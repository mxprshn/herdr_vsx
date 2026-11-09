import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { Core } from './core';
import { CorePty } from './pty';
import { freshId, lastSegment, State, tabNode } from './state';
import { Programs, Startable } from './programs';
import { buildModel, programOf } from './model';
import { Message, Sidebar } from './sidebar';
import { Repos } from './repos';
import { ExplorerFollower } from './explorer';
import { FileTabs } from './filetabs';
import { paste } from './paste';
import { lastMessage, Notifier } from './notify';
import { findExplytSession, recentExplytSessions } from './duplicate';
import { findClaudeSession } from './transcript';
import { MobileServer } from './mobile';
import { Mascots } from './mascots';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const qrcode: (type: number, level: 'L' | 'M' | 'Q' | 'H') => any = require('../media/vendor/qrcode.js');
import * as fs from 'fs';

const HERDR_HOME = path.join(os.homedir(), '.config', 'herdr-app');
const NEW_SPACE = '__new_space__';
/** herdr-app's editor mod that file tabs open in; without it they'd be broken panes there. */
const EDITOR_MOD = 'my-editor';

/** The `hc` to run: the setting, else where the installers put it (an editor opened from the Dock has a short PATH). */
function hcPath(setting: string | undefined): string {
  if (setting && setting !== 'hc') return setting;
  const known = [path.join(os.homedir(), '.local', 'bin', 'hc'), '/opt/homebrew/bin/hc', '/usr/local/bin/hc'];
  return known.find((p) => fs.existsSync(p)) ?? 'hc';
}
const SHELL = process.env.SHELL || '/bin/sh';

let core: Core | undefined;

/** How herdr-app starts a command in the person's shell, so their PATH and profile apply. */
function inShell(cmd: string[]): string[] {
  const fish = path.basename(SHELL) === 'fish';
  const login = process.platform === 'darwin';
  const script = fish
    ? `command $argv[2..]; exec $argv[1] ${login ? '-li' : '-i'}`
    : `"$@"; exec "$0" ${login ? '-li' : '-i'}`;
  return [SHELL, login ? '-lic' : '-ic', script, SHELL, ...cmd];
}

/** Which agent commands the person's shell finds (an editor opened from the Dock has a short PATH). */
function installed(commands: string[]): Promise<Set<string>> {
  const line = commands.map((c) => `command -v '${c}' >/dev/null 2>&1 && printf 'herdr-has:%s\\n' '${c}';`).join(' ');
  return new Promise((resolve) => {
    execFile(SHELL, ['-lic', line], { timeout: 8000 }, (_e, out) => {
      resolve(new Set(String(out ?? '').split('herdr-has:').slice(1).map((s) => s.trim().split(/\s/)[0])));
    });
  });
}

function playSound(file: string) {
  const player = process.platform === 'darwin' ? ['afplay', [file]] : process.platform === 'linux' ? ['paplay', [file]] : undefined;
  if (!player) return;
  const p = spawn(player[0] as string, player[1] as string[], { stdio: 'ignore', detached: true });
  p.on('error', () => {});
  p.unref();
}

export function activate(context: vscode.ExtensionContext) {
  const config = () => vscode.workspace.getConfiguration('herdr');
  const programs = new Programs(context.asAbsolutePath('media'), HERDR_HOME);
  const open = new Map<string, vscode.Terminal>();
  const ptys = new Map<string, CorePty>();
  let state: State | undefined;
  let error: string | undefined;
  let active: string | undefined;
  let sort: 'priority' | 'space' = context.globalState.get('sort') ?? 'priority';
  let installedAgents: Set<string> | undefined;
  const repos = new Repos(path.join(HERDR_HOME, 'my-icons', 'github'), () => refresh());
  const mascots = new Mascots(context.asAbsolutePath('media/mascots'));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('herdr.mascots')) refresh(); }));
  const notifier = new Notifier(path.join(context.globalStorageUri.fsPath, 'notify'));
  const bannerGroup = (address: string) => `herdr-vsx:${address}`;
  // A banner's click opens `<editor>://mxprshn.herdr-vsx/open?t=<address>` and lands here.
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri(uri) {
      const address = new URLSearchParams(uri.query).get('t');
      if (uri.path === '/open' && address) openTerminal(address);
    },
  }));
  const explorer = new ExplorerFollower();
  const fileTabs = new FileTabs(() => state, (f) => explorer.project(f), () => currentSpace,
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'vscode');
  const syncFiles = () => {
    if (config().get<boolean>('filesFollowEditors', true) && fs.existsSync(path.join(HERDR_HOME, 'mods', EDITOR_MOD))) fileTabs.schedule();
  };
  context.subscriptions.push(fileTabs, vscode.window.tabGroups.onDidChangeTabs(syncFiles), vscode.window.tabGroups.onDidChangeTabGroups(syncFiles));

  /** Closes the editors of files whose space tab was closed, so the sync doesn't bring it back. */
  const closeEditors = (paths: string[]) => {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && paths.includes(t.input.uri.fsPath));
    if (tabs.length) void vscode.window.tabGroups.close(tabs);
  };
  let currentSpace: string | undefined;

  function selectSpace(spaceId: string | undefined) {
    const sp = spaceId ? state?.space(spaceId) : undefined;
    if (!state || !sp) return;
    if (currentSpace !== sp.id) {
      currentSpace = sp.id;
      refresh();
    }
    if (config().get<boolean>('explorerFollowsSpace', true)) explorer.follow(state.spaceFolder(sp), state.spaceName(sp));
  }

  const onMessage = (m: Message) => {
    switch (m.type) {
      case 'open': return openTerminal(m.address);
      case 'selectSpace': return selectSpace(m.space);
      case 'openFile':
        selectSpace(m.space);
        return void vscode.window.showTextDocument(vscode.Uri.file(m.file), { preview: false });
      case 'newTab': return void newTab(m.space, m.agent);
      case 'newSpace': return void newSpace(m.agent);
      case 'closeTab': return void closeTab(m.tab);
      case 'closeAgentTab': return void closeTab(m.tab, true);
      case 'gitSpace': return void git(m.space, m.op);
      case 'newNote': return void newNote(m.space);
      case 'closeSpace': return void closeSpace(m.space);
      case 'duplicate': return void duplicateAgent(m.address);
      case 'rename': return void renameSession(m.address, m.name);
      case 'pin': return void state?.label(m.address, { 'herdr.pinned': m.pinned ? '1' : '' });
    }
  };
  const agentsView = new Sidebar(context.extensionUri, 'agents', onMessage);
  const spacesView = new Sidebar(context.extensionUri, 'spaces', onMessage);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('herdr.agents', agentsView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('herdr.spaces', spacesView, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'herdr.focusAgents';
  context.subscriptions.push(status);

  let pending: NodeJS.Timeout | undefined;
  let lastModel: ReturnType<typeof buildModel> | undefined;
  const refresh = () => {
    if (pending) return;
    // Coalesce bursts of events (a working agent reports often).
    pending = setTimeout(() => {
      pending = undefined;
      const model = buildModel(state, programs, { active, current: currentSpace, lastProgram: context.globalState.get<string>('lastProgram'), mascot: config().get<boolean>('mascots', true) ? (k) => mascots.uri(k) : undefined, sort, error, installed: installedAgents, repo: (f) => repos.get(f) });
      agentsView.update(model);
      spacesView.update(model);
      lastModel = model;
      mobile?.modelChanged();
      const all = model.agents.flatMap((a) => [a, ...a.kids]);
      const waiting = all.filter((a) => a.word === 'blocked').length;
      const done = all.filter((a) => a.word === 'done').length;
      const working = all.filter((a) => a.word === 'working').length;
      const attention = waiting + done;
      agentsView.badge = attention ? { value: attention, tooltip: `${waiting} need you, ${done} done` } : undefined;
      agentsView.description = !state ? 'offline'
        : [waiting && `● ${waiting} need you`, done && `✓ ${done} done`, working && `◌ ${working} working`].filter(Boolean).join('  ') || `${all.length} idle`;
      const shown = model.spaces.find((sp) => sp.current);
      spacesView.description = !state ? undefined : shown ? `▸ ${shown.name}` : `${model.spaces.length}`;
      if (!state) { status.hide(); return; }
      const parts = [
        waiting ? `$(bell-dot) ${waiting}` : '',
        done ? `$(pass-filled) ${done}` : '',
        working ? `$(loading~spin) ${working}` : '',
      ].filter(Boolean);
      status.text = parts.length ? `herdr ${parts.join('  ')}` : '$(server-process) herdr';
      status.tooltip = `${working} working · ${waiting} need you · ${done} done`;
      status.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      status.show();
    }, 50);
  };

  // ------------------------------------------------------------- core

  let retry: NodeJS.Timeout | undefined;
  const connect = async () => {
    clearTimeout(retry);
    core?.dispose();
    core = state = undefined;
    error = undefined;
    refresh();
    try {
      const c = await Core.connect(hcPath(config().get<string>('hcPath')));
      const s = new State(c);
      s.on('changed', refresh);
      s.on('status', (address: string, before?: string, after?: string) => alert(s, address, before, after));
      c.on('lost', () => {
        if (core !== c) return;
        error = 'Lost herdr-core, reconnecting…';
        core = state = undefined;
        refresh();
        retry = setTimeout(connect, 2000);
      });
      await s.start();
      core = c;
      state = s;
      syncFiles();
      refresh();
    } catch (e: any) {
      error = `herdr-core: ${e.message}`;
      refresh();
    }
  };

  // ------------------------------------------------------------- attention

  const looking = (address: string) => vscode.window.state.focused && active === address;

  /** Herdr's rule: needing you always alerts; finishing alerts only if you weren't looking. */
  function alert(s: State, address: string, before?: string, after?: string) {
    const t = s.terminals.get(address);
    if (!t || t.parent) return;
    const blocked = (w?: string) => w === 'blocked' || w === 'error';
    const busy = (w?: string) => w === 'working' || blocked(w);
    if (looking(address)) { void s.markSeen(address); return; }
    let kind: 'blocked' | 'done' | undefined;
    if (blocked(after) && !blocked(before)) kind = 'blocked';
    else if (busy(before) && after && !busy(after)) kind = 'done';
    if (!kind) return;
    if (config().get<boolean>('sounds', true)) playSound(context.asAbsolutePath(`media/sounds/${kind === 'blocked' ? 'request' : 'done'}.mp3`));
    if (config().get<boolean>('notifications', true)) void announce(s, address, kind);
  }

  /** A notification with what the agent just said; a macOS banner too when VS Code is in the background. */
  async function announce(s: State, address: string, kind: 'blocked' | 'done') {
    const t = s.terminals.get(address);
    if (!t) return;
    const p = programOf(programs, t);
    const place = s.placeOf(address);
    const spaceName = place ? s.spaceName(place.space) : '';
    const topic = (t.status as any)?.msg || (place?.tab.name !== p.name ? place?.tab.name : '') || '';
    let said = '';
    try {
      const screen = await s.core.call('terminal.read', { terminal: address, lines: 0 }, 3000);
      said = lastMessage(String(screen?.text ?? ''), kind === 'blocked');
    } catch { /* the screen is a nicety */ }
    const head = `${p.name}${spaceName ? ` · ${spaceName}` : ''}`;
    const verb = kind === 'blocked' ? 'needs you' : 'finished';
    const message = said || topic || (kind === 'blocked' ? 'Waiting for your answer' : 'Done');

    if (!vscode.window.state.focused && config().get<boolean>('systemNotifications', true)) {
      const folder = place ? s.spaceFolder(place.space) : t.cwd ?? '';
      void notifier.show({
        group: bannerGroup(address),
        title: `${kind === 'blocked' ? '🔴' : '✅'} ${p.name} ${verb}`,
        subtitle: [spaceName, topic && topic !== said ? topic : ''].filter(Boolean).join(' › '),
        message,
        image: (config().get<boolean>('mascots', true) && mascots.png(p.key)) || repos.get(folder)?.avatarFile,
        icon: p.iconFile,
        url: `${vscode.env.uriScheme}://${context.extension.id}/open?t=${encodeURIComponent(address)}`,
      });
    }
    const show = kind === 'blocked' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(`${head} ${verb}: ${message}`, 'Open').then((pick) => { if (pick) openTerminal(address); });
  }

  // ------------------------------------------------------------- terminals

  function openTerminal(address: string) {
    const c = core;
    if (!c || !state) return;
    void state.markSeen(address);
    void notifier.remove(bannerGroup(address));
    selectSpace(state.placeOf(address)?.space.id);
    const existing = open.get(address);
    if (existing) { existing.show(); return; }
    const t = state.terminals.get(address);
    const p = programOf(programs, t);
    const place = state.placeOf(address);
    const title = place?.tab.name || (p.agent ? p.name : t?.title || p.name);
    const pty = new CorePty(c, address, () => { open.delete(address); ptys.delete(address); });
    ptys.set(address, pty);
    const term = vscode.window.createTerminal({
      name: place ? `${title} · ${state.spaceName(place.space)}` : `${title} · ${address}`,
      pty,
      location: config().get<string>('openIn') === 'panel' ? vscode.TerminalLocation.Panel : vscode.TerminalLocation.Editor,
      iconPath: p.iconFile && !p.tint ? vscode.Uri.file(p.iconFile) : new vscode.ThemeIcon(p.agent ? 'hubot' : 'terminal'),
      isTransient: true,
    });
    open.set(address, term);
    term.show();
  }

  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal((term) => {
    active = [...open].find(([, t]) => t === term)?.[0];
    void vscode.commands.executeCommand('setContext', 'herdr.terminalFocused', !!active);
    if (active) {
      void state?.markSeen(active);
      selectSpace(state?.placeOf(active)?.space.id);
    }
    refresh();
  }));
  context.subscriptions.push(vscode.window.onDidChangeWindowState((w) => {
    if (w.focused && active) void state?.markSeen(active);
  }));

  // ------------------------------------------------------------- layout edits

  type Pick = { argv?: string[]; name?: string };

  /** What a program key starts: `terminal` is the shell; the rest are agents from the program table. */
  function programPick(key: string): Pick | undefined {
    if (key === 'terminal') return {};
    const a = programs.startable().find((s) => s.key === key);
    return a ? { argv: inShell(a.run), name: a.name } : undefined;
  }

  const lastProgram = () => context.globalState.get<string>('lastProgram') ?? 'terminal';
  const remember = (key: string) => { void context.globalState.update('lastProgram', key); refresh(); };

  /** Terminal and the installed agents with their own icons, the last one used first. */
  async function pickProgram(title: string, step?: string): Promise<Pick | undefined> {
    installedAgents ??= await installed(programs.startable().map((s) => s.run[0]));
    const agents = programs.startable().filter((s) => installedAgents!.has(s.run[0]));
    const iconOf = (a: Startable) => (a.iconFile && !a.tint ? vscode.Uri.file(a.iconFile) : new vscode.ThemeIcon('hubot'));
    type Item = vscode.QuickPickItem & { key?: string };
    const items: Item[] = [
      { key: 'terminal', label: 'Terminal', description: path.basename(SHELL), iconPath: new vscode.ThemeIcon('terminal') },
      { label: 'Agents', kind: vscode.QuickPickItemKind.Separator },
      ...agents.map((a): Item => ({ key: a.key, label: a.name, description: a.run.join(' '), iconPath: iconOf(a) })),
    ];
    const last = items.find((i) => i.key === lastProgram());
    if (last) {
      items.splice(items.indexOf(last), 1);
      items.unshift({ ...last, detail: undefined, description: `${last.description ?? ''}  · last used`.trim() }, { label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    const pick = await vscode.window.showQuickPick(items, { title: step ? `${title} (${step})` : title, placeHolder: 'What to run — Enter starts the first' });
    if (!pick?.key) return undefined;
    remember(pick.key);
    return programPick(pick.key);
  }

  /** Starts a terminal labeled for its space and tab, so herdr-app files it there too. */
  async function run(cwd: string, spaceId: string, tabId: string, what: Pick): Promise<string> {
    const r = await core!.call('terminal.run', {
      argv: what.argv ?? [],
      cwd,
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'herdr' },
      labels: { 'herdr.space': spaceId, 'herdr.tab': tabId, 'herdr.seen': '0' },
      keep: true,
    });
    return r.address;
  }

  /**
   * A copy of an agent as a new tab next to it: the harness forks its session, so the copy
   * has the whole conversation and goes its own way. Explyt only, for now.
   */
  // ------------------------------------------------------------- phone

  /** The session file an agent runs, if its harness keeps one we can read; only sure matches. */
  async function sessionOf(address: string): Promise<{ file: string; kind: 'explyt' | 'claude' } | undefined> {
    const t = state?.terminals.get(address);
    if (!t) return undefined;
    const key = programOf(programs, t).key;
    const cwd = t.foreground?.cwd ?? t.cwd ?? '';
    if (key === 'explyt') {
      const s = findExplytSession(cwd, {
        topic: state!.renamed.get(address) ?? (t.status as any)?.msg,
        statusMs: Number(t.status_ms) || undefined,
        working: t.status?.state === 'working',
        startedMs: await processStart(t.foreground?.pid),
      });
      return s?.sure ? { file: s.file, kind: 'explyt' } : undefined;
    }
    if (key === 'claude' || key === 'claude-code') {
      const file = findClaudeSession(cwd, await processStart(t.foreground?.pid));
      return file ? { file, kind: 'claude' } : undefined;
    }
    return undefined;
  }

  let mobile: MobileServer | undefined;
  let qrPanel: vscode.WebviewPanel | undefined;

  async function openOnPhone() {
    mobile ??= new MobileServer({
      model: () => lastModel,
      sessionOf,
      screen: async (address) => String((await core?.call('terminal.read', { terminal: address, lines: 60 }, 4000))?.text ?? ''),
      send: async (address, text) => { await core?.call('terminal.send', { terminal: address, text, force: true }); },
      keys: async (address, keys) => { if (keys.length) await core?.call('terminal.keys', { terminal: address, keys }); },
    }, context.asAbsolutePath('media'));
    if (!mobile.running) {
      try {
        await mobile.start(config().get<number>('mobilePort', 7681));
      } catch (e: any) {
        void vscode.window.showErrorMessage(`Cannot start the phone server: ${e.message}`);
        return;
      }
    }
    const url = mobile.url;
    if (!url) { void vscode.window.showErrorMessage('No local network address: connect to Wi‑Fi and try again.'); return; }
    const q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    const svg = q.createSvgTag({ cellSize: 8, margin: 3, scalable: true });
    if (!qrPanel) {
      qrPanel = vscode.window.createWebviewPanel('herdr.phone', 'herdr on your phone', vscode.ViewColumn.Active, { enableScripts: true });
      qrPanel.iconPath = vscode.Uri.file(context.asAbsolutePath('media/icon.png'));
      qrPanel.onDidDispose(() => { qrPanel = undefined; });
      qrPanel.webview.onDidReceiveMessage((m) => {
        if (m === 'stop') { mobile?.stop(); qrPanel?.dispose(); void vscode.window.showInformationMessage('Phone access stopped.'); }
        if (m === 'rotate') { mobile?.rotate(); void openOnPhone(); }
        if (m === 'copy' && mobile?.url) void vscode.env.clipboard.writeText(mobile.url);
      });
    }
    qrPanel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);display:flex;flex-direction:column;align-items:center;padding:32px;gap:14px;text-align:center}
      .qr{background:#fff;padding:14px;border-radius:14px;width:300px;height:300px;box-sizing:border-box}.qr svg{width:100%;height:100%}
      h2{margin:0}p{margin:0;color:var(--vscode-descriptionForeground);max-width:420px;line-height:1.5}
      code{font-size:12px;word-break:break-all}.row{display:flex;gap:8px}
      button{font:inherit;padding:6px 12px;border:none;border-radius:2px;cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
      button.danger{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
    </style></head><body>
      <h2>Scan with your phone</h2>
      <div class="qr">${svg}</div>
      <p>Same Wi‑Fi as this Mac. The link carries a secret key: anyone with it can read and answer your agents, so don't share it.</p>
      <code>${url.replace(/#k=.*/, '#k=…')}</code>
      <div class="row"><button onclick="post('copy')">Copy link</button><button onclick="post('rotate')">New key</button><button class="danger" onclick="post('stop')">Stop</button></div>
      <script>const vs=acquireVsCodeApi();function post(m){vs.postMessage(m)}</script>
    </body></html>`;
    qrPanel.reveal();
  }

  async function duplicateAgent(address: string): Promise<void> {
    if (!state) return;
    const s = state;
    const t = s.terminals.get(address);
    const place = s.placeOf(address);
    const p = programOf(programs, t);
    if (!t || !place) return;
    if (p.key !== 'explyt') {
      void vscode.window.showInformationMessage(`Duplicating works for Explyt agents for now, not ${p.name}.`);
      return;
    }
    const cwd = t.foreground?.cwd ?? t.cwd ?? s.spaceFolder(place.space);
    const session = findExplytSession(cwd, {
      topic: (t.status as any)?.msg,
      statusMs: Number(t.status_ms) || undefined,
      working: t.status?.state === 'working',
      startedMs: await processStart(t.foreground?.pid),
    });
    if (!session) {
      void vscode.window.showErrorMessage(`No Explyt session found for ${lastSegment(cwd)}.`);
      return;
    }
    let file = session.file;
    // Not matched for sure: forking a neighbour's conversation would be worse than asking.
    if (!session.sure) {
      const ago = (ms: number) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
      const pick = await vscode.window.showQuickPick(
        recentExplytSessions(cwd).map((x) => ({ label: x.name || '(unnamed session)', description: ago(x.mtime), detail: path.basename(x.file), file: x.file })),
        { title: `Duplicate ${place.tab.name || p.name}: which session is it?`, placeHolder: `Couldn't tell which session this agent runs — pick it (newest first)` },
      );
      if (!pick) return;
      file = pick.file;
    }
    try {
      const tabId = freshId('tb');
      const address2 = await run(cwd, place.space.id, tabId, { argv: inShell(['explyt', '--fork', file]), name: p.name });
      const name = place.tab.name ? `${place.tab.name} (copy)` : '';
      await s.editDoc((doc) => {
        if (JSON.stringify(doc).includes(`"terminal":"${address2}"`)) return false;
        const sp = doc.spaces.find((x: any) => x.id === place.space.id);
        if (!sp) return false;
        const at = (sp.tabs ?? []).findIndex((x: any) => x.id === place.tab.id);
        sp.tabs.splice(at < 0 ? sp.tabs.length : at + 1, 0, tabNode(tabId, name, address2));
        return true;
      });
      openTerminal(address2);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Cannot duplicate: ${e.message}`);
    }
  }

  /** When a process started (`ps` speaks local time). */
  function processStart(pid: number | undefined): Promise<number | undefined> {
    if (!pid) return Promise.resolve(undefined);
    return new Promise((resolve) => execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (e, out) => {
      const ms = Date.parse(String(out ?? '').trim().replace(/\s+/g, ' '));
      resolve(e || Number.isNaN(ms) ? undefined : ms);
    }));
  }

  /**
   * Renames an Explyt agent's session with its own `/name`: the agent writes the name to the
   * session and reports it to herdr as its topic. Typed only while it waits for input.
   */
  /** `typed`: the name from the panel's inline editor; else asks. */
  async function renameSession(address: string, typed?: string): Promise<void> {
    if (!state || !core) return;
    const s = state;
    const t = s.terminals.get(address);
    if (!t) return;
    if (programOf(programs, t).key !== 'explyt') {
      void vscode.window.showInformationMessage('Renaming sessions works for Explyt agents for now.');
      return;
    }
    const name = (typed ?? await vscode.window.showInputBox({
      title: 'Rename session',
      value: (t.status as any)?.msg ?? '',
      prompt: 'The agent gets /name <name>: its session and its topic in herdr change.',
      validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
    }))?.trim().replace(/\s+/g, ' ');
    if (!name || name === (t.status as any)?.msg) { refresh(); return; }
    const now = s.terminals.get(address)?.status?.state;
    if (now !== 'done' && now !== 'idle') {
      void vscode.window.showWarningMessage(`The agent is ${now ?? 'busy'}: rename it once it waits for you, so /name doesn't mix into what it's doing.`);
      refresh();
      return;
    }
    try {
      await core.call('terminal.send', { terminal: address, text: `/name ${name}`, if: now });
      // Explyt reports its topic to herdr with its next status: show the new name now.
      s.renamed.set(address, name);
      refresh();
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Cannot rename: ${e.message}`);
      refresh();
    }
  }

  /** `program`: a key from the panel's + menu (no picker); else asks. */
  async function newTab(spaceId?: string, program?: string): Promise<void> {
    if (!state) return;
    const s = state;
    spaceId ??= await pickSpace();
    if (spaceId === NEW_SPACE) return newSpace();
    const space = spaceId && s.space(spaceId);
    if (!space) return;
    const what = program ? programPick(program) : await pickProgram(`New tab in ${s.spaceName(space)}`);
    if (!what) return;
    if (program) remember(program);
    try {
      const tabId = freshId('tb');
      const address = await run(s.spaceFolder(space) || os.homedir(), space.id, tabId, what);
      await s.editDoc((doc) => {
        if (JSON.stringify(doc).includes(`"terminal":"${address}"`)) return false; // herdr-app already placed it
        const sp = doc.spaces.find((x: any) => x.id === space.id);
        if (!sp) return false;
        (sp.tabs ??= []).push(tabNode(tabId, '', address));
        return true;
      });
      openTerminal(address);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Cannot start: ${e.message}`);
    }
  }

  /** Folders worth a space: this window's, then VS Code's recent ones; typing a path works too. */
  async function pickFolder(): Promise<string | undefined> {
    if (!state) return undefined;
    const s = state;
    const spaceAt = new Map(s.spaces.map((sp) => [s.spaceFolder(sp), s.spaceName(sp)]));
    type Item = vscode.QuickPickItem & { folder?: string; browse?: boolean };
    const seen = new Set<string>();
    const entry = (folder: string): Item | undefined => {
      if (seen.has(folder) || folder === os.homedir()) return undefined;
      seen.add(folder);
      const has = spaceAt.get(folder);
      return { folder, label: path.basename(folder), description: folder.replace(os.homedir(), '~'), detail: has ? `$(layers) already the space “${has}”` : undefined, iconPath: new vscode.ThemeIcon(has ? 'layers' : 'folder') };
    };
    const here = (vscode.workspace.workspaceFolders ?? []).map((f) => entry(f.uri.fsPath)).filter((x): x is Item => !!x);
    let recent: Item[] = [];
    try {
      const r: any = await vscode.commands.executeCommand('_workbench.getRecentlyOpened');
      recent = (r?.workspaces ?? [])
        .map((w: any) => w.folderUri ?? w.workspace?.configPath)
        .filter((u: any) => u?.scheme === 'file' && !u.path.endsWith('.code-workspace'))
        .map((u: any) => entry(vscode.Uri.from(u).fsPath))
        .filter((x: Item | undefined): x is Item => !!x)
        .slice(0, 12);
    } catch { /* an older VS Code: no recents */ }
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'New space (1/2): folder';
    qp.placeholder = 'Pick a folder, or type a path';
    qp.matchOnDescription = true;
    const base: Item[] = [
      ...(here.length ? [{ label: 'This window', kind: vscode.QuickPickItemKind.Separator } as Item, ...here] : []),
      ...(recent.length ? [{ label: 'Recent', kind: vscode.QuickPickItemKind.Separator } as Item, ...recent] : []),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Browse…', iconPath: new vscode.ThemeIcon('folder-opened'), browse: true, alwaysShow: true },
    ];
    qp.items = base;
    qp.onDidChangeValue((v) => {
      const typed = v.trim().replace(/^~(?=\/|$)/, os.homedir());
      const isDir = path.isAbsolute(typed) && fs.existsSync(typed) && fs.statSync(typed).isDirectory();
      qp.items = isDir ? [{ folder: typed, label: path.basename(typed) || typed, description: typed, iconPath: new vscode.ThemeIcon('folder'), alwaysShow: true }, ...base] : base;
    });
    const picked = await new Promise<Item | undefined>((resolve) => {
      qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.hide(); });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!picked) return undefined;
    if (!picked.browse) return picked.folder;
    const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use for space' });
    return chosen?.[0]?.fsPath;
  }

  /** `program`: a key from a + menu (no picker). A folder that already is a space gets a tab there. */
  async function newSpace(program?: string): Promise<void> {
    if (!state) return;
    const s = state;
    const folder = await pickFolder();
    if (!folder) return;
    const existing = s.spaces.find((sp) => s.spaceFolder(sp) === folder);
    if (existing) return newTab(existing.id, program);
    const what = program ? programPick(program) : await pickProgram(`New space in ${lastSegment(folder)}`, '2/2: what to run');
    if (!what) return;
    if (program) remember(program);
    try {
      const spaceId = freshId('sp');
      const tabId = freshId('tb');
      const address = await run(folder, spaceId, tabId, what);
      await s.editDoc((doc) => {
        if (JSON.stringify(doc).includes(`"terminal":"${address}"`)) return false;
        doc.spaces.push({ id: spaceId, name: '', folder, tabs: [tabNode(tabId, '', address)] });
        return true;
      });
      openTerminal(address);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Cannot start: ${e.message}`);
    }
  }

  /** Git in the space's folder. Pull only fast-forwards: never a merge commit or a rebase from a click. */
  async function git(spaceId: string, op: 'fetch' | 'pull') {
    const space = state?.space(spaceId);
    if (!state || !space) return;
    const name = state.spaceName(space);
    const folder = state.spaceFolder(space);
    const args = op === 'fetch' ? ['fetch', '--all', '--prune'] : ['pull', '--ff-only'];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Git ${op} in ${name}…` }, () =>
      new Promise<void>((resolve) => {
        execFile('git', args, { cwd: folder, timeout: 120000 }, (e, out, err) => {
          const said = `${out}\n${err}`.trim().split('\n').map((l) => l.trim()).filter((l) => l && !/^Fetching /.test(l));
          if (e) void vscode.window.showErrorMessage(`Git ${op} failed in ${name}: ${said.slice(-3).join(' ') || e.message}`);
          else void vscode.window.showInformationMessage(`${op === 'fetch' ? 'Fetched' : 'Pulled'} ${name}: ${said.slice(-2).join(' ') || 'Already up to date.'}`);
          resolve();
        });
      }));
  }

  /** A markdown file in the space's folder, opened in the editor; never overwrites one. */
  async function newNote(spaceId: string) {
    const space = state?.space(spaceId);
    if (!state || !space) return;
    const folder = state.spaceFolder(space);
    const d = new Date();
    const p = (v: number) => String(v).padStart(2, '0');
    const suggested = `notes-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.md`;
    let name = await vscode.window.showInputBox({
      title: `New markdown file in ${state.spaceName(space)}`,
      value: suggested,
      valueSelection: [0, suggested.length - 3],
      validateInput: (v) => (v.trim().startsWith('/') || v.split('/').includes('..') ? 'Use a name inside the space folder' : undefined),
    });
    name = name?.trim().replace(/^\.\/+/, '');
    if (!name) return;
    if (!/\.(md|markdown)$/i.test(name)) name += '.md';
    const file = path.join(folder, name);
    if (fs.existsSync(file)) { void vscode.window.showErrorMessage(`${name} already exists`); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${path.basename(name).replace(/\.(md|markdown)$/i, '')}\n\n`);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  /** Spaces, the one in the Explorer first; or a new one. */
  async function pickSpace(): Promise<string | undefined> {
    if (!state) return undefined;
    const s = state;
    const order = [...s.spaces].sort((a, b) => Number(b.id === currentSpace) - Number(a.id === currentSpace));
    const pick = await vscode.window.showQuickPick(
      [
        ...order.map((sp) => ({ label: s.spaceName(sp), description: s.spaceFolder(sp).replace(os.homedir(), '~'), id: sp.id, iconPath: new vscode.ThemeIcon(sp.id === currentSpace ? 'files' : 'layers') })),
        { label: '', kind: vscode.QuickPickItemKind.Separator, id: '' },
        { label: 'New space…', id: NEW_SPACE, iconPath: new vscode.ThemeIcon('new-folder'), alwaysShow: true },
      ],
      { title: 'New agent: which space', placeHolder: 'Space' },
    );
    return pick?.id || undefined;
  }

  async function killAll(addresses: string[]) {
    for (const a of addresses) {
      open.get(a)?.dispose();
      await core?.call('terminal.kill', { terminal: a }).catch(() => {});
    }
  }

  /** `ask`: always confirm (closing from the agents list, without looking at the tab). */
  async function closeTab(tabId: string, ask = false) {
    if (!state) return;
    const s = state;
    const space = s.spaces.find((sp) => sp.tabs.some((t) => t.id === tabId));
    const tab = space?.tabs.find((t) => t.id === tabId);
    if (!space || !tab) return;
    const busy = tab.terminals.filter((a) => s.word(s.terminals.get(a)) === 'working');
    if (ask || busy.length || tab.terminals.length > 1) {
      const name = tab.name || programOf(programs, s.terminals.get(tab.terminals[0])).name;
      const last = space.tabs.length === 1 ? `, and ${s.spaceName(space)} closes with its last tab` : '';
      const ok = await vscode.window.showWarningMessage(
        `Close “${name}”?`,
        { modal: true, detail: `${busy.length ? 'An agent in it is working. ' : ''}Its terminals and sub-agents end${last}.` }, 'Close');
      if (ok !== 'Close') return;
    }
    await s.editDoc((doc) => {
      const sp = doc.spaces.find((x: any) => x.id === space.id);
      if (!sp) return false;
      sp.tabs = (sp.tabs ?? []).filter((t: any) => t.id !== tabId);
      if (!sp.tabs.length) doc.spaces = doc.spaces.filter((x: any) => x.id !== space.id);
      return true;
    }).catch((e) => vscode.window.showErrorMessage(e.message));
    closeEditors(tab.files);
    await killAll(tab.terminals);
  }

  async function closeSpace(spaceId: string) {
    if (!state) return;
    const s = state;
    const space = s.space(spaceId);
    if (!space) return;
    const all = space.tabs.flatMap((t) => t.terminals);
    const ok = await vscode.window.showWarningMessage(
      `Close space “${s.spaceName(space)}”? Its ${all.length} terminal(s) will end.`, { modal: true }, 'Close');
    if (ok !== 'Close') return;
    await s.editDoc((doc) => {
      const before = doc.spaces.length;
      doc.spaces = doc.spaces.filter((x: any) => x.id !== spaceId);
      return doc.spaces.length !== before;
    }).catch((e) => vscode.window.showErrorMessage(e.message));
    closeEditors(space.tabs.flatMap((t) => t.files));
    await killAll(all);
  }

  async function rename(kind: 'space' | 'tab', id: string) {
    if (!state) return;
    const s = state;
    const space = kind === 'space' ? s.space(id) : s.spaces.find((sp) => sp.tabs.some((t) => t.id === id));
    const current = kind === 'space' ? space?.name : space?.tabs.find((t) => t.id === id)?.name;
    const name = await vscode.window.showInputBox({
      title: `Rename ${kind}`,
      value: current ?? '',
      prompt: kind === 'space' ? 'Empty: follow the folder' : 'Empty: follow what runs in it',
    });
    if (name === undefined) return;
    await s.editDoc((doc) => {
      const sp = doc.spaces.find((x: any) => (kind === 'space' ? x.id === id : (x.tabs ?? []).some((t: any) => t.id === id)));
      const target = kind === 'space' ? sp : sp?.tabs.find((t: any) => t.id === id);
      if (!target || target.name === name.trim()) return false;
      target.name = name.trim();
      return true;
    }).catch((e) => vscode.window.showErrorMessage(e.message));
  }

  // ------------------------------------------------------------- commands

  const setSort = (to: 'priority' | 'space') => {
    sort = to;
    void context.globalState.update('sort', to);
    void vscode.commands.executeCommand('setContext', 'herdr.sort', to);
    refresh();
  };
  void vscode.commands.executeCommand('setContext', 'herdr.sort', sort);

  /** Webview context menus pass the row's data-vscode-context. */
  type Ctx = { space?: string; tab?: string; address?: string; pinned?: boolean };

  context.subscriptions.push(
    vscode.commands.registerCommand('herdr.open', (a: string | Ctx) => { const x = typeof a === 'string' ? a : a?.address; if (x) openTerminal(x); }),
    vscode.commands.registerCommand('herdr.reconnect', connect),
    vscode.commands.registerCommand('herdr.paste', async () => {
      const pty = active ? ptys.get(active) : undefined;
      if (!pty) return vscode.commands.executeCommand('workbench.action.terminal.paste');
      await paste(pty.address, (d) => pty.handleInput(d), hcPath(config().get<string>('hcPath')));
    }),
    vscode.commands.registerCommand('herdr.newSpace', () => newSpace()),
    vscode.commands.registerCommand('herdr.newTab', (c?: Ctx) => newTab(c?.space)),
    vscode.commands.registerCommand('herdr.newAgent', () => newTab()),
    vscode.commands.registerCommand('herdr.duplicate', (c?: Ctx) => c?.address && duplicateAgent(c.address)),
    vscode.commands.registerCommand('herdr.renameSession', (c?: Ctx) => c?.address && renameSession(c.address)),
    vscode.commands.registerCommand('herdr.renameSpace', (c?: Ctx) => c?.space && rename('space', c.space)),
    vscode.commands.registerCommand('herdr.renameTab', (c?: Ctx) => c?.tab && rename('tab', c.tab)),
    vscode.commands.registerCommand('herdr.closeTab', (c?: Ctx) => c?.tab && closeTab(c.tab)),
    vscode.commands.registerCommand('herdr.gitFetch', (c?: Ctx) => c?.space && git(c.space, 'fetch')),
    vscode.commands.registerCommand('herdr.gitPull', (c?: Ctx) => c?.space && git(c.space, 'pull')),
    vscode.commands.registerCommand('herdr.newNote', (c?: Ctx) => c?.space && newNote(c.space)),
    vscode.commands.registerCommand('herdr.closeSpace', (c?: Ctx) => c?.space && closeSpace(c.space)),
    vscode.commands.registerCommand('herdr.pin', (c?: Ctx) => c?.address && state?.label(c.address, { 'herdr.pinned': '1' })),
    vscode.commands.registerCommand('herdr.unpin', (c?: Ctx) => c?.address && state?.label(c.address, { 'herdr.pinned': '' })),
    vscode.commands.registerCommand('herdr.kill', async (c?: Ctx) => {
      if (!c?.address) return;
      const ok = await vscode.window.showWarningMessage(`End ${c.address}?`, { modal: true }, 'End');
      if (ok === 'End') await killAll([c.address]);
    }),
    vscode.commands.registerCommand('herdr.sortSpace', () => setSort('space')),
    vscode.commands.registerCommand('herdr.sortPriority', () => setSort('priority')),
    vscode.commands.registerCommand('herdr.focusAgents', () => vscode.commands.executeCommand('herdr.agents.focus')),
    vscode.commands.registerCommand('herdr.goToAgent', async () => {
      if (!state) return;
      const s = state;
      const order = { blocked: 0, done: 1, working: 2, idle: 3 } as const;
      const items = s.agents()
        .sort((a, b) => order[s.word(a)!] - order[s.word(b)!])
        .map((t) => {
          const place = s.placeOf(t.address);
          return {
            label: `${programOf(programs, t).name}`,
            description: `${s.word(t)} · ${place ? s.spaceName(place.space) : t.address}`,
            detail: t.title || undefined,
            address: t.address,
          };
        });
      const pick = await vscode.window.showQuickPick(items, { title: 'Go to agent', matchOnDescription: true, matchOnDetail: true });
      if (pick) openTerminal(pick.address);
    }),
    vscode.commands.registerCommand('herdr.nextAttention', () => {
      if (!state) return;
      const s = state;
      const next = s.agents().filter((t) => s.word(t) === 'blocked').concat(s.agents().filter((t) => s.word(t) === 'done'))[0];
      if (next) openTerminal(next.address);
      else void vscode.window.showInformationMessage('No agent needs you.');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('herdr.hcPath')) void connect(); }),
    vscode.commands.registerCommand('herdr.openOnPhone', openOnPhone),
    { dispose: () => { clearTimeout(retry); core?.dispose(); mobile?.stop(); } },
  );

  void installed(programs.startable().map((s) => s.run[0])).then((found) => { installedAgents = found; refresh(); });
  void connect();
}

export function deactivate() {
  core?.dispose();
}
