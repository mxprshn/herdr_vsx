// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const root = /** @type {HTMLElement} */ (document.getElementById('root'));
  const saved = vscode.getState() ?? {};
  const folded = new Set(saved.folded ?? []);
  let filter = saved.filter ?? '';
  /** @type {any} */
  let model;
  let editing = false;
  let openTimer;
  let launch;
  /** @type {HTMLInputElement | undefined} */
  let search;

  const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
  const WORD_LABEL = { blocked: 'Needs you', done: 'Done', working: 'Working', idle: 'Idle' };
  const save = () => vscode.setState({ folded: [...folded], filter });
  const send = (msg) => vscode.postMessage(msg);

  function h(tag, props, ...kids) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value == null || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'context') el.dataset.vscodeContext = JSON.stringify({ preventDefaultContextMenuItems: true, ...value });
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const codicon = (name, cls = '') => h(`i.codicon.codicon-${name}${cls ? '.' + cls : ''}`);
  const matches = (...texts) => !filter || texts.some((text) => (text ?? '').toLowerCase().includes(filter.toLowerCase()));
  const duration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  };
  const tone = (word) => word === 'blocked' || word === 'done' || word === 'working' ? ` tone-${word}` : '';
  const flatKids = (agent) => agent.kids.flatMap((kid) => [kid, ...flatKids(kid)]);

  function icon(ref, name, big = false) {
    const found = ref && model.icons[ref.key];
    const cls = big ? 'icon big' : 'icon';
    if (!found) return h(`span.${cls}.letter`, {}, (name || '?').slice(0, 1).toUpperCase());
    if (found.tint) {
      const glyph = h(`span.${cls}.glyph`);
      glyph.style.setProperty('-webkit-mask-image', `url("${found.uri}")`);
      glyph.style.setProperty('mask-image', `url("${found.uri}")`);
      return glyph;
    }
    return h(`img.${cls}`, { src: found.uri, alt: '' });
  }

  function status(word, compact = false) {
    if (word === 'working') return h('span.st.working', { title: 'Working' }, codicon('loading', 'codicon-modifier-spin'));
    if (word === 'blocked') return compact ? h('span.st.blocked-mark', { title: 'Needs you' }, '!') : h('span.st.blocked-pill', { title: 'Waiting for you' }, 'Needs you');
    if (word === 'done') return h('span.st.dot.done', { title: 'Done (not seen yet)' });
    return word ? h('span.st.dot.idle', { title: 'Idle' }) : null;
  }

  function action(name, title, run) {
    return h('button.act', { title, 'aria-label': title, onclick: (event) => { event.stopPropagation(); run(event); } }, codicon(name));
  }

  function toggle(id) {
    folded.has(id) ? folded.delete(id) : folded.add(id);
    save();
    render();
  }

  function subRow(agent) {
    const generic = /^(fork|subagent)$/i.test(agent.name) && Boolean(agent.msg);
    const address = agent.owner ?? agent.address;
    const row = h(`div.item sub-item${tone(agent.word)}`, {
      role: 'button', title: [agent.name, agent.msg].filter(Boolean).join('\n'),
      onclick: () => send({ type: 'open', address }), context: { webviewSection: 'pane', address },
    },
      h('span.item-icon', {}, icon(agent.icon, agent.name)),
      h('span.label', {}, generic ? h('span.kind', {}, agent.name.toLowerCase()) : h('span.name', {}, agent.name), agent.msg ? h('span.detail', {}, generic ? agent.msg : ` · ${agent.msg}`) : null),
      status(agent.word, true));
    return [row, ...agent.kids.flatMap(subRow)];
  }

  function editTitle(span, agent) {
    if (editing) return;
    editing = true;
    const before = agent.session || span.textContent;
    const input = h('input.title-edit', { type: 'text', value: before, 'aria-label': 'Session name' });
    let done = false;
    const finish = (saveName) => {
      if (done) return;
      done = true;
      editing = false;
      const name = input.value.trim().replace(/\s+/g, ' ');
      if (saveName && name && name !== before) send({ type: 'rename', address: agent.address, name });
      input.replaceWith(span);
      render();
    };
    for (const event of ['click', 'mousedown', 'dblclick']) input.addEventListener(event, (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(false));
    span.replaceWith(input);
    input.focus();
    input.select();
  }

  function agentRow(agent) {
    const word = agent.shown ?? agent.word;
    const title = agent.detail || agent.name;
    const old = agent.since && model.now - agent.since > 86400000;
    const closeTab = () => send({ type: 'closeAgentTab', tab: agent.tab, title: agent.tabName, space: agent.where, lastTab: agent.lastTab });
    if (old && !agent.kids.length) return h(`div.item compact-item${agent.active ? ' active' : ''}`, {
      role: 'button', title: [title, agent.where, agent.name, agent.address].filter(Boolean).join(' · '),
      onclick: () => send({ type: 'open', address: agent.address }),
      context: { webviewSection: 'agent', address: agent.address, pinned: agent.pinned, tab: agent.tab, program: agent.program },
    }, h('span.item-icon', {}, icon(agent.icon, agent.name)), h('span.label', {}, h('span.name', {}, title), h('span.detail', {}, ` · ${agent.where}`)), h('span.time', {}, duration(model.now - agent.since)), status(word, true));

    const open = !folded.has(`kids:${agent.address}`);
    const titleNode = agent.program === 'explyt'
      ? h('span.title.editable', { title: 'Double-click to rename the session', ondblclick: (e) => { e.stopPropagation(); clearTimeout(openTimer); editTitle(e.currentTarget, agent); } }, title)
      : h('span.title', {}, title);
    const head = h(`div.agent-item${agent.active ? ' active' : ''}${tone(word)}`, {
      role: 'button', tabindex: 0, title: [agent.name, agent.where, agent.detail, agent.cwd, agent.address].filter(Boolean).join('\n'),
      onclick: (e) => { const go = () => send({ type: 'open', address: agent.address }); if (!e.target.closest?.('.title.editable')) return go(); clearTimeout(openTimer); openTimer = setTimeout(go, 260); },
      onkeydown: (e) => { if (e.key === 'Enter') send({ type: 'open', address: agent.address }); },
      context: { webviewSection: 'agent', address: agent.address, pinned: agent.pinned, tab: agent.tab, program: agent.program },
    },
      h('span.item-icon.avatar-rail', {}, agent.mascot ? h('span.ava mascot', {}, h('img.ava-img', { src: agent.mascot, alt: '', title: agent.name }), h('span.ava-badge.repo', { title: agent.where }, agent.avatar ? h('img', { src: agent.avatar, alt: '' }) : h('span.letter', {}, (agent.where[0] ?? '?').toUpperCase()))) : h('span.ava', {}, agent.avatar ? h('img.ava-img', { src: agent.avatar, alt: '' }) : h('span.ava-img.letter', {}, (agent.where[0] ?? '?').toUpperCase()), h('span.ava-badge', { title: agent.name }, icon(agent.icon, agent.name)))),
      h('div.lines', {}, h('div.line1', {}, titleNode, agent.pinned ? h('span.pin-mark', { title: 'Pinned' }, codicon('pinned')) : null, h('span.spacer'), h('span.hover-only', {}, agent.program === 'explyt' ? action('copy', 'Duplicate (fork the session)', () => send({ type: 'duplicate', address: agent.address })) : null, action(agent.pinned ? 'pinned' : 'pin', agent.pinned ? 'Unpin' : 'Pin to the top', () => send({ type: 'pin', address: agent.address, pinned: !agent.pinned })), agent.tab ? action('close', 'Close this tab', closeTab) : null), agent.since ? h('span.time.hover-hide', {}, duration(model.now - agent.since)) : null), h('div.line2', {}, h('span.meta', {}, [agent.where, agent.name !== title ? agent.name : null, agent.cwd && agent.cwd !== agent.where ? agent.cwd : null].filter(Boolean).join(' · ')), agent.address.includes('/') ? h('span.machine', {}, agent.address.split('/')[0]) : null, word && word !== 'idle' ? h(`span.unread.${word}`, { title: WORD_LABEL[word] }, word === 'working' ? codicon('loading', 'codicon-modifier-spin') : word === 'blocked' ? 'Needs you' : codicon('check')) : null)),
    );
    const children = agent.kids.length ? [h(`button.kids-bar${open ? '' : tone(agent.kids[0]?.word)}`, { onclick: (e) => { e.stopPropagation(); toggle(`kids:${agent.address}`); } }, codicon(open ? 'chevron-down' : 'chevron-right'), `${flatKids(agent).length} sub-agent${flatKids(agent).length === 1 ? '' : 's'}`), open ? h('div.kids-list', {}, agent.kids.flatMap(subRow)) : null] : [];
    return [h('div.agent-block', {}, head, children)];
  }

  function tabRow(space, tab) {
    const lead = tab.lead;
    const go = () => lead ? send({ type: 'open', address: lead.address }) : tab.file ? send({ type: 'openFile', file: tab.file, space: space.id }) : null;
    return h(`div.item compact-item${tab.active ? ' active' : ''}${tone(tab.word)}`, {
      role: 'button', tabindex: 0, title: [tab.name, lead?.cwd ?? tab.file, lead?.address].filter(Boolean).join('\n'), onclick: go,
      onkeydown: (e) => { if (e.key === 'Enter') go(); }, context: { webviewSection: 'tab', space: space.id, tab: tab.id, address: lead?.address, program: lead?.word ? lead.program : undefined },
    }, h('span.item-icon', {}, tab.file && !lead ? h('span.icon.file', {}, codicon('file')) : icon(lead?.icon, lead?.name ?? tab.name)), h('span.label', {}, h('span.name', {}, tab.name), tab.detail ? h('span.detail', {}, ` · ${tab.detail}`) : null), h('span.hover-only', {}, action('close', 'Close tab (ends its terminals)', () => send({ type: 'closeTab', tab: tab.id }))), h('span.hover-hide', {}, status(tab.word, true)));
  }

  function openLaunch(anchor, pick) {
    launch?.remove();
    const programs = [{ key: 'terminal', name: 'Terminal' }, ...model.startable];
    const last = programs.findIndex((program) => program.key === model.lastProgram);
    if (last > 0) programs.unshift(...programs.splice(last, 1));
    const choose = (key) => { launch?.remove(); launch = undefined; pick(key); };
    launch = h('div.launch', { role: 'menu', tabindex: -1, onkeydown: (e) => { if (e.key === 'Escape') launch?.remove(); const n = Number(e.key); if (n >= 1 && n <= programs.length) choose(programs[n - 1].key); } }, programs.map((program, index) => h('button.launch-item', { role: 'menuitem', onclick: (e) => { e.stopPropagation(); choose(program.key); } }, program.key === 'terminal' ? h('span.icon.file', {}, codicon('terminal')) : icon(program.icon, program.name), h('span.label', {}, program.name), index === 0 && model.lastProgram ? h('span.launch-hint', {}, 'last') : null, index < 9 ? h('kbd', {}, String(index + 1)) : null)));
    document.body.append(launch);
    const rect = anchor.getBoundingClientRect();
    const width = launch.offsetWidth || 200;
    const height = launch.offsetHeight || 200;
    launch.style.left = `${Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4))}px`;
    launch.style.top = `${rect.bottom + 4 + height > window.innerHeight ? Math.max(4, rect.top - height - 4) : rect.bottom + 4}px`;
    launch.focus();
  }

  function spaceHeader(space, count, word) {
    const id = `space:${space.id}`;
    const open = !folded.has(id);
    return h(`div.space-header${open ? '' : ' closed'}${space.current ? ' current' : ''}`, { role: 'button', title: space.folder, onclick: () => toggle(id), context: { webviewSection: 'space', space: space.id, git: !!space.git } },
      space.avatar ? h('img.space-avatar', { src: space.avatar, alt: '' }) : h('span.space-avatar.letter', {}, (space.name[0] ?? '?').toUpperCase()), h('span.label', {}, h('span.name', {}, space.name)), h('span.count', {}, String(count)), h('button.space-add', { title: 'New agent or terminal here', 'aria-label': 'New agent or terminal here', onclick: (e) => { e.stopPropagation(); openLaunch(e.currentTarget, (agent) => send({ type: 'newTab', space: space.id, agent })); } }, codicon('add')));
  }

  function renderAgents() {
    const agents = model.agents.filter((agent) => matches(agent.name, agent.where, agent.detail, agent.address));
    const bySpace = new Map(model.spaces.map((space) => [space.id, { space, agents: [], tabs: [] }]));
    for (const agent of agents) {
      const space = model.spaces.find((item) => item.id === agent.space || item.name === agent.where);
      const group = bySpace.get(space?.id ?? agent.where) ?? { space: { id: agent.where, name: agent.where }, agents: [], tabs: [] };
      group.agents.push(agent);
      if (space) bySpace.set(space.id, group);
      else bySpace.set(agent.where, group);
    }
    for (const space of model.spaces) {
      const group = bySpace.get(space.id) ?? { space, agents: [], tabs: [] };
      group.tabs = space.tabs.filter((tab) => !tab.lead || !tab.lead.word).filter((tab) => matches(space.name, tab.name, tab.detail, ...tab.panes.map((pane) => pane.name)));
      bySpace.set(space.id, group);
    }
    const groups = [...bySpace.values()].filter((group) => group.agents.length || group.tabs.length || matches(group.space.name));
    groups.sort((a, b) => Math.max(...b.agents.map((agent) => agent.since || 0), 0) - Math.max(...a.agents.map((agent) => agent.since || 0), 0));
    const out = [];
    for (const group of groups) {
      const items = [...group.agents].sort((a, b) => (b.pinned - a.pinned) || (b.since - a.since) || a.address.localeCompare(b.address));
      const count = items.length + group.tabs.length;
      out.push(spaceHeader(group.space, count, null));
      if (!folded.has(`space:${group.space.id}`)) {
        for (const agent of items) out.push(...agentRow(agent));
        for (const tab of group.tabs) out.push(tabRow(group.space, tab));
      }
    }
    const loose = model.unplaced.filter((tab) => matches(tab.name, tab.title, tab.cwd, tab.address));
    if (loose.length) {
      const space = { id: 'loose', name: 'Not in a space' };
      out.push(spaceHeader(space, loose.length, null));
      if (!folded.has('space:loose')) for (const tab of loose) out.push(tabRow(space, tab));
    }
    if (!model.agents.length && !model.spaces.length && !loose.length) out.push(h('div.empty', {}, h('p', {}, 'No agents yet.'), h('p.dim', {}, 'Agents show up here when they report their status.')));
    if (model.agents.length && !agents.length) out.push(h('div.empty.dim', {}, 'Nothing matches.'));
    out.push(h('button.new-space', { onclick: () => send({ type: 'newSpace' }) }, codicon('new-folder'), ' New space…'));
    return out;
  }

  function render() {
    if (!model || editing) return;
    const focused = document.activeElement === search;
    const top = root.scrollTop;
    root.replaceChildren();
    if (!model.connected) { root.append(h('div.empty', {}, h('p', {}, codicon('plug'), ' ', model.error ?? 'Connecting to herdr-core…'))); return; }
    search = /** @type {HTMLInputElement} */ (h('input.search', { type: 'search', placeholder: 'Filter agents', value: filter, oninput: (e) => { filter = e.target.value; save(); render(); }, onkeydown: (e) => { if (e.key === 'Escape') { filter = ''; save(); render(); } } }));
    const plus = h('button.bar-add', { title: 'New agent', onclick: (e) => openLaunch(e.currentTarget, (agent) => send({ type: 'newTab', agent })) }, codicon('add'));
    root.append(h('div.bar', {}, search, plus), h('div.list', {}, renderAgents()));
    root.scrollTop = top;
    if (focused) { search.focus(); search.setSelectionRange(filter.length, filter.length); }
  }

  document.addEventListener('mousedown', (event) => { if (launch && !launch.contains(event.target)) { launch.remove(); launch = undefined; } });
  window.addEventListener('blur', () => { launch?.remove(); launch = undefined; });
  window.addEventListener('message', (event) => { if (event.data?.type === 'model') { model = event.data.model; render(); } if (event.data?.type === 'focusSearch') search?.focus(); });
  setInterval(() => { if (model) { model.now = Date.now(); render(); } }, 30000);
  send({ type: 'ready' });
})();
