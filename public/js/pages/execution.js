/* Test execution: run history, live run view (ribbon + stream), results, analysis. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, badge, pri, method, on, errorBox, loading, empty, toast, toastError, withBusy, esc } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.execution = {
    render(view, ctx) {
      if (!QA.state.project) { view.innerHTML = String(C.projectRequired()); return null; }
      return ctx.params.runId ? renderRun(view, ctx) : renderList(view, ctx);
    },
  };

  // ── Run history ──
  function renderList(view, ctx) {
    const p = QA.state.project;
    QA.router.setCrumbs([{ label: 'Test Runs' }]);
    view.innerHTML = String(h`${C.pageHead('Test Runs', `Watch your test executions. Click a run to see detailed results and defects for ${p.name}.`,
      h`<button class="btn" data-act="failed">${ic('zap')} Re-run failed</button><button class="btn primary" data-act="run">${ic('play')} Start new run</button>`)}
      ${C.connectionNotice(p)}<div data-list></div>`);
    const list = C.listController(view.querySelector('[data-list]'), {
      sort: 'startedAt', dir: 'DESC', searchPlaceholder: 'Search by execution id, label or user',
      filters: { status: ctx.query.status || '' },
      toolbar: (s) => C.chipGroup('status', ['running', 'completed', 'stopped', 'error'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })), (s.filters.status || '').split(',')),
      fetch: (q) => api.get(`/api/runs${api.qs({ projectId: p.id, ...q })}`),
      rowAttrs: (r) => `data-id="${esc(r.id)}"`,
      onRow: (r) => QA.router.go(`/execution/${r.id}`),
      emptyState: () => empty({ icon: 'play', title: 'No executions yet', text: 'Start a run to execute the approved test cases against the selected environment.', action: h`<button class="btn primary" data-act="run">${ic('play')} Run tests</button>` }),
      columns: [
        { key: 'id', label: 'Execution', sortable: false, render: (r) => h`<span class="mono small">${r.id}</span><div class="cell-sub">${r.label || r.trigger || 'manual'}</div>` },
        { key: 'status', label: 'Status', sortable: true, render: (r) => badge(r.status) },
        { key: 'environment', label: 'Env' },
        { key: 'total', label: 'Tests', sortable: true, cls: 'num' },
        { key: 'result', label: 'Result', render: (r) => h`<div class="progress" style="width:120px"><span style="width:${(r.passed / Math.max(1, r.total)) * 100}%;background:var(--success)"></span><span style="width:${(r.failed / Math.max(1, r.total)) * 100}%;background:var(--error)"></span><span style="width:${(r.blocked / Math.max(1, r.total)) * 100}%;background:var(--warning)"></span></div><div class="cell-sub num">${r.passed} passed · ${r.failed} failed${r.blocked ? ` · ${r.blocked} blocked` : ''}</div>` },
        { key: 'failed', label: 'Failed', sortable: true, cls: 'num', render: (r) => (r.failed ? h`<span class="text-error">${r.failed}</span>` : '0') },
        { key: 'avgResponseMs', label: 'Avg', cls: 'num', render: (r) => fmt.ms(r.avgResponseMs) },
        { key: 'user', label: 'By' },
        { key: 'startedAt', label: 'Started', sortable: true, render: (r) => h`<span title="${fmt.date(r.startedAt)}">${fmt.ago(r.startedAt)}</span><div class="cell-sub">${fmt.duration(r.startedAt, r.endedAt)}</div>` },
      ],
    });
    on(view, 'click', '[data-act=run]', () => C.runDialog());
    on(view, 'click', '[data-act=failed]', (e, el) => C.startRun({ mode: 'failed' }, el));
    const t = setInterval(() => { if ((list.state.data && (list.state.data.items || []).some((r) => r.status === 'running'))) list.reload(); }, 4000);
    return () => clearInterval(t);
  }

  // ── Single run ──
  async function renderRun(view, ctx) {
    const runId = ctx.params.runId;
    QA.router.setCrumbs([{ label: 'Test execution', href: '/execution' }, { label: runId }]);
    view.innerHTML = String(loading(12));
    let run; let results;
    try {
      [run, results] = await Promise.all([api.get(`/api/runs/${encodeURIComponent(runId)}`), loadAllResults(runId)]);
    } catch (e) { view.innerHTML = String(errorBox(e)); return null; }

    const state = { tab: ctx.query.tab || 'results', status: ctx.query.status || '', q: '', live: run.status === 'running', log: [] };
    const byIndex = results.slice();
    // Pre-size the ribbon for live runs so cells fill in place.
    const total = Math.max(run.total, byIndex.length);
    const cells = Array.from({ length: total }, (_, i) => byIndex[i] ? { ...byIndex[i] } : { status: 'pending', seq: i + 1, title: '' });

    view.innerHTML = String(h`<div data-head></div>
      <div class="card mt"><div class="card-head"><h2>Execution order <span class="sub" data-progress></span></h2><div class="ribbon-legend" style="margin:0"><span><i style="background:var(--success)"></i>Passed</span><span><i style="background:var(--error)"></i>Failed</span><span><i style="background:var(--warning)"></i>Blocked</span><span><i style="background:var(--skipped)"></i>Skipped</span><span><i style="background:var(--primary)"></i>Running</span></div></div>
        <div class="ribbon-wrap" data-ribbon></div></div>
      <div data-live></div>
      <div class="mt" data-tabs></div><div data-pane></div>`);

    const head = view.querySelector('[data-head]');
    const drawHead = () => {
      const exec = run.passed + run.failed;
      const s = run.summary || {};
      head.innerHTML = String(h`${C.pageHead(h`<span class="mono" style="font-size:20px">${run.id}</span>`, h`${run.label || 'Execution'} · ${run.environment} · ${run.trigger || 'manual'} by ${run.user} · started ${fmt.date(run.startedAt)}`,
        h`${badge(run.status)}
          ${state.live ? h`<button class="btn danger-outline" data-act="stop">${ic('stop')} Stop run</button>` : h`
          <button class="btn" data-act="rerun-failed" ${run.failed + run.blocked ? '' : 'disabled'}>${ic('refresh')} Re-run failed</button>
          <a class="btn" href="/reports?run=${run.id}" data-link>${ic('download')} Report</a>`}`)}
        <div class="kpis" style="--cols:7">
          ${kpiCell('Tests', fmt.num(run.total))}
          ${kpiCell('Passed', fmt.num(run.passed), 'ok')}
          ${kpiCell('Failed', fmt.num(run.failed), run.failed ? 'bad' : '')}
          ${kpiCell('Blocked', fmt.num(run.blocked), run.blocked ? 'warn' : '')}
          ${kpiCell('Pass rate', exec ? `${Math.round((run.passed / exec) * 1000) / 10}%` : '–')}
          ${kpiCell('Avg / p95', run.avgResponseMs ? h`${fmt.num(run.avgResponseMs)}<span class="unit">ms</span>` : '–', '', s.p95Ms ? `p95 ${fmt.ms(s.p95Ms)}` : '')}
          ${kpiCell('Duration', fmt.duration(run.startedAt, run.endedAt), '', run.sfErrors ? `${run.sfErrors} Salesforce errors` : `${run.apiErrors || 0} API errors`)}
        </div>`);
    };
    const kpiCell = (label, value, tone = '', foot = '') => h`<div class="kpi ${tone}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${foot ? h`<div class="kpi-foot">${foot}</div>` : ''}</div>`;

    const ribbonEl = view.querySelector('[data-ribbon]');
    const drawRibbon = () => {
      ribbonEl.innerHTML = QA.charts.ribbon(cells, { large: true });
      const done = cells.filter((c) => !['pending', 'running'].includes(c.status)).length;
      view.querySelector('[data-progress]').textContent = state.live ? `${done} of ${cells.length} complete` : `${cells.length} tests · click a cell for details`;
    };
    on(ribbonEl, 'click', '.cell[data-result]', (e, el) => C.openResult(el.dataset.result, { onChange: refreshAll }));

    const drawLive = () => {
      const el = view.querySelector('[data-live]');
      if (!state.live && !state.log.length) { el.innerHTML = ''; return; }
      el.innerHTML = String(h`<div class="card mt"><div class="card-head"><h2>Live activity ${state.live ? h`<span class="badge running" style="margin-left:8px">Streaming</span>` : ''}</h2><span class="small muted">Server-sent events · correlation ids recorded per request</span></div>
        <div class="card-body" style="max-height:220px;overflow-y:auto;font-family:var(--mono);font-size:12px" data-log>${state.log.slice(-200).map((l) => h`<div class="${l.cls || ''}"><span class="faint">${l.t}</span> ${l.text}</div>`)}</div></div>`);
      const lg = el.querySelector('[data-log]'); if (lg) lg.scrollTop = lg.scrollHeight;
    };

    const TABS = () => [
      { id: 'results', label: 'Results', n: cells.filter((c) => c.id).length },
      { id: 'analysis', label: 'Failure analysis', n: run.failed + run.blocked || null },
      { id: 'jira', label: 'Jira activity', n: (run.jiraActivity || []).length || null },
      { id: 'data', label: 'Test data & cleanup' },
    ];
    const drawTabs = () => { view.querySelector('[data-tabs]').innerHTML = String(C.tabs(TABS(), state.tab)); };
    on(view, 'click', '[data-tab]', (e, el) => { state.tab = el.dataset.tab; QA.router.setQuery({ tab: state.tab === 'results' ? '' : state.tab }); drawTabs(); drawPane(); });

    const pane = view.querySelector('[data-pane]');
    async function drawPane() {
      if (state.tab === 'results') return drawResults();
      if (state.tab === 'analysis') return drawAnalysis();
      if (state.tab === 'jira') return drawJira();
      return drawData();
    }

    function drawResults() {
      const rows = cells.filter((c) => c.id).filter((c) => !state.status || state.status.split(',').includes(c.status)).filter((c) => !state.q || `${c.title} ${c.endpoint} ${c.testCaseId}`.toLowerCase().includes(state.q.toLowerCase()));
      const counts = (s) => cells.filter((c) => c.status === s).length;
      pane.innerHTML = String(h`<div class="card"><div class="toolbar"><input class="input search" type="search" placeholder="Filter by title, endpoint or test id" value="${state.q}" data-rq aria-label="Filter results">
        ${C.chipGroup('rstatus', ['failed', 'blocked', 'passed', 'skipped'].map((s) => ({ value: s, label: `${s[0].toUpperCase() + s.slice(1)} (${counts(s)})` })), state.status.split(','))}
        <span class="spacer"></span><span class="small muted">${rows.length} shown</span></div>
        ${QA.ui.table({ rows: rows.slice(0, 500), rowAttrs: (r) => `data-rid="${esc(r.id)}"`, emptyState: empty({ title: 'No results match', text: state.live ? 'Results appear here as each test completes.' : 'Clear the filters to see every result.' }), columns: [
          { key: 'seq', label: '#', cls: 'num', width: '48px' },
          { key: 'status', label: 'Status', width: '96px', render: (r) => badge(r.status) },
          { key: 'title', label: 'Test', render: (r) => h`<div class="cell-title">${r.title}</div><div class="cell-sub">${C.endpoint(r.method, r.endpoint)}</div>${r.reason ? h`<div class="cell-sub" style="color:var(--error-text)">${r.reason}</div>` : ''}` },
          { key: 'priority', label: 'Pri', render: (r) => pri(r.priority) },
          { key: 'testType', label: 'Type', render: (r) => h`<span class="small">${r.testType}</span>` },
          { key: 'statusCode', label: 'HTTP', render: (r) => C.statusCode(r.statusCode) },
          { key: 'sfValidation', label: 'SF data', render: (r) => (r.sfValidation ? badge(r.sfValidation) : h`<span class="faint">–</span>`) },
          { key: 'responseMs', label: 'Time', cls: 'num', render: (r) => fmt.ms(r.responseMs) },
          { key: 'defectKey', label: 'Defect', render: (r) => (r.defectKey ? h`<a href="/defects?q=${r.defectKey}" data-link>${r.defectKey}</a>` : r.status === 'failed' ? h`<button class="btn xs" data-defect="${r.id}">${ic('bug')} Preview</button>` : '') },
        ] })}</div>`);
    }
    on(pane, 'input', '[data-rq]', QA.ui.debounce((e) => { state.q = e.target.value; const pos = e.target.selectionStart; drawResults(); const i = pane.querySelector('[data-rq]'); i.focus(); i.setSelectionRange(pos, pos); }, 250));
    on(pane, 'click', '[data-chip=rstatus]', (e, el) => { const s = new Set(state.status.split(',').filter(Boolean)); s.has(el.dataset.value) ? s.delete(el.dataset.value) : s.add(el.dataset.value); state.status = [...s].join(','); QA.router.setQuery({ status: state.status }); drawResults(); });
    on(pane, 'click', 'tr[data-rid]', (e, el) => { if (e.target.closest('button, a')) return; C.openResult(el.dataset.rid, { onChange: refreshAll }); });
    on(pane, 'click', '[data-defect]', (e, el) => C.defectPreview(el.dataset.defect, { onCreated: refreshAll }));

    async function drawAnalysis() {
      pane.innerHTML = String(loading(6));
      try {
        const a = await api.get(`/api/runs/${run.id}/analysis`);
        if (!a.failures.length) { pane.innerHTML = String(h`<div class="card">${empty({ icon: 'check', title: 'No failures to analyse', text: 'Every executed test passed in this run.' })}</div>`); return; }
        pane.innerHTML = String(h`
          ${a.aiSummary ? h`<div class="callout info">${ic('spark')}<div><b>AI summary</b> ${QA.ui.prov('ASSUMED')}<div class="small mt-s" style="white-space:pre-wrap">${a.aiSummary}</div></div></div>` : ''}
          <div class="grid g-21 ${a.aiSummary ? 'mt' : ''}">
            <div class="card"><div class="card-head"><h2>Failures and root causes</h2><span class="small muted">Defects are never created automatically — preview and confirm each one.</span></div>
              <div class="card-body flush">${a.failures.map((f) => h`<div style="padding:14px 18px;border-bottom:1px solid var(--border)">
                <div class="row wrap" style="gap:8px">${badge(f.status)}<b>${f.title}</b><span class="spacer"></span>${f.defectKey ? h`<a class="badge Open plain" href="/defects?q=${f.defectKey}" data-link>${f.defectKey}</a>` : f.status === 'failed' ? h`<button class="btn sm" data-defect="${f.resultId}">${ic('bug')} Preview Jira defect</button>` : ''}<button class="btn sm ghost" data-open="${f.resultId}">Details</button></div>
                ${f.analysis ? h`<div class="row wrap small mt-s" style="gap:8px">${f.analysis.classification ? h`<span class="tag" title="Failure classification">${f.analysis.classification}</span>` : ''}<span class="tag">${f.analysis.category}</span>${QA.ui.prov(f.analysis.label)}<span class="muted">confidence ${f.analysis.confidence}</span>${f.statusCode ? h`<span class="muted">HTTP ${f.statusCode}</span>` : ''}</div>
                <p class="small" style="margin:8px 0 4px">${f.analysis.rootCause}</p>
                ${f.analysis.evidence && f.analysis.evidence.length ? h`<ul class="list small muted" style="margin:0 0 6px">${f.analysis.evidence.slice(0, 4).map((x) => h`<li>${x}</li>`)}</ul>` : ''}
                <p class="small" style="margin:0 0 4px"><b>Impact:</b> ${f.analysis.impact || ''}</p>
                <p class="small" style="margin:0 0 4px"><b>Recommendation:</b> ${f.analysis.recommendation || f.analysis.action}</p>
                <p class="small" style="margin:0"><b>Retest:</b> ${f.analysis.retest || ''}</p>` : ''}
              </div>`)}</div></div>
            <div class="stack">
              <div class="card"><div class="card-head"><h2>Failure categories</h2></div><div class="card-body">${QA.charts.hbars ? raw(QA.charts.hbars({ items: a.categories.map((c) => ({ label: c.category, value: c.count, color: '--error' })) })) : ''}</div></div>
              <div class="card"><div class="card-head"><h2>Endpoint hotspots</h2></div><div class="card-body flush"><ul class="list" style="margin:0">${a.hotspots.map((x) => h`<li style="padding:10px 18px"><code class="mono small" style="word-break:break-all">${x.endpoint}</code><div class="small muted">${x.failed} of ${x.total} failed</div></li>`)}</ul></div></div>
              <div class="card"><div class="card-head"><h2>Regression recommendation</h2>${QA.ui.prov('RECOMMENDED')}</div><div class="card-body">
                ${a.regressionRecommendation.tests.length ? h`<p class="small muted" style="margin-top:0">Re-run ${a.regressionRecommendation.tests.length} P0/P1 tests on objects with failures: ${a.regressionRecommendation.objects.join(', ')}.</p><button class="btn sm primary" data-regress>${ic('play')} Run recommended regression</button>` : h`<p class="small muted" style="margin:0">No P0/P1 tests share objects with the failures.</p>`}
              </div></div>
            </div>
          </div>`);
        state.regressIds = a.regressionRecommendation.tests.map((t) => t.id);
      } catch (e) { pane.innerHTML = String(errorBox(e)); }
    }
    on(pane, 'click', '[data-regress]', (e, el) => C.startRun({ testCaseIds: state.regressIds, label: `Regression after ${run.id}` }, el));
    on(pane, 'click', '[data-open]', (e, el) => C.openResult(el.dataset.open, { onChange: refreshAll }));

    function drawJira() {
      const act = run.jiraActivity || [];
      pane.innerHTML = String(h`<div class="card">${act.length ? h`<ul class="list" style="margin:0">${act.map((a) => h`<li style="padding:12px 18px"><div class="row"><b>${a.action}</b><span class="spacer"></span><span class="small muted">${fmt.date(a.ts)} · ${a.user}</span></div><div class="small muted mono">${JSON.stringify(a.detail)}</div></li>`)}</ul>` : empty({ icon: 'jira', title: 'No Jira activity for this run', text: 'Defects created from this run, story links and comments are listed here.' })}</div>`);
    }
    function drawData() {
      const s = run.summary || {};
      const cl = s.cleanup;
      const recs = run.createdRecords || [];
      const byObj = recs.reduce((m, r) => { m[r.object] = (m[r.object] || 0) + 1; return m; }, {});
      pane.innerHTML = String(h`<div class="grid g-2"><div class="card"><div class="card-head"><h2>Records created by this run</h2><span class="small muted">${recs.length} records</span></div><div class="card-body">
        ${recs.length ? QA.charts.hbars({ items: Object.entries(byObj).map(([o, n]) => ({ label: o, value: n })) }) : h`<p class="muted small" style="margin:0">This run did not create Salesforce records.</p>`}</div></div>
        <div class="card"><div class="card-head"><h2>Cleanup</h2></div><div class="card-body">
        ${run.environment === 'Production' ? h`<div class="callout warn">${ic('shield')}<div class="small">Automatic cleanup never runs in Production. Records are not created or deleted automatically there.</div></div>` : cl ? C.kv([['Attempted', fmt.num(cl.attempted)], ['Deleted', fmt.num(cl.deleted)], ['Errors', cl.errors && cl.errors.length ? h`<ul class="list">${cl.errors.slice(0, 10).map((x) => h`<li class="small">${typeof x === 'string' ? x : JSON.stringify(x)}</li>`)}</ul>` : 'None']]) : h`<p class="muted small" style="margin:0">${state.live ? 'Cleanup runs after the last test completes.' : 'Cleanup was not performed for this run.'}</p>`}
        </div></div></div>`);
    }

    async function refreshAll() {
      try {
        [run, results] = await Promise.all([api.get(`/api/runs/${run.id}`), loadAllResults(run.id)]);
        results.forEach((r, i) => { cells[i] = { ...r }; });
        drawHead(); drawRibbon(); drawTabs(); drawPane();
        QA.state.emit('defects-changed');
      } catch (e) { toastError(e); }
    }

    drawHead(); drawRibbon(); drawLive(); drawTabs(); drawPane();

    on(view, 'click', '[data-act=stop]', (e, el) => withBusy(el, async () => {
      const ok = await QA.ui.confirm({ title: 'Stop this run?', message: 'The test in progress finishes, remaining tests are marked skipped, and created test data is still cleaned up (outside Production).', confirmLabel: 'Stop run', danger: true });
      if (!ok) return;
      try { await api.post(`/api/runs/${run.id}/stop`); toast('Stopping after the current test…', 'warn', 'Stop requested'); } catch (err) { toastError(err); }
    }));
    on(view, 'click', '[data-act=rerun-failed]', (e, el) => C.startRun({ mode: 'failed', fromRunId: run.id }, el));

    // Live stream
    let close = () => {};
    if (state.live) {
      const t = () => new Date().toLocaleTimeString();
      const log = (text, cls) => { state.log.push({ t: t(), text, cls }); drawLive(); };
      log(`Connected to ${run.id} — ${run.total} tests queued in ${run.environment}.`);
      let redrawTimer = null;
      const scheduleRedraw = () => { if (redrawTimer) return; redrawTimer = setTimeout(() => { redrawTimer = null; drawHead(); drawRibbon(); if (state.tab === 'results') drawResults(); }, 120); };
      close = api.stream(`/api/runs/${run.id}/stream`, {
        'test-start': (e) => { if (cells[e.index]) { cells[e.index] = { ...cells[e.index], status: 'running', title: e.title, testCaseId: e.testCaseId }; scheduleRedraw(); } },
        'test-result': (e) => {
          cells[e.index] = { ...e.result };
          Object.assign(run, e.counts || {});
          if (e.result.status !== 'passed') log(`#${e.result.seq} ${e.result.status.toUpperCase()} ${e.result.title}${e.result.reason ? ` — ${e.result.reason}` : ''}`, e.result.status === 'failed' ? 'text-error' : 'text-warn');
          scheduleRedraw();
        },
        notice: (e) => log(e.message, 'text-warn'),
        stopping: () => log('Stop requested — finishing the current test.', 'text-warn'),
        'cleanup-start': (e) => log(`Cleaning up ${e.count} test records…`),
        'run-end': async (e) => {
          log(`Run ${e.status}. ${e.counts ? `${e.counts.passed} passed, ${e.counts.failed} failed, ${e.counts.blocked} blocked, ${e.counts.skipped} skipped.` : ''}`);
          state.live = false; close();
          QA.state.notify({ title: `Run ${run.id} ${e.status}`, message: e.counts ? `${e.counts.passed} passed · ${e.counts.failed} failed · ${e.counts.blocked} blocked` : e.error || '', kind: e.counts && e.counts.failed ? 'error' : 'ok' });
          await refreshAll(); drawLive();
        },
        error: () => { /* EventSource retries automatically */ },
      });
    }
    return () => close();
  }

  async function loadAllResults(runId) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const r = await api.get(`/api/runs/${encodeURIComponent(runId)}/results?pageSize=200&page=${page}&sort=seq&dir=ASC`);
      out.push(...r.items);
      if (QA.api.snapshot || page >= r.pages) break;
    }
    return out;
  }
})();
