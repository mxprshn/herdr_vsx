// The core's terminals and herdr-app's layout document, kept live from `events.subscribe`.
// Event handling mirrors herdr-app's EventLines (src/hc.rs).
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { Core, CoreError, TerminalRecord } from './core';

export interface Tab { id: string; name: string; terminals: string[]; files: string[] }
export interface Space { id: string; name: string; folder: string; tabs: Tab[] }

export type AgentWord = 'working' | 'blocked' | 'done' | 'idle';

const DOC = 'herdr-app';

/** `sp…`, `tb…`, `p…` ids as herdr-app makes them. */
export function freshId(prefix: string): string {
  return prefix + randomBytes(16).toString('hex');
}

/** A tab showing a file in herdr's editor mod; `owner` marks the ones this extension manages. */
export function fileTabNode(file: string, name: string, owner: string) {
  const id = freshId('tb');
  return { id, name, root: { id, type: 'row', children: [{ id: freshId('p'), type: 'block', content: { mod: 'my-editor', props: { file, on: null, vscode: owner } } }] } };
}

/** The tab node herdr-app writes for a tab with one terminal pane. */
export function tabNode(id: string, name: string, address: string) {
  return { id, name, root: { id, type: 'row', children: [{ id: freshId('p'), type: 'block', content: { terminal: address } }] } };
}

export class State extends EventEmitter {
  terminals = new Map<string, TerminalRecord>();
  spaces: Space[] = [];
  private seq = 0;
  private pending = '';

  constructor(readonly core: Core) { super(); }

  async start() {
    const snap = await this.core.call('events.subscribe', {});
    this.seq = snap.seq ?? 0;
    this.terminals = new Map((snap.terminals ?? []).map((t: TerminalRecord) => [t.address, t]));
    this.core.listen(snap.channel, {
      data: (bytes) => { this.core.credit(snap.channel, bytes.length); this.push(bytes); },
      closed: () => this.emit('lost'),
      lost: () => this.emit('lost'),
    });
    this.core.credit(snap.channel, 1024 * 1024);
    await this.loadDoc();
  }

  private async loadDoc() {
    try {
      const r = await this.core.call('doc.get', { name: DOC });
      this.spaces = parseSpaces(r?.value);
    } catch {
      this.spaces = [];
    }
    this.emit('changed');
  }

  /**
   * Edits herdr-app's layout document: `edit` changes the document in place and
   * returns false when there is nothing to write. Retries on a concurrent write.
   */
  async editDoc(edit: (doc: { spaces: any[] }) => boolean) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this.core.call('doc.get', { name: DOC });
      const doc = r?.value ?? { spaces: [] };
      doc.spaces ??= [];
      if (!edit(doc)) return;
      try {
        await this.core.call('doc.set', { name: DOC, version: r?.version ?? 0, value: doc });
        return;
      } catch (e) {
        if ((e as CoreError).kind !== 'conflict') throw e;
      }
    }
    throw new Error('the layout kept changing; try again');
  }

  private push(bytes: Buffer) {
    this.pending += bytes.toString('utf8');
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    let changed = false;
    let docs = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = msg.params ?? {};
      if (msg.method === 'missed') {
        this.seq = p.seq ?? this.seq;
        this.terminals = new Map((p.terminals ?? []).map((t: TerminalRecord) => [t.address, t]));
        changed = docs = true;
      } else if (msg.method === 'event' && (typeof p.seq !== 'number' || p.seq > this.seq)) {
        if (typeof p.seq === 'number') this.seq = p.seq;
        if (p.type === 'doc') docs = true;
        else changed = this.apply(p) || changed;
      }
    }
    if (docs) void this.loadDoc();
    else if (changed) this.emit('changed');
  }

  private apply(p: any): boolean {
    const { type, terminal: address, data = {} } = p;
    const whole = type === 'created' || type === 'restarted' ? data : type === 'labels' ? data.record : undefined;
    if (whole) { this.terminals.set(address, whole); return true; }
    const t = this.terminals.get(address);
    if (!t) return false;
    const set = (keys: string[]) => keys.forEach((k) => { t[k] = data[k]; });
    switch (type) {
      case 'removed': this.terminals.delete(address); return true;
      case 'finished':
      case 'lost':
        set(['reason', 'exit_code', 'signal', 'finished_ms']);
        t.state = type === 'lost' ? 'live' : 'finished';
        if (type === 'lost') t.pid = null;
        delete t.foreground;
        return true;
      case 'status': {
        const before = t.status?.state;
        set(['status', 'records', 'reported']);
        t.status_ms = data.status_ms ?? Date.now();
        if (before !== t.status?.state) this.emit('status', address, before, t.status?.state);
        return true;
      }
      case 'turn': set(['turn']); return true;
      case 'title': set(['title']); return true;
      case 'labels': set(['labels']); return true;
      case 'keep': set(['keep']); return true;
      case 'size': set(['cols', 'rows']); return true;
      case 'foreground': t.foreground = data; return true;
      default: return false;
    }
  }

  live(): TerminalRecord[] {
    return [...this.terminals.values()].filter((t) => t.state === 'live');
  }

  agents(): TerminalRecord[] {
    return this.live().filter((t) => t.status?.state);
  }

  /** Herdr's words: a finish you haven't looked at (turn past `herdr.seen`) is "done". */
  word(t: TerminalRecord | undefined): AgentWord | undefined {
    const s = t?.status?.state;
    if (!t || !s) return undefined;
    if (s === 'working') return 'working';
    if (s === 'blocked' || s === 'error') return 'blocked';
    const seen = Number(t.labels?.['herdr.seen'] ?? 0);
    return (t.turn ?? 0) > seen ? 'done' : 'idle';
  }

  /** Marks the agent's current turn as seen, shared with herdr-app through the label. */
  async markSeen(address: string) {
    const t = this.terminals.get(address);
    if (!t?.status?.state || !t.turn) return;
    if (Number(t.labels?.['herdr.seen'] ?? 0) >= t.turn) return;
    await this.label(address, { 'herdr.seen': String(t.turn) });
  }

  label(address: string, labels: Record<string, string>) {
    return this.core.call('terminal.label', { terminal: address, labels }).catch(() => {});
  }

  space(id: string) { return this.spaces.find((s) => s.id === id); }

  /** Where a terminal is shown: its space and tab. */
  placeOf(address: string): { space: Space; tab: Tab } | undefined {
    for (const space of this.spaces) for (const tab of space.tabs) if (tab.terminals.includes(address)) return { space, tab };
    return undefined;
  }

  /** An unnamed space follows its first terminal's folder, as in herdr-app. */
  spaceName(s: Space): string {
    if (s.name) return s.name;
    return lastSegment(this.spaceFolder(s)) || 'space';
  }

  spaceFolder(s: Space): string {
    const first = this.terminals.get(s.tabs[0]?.terminals[0] ?? '');
    return first?.foreground?.cwd ?? first?.cwd ?? s.folder;
  }
}

export function lastSegment(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? '';
}

function parseSpaces(doc: any): Space[] {
  return (doc?.spaces ?? []).map((s: any) => ({
    id: s.id,
    name: s.name ?? '',
    folder: s.folder ?? '',
    tabs: (s.tabs ?? []).map((t: any) => ({ id: t.id, name: t.name ?? '', terminals: collect(t.root), files: files(t.root) })),
  }));
}

/** Files shown by mod panes (herdr's editors put the path in `props.file`). */
export function files(node: any): string[] {
  if (!node) return [];
  const own = typeof node.content?.props?.file === 'string' && !node.content.props.on ? [node.content.props.file] : [];
  return [...own, ...(node.children ?? []).flatMap(files)];
}

function collect(node: any): string[] {
  if (!node) return [];
  const own = node.content?.terminal ? [node.content.terminal] : [];
  const floats = (node.floating ?? []).map((f: any) => f.content?.terminal).filter(Boolean);
  return [...own, ...floats, ...(node.children ?? []).flatMap(collect)];
}
