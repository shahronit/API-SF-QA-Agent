/* Dashboard: KPI strip, latest-run ribbon, trends, defects and recent executions. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, badge, on, errorBox, loading, empty } = QA.ui;
  const C = QA.components;

  const RANGES = [['7', 'Last 7 days'], ['14', 'Last 14 days'], ['30', 'Last 30 days'], ['', 'All time']];
  const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

  QA.pages.dashboard = {
    async render(view, ctx) {
      QA.router.setCrumbs([{ label: 'Dashboard' }]);
      const S = QA.state;
      const f = {
        scope: ctx.query.scope || 'project', range: ctx.query.range ?? '14',
        environment: ctx.query.environment || '', apiType: ctx.query.apiType || '', testType: ctx.query.testType || '', priority: ctx.query.priority || '', sprint: ctx.query.sprint || '',
        sfOrg: ctx.query.sfOrg || '', jiraProject: ctx.query.jiraProject || '', status: ctx.query.status || '',
      };
      if (!S.project && f.scope === 'project') f.scope = 'all';

      view.innerHTML = String(h`${C.pageHead('Dashboard', f.scope === 'project' && S.project ? `Health of ${S.project.name} (${S.project.environment}) — pass rate, failures and recent runs.` : 'Health across every project. Switch to a project in the top bar to focus.',
        h`<a class="btn" href="/projects/new" data-link>${ic('plus')} New project</a><button class="btn" data-act="refresh">${ic('refresh')} Refresh</button>${S.project ? h`<button class="btn primary" data-act="run">${ic('play')} Run tests</button>` : ''}`)}
        ${C.pageIntro({ what: 'A snapshot of quality for the project in the top bar. KPIs, the latest run and open defects live here.', next: S.project ? 'If this is a new workspace, open How QA works in the sidebar. To run tests already approved, click Run tests.' : 'Create a project first — that unlocks tickets, tests and runs.' })}
        <div class="card" style="margin-bottom:16px"><div class="toolbar" data-filters></div></div>
        <div data-body>${loading(10)}</div>`);

      const meta = S.meta;
      const drawFilters = (opts) => {
        const sel = (name, label, options) => h`<label class="sr-only" for="f-${name}">${label}</label><select class="select" id="f-${name}" data-f="${name}"><option value="">${label}</option>${options.map((o) => { const v = Array.isArray(o) ? o[0] : o; const l = Array.isArray(o) ? o[1] : o; return h`<option value="${v}" ${String(f[name]) === String(v) ? 'selected' : ''}>${l}</option>`; })}</select>`;
        view.querySelector('[data-filters]').innerHTML = String(h`<div class="btn-group" role="group" aria-label="Scope">
            <button class="btn sm ${f.scope === 'project' ? 'on' : ''}" data-scope="project" ${S.project ? '' : 'disabled'}>This project</button>
            <button class="btn sm ${f.scope === 'all' ? 'on' : ''}" data-scope="all">All projects</button></div>
          ${f.scope === 'all' ? sel('environment', 'All environments', meta.environments) : ''}
          ${sel('apiType', 'All API types', meta.apiTypes)}${sel('testType', 'All test types', meta.testTypes)}${sel('priority', 'All priorities', meta.priorities)}
          ${sel('status', 'All statuses', ['passed', 'failed', 'blocked', 'skipped'])}
          ${opts && opts.orgs && opts.orgs.length ? sel('sfOrg', 'All Salesforce orgs', opts.orgs) : ''}
          ${opts && opts.jiraProjects && opts.jiraProjects.length ? sel('jiraProject', 'All Jira projects', opts.jiraProjects) : ''}
          ${opts && opts.sprints.length ? sel('sprint', 'All sprints', opts.sprints) : ''}
          <span class="spacer"></span>
          <select class="select" data-f="range" aria-label="Date range">${RANGES.map(([v, l]) => h`<option value="${v}" ${f.range === v ? 'selected' : ''}>${l}</option>`)}</select>`);
      };
      drawFilters(null);

      let alive = true;
      async function load() {
        const body = view.querySelector('[data-body]');
        body.style.opacity = '.6';
        const q = { projectId: f.scope === 'project' && S.project ? S.project.id : '', environment: f.scope === 'all' ? f.environment : '', apiType: f.apiType, testType: f.testType, priority: f.priority, sprint: f.sprint, sfOrg: f.sfOrg, jiraProjectKey: f.jiraProject, status: f.status, from: f.range ? isoDaysAgo(Number(f.range)) : '' };
        try {
          const d = await QA.api.get(`/api/dashboard${QA.api.qs(q)}`);
          if (!alive) return;
          drawFilters(d.filterOptions);
          body.innerHTML = String(renderBody(d, f));
          mountCharts(body, d);
        } catch (e) { body.innerHTML = String(errorBox(e)); }
        body.style.opacity = '';
      }

      on(view, 'click', '[data-scope]', (e, el) => { f.scope = el.dataset.scope; QA.router.setQuery({ scope: f.scope === 'project' ? '' : f.scope }); QA.router.render(); });
      on(view, 'change', '[data-f]', (e, el) => { f[el.dataset.f] = el.value; QA.router.setQuery({ [el.dataset.f]: el.value === '' && el.dataset.f === 'range' ? '' : el.value || '' }); load(); });
      on(view, 'click', '[data-act=refresh]', () => { QA.api.clearCache(); load(); });
      on(view, 'click', '[data-act=run]', () => C.runDialog());
      load();
      return () => { alive = false; };
    },
  };

  function kpi(label, value, { unit, foot, tone, href, title } = {}) {
    return h`<div class="kpi ${tone || ''}" ${title ? raw(`title="${QA.ui.esc(title)}"`) : ''}><div class="kpi-label">${label}</div><div class="kpi-value">${value}${unit ? h`<span class="unit">${unit}</span>` : ''}</div>${foot ? h`<div class="kpi-foot">${href ? h`<a href="${href}" data-link>${foot}</a>` : foot}</div>` : ''}</div>`;
  }

  function renderBody(d, f) {
    const k = d.kpis;
    const run = d.recentRuns[0];
    const tone = (v, good, warn) => (v === null ? '' : v >= good ? 'ok' : v >= warn ? 'warn' : 'bad');
    if (!k.results && !d.recentRuns.length) {
      return h`<div class="card">${empty({ icon: 'play', title: 'Nothing has run yet', text: 'Create a project (or pick one), pull Jira tickets, generate tests, then run them. How QA works walks through each step.',
        action: h`<div class="workflow-guide"><a class="btn primary" href="/projects/new" data-link>${ic('plus')} New project</a><a class="btn" href="/workflow" data-link>${ic('layers')} How QA works</a><a class="btn" href="/stories" data-link>${ic('bookmark')} Jira tickets</a></div>` })}</div>`;
    }
    return h`
      <div class="kpis" style="--cols:8">
        ${kpi('Projects', fmt.num(k.totalProjects), { foot: `${fmt.num(k.activeProjects)} active`, href: '/projects' })}
        ${kpi('API tests', fmt.num(k.apiTests), { href: '/testcases' })}
        ${kpi('Test runs', fmt.num(k.testRuns), { href: '/execution' })}
        ${kpi('Pass rate', k.passRate === null ? '–' : fmt.num(k.passRate), { unit: k.passRate === null ? '' : '%', tone: tone(k.passRate, 95, 85), foot: `${fmt.num(k.results)} results` })}
        ${kpi('Failed tests', fmt.num(k.failed || 0), { tone: k.failed ? 'bad' : '', href: '/execution' })}
        ${kpi('Open defects', fmt.num(k.openDefects), { tone: k.criticalDefects ? 'bad' : '', foot: k.criticalDefects ? `${k.criticalDefects} critical` : 'None critical', href: '/defects' })}
        ${kpi('Critical defects', fmt.num(k.criticalDefects), { tone: k.criticalDefects ? 'bad' : '', href: '/defects' })}
        ${kpi('API health', k.apiHealth === null ? '–' : fmt.num(k.apiHealth), { unit: k.apiHealth === null ? '' : '%', tone: tone(k.apiHealth, 95, 80), foot: `${k.healthyEndpoints} of ${k.endpoints} endpoints healthy`, title: 'Share of endpoints whose latest result passed' })}
      </div>
      <div class="stat-inline mt"><span><b>${fmt.num(k.totalProjects)}</b> projects (${fmt.num(k.activeProjects)} active)</span><span><b>${fmt.num(k.apiTests)}</b> API tests</span><span><b>${fmt.num(k.testRuns)}</b> test runs</span></div>

      ${run ? h`<div class="card mt">
        <div class="card-head"><h2>Latest execution <span class="sub">${run.projectName} · ${run.environment} · ${fmt.ago(run.startedAt)} · ${run.trigger || 'manual'} by ${run.user}</span></h2>
          <div class="row">${badge(run.status)}<a class="btn sm" href="/execution/${run.id}" data-link>Open ${run.id}</a></div></div>
        <div class="ribbon-wrap">${raw(String(QA.charts.ribbon(d.ribbon.cells, { large: true, linkBase: null })).replace(/data-index="(\d+)"/g, `data-index="$1" data-href="/execution/${run.id}"`))}
          <div class="ribbon-legend"><span><i style="background:var(--success)"></i>${run.passed} passed</span><span><i style="background:var(--error)"></i>${run.failed} failed</span><span><i style="background:var(--warning)"></i>${run.blocked} blocked</span><span><i style="background:var(--skipped)"></i>${run.skipped} skipped</span><span class="spacer"></span><span>${run.total} tests in execution order · avg ${fmt.ms(run.avgResponseMs)}</span></div>
        </div></div>` : ''}

      <div class="grid g-21 mt">
        <div class="card"><div class="card-head"><h2>Execution trend <span class="sub">results per day</span></h2><div class="legend"><span><i style="background:var(--success)"></i>Passed</span><span><i style="background:var(--error)"></i>Failed</span><span><i style="background:var(--warning)"></i>Blocked</span></div></div><div class="card-body"><div data-chart="trend"></div></div></div>
        <div class="card"><div class="card-head"><h2>Open defects by severity</h2><a class="small" href="/defects" data-link>View all</a></div><div class="card-body row" style="justify-content:center;gap:24px"><div data-chart="sev"></div><div class="legend" style="flex-direction:column;align-items:flex-start">${['Critical', 'High', 'Medium', 'Low'].map((s) => h`<span><i style="background:${SEV_COLOR[s]}"></i>${s}: ${(d.defectsBySeverity.find((x) => x.severity === s) || { n: 0 }).n}</span>`)}</div></div></div>
      </div>

      <div class="grid g-3 mt">
        <div class="card"><div class="card-head"><h2>Pass rate</h2><span class="small muted">daily</span></div><div class="card-body"><div data-chart="rate"></div></div></div>
        <div class="card"><div class="card-head"><h2>Response time</h2><span class="small muted">avg and max per day</span></div><div class="card-body"><div data-chart="latency"></div></div></div>
        <div class="card"><div class="card-head"><h2>Results by test type</h2></div><div class="card-body"><div data-chart="types"></div></div></div>
      </div>

      <div class="grid g-21 mt">
        <div class="card"><div class="card-head"><h2>Recent executions</h2><a class="small" href="/execution" data-link>All executions</a></div>
          ${QA.ui.table({ columns: [
            { key: 'id', label: 'Execution', render: (r) => h`<a href="/execution/${r.id}" data-link class="mono small">${r.id}</a><div class="cell-sub">${r.projectName}</div>` },
            { key: 'environment', label: 'Env' },
            { key: 'status', label: 'Status', render: (r) => badge(r.status) },
            { key: 'result', label: 'Result', render: (r) => h`<div class="progress" style="width:110px" title="${r.passed} passed, ${r.failed} failed, ${r.blocked} blocked"><span style="width:${(r.passed / Math.max(1, r.total)) * 100}%;background:var(--success)"></span><span style="width:${(r.failed / Math.max(1, r.total)) * 100}%;background:var(--error)"></span><span style="width:${(r.blocked / Math.max(1, r.total)) * 100}%;background:var(--warning)"></span></div><div class="cell-sub num">${r.passed}/${r.total} passed</div>` },
            { key: 'startedAt', label: 'Started', render: (r) => h`<span title="${fmt.date(r.startedAt)}">${fmt.ago(r.startedAt)}</span>` },
          ], rows: d.recentRuns })}
        </div>
        <div class="card"><div class="card-head"><h2>Tests by project</h2></div><div class="card-body"><div data-chart="projects"></div></div></div>
      </div>`;
  }

  const SEV_COLOR = { Critical: 'var(--error)', High: '#F97316', Medium: 'var(--warning)', Low: 'var(--text-3)' };

  function mountCharts(root, d) {
    const labels = d.trend.map((t) => QA.ui.fmt.day(t.day));
    const ch = (n) => root.querySelector(`[data-chart=${n}]`);
    QA.charts.mount(ch('trend'), 'bars', { labels, height: 230, aria: 'Daily results: passed, failed, blocked', series: [
      { name: 'Passed', color: '--success', values: d.trend.map((t) => t.passed) },
      { name: 'Failed', color: '--error', values: d.trend.map((t) => t.failed) },
      { name: 'Blocked', color: '--warning', values: d.trend.map((t) => t.blocked) },
    ] });
    QA.charts.mount(ch('rate'), 'line', { labels, height: 170, max: 100, yFmt: (v) => `${Math.round(v)}%`, aria: 'Daily pass rate', series: [
      { name: 'Pass rate', color: '--primary', area: true, values: d.trend.map((t) => (t.passed + t.failed ? Math.round((t.passed / (t.passed + t.failed)) * 1000) / 10 : null)) },
    ] });
    QA.charts.mount(ch('latency'), 'line', { labels, height: 170, yFmt: (v) => `${Math.round(v)}ms`, aria: 'Daily response time', series: [
      { name: 'Max', color: '--warning', dash: true, values: d.trend.map((t) => t.maxMs) },
      { name: 'Average', color: '--primary', values: d.trend.map((t) => t.avgMs) },
    ] });
    QA.charts.mount(ch('types'), 'hbars', { items: d.byType.map((t) => ({ label: t.type, value: t.n, display: `${QA.ui.fmt.num(t.n)}${t.failed ? ` · ${t.failed} failed` : ''}`, parts: [{ value: t.n - t.failed, color: '--primary' }, { value: t.failed, color: '--error' }] })) });
    const sev = ['Critical', 'High', 'Medium', 'Low'].map((s) => ({ label: s, value: (d.defectsBySeverity.find((x) => x.severity === s) || { n: 0 }).n, color: SEV_COLOR[s].replace(/var\((.+)\)/, '$1') }));
    QA.charts.mount(ch('sev'), 'donut', { segments: sev, size: 140, sub: 'open', aria: 'Open defects by severity' });
    QA.charts.mount(ch('projects'), 'hbars', { items: d.testsByProject.map((p) => ({ label: p.name, value: p.totalTests, display: `${p.totalTests} tests · ${p.passed + p.failed ? Math.round((p.passed / (p.passed + p.failed)) * 100) : 0}% pass`, parts: [{ value: p.totalTests, color: '--primary' }] })) });
  }
})();
