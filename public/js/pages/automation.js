/* Automation: Postman export/import, Newman runs, CI pipeline and framework structure. */
(() => {
  const QA = window.QA;
  const { h, ic, fmt, badge, on, errorBox, empty, toast, toastError, withBusy, modal, json } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  const TREE = `api-tests/
├── collections/        Postman collections (exported per project)
├── environments/       Postman environments — secret values left empty
├── test-data/          Datasets exported from the Test Data manager
├── schemas/            OpenAPI / JSON Schema contracts
├── scripts/
│   ├── run-suite.js    Runs tests through the platform API (CI-friendly, JUnit output)
│   └── run-newman.js   Runs Newman with env-var credentials
├── reports/            JUnit, HTML and JSON reports (git-ignored)
└── config/             Per-environment settings (no secrets)`;

  QA.pages.automation = {
    render(view) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Automation' }]);
      const m = QA.state.meta;
      view.innerHTML = String(h`${C.pageHead('Automation', 'Export approved tests as Postman collections, run them with Newman locally or in CI, and import existing collections.')}
        <div class="grid g-2">
          <div class="card"><div class="card-head"><h2>Export Postman collection</h2><span class="small muted">Collection v2.1</span></div><div class="card-body stack">
            <div class="field"><span>Priority</span>${C.chipGroup('xp', m.priorities, [])}</div>
            <div class="field"><span>Test type</span>${C.chipGroup('xt', m.testTypes, [])}</div>
            <div class="callout info">${ic('lock')}<div class="small">Requests use <code>{{baseUrl}}</code>, <code>{{accessToken}}</code>, <code>{{clientId}}</code>, <code>{{clientSecret}}</code>, <code>{{recordId}}</code>. A collection-level pre-request script fetches the token from environment variables. No secrets are written to the file.</div></div>
            <div class="row"><button class="btn primary" data-act="col">${ic('download')} Download collection</button><button class="btn" data-act="env">${ic('download')} Download ${p.environment} environment</button></div>
          </div></div>
          <div class="card"><div class="card-head"><h2>Run with Newman</h2><span class="small muted">server-side, in api-tests/</span></div><div class="card-body stack">
            <p class="small muted" style="margin:0">Writes the collection to <code>api-tests/collections/${p.id}.postman_collection.json</code> and runs <code>npx newman</code>. Requires <code>npm install</code> inside <code>api-tests/</code> and credentials in the environment file or CI secrets.</p>
            <div class="row"><button class="btn primary" data-act="newman">${ic('play')} Run Newman</button></div><div data-newman></div>
          </div></div>
        </div>
        <div class="grid g-2 mt">
          <div class="card"><div class="card-head"><h2>Import Postman collection</h2></div><div class="card-body stack">
            <label class="field"><span>Collection file (v2.1 JSON)</span><input class="input" type="file" name="pfile" accept=".json,application/json"></label>
            <label class="field"><span>Link to story (optional)</span><input class="input mono" name="pstory" placeholder="${p.jiraProjectKey || 'PROJ'}-123"></label>
            <div class="row"><button class="btn" data-act="preview">Preview import</button></div><div data-import></div>
          </div></div>
          <div class="card"><div class="card-head"><h2>CI pipeline</h2><span class="small muted">.github/workflows/api-tests.yml</span></div><div class="card-body">
            <pre class="code">${`# Credentials come from repository secrets — never committed
- run: node api-tests/scripts/run-suite.js \\
    --project ${p.id} --priority P0,P1 --junit api-tests/reports/junit.xml
  env:
    QA_PLATFORM_URL: \${{ secrets.QA_PLATFORM_URL }}
    SF_${(p.credentialRef || 'PREFIX').toUpperCase()}_CLIENT_ID: \${{ secrets.SF_CLIENT_ID }}
    SF_${(p.credentialRef || 'PREFIX').toUpperCase()}_CLIENT_SECRET: \${{ secrets.SF_CLIENT_SECRET }}`}</pre>
            <h3 class="mt">Framework structure</h3><pre class="code">${TREE}</pre>
          </div></div>
        </div>`);

      const sel = { xp: new Set(), xt: new Set() };
      on(view, 'click', '[data-chip]', (e, el) => { const s = sel[el.dataset.chip]; s.has(el.dataset.value) ? s.delete(el.dataset.value) : s.add(el.dataset.value); el.classList.toggle('on'); el.setAttribute('aria-pressed', s.has(el.dataset.value)); });
      on(view, 'click', '[data-act=col]', (e, el) => withBusy(el, async () => { try { await api.download(`/api/postman/collection${api.qs({ projectId: p.id, priority: [...sel.xp], testType: [...sel.xt] })}`, `${p.id}.postman_collection.json`); toast('Collection downloaded. Fill credentials in your Postman environment, not in the collection.', 'ok'); } catch (err) { toastError(err, 'Export failed'); } }));
      on(view, 'click', '[data-act=env]', (e, el) => withBusy(el, async () => { try { await api.download(`/api/postman/environment?projectId=${p.id}`, `${p.environment.toLowerCase()}.postman_environment.json`); } catch (err) { toastError(err, 'Export failed'); } }));
      on(view, 'click', '[data-act=newman]', (e, el) => withBusy(el, async () => {
        const out = view.querySelector('[data-newman]');
        out.innerHTML = String(h`<p class="small muted">Running Newman… this can take a while for large suites.</p>`);
        try {
          const r = await C.withProductionSafety((conf) => api.post(`/api/postman/newman?projectId=${p.id}`, { filter: { priority: [...sel.xp], testType: [...sel.xt] }, ...conf }));
          if (!r) { out.innerHTML = ''; return; }
          out.innerHTML = String(r.ok || r.stats ? h`<div class="callout ${r.ok ? 'ok' : 'warn'}">${ic(r.ok ? 'check' : 'alert')}<div><b>Newman ${r.ok ? 'passed' : `finished with failures (exit ${r.exitCode})`}</b><div class="small">${r.stats ? `${r.stats.assertions ? `${r.stats.assertions.total} assertions, ${r.stats.assertions.failed} failed` : ''}` : ''} · report <code>${r.report}</code></div>${(r.failures || []).length ? h`<ul class="list small">${r.failures.slice(0, 8).map((f) => h`<li><b>${f.item}</b> — ${f.test}: ${f.message}</li>`)}</ul>` : ''}<div class="small muted">${r.note}</div></div></div>` : errorBox({ message: r.title, info: r }));
        } catch (err) { out.innerHTML = String(errorBox(err)); }
      }));
      let importCol = null;
      on(view, 'change', '[name=pfile]', async (e) => { const f = e.target.files[0]; importCol = f ? await f.text() : null; });
      on(view, 'click', '[data-act=preview]', (e, el) => withBusy(el, async () => {
        const out = view.querySelector('[data-import]');
        if (!importCol) { toast('Choose a Postman collection file first.', 'warn'); return; }
        try {
          const r = await api.post(`/api/postman/import?projectId=${p.id}`, { collection: importCol, preview: true });
          out.innerHTML = String(h`<p class="small"><b>${r.count}</b> requests will become test cases (label ASSUMED, status assertions inferred from pm.test scripts).</p>
            <div class="table-wrap" style="max-height:240px;overflow:auto"><table class="t"><tbody>${r.drafts.slice(0, 50).map((d) => h`<tr><td>${QA.ui.method(d.method)}</td><td class="small">${d.title}<div class="cell-sub mono">${d.endpoint}</div></td><td class="small">${d.testType}</td></tr>`)}</tbody></table></div>
            <div class="row mt"><button class="btn primary" data-act="import">${ic('upload')} Import ${r.count} test cases</button></div>`);
        } catch (err) { out.innerHTML = String(errorBox(err)); }
      }));
      on(view, 'click', '[data-act=import]', (e, el) => withBusy(el, async () => {
        try { const r = await api.post(`/api/postman/import?projectId=${p.id}`, { collection: importCol, storyKey: view.querySelector('[name=pstory]').value.trim() || undefined }); toast(`${r.imported} test cases imported.`, 'ok', 'Import complete'); QA.router.go('/testcases?tag=imported'); } catch (err) { toastError(err, 'Import failed'); }
      }));
      return null;
    },
  };
})();
