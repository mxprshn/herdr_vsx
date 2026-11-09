// What the sidebar shows: a plain snapshot built from the core's state, sent to the webviews.
import * as os from 'os';
import { TerminalRecord } from './core';
import { Program, Programs } from './programs';
import { AgentWord, lastSegment, State } from './state';

export interface IconRef { key: string; tint: boolean }

export interface TerminalVM {
  address: string;
  name: string;
  icon?: IconRef;
  /** The program table's key (`claude`, `explyt`, `shell`…). */
  program: string;
  word?: AgentWord;
  title: string;
  cwd: string;
  live: boolean;
  shell: boolean;
  active: boolean;
}

export interface TabVM { id: string; name: string; detail: string; word?: AgentWord; lead?: TerminalVM; panes: TerminalVM[]; file?: string; active: boolean }
export interface SpaceVM { id: string; name: string; folder: string; word?: AgentWord; attention: number; tabs: TabVM[]; avatar?: string; git?: boolean; current?: boolean }

export interface RepoInfo { git: boolean; avatar?: string; avatarFile?: string }

export interface AgentVM extends TerminalVM {
  since: number;
  where: string;
  detail: string;
  pinned: boolean;
  /** The session's name the agent reports (Explyt: `/name`), editable inline. */
  session?: string;
  /** What the agent says it is doing (sub-agents: OSC 7501 `msg`). */
  msg: string;
  /** A child record reported by its owner (no terminal of its own): opening it opens the owner. */
  owner?: string;
  space?: string;
  tab?: string;
  tabName?: string;
  /** The last tab of its space: closing it closes the space. */
  lastTab?: boolean;
  /** Its repo owner's avatar (the space's, else its folder's). */
  avatar?: string;
  /** The harness's mascot (`herdr.mascots`): then it is the big picture and the repo goes in the corner. */
  mascot?: string;
  /** The status the row shows: its own, raised by a working or blocked sub-agent. */
  shown?: AgentWord;
  kids: AgentVM[];
}

export interface Model {
  connected: boolean;
  error?: string;
  sort: 'priority' | 'space';
  agents: AgentVM[];
  spaces: SpaceVM[];
  unplaced: TerminalVM[];
  startable: { key: string; name: string; icon?: IconRef }[];
  /** The program last started from a + (first in menus). */
  lastProgram?: string;
  icons: Record<string, { uri: string; tint: boolean }>;
  now: number;
}

const RANK: Record<AgentWord, number> = { blocked: 4, done: 3, working: 2, idle: 1 };

export function rollup(words: (AgentWord | undefined)[]): AgentWord | undefined {
  return words.reduce<AgentWord | undefined>((m, w) => (w && (!m || RANK[w] > RANK[m]) ? w : m), undefined);
}

/**
 * A window title worth showing: not a path, a prompt or the program's own name;
 * without the program and folder that agents put around their topic (`explyt - topic - repo`).
 */
function telling(title: string | undefined, p: Program, cwd: string): string {
  let s = (title ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const folder = lastSegment(cwd);
  for (const word of [p.key, p.name]) if (s.toLowerCase().startsWith(`${word.toLowerCase()} - `)) s = s.slice(word.length + 3);
  if (folder && s.endsWith(` - ${folder}`)) s = s.slice(0, -(folder.length + 3));
  if (!s || s === p.name || s === folder || s.toLowerCase() === p.key || /^[~/]|^[A-Za-z]:\\/.test(s) || s.includes('@')) return '';
  return s;
}

/** A sub-agent's word: error counts as blocked; it is never done (its parent's done is the news). */
function kidWord(w: string | undefined): AgentWord | undefined {
  if (!w) return undefined;
  if (w === 'error' || w === 'blocked') return 'blocked';
  if (w === 'working') return 'working';
  return 'idle';
}

/**
 * A terminal's child records (OSC 7501 `id=a/b`, e.g. Explyt's subagents, which run
 * without a terminal) as a forest: each under its nearest reported ancestor.
 */
function recordKids(owner: AgentVM, records: Record<string, any> | undefined): AgentVM[] {
  const ids = Object.keys(records ?? {});
  const nodes = new Map<string, AgentVM>(ids.map((id) => {
    const s = records![id] ?? {};
    return [id, {
      ...owner,
      address: `${owner.address}#${id}`,
      name: s.title || id.split('/').at(-1) || id,
      title: '',
      msg: s.msg || '',
      word: kidWord(s.state),
      since: 0,
      detail: '',
      pinned: false,
      active: false,
      owner: owner.owner ?? owner.address,
      kids: [],
    }];
  }));
  const roots: AgentVM[] = [];
  for (const id of ids) {
    const parts = id.split('/');
    let up: AgentVM | undefined;
    for (let n = parts.length - 1; n > 0 && !up; n--) up = nodes.get(parts.slice(0, n).join('/'));
    (up ? up.kids : roots).push(nodes.get(id)!);
  }
  return roots;
}

function descendants(a: AgentVM): AgentVM[] {
  return a.kids.flatMap((k) => [k, ...descendants(k)]);
}

export function tilde(p: string): string {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

export function programOf(programs: Programs, t: TerminalRecord | undefined): Program {
  const argv = t?.foreground?.argv ?? (t?.argv as string[] | undefined) ?? [];
  return programs.of(t?.status?.app || undefined, argv);
}

export function buildModel(
  state: State | undefined,
  programs: Programs,
  opts: { active?: string; current?: string; lastProgram?: string; mascot?: (program: string) => string | undefined; sort: 'priority' | 'space'; error?: string; installed?: Set<string>; repo?: (folder: string) => RepoInfo | undefined },
): Model {
  const icons: Model['icons'] = {};
  const iconRef = (p: Program): IconRef | undefined => {
    if (!p.icon) return undefined;
    icons[p.key] ??= { uri: p.icon, tint: p.tint };
    return { key: p.key, tint: p.tint };
  };
  const startable = programs.startable()
    .filter((s) => !opts.installed || opts.installed.has(s.run[0]))
    .map((s) => ({ key: s.key, name: s.name, icon: iconRef(s) }));
  const base: Model = { connected: !!state, error: opts.error, sort: opts.sort, agents: [], spaces: [], unplaced: [], startable, lastProgram: opts.lastProgram, icons, now: Date.now() };
  if (!state) return base;

  const terminal = (address: string): TerminalVM => {
    const t = state.terminals.get(address);
    const p = programOf(programs, t);
    const cwd = t?.foreground?.cwd ?? t?.cwd ?? '';
    return {
      address,
      name: p.name,
      icon: iconRef(p),
      program: p.key,
      word: state.word(t),
      title: telling(t?.title, p, cwd),
      cwd: tilde(cwd),
      live: t?.state === 'live',
      shell: p.shell,
      active: address === opts.active,
    };
  };

  base.spaces = state.spaces.map((s) => {
    const tabs = s.tabs.map((tab, i): TabVM => {
      const panes = tab.terminals.map(terminal);
      const lead = panes.find((p) => p.word) ?? panes[0];
      const file = tab.files[0];
      const auto = lead ? (lead.word || !lead.shell ? lead.name : lead.title || lead.name) : file ? lastSegment(file) : `${i + 1}`;
      return {
        id: tab.id,
        name: tab.name || auto,
        detail: lead?.word ? lead.title : lead?.shell ? lastSegment(lead.cwd) : '',
        file: lead ? undefined : file,
        word: rollup(panes.map((p) => p.word)),
        lead,
        panes,
        active: panes.some((p) => p.active),
      };
    });
    const words = tabs.flatMap((t) => t.panes.map((p) => p.word));
    const repo = opts.repo?.(state.spaceFolder(s));
    return {
      current: s.id === opts.current,
      avatar: repo?.avatar,
      git: repo?.git,
      id: s.id,
      name: state.spaceName(s),
      folder: tilde(state.spaceFolder(s)),
      word: rollup(words),
      attention: words.filter((w) => w === 'blocked' || w === 'done').length,
      tabs,
    };
  });

  const placed = new Set(state.spaces.flatMap((s) => s.tabs.flatMap((t) => t.terminals)));
  base.unplaced = state.live().filter((t) => !placed.has(t.address) && !t.parent).map((t) => terminal(t.address));

  const agentVM = (t: TerminalRecord): AgentVM => {
    const vm = terminal(t.address);
    const place = state.placeOf(t.address);
    const tabName = place?.tab.name && place.tab.name !== vm.name && !/^\d+$/.test(place.tab.name) ? place.tab.name : '';
    // The session's name, when the agent reports one (Explyt's /name), comes before the tab's.
    const session = state.renamed.get(t.address) ?? (t.status as any)?.msg ?? '';
    return {
      ...vm,
      since: Number(t.status_ms ?? 0),
      where: place ? state.spaceName(place.space) : lastSegment(vm.cwd) || vm.cwd,
      detail: session || tabName || vm.title,
      session,
      pinned: !!t.labels?.['herdr.pinned'],
      msg: '',
      space: place?.space.id,
      tab: place?.tab.id,
      tabName: place ? place.tab.name || vm.name : undefined,
      lastTab: place ? place.space.tabs.length === 1 : undefined,
      avatar: opts.repo?.(place ? state.spaceFolder(place.space) : t.foreground?.cwd ?? t.cwd ?? '')?.avatar,
      mascot: opts.mascot?.(vm.program),
      kids: [],
    };
  };
  const live = state.agents();
  const byAddress = new Map(live.map((t) => [t.address, agentVM(t)]));
  // Sub-agents: terminals an agent started (`hc run`), then the child records it reports.
  for (const t of live) {
    const parent = t.parent ? byAddress.get(t.parent) : undefined;
    const vm = byAddress.get(t.address)!;
    if (parent) parent.kids.push({ ...vm, word: kidWord(t.status?.state) });
  }
  for (const t of live) {
    const vm = byAddress.get(t.address)!;
    vm.kids.push(...recordKids(vm, t.records as Record<string, any> | undefined));
  }
  // An agent counts as working while a sub-agent works, even when it finished or idles
  // itself; one with a blocked sub-agent is blocked.
  for (const vm of byAddress.values()) {
    const kid = rollup(descendants(vm).map((k) => k.word));
    vm.shown = vm.word === 'blocked' || kid === 'blocked' ? 'blocked' : kid === 'working' ? 'working' : vm.word;
  }
  base.agents = live.filter((t) => !t.parent || !byAddress.has(t.parent)).map((t) => byAddress.get(t.address)!);
  return base;
}
