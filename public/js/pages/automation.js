/* Automation: Postman export/import, Newman runs, CI pipeline and framework structure. */
(() => {
  const QA = window.QA;
  const { h, ic, on, errorBox, empty, toast, toastError, withBusy } = QA.ui;
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

  async function applyImport(r) {
    await QA.state.reloadProjects();
    if (r.project && r.project.id) QA.state.setProject(r.project.id);
    if (r.href) {
      toast(r.notice || 'Imported. Set the frontend HTTP base URL and token to run these tests.', 'warn', 'HTTP details needed');
      QA.router.go(r.href);
      return;
    }
    toast(r.notice || `Imported ${r.imported} requests.`, 'ok', r.created ? 'Project created' : 'Collection imported');
    QA.router.go('/testcases?tag=imported');
  }

  function importCard(p) {
    return h`<div class="card"><div class="card-head"><h2>Import a Postman collection</h2><span class="small muted">v1, v2 or v2.1</span></div><div class="card-body stack">
      <p class="small muted" style="margin:0">Drop any Postman export. The platform detects the Salesforce org / project (name, host, API version, organization_id). If none match, it creates a project with those details and attaches the collection.</p>
      <label class="field"><span>Collection file</span><input class="input" type="file" name="pfile" accept=".json,application/json"></label>
      <label class="field"><span>Environment file (optional)</span><input class="input" type="file" name="penv" accept=".json,application/json"></label>
      ${p ? h`<label class="field"><span>Link to story (optional)</span><input class="input mono" name="pstory" placeholder="${p.jiraProjectKey || 'PROJ'}-123"></label>` : ''}
      <div class="row"><button class="btn primary" data-act="preview">${ic('search')} Detect project</button></div>
      <div data-import></div>
    </div></div>`;
  }

  QA.pages.automation = {
    render(view) {
      const p = QA.state.project;
      QA.router.setCrumbs([{ label: 'HTTP / Postman' }]);
      const m = QA.state.meta;
      view.innerHTML = String(h`${C.pageHead('HTTP / Postman', h`${C.layerTag('frontend')} Import an existing collection (any version). A matching project is reused, or a new one is created.`)}
        ${C.pageIntro({ what: 'Import is the simple path: one file, auto-detect the Salesforce project, reuse or create, then run. Secrets stay out of the file.', next: 'Choose a collection JSON (v1 / v2 / v2.1). Detect project, then Import. Export and Newman below are optional.' })}
        <div class="grid g-2">
          ${importCard(p)}
          ${p ? h`<div class="card"><div class="card-head"><h2>Export Postman collection</h2><span class="small muted">Collection v2.1</span></div><div class="card-body stack">
            <div class="field"><span>Priority</span>${C.chipGroup('xp', m.priorities, [])}</div>
            <div class="field"><span>Test type</span>${C.chipGroup('xt', m.testTypes, [])}</div>
            <div class="callout info">${ic('lock')}<div class="small">Requests use <code>{{baseUrl}}</code> and <code>{{accessToken}}</code>. No secrets are written to the file. <code>{{organization_id}}</code> is filled from the connected org or Test data.</div></div>
            <div class="row"><button class="btn primary" data-act="col">${ic('download')} Download collection</button><button class="btn" data-act="env">${ic('download')} Download ${p.environment} environment</button></div>
          </div></div>` : h`<div class="card"><div class="card-body">${empty({ title: 'No project selected yet', text: 'Import a collection and we will pick or create the project. Or create a project first.', action: h`<a class="btn" href="/projects/new" data-link data-act="new">${ic('plus')} New project</a>` })}</div></div>`}
        </div>
        ${p ? h`<div class="grid g-2 mt">
          <div class="card"><div class="card-head"><h2>Run with Newman</h2><span class="small muted">server-side, in api-tests/</span></div><div class="card-body stack">
            <p class="small muted" style="margin:0">Writes the collection to <code>api-tests/collections/${p.id}.postman_collection.json</code> and runs <code>npx newman</code>.</p>
            <div class="row"><button class="btn primary" data-act="newman">${ic('play')} Run Newman</button></div><div data-newman></div>
          </div></div>
          <div class="card"><div class="card-head"><h2>CI pipeline</h2><span class="small muted">.github/workflows/api-tests.yml</span></div><div class="card-body">
            <pre class="code">${`# Credentials come from repository secrets — never committed
- run: node api-tests/scripts/run-suite.js \\
    --project ${p.id} --priority P0,P1 --junit api-tests/reports/junit.xml`}</pre>
            <h3 class="mt">Framework structure</h3><pre class="code">${TREE}</pre>
          </div></div>
        </div>` : ''}`);

      const sel = { xp: new Set(), xt: new Set() };
      on(view, 'click', '[data-chip]', (e, el) => { const s = sel[el.dataset.chip]; s.has(el.dataset.value) ? s.delete(el.dataset.value) : s.add(el.dataset.value); el.classList.toggle('on'); el.setAttribute('aria-pressed', s.has(el.dataset.value)); });
      if (p) {
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
      }
      let importCol = null;
      let importEnv = null;
      on(view, 'change', '[name=pfile]', async (e) => { const f = e.target.files[0]; importCol = f ? await f.text() : null; });
      on(view, 'change', '[name=penv]', async (e) => { const f = e.target.files[0]; importEnv = f ? await f.text() : null; });
      on(view, 'click', '[data-act=preview]', (e, el) => withBusy(el, async () => {
        const out = view.querySelector('[data-import]');
        if (!importCol) { toast('Choose a Postman collection file first.', 'warn'); return; }
        try {
          const r = await api.post('/api/postman/import', { collection: importCol, environment: importEnv || undefined, preview: true, auto: true });
          const hnt = r.hints || {};
          out.innerHTML = String(h`
            <div class="callout ${r.action === 'reuse' ? 'success' : 'info'}">${ic(r.action === 'reuse' ? 'check' : 'plus')}<div class="small wrap">
              <b>${r.action === 'reuse' ? `Will use existing project “${r.match.name}”` : `Will create project “${hnt.name}”`}</b>
              <div>${hnt.kind === 'core' ? 'Salesforce Core' : hnt.kind === 'sfcc' ? 'B2C / SFCC' : 'HTTP / frontend'} · ${hnt.environment || ''} · API ${hnt.apiVersion || ''}${hnt.instanceUrl ? ` · ${hnt.instanceUrl}` : ''}${hnt.httpBaseUrl ? ` · HTTP ${hnt.httpBaseUrl}` : ''}${hnt.needsBearer ? ' · Bearer token required' : ''}${hnt.sfOrg ? ` · org ${hnt.sfOrg}` : ''}${hnt.orgId ? ` · organization_id ${hnt.orgId}` : ''}</div>
            </div></div>
            <p class="small"><b>${r.count}</b> requests will become tests.</p>
            <div class="table-wrap" style="max-height:240px;overflow:auto"><table class="t"><tbody>${r.drafts.slice(0, 50).map((d) => h`<tr><td>${QA.ui.method(d.method)}</td><td class="small">${d.title}<div class="cell-sub mono">${d.endpoint}</div></td><td class="small">${d.testType}</td></tr>`)}</tbody></table></div>
            <div class="row mt"><button class="btn primary" data-act="import">${ic('upload')} ${r.action === 'reuse' ? 'Import into this project' : 'Create project and import'}</button></div>`);
        } catch (err) { out.innerHTML = String(errorBox(err)); }
      }));
      on(view, 'click', '[data-act=import]', (e, el) => withBusy(el, async () => {
        try {
          const story = view.querySelector('[name=pstory]');
          const r = await api.post('/api/postman/import', {
            collection: importCol, environment: importEnv || undefined, auto: true,
            storyKey: story && story.value.trim() ? story.value.trim() : undefined,
          });
          await applyImport(r);
        } catch (err) { toastError(err, 'Import failed'); }
      }));
      return null;
    },
  };
})();
