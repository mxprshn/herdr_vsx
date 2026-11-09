// A framed connection to herdr-core through `hc connect`: JSON-RPC on channel 0,
// terminal byte streams and the event stream on their own channels.
// Mirrors herdr-app's src/hc.rs.
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';

const HEADER = 9;
export const DATA = 0;
export const CREDIT = 1;
export const CLOSE = 2;
export const RESIZE = 3;
export const FOCUS = 4;

export interface StreamHandler {
  data(bytes: Buffer): void;
  closed(why: unknown): void;
  /** The connection dropped; the program most likely still runs. */
  lost(): void;
}

export interface TerminalRecord {
  address: string;
  state: string;
  cwd?: string;
  title?: string;
  turn?: number;
  labels?: Record<string, string>;
  status?: { app?: string; state?: string } | null;
  foreground?: { name?: string; argv?: string[]; cwd?: string } | null;
  parent?: string | null;
  [key: string]: unknown;
}

/** A core error reply; `kind` is its `data.kind` (e.g. `conflict`, `not_found`). */
export class CoreError extends Error {
  constructor(message: string, readonly kind?: string) { super(message); }
}

function encode(channel: number, kind: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(HEADER);
  h.writeUInt32LE(channel, 0);
  h[4] = kind;
  h.writeUInt32LE(payload.length, 5);
  return Buffer.concat([h, payload]);
}

export class Core extends EventEmitter {
  hello: any;
  private proc: ChildProcessWithoutNullStreams;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private replies = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  private streams = new Map<number, StreamHandler>();
  private early = new Map<number, Array<[number, Buffer]>>();
  private closed = false;

  private constructor(proc: ChildProcessWithoutNullStreams, hello: any, rest: Buffer) {
    super();
    this.proc = proc;
    this.hello = hello;
    proc.stdout.on('data', (d: Buffer) => this.read(d));
    proc.on('exit', () => this.lose());
    proc.stdin.on('error', () => this.lose());
    if (rest.length) this.read(rest);
  }

  /** Connects to the user's core (`hc connect` starts it if needed) and switches to framed mode. */
  static connect(hcPath: string): Promise<Core> {
    return new Promise((resolve, reject) => {
      const proc = spawn(hcPath, ['connect']);
      let stderr = '';
      let buf = Buffer.alloc(0);
      const fail = (e: Error) => { proc.kill(); reject(e); };
      proc.on('error', (e) => reject(new Error(`cannot run \`${hcPath} connect\`: ${e.message}`)));
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      const onHello = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        proc.stdout.off('data', onHello);
        let msg: any;
        try { msg = JSON.parse(buf.subarray(0, nl).toString()); } catch { return fail(new Error('bad hello reply from core')); }
        if (msg.error) return fail(new Error(`core refused hello: ${JSON.stringify(msg.error)}`));
        resolve(new Core(proc, msg.result, buf.subarray(nl + 1)));
      };
      proc.stdout.on('data', onHello);
      proc.on('exit', (code) => reject(new Error(stderr.trim() || `hc connect exited (${code})`)));
      proc.stdin.write('{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n');
    });
  }

  private read(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= HEADER) {
      const len = this.buf.readUInt32LE(5);
      if (this.buf.length < HEADER + len) break;
      const channel = this.buf.readUInt32LE(0);
      const kind = this.buf[4];
      const payload = this.buf.subarray(HEADER, HEADER + len);
      this.buf = this.buf.subarray(HEADER + len);
      if (channel === 0) this.reply(payload);
      else this.route(channel, kind, Buffer.from(payload));
    }
  }

  private reply(payload: Buffer) {
    let msg: any;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    const r = typeof msg.id === 'number' ? this.replies.get(msg.id) : undefined;
    if (!r) return;
    this.replies.delete(msg.id);
    if (msg.error) {
      const hint = msg.error.data?.hint ? ` (${msg.error.data.hint})` : '';
      r.reject(new CoreError(`${msg.error.message ?? 'core call failed'}${hint}`, msg.error.data?.kind));
    } else r.resolve(msg.result ?? null);
  }

  private route(channel: number, kind: number, payload: Buffer) {
    if (kind !== DATA && kind !== CLOSE) return;
    const h = this.streams.get(channel);
    if (!h) {
      // Frames can arrive before the attach/subscribe reply is handled.
      const list = this.early.get(channel) ?? [];
      list.push([kind, payload]);
      this.early.set(channel, list);
      return;
    }
    if (kind === DATA) h.data(payload);
    else {
      this.streams.delete(channel);
      let why: unknown = null;
      try { why = JSON.parse(payload.toString()); } catch { /* empty close */ }
      h.closed(why);
    }
  }

  private lose() {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.streams.values()) h.lost();
    this.streams.clear();
    for (const r of this.replies.values()) r.reject(new Error('lost the core'));
    this.replies.clear();
    this.emit('lost');
  }

  get isClosed() { return this.closed; }

  send(channel: number, kind: number, payload: Buffer) {
    if (!this.closed) this.proc.stdin.write(encode(channel, kind, payload));
  }

  call<T = any>(method: string, params: object = {}, timeoutMs = 10000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${method}: lost the core`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(id);
        reject(new Error(`${method}: no reply from core`));
      }, timeoutMs);
      this.replies.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(new CoreError(`${method}: ${e.message}`, (e as CoreError).kind)); },
      });
      this.send(0, DATA, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    });
  }

  /** Registers a handler for a channel and replays frames that came early. */
  listen(channel: number, h: StreamHandler) {
    this.streams.set(channel, h);
    for (const [kind, payload] of this.early.get(channel) ?? []) this.route(channel, kind, payload);
    this.early.delete(channel);
  }

  credit(channel: number, n: number) {
    const p = Buffer.alloc(4);
    p.writeUInt32LE(n, 0);
    this.send(channel, CREDIT, p);
  }

  resize(channel: number, cols: number, rows: number) {
    const p = Buffer.alloc(4);
    p.writeUInt16LE(cols, 0);
    p.writeUInt16LE(rows, 2);
    this.send(channel, RESIZE, p);
  }

  detach(channel: number) {
    this.streams.delete(channel);
    this.send(channel, CLOSE, Buffer.alloc(0));
  }

  dispose() {
    this.proc.kill();
    this.lose();
  }
}
