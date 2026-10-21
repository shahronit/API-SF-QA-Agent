/* Test cases: filterable list, bulk actions, editor drawer, history and automation preview. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, badge, prov, pri, method, on, errorBox, loading, empty, toast, toastError, withBusy, esc, json, drawer, confirm } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.testcases = {
    render(view, ctx) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Test Cases' }]);
      const m = QA.state.meta;
      view.innerHTML = String(h`${C.pageHead('Tests', `API tests for ${p.name}. Tick rows to run a subset, or open a row to edit it.`,
        h`<button class="btn" data-act="new">${ic('plus')} New test</button><button class="btn primary" data-act="run">${ic('play')} Run selected</button>`)}
        ${C.pageIntro({ what: 'Every generated or hand-written API test for this project. Filters on the toolbar narrow by priority, type and last result.', next: 'Prefer generating from a Jira ticket. To run: tick the rows you want (or none for the dialog defaults) and click Run selected.' })}
        <div class="card" style="margin-bottom:12px" data-bulk hidden><div class="card-body row wrap" style="gap:10px;padding:10px 14px">
          <b data-selcount></b><span class="spacer"></span>
          <button class="btn sm primary" data-bulk-act="run">${ic('play')} Run selected</button>
          <select class="select" data-bulk-act="priority" aria-label="Set priority" style="height:28px"><option value="">Set priority…</option>${m.priorities.map((x) => h`<option>${x}</option>`)}</select>
          <select class="select" data-bulk-act="status" aria-label="Set status" style="height:28px"><option value="">Set status…</option>${['ready', 'draft', 'disabled'].map((x) => h`<option>${x}</option>`)}</select>
          <button class="btn sm danger-outline" data-bulk-act="delete">${ic('trash')} Delete</button></div></div>
        <div data-list></div>`);

      const f = ctx.query;
      const list = C.listController(view.querySelector('[data-list]'), {
        sort: 'seq', dir: 'ASC', selectable: true, q: f.q || '', searchPlaceholder: 'Search id, title, endpoint or story',
        filters: { tag: f.tag || '', priority: f.priority || '', testType: f.testType || '', lastResult: f.lastResult || '', apiType: f.apiType || '', status: f.status || '', label: f.label || '', storyKey: f.storyKey || '', scenarioId: f.scenarioId || '' },
        toolbar: (s) => h`${C.chipGroup('priority', m.priorities, (s.filters.priority || '').split(','))}
          <select class="select" data-filter="testType" aria-label="Test type"><option value="">All types</option>${m.testTypes.map((x) => h`<option ${s.filters.testType === x ? 'selected' : ''}>${x}</option>`)}</select>
          <select class="select" data-filter="lastResult" aria-label="Last result"><option value="">Any result</option>${['passed', 'failed', 'blocked', 'skipped'].map((x) => h`<option ${s.filters.lastResult === x ? 'selected' : ''}>${x}</option>`)}</select>
          <select class="select" data-filter="label" aria-label="Provenance"><option value="">Any provenance</option>${['VERIFIED', 'ASSUMED', 'RECOMMENDED'].map((x) => h`<option ${s.filters.label === x ? 'selected' : ''}>${x}</option>`)}</select>
          <select class="select" data-filter="status" aria-label="Status"><option value="">Any status</option>${['ready', 'draft', 'disabled'].map((x) => h`<option ${s.filters.status === x ? 'selected' : ''}>${x}</option>`)}</select>
          ${s.filters.storyKey ? h`<span class="chip on">Story ${s.filters.storyKey}</span>` : ''}${s.filters.scenarioId ? h`<span class="chip on">Scenario ${s.filters.scenarioId}</span>` : ''}`,
        fetch: (q) => api.get(`/api/testcases${api.qs({ projectId: p.id, ...q })}`),
        rowAttrs: (r) => `data-id="${esc(r.id)}"`,
        onRow: (r) => openEditor(r.id, list),
        onSelect: (s) => { const b = view.querySelector('[data-bulk]'); b.hidden = !s.selected.size; view.querySelector('[data-selcount]').textContent = `${s.selected.size} selected`; },
        emptyState: (s) => (s.q || Object.values(s.filters).some(Boolean) ? empty({ title: 'No test cases match', text: 'Clear the search or filters.' }) : empty({ icon: 'wand', title: 'No test cases yet', text: 'Generate tests from a Jira story or create one manually.', action: h`<a class="btn primary" href="/stories" data-link>${ic('jira')} Generate from a story</a>` })),
        columns: [
          { key: 'id', label: 'Id', sortable: true, render: (r) => h`<span class="mono small">${r.id}</span>` },
          { key: 'title', label: 'Test case', sortable: true, render: (r) => h`<div class="cell-title">${r.title}</div><div class="cell-sub">${C.endpoint(r.method, r.endpoint)}</div>` },
          { key: 'storyKey', label: 'Story', sortable: true, render: (r) => (r.storyKey ? h`<a href="/stories/${r.storyKey}" data-link class="small">${r.storyKey}</a>` : '–') },
          { key: 'testType', label: 'Type', sortable: true, render: (r) => h`<span class="small">${r.testType}</span>` },
          { key: 'priority', label: 'Pri', sortable: true, render: (r) => pri(r.priority) },
          { key: 'label', label: 'Provenance', render: (r) => prov(r.label) },
          { key: 'status', label: 'Status', sortable: true, render: (r) => badge(r.status) },
          { key: 'lastResult', label: 'Last result', sortable: true, render: (r) => (r.lastResult ? h`${badge(r.lastResult)}<div class="cell-sub">${fmt.ago(r.lastRunAt)} · ${fmt.ms(r.lastResponseMs)}</div>` : h`<span class="faint small">Not run</span>`) },
        ],
      });

      on(view, 'click', '[data-act=run]', () => C.runDialog());
      on(view, 'click', '[data-act=new]', () => openEditor(null, list));
      on(view, 'click', '[data-bulk-act=run]', (e, el) => C.startRun({ testCaseIds: [...list.state.selected], label: `${list.state.selected.size} selected tests` }, el));
      on(view, 'change', 'select[data-bulk-act]', async (e, el) => {
        const field = el.dataset.bulkAct; const value = el.value; el.value = '';
        if (!value) return;
        try { const r = await api.post(`/api/testcases/bulk?projectId=${p.id}`, { ids: [...list.state.selected], [field]: value }); toast(`${r.updated} test cases updated.`, 'ok'); list.reload(); } catch (err) { toastError(err); }
      });
      on(view, 'click', '[data-bulk-act=delete]', async () => {
        const n = list.state.selected.size;
        const ok = await confirm({ title: `Delete ${n} test cases?`, message: 'Execution history is kept, but the test cases are removed from future runs.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        try { await api.post(`/api/testcases/bulk?projectId=${p.id}`, { ids: [...list.state.selected], delete: true }); list.state.selected.clear(); view.querySelector('[data-bulk]').hidden = true; toast(`${n} test cases deleted.`, 'warn'); list.reload(); } catch (err) { toastError(err); }
      });
      if (f.id) openEditor(f.id, list);
      return null;
    },
  };

  const J = (v) => (v === undefined || v === null ? '' : JSON.stringify(v, null, 2));
  function parseJson(text, label, fallback) {
    if (!String(text).trim()) return fallback;
    try { return JSON.parse(text); } catch (e) { throw Object.assign(new Error(`${label} is not valid JSON: ${e.message}`), { info: { action: `Fix the JSON in the ${label} field.` } }); }
  }

  async function openEditor(id, list) {
    const p = QA.state.project;
    const m = QA.state.meta;
    const d = drawer({ title: id ? `Test case ${id}` : 'New test case', body: loading(10), foot: h``, width: 900, onClose: () => QA.router.setQuery({ id: '' }) });
    let t;
    try {
      t = id ? await api.get(`/api/testcases/${encodeURIComponent(id)}`) : { method: 'GET', endpoint: '/services/data/v{{apiVersion}}/', apiType: 'REST', auth: 'default', testType: 'Functional', priority: '', status: 'ready', label: 'ASSUMED', headers: {}, query: {}, assertions: [{ type: 'status', op: 'eq', expected: 200 }], extract: [], tags: [], history: [], defects: [] };
    } catch (e) { d.setBody(errorBox(e)); return; }
    if (id) QA.router.setQuery({ id });
    let tab = 'definition';
    const readonly = QA.api.snapshot;
    const TABS = [{ id: 'definition', label: 'Definition' }, { id: 'request', label: 'Request' }, { id: 'assertions', label: 'Assertions', n: (t.assertions || []).length }, { id: 'validation', label: 'Salesforce validation' }, ...(id ? [{ id: 'history', label: 'History', n: t.history.length }, { id: 'automation', label: 'Automation' }] : [])];
    const pr = t.priorityReason;

    d.el.querySelector('#d-title').textContent = id ? `${t.id} · ${t.title}` : 'New test case';
    d.setBody(h`<div data-ttabs>${C.tabs(TABS, tab)}</div>
      <form data-form autocomplete="off">
      <div data-p="definition">
        <div class="form-grid">
          <label class="field full"><span>Title</span><input class="input" name="title" value="${t.title || ''}" required></label>
          <label class="field"><span>Test type</span><select class="select" name="testType">${m.testTypes.map((x) => h`<option ${t.testType === x ? 'selected' : ''}>${x}</option>`)}</select></label>
          <label class="field"><span>Priority</span><select class="select" name="priority">${!id ? h`<option value="">Calculate automatically</option>` : ''}${m.priorities.map((x) => h`<option ${t.priority === x ? 'selected' : ''}>${x}</option>`)}</select></label>
          <label class="field"><span>Status</span><select class="select" name="status">${['ready', 'draft', 'disabled'].map((x) => h`<option ${t.status === x ? 'selected' : ''}>${x}</option>`)}</select></label>
          <label class="field"><span>Provenance</span><select class="select" name="label">${['ASSUMED', 'RECOMMENDED', 'VERIFIED'].map((x) => h`<option ${t.label === x ? 'selected' : ''}>${x}</option>`)}</select><small>VERIFIED requires confirming metadata against a live org.</small></label>
          <label class="field"><span>Story key</span><input class="input mono" name="storyKey" value="${t.storyKey || ''}"></label>
          <label class="field"><span>Salesforce object</span><input class="input mono" name="object" value="${t.object || ''}"></label>
          <label class="field full"><span>Tags (comma separated)</span><input class="input" name="tags" value="${(t.tags || []).join(', ')}"></label>
          <label class="field full"><span>Description</span><textarea class="input" rows="3" name="description">${t.description || ''}</textarea></label>
        </div>
        ${pr && pr.factors ? h`<div class="card mt"><div class="card-head"><h2>Why ${pr.priority}?</h2><span class="small muted">score ${pr.score} of 100</span></div><div class="card-body">${raw(QA.charts.hbars({ items: Object.entries(pr.factors).map(([k, v]) => ({ label: k.replace(/([A-Z])/g, ' $1').toLowerCase(), value: v, max: 3, display: `${v}/3 × weight ${pr.weights[k]}` })) }))}</div></div>` : ''}
        ${t.defects && t.defects.length ? h`<div class="callout error mt">${ic('bug')}<div class="small">Linked defects: ${t.defects.map((x) => h`<a href="${x.url}" target="_blank" rel="noopener">${x.key}</a> (${x.status}) `)}</div></div>` : ''}
      </div>
      <div data-p="request" class="hidden"><div class="form-grid">
        <label class="field"><span>Method</span><select class="select" name="method">${['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'].map((x) => h`<option ${t.method === x ? 'selected' : ''}>${x}</option>`)}</select></label>
        <label class="field"><span>API type</span><select class="select" name="apiType">${m.apiTypes.map((x) => h`<option ${t.apiType === x ? 'selected' : ''}>${x}</option>`)}</select></label>
        <label class="field full"><span>Endpoint</span><input class="input mono" name="endpoint" value="${t.endpoint || ''}" required><small>Use variables such as <code>{{apiVersion}}</code>, <code>{{accountId}}</code>, <code>{{$uuid}}</code>. Never paste tokens.</small></label>
        <label class="field"><span>Authentication</span><select class="select" name="auth">${[['default', 'Project integration user'], ['lowpriv', 'Low-privilege user'], ['none', 'No token (negative)'], ['invalid', 'Invalid token (negative)']].map(([v, l]) => h`<option value="${v}" ${t.auth === v ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label class="field"><span>Timeout (ms)</span><input class="input" type="number" min="100" name="timeoutMs" value="${t.timeoutMs || ''}" placeholder="30000"></label>
        <label class="field"><span>Headers (JSON)</span><textarea class="input mono" rows="5" name="headers" spellcheck="false">${J(t.headers || {})}</textarea><small>Authorization is injected from the secret store and is rejected here.</small></label>
        <label class="field"><span>Query parameters (JSON)</span><textarea class="input mono" rows="5" name="query" spellcheck="false">${J(t.query || {})}</textarea></label>
        <label class="field full"><span>Body (JSON)</span><textarea class="input mono" rows="10" name="body" spellcheck="false">${J(t.body)}</textarea></label>
        ${t.bodyRaw ? h`<label class="field full"><span>Raw body (XML/CSV)</span><textarea class="input mono" rows="8" name="bodyRaw" spellcheck="false">${t.bodyRaw}</textarea></label>` : ''}
        <label class="field full"><span>Extract variables (JSON)</span><textarea class="input mono" rows="3" name="extract" spellcheck="false">${J(t.extract || [])}</textarea><small>e.g. <code>[{"var":"accountId","path":"$.id"}]</code></small></label>
      </div></div>
      <div data-p="assertions" class="hidden"><label class="field"><span>Assertions (JSON array)</span><textarea class="input mono" rows="18" name="assertions" spellcheck="false">${J(t.assertions || [])}</textarea>
        <small>Types: status, jsonpath, header, responseTime, sfError, schema, bodyContains. Operators: eq, neq, in, exists, notExists, contains, notContains, matches, type, lt, lte, gt, gte.</small></label></div>
      <div data-p="validation" class="hidden"><label class="field"><span>Salesforce data validation (JSON)</span><textarea class="input mono" rows="12" name="sfValidation" spellcheck="false">${J(t.sfValidation)}</textarea>
        <small>Compares the API request with the persisted record, e.g. <code>{"object":"Account","idVar":"accountId","expected":{"Rating":"{{req.Rating}}"}}</code>. Leave empty to skip.</small></label>
        <label class="field mt"><span>Cleanup (JSON)</span><textarea class="input mono" rows="3" name="cleanup" spellcheck="false">${J(t.cleanup)}</textarea><small>Records created by this test are deleted after the run (never in Production).</small></label></div>
      </form>
      <div data-p="history" class="hidden">${id ? QA.ui.table({ rows: t.history, rowAttrs: (r) => `data-res="${esc(r.id)}"`, emptyState: empty({ icon: 'clock', title: 'Never executed' }), columns: [
        { key: 'startedAt', label: 'When', render: (r) => fmt.date(r.startedAt) }, { key: 'runId', label: 'Execution', render: (r) => h`<a href="/execution/${r.runId}" data-link class="mono small">${r.runId}</a>` },
        { key: 'status', label: 'Result', render: (r) => badge(r.status) }, { key: 'statusCode', label: 'HTTP', render: (r) => C.statusCode(r.statusCode) }, { key: 'responseMs', label: 'Time', cls: 'num', render: (r) => fmt.ms(r.responseMs) }, { key: 'defectKey', label: 'Defect' },
      ] }) : ''}</div>
      <div data-p="automation" class="hidden" data-auto><p class="small muted">Generates a Postman item for this test with pre-request OAuth from environment variables (no hardcoded secrets) and a Newman command.</p><button class="btn" data-act="automate">${ic('code')} Generate automation</button></div>`);
    d.setFoot(h`${id ? h`<button class="btn danger-outline" data-act="delete">${ic('trash')} Delete</button><button class="btn" data-act="dup">${ic('copy')} Duplicate</button>` : ''}<span class="spacer"></span>${id ? h`<button class="btn" data-act="runone">${ic('play')} Run</button>` : ''}<button class="btn primary" data-act="save" ${readonly ? 'disabled' : ''}>${id ? 'Save changes' : 'Create test case'}</button>`);

    const showTab = (x) => { tab = x; d.el.querySelector('[data-ttabs]').innerHTML = String(C.tabs(TABS, tab)); d.el.querySelectorAll('[data-p]').forEach((pn) => pn.classList.toggle('hidden', pn.dataset.p !== tab)); };
    on(d.el, 'click', '[data-tab]', (e, el) => showTab(el.dataset.tab));
    on(d.el, 'click', 'tr[data-res]', (e, el) => { if (!e.target.closest('a')) C.openResult(el.dataset.res); });
    const form = d.el.querySelector('[data-form]');
    const collect = () => {
      const v = (n) => (form.elements[n] ? form.elements[n].value : undefined);
      const b = {
        title: v('title').trim(), testType: v('testType'), status: v('status'), label: v('label'), storyKey: v('storyKey').trim() || null, object: v('object').trim() || null,
        tags: v('tags').split(',').map((x) => x.trim()).filter(Boolean), description: v('description') || null,
        method: v('method'), apiType: v('apiType'), endpoint: v('endpoint').trim(), auth: v('auth'), timeoutMs: v('timeoutMs') ? Number(v('timeoutMs')) : null,
        headers: parseJson(v('headers'), 'Headers', {}), query: parseJson(v('query'), 'Query parameters', {}), body: parseJson(v('body'), 'Body', null),
        extract: parseJson(v('extract'), 'Extract variables', []), assertions: parseJson(v('assertions'), 'Assertions', []),
        sfValidation: parseJson(v('sfValidation'), 'Salesforce validation', null), cleanup: parseJson(v('cleanup'), 'Cleanup', null),
      };
      if (form.elements.bodyRaw) b.bodyRaw = v('bodyRaw');
      if (v('priority')) b.priority = v('priority');
      if (!b.title) throw Object.assign(new Error('Title is required.'), { info: {} });
      return b;
    };
    on(d.el, 'click', '[data-act=save]', (e, el) => withBusy(el, async () => {
      let b;
      try { b = collect(); } catch (err) { toastError(err, 'Cannot save'); return; }
      try {
        if (b.label === 'VERIFIED' && t.label !== 'VERIFIED') {
          const ok = await confirm({ title: 'Mark as VERIFIED?', message: 'Only mark a test VERIFIED after its objects, fields and endpoint have been confirmed against a live Salesforce org (not demo or assumed metadata).', confirmLabel: 'I confirmed it against a live org' });
          if (!ok) return;
          b.confirmVerified = true;
        }
        const saved = id ? await api.put(`/api/testcases/${id}`, b) : await api.post(`/api/testcases?projectId=${p.id}`, b);
        toast(`${saved.id} ${id ? 'saved' : 'created'}.`, 'ok');
        d.close(); list.reload();
      } catch (err) { toastError(err, 'Not saved'); }
    }));
    on(d.el, 'click', '[data-act=dup]', (e, el) => withBusy(el, async () => { try { const c = await api.post(`/api/testcases/${id}/duplicate`); toast(`Duplicated as ${c.id}.`, 'ok'); d.close(); list.reload(); openEditor(c.id, list); } catch (err) { toastError(err); } }));
    on(d.el, 'click', '[data-act=delete]', async () => {
      const ok = await confirm({ title: `Delete ${id}?`, message: 'Execution history is kept for traceability.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try { await api.del(`/api/testcases/${id}`); toast(`${id} deleted.`, 'warn'); d.close(); list.reload(); } catch (err) { toastError(err); }
    });
    on(d.el, 'click', '[data-act=runone]', (e, el) => C.startRun({ testCaseIds: [id], label: `Single test ${id}` }, el));
    on(d.el, 'click', '[data-act=automate]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/testcases/${id}/automate`);
        d.el.querySelector('[data-auto]').innerHTML = String(h`<h3>Newman</h3><pre class="code">${r.newman}</pre><h3 class="mt">Node runner</h3><pre class="code">${r.node}</pre><h3 class="mt">Postman collection item</h3>${json(r.collection)}`);
      } catch (err) { toastError(err); }
    }));
  }
})();
