/* Application shell: navigation, project/environment switchers, command palette,
   notifications, theme, environment band. Boots the router. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, esc, fmt, on, debounce, toast } = QA.ui;
  const S = QA.state;
  const $ = (id) => document.getElementById(id);

  const WF_NAME = {
    connect: '1. Connect', create: '2. Create tests', run: '3. Run', report: '4. Report',
  };
  const NAV = [
    { label: 'Start here', items: [['/projects/new', 'New project', 'plus'], ['/projects', 'All projects', 'folder'], ['/workflow', 'How QA works', 'layers']] },
    { label: 'This project', items: [['/', 'Dashboard', 'dashboard'], ['/stories', 'Jira tickets', 'bookmark'], ['/testcases', 'Tests', 'list'], ['/execution', 'Run tests', 'play'], ['/defects', 'Defects', 'alert', 'defects'], ['/reports', 'Reports', 'chart']] },
    { label: 'Tools', items: [['/explorer', 'Try an API', 'code'], ['/automation', 'HTTP / Postman', 'zap'], ['/traceability', 'Traceability', 'tree'], ['/agent', 'Ask the assistant', 'sparkles'], ['/logs', 'Audit log', 'history']] },
  ];
  const counts = { defects: 0 };

  function renderNav() {
    const path = QA.router.path;
    const active = (href) => {
      if (href === '/') return path === '/' || path === '/dashboard';
      if (href === '/projects') return path === '/projects' || (path.startsWith('/projects/') && path !== '/projects/new');
      if (href === '/projects/new') return path === '/projects/new';
      return path === href || path.startsWith(`${href}/`) || (href === '/stories' && path.startsWith('/generate')) || (href === '/traceability' && path === '/regression');
    };
    const p = S.project;
    const wf = p && p.workflow;
    const wfHtml = wf ? h`<div class="nav-group"><div class="nav-label">Checklist for this project</div>${wf.steps.map((s) => {
      const href = `/workflow/${s.id}`;
      const on = path === href || (path === '/workflow' && s.id === wf.currentStep);
      const m = (QA.workflow && QA.workflow.mark) ? QA.workflow.mark(s.status, on || s.id === wf.currentStep) : ic('circle', 'icon-sm');
      return h`<a href="${href}" data-link class="wf-link ${on ? 'active' : ''}" ${on ? raw('aria-current="page"') : ''} title="${(s.help || s.label) + ' · ' + s.status.replace(/_/g, ' ')}">${m}<span class="truncate">${WF_NAME[s.id] || s.label}</span></a>`;
    })}</div>` : '';
    $('nav').innerHTML = String(h`<a class="nav-cta" href="/projects/new" data-link>${ic('plus')}<span>New project</span></a>${NAV.map((g) => h`<div class="nav-group"><div class="nav-label">${g.label}</div>${g.items.map(([href, label, icon, countKey]) => h`<a href="${href}" data-link class="${active(href) ? 'active' : ''} ${href === '/projects/new' ? 'nav-new' : ''}" ${active(href) ? raw('aria-current="page"') : ''} title="${label}">${ic(icon)}<span>${label}</span>${countKey && counts[countKey] ? h`<span class="count" title="Open defects">${counts[countKey]}</span>` : ''}</a>`)}</div>`)}${wfHtml}`);
  }

  function renderSidebarFoot() {
    const p = S.project;
    const m = S.meta || {};
    const sf = p && p.connection ? p.connection.salesforce : null;
    const jira = p && p.connection ? p.connection.jira : null;
    const pm = p && p.connection ? p.connection.postman : null;
    const commerce = p && p.connection ? p.connection.commerce : null;
    const short = (s) => ({ connected: 'Connected', configured: 'Ready', demo: 'Demo', off: 'Off', unavailable: 'Not connected' }[s && s.status] || (s && s.label) || '–');
    const dotCls = (s) => (s === 'connected' || s === 'configured' ? 'ok' : s === 'demo' ? 'demo' : s === 'off' ? 'off' : 'bad');
    $('sidebar-foot').innerHTML = String(h`${p ? h`<div class="conn-status">
      <div class="conn-line"><span class="conn-dot ${dotCls(sf && sf.status)}"></span><span>Salesforce: ${short(sf)}</span></div>
      <div class="conn-line"><span class="conn-dot ${dotCls(jira && jira.status)}"></span><span>Jira: ${short(jira)}</span></div>
      <div class="conn-line"><span class="conn-dot ${dotCls(pm && pm.status)}"></span><span>HTTP / Postman: ${short(pm)}</span></div>
      ${p.connection && p.connection.playwright && p.connection.playwright.status !== 'off' ? h`<div class="conn-line"><span class="conn-dot ${dotCls(p.connection.playwright.status)}"></span><span>Playwright: ${short(p.connection.playwright)}</span></div>` : ''}
      ${commerce && commerce.status !== 'off' ? h`<div class="conn-line"><span class="conn-dot ${dotCls(commerce.status)}"></span><span>Commerce Cloud: ${short(commerce)}</span></div>` : ''}
      <div class="faint conn-meta wrap">v${m.version || ''} · metadata ${p.connection ? p.connection.metadataLabel : ''}</div></div>` : ''}`);
  }

  function renderSwitchers() {
    const envs = [...new Set(S.projects.map((p) => p.environment))];
    const order = (S.meta && S.meta.environments) || envs;
    const envSel = $('env-switch');
    const cur = S.project;
    const envFilter = S.envFilter || '';
    envSel.innerHTML = String(h`<option value="">All environments</option>${order.filter((e) => envs.includes(e)).map((e) => h`<option value="${e}" ${e === envFilter ? 'selected' : ''}>${e}</option>`)}`);
    const list = S.projects;
    $('project-switch').innerHTML = String(h`${list.length ? list.map((p) => h`<option value="${p.id}" ${cur && p.id === cur.id ? 'selected' : ''}>${p.name} · ${p.environment}</option>`) : h`<option value="">No projects yet</option>`}<option value="__new__">+ New project…</option>`);
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
      <div class="notif-list">${list.length ? list.map((n) => h`<div class="notif"><div class="row wrap"><b>${n.title}</b><span class="spacer"></span><span class="when">${fmt.ago(n.at)}</span></div><div class="small muted wrap">${raw(String(n.message instanceof QA.ui.Safe ? n.message : esc(n.message)))}</div></div>`) : h`<div class="empty compact">${ic('bell')}<p>Run completions, defects and errors appear here.</p></div>`}</div>`);
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
    $('project-switch').addEventListener('change', (e) => {
      if (e.target.value === '__new__') { e.target.value = S.projectId || ''; QA.router.go('/projects/new'); return; }
      if (e.target.value) S.setProject(e.target.value);
    });
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
      const listPath = { '/stories/:key': '/stories', '/generate/:id': '/stories', '/execution/:runId': '/execution', '/testcases/:id': '/testcases', '/defects/:id': '/defects', '/workflow/:step': '/workflow', '/projects/new': '/projects/new' }[cur.pattern];
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
