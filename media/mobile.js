// herdr on the phone: the agents as a chat list, a chat as bubbles, a box to answer.
// The key comes in the link's #fragment, is kept in localStorage, and goes with every request.
(function () {
  const app = document.getElementById('app');
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('k');
  if (fromHash) { localStorage.setItem('herdr.k', fromHash); history.replaceState(null, '', '/'); }
  const key = localStorage.getItem('herdr.k') || '';

  const WORD = { blocked: 'Needs you', done: 'Done', working: 'Working', idle: '' };
  let list = { agents: [], icons: {}, now: Date.now(), connected: false };
  let chat = null; // { address, header, bubbles: Map, order: [], kind, screen }
  let listSource, chatSource;

  function h(tag, props, ...kids) {
    const [head, ...cls] = tag.split('.');
    const [name, id] = head.split('#');
    const last = cls.length ? cls[cls.length - 1].split('#') : [];
    if (last.length > 1) cls[cls.length - 1] = last[0];
    const el = document.createElement(name || 'div');
    if (cls.length) el.className = cls.join(' ');
    if (id || last[1]) el.id = id || last[1];
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const api = (p) => `${p}${p.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}`;
  async function post(p, body) {
    const r = await fetch(api(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text() || r.statusText);
  }

  function ago(ms) {
    if (!ms) return '';
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const hr = Math.floor(m / 60);
    return hr < 24 ? `${hr}h` : `${Math.floor(hr / 24)}d`;
  }
  const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

  /** The repo with the agent's icon in its corner; with mascots on, the mascot with the repo in its corner. */
  function avatar(a, size) {
    const box = h(`div.ava${size ? '.' + size : ''}`);
    const repo = () => (a.avatar ? h('img', { src: a.avatar, alt: '' }) : h('span.letter', {}, (a.where || '?')[0].toUpperCase()));
    if (a.hasMascot) {
      box.append(h('img', { src: `/mascots/${a.mascot}.webp`, alt: '' }), h('span.badge.repo', {}, repo()));
      return box;
    }
    box.append(repo());
    const icon = a.icon && list.icons[a.icon];
    if (icon) box.append(h('span.badge', {}, h('img', { src: icon, alt: '' })));
    return box;
  }

  // ------------------------------------------------------------ markdown, small and safe

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  }
  function markdown(src) {
    const out = [];
    const parts = src.split(/```[^\n]*\n?/);
    parts.forEach((part, i) => {
      if (i % 2) { out.push(`<pre>${esc(part.replace(/\n$/, ''))}</pre>`); return; }
      let listOpen = null;
      const close = () => { if (listOpen) { out.push(`</${listOpen}>`); listOpen = null; } };
      for (const line of part.split('\n')) {
        const li = /^\s*([-*•]|\d+\.)\s+(.*)$/.exec(line);
        const hd = /^#{1,4}\s+(.*)$/.exec(line);
        const row = /^\|(.+)\|\s*$/.exec(line);
        if (li) {
          const kind = /\d/.test(li[1]) ? 'ol' : 'ul';
          if (listOpen !== kind) { close(); out.push(`<${kind}>`); listOpen = kind; }
          out.push(`<li>${inline(li[2])}</li>`);
        } else if (row) {
          close();
          if (/^\|[\s:|-]+\|$/.test(line)) continue;
          out.push(`<div class="trow">${row[1].split('|').map((c) => `<span>${inline(c.trim())}</span>`).join('')}</div>`);
        } else {
          close();
          if (hd) out.push(`<p class="hd">${inline(hd[1])}</p>`);
          else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
        }
      }
      close();
    });
    return out.join('');
  }

  // ------------------------------------------------------------ list

  function renderList() {
    const rank = { blocked: 3, done: 2, working: 1 };
    const agents = [...list.agents].sort((a, b) => (b.pinned - a.pinned) || ((rank[b.word] || 0) - (rank[a.word] || 0)) || (b.since - a.since));
    const waiting = agents.filter((a) => a.word === 'blocked').length;
    app.replaceChildren(
      h('header.top', {},
        h('img.logo', { src: '/icon.png', alt: '' }),
        h('div.top-title', {}, h('b', {}, 'herdr'), h('span', {}, list.connected ? `${agents.length} agents${waiting ? ` · ${waiting} need you` : ''}` : 'offline'))),
      h('main.list', {},
        agents.length ? agents.map((a) => h(`button.chat-row.${a.word || 'idle'}`, { onclick: () => openChat(a.address) },
          avatar(a),
          h('div.lines', {},
            h('div.l1', {}, h('span.title', {}, a.title), h('span.time', {}, ago(a.since))),
            h('div.l2', {}, h('span.meta', {}, [a.where, a.name !== a.title ? a.name : ''].filter(Boolean).join(' · ')),
              a.kids ? h('span.kids', {}, `+${a.kids}`) : null,
              a.word && a.word !== 'idle' ? h(`span.pill.${a.word}`, {}, a.word === 'working' ? h('span.spin') : WORD[a.word]) : null)),
        )) : h('p.empty', {}, list.connected ? 'No agents.' : 'Not connected to herdr-core.')),
    );
  }

  function listen() {
    listSource?.close();
    listSource = new EventSource(api('/api/events'));
    listSource.onmessage = (e) => {
      list = JSON.parse(e.data);
      if (!chat) renderList();
      else updateHeader();
    };
    listSource.onerror = () => { if (!key) app.replaceChildren(h('p.empty', {}, 'Scan the QR code in VS Code (herdr → Open on Phone).')); };
  }

  // ------------------------------------------------------------ chat

  function openChat(address) {
    history.pushState({ chat: address }, '', `#${encodeURIComponent(address)}`);
    showChat(address);
  }

  function showChat(address) {
    chatSource?.close();
    chat = { address, header: null, bubbles: new Map(), order: [], kind: 'bubbles', screen: '' };
    const a = list.agents.find((x) => x.address === address) || { title: address, where: '', name: '' };
    const input = h('textarea', { rows: 1, placeholder: 'Message', enterkeyhint: 'send' });
    const sendBtn = h('button.send', { 'aria-label': 'Send', disabled: true, onclick: () => submit() }, h('span.arrow'));
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
      sendBtn.disabled = !input.value.trim();
    });
    async function submit() {
      const text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      try {
        await post(`/api/chat/${encodeURIComponent(address)}/send`, { text });
        input.value = '';
        input.dispatchEvent(new Event('input'));
        // Shown at once; the agent's session confirms it in a moment.
        addBubbles([{ id: `local-${Date.now()}`, role: 'user', text, tools: [], ms: Date.now(), pending: true }]);
      } catch (e) {
        toast(String(e.message || e));
        sendBtn.disabled = false;
      }
    }
    const keys = h('div.keys', {},
      [['esc', 'Esc'], ['enter', '⏎'], ['up', '↑'], ['down', '↓'], ['1', '1'], ['2', '2'], ['3', '3'], ['ctrl+c', '^C']]
        .map(([k, label]) => h('button.key', { onclick: () => post(`/api/chat/${encodeURIComponent(address)}/keys`, { keys: [k] }).catch((e) => toast(e.message)) }, label)));
    app.replaceChildren(
      h('header.top.chat-top', {},
        h('button.back', { 'aria-label': 'Back', onclick: () => history.back() }, h('span.chev')),
        h('div#chat-ava', {}, avatar(a, 'small')),
        h('div.top-title#chat-title', {}, h('b', {}, a.title), h('span', {}, a.where))),
      h('main.chat#chat', {}, h('div.loading', {}, 'Loading…')),
      h('div.blocked-bar#blocked', { hidden: true }, h('span', {}, 'Waiting for your answer'), keys),
      h('footer.composer', {}, input, sendBtn),
    );
    updateHeader();
    chatSource = new EventSource(api(`/api/chat/${encodeURIComponent(address)}/events`));
    chatSource.onmessage = (e) => {
      const p = JSON.parse(e.data);
      chat.kind = p.kind;
      if (p.kind === 'screen') { renderScreen(p.screen); return; }
      addBubbles(p.bubbles);
    };
  }

  function updateHeader() {
    if (!chat) return;
    const a = list.agents.find((x) => x.address === chat.address);
    if (!a) return;
    const title = document.getElementById('chat-title');
    if (title) title.replaceChildren(h('b', {}, a.title), h('span', {}, [a.where, a.word === 'working' ? 'working…' : WORD[a.word]].filter(Boolean).join(' · ')));
    const bar = document.getElementById('blocked');
    if (bar) bar.hidden = a.word !== 'blocked';
    document.getElementById('chat')?.classList.toggle('working', a.word === 'working');
  }

  function addBubbles(incoming) {
    const box = document.getElementById('chat');
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.querySelector('.loading')?.remove();
    for (const b of incoming) {
      if (!b.pending && b.role === 'user') {
        // The real message replaces the one shown while sending.
        const local = [...box.querySelectorAll('.bubble.pending')].find((el) => el.dataset.text === b.text.trim());
        local?.remove();
      }
      const old = chat.bubbles.get(b.id);
      const el = bubble(b);
      if (old) old.replaceWith(el);
      else box.append(el);
      chat.bubbles.set(b.id, el);
    }
    if (atBottom || incoming.some((b) => b.pending)) box.scrollTop = box.scrollHeight;
  }

  function bubble(b) {
    const tools = b.tools && b.tools.length
      ? h('details.tools', {}, h('summary', {}, `${b.tools.length} tool${b.tools.length === 1 ? '' : 's'}`),
        b.tools.map((t) => h('div.tool', {}, h('b', {}, t.name), t.summary ? ` ${t.summary}` : '')))
      : null;
    const body = b.role === 'user' ? h('div.text.plain', {}, b.text) : h('div.text', { html: markdown(b.text || '') });
    const el = h(`div.bubble.${b.role}${b.pending ? '.pending' : ''}`, {}, b.text ? body : null, tools, h('span.stamp', {}, b.pending ? 'sending…' : clock(b.ms)));
    if (b.pending) el.dataset.text = b.text.trim();
    return el;
  }

  function renderScreen(text) {
    const box = document.getElementById('chat');
    if (!box) return;
    box.replaceChildren(h('pre.screen', {}, text));
    box.scrollTop = box.scrollHeight;
  }

  function toast(msg) {
    const t = h('div.toast', {}, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  function route() {
    const address = decodeURIComponent(location.hash.slice(1));
    if (address && !address.startsWith('k=')) showChat(address);
    else { chatSource?.close(); chat = null; renderList(); }
  }

  window.addEventListener('popstate', route);
  if (!key) {
    app.replaceChildren(h('p.empty', {}, 'Scan the QR code in VS Code (herdr → Open on Phone).'));
    return;
  }
  listen();
  route();
})();
