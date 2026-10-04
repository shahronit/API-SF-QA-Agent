/* Application shell: navigation, project/environment switchers, command palette,
   notifications, theme, environment band. Boots the router. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, esc, fmt, on, debounce, toast } = QA.ui;
  const S = QA.state;
  const $ = (id) => document.getElementById(id);

  const NAV = [
    { label: 'Core Workflow', items: [['/', 'Dashboard', 'dashboard'], ['/stories', 'Stories & Tests', 'bookmark'], ['/execution', 'Test Runs', 'play'], ['/defects', 'Defects', 'alert', 'defects']] },
    { label: 'Testing', items: [['/testcases', 'Test Cases', 'list'], ['/explorer', 'API Explorer', 'code'], ['/contracts', 'API Contracts', 'file']] },
    { label: 'Resources', items: [['/testdata', 'Test Data', 'database'], ['/automation', 'CI/CD', 'zap'], ['/projects', 'Projects', 'settings']] },
    { label: 'Insights', items: [['/reports', 'Reports', 'chart'], ['/traceability', 'Traceability', 'tree'], ['/agent', 'AI Assistant', 'sparkles'], ['/logs', 'Audit Log', 'history']] },
  ];
  const counts = { defects: 0 };

  function renderNav() {
    const path = QA.router.path;
    const active = (href) => (href === '/' ? path === '/' || path === '/dashboard' : path === href || path.startsWith(`${href}/`) || (href === '/stories' && path.startsWith('/generate')) || (href === '/traceability' && path === '/regression'));
    $('nav').innerHTML = String(h`${NAV.map((g) => h`<div class="nav-group"><div class="nav-label">${g.label}</div>${g.items.map(([href, label, icon, countKey]) => h`<a href="${href}" data-link class="${active(href) ? 'active' : ''}" ${active(href) ? raw('aria-current="page"') : ''}>${ic(icon)}<span>${label}</span>${countKey && counts[countKey] ? h`<span class="count" title="Open defects">${counts[countKey]}</span>` : ''}</a>`)}</div>`)}`);
  }

  function renderSidebarFoot() {
    const p = S.project;
    const m = S.meta || {};
    const sf = p && p.connection ? p.connection.salesforce : null;
    const jira = p && p.connection ? p.connection.jira : null;
    const dot = (s) => (s === 'connected' || s === 'configured' ? 'var(--success)' : s === 'demo' ? 'var(--warning)' : 'var(--error)');
    $('sidebar-foot').innerHTML = String(h`${p ? h`<div class="stack" style="gap:4px">
      <div class="row" style="gap:6px"><span style="width:7px;height:7px;border-radius:50%;background:${dot(sf && sf.status)}"></span>Salesforce: ${sf ? sf.label : '–'}</div>
      <div class="row" style="gap:6px"><span style="width:7px;height:7px;border-radius:50%;background:${dot(jira && jira.status)}"></span>Jira: ${jira ? jira.label : '–'}</div>
      <div class="faint" style="margin-top:4px">v${m.version || ''} · metadata ${p.connection ? p.connection.metadataLabel : ''}</div></div>` : ''}`);
  }

  function renderSwitchers() {
    const envs = [...new Set(S.projects.map((p) => p.environment))];
    const order = (S.meta && S.meta.environments) || envs;
    const envSel = $('env-switch');
    const cur = S.project;
    const envFilter = S.envFilter || '';
    envSel.innerHTML = String(h`<option value="">All environments</option>${order.filter((e) => envs.includes(e)).map((e) => h`<option value="${e}" ${e === envFilter ? 'selected' : ''}>${e}</option>`)}`);
    const list = S.projects.filter((p) => !envFilter || p.environment === envFilter);
    $('project-switch').innerHTML = String(list.length ? h`${list.map((p) => h`<option value="${p.id}" ${cur && p.id === cur.id ? 'selected' : ''}>${p.name} · ${p.environment}</option>`)}` : h`<option value="">No projects</option>`);
  }

  function renderEnvBand() {
    const p = S.project;
    const band = $('env-band');
    if (!p) { band.innerHTML = ''; return; }
    const sf = p.connection && p.connection.salesforce;
    if (p.environment === 'Production') {
      band.innerHTML = String(h`<div class="env-band" role="status">${ic('shield')}<span>Production · ${p.sfOrg || p.name} — read-only mode. Any data change requires explicit confirmation; DELETE requires a second confirmation.</span></div>`);
    } else if (sf && sf.status === 'unavailable') {
      band.innerHTML = String(h`<div class="env-band info" role="status">${ic('alert')}<span>Salesforce MCP is unavailable. API test design and automation generation are available, but live Salesforce validation is disabled.</span></div>`);
    } else band.innerHTML = '';
  }

  function renderChrome() {
    renderSwitchers();
    renderEnvBand();
    renderSidebarFoot();
    renderNav();
    const u = (S.meta && S.meta.user) || 'user';
    $('avatar').textContent = u.split(/[.\s_-]/).map((x) => x[0] || '').join('').slice(0, 2).toUpperCase();
    $('avatar').title = `Signed in as ${u}`;
    $('theme-btn').innerHTML = ic(S.theme === 'dark' ? 'sun' : 'moon');
    $('theme-btn').setAttribute('aria-label', S.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }

  async function refreshCounts() {
    const p = S.project;
    if (!p || QA.api.snapshot) return;
    try {
      const d = await QA.api.get(`/api/defects${QA.api.qs({ projectId: p.id, status: 'Open,In Progress,Reopened', pageSize: 1 })}`);
      counts.defects = d.total || 0;
      renderNav();
    } catch { /* non-critical */ }
  }

  // ── Notifications ──
  function renderNotifs() {
    const list = S.notifications;
    const unread = list.filter((n) => !n.read).length;
    $('notif-btn').innerHTML = ic('bell') + (unread ? '<span class="dot"></span>' : '');
    $('notif-btn').setAttribute('aria-label', unread ? `Notifications (${unread} unread)` : 'Notifications');
    $('notif-pop').innerHTML = String(h`<div class="popover-head"><span>Notifications</span>${list.length ? h`<button class="btn xs ghost" data-clear>Clear</button>` : ''}</div>
      <div style="max-height:380px;overflow-y:auto">${list.length ? list.map((n) => h`<div class="notif"><div class="row" style="gap:6px"><b>${n.title}</b><span class="spacer"></span><span class="when">${fmt.ago(n.at)}</span></div><div class="small muted">${raw(String(n.message instanceof QA.ui.Safe ? n.message : esc(n.message)))}</div></div>`) : h`<div class="empty" style="padding:28px 16px">${ic('bell')}<p>Run completions, defects and errors appear here.</p></div>`}</div>`);
  }

  // ── Command palette (⌘K) ──
  const TYPE_ICON = { story: 'jira', testcase: 'list', run: 'play', endpoint: 'code', defect: 'bug', request: 'send', sobject: 'database', page: 'chevronRight' };
  function openPalette() {
    if (document.querySelector('.palette')) return;
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.style.alignItems = 'flex-start';
    scrim.style.paddingTop = '12vh';
    scrim.innerHTML = String(h`<div class="palette" role="dialog" aria-modal="true" aria-label="Search"><input placeholder="Search stories, test cases, runs, endpoints, defects, objects…" aria-label="Search" autocomplete="off"><div class="palette-results" role="listbox"></div><div class="palette-hint"><span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span><span class="spacer"></span><span>Type a command like “run P0 tests” in the agent console</span></div></div>`);
    $('overlay-root').appendChild(scrim);
    const input = scrim.querySelector('input');
    const results = scrim.querySelector('.palette-results');
    let items = [];
    let idx = 0;
    const close = () => scrim.remove();
    const pages = NAV.flatMap((g) => g.items.map(([href, label, icon]) => ({ type: 'page', title: label, href, icon })));
    const draw = (groups) => {
      items = groups.flatMap((g) => g.items);
      idx = Math.min(idx, Math.max(0, items.length - 1));
      let n = 0;
      results.innerHTML = String(items.length ? h`${groups.filter((g) => g.items.length).map((g) => h`<div class="palette-group">${g.label}</div>${g.items.map((it) => { const i = n++; return h`<div class="palette-item ${i === idx ? 'on' : ''}" role="option" aria-selected="${i === idx}" data-i="${i}">${ic(it.icon || TYPE_ICON[it.type] || 'chevronRight')}<span class="truncate">${it.id && it.type !== 'page' ? h`<b class="mono small">${it.id}</b> ` : ''}${it.title}</span><span class="meta">${it.meta || ''}</span></div>`; })}`)}` : h`<div class="empty" style="padding:28px">${ic('search')}<p>No matches. Search covers stories, tests, runs, endpoints, defects, saved requests and Salesforce objects in the current project.</p></div>`);
    };
    const hrefFor = (it) => {
      if (it.href) return it.href;
      switch (it.type) {
        case 'story': return `/stories/${it.id}`;
        case 'testcase': return `/testcases?id=${it.id}`;
        case 'run': return `/execution/${it.id}`;
        case 'defect': return `/defects?q=${encodeURIComponent(it.id)}`;
        case 'endpoint': return `/testcases?q=${encodeURIComponent(it.title)}`;
        case 'request': return `/explorer?request=${encodeURIComponent(it.id)}`;
        case 'sobject': return `/explorer?object=${encodeURIComponent(it.id)}`;
        default: return '/';
      }
    };
    const choose = (it) => { if (!it) return; close(); QA.router.go(hrefFor(it)); };
    const search = debounce(async () => {
      const q = input.value.trim();
      const pageMatches = pages.filter((p) => !q || p.title.toLowerCase().includes(q.toLowerCase()));
      if (q.length < 2) { draw([{ label: 'Go to', items: pageMatches }]); return; }
      try {
        const r = await QA.api.get(`/api/search${QA.api.qs({ q, projectId: S.projectId })}`);
        draw([...r.groups, { label: 'Go to', items: pageMatches }]);
      } catch (e) { results.innerHTML = String(QA.ui.errorBox(e, { compact: true })); }
    }, 180);
    input.addEventListener('input', () => { idx = 0; search(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); e.preventDefault(); }
      else if (e.key === 'Enter') { choose(items[idx]); return; }
      else if (e.key === 'Escape') { close(); return; }
      else return;
      results.querySelectorAll('.palette-item').forEach((el) => { const on2 = Number(el.dataset.i) === idx; el.classList.toggle('on', on2); el.setAttribute('aria-selected', on2); if (on2) el.scrollIntoView({ block: 'nearest' }); });
    });
    results.addEventListener('click', (e) => { const el = e.target.closest('[data-i]'); if (el) choose(items[Number(el.dataset.i)]); });
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    draw([{ label: 'Go to', items: pages }]);
    setTimeout(() => input.focus(), 10);
  }

  function bindChrome() {
    $('menu-btn').innerHTML = ic('menu');
    $('search-ico').innerHTML = ic('search');
    $('menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
    $('nav').addEventListener('click', () => $('sidebar').classList.remove('open'));
    $('search-btn').addEventListener('click', openPalette);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.querySelector('.scrim')) { e.preventDefault(); openPalette(); }
    });
    $('theme-btn').addEventListener('click', () => { S.setTheme(S.theme === 'dark' ? 'light' : 'dark'); renderChrome(); });
    $('notif-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('notif-pop');
      pop.classList.toggle('hidden');
      if (!pop.classList.contains('hidden')) { S.notifications.forEach((n) => { n.read = true; }); renderNotifs(); }
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#notif-pop') && !e.target.closest('#notif-btn')) $('notif-pop').classList.add('hidden'); });
    on($('notif-pop'), 'click', '[data-clear]', () => { S.notifications = []; renderNotifs(); });
    $('project-switch').addEventListener('change', (e) => { if (e.target.value) S.setProject(e.target.value); });
    $('env-switch').addEventListener('change', (e) => {
      S.envFilter = e.target.value;
      const first = S.projects.find((p) => !S.envFilter || p.environment === S.envFilter);
      renderSwitchers();
      if (first && (!S.project || (S.envFilter && S.project.environment !== S.envFilter))) S.setProject(first.id);
    });
    S.on('project', () => {
      renderChrome();
      refreshCounts();
      // Project-scoped pages re-render; detail routes return to their list.
      const cur = QA.router.current;
      if (!cur) return;
      const listPath = { '/stories/:key': '/stories', '/generate/:id': '/stories', '/execution/:runId': '/execution', '/testcases/:id': '/testcases', '/defects/:id': '/defects' }[cur.pattern];
      if (listPath) QA.router.go(listPath); else QA.router.render();
    });
    S.on('projects', renderChrome);
    S.on('notifications', renderNotifs);
    S.on('route', () => { renderNav(); $('sidebar').classList.remove('open'); });
    S.on('defects-changed', refreshCounts);
  }

  async function boot() {
    bindChrome();
    renderNotifs();
    $('view').innerHTML = String(QA.ui.loading(10));
    try {
      await S.load();
    } catch (e) {
      $('view').innerHTML = String(h`<div style="padding:24px">${QA.ui.errorBox(e)}</div>`);
      return;
    }
    renderChrome();
    refreshCounts();
    if (QA.api.snapshot) toast('This is a read-only snapshot. Run `npm start` for the live platform.', 'info', 'Snapshot');
    QA.router.render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
