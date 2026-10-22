/* Traceability (story → scenario → case → execution → result → defect) and regression impact. */
(() => {
  const QA = window.QA;
  const { h, ic, fmt, badge, prov, pri, method, on, errorBox, loading, empty, withBusy } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.traceability = {
    render(view, ctx) {
      if (!QA.state.project) { view.innerHTML = String(C.projectRequired()); return null; }
      return ctx.path === '/regression' ? renderRegression(view, ctx) : renderTrace(view, ctx);
    },
  };

  async function renderTrace(view, ctx) {
    const p = QA.state.project;
    QA.router.setCrumbs([{ label: 'Traceability' }]);
    view.innerHTML = String(h`${C.pageHead('Traceability', 'See the chain from a Jira ticket → scenarios → tests → latest run → result → defect.', h`<a class="btn" href="/regression" data-link>${ic('target')} What a change would hit</a>`)}
      ${C.pageIntro({ what: 'Coverage map for this project. Gaps (ticket with no tests, or tests with no recent run) show up here.', next: 'Scan the table for missing links. Use “What a change would hit” if a story or object changed and you need the P0 pack.' })}
      <div data-body>${loading(10)}</div>`);
    let d;
    try { d = await api.get(`/api/traceability?projectId=${p.id}`); } catch (e) { view.querySelector('[data-body]').innerHTML = String(errorBox(e)); return null; }
    const m = d.metrics;
    const state = { q: ctx.query.q || '', only: ctx.query.only || '' };
    const body = view.querySelector('[data-body]');
    const k = (label, value, foot, tone = '') => h`<div class="kpi ${tone}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${foot ? h`<div class="kpi-foot">${foot}</div>` : ''}</div>`;
    body.innerHTML = String(h`<div class="kpis" style="--cols:6">
        ${k('Requirement coverage', `${m.coveragePct}%`, `${m.storiesCovered} of ${m.storiesTotal} stories`, m.coveragePct >= 90 ? 'ok' : m.coveragePct >= 70 ? 'warn' : 'bad')}
        ${k('Tests generated', fmt.num(m.testsGenerated))}
        ${k('Executed', `${m.executionPct}%`, `${m.testsExecuted} tests`)}
        ${k('Passed / failed', h`<span class="text-ok">${m.passed}</span> / <span class="text-error">${m.failed}</span>`, `${m.blocked} blocked`)}
        ${k('Defects created', fmt.num(m.defectsCreated))}
        ${k('Defects resolved', fmt.num(m.defectsResolved))}
      </div>
      <div class="card mt"><div class="toolbar"><input class="input search" type="search" placeholder="Filter stories, scenarios or tests" value="${state.q}" data-q aria-label="Filter">
        ${C.chipGroup('only', [{ value: 'failed', label: 'Has failures' }, { value: 'untested', label: 'Not executed' }, { value: 'uncovered', label: 'No tests' }, { value: 'defects', label: 'Has defects' }], [state.only])}
        <span class="spacer"></span><button class="btn sm" data-expand="1">Expand all</button><button class="btn sm" data-expand="0">Collapse all</button></div>
        <div class="card-body flush"><div class="tree" data-tree></div></div></div>`);
    const tree = body.querySelector('[data-tree]');
    const draw = () => {
      const q = state.q.toLowerCase();
      const match = (s) => !q || JSON.stringify([s.key, s.summary, s.scenarios.map((x) => [x.title, x.tests.map((t) => [t.id, t.title, t.endpoint])])]).toLowerCase().includes(q);
      const filt = (s) => {
        const tests = s.scenarios.flatMap((x) => x.tests);
        if (state.only === 'failed') return tests.some((t) => t.execution && t.execution.status === 'failed');
        if (state.only === 'untested') return tests.some((t) => !t.execution);
        if (state.only === 'uncovered') return !tests.length;
        if (state.only === 'defects') return tests.some((t) => t.defects.length);
        return true;
      };
      const rows = d.tree.filter((s) => match(s) && filt(s));
      tree.innerHTML = String(rows.length ? h`${rows.map((s) => {
        const tests = s.scenarios.flatMap((x) => x.tests);
        const failed = tests.filter((t) => t.execution && t.execution.status === 'failed').length;
        const defects = tests.reduce((n, t) => n + t.defects.length, 0);
        return h`<details ${q || state.only ? 'open' : ''}><summary><span class="row" style="gap:8px;flex:1;min-width:0">${ic('jira')}<a href="/stories/${s.key}" data-link class="mono small"><b>${s.key}</b></a><span class="truncate">${s.summary}</span><span class="spacer"></span><span class="tag">${s.status}</span>${tests.length ? h`<span class="small muted num">${tests.length} tests</span>` : h`<span class="badge blocked plain">No tests</span>`}${failed ? h`<span class="badge failed">${failed} failed</span>` : ''}${defects ? h`<span class="badge Open plain">${ic('bug')} ${defects}</span>` : ''}</span></summary>
          ${s.scenarios.length ? s.scenarios.map((sc) => h`<details style="margin-left:18px"><summary><span class="row" style="gap:8px;flex:1;min-width:0">${ic('layers')}<span class="truncate">${sc.title}</span><span class="spacer"></span><span class="tag">${sc.type}</span>${pri(sc.priority)}${prov(sc.label)}</span></summary>
            ${sc.tests.map((t) => h`<div class="leaf row wrap" style="gap:8px;margin-left:22px">
              <a href="/testcases?id=${t.id}" data-link class="mono small">${t.id}</a><span class="truncate" style="max-width:380px">${t.title}</span>${method(t.method)}
              <span class="spacer"></span>
              ${t.execution ? h`<a href="/execution/${t.execution.runId}" data-link class="mono small faint">${t.execution.runId}</a><button class="btn xs ghost" data-res="${t.execution.id}">${badge(t.execution.status)} ${t.execution.statusCode || ''} · ${fmt.ms(t.execution.responseMs)}</button>` : h`<span class="faint small">Not executed</span>`}
              ${t.defects.map((x) => h`<a class="badge ${x.status === 'Open' ? 'Open' : 'ok'} plain" href="/defects?q=${x.key}" data-link>${ic('bug')} ${x.key}</a>`)}
            </div>`)}</details>`) : h`<p class="small muted" style="margin:6px 0 10px 26px">No scenarios. <a href="/stories/${s.key}" data-link>Generate API tests</a> for this story.</p>`}
        </details>`;
      })}` : empty({ icon: 'tree', title: 'Nothing matches', text: 'Clear the filter to see the full traceability tree.' }));
    };
    draw();
    on(body, 'input', '[data-q]', QA.ui.debounce((e) => { state.q = e.target.value.trim(); QA.router.setQuery({ q: state.q }); draw(); }, 200));
    on(body, 'click', '[data-chip=only]', (e, el) => { state.only = state.only === el.dataset.value ? '' : el.dataset.value; body.querySelectorAll('[data-chip=only]').forEach((c) => { c.classList.toggle('on', c.dataset.value === state.only); c.setAttribute('aria-pressed', c.dataset.value === state.only); }); QA.router.setQuery({ only: state.only }); draw(); });
    on(body, 'click', '[data-expand]', (e, el) => tree.querySelectorAll('details').forEach((x) => { x.open = el.dataset.expand === '1'; }));
    on(body, 'click', '[data-res]', (e, el) => { e.preventDefault(); C.openResult(el.dataset.res); });
    return null;
  }

  async function renderRegression(view, ctx) {
    const p = QA.state.project;
    QA.router.setCrumbs([{ label: 'Traceability', href: '/traceability' }, { label: 'Regression impact' }]);
    let objects = [];
    try { objects = (await api.get(`/api/projects/${p.id}/sobjects`, { cacheMs: 300000 })).objects.map((o) => o.name); } catch { /* manual entry still works */ }
    view.innerHTML = String(h`${C.pageHead('What a change would hit', 'Name the ticket, objects or endpoints that changed. We rank the tests that should re-run, and always include the P0 pack.')}
      ${C.pageIntro({ what: 'A “what should I re-run?” helper. It does not change Salesforce.', next: 'Enter a story key like DEMO-102, tick changed objects, then Find impacted tests. Start a run from the result list if you want to execute them.' })}
      <div class="grid g-12"><div class="card" style="align-self:start"><div class="card-head"><h2>What changed?</h2></div><div class="card-body stack">
        <label class="field"><span>Story key</span><input class="input mono" name="story" value="${ctx.query.story || ''}" placeholder="e.g. DEMO-102"><small>Objects mentioned in the story are added automatically.</small></label>
        <div class="field"><span>Changed objects</span>${objects.length ? C.chipGroup('obj', objects, (ctx.query.objects || '').split(',')) : h`<input class="input mono" name="objtext" placeholder="Account, Contact">`}</div>
        <label class="field"><span>Changed endpoints (one per line, partial match)</span><textarea class="input mono" rows="3" name="eps" placeholder="/services/apexrest/v1/invoices"></textarea></label>
        <button class="btn primary" data-act="analyse">${ic('target')} Find impacted tests</button></div></div>
        <div class="card" data-out>${empty({ icon: 'target', title: 'No analysis yet', text: 'Choose a story, objects or endpoints, then find impacted tests.' })}</div></div>`);
    const sel = new Set((ctx.query.objects || '').split(',').filter(Boolean));
    on(view, 'click', '[data-chip=obj]', (e, el) => { sel.has(el.dataset.value) ? sel.delete(el.dataset.value) : sel.add(el.dataset.value); el.classList.toggle('on'); el.setAttribute('aria-pressed', sel.has(el.dataset.value)); });
    let last = null;
    const analyse = (btn) => withBusy(btn, async () => {
      const objs = view.querySelector('[name=objtext]') ? view.querySelector('[name=objtext]').value.split(',').map((x) => x.trim()).filter(Boolean) : [...sel];
      const body = { storyKey: view.querySelector('[name=story]').value.trim() || undefined, objects: objs, endpoints: view.querySelector('[name=eps]').value.split('\n').map((x) => x.trim()).filter(Boolean) };
      const out = view.querySelector('[data-out]');
      try {
        last = await api.post(`/api/regression/impact?projectId=${p.id}`, body);
        out.innerHTML = String(h`<div class="card-head"><h2>${last.impacted.length} impacted tests</h2><div class="row">${prov(last.label)}<button class="btn sm primary" data-act="runimpact" ${last.impacted.length ? '' : 'disabled'}>${ic('play')} Run impacted tests</button></div></div>
          ${last.objects.length ? h`<div class="card-body small muted" style="padding-bottom:0">Objects: ${last.objects.join(', ')}</div>` : ''}
          ${QA.ui.table({ rows: last.impacted, emptyState: empty({ title: 'No impacted tests', text: 'No tests touch these objects or endpoints.' }), columns: [
            { key: 'id', label: 'Test', render: (r) => h`<a href="/testcases?id=${r.id}" data-link class="mono small">${r.id}</a>` }, { key: 'title', label: 'Title' }, { key: 'priority', label: 'Pri', render: (r) => pri(r.priority) },
            { key: 'object', label: 'Object', render: (r) => h`<span class="mono small">${r.object || '–'}</span>` }, { key: 'reason', label: 'Why', render: (r) => h`<span class="small">${r.reason}</span>` }, { key: 'lastResult', label: 'Last', render: (r) => (r.lastResult ? badge(r.lastResult) : '–') },
          ] })}`);
      } catch (err) { out.innerHTML = String(h`<div class="card-body">${errorBox(err)}</div>`); }
    });
    on(view, 'click', '[data-act=analyse]', (e, el) => analyse(el));
    on(view, 'click', '[data-act=runimpact]', (e, el) => C.startRun({ testCaseIds: last.impacted.map((t) => t.id), label: `Regression: ${last.objects.join(', ') || 'impacted tests'}`, trigger: 'regression' }, el));
    if (ctx.query.story || ctx.query.objects) analyse(view.querySelector('[data-act=analyse]'));
    return null;
  }
})();
