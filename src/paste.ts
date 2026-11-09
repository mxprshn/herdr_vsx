// Cmd+V in a herdr terminal, as herdr-app does it: VS Code's own paste only knows text, so
// an image alone (a screenshot) is sent as Ctrl+V, and the agent reads the clipboard itself.
// A terminal on another machine reads that machine's clipboard: the image goes there as a
// file (`hc put`) and its path is pasted.
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';

const CTRL_V = '\x16';

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 15000 }, (e, out) => resolve({ ok: !e, out: String(out ?? '') })));
}

async function clipboardHasImage(): Promise<boolean> {
  if (process.platform !== 'darwin') return true; // can't tell elsewhere: let the program look
  const r = await run('osascript', ['-e', 'clipboard info']);
  return /«class PNGf»|TIFF picture|«class TIFF»|JPEG picture|GIF picture/.test(r.out);
}

async function saveClipboardImage(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const file = path.join(os.tmpdir(), `herdr-paste-${Date.now()}.png`);
  const r = await run('osascript', [
    '-e', 'on run argv',
    '-e', 'set f to open for access (POSIX file (item 1 of argv)) with write permission',
    '-e', 'write (the clipboard as «class PNGf») to f',
    '-e', 'close access f',
    '-e', 'end run',
    file,
  ]);
  return r.ok && fs.existsSync(file) ? file : undefined;
}

const quote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

export async function paste(address: string, send: (data: string) => void, hcPath: string) {
  if (await vscode.env.clipboard.readText()) {
    // Text: VS Code's paste, with bracketed paste and its multi-line warning.
    await vscode.commands.executeCommand('workbench.action.terminal.paste');
    return;
  }
  if (!(await clipboardHasImage())) return;
  if (!address.includes('/')) {
    send(CTRL_V);
    return;
  }
  const file = await saveClipboardImage();
  if (!file) { send(CTRL_V); return; }
  const r = await run(hcPath, ['put', '--json', address, file]);
  fs.rmSync(file, { force: true });
  try {
    const there = JSON.parse(r.out).path;
    if (there) send(`\x1b[200~${quote(there)}\x1b[201~`);
  } catch {
    void vscode.window.showErrorMessage(`Herdr: cannot send the image to ${address.split('/')[0]}`);
  }
}
