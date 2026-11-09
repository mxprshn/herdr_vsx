// A core terminal shown in a VS Code terminal: attach, stream bytes both ways, resize.
import * as vscode from 'vscode';
import { StringDecoder } from 'string_decoder';
import { Core, DATA } from './core';

export class CorePty implements vscode.Pseudoterminal {
  private write = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.write.event;
  private channel?: number;
  private decoder = new StringDecoder('utf8');
  private disposed = false;

  constructor(private core: Core, readonly address: string, private onEnd: () => void) {}

  async open(dims: vscode.TerminalDimensions | undefined) {
    const cols = dims?.columns ?? 120;
    const rows = dims?.rows ?? 40;
    try {
      const r = await this.core.call('terminal.attach', { terminal: this.address, cols, rows, history: 2000 });
      if (this.disposed) { this.core.detach(r.channel); return; }
      this.channel = r.channel;
      this.core.listen(r.channel, {
        data: (bytes) => {
          this.core.credit(r.channel, bytes.length);
          this.write.fire(this.decoder.write(bytes));
        },
        closed: (why: any) => this.end(`\r\n[herdr: ${this.address} ended${why?.reason ? `: ${why.reason}` : ''}]\r\n`),
        lost: () => this.end(`\r\n[herdr: lost the core]\r\n`),
      });
    } catch (e: any) {
      this.end(`[herdr: cannot attach ${this.address}: ${e.message}]\r\n`);
    }
  }

  private end(message: string) {
    this.channel = undefined;
    this.write.fire(message);
    // Keep the message visible; the user closes the tab.
  }

  handleInput(data: string) {
    if (this.channel !== undefined) this.core.send(this.channel, DATA, Buffer.from(data, 'utf8'));
  }

  setDimensions(dims: vscode.TerminalDimensions) {
    if (this.channel !== undefined) this.core.resize(this.channel, dims.columns, dims.rows);
  }

  /** Closing the VS Code tab only detaches: the program keeps running in the core. */
  close() {
    this.disposed = true;
    if (this.channel !== undefined) this.core.detach(this.channel);
    this.channel = undefined;
    this.onEnd();
  }
}
