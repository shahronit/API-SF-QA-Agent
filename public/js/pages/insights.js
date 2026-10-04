/* Insights: failing endpoints above a threshold, duplicate tests, coverage gaps. */
(() => {
  const QA = window.QA;
  const { h, ic, fmt, prov, method, on, errorBox, loading, empty } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.insights = {
    async render(view, ctx) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Insights' }]);
      let threshold = Number(ctx.query.failureRate || 10);
      view.innerHTML = String(h`${C.pageHead('Insights', 'Where quality risk concentrates: unstable endpoints, redundant tests and missing coverage. Items marked RECOMMENDED need a human decision.')}
        <div class="card" style="margin-bottom:16px"><div class="toolbar"><label class="small" for="thr">Show APIs with failure rate above</label><select class="select" id="thr" data-thr>${[0, 5, 10, 25, 50].map((t) => h`<option value="${t}" ${t === threshold ? 'selected' : ''}>${t}%</option>`)}</select></div></div><div data-body>${loading(8)}</div>`);
      const body = view.querySelector('[data-body]');
      async function load() {
        try {
          const d = await api.get(`/api/insights${api.qs({ projectId: p.id, failureRate: threshold })}`);
          const types = Object.entries(d.typeDistribution);
          body.innerHTML = String(h`<div class="grid g-21">
            <div class="card"><div class="card-head"><h2>APIs with failure rate above ${d.threshold}%</h2><span class="small muted">${d.failingEndpoints.length}</span></div>
              ${QA.ui.table({ rows: d.failingEndpoints, emptyState: empty({ icon: 'check', title: `No API fails more than ${d.threshold}% of the time`, text: 'Lower the threshold to see less frequent failures.' }), columns: [
                { key: 'endpoint', label: 'Endpoint', render: (x) => h`${method(x.method)} <code class="mono small">${fmt.shortPath(x.endpoint)}</code>` },
                { key: 'failureRate', label: 'Failure rate', render: (x) => h`<div class="row" style="gap:8px"><div class="progress" style="width:90px"><span style="width:${x.failureRate}%;background:var(--error)"></span></div><span class="num small">${x.failureRate}%</span></div>` },
                { key: 'runs', label: 'Executions', cls: 'num', render: (x) => h`${x.failed}/${x.runs}` }, { key: 'avgMs', label: 'Avg', cls: 'num', render: (x) => fmt.ms(x.avgMs) },
                { key: 'go', label: '', render: (x) => h`<a class="btn xs" href="/testcases?q=${encodeURIComponent(x.endpoint)}" data-link>Tests</a>` },
              ] })}</div>
            <div class="card"><div class="card-head"><h2>Test type mix</h2></div><div class="card-body">${types.length ? QA.charts.hbars({ items: types.map(([k, v]) => ({ label: k, value: v })) }) : h`<p class="small muted">No tests.</p>`}</div></div></div>
            <div class="grid g-2 mt">
              <div class="card"><div class="card-head"><h2>Coverage gaps</h2><span class="small muted">${d.gaps.length}</span></div><div class="card-body stack" style="gap:10px">${d.gaps.length ? d.gaps.map((g) => h`<div class="row" style="align-items:flex-start;gap:8px">${prov(g.label)}<span class="small" style="flex:1">${g.text}</span>${g.storyKey ? h`<a class="btn xs" href="/stories/${g.storyKey}" data-link>${ic('wand')} Generate</a>` : ''}</div>`) : h`<p class="small muted" style="margin:0">No gaps detected.</p>`}</div></div>
              <div class="card"><div class="card-head"><h2>Possible duplicate tests</h2><span class="small muted">${d.duplicates.length}</span></div>${QA.ui.table({ rows: d.duplicates, emptyState: empty({ icon: 'copy', title: 'No duplicates', text: 'No test cases share the same request and assertions.' }), columns: [
                { key: 'endpoint', label: 'Request', render: (x) => h`${method(x.method)} <code class="mono small">${fmt.shortPath(x.endpoint)}</code>` }, { key: 'count', label: 'Copies', cls: 'num' },
                { key: 'ids', label: 'Test cases', render: (x) => h`${x.ids.map((id) => h`<a href="/testcases?id=${id}" data-link class="mono small" style="margin-right:6px">${id}</a>`)}` },
              ] })}</div></div>`);
        } catch (e) { body.innerHTML = String(errorBox(e)); }
      }
      on(view, 'change', '[data-thr]', (e, el) => { threshold = Number(el.value); QA.router.setQuery({ failureRate: threshold }); load(); });
      load();
      return null;
    },
  };
})();
