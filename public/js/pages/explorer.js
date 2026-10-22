/* API explorer: request builder for every Salesforce API, object discovery, SOQL, save/convert to test. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, badge, prov, method, on, errorBox, loading, empty, toast, toastError, withBusy, modal, debounce } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  const J = (v) => (v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

  QA.pages.explorer = {
    async render(view, ctx) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'API explorer' }]);
      const HC = QA.httpClient;
      const state = { layer: ctx.query.layer === 'frontend' ? 'frontend' : 'backend', side: ctx.query.object ? 'objects' : 'templates', req: { method: 'GET', path: '/services/data/v{{apiVersion}}/limits', auth: 'default', headers: '', query: '', body: '', variables: '', apiType: 'REST', bodyMode: 'json' }, last: null, object: ctx.query.object || null };

      view.innerHTML = String(h`${C.pageHead('Try an API', h`${C.layerTag(state.layer)} ${p.name} (${p.environment}). Salesforce session tokens stay on the server. Generic HTTP requests can use Bearer, Basic, API key or OAuth 2.0.`, h`<a class="btn" href="/workflow/postman" data-link>${ic('folder')} Open collection</a>`)}
        ${C.pageIntro({ what: 'Backend APIs are Salesforce org REST, Apex REST, Bulk and Composite. Frontend / HTTP is a Postman-style client: full URLs, auth helpers, cookies, scripts, environments, WebSocket, gRPC and local mocks.', next: state.layer === 'frontend' ? 'Paste an https URL (or import cURL), pick an environment, and Send. Collections, history, cookies and mocks are in the left sidebar.' : 'Pick a Salesforce template or object on the left, click Send, then Save as test if the call is useful. Production writes ask you to confirm.' })}
        ${C.connectionNotice(p)}
        <div class="mt" style="margin-bottom:var(--space-4)">${C.tabs([{ id: 'backend', label: 'Backend · Salesforce' }, { id: 'frontend', label: 'Frontend · HTTP / Postman' }], state.layer, 'data-layer')}</div>
        <div data-layer-pane="frontend" class="${state.layer === 'frontend' ? '' : 'hidden'}"><div data-fe>${loading(6)}</div></div>
        <div data-layer-pane="backend" class="${state.layer === 'backend' ? '' : 'hidden'}">
        <div class="split">
          <aside class="card" style="align-self:start;position:sticky;top:72px;max-height:calc(100vh - 96px);overflow:auto">
            <div class="toolbar" style="padding:8px">${C.tabs([{ id: 'templates', label: 'Templates' }, { id: 'saved', label: 'Saved' }, { id: 'objects', label: 'Objects' }], state.side, 'data-side')}</div>
            <div data-side-body>${loading(8)}</div>
          </aside>
          <div class="stack" style="min-width:0">
            <div class="card"><div class="card-body" data-sf-builder></div>
              <div class="card-body" style="padding-top:0">
                <label class="field"><span>Variables (JSON, merged with the active environment)</span><textarea class="input mono" name="variables" rows="3" placeholder='{ "accountId": "001..." }'></textarea></label>
                <div class="row mt" style="gap:8px"><span class="small muted" data-reqhint></span><span class="spacer"></span><button class="btn sm" data-act="save">${ic('plus')} Save request</button><button class="btn sm" data-act="save-ep">${ic('code')} Save as endpoint</button><button class="btn sm" data-act="totest" disabled>${ic('wand')} Create test case from response</button></div>
              </div>
            </div>
            <div class="card" data-response>${empty({ icon: 'send', title: 'No request sent yet', text: 'Choose a template or object on the left, or type an endpoint, then click Send.' })}</div>
          </div>
        </div>
        </div>`);

      const backendRoot = view.querySelector('[data-layer-pane="backend"]');
      const sfBuilder = view.querySelector('[data-sf-builder]');
      sfBuilder.innerHTML = String(HC.builderHtml(state.req, { sf: true }));
      const f = (n) => view.querySelector(`[name=${n}]`);
      const setReq = (r) => {
        Object.assign(state.req, r);
        const q = r.query && typeof r.query === 'object' && !Array.isArray(r.query) ? r.query : undefined;
        const hd = r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers) ? r.headers : undefined;
        HC.apply(sfBuilder, {
          ...state.req,
          body: typeof state.req.body === 'string' ? state.req.body : J(state.req.body),
          queryRows: q ? HC.objRows(q) : state.req.queryRows,
          headerRows: hd ? HC.objRows(hd) : state.req.headerRows,
          bodyMode: state.req.bodyMode || (state.req.apiType === 'SOAP' ? 'xml' : (state.req.apiType === 'GraphQL' ? 'graphql' : 'json')),
        });
        if (f('variables') && state.req.variables !== undefined) f('variables').value = J(state.req.variables);
        view.querySelector('[data-reqhint]').textContent = state.req.note || (state.req.apiType ? `Backend API · ${state.req.apiType}` : 'Backend API · Salesforce');
      };
      HC.bindBuilder(sfBuilder, {
        onSend: async (el) => {
          let b;
          try { b = await collect(); } catch (err) { toastError(err, 'Request not sent'); return; }
          const box = backendRoot.querySelector('[data-response]');
          try {
            const r = await C.withProductionSafety((conf) => api.post(`/api/explorer/execute?projectId=${p.id}`, { ...b, ...conf }));
            if (!r) return;
            state.last = { req: b, res: r };
            backendRoot.querySelector('[data-act=totest]').disabled = false;
            drawResponse(box, r);
          } catch (err) { box.innerHTML = String(h`<div class="card-body">${errorBox(err)}</div>`); }
        },
      });
      setReq(state.req);
      on(view, 'click', '[data-layer]', (e, el) => {
        state.layer = el.dataset.layer;
        QA.router.setQuery({ layer: state.layer === 'backend' ? '' : 'frontend', object: state.layer === 'backend' ? (state.object || '') : '' });
        view.querySelectorAll('[data-layer]').forEach((b) => { b.classList.toggle('on', b === el); b.setAttribute('aria-selected', b === el); });
        view.querySelectorAll('[data-layer-pane]').forEach((pane) => pane.classList.toggle('hidden', pane.dataset.layerPane !== state.layer));
        if (state.layer === 'frontend') drawFrontend();
      });
      async function drawFrontend() {
        const box = view.querySelector('[data-fe]');
        if (!box) return;
        box.innerHTML = '';
        HC.mountFrontend(box, p, ctx);
      }
      if (state.layer === 'frontend') drawFrontend();

      // Sidebar
      const sideBody = backendRoot.querySelector('[data-side-body]');
      let templates = []; let saved = []; let objects = null;
      async function drawSide() {
        backendRoot.querySelector('[data-side]') && (backendRoot.querySelector('aside .toolbar').innerHTML = String(C.tabs([{ id: 'templates', label: 'Templates' }, { id: 'saved', label: 'Saved' }, { id: 'objects', label: 'Objects' }], state.side, 'data-side')));
        try {
          if (state.side === 'templates') {
            if (!templates.length) templates = await api.get(`/api/explorer/templates?projectId=${encodeURIComponent(p.id)}`, { cacheMs: 30000 });
            const groups = templates.reduce((m, t, i) => { (m[t.group] = m[t.group] || []).push({ ...t, i }); return m; }, {});
            sideBody.innerHTML = String(h`<div class="side-list">${Object.entries(groups).map(([g, items]) => h`<div class="side-group">${g}</div>${items.map((t) => h`<button class="item" data-tpl="${t.i}" title="${t.name}">${method(t.method)}<span class="truncate">${t.name}</span></button>`)}`)}</div>`);
          } else if (state.side === 'saved') {
            saved = await api.get(`/api/requests?projectId=${p.id}`);
            const groups = saved.reduce((m, t) => { (m[t.collection || 'Default'] = m[t.collection || 'Default'] || []).push(t); return m; }, {});
            sideBody.innerHTML = String(saved.length ? h`<div class="side-list">${Object.entries(groups).map(([g, items]) => h`<div class="side-group">${g}</div>${items.map((t) => h`<div class="item" style="display:flex;gap:6px;align-items:center"><button class="btn ghost xs" style="flex:1;justify-content:flex-start;min-width:0" data-saved="${t.id}" title="${t.name}">${method(t.method)}<span class="truncate">${t.name}</span></button><button class="btn ghost xs" data-delsaved="${t.id}" aria-label="Delete ${t.name}">${ic('x')}</button></div>`)}`)}</div>` : empty({ icon: 'inbox', title: 'No saved requests', text: 'Use "Save request" to keep requests for reuse.' }));
          } else {
            if (!objects) objects = await api.get(`/api/projects/${p.id}/sobjects`, { cacheMs: 300000 });
            sideBody.innerHTML = String(h`<div style="padding:8px"><input class="input search" type="search" placeholder="Filter objects" data-objq aria-label="Filter objects"><div class="small muted mt-s">${prov(objects.label)} ${objects.source}</div></div><div class="side-list" data-objlist>${raw(objList(''))}</div>`);
          }
        } catch (e) { sideBody.innerHTML = String(h`<div class="card-body">${errorBox(e, { compact: true })}</div>`); }
      }
      const objList = (q) => String(h`${objects.objects.filter((o) => !q || `${o.name} ${o.label}`.toLowerCase().includes(q.toLowerCase())).map((o) => h`<button class="item ${state.object === o.name ? 'on' : ''}" data-obj="${o.name}" title="${o.label} (${o.name})"><span class="truncate">${o.label}</span><span class="faint small mono" style="margin-left:auto">${o.name}</span></button>`)}`);
      on(view, 'click', '[data-side]', (e, el) => { state.side = el.dataset.side; drawSide(); });
      on(sideBody, 'input', '[data-objq]', debounce((e) => { sideBody.querySelector('[data-objlist]').innerHTML = objList(e.target.value); }, 150));
      on(sideBody, 'click', '[data-tpl]', (e, el) => {
        const t = templates[Number(el.dataset.tpl)];
        const gql = /graphql/i.test(`${t.group || ''} ${t.apiType || ''}`) || (t.body && typeof t.body === 'object' && t.body.query);
        setReq({
          method: t.method, path: t.path, body: gql ? '' : (t.body || ''), query: t.query || '', headers: t.headers || '',
          apiType: t.apiType || t.group, note: t.note || `${t.group} · ${t.name}`, auth: 'default',
          bodyMode: gql ? 'graphql' : (/soap/i.test(`${t.group || ''} ${t.apiType || ''}`) ? 'xml' : (t.body ? 'json' : 'none')),
          graphql: gql ? (typeof t.body === 'object' ? t.body : { query: t.body || '' }) : undefined,
        });
      });
      on(sideBody, 'click', '[data-saved]', (e, el) => { const t = saved.find((x) => x.id === el.dataset.saved); setReq({ method: t.method, path: t.path, body: t.body || '', query: t.query || '', headers: t.headers || '', auth: t.auth, apiType: t.apiType, note: `Saved: ${t.name}`, ...(t.extra || {}) }); });
      on(sideBody, 'click', '[data-delsaved]', async (e, el) => { try { await api.del(`/api/requests/${el.dataset.delsaved}`); toast('Saved request deleted.', 'warn'); drawSide(); } catch (err) { toastError(err); } });
      on(sideBody, 'click', '[data-obj]', (e, el) => { state.object = el.dataset.obj; QA.router.setQuery({ object: state.object }); sideBody.querySelectorAll('[data-obj]').forEach((b) => b.classList.toggle('on', b === el)); describeObject(state.object); });
      drawSide();

      // Object describe panel (replaces response area)
      async function describeObject(name) {
        const box = backendRoot.querySelector('[data-response]');
        box.innerHTML = String(loading(8));
        try {
          const d = await api.get(`/api/projects/${p.id}/sobjects/${encodeURIComponent(name)}`, { cacheMs: 300000 });
          const v = `/services/data/v{{apiVersion}}`;
          box.innerHTML = String(h`<div class="card-head"><h2>${d.label} <span class="sub mono">${d.name}</span></h2><div class="row">${prov(d.label === 'VERIFIED' || d.label === 'ASSUMED' ? d.label : objects && objects.label)}<span class="small muted">key prefix ${d.keyPrefix || '–'}</span></div></div>
            <div class="card-body"><div class="row wrap" style="gap:8px">
              <button class="btn sm" data-quick="describe">${method('GET')} Describe</button>
              <button class="btn sm" data-quick="query">${method('GET')} Query 5 records</button>
              ${d.createable ? h`<button class="btn sm" data-quick="create">${method('POST')} Create (required fields)</button>` : ''}
              <span class="spacer"></span><span class="small muted">${[d.createable && 'create', d.updateable && 'update', d.deletable && 'delete', d.queryable && 'query'].filter(Boolean).join(' · ')}</span></div>
              ${objects && objects.label === 'ASSUMED' ? h`<div class="callout warn mt">${ic('alert')}<div class="small">This describe comes from the demo simulator. Field names and rules are ASSUMED, not verified facts about your org.</div></div>` : ''}</div>
            ${QA.ui.table({ rows: d.fields, columns: [
              { key: 'name', label: 'Field', render: (x) => h`<div class="mono small">${x.name}</div><div class="cell-sub">${x.label}</div>` },
              { key: 'type', label: 'Type', render: (x) => h`<span class="small">${x.type}${x.length ? `(${x.length})` : x.precision ? `(${x.precision},${x.scale})` : ''}</span>${x.referenceTo && x.referenceTo.length ? h`<div class="cell-sub">→ ${x.referenceTo.join(', ')}</div>` : ''}` },
              { key: 'flags', label: 'Properties', render: (x) => h`${x.required ? h`<span class="tag" style="color:var(--error-text)">required</span>` : ''}${x.unique ? h`<span class="tag">unique</span>` : ''}${x.externalId ? h`<span class="tag">external id</span>` : ''}${!x.createable && !x.updateable ? h`<span class="tag">read-only</span>` : ''}${x.calculated ? h`<span class="tag">formula</span>` : ''}${x.pii ? h`<span class="tag">PII</span>` : ''}` },
              { key: 'picklist', label: 'Picklist values', render: (x) => h`<span class="small muted">${(x.picklistValues || []).map((pv) => pv.value || pv).slice(0, 6).join(', ')}${(x.picklistValues || []).length > 6 ? '…' : ''}</span>` },
            ] })}`);
          state.describe = d;
          if (box.__quickBound) return;
          box.__quickBound = true;
          on(box, 'click', '[data-quick]', (e, el) => {
            const d = state.describe; const v = '/services/data/v{{apiVersion}}';
            const k = el.dataset.quick;
            if (k === 'describe') setReq({ method: 'GET', path: `${v}/sobjects/${d.name}/describe`, body: '', query: '', note: `Describe ${d.name}` });
            if (k === 'query') setReq({ method: 'GET', path: `${v}/query`, query: { q: `SELECT ${['Id', ...d.fields.filter((x) => x.name !== 'Id' && ['string', 'picklist', 'email', 'phone', 'currency', 'double', 'date'].includes(x.type)).slice(0, 4).map((x) => x.name)].join(', ')} FROM ${d.name} ORDER BY CreatedDate DESC LIMIT 5` }, body: '', note: `SOQL on ${d.name}` });
            if (k === 'create') {
              const body = {};
              d.fields.filter((x) => x.required && x.createable && x.type !== 'reference').forEach((x) => { body[x.name] = x.type === 'picklist' && x.picklistValues[0] ? (x.picklistValues[0].value || x.picklistValues[0]) : x.type === 'email' ? '{{$randomEmail}}' : x.type === 'double' || x.type === 'currency' ? 1 : x.type === 'date' ? '{{$today}}' : `QA ${x.label} {{$timestamp}}`; });
              setReq({ method: 'POST', path: `${v}/sobjects/${d.name}`, body, query: '', note: `Create ${d.name} with required fields (${Object.keys(body).join(', ') || 'none detected'})` });
            }
          });
        } catch (e) { box.innerHTML = String(h`<div class="card-body">${errorBox(e)}</div>`); }
      }
      if (state.object) describeObject(state.object);

      // Prefill from a result or saved request id
      if (ctx.query.fromResult) {
        try {
          const r = await api.get(`/api/results/${encodeURIComponent(ctx.query.fromResult)}`);
          const u = new URL(r.request.url);
          const path = u.pathname.replace(`/v${p.apiVersion}/`, '/v{{apiVersion}}/');
          const q = Object.fromEntries(u.searchParams);
          const hd = { ...(r.request.headers || {}) }; delete hd.Authorization; delete hd.authorization;
          setReq({ method: r.request.method, path, query: Object.keys(q).length ? q : r.request.query, headers: hd, body: r.request.body, auth: r.request.auth || 'default', note: `Loaded from result ${r.id}` });
        } catch (e) { toastError(e, 'Could not load result'); }
      }

      const collect = async () => {
        const b = await HC.collect(sfBuilder);
        b.apiType = state.req.apiType || (/^https?:\/\//i.test(b.path) ? 'HTTP' : 'REST');
        if (f('variables') && f('variables').value.trim()) {
          try { b.variables = JSON.parse(f('variables').value); } catch (e) { throw Object.assign(new Error(`Variables must be valid JSON: ${e.message}`), { info: { action: 'Fix the Variables JSON.' } }); }
        }
        if (b.bodyMode === 'graphql' && b.graphql && b.graphql.query && !b.graphql.query.includes('{')) {
          /* keep as typed */
        }
        return b;
      };

      view.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && state.layer === 'backend') sfBuilder.querySelector('[data-act=send]').click(); });

      on(view, 'click', '[data-act=save-ep]', (e, el) => withBusy(el, async () => {
        if (state.layer !== 'backend') return;
        let b;
        try { b = await collect(); } catch (err) { toastError(err); return; }
        try {
          const r = await api.post(`/api/projects/${p.id}/endpoints`, { method: b.method, path: b.path, body: b.body });
          if (r.added === 0) toast('That path is already an endpoint (or it is a standard REST / Experience / SFCC path, which is not stored here).', 'warn');
          else toast('Saved as a project endpoint. Generate tests will pick it up when the story matches.', 'ok');
          templates = [];
        } catch (err) { toastError(err, 'Not saved as endpoint'); }
      }));
      on(view, 'click', '[data-act=save]', async () => {
        if (state.layer !== 'backend') return;
        let b;
        try { b = await collect(); } catch (err) { toastError(err); return; }
        modal({
          title: 'Save request', body: h`<div class="form-grid"><label class="field"><span>Name</span><input class="input" name="sname" value="${b.method} ${fmt.shortPath(b.path)}"></label><label class="field"><span>Collection</span><input class="input" name="scoll" value="Default"></label></div>`,
          foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Save</button>`,
          onMount(el, close) {
            el.querySelector('[data-go]').addEventListener('click', async () => {
              let body = b.body; try { body = typeof b.body === 'string' && b.body.trim() ? JSON.parse(b.body) : b.body; } catch { /* keep raw */ }
              try { await api.post(`/api/requests?projectId=${p.id}`, { name: el.querySelector('[name=sname]').value, collection: el.querySelector('[name=scoll]').value, method: b.method, path: b.path, headers: b.headers, query: b.query, body, auth: b.auth, apiType: b.apiType, extra: { bodyMode: b.bodyMode, authConfig: b.authConfig, preRequest: b.preRequest, tests: b.tests, queryRows: b.queryRows, headerRows: b.headerRows, form: b.form, graphql: b.graphql } }); close(); toast('Request saved.', 'ok'); if (state.side === 'saved') drawSide(); } catch (err) { toastError(err); }
            });
          },
        });
      });

      on(view, 'click', '[data-act=totest]', (e, el) => withBusy(el, async () => {
        if (state.layer !== 'backend') return;
        if (!state.last) return;
        try {
          const draft = await api.post(`/api/explorer/generate-test?projectId=${p.id}`, { ...state.last.req, response: state.last.res.response });
          modal({
            title: 'Create test case', subtitle: 'Review the generated assertions. The test is saved as ASSUMED until verified against a live org.', size: 'wide',
            body: h`<div class="form-grid"><label class="field full"><span>Title</span><input class="input" name="title" value="${draft.title}"></label><label class="field"><span>Test type</span><input class="input" value="${draft.testType}" disabled></label><label class="field"><span>Priority</span><input class="input" value="${draft.priority}" disabled></label><label class="field full"><span>Story key (optional)</span><input class="input mono" name="storyKey"></label><label class="field full"><span>Assertions</span><textarea class="input mono" rows="10" name="assertions">${JSON.stringify(draft.assertions, null, 2)}</textarea></label></div>`,
            foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Create test case</button>`,
            onMount(m, close) {
              m.querySelector('[data-go]').addEventListener('click', async (ev) => withBusy(ev.currentTarget, async () => {
                try {
                  const t = await api.post(`/api/testcases?projectId=${p.id}`, { ...draft, title: m.querySelector('[name=title]').value, storyKey: m.querySelector('[name=storyKey]').value.trim() || null, assertions: JSON.parse(m.querySelector('[name=assertions]').value) });
                  close(); toast(h`${t.id} created. <a href="/testcases?id=${t.id}" data-link>Open</a>`, 'ok', 'Test case created');
                } catch (err) { toastError(err, 'Not created'); }
              }));
            },
          });
        } catch (err) { toastError(err); }
      }));
      return null;
    },
  };

  function drawResponse(box, r) {
    const res = r.response;
    const x = r.explanation || {};
    const extra = [];
    if (r.cookies && r.cookies.length) extra.push({ id: 'cookies', label: 'Cookies', html: C.kv(r.cookies.map((c) => [`${c.name}`, `${c.value} · ${c.domain}${c.path}${c.httpOnly ? ' · httpOnly' : ''}`])) });
    if (r.console && r.console.length) extra.push({ id: 'console', label: 'Console', html: h`<pre class="console-log">${r.console.map((l) => `[${l.level}] ${l.source}: ${l.message}`).join('\n')}</pre>` });
    const view = C.exchangeView({ request: r.request, response: res, assertions: r.assertions, correlationId: res.correlationId, status: res.status < 400 && !(r.assertions || []).some((a) => a.result === 'FAIL') ? 'passed' : 'failed' }, { extraTabs: extra });
    box.innerHTML = String(h`<div class="card-head"><h2>Response</h2><div class="row" style="gap:14px"><span>${C.statusCode(res.status)}</span><span class="small muted">${fmt.ms(res.timeMs)} · ${fmt.bytes(res.sizeBytes)}</span>${r.demo ? h`<span class="badge demo">Demo org</span>` : ''}${(r.assertions || []).length ? h`<span class="small">${(r.assertions || []).filter((a) => a.result === 'PASS').length}/${r.assertions.length} tests passed</span>` : ''}</div></div>
      ${res.status >= 400 && x.title ? h`<div class="card-body" style="padding-bottom:0">${errorBox({ message: `${x.code ? `${x.code}: ` : ''}${x.title}`, info: x })}</div>` : ''}
      <div class="card-body">${view.html}</div>`);
    view.bind(box);
  }
})();
