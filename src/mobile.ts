// A small web app for the phone, served on the local network: the agents as a chat list,
// each agent's conversation as bubbles, and a box to answer it. Anyone on the network can
// reach the port, so every request needs the secret token from the QR code's link.
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { Model, AgentVM } from './model';
import { Transcript } from './transcript';

export interface MobileHost {
  model(): Model | undefined;
  /** The session file of an agent and its format, if its harness keeps one we can read. */
  sessionOf(address: string): Promise<{ file: string; kind: 'explyt' | 'claude' } | undefined>;
  /** The agent's screen, for agents without a readable session. */
  screen(address: string): Promise<string>;
  send(address: string, text: string): Promise<void>;
  keys(address: string, keys: string[]): Promise<void>;
}

/** The address phones reach this machine at: the first private IPv4 on an up interface. */
export function lanAddress(): string | undefined {
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? []).map((a) => ({ name, ...a })));
  const v4 = all.filter((a) => a.family === 'IPv4' && !a.internal);
  const priv = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return (v4.find((a) => priv(a.address) && /^en\d/.test(a.name)) ?? v4.find((a) => priv(a.address)) ?? v4[0])?.address;
}

export class MobileServer {
  private server?: http.Server;
  private token = randomBytes(18).toString('base64url');
  private clients = new Set<http.ServerResponse>();
  private transcripts = new Map<string, Transcript>();
  private watched = new Map<string, Set<http.ServerResponse>>();
  private poll?: NodeJS.Timeout;
  port = 0;

  constructor(private host: MobileHost, private media: string) {}

  get url(): string | undefined {
    const ip = lanAddress();
    return this.server && ip ? `http://${ip}:${this.port}/#k=${this.token}` : undefined;
  }

  get running() { return !!this.server; }

  start(port: number): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(e?.message ?? e));
      }));
      server.on('error', reject);
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        this.port = (server.address() as any).port;
        // Session files change without events: look at the watched ones twice a second.
        this.poll = setInterval(() => this.pushTranscripts(), 500);
        resolve();
      });
    });
  }

  stop() {
    clearInterval(this.poll);
    for (const c of this.clients) c.end();
    for (const set of this.watched.values()) for (const c of set) c.end();
    this.clients.clear();
    this.watched.clear();
    this.server?.close();
    this.server = undefined;
  }

  /** A new token: links already shared stop working. */
  rotate() {
    this.token = randomBytes(18).toString('base64url');
    for (const c of this.clients) c.end();
    for (const set of this.watched.values()) for (const c of set) c.end();
  }

  /** The list changed: tell the phones. */
  modelChanged() {
    if (!this.clients.size) return;
    const data = `data: ${JSON.stringify(this.listPayload())}\n\n`;
    for (const c of this.clients) c.write(data);
  }

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const given = url.searchParams.get('k') ?? String(req.headers['x-herdr-key'] ?? '');
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private listPayload() {
    const m = this.host.model();
    if (!m) return { connected: false, agents: [] };
    const flat = (a: AgentVM) => ({
      address: a.address, name: a.name, title: a.detail || a.name, where: a.where, word: a.shown ?? a.word,
      since: a.since, icon: a.icon?.key, avatar: a.avatar, mascot: a.program, hasMascot: !!a.mascot, pinned: a.pinned,
      kids: a.kids.filter((k) => k.word === 'working' || k.word === 'blocked').length,
    });
    return {
      connected: true,
      now: Date.now(),
      icons: Object.fromEntries(Object.entries(m.icons).map(([k, v]) => [k, v.uri])),
      agents: m.agents.map(flat),
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    // The page itself carries no data: the token in its #fragment never reaches the server logs.
    if (p === '/' || p === '/index.html') return this.file(res, 'mobile.html', 'text/html; charset=utf-8');
    if (p === '/mobile.js') return this.file(res, 'mobile.js', 'text/javascript; charset=utf-8');
    if (p === '/mobile.css') return this.file(res, 'mobile.css', 'text/css; charset=utf-8');
    if (p === '/icon.png') return this.file(res, 'icon.png', 'image/png');
    // Mascots by URL, so the phone caches them instead of getting them in every update.
    const mascot = /^\/mascots\/([a-z0-9-]+)\.webp$/.exec(p);
    if (mascot) return this.file(res, path.join('mascots', `${mascot[1]}.webp`), 'image/webp', 'public, max-age=86400');
    if (p === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/manifest+json' });
      return res.end(JSON.stringify({ name: 'herdr', short_name: 'herdr', display: 'standalone', background_color: '#111', theme_color: '#111', icons: [{ src: '/icon.png', sizes: '256x256', type: 'image/png' }] }));
    }
    if (!this.authorized(req, url)) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('Scan the QR code in VS Code again.'); }

    if (p === '/api/events') return this.stream(res, this.clients, this.listPayload());
    const chat = /^\/api\/chat\/([^/]+)(\/events|\/send|\/keys)?$/.exec(p);
    if (!chat) { res.writeHead(404); return res.end(); }
    const address = decodeURIComponent(chat[1]);
    if (!this.host.model()?.agents.some((a) => a.address === address || a.kids.some((k) => k.address === address))) {
      res.writeHead(404); return res.end();
    }
    if (chat[2] === '/events') {
      const set = this.watched.get(address) ?? new Set();
      this.watched.set(address, set);
      return this.stream(res, set, await this.chatPayload(address, true), () => {
        if (!set.size) { this.watched.delete(address); this.transcripts.delete(address); }
      });
    }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const body = await readJson(req);
    if (chat[2] === '/send') {
      const text = String(body.text ?? '').trim();
      if (!text) { res.writeHead(400); return res.end(); }
      await this.host.send(address, text.slice(0, 20_000));
    } else if (chat[2] === '/keys') {
      const keys = (Array.isArray(body.keys) ? body.keys : []).map(String).filter((k: string) => /^[a-z0-9+]{1,12}$/.test(k)).slice(0, 8);
      await this.host.keys(address, keys);
    }
    res.writeHead(204);
    res.end();
  }

  private stream(res: http.ServerResponse, set: Set<http.ServerResponse>, first: unknown, onClose?: () => void) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`data: ${JSON.stringify(first)}\n\n`);
    set.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    res.on('close', () => { clearInterval(ping); set.delete(res); onClose?.(); });
  }

  private async chatPayload(address: string, full: boolean) {
    const agent = this.host.model()?.agents.find((a) => a.address === address);
    let t = this.transcripts.get(address);
    if (!t) {
      const s = await this.host.sessionOf(address);
      if (s) { t = new Transcript(s.file, s.kind); this.transcripts.set(address, t); }
    }
    const header = agent && { title: agent.detail || agent.name, name: agent.name, where: agent.where, word: agent.shown ?? agent.word, icon: agent.icon?.key, avatar: agent.avatar, mascot: agent.program, hasMascot: !!agent.mascot };
    if (t) {
      t.refresh();
      return { kind: 'bubbles', header, bubbles: full ? t.bubbles : t.bubbles.slice(-3) };
    }
    return { kind: 'screen', header, screen: await this.host.screen(address) };
  }

  private screens = new Map<string, string>();

  private async pushTranscripts() {
    for (const [address, set] of this.watched) {
      if (!set.size) continue;
      const t = this.transcripts.get(address);
      let payload: unknown;
      if (t) {
        if (!t.refresh()) continue;
        // The last bubbles are enough: the page merges them by id.
        payload = await this.chatPayload(address, false);
      } else {
        const p: any = await this.chatPayload(address, false);
        if (this.screens.get(address) === p.screen) continue;
        this.screens.set(address, p.screen);
        payload = p;
      }
      const data = `data: ${JSON.stringify(payload)}\n\n`;
      for (const c of set) c.write(data);
    }
  }

  private file(res: http.ServerResponse, name: string, type: string, cache = 'no-cache') {
    const file = path.join(this.media, name);
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': type, 'cache-control': cache });
      res.end(buf);
    });
  }
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 100_000) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
