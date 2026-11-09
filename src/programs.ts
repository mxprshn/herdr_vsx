// What runs in a terminal, as people see it: name, icon, tile. A port of
// herdr-app's src/programs.rs: the bundled table with the person's
// `programs.json` from herdr-app's home on top.
import * as fs from 'fs';
import * as path from 'path';

interface Entry {
  name?: string;
  icon?: string;
  tint?: boolean;
  tile?: string;
  color?: string;
  match?: string[];
  run?: string[];
}

interface Table {
  shells: string[];
  interpreters: string[];
  programs: Record<string, Entry>;
}

export interface Program {
  key: string;
  name: string;
  /** `data:` URI of the icon, if any. */
  icon?: string;
  /** The icon's file, for VS Code's own icons (terminal tabs, pickers). */
  iconFile?: string;
  tint: boolean;
  tile?: string;
  color?: string;
  shell: boolean;
  agent: boolean;
}

export interface Startable extends Program { run: string[] }

const AGENTS_FIRST = ['claude', 'codex', 'pi', 'opencode', 'cursor', 'copilot', 'amp', 'gemini', 'grok'];
const PALETTE = ['#6d5bd0', '#2f80ed', '#0f9d8a', '#d9822b', '#c2417d', '#3a7d44', '#8a5a44', '#4e5d94'];

function base(s: string): string {
  return (s.split(/[/\\]/).pop() ?? s).replace(/^-+/, '').replace(/\.exe$/i, '');
}

function hashColor(s: string): string {
  let h = 2166136261;
  for (const b of Buffer.from(s)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export class Programs {
  private table: Table;
  private icons = new Map<string, { uri: string; file: string } | undefined>();

  constructor(private bundled: string, private home: string) {
    this.table = JSON.parse(fs.readFileSync(path.join(bundled, 'programs.json'), 'utf8'));
    try {
      const mine: Partial<Table> = JSON.parse(fs.readFileSync(path.join(home, 'programs.json'), 'utf8'));
      this.table.shells.push(...(mine.shells ?? []));
      this.table.interpreters.push(...(mine.interpreters ?? []));
      for (const [key, e] of Object.entries(mine.programs ?? {})) {
        const old = this.table.programs[key] ?? {};
        this.table.programs[key] = {
          ...old,
          ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))),
        };
      }
    } catch { /* no personal table */ }
  }

  /** Icon paths are relative to herdr-app's home; shipped ones are bundled too. */
  private icon(rel?: string): { uri: string; file: string } | undefined {
    if (!rel) return undefined;
    if (this.icons.has(rel)) return this.icons.get(rel);
    let found: { uri: string; file: string } | undefined;
    for (const file of [path.join(this.home, rel), path.join(this.bundled, rel)]) {
      try {
        const bytes = fs.readFileSync(file);
        const mime = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
        found = { uri: `data:${mime};base64,${bytes.toString('base64')}`, file };
        break;
      } catch { /* try the next */ }
    }
    this.icons.set(rel, found);
    return found;
  }

  private find(name: string): [string, Entry] | undefined {
    const lower = name.toLowerCase();
    const p = Object.entries(this.table.programs);
    return p.find(([k]) => k.toLowerCase() === lower)
      ?? p.find(([, e]) => (e.match ?? []).some((a) => a.toLowerCase() === lower));
  }

  private shown(key: string, e: Entry, name: string | undefined, shell: boolean, agent: boolean): Program {
    const icon = this.icon(e.icon);
    return {
      key,
      name: name ?? e.name ?? key,
      icon: icon?.uri,
      iconFile: icon?.file,
      tint: e.tint ?? true,
      tile: e.tile,
      color: e.color,
      shell,
      agent,
    };
  }

  /** From the agent's own report (`app`), else the program it runs (`argv`). */
  of(app: string | undefined, argv: string[]): Program {
    const t = this.table;
    if (app) {
      const f = this.find(app);
      return f ? this.shown(f[0], f[1], undefined, false, true) : this.shown('agent', t.programs.agent ?? {}, app, false, true);
    }
    // `zsh -ic '"$@"; exec "$0" -i' zsh <cmd>...`: how herdr starts commands in the person's shell.
    if (argv.length > 4 && t.shells.includes(base(argv[0])) && /^-.*c$/.test(argv[1]) && argv[2].includes('"$@"')) {
      return this.of(undefined, argv.slice(4));
    }
    const first = argv[0] ? base(argv[0]) : undefined;
    if (!first) return this.shown('shell', t.programs.shell ?? {}, undefined, true, false);
    if (t.interpreters.includes(first)) {
      for (const arg of argv.slice(1).filter((a) => !a.startsWith('-'))) {
        const stem = base(arg).replace(/\.(js|mjs|cjs|ts|py|rb)$/, '');
        const f = this.find(stem);
        if (f && !t.interpreters.includes(f[0])) return this.shown(f[0], f[1], undefined, false, false);
      }
    }
    const f = this.find(first);
    if (f) return this.shown(f[0], f[1], undefined, false, false);
    if (t.shells.includes(first)) return this.shown('shell', t.programs.shell ?? {}, first, true, false);
    return this.shown('program', { ...t.programs.program, tile: hashColor(first), color: '#ffffff' }, first, false, false);
  }

  /** Agents people can start (entries with `run`), most picked first. */
  startable(): Startable[] {
    const rank = (k: string) => { const i = AGENTS_FIRST.indexOf(k); return i < 0 ? AGENTS_FIRST.length : i; };
    return Object.entries(this.table.programs)
      .filter(([, e]) => e.run?.length)
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([k, e]) => ({ ...this.shown(k, e, undefined, false, true), run: e.run! }));
  }
}
