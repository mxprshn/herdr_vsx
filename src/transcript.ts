// An agent's conversation as chat bubbles, read from its harness's session file.
// Session files grow to megabytes, so each is read once to the end and then only the
// bytes appended since, from a remembered offset. Bubbles keep only text: tool output
// and images are reduced to a line.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Tool { name: string; summary: string; }

export interface Bubble {
  id: string;
  role: 'user' | 'agent';
  text: string;
  tools: Tool[];
  ms: number;
}

const MAX_BUBBLES = 400;
const MAX_TEXT = 6000;
/** A first read of a huge file starts this far from its end: older history isn't needed on a phone. */
const FIRST_READ = 4 * 1024 * 1024;

function cut(s: string, n: number) { return s.length > n ? `${s.slice(0, n)}…` : s; }

/** One line saying what a tool call did, from its arguments. */
function summarize(name: string, args: any): string {
  if (!args || typeof args !== 'object') return '';
  const pick = args.command ?? args.cmd ?? args.path ?? args.file_path ?? args.file ?? args.pattern ?? args.query ?? args.url
    ?? args.description ?? args.short_task_description ?? args.prompt ?? args.directive;
  return cut(String(pick ?? '').replace(/\s+/g, ' ').trim(), 140);
}

/** Explyt's (pi) message lines. */
function fromExplyt(o: any): { role: 'user' | 'agent'; text: string; tools: Tool[]; ms: number; id: string } | undefined {
  if (o.type !== 'message') return undefined;
  const m = o.message ?? {};
  const ms = Date.parse(o.timestamp) || 0;
  const blocks: any[] = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
  if (m.role === 'user') {
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const images = blocks.filter((b) => b.type === 'image').length;
    return text || images ? { id: o.id, role: 'user', text: text + (images ? `${text ? '\n' : ''}🖼 ×${images}` : ''), tools: [], ms } : undefined;
  }
  if (m.role === 'assistant') {
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const tools = blocks.filter((b) => b.type === 'toolCall').map((b) => ({ name: b.name, summary: summarize(b.name, b.arguments) }));
    return text || tools.length ? { id: o.id, role: 'agent', text, tools, ms } : undefined;
  }
  return undefined;
}

/** Claude Code's transcript lines; system reminders and tool results are skipped. */
function fromClaude(o: any): { role: 'user' | 'agent'; text: string; tools: Tool[]; ms: number; id: string } | undefined {
  if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) return undefined;
  const m = o.message ?? {};
  const ms = Date.parse(o.timestamp) || 0;
  const blocks: any[] = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g, '')
    .trim();
  if (o.type === 'user') return text ? { id: o.uuid, role: 'user', text, tools: [], ms } : undefined;
  const tools = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, summary: summarize(b.name, b.input) }));
  return text || tools.length ? { id: o.uuid, role: 'agent', text, tools, ms } : undefined;
}

export class Transcript {
  bubbles: Bubble[] = [];
  private offset = 0;
  private rest = '';
  private size = -1;
  private mtime = -1;

  constructor(readonly file: string, private kind: 'explyt' | 'claude') {}

  /** Reads what was appended since the last time; true if the bubbles changed. */
  refresh(): boolean {
    let st: fs.Stats;
    try { st = fs.statSync(this.file); } catch { return false; }
    if (st.size === this.size && st.mtimeMs === this.mtime) return false;
    if (st.size < this.offset) { this.offset = 0; this.rest = ''; this.bubbles = []; }
    if (this.offset === 0 && st.size > FIRST_READ) {
      this.offset = st.size - FIRST_READ;
      this.rest = '';
      this.skipPartialLine = true;
    }
    this.size = st.size;
    this.mtime = st.mtimeMs;
    const len = st.size - this.offset;
    if (len <= 0) return false;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, len, this.offset); } finally { fs.closeSync(fd); }
    this.offset = st.size;
    let text = this.rest + buf.toString('utf8');
    if (this.skipPartialLine) {
      text = text.slice(text.indexOf('\n') + 1);
      this.skipPartialLine = false;
    }
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    const parse = this.kind === 'explyt' ? fromExplyt : fromClaude;
    let changed = false;
    for (const line of lines) {
      if (!line) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      const b = parse(o);
      if (!b) continue;
      const last = this.bubbles[this.bubbles.length - 1];
      // An agent's turn is many lines (a thought, tools, more text): one bubble.
      if (last && b.role === 'agent' && last.role === 'agent') {
        if (b.text) last.text = cut(last.text ? `${last.text}\n\n${b.text}` : b.text, MAX_TEXT);
        last.tools.push(...b.tools);
        last.ms = b.ms || last.ms;
      } else {
        this.bubbles.push({ id: b.id, role: b.role, text: cut(b.text, MAX_TEXT), tools: b.tools, ms: b.ms });
      }
      changed = true;
    }
    if (this.bubbles.length > MAX_BUBBLES) this.bubbles.splice(0, this.bubbles.length - MAX_BUBBLES);
    return changed;
  }

  private skipPartialLine = false;
}

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

/** Claude Code's session for a folder: its newest transcript (`-Users-me-repo/<id>.jsonl`). */
export function findClaudeSession(cwd: string, sinceMs?: number): string | undefined {
  const real = (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })();
  const dirs = [...new Set([cwd, real])].map((c) => path.join(CLAUDE_PROJECTS, c.replace(/[^A-Za-z0-9]/g, '-'))).filter((d) => fs.existsSync(d));
  const files = dirs
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .filter((f) => !sinceMs || f.mtime >= sinceMs - 60_000)
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.file;
}
