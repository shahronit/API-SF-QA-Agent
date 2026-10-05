/* Reports: per-execution QA report preview and export (PDF, Excel, CSV, HTML). */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, badge, prov, on, errorBox, loading, empty, toastError, withBusy } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.reports = {
    async render(view, ctx) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Reports' }]);
      view.innerHTML = String(h`${C.pageHead('Reports', 'Execution reports for stakeholders. Credentials and tokens are masked in every format.')}<div data-body>${loading(8)}</div>`);
      const body = view.querySelector('[data-body]');
      let runs;
      try { runs = (await api.get(`/api/runs${api.qs({ projectId: p.id, pageSize: 50 })}`)).items; } catch (e) { body.innerHTML = String(errorBox(e)); return null; }
      if (!runs.length) { body.innerHTML = String(h`<div class="card">${empty({ icon: 'chart', title: 'No executions to report on', text: 'Run tests first; each execution produces a downloadable report.', action: h`<a class="btn primary" href="/execution" data-link>Go to execution</a>` })}</div>`); return null; }
      let runId = ctx.query.run && runs.some((r) => r.id === ctx.query.run) ? ctx.query.run : runs[0].id;
      body.innerHTML = String(h`<div class="card"><div class="toolbar"><label class="small" for="rsel">Execution</label><select class="select" id="rsel" data-run style="min-width:360px">${runs.map((r) => h`<option value="${r.id}" ${r.id === runId ? 'selected' : ''}>${r.id} · ${r.label || r.trigger || 'manual'} · ${r.passed}/${r.total} passed · ${fmt.date(r.startedAt)}</option>`)}</select>
        <span class="spacer"></span>${['pdf', 'xlsx', 'csv', 'html'].map((f) => h`<button class="btn sm" data-dl="${f}">${ic('download')} ${{ pdf: 'PDF', xlsx: 'Excel', csv: 'CSV', html: 'HTML' }[f]}</button>`)}</div></div><div class="mt" data-report>${loading(10)}</div>`);
      const out = body.querySelector('[data-report]');
      async function load() {
        out.innerHTML = String(loading(10));
        try { const d = await api.get(`/api/reports/${encodeURIComponent(runId)}?format=json`); out.innerHTML = String(renderReport(d)); } catch (e) { out.innerHTML = String(errorBox(e)); }
      }
      on(body, 'change', '[data-run]', (e, el) => { runId = el.value; QA.router.setQuery({ run: runId }); load(); });
      on(body, 'click', '[data-dl]', (e, el) => withBusy(el, async () => { try { await api.download(`/api/reports/${encodeURIComponent(runId)}?format=${el.dataset.dl}`, `qa-report-${runId}.${el.dataset.dl}`); } catch (err) { toastError(err, 'Export failed'); } }));
      load();
      return null;
    },
  };

  function renderReport(d) {
    const r = d.run;
    const k = (label, value, tone = '', foot = '') => h`<div class="kpi ${tone}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${foot ? h`<div class="kpi-foot">${foot}</div>` : ''}</div>`;
    return h`<div class="card"><div class="card-head"><h2>Executive summary</h2>${badge(d.health === 'Healthy' ? 'passed' : d.health === 'Critical' ? 'failed' : 'blocked', d.health)}</div><div class="card-body"><p style="margin:0;max-width:90ch">${d.executiveSummary}</p>
        ${d.aiSummary ? h`<div class="callout info mt">${ic('spark')}<div class="small"><b>AI analysis</b> ${prov('ASSUMED')}<div style="white-space:pre-wrap">${d.aiSummary}</div></div></div>` : ''}</div></div>
      <div class="kpis mt" style="--cols:6">${k('Pass rate', `${r.passRate}%`, r.passRate >= 95 ? 'ok' : r.passRate >= 85 ? 'warn' : 'bad')}${k('Passed', r.passed, 'ok')}${k('Failed', r.failed, r.failed ? 'bad' : '')}${k('Blocked', r.blocked, r.blocked ? 'warn' : '')}${k('Avg / p95', `${fmt.ms(r.avgResponseMs)}`, '', r.p95Ms ? `p95 ${fmt.ms(r.p95Ms)} · SLA ${fmt.ms(d.slaMs)}` : '')}${k('Defects', d.defects.length, '', `${d.defectCandidates} candidates`)}</div>
      <div class="grid g-2 mt">
        <div class="card"><div class="card-head"><h2>Coverage</h2></div><div class="card-body">${C.kv([['Project', `${d.project.name} · ${d.project.environment}`], ['Salesforce org', `${d.project.sfOrg || '–'} · API v${d.project.apiVersion}`], ['Stories covered', `${d.coverage.storiesCovered} of ${d.coverage.storiesTotal}`], ['Stories without tests', d.coverage.storiesWithoutTests.join(', ') || 'None'], ['API types', d.coverage.apiTypes.join(', ')], ['Endpoints covered', d.coverage.endpointsCovered], ['Salesforce validations', h`${d.sfValidation.passed} pass · ${d.sfValidation.failed} fail of ${d.sfValidation.total} <span class="small muted">(${d.sfValidation.label})</span>`]])}</div></div>
        <div class="card"><div class="card-head"><h2>Recommendations</h2></div><div class="card-body">${(d.recommendations || []).length ? h`<ul class="list" style="margin:0">${d.recommendations.map((x) => h`<li class="small" style="padding:6px 0">${typeof x === 'string' ? x : h`${prov(x.label)} ${x.text}`}</li>`)}</ul>` : h`<p class="small muted" style="margin:0">No recommendations.</p>`}</div></div>
      </div>
      ${d.failed.length ? h`<div class="card mt"><div class="card-head"><h2>Failed tests</h2><span class="small muted">${d.failed.length}</span></div>${QA.ui.table({ rows: d.failed, columns: [
        { key: 'id', label: 'Test', render: (x) => h`<span class="mono small">${x.id}</span>` }, { key: 'title', label: 'Title', render: (x) => h`<div class="cell-title">${x.title}</div><div class="cell-sub mono">${x.endpoint}</div>` }, { key: 'statusCode', label: 'HTTP', render: (x) => C.statusCode(x.statusCode) },
        { key: 'rootCause', label: 'Root cause', render: (x) => h`<span class="tag">${x.classification || x.category || ''}</span><div class="small">${x.rootCause || ''}</div>${x.impact ? h`<div class="small muted">Impact: ${x.impact}</div>` : ''}${x.retest ? h`<div class="small muted">Retest: ${x.retest}</div>` : ''}` }, { key: 'defectKey', label: 'Defect', render: (x) => x.defectKey || h`<span class="faint small">None</span>` },
      ] })}</div>` : ''}
      <div class="grid g-2 mt">
        <div class="card"><div class="card-head"><h2>Risks</h2></div><div class="card-body"><ul class="list" style="margin:0">${(d.risks || []).map((x) => h`<li class="small" style="padding:6px 0"><span class="tag ${x.level === 'High' ? 'bad' : x.level === 'Medium' ? 'warn' : ''}">${x.level}</span> ${x.text}</li>`)}</ul></div></div>
        <div class="card"><div class="card-head"><h2>Automation assets</h2></div><div class="card-body">${d.automationAssets ? C.kv([['Postman collection', h`<a href="${d.automationAssets.postmanCollection.url}" download>${d.automationAssets.postmanCollection.name}</a>`], ['Postman environment', h`<a href="${d.automationAssets.postmanEnvironment.url}" download>${d.automationAssets.postmanEnvironment.name}</a><div class="small muted">${d.automationAssets.postmanEnvironment.note}</div>`], ['Newman', h`<code class="mono small" style="word-break:break-all">${d.automationAssets.newmanCommand}</code>`], ['Automated tests', `${d.automationAssets.tests.automated} of ${d.automationAssets.tests.total} (${d.automationAssets.tests.regression} regression-tagged)`]]) : ''}</div></div>
      </div>
      <div class="card mt"><div class="card-head"><h2>Endpoint health</h2></div>${QA.ui.table({ rows: d.endpoints, columns: [
        { key: 'endpoint', label: 'Endpoint', render: (x) => h`<code class="mono small" style="word-break:break-all">${x.endpoint}</code>` }, { key: 'health', label: 'Health', render: (x) => badge(x.health) },
        { key: 'total', label: 'Tests', cls: 'num' }, { key: 'failed', label: 'Failed', cls: 'num', render: (x) => (x.failed ? h`<span class="text-error">${x.failed}</span>` : '0') }, { key: 'avg', label: 'Avg', cls: 'num', render: (x) => fmt.ms(x.avg) }, { key: 'p95', label: 'p95', cls: 'num', render: (x) => fmt.ms(x.p95) },
      ] })}</div>
      <p class="small muted mt">Generated ${fmt.date(d.generatedAt)} · ${r.id} · ${r.total} results. Download the Excel or CSV export for the full result list.</p>`;
  }
})();
