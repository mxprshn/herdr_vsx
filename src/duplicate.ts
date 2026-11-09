// Duplicating an agent with its harness's own session fork. Explyt (built on pi) keeps a
// session per run in ~/.local/share/explyt-ai-agent/agent/sessions/<cwd-slug>/*.jsonl and
// starts a copy with `explyt --fork <file>`: the whole history, a new session id.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SessionGuess {
  file: string;
  name: string;
  /** Matched by the agent's reported topic (its session name), not just the newest file. */
  sure: boolean;
}

const EXPLYT_SESSIONS = path.join(os.homedir(), '.local', 'share', 'explyt-ai-agent', 'agent', 'sessions');

/** pi's folder name for a cwd: `/a/b.c` → `--a-b.c--`. */
function slug(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** The session's display name: the last `session_info` line, read from the file's tail. */
function sessionName(file: string): string {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    // Names are set early and renamed rarely: the head and the tail cover both.
    const read = (start: number, len: number) => {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    };
    const chunk = 256 * 1024;
    const text = size <= 2 * chunk ? read(0, size) : read(0, chunk) + '\n' + read(size - chunk, chunk);
    const names = [...text.matchAll(/"type":"session_info"[^\n]*?"name":"((?:[^"\\]|\\.)*)"/g)];
    return names.length ? JSON.parse(`"${names[names.length - 1][1]}"`) : '';
  } finally {
    fs.closeSync(fd);
  }
}

/** When a session file was created, from its name: `2026-11-05T10-40-34-469Z_<id>.jsonl`. */
function createdMs(file: string): number {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z_/.exec(path.basename(file));
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
}

export interface Clues {
  /** The agent's reported topic: explyt's session name. */
  topic?: string;
  /** When the agent's process started: a fresh session's file is created within seconds. */
  startedMs?: number;
  /** When its status last changed: each turn's end is written to the session then. */
  statusMs?: number;
  working?: boolean;
}

/**
 * The explyt session a terminal runs, from clues in order of trust: its name, the file
 * written when its status last changed, the file created when its process started.
 */
export function findExplytSession(cwd: string, clues: Clues): SessionGuess | undefined {
  const real = (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })();
  const dirs = [...new Set([cwd, real])].map((c) => path.join(EXPLYT_SESSIONS, slug(c))).filter((d) => fs.existsSync(d));
  const files = dirs
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 40);
  if (!files.length) return undefined;
  const sure = (file: string): SessionGuess => ({ file, name: sessionName(file), sure: true });
  if (clues.topic) {
    const named = files.find(({ file }) => sessionName(file) === clues.topic);
    if (named) return sure(named.file);
  }
  // A working agent writes as it goes; an idle one wrote when it stopped.
  const at = clues.working ? Date.now() : clues.statusMs;
  if (at) {
    const near = files.filter((f) => Math.abs(f.mtime - at) < (clues.working ? 120_000 : 30_000));
    if (near.length === 1) return sure(near[0].file);
  }
  if (clues.startedMs) {
    const born = files.filter((f) => Math.abs(createdMs(f.file) - clues.startedMs!) < 15_000);
    if (born.length === 1) return sure(born[0].file);
  }
  return { file: files[0].file, name: sessionName(files[0].file), sure: false };
}

/** Recent sessions in a folder, newest first, for picking by hand. */
export function recentExplytSessions(cwd: string, limit = 15): { file: string; name: string; mtime: number }[] {
  const real = (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })();
  return [...new Set([cwd, real])]
    .map((c) => path.join(EXPLYT_SESSIONS, slug(c)))
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => ({ ...f, name: sessionName(f.file) }));
}
