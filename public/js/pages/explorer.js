/* API explorer: request builder for every Salesforce API, object discovery, SOQL, save/convert to test. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, badge, prov, method, on, errorBox, loading, empty, toast, toastError, withBusy, esc, modal, json, debounce } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  const J = (v) => (v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

  QA.pages.explorer = {
    async render(view, ctx) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'API explorer' }]);
      const state = { layer: ctx.query.layer === 'frontend' ? 'frontend' : 'backend', side: ctx.query.object ? 'objects' : 'templates', req: { method: 'GET', path: '/services/data/v{{apiVersion}}/limits', auth: 'default', headers: '', query: '', body: '', variables: '', apiType: 'REST' }, last: null, object: ctx.query.object || null };

      view.innerHTML = String(h`${C.pageHead('Try an API', h`${C.layerTag(state.layer)} ${p.name} (${p.environment}). The access token is added on the server — you never paste it here.`, h`<a class="btn" href="/workflow/postman" data-link>${ic('folder')} Open collection</a>`)}
        ${C.pageIntro({ what: 'Backend APIs are Salesforce org REST, Apex REST, Bulk and Composite. Frontend / HTTP APIs are custom REST, storefront, middleware and BFF collections in Postman.', next: state.layer === 'frontend' ? 'Review collections below, or open Find HTTP collections in How QA works. Import/export lives under HTTP / Postman.' : 'Pick a Salesforce template or object on the left, click Send, then Save as test if the call is useful. Production writes ask you to confirm.' })}
        ${C.connectionNotice(p)}
        <div class="mt" style="margin-bottom:var(--space-4)">${C.tabs([{ id: 'backend', label: 'Backend · Salesforce' }, { id: 'frontend', label: 'Frontend · HTTP / Postman' }], state.layer, 'data-layer')}</div>
        <div data-layer-pane="frontend" class="${state.layer === 'frontend' ? '' : 'hidden'}"><div data-fe>${loading(6)}</div></div>
        <div data-layer-pane="backend" class="${state.layer === 'backend' ? '' : 'hidden'}">
        <div class="split" style="grid-template-columns:280px minmax(0,1fr)">
          <aside class="card" style="align-self:start;position:sticky;top:72px;max-height:calc(100vh - 96px);overflow:auto">
            <div class="toolbar" style="padding:8px">${C.tabs([{ id: 'templates', label: 'Templates' }, { id: 'saved', label: 'Saved' }, { id: 'objects', label: 'Objects' }], state.side, 'data-side')}</div>
            <div data-side-body>${loading(8)}</div>
          </aside>
          <div class="stack" style="min-width:0">
            <div class="card"><div class="card-body">
              <div class="row" style="gap:8px;flex-wrap:wrap">
                <select class="select" name="method" aria-label="Method" style="width:110px">${['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'].map((m) => h`<option>${m}</option>`)}</select>
                <input class="input mono" name="path" aria-label="Endpoint path" style="flex:1;min-width:260px">
                <select class="select" name="auth" aria-label="Authentication" style="width:190px">${[['default', 'Integration user'], ['lowpriv', 'Low-privilege user'], ['none', 'No token'], ['invalid', 'Invalid token']].map(([v, l]) => h`<option value="${v}">${l}</option>`)}</select>
                <button class="btn primary" data-act="send">${ic('send')} Send</button>
              </div>
              <div class="mt" data-reqtabs>${C.tabs([{ id: 'body', label: 'Body' }, { id: 'query', label: 'Parameters' }, { id: 'headers', label: 'Headers' }, { id: 'variables', label: 'Variables' }], 'body', 'data-rt')}</div>
              ${['body', 'query', 'headers', 'variables'].map((k) => h`<div data-rp="${k}" class="${k === 'body' ? '' : 'hidden'}"><textarea class="input mono" rows="${k === 'body' ? 10 : 5}" name="${k}" spellcheck="false" placeholder="${{ body: 'JSON, XML (SOAP) or CSV body', query: '{ "q": "SELECT Id FROM Account LIMIT 5" }', headers: '{ "Sforce-Call-Options": "client=qa-platform" } — no Authorization header', variables: '{ "accountId": "001..." }  — {{apiVersion}} and {{$uuid}} etc. resolve automatically' }[k]}"></textarea></div>`)}
              <div class="row mt" style="gap:8px"><span class="small muted" data-reqhint></span><span class="spacer"></span><button class="btn sm" data-act="save">${ic('plus')} Save request</button><button class="btn sm" data-act="totest" disabled>${ic('wand')} Create test case from response</button></div>
            </div></div>
            <div class="card" data-response>${empty({ icon: 'send', title: 'No request sent yet', text: 'Choose a template or object on the left, or type an endpoint, then click Send.' })}</div>
          </div>
        </div>
        </div>`);

      const f = (n) => view.querySelector(`[name=${n}]`);
      const setReq = (r) => {
        Object.assign(state.req, r);
        f('method').value = state.req.method; f('path').value = state.req.path; f('auth').value = state.req.auth || 'default';
        for (const k of ['body', 'query', 'headers', 'variables']) f(k).value = J(state.req[k]);
        view.querySelector('[data-reqhint]').textContent = state.req.note || (state.req.apiType ? `Backend API · ${state.req.apiType}` : 'Backend API · Salesforce');
      };
      setReq(state.req);
      on(view, 'click', '[data-rt]', (e, el) => { view.querySelector('[data-reqtabs]').innerHTML = String(C.tabs([{ id: 'body', label: 'Body' }, { id: 'query', label: 'Parameters' }, { id: 'headers', label: 'Headers' }, { id: 'variables', label: 'Variables' }], el.dataset.rt, 'data-rt')); view.querySelectorAll('[data-rp]').forEach((x) => x.classList.toggle('hidden', x.dataset.rp !== el.dataset.rt)); });
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
        box.innerHTML = String(loading(6));
        try {
          const r = await api.get(`/api/projects/${p.id}/postman/collections`);
          const items = r.items || [];
          box.innerHTML = String(h`<div class="card"><div class="card-head"><h2>Frontend / HTTP collections</h2><span class="sub">${r.source || ''} · ${r.workspace || 'local'}</span></div>
            <div class="card-body">
              <p class="small wrap">These collections are the frontend HTTP layer (custom REST, storefront, middleware, BFF). Salesforce org APIs stay on the Backend tab.</p>
              <div class="row wrap mt"><a class="btn primary" href="/workflow/postman" data-link>${ic('search')} Find collections</a><a class="btn" href="/automation" data-link>Import / export Postman</a><a class="btn" href="/projects/${p.id}?tab=connection" data-link>Postman connection</a></div>
            </div>
            ${items.length ? QA.ui.table({ rows: items, columns: [
              { key: 'name', label: 'Collection', render: (c) => h`<div class="wrap">${c.name}</div><div class="cell-sub">${c.source || ''} · ${c.requestCount != null ? `${c.requestCount} requests` : ''}</div>` },
              { key: 'workspace', label: 'Workspace', render: (c) => c.workspace || '—' },
              { key: 'open', label: '', render: (c) => h`<a class="btn xs" href="/workflow/postman" data-link>Open</a>` },
            ] }) : empty({ icon: 'folder', title: 'No collections yet', text: 'Reuse local collections or connect a Postman workspace, then Test Postman on Connections.', action: h`<a class="btn primary" href="/projects/${p.id}?tab=connection" data-link>Open Connections</a>` })}
          </div>`);
        } catch (e) {
          box.innerHTML = String(h`<div class="card"><div class="card-body">${errorBox(e, { compact: true })}<div class="row mt"><a class="btn primary" href="/projects/${p.id}?tab=connection" data-link>Connect Postman</a><a class="btn" href="/workflow/postman" data-link>Find collections</a></div></div></div>`);
        }
      }
      if (state.layer === 'frontend') drawFrontend();

      // Sidebar
      const sideBody = view.querySelector('[data-side-body]');
      let templates = []; let saved = []; let objects = null;
      async function drawSide() {
        view.querySelector('[data-side]') && (view.querySelector('aside .toolbar').innerHTML = String(C.tabs([{ id: 'templates', label: 'Templates' }, { id: 'saved', label: 'Saved' }, { id: 'objects', label: 'Objects' }], state.side, 'data-side')));
        try {
          if (state.side === 'templates') {
            if (!templates.length) templates = await api.get('/api/explorer/templates', { cacheMs: 600000 });
            const groups = templates.reduce((m, t, i) => { (m[t.group] = m[t.group] || []).push({ ...t, i }); return m; }, {});
            sideBody.innerHTML = String(h`<div class="side-list">${Object.entries(groups).map(([g, items]) => h`<div class="side-group">${g}</div>${items.map((t) => h`<button class="item" data-tpl="${t.i}">${method(t.method)}<span class="truncate">${t.name}</span></button>`)}`)}</div>`);
          } else if (state.side === 'saved') {
            saved = await api.get(`/api/requests?projectId=${p.id}`);
            const groups = saved.reduce((m, t) => { (m[t.collection || 'Default'] = m[t.collection || 'Default'] || []).push(t); return m; }, {});
            sideBody.innerHTML = String(saved.length ? h`<div class="side-list">${Object.entries(groups).map(([g, items]) => h`<div class="side-group">${g}</div>${items.map((t) => h`<div class="item" style="display:flex;gap:6px;align-items:center"><button class="btn ghost xs" style="flex:1;justify-content:flex-start;min-width:0" data-saved="${t.id}">${method(t.method)}<span class="truncate">${t.name}</span></button><button class="btn ghost xs" data-delsaved="${t.id}" aria-label="Delete ${t.name}">${ic('x')}</button></div>`)}`)}</div>` : empty({ icon: 'inbox', title: 'No saved requests', text: 'Use "Save request" to keep requests for reuse.' }));
          } else {
            if (!objects) objects = await api.get(`/api/projects/${p.id}/sobjects`, { cacheMs: 300000 });
            sideBody.innerHTML = String(h`<div style="padding:8px"><input class="input search" type="search" placeholder="Filter objects" data-objq aria-label="Filter objects"><div class="small muted mt-s">${prov(objects.label)} ${objects.source}</div></div><div class="side-list" data-objlist>${raw(objList(''))}</div>`);
          }
        } catch (e) { sideBody.innerHTML = String(h`<div class="card-body">${errorBox(e, { compact: true })}</div>`); }
      }
      const objList = (q) => String(h`${objects.objects.filter((o) => !q || `${o.name} ${o.label}`.toLowerCase().includes(q.toLowerCase())).map((o) => h`<button class="item ${state.object === o.name ? 'on' : ''}" data-obj="${o.name}"><span class="truncate">${o.label}</span><span class="faint small mono" style="margin-left:auto">${o.name}</span></button>`)}`);
      on(view, 'click', '[data-side]', (e, el) => { state.side = el.dataset.side; drawSide(); });
      on(sideBody, 'input', '[data-objq]', debounce((e) => { sideBody.querySelector('[data-objlist]').innerHTML = objList(e.target.value); }, 150));
      on(sideBody, 'click', '[data-tpl]', (e, el) => { const t = templates[Number(el.dataset.tpl)]; setReq({ method: t.method, path: t.path, body: t.body || '', query: t.query || '', headers: t.headers || '', apiType: t.apiType || t.group, note: t.note || `${t.group} · ${t.name}`, auth: 'default' }); });
      on(sideBody, 'click', '[data-saved]', (e, el) => { const t = saved.find((x) => x.id === el.dataset.saved); setReq({ method: t.method, path: t.path, body: t.body || '', query: t.query || '', headers: t.headers || '', auth: t.auth, apiType: t.apiType, note: `Saved: ${t.name}` }); });
      on(sideBody, 'click', '[data-delsaved]', async (e, el) => { try { await api.del(`/api/requests/${el.dataset.delsaved}`); toast('Saved request deleted.', 'warn'); drawSide(); } catch (err) { toastError(err); } });
      on(sideBody, 'click', '[data-obj]', (e, el) => { state.object = el.dataset.obj; QA.router.setQuery({ object: state.object }); sideBody.querySelectorAll('[data-obj]').forEach((b) => b.classList.toggle('on', b === el)); describeObject(state.object); });
      drawSide();

      // Object describe panel (replaces response area)
      async function describeObject(name) {
        const box = view.querySelector('[data-response]');
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

      const parse = (k, label) => { const t = f(k).value.trim(); if (!t) return undefined; try { return JSON.parse(t); } catch (e) { throw Object.assign(new Error(`${label} must be valid JSON: ${e.message}`), { info: { action: `Fix the ${label} tab.` } }); } };
      const collect = () => ({ method: f('method').value, path: f('path').value.trim(), auth: f('auth').value, headers: parse('headers', 'Headers') || {}, query: parse('query', 'Query') || {}, variables: parse('variables', 'Variables') || {}, body: f('body').value, apiType: state.req.apiType });

      on(view, 'click', '[data-act=send]', (e, el) => withBusy(el, async () => {
        let b;
        try { b = collect(); } catch (err) { toastError(err, 'Request not sent'); return; }
        const box = view.querySelector('[data-response]');
        try {
          const r = await C.withProductionSafety((conf) => api.post(`/api/explorer/execute?projectId=${p.id}`, { ...b, ...conf }));
          if (!r) return;
          state.last = { req: b, res: r };
          view.querySelector('[data-act=totest]').disabled = false;
          drawResponse(box, r);
        } catch (err) { box.innerHTML = String(h`<div class="card-body">${errorBox(err)}</div>`); }
      }));
      view.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') view.querySelector('[data-act=send]').click(); });

      on(view, 'click', '[data-act=save]', () => {
        let b;
        try { b = collect(); } catch (err) { toastError(err); return; }
        modal({
          title: 'Save request', body: h`<div class="form-grid"><label class="field"><span>Name</span><input class="input" name="sname" value="${b.method} ${fmt.shortPath(b.path)}"></label><label class="field"><span>Collection</span><input class="input" name="scoll" value="Default"></label></div>`,
          foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Save</button>`,
          onMount(el, close) {
            el.querySelector('[data-go]').addEventListener('click', async () => {
              let body = b.body; try { body = b.body.trim() ? JSON.parse(b.body) : null; } catch { /* keep raw */ }
              try { await api.post(`/api/requests?projectId=${p.id}`, { name: el.querySelector('[name=sname]').value, collection: el.querySelector('[name=scoll]').value, method: b.method, path: b.path, headers: b.headers, query: b.query, body, auth: b.auth, apiType: b.apiType }); close(); toast('Request saved.', 'ok'); if (state.side === 'saved') drawSide(); } catch (err) { toastError(err); }
            });
          },
        });
      });

      on(view, 'click', '[data-act=totest]', (e, el) => withBusy(el, async () => {
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
    const view = C.exchangeView({ request: r.request, response: res, assertions: r.assertions, correlationId: res.correlationId, status: res.status < 400 ? 'passed' : 'failed' });
    box.innerHTML = String(h`<div class="card-head"><h2>Response</h2><div class="row" style="gap:14px"><span>${C.statusCode(res.status)}</span><span class="small muted">${fmt.ms(res.timeMs)} · ${fmt.bytes(res.sizeBytes)}</span>${r.demo ? h`<span class="badge demo">Demo org</span>` : ''}</div></div>
      ${res.status >= 400 && x.title ? h`<div class="card-body" style="padding-bottom:0">${errorBox({ message: `${x.code ? `${x.code}: ` : ''}${x.title}`, info: x })}</div>` : ''}
      <div class="card-body">${view.html}</div>`);
    view.bind(box);
  }
})();
