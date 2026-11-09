// @ts-check
// Draws the Agents or Spaces panel from the model the extension posts.
(function () {
  const vscode = acquireVsCodeApi();
  const mode = document.body.dataset.mode;
  const root = /** @type {HTMLElement} */ (document.getElementById('root'));
  const saved = vscode.getState() ?? {};
  const folded = new Set(saved.folded ?? []);
  let filter = saved.filter ?? '';
  /** @type {any} */
  let model;

  const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
  const SECTION = { 4: 'Needs you', 3: 'Done', 2: 'Working', 1: 'Idle' };
  const SECTION_WORD = { 4: 'blocked', 3: 'done', 2: 'working', 1: 'idle' };

  const save = () => vscode.setState({ folded: [...folded], filter });
  const send = (msg) => vscode.postMessage(msg);

  /** Tiny element builder: h('div.a.b', {attrs/on*}, ...children). */
  function h(tag, props, ...kids) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(props ?? {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'context') el.dataset.vscodeContext = JSON.stringify({ preventDefaultContextMenuItems: true, ...v });
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const codicon = (name, cls = '') => h(`i.codicon.codicon-${name}${cls ? '.' + cls : ''}`);

  function duration(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const hr = Math.floor(m / 60);
    return hr < 24 ? `${hr}h` : `${Math.floor(hr / 24)}d`;
  }

  /** A program's icon: a tinted glyph (mask) or a picture; else a letter tile. */
  function icon(ref, name, big = false) {
    const cls = big ? '.icon.big' : '.icon';
    const found = ref && model.icons[ref.key];
    if (!found) return h(`span${cls}.letter`, {}, (name || '?').slice(0, 1).toUpperCase());
    if (found.tint) {
      const el = h(`span${cls}.glyph`);
      el.style.setProperty('-webkit-mask-image', `url("${found.uri}")`);
      el.style.setProperty('mask-image', `url("${found.uri}")`);
      return el;
    }
    return h(`img${cls}`, { src: found.uri, alt: '' });
  }

  function status(word, compact = false) {
    if (!word) return null;
    if (word === 'working') return h('span.st.working', { title: 'Working' }, codicon('loading', 'codicon-modifier-spin'));
    if (word === 'blocked') return compact
      ? h('span.st.blocked-mark', { title: 'Needs you' }, '!')
      : h('span.st.blocked-pill', { title: 'Waiting for you' }, 'Needs you');
    if (word === 'done') return h('span.st.dot.done', { title: 'Done (not seen yet)' });
    return h('span.st.dot.idle', { title: 'Idle' });
  }

  function action(iconName, title, run) {
    return h('button.act', { title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); run(e); } }, codicon(iconName));
  }

  function foldToggle(id) {
    folded.has(id) ? folded.delete(id) : folded.add(id);
    save();
    render();
  }

  const matches = (...texts) => !filter || texts.some((t) => (t ?? '').toLowerCase().includes(filter.toLowerCase()));

  // ---------------------------------------------------------------- Agents

  const rankOf = (a) => RANK[a.shown ?? a.word] ?? 0;
  /** Rows needing you, done unseen or working are tinted and outlined in that color. */
  const tone = (word) => (word === 'blocked' || word === 'done' || word === 'working' ? `.tone-${word}` : '');
  const flatKids = (a) => a.kids.flatMap((k) => [k, ...flatKids(k)]);

  /** A sub-agent row inside its agent's card, with tree lines; colored by its own state only. */
  function subRow(k, lines) {
    // Explyt titles every sub-agent by its kind ("Fork", "Subagent"): what it does says more.
    const generic = /^(fork|subagent)$/i.test(k.name) && Boolean(k.msg);
    const go = k.owner ?? k.address;
    return h(`div.row.sub${k.word === 'working' || k.word === 'blocked' ? '.sub-' + k.word : ''}`, {
      role: 'button',
      title: [k.name, k.msg].filter(Boolean).join('\n'),
      onclick: () => send({ type: 'open', address: go }),
      context: { webviewSection: 'pane', address: go },
    },
      lines.map((l) => h(`span.line${l ? '.' + (l === '│' ? 'through' : l === '└' ? 'last' : 'mid') : ''}`)),
      icon(k.icon, k.name),
      h('span.label', {},
        generic ? h('span.kind', {}, k.name.toLowerCase()) : h(`span.name${k.msg ? '.short' : ''}`, {}, k.name),
        k.msg ? h(generic ? 'span.name' : 'span.detail', {}, generic ? k.msg : ` ${k.msg}`) : null),
      status(k.word, true),
    );
  }

  function subTree(a, lead = []) {
    return a.kids.flatMap((k, i) => {
      const last = i === a.kids.length - 1;
      return [{ k, lines: [...lead, last ? '└' : '├'] }, ...subTree(k, [...lead, last ? '' : '│'])];
    });
  }

  const WORD_LABEL = { blocked: 'Needs you', done: 'Done', working: 'Working', idle: 'Idle' };

  /** An agent as a card: its topic, then where it runs and what it is; status on the right. */
  function agentRow(a, full) {
    const word = a.shown ?? a.word;
    const title = a.detail || a.name;
    const meta = [full || !a.space ? a.where : null, a.name !== title ? a.name : null, a.cwd && a.cwd !== a.where ? a.cwd : null].filter(Boolean);
    const hasKids = a.kids.length > 0;
    const open = !folded.has(`kids:${a.address}`);
    const subs = hasKids && open ? subTree(a) : [];
    const closeTab = () => send({ type: 'closeAgentTab', tab: a.tab, title: a.tabName, space: a.where, lastTab: a.lastTab });
    const top = flatKids(a).reduce((m, k) => ((RANK[k.word] ?? 0) > (RANK[m] ?? 0) ? k.word : m), null);
    const row = h(`div.agent-head${word === 'idle' && !a.active ? '.quiet' : ''}`, {
      role: 'button',
      tabindex: 0,
      title: [a.name, a.where, a.detail, a.cwd, a.address].filter(Boolean).join('\n'),
      onclick: () => send({ type: 'open', address: a.address }),
      onkeydown: (e) => { if (e.key === 'Enter') send({ type: 'open', address: a.address }); },
      context: { webviewSection: 'agent', address: a.address, pinned: a.pinned, tab: a.tab },
    },
      // The repo's avatar (else the space's letter), the agent's icon in its corner.
      h('span.ava', {},
        a.avatar ? h('img.ava-img', { src: a.avatar, alt: '' }) : h('span.ava-img.letter', {}, (a.where[0] ?? '?').toUpperCase()),
        h('span.ava-badge', { title: a.name }, icon(a.icon, a.name))),
      h('div.lines', {},
        h('div.line1', {},
          h('span.title', {}, title),
          a.pinned ? h('span.pin-mark', { title: 'Pinned' }, codicon('pinned')) : null,
          h('span.spacer'),
          h('span.hover-only', {},
            action(a.pinned ? 'pinned' : 'pin', a.pinned ? 'Unpin' : 'Pin to the top', () => send({ type: 'pin', address: a.address, pinned: !a.pinned })),
            a.tab ? action('close', 'Close this tab', closeTab) : null),
          a.since ? h('span.time.hover-hide', {}, duration(model.now - a.since)) : null),
        // As in a messenger: what it is on the second line, its state where an unread count goes.
        h('div.line2', {},
          h('span.meta', {}, meta.join(' · ')),
          a.address.includes('/') ? h('span.machine', {}, a.address.split('/')[0]) : null,
          word && word !== 'idle' ? h(`span.unread.${word}`, { title: WORD_LABEL[word] },
            word === 'working' ? codicon('loading', 'codicon-modifier-spin') : word === 'blocked' ? 'Needs you' : codicon('check')) : null)),
    );
    const kidsToggle = hasKids ? h(`button.kids-bar${open ? '' : tone(top)}`, { onclick: (e) => { e.stopPropagation(); foldToggle(`kids:${a.address}`); } },
      codicon(open ? 'chevron-down' : 'chevron-right'),
      `${flatKids(a).length} sub-agent${flatKids(a).length === 1 ? '' : 's'}`,
      !open && top && top !== 'idle' ? status(top, true) : null) : null;
    const kids = subs.map(({ k, lines }) => subRow(k, lines));
    return [h(`div.card.agent${a.active ? '.active' : ''}${tone(word)}`, {}, row, kidsToggle, kids.length ? h('div.kids-list', {}, kids) : null)];
  }

  function groupHeader(id, label, count, word, extra) {
    const open = !folded.has(id);
    return h(`div.group${open ? '' : '.closed'}`, { role: 'button', onclick: () => foldToggle(id) },
      codicon(open ? 'chevron-down' : 'chevron-right', 'chev'),
      h(`span.group-label${word ? '.' + word : ''}`, {}, label),
      h('span.count', {}, String(count)),
      h('span.spacer'),
      extra ?? null,
    );
  }

  function renderAgents() {
    let list = model.agents.filter((a) => matches(a.name, a.where, a.detail, a.address));
    const byPriority = model.sort === 'priority';
    list = [...list].sort((x, y) => (y.pinned - x.pinned) || (byPriority ? rankOf(y) - rankOf(x) : 0) || (y.since - x.since) || x.address.localeCompare(y.address));
    const out = [];
    if (!model.agents.length) {
      out.push(h('div.empty', {},
        h('p', {}, 'No agents yet.'),
        h('p.dim', {}, 'Agents show up here when they report their status.'),
        h('button.primary', { onclick: () => send({ type: 'newSpace' }) }, codicon('add'), ' Start an agent')));
      return out;
    }
    // One group per key, in the order its first member comes (a space never splits in two).
    const byKey = new Map();
    for (const a of list) {
      const id = a.pinned ? 'pinned' : byPriority ? `sec-${rankOf(a) || 1}` : `sp-${a.space ?? a.where}`;
      const g = byKey.get(id);
      if (g) g.members.push(a);
      else byKey.set(id, {
        id,
        label: a.pinned ? 'Pinned' : byPriority ? SECTION[rankOf(a) || 1] : a.where,
        word: a.pinned ? null : byPriority ? SECTION_WORD[rankOf(a) || 1] : null,
        members: [a],
      });
    }
    const groups = [...byKey.values()];
    // Grouped by space: spaces needing you first (blocked, then done unseen), then ones
    // where something runs, then the rest; within each, the one that changed last.
    if (!byPriority) {
      const has = (g, w) => g.members.some((a) => (a.shown ?? a.word) === w);
      const lead = (g) => (g.id === 'pinned' ? 9 : has(g, 'blocked') ? 3 : has(g, 'done') ? 2 : has(g, 'working') ? 1 : 0);
      const recent = (g) => Math.max(0, ...g.members.map((a) => a.since));
      groups.sort((x, y) => lead(y) - lead(x) || recent(y) - recent(x));
    }
    for (const g of groups) {
      const top = g.members.reduce((m, a) => ((RANK[a.shown ?? a.word] ?? 0) > (RANK[m] ?? 0) ? a.shown ?? a.word : m), null);
      out.push(groupHeader(`ag:${g.id}`, g.label, g.members.length, g.word, folded.has(`ag:${g.id}`) && !byPriority ? status(top, true) : null));
      if (!folded.has(`ag:${g.id}`)) for (const a of g.members) out.push(...agentRow(a, byPriority || a.pinned));
    }
    if (!list.length) out.push(h('div.empty.dim', {}, 'Nothing matches.'));
    return out;
  }

  // ---------------------------------------------------------------- Spaces

  function tabRow(space, tab) {
    const lead = tab.lead;
    const multi = tab.panes.length > 1;
    const open = !folded.has(`tab:${tab.id}`);
    const go = () => {
      if (lead) send({ type: 'open', address: lead.address });
      else if (tab.file) send({ type: 'openFile', file: tab.file, space: space.id });
    };
    const row = h(`div.row.tab${tab.active ? '.active' : ''}${tone(tab.word)}`, {
      role: 'button',
      tabindex: 0,
      title: [tab.name, lead?.cwd ?? tab.file, lead?.address].filter(Boolean).join('\n'),
      onclick: go,
      onkeydown: (e) => { if (e.key === 'Enter') go(); },
      context: { webviewSection: 'tab', space: space.id, tab: tab.id, address: lead?.address },
    },
      tab.file && !lead ? h('span.icon.file', {}, codicon('file')) : icon(lead?.icon, lead?.name ?? tab.name),
      h('span.label', {},
        h('span.name', {}, tab.name),
        tab.detail ? h('span.detail', {}, ` · ${tab.detail}`) : null),
      multi ? h('button.kids', { title: `${tab.panes.length} panes`, onclick: (e) => { e.stopPropagation(); foldToggle(`tab:${tab.id}`); } },
        codicon('split-horizontal'), String(tab.panes.length)) : null,
      h('span.hover-only', {}, action('close', 'Close tab (ends its terminals)', () => send({ type: 'closeTab', tab: tab.id }))),
      h('span.hover-hide', {}, status(tab.word, true)),
    );
    const panes = multi && open ? tab.panes.map((p) => h(`div.row.pane${p.active ? '.active' : ''}${tone(p.word)}`, {
      role: 'button',
      onclick: () => send({ type: 'open', address: p.address }),
      context: { webviewSection: 'pane', address: p.address },
      title: [p.name, p.cwd, p.address].filter(Boolean).join('\n'),
    }, icon(p.icon, p.name), h('span.label', {}, h('span.name', {}, p.title || p.name), h('span.detail', {}, ` · ${p.address}`)), status(p.word, true))) : [];
    return [row, ...panes];
  }

  function spaceBlock(space) {
    const id = `space:${space.id}`;
    const open = !folded.has(id);
    const tabs = space.tabs.filter((t) => matches(space.name, t.name, t.detail, ...t.panes.map((p) => p.name)));
    if (filter && !tabs.length) return [];
    // A summary of the space's agents by state, so a folded card still tells what's inside.
    const words = space.tabs.flatMap((t) => t.panes.map((p) => p.word)).filter(Boolean);
    const count = (w) => words.filter((x) => x === w).length;
    const summary = ['blocked', 'done', 'working'].filter(count).map((w) => h(`span.chip.${w}`, { title: `${count(w)} ${WORD_LABEL[w].toLowerCase()}` },
      w === 'working' ? codicon('loading', 'codicon-modifier-spin') : w === 'blocked' ? '!' : codicon('check'), String(count(w))));
    const header = h(`div.tree-space${open ? '' : '.closed'}${space.current ? '.current' : ''}`, {
      role: 'button',
      title: space.folder === '~' ? `${space.folder}\nThe home folder is never added to the Explorer`
        : space.current ? `${space.folder}\nShown in the Explorer` : `${space.folder}\nClick to show it in the Explorer`,
      onclick: () => {
        if (space.current || !open) foldToggle(id);
        send({ type: 'selectSpace', space: space.id });
      },
      context: { webviewSection: 'space', space: space.id, git: !!space.git },
    },
      codicon(open ? 'chevron-down' : 'chevron-right', 'twisty'),
      space.avatar ? h('img.space-avatar', { src: space.avatar, alt: '' }) : h('span.space-avatar.letter', {}, (space.name[0] ?? '?').toUpperCase()),
      h('span.label', {},
        h('span.name', {}, space.name),
        h('span.detail', {}, space.folder !== space.name ? ` ${space.folder}` : '')),
      space.current && space.folder !== '~' ? h('span.here', { title: 'Shown in the Explorer' }, codicon('files')) : null,
      h('span.hover-only', {},
        space.git ? action('repo-pull', 'Git pull (fast-forward only)', () => send({ type: 'gitSpace', space: space.id, op: 'pull' })) : null,
        action('add', 'New agent or terminal here', (e) => openLaunch(e.currentTarget, (agent) => send({ type: 'newTab', space: space.id, agent }))),
        action('close', 'Close space (ends its terminals)', () => send({ type: 'closeSpace', space: space.id }))),
      h('span.hover-hide.chips', {}, summary.length ? summary : h('span.count', {}, String(space.tabs.length))),
    );
    const body = open || filter ? h('div.tree-children', {}, tabs.flatMap((t) => tabRow(space, t))) : null;
    return [h(`div.tree-node${space.current ? '.current' : ''}`, {}, header, body)];
  }

  function renderSpaces() {
    const out = model.spaces.flatMap(spaceBlock);
    const loose = model.unplaced.filter((t) => matches(t.name, t.title, t.cwd, t.address));
    if (loose.length) {
      out.push(groupHeader('loose', 'Not in a space', loose.length, null));
      if (!folded.has('loose')) for (const t of loose) out.push(h(`div.row.tab${t.active ? '.active' : ''}`, {
        role: 'button',
        onclick: () => send({ type: 'open', address: t.address }),
        context: { webviewSection: 'pane', address: t.address },
        title: [t.cwd, t.address].join('\n'),
      }, icon(t.icon, t.name), h('span.label', {}, h('span.name', {}, t.title || t.name), h('span.detail', {}, ` · ${t.address}`)), status(t.word, true)));
    }
    if (!model.spaces.length && !loose.length) out.push(h('div.empty', {}, h('p', {}, 'No spaces yet.')));
    out.push(h('button.new-space', { onclick: () => send({ type: 'newSpace' }) }, codicon('new-folder'), ' New space…'));
    return out;
  }

  // ---------------------------------------------------------------- + menu

  /** A small menu under a + : what to start, the last used first, one click. Number keys pick. */
  let launch;
  function closeLaunch() { launch?.remove(); launch = undefined; }
  function openLaunch(anchor, pick) {
    closeLaunch();
    const programs = [{ key: 'terminal', name: 'Terminal' }, ...model.startable];
    const last = programs.findIndex((p) => p.key === model.lastProgram);
    if (last > 0) programs.unshift(...programs.splice(last, 1));
    const choose = (key) => { closeLaunch(); pick(key); };
    launch = h('div.launch', { role: 'menu', tabindex: -1,
      onkeydown: (e) => {
        if (e.key === 'Escape') closeLaunch();
        const n = Number(e.key);
        if (n >= 1 && n <= programs.length) choose(programs[n - 1].key);
      } },
      programs.map((p, i) => h('button.launch-item', { role: 'menuitem', onclick: (e) => { e.stopPropagation(); choose(p.key); } },
        p.key === 'terminal' ? h('span.icon.file', {}, codicon('terminal')) : icon(p.icon, p.name),
        h('span.label', {}, p.name),
        i === 0 && model.lastProgram ? h('span.launch-hint', {}, 'last') : null,
        i < 9 ? h('kbd', {}, String(i + 1)) : null)),
    );
    document.body.append(launch);
    const r = anchor.getBoundingClientRect();
    const w = launch.offsetWidth, hgt = launch.offsetHeight;
    launch.style.left = `${Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4))}px`;
    launch.style.top = `${r.bottom + 4 + hgt > window.innerHeight ? Math.max(4, r.top - hgt - 4) : r.bottom + 4}px`;
    launch.focus();
  }
  document.addEventListener('mousedown', (e) => { if (launch && !launch.contains(e.target)) closeLaunch(); });
  window.addEventListener('blur', closeLaunch);

  // ---------------------------------------------------------------- frame

  /** @type {HTMLInputElement | undefined} */
  let search;

  function render() {
    if (!model) return;
    const focused = document.activeElement === search;
    const top = root.scrollTop;
    root.replaceChildren();
    if (!model.connected) {
      root.append(h('div.empty', {}, h('p', {}, codicon('plug'), ' ', model.error ?? 'Connecting to herdr-core…')));
      return;
    }
    search = /** @type {HTMLInputElement} */ (h('input.search', {
      type: 'search',
      placeholder: mode === 'agents' ? 'Filter agents' : 'Filter spaces and tabs',
      value: filter,
      oninput: (e) => { filter = e.target.value; save(); render(); },
      onkeydown: (e) => { if (e.key === 'Escape') { filter = ''; save(); render(); } },
    }));
    search.value = filter;
    const list = h('div.list', {}, mode === 'agents' ? renderAgents() : renderSpaces());
    const plus = h('button.bar-add', { title: mode === 'agents' ? 'New agent' : 'New space', onclick: (e) => mode === 'agents'
      ? openLaunch(e.currentTarget, (agent) => send({ type: 'newTab', agent }))
      : send({ type: 'newSpace' }) }, codicon(mode === 'agents' ? 'add' : 'new-folder'));
    root.append(h('div.bar', {}, search, plus), list);
    root.scrollTop = top;
    if (focused) { search.focus(); search.setSelectionRange(filter.length, filter.length); }
  }

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'model') { model = e.data.model; render(); }
    if (e.data?.type === 'focusSearch') search?.focus();
  });
  setInterval(() => { if (model) { model.now = Date.now(); render(); } }, 30000);
  send({ type: 'ready' });
})();
