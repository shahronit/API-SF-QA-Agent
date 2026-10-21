/* API contracts: OpenAPI / Swagger / JSON Schema upload, run validation and an ad-hoc playground. */
(() => {
  const QA = window.QA;
  const { h, ic, fmt, badge, method, on, errorBox, loading, empty, toast, toastError, withBusy, esc, modal, confirm } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.contracts = {
    async render(view) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Contracts' }]);
      view.innerHTML = String(h`${C.pageHead('API contracts', 'Check responses against an OpenAPI, Swagger or JSON Schema file — required fields, types, enums and status codes.', h`<button class="btn primary" data-act="upload">${ic('upload')} Upload a contract</button>`)}
        ${C.pageIntro({ what: 'Optional. Upload a spec so runs can flag responses that drift from the contract.', next: 'Upload an OpenAPI 3, Swagger 2 or JSON Schema file, then attach it when you review tests.' })}
        <div class="grid g-12"><div class="card" style="align-self:start" data-list>${loading(4)}</div><div data-detail>${'' }</div></div>`);
      let list = [];
      let current = null;
      const listEl = view.querySelector('[data-list]');
      const detail = view.querySelector('[data-detail]');
      async function loadList() {
        try {
          list = await api.get(`/api/contracts?projectId=${p.id}`);
          listEl.innerHTML = String(h`<div class="card-head"><h2>Contracts</h2><span class="small muted">${list.length}</span></div>${list.length ? h`<div class="side-list">${list.map((c) => h`<button class="item ${current === c.id ? 'on' : ''}" data-c="${c.id}" style="flex-direction:column;align-items:flex-start;gap:2px"><span>${c.name}</span><span class="small muted">${c.kind} · ${c.operations} operations · ${c.linkedTests} linked tests</span></button>`)}</div>` : empty({ icon: 'file', title: 'No contracts', text: 'Upload an OpenAPI, Swagger or JSON Schema document.' })}`);
          if (!current && list[0]) open(list[0].id);
          if (!list.length) detail.innerHTML = '';
        } catch (e) { listEl.innerHTML = String(h`<div class="card-body">${errorBox(e)}</div>`); }
      }
      async function open(id) {
        current = id;
        listEl.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('on', b.dataset.c === id));
        detail.innerHTML = String(h`<div class="card">${loading(8)}</div>`);
        try {
          const c = await api.get(`/api/contracts/${id}`);
          detail.innerHTML = String(h`<div class="card"><div class="card-head"><h2>${c.name} <span class="sub">${c.kind} · uploaded ${fmt.date(c.createdAt)}</span></h2><div class="row"><button class="btn sm" data-act="validate">${ic('check')} Validate latest run</button><button class="btn sm ghost" data-act="delete" aria-label="Delete contract">${ic('trash')}</button></div></div>
            ${QA.ui.table({ rows: c.operations, columns: [
              { key: 'method', label: 'Method', render: (o) => method(o.method) }, { key: 'path', label: 'Path', render: (o) => h`<code class="mono small">${o.path}</code>` },
              { key: 'summary', label: 'Summary', render: (o) => h`<span class="small">${o.summary}</span><div class="cell-sub mono">${o.id}</div>` }, { key: 'responses', label: 'Responses', render: (o) => h`${(o.responses || []).map((r) => h`<span class="tag">${r}</span>`)}` },
            ] })}</div>
            <div class="mt" data-validation></div>
            <div class="card mt"><div class="card-head"><h2>Playground</h2><span class="small muted">Check a sample response against an operation</span></div><div class="card-body"><div class="form-grid">
              <label class="field"><span>Method</span><select class="select" name="pm">${['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map((m) => h`<option>${m}</option>`)}</select></label>
              <label class="field"><span>Status</span><input class="input" name="ps" type="number" value="200"></label>
              <label class="field full"><span>Path</span><input class="input mono" name="pp" value="${(c.operations[0] || {}).path || '/'}"></label>
              <label class="field full"><span>Response body (JSON)</span><textarea class="input mono" rows="7" name="pb" spellcheck="false">{}</textarea></label></div>
              <div class="row mt"><button class="btn primary" data-act="check">Check response</button><span data-checkout></span></div></div></div>`);
        } catch (e) { detail.innerHTML = String(errorBox(e)); }
      }
      on(listEl, 'click', '[data-c]', (e, el) => open(el.dataset.c));
      on(detail, 'click', '[data-act=validate]', (e, el) => withBusy(el, async () => {
        const out = detail.querySelector('[data-validation]');
        try {
          const r = await api.post(`/api/contracts/${current}/validate`, {});
          const rows = r.checks.filter((x) => x.status !== 'NOT_APPLICABLE');
          out.innerHTML = String(h`<div class="card"><div class="card-head"><h2>Validation of <a href="/execution/${r.runId}" data-link class="mono">${r.runId}</a></h2><span class="stat-inline"><span><b>${r.applicable}</b> applicable</span><span><b class="text-ok">${r.passed}</b> pass</span><span><b class="text-error">${r.failed}</b> fail</span></span></div>
            ${QA.ui.table({ rows, rowAttrs: (x) => `data-res="${esc(x.resultId)}"`, emptyState: empty({ title: 'No results matched this contract', text: 'None of the executed endpoints are declared in this contract.' }), columns: [
              { key: 'status', label: 'Contract', render: (x) => badge(x.status) }, { key: 'title', label: 'Test', render: (x) => h`<div class="cell-title">${x.title}</div><div class="cell-sub">${C.endpoint(x.method, x.endpoint)} · HTTP ${x.statusCode}</div>` },
              { key: 'violations', label: 'Violations', render: (x) => (x.violations.length ? h`<ul class="list small" style="margin:0">${x.violations.slice(0, 4).map((v) => h`<li><code class="mono">${v.path || '$'}</code> ${v.message}</li>`)}</ul>` : h`<span class="faint small">None</span>`) },
            ] })}</div>`);
        } catch (err) { out.innerHTML = String(errorBox(err)); }
      }));
      on(detail, 'click', 'tr[data-res]', (e, el) => { if (!e.target.closest('a')) C.openResult(el.dataset.res); });
      on(detail, 'click', '[data-act=check]', (e, el) => withBusy(el, async () => {
        const v = (n) => detail.querySelector(`[name=${n}]`).value;
        const out = detail.querySelector('[data-checkout]');
        try {
          const r = await api.post(`/api/contracts/${current}/check`, { method: v('pm'), status: Number(v('ps')), path: v('pp'), body: v('pb') });
          out.innerHTML = String(h`${badge(r.status)} <span class="small muted">${r.operation || ''}</span>${r.violations.length ? h`<ul class="list small">${r.violations.map((x) => h`<li><code class="mono">${x.path || '$'}</code> ${x.message}</li>`)}</ul>` : ''}`);
        } catch (err) { out.innerHTML = String(errorBox(err, { compact: true })); }
      }));
      on(detail, 'click', '[data-act=delete]', async () => {
        const ok = await confirm({ title: 'Delete this contract?', message: 'Linked tests keep running but contract checks are skipped.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        try { await api.del(`/api/contracts/${current}`); current = null; toast('Contract deleted.', 'warn'); loadList(); } catch (err) { toastError(err); }
      });
      on(view, 'click', '[data-act=upload]', () => {
        modal({
          title: 'Upload contract', size: 'wide', subtitle: 'OpenAPI 3.x or Swagger 2.0 (JSON or YAML), or a JSON Schema document.',
          body: h`<div class="form-grid"><label class="field"><span>Name</span><input class="input" name="name" placeholder="Integration APIs v1"></label><label class="field"><span>File</span><input class="input" type="file" name="file" accept=".json,.yaml,.yml"></label>
            <label class="field full"><span>Or paste the specification</span><textarea class="input mono" rows="12" name="content" spellcheck="false" placeholder="openapi: 3.0.3&#10;info: …"></textarea></label></div>`,
          foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>${ic('upload')} Upload</button>`,
          onMount(el, close) {
            el.querySelector('[name=file]').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; el.querySelector('[name=content]').value = await f.text(); if (!el.querySelector('[name=name]').value) el.querySelector('[name=name]').value = f.name.replace(/\.(json|ya?ml)$/i, ''); });
            el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
              const name = el.querySelector('[name=name]').value.trim(); const content = el.querySelector('[name=content]').value;
              if (!name || !content.trim()) { toast('Provide a name and the specification content.', 'warn'); return; }
              try { const c = await api.post(`/api/contracts?projectId=${p.id}`, { name, content }); close(); toast(`${c.name} uploaded with ${c.operations.length} operations.`, 'ok'); current = c.id; loadList(); open(c.id); } catch (err) { toastError(err, 'Upload failed'); }
            }));
          },
        });
      });
      loadList();
      return null;
    },
  };
})();
