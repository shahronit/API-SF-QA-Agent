/* Shared composite components: page header, tabs, list controller, result viewer,
   defect preview, production-safety confirmations. */
(() => {
  const QA = window.QA;
  const { h, raw, esc, ic, fmt, badge, prov, pri, method, toast, toastError, modal, confirm, drawer, on, debounce, withBusy, json, table, pager, errorBox, empty, loading } = QA.ui;
  const api = QA.api;

  // ── Layout helpers ──
  const pageHead = (title, sub, actions) => h`<div class="page-head"><div><h1>${title}</h1>${sub ? h`<p>${sub}</p>` : ''}</div>${actions ? h`<div class="page-actions">${actions}</div>` : ''}</div>`;
  const pageIntro = ({ what, next } = {}) => (what || next) ? h`<div class="page-intro" role="note"><div class="page-intro-grid">${what ? h`<div><div class="page-intro-k">What this screen is</div><div class="wrap">${what}</div></div>` : ''}${next ? h`<div><div class="page-intro-k">What you should do</div><div class="wrap">${next}</div></div>` : ''}</div></div>` : '';
  const tabs = (items, active, attr = 'data-tab') => h`<div class="tabs" role="tablist">${items.map((t) => h`<button class="tab ${t.id === active ? 'on' : ''}" role="tab" aria-selected="${t.id === active}" ${raw(`${attr}="${esc(t.id)}"`)}>${t.label}${t.n !== undefined && t.n !== null ? h`<span class="n">${t.n}</span>` : ''}</button>`)}</div>`;
  const kv = (pairs) => h`<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => h`<dt>${k}</dt><dd>${v === undefined || v === null || v === '' ? raw('<span class="faint">–</span>') : v}</dd>`)}</dl>`;
  const endpoint = (m, path) => h`<span class="endpoint wrap">${m ? method(m) : ''} <code class="mono small">${fmt.shortPath(path)}</code></span>`;
  const statusCode = (c) => (c ? h`<span class="num ${c >= 500 ? 'text-error' : c >= 400 ? 'text-warn' : 'text-ok'}">${c}</span>` : h`<span class="faint">–</span>`);
  const projectRequired = () => empty({ icon: 'folder', title: 'Start with a project', text: 'A project is one Salesforce org (backend APIs) + HTTP/Postman collections (frontend APIs) + one environment (QA, UAT, Production). Create one to unlock stories, tests and runs.', action: h`<a class="btn primary" href="/projects/new" data-link>${ic('plus')} Create a project</a><a class="btn" href="/projects" data-link>See existing projects</a>` });
  const layerTag = (kind) => kind === 'frontend'
    ? h`<span class="layer-tag frontend">Frontend / HTTP APIs</span>`
    : h`<span class="layer-tag backend">Backend APIs</span>`;

  /** Banner showing Salesforce connection availability for the current project. */
  function connectionNotice(project) {
    if (!project || !project.connection) return '';
    const s = project.connection.salesforce;
    if (s.status === 'unavailable') return h`<div class="callout warn">${ic('alert')}<div><b class="wrap">Salesforce MCP is unavailable. API test design and automation generation are available, but live Salesforce validation is disabled.</b><div class="small mt-s wrap">${s.reason || 'Connect a Salesforce org (OAuth) and/or an MCP server on Projects → Connect Salesforce, then Test connections.'} <a href="/projects/${project.id}?tab=connection" data-link>Open Connect Salesforce</a></div></div></div>`;
    return '';
  }

  // ── Filter chips (multi-select) ──
  function chipGroup(name, options, selected = []) {
    const set = new Set([].concat(selected || []));
    return h`<div class="chip-select" role="group" aria-label="${name}">${options.map((o) => {
      const v = typeof o === 'object' ? o.value : o; const l = typeof o === 'object' ? o.label : o;
      return h`<button class="chip ${set.has(v) ? 'on' : ''}" data-chip="${name}" data-value="${v}" aria-pressed="${set.has(v)}">${l}</button>`;
    })}</div>`;
  }

  /**
   * Paginated list controller. Owns query state (page, sort, search, filters, selection),
   * fetches via `fetch(params)` and renders toolbar + table + pager into `root`.
   * opts: { columns, fetch, toolbar(state) → Safe, sort, dir, pageSize, selectable, rowAttrs, onRow(row, e),
   *         emptyState(state), afterRender(root, data, state), filters }
   */
  function listController(root, opts) {
    const state = { page: 1, pageSize: opts.pageSize || 25, sort: opts.sort, dir: opts.dir || 'DESC', q: opts.q || '', filters: { ...(opts.filters || {}) }, selected: new Set(), data: null };
    let seq = 0;
    root.innerHTML = String(h`<div class="card"><div class="toolbar" data-toolbar></div><div data-body>${loading()}</div><div data-pager></div></div>`);
    const tb = root.querySelector('[data-toolbar]');
    const body = root.querySelector('[data-body]');
    const pg = root.querySelector('[data-pager]');
    const renderToolbar = () => { tb.innerHTML = String(h`<input class="input search" type="search" placeholder="${opts.searchPlaceholder || 'Search'}" value="${state.q}" data-q aria-label="Search">${opts.toolbar ? opts.toolbar(state) : ''}`); };

    async function load() {
      const my = ++seq;
      body.style.opacity = state.data ? '.55' : '';
      try {
        const data = await opts.fetch({ page: state.page, pageSize: state.pageSize, sort: state.sort, dir: state.dir, q: state.q, ...state.filters });
        if (my !== seq) return;
        state.data = data;
        const rows = data.items || data;
        body.innerHTML = String(table({ columns: opts.columns, rows, sort: state.sort, dir: state.dir, selectable: opts.selectable, selected: state.selected, rowAttrs: opts.rowAttrs, emptyState: opts.emptyState ? opts.emptyState(state) : empty({ title: 'Nothing matches these filters', text: 'Clear the search or filters to see all records.' }) }));
        pg.innerHTML = String(data.items ? pager(data) : '');
        if (opts.afterRender) opts.afterRender(root, data, state);
      } catch (e) {
        if (my !== seq) return;
        body.innerHTML = String(h`<div class="card-body">${errorBox(e)}</div>`);
      } finally { body.style.opacity = ''; }
    }
    renderToolbar();
    on(root, 'input', '[data-q]', debounce((e) => { state.q = e.target.value.trim(); state.page = 1; load(); }, 300));
    on(root, 'click', '[data-sort]', (e, el) => { const k = el.dataset.sort; state.dir = state.sort === k && state.dir === 'DESC' ? 'ASC' : 'DESC'; state.sort = k; load(); });
    on(root, 'keydown', '[data-sort]', (e, el) => { if (e.key === 'Enter') el.click(); });
    on(root, 'click', '[data-page]', (e, el) => { state.page = Number(el.dataset.page); load(); });
    on(root, 'change', '[data-page-size]', (e) => { state.pageSize = Number(e.target.value); state.page = 1; load(); });
    on(root, 'change', '[data-select]', (e, el) => { el.checked ? state.selected.add(el.dataset.select) : state.selected.delete(el.dataset.select); el.closest('tr').classList.toggle('selected', el.checked); if (opts.onSelect) opts.onSelect(state); });
    on(root, 'change', '[data-select-all]', (e, el) => { const rows = (state.data.items || state.data); rows.forEach((r) => (el.checked ? state.selected.add(r.id) : state.selected.delete(r.id))); load(); if (opts.onSelect) opts.onSelect(state); });
    on(root, 'click', '[data-chip]', (e, el) => {
      const k = el.dataset.chip; const v = el.dataset.value;
      const cur = new Set(String(state.filters[k] || '').split(',').filter(Boolean));
      cur.has(v) ? cur.delete(v) : cur.add(v);
      state.filters[k] = [...cur].join(','); state.page = 1;
      el.classList.toggle('on'); el.setAttribute('aria-pressed', cur.has(v));
      load();
    });
    on(root, 'change', '[data-filter]', (e, el) => { state.filters[el.dataset.filter] = el.value; state.page = 1; load(); });
    if (opts.onRow) on(root, 'click', 'tbody tr', (e, el) => { if (e.target.closest('input, button, a, select')) return; const rows = state.data.items || state.data; const row = rows.find((r) => String(r.id) === el.dataset.id); if (row) opts.onRow(row, e); });
    load();
    return { state, reload: load, renderToolbar, setFilter(k, v) { state.filters[k] = v; state.page = 1; renderToolbar(); load(); } };
  }

  // ── Request / response viewer ──
  function headersTable(hd) {
    const entries = Object.entries(hd || {});
    if (!entries.length) return h`<p class="muted small">No headers.</p>`;
    return h`<div class="table-wrap"><table class="t"><tbody>${entries.map(([k, v]) => h`<tr><td class="mono small" style="width:38%">${k}</td><td class="mono small" style="word-break:break-all">${String(v)}</td></tr>`)}</tbody></table></div>`;
  }
  function bodyView(b) {
    if (b === undefined || b === null || b === '') return h`<p class="muted small">No body.</p>`;
    if (typeof b === 'string' && /^\s*</.test(b)) return h`<pre class="code">${b}</pre>`;
    return json(b);
  }
  function assertionsView(list) {
    if (!list || !list.length) return empty({ icon: 'check', title: 'No assertions', text: 'This request had no assertions configured.' });
    const failed = list.filter((a) => a.result === 'FAIL').length;
    return h`<p class="small muted">${list.length - failed} of ${list.length} assertions passed.</p>
      <div class="table-wrap"><table class="t"><thead><tr><th style="width:70px">Result</th><th>Check</th><th>Expected</th><th>Actual</th></tr></thead><tbody>
      ${list.map((a) => h`<tr class="${a.result === 'FAIL' ? 'diff-row bad' : ''}"><td>${badge(a.result)}</td><td>${a.check || a.type}${a.message ? h`<div class="cell-sub">${a.message}</div>` : ''}</td><td class="mono small">${fmtVal(a.expected)}</td><td class="mono small">${fmtVal(a.actual)}</td></tr>`)}
      </tbody></table></div>`;
  }
  const fmtVal = (v) => (v === undefined ? '–' : typeof v === 'string' ? v : JSON.stringify(v));
  function sfValidationView(v) {
    if (!v) return empty({ icon: 'database', title: 'No Salesforce validation', text: 'This test does not compare the API response with the persisted Salesforce record.' });
    return h`<div class="row wrap" style="gap:10px;margin-bottom:12px">${badge(v.status)} ${prov(v.label)} <span class="small muted">${v.message || ''}</span></div>
      ${kv([['Object', v.object], ['Record Id', v.recordId ? h`<code class="mono">${v.recordId}</code>` : null], ['SOQL', v.soql ? h`<code class="mono small" style="word-break:break-all">${v.soql}</code>` : null]])}
      ${v.comparisons && v.comparisons.length ? h`<h3 class="mt">Field comparison</h3><div class="table-wrap"><table class="t"><thead><tr><th>Field</th><th>Sent / expected</th><th>Persisted in Salesforce</th><th style="width:80px">Match</th></tr></thead><tbody>
        ${v.comparisons.map((c) => h`<tr class="${c.match ? '' : 'diff-row bad'}"><td class="mono small">${c.field}</td><td class="mono small">${fmtVal(c.expected)}</td><td class="mono small">${fmtVal(c.actual)}</td><td>${c.match ? h`<span class="text-ok">${ic('check')}</span>` : h`<span class="text-error">${ic('x')}</span>`}</td></tr>`)}
      </tbody></table></div>` : ''}
      ${v.related && v.related.length ? h`<h3 class="mt">Related records</h3>${json(v.related)}` : ''}
      ${v.label === 'ASSUMED' ? h`<div class="callout info mt">${ic('info')}<div class="small">Validated against the demo org simulator. Results are ASSUMED until re-run against a live, VERIFIED Salesforce org.</div></div>` : ''}`;
  }
  function analysisView(a, err) {
    if (!a && !err) return empty({ icon: 'spark', title: 'No analysis', text: 'Analysis is produced for failed and blocked tests.' });
    const x = a || {};
    const href = x.href || (err && err.href);
    const actionLabel = x.actionLabel || (err && err.actionLabel) || 'Open Connections';
    return h`<div class="row wrap" style="gap:8px;margin-bottom:10px"><b>${x.category || (err && err.title) || 'Failure'}</b>${prov(x.label)}${x.confidence ? h`<span class="tag">confidence: ${x.confidence}</span>` : ''}</div>
      ${kv([['Classification', x.classification], ['Failure', x.failure], ['Root cause', x.rootCause || (err && err.cause)], ['Evidence', (x.evidence || (err && err.evidence) || []).length ? h`<ul class="list">${[].concat(x.evidence || err.evidence).map((e) => h`<li class="small">${e}</li>`)}</ul>` : null], ['Impact', x.impact], ['Recommendation', x.recommendation || x.action || (err && err.action)], ['Retest', x.retest]])}
      ${href ? h`<div class="form-actions mt"><a class="btn primary" href="${href}" data-link>${actionLabel}</a></div>` : ''}`;
  }

  /** Tabs for a single exchange. Returns { html, bind(el) }. */
  function exchangeView(r, { extraTabs = [] } = {}) {
    const items = [
      { id: 'request', label: 'Request' },
      { id: 'response', label: 'Response' },
      { id: 'assertions', label: 'Assertions', n: r.assertions ? r.assertions.length : 0 },
      { id: 'sf', label: 'Salesforce validation' },
      ...(r.contract ? [{ id: 'contract', label: 'Contract' }] : []),
      ...(r.analysis || r.error ? [{ id: 'analysis', label: 'Analysis' }] : []),
      ...extraTabs,
    ];
    const req = r.request || {}; const res = r.response || {};
    const panes = {
      request: h`<div class="row" style="gap:8px;margin-bottom:12px">${method(req.method || r.method)}<code class="mono small" style="word-break:break-all">${req.url || r.endpoint}</code></div>
        ${req.auth && req.auth !== 'default' ? h`<p class="small"><span class="tag">auth: ${req.auth}</span></p>` : ''}
        <h3>Headers</h3>${headersTable(req.headers)}${req.query && Object.keys(req.query).length ? h`<h3 class="mt">Query</h3>${json(req.query)}` : ''}<h3 class="mt">Body</h3>${bodyView(req.body)}`,
      response: res.status !== undefined ? h`<div class="row wrap" style="gap:16px;margin-bottom:12px"><span>Status ${statusCode(res.status)}</span><span class="muted small">${fmt.ms(res.timeMs)}</span><span class="muted small">${fmt.bytes(res.sizeBytes)}</span>${r.correlationId || res.correlationId ? h`<span class="small muted">Correlation <code class="mono">${r.correlationId || res.correlationId}</code></span>` : ''}</div>
        <h3>Headers</h3>${headersTable(res.headers)}<h3 class="mt">Body</h3>${bodyView(res.body)}` : (r.error ? errorBox({ message: r.error.title || 'No response', info: r.error }) : empty({ title: 'No response', text: 'The request was not sent.' })),
      assertions: assertionsView(r.assertions),
      sf: sfValidationView(r.sfValidation),
      contract: r.contract ? h`<div class="row" style="gap:8px;margin-bottom:10px">${badge(r.contract.status)}<span class="small muted">${r.contract.operation || ''}</span></div>${(r.contract.violations || []).length ? h`<ul class="list">${r.contract.violations.map((e) => h`<li class="small"><code class="mono">${e.path || '$'}</code> ${e.rule ? h`<span class="tag">${e.rule}</span>` : ''} ${e.message}</li>`)}</ul>` : h`<p class="small muted">Response matches the declared contract.</p>`}` : '',
      analysis: analysisView(r.analysis, r.error),
    };
    for (const t of extraTabs) panes[t.id] = t.html;
    const first = r.status === 'failed' && r.sfValidation && r.sfValidation.status === 'FAIL' ? 'sf' : r.status === 'failed' && (r.assertions || []).some((a) => a.result === 'FAIL') ? 'assertions' : 'response';
    const html = h`<div data-xv>${tabs(items, first, 'data-xtab')}${items.map((t) => h`<div class="${t.id === first ? '' : 'hidden'}" data-xpane="${t.id}" role="tabpanel">${panes[t.id]}</div>`)}</div>`;
    return {
      html,
      bind(el) {
        on(el, 'click', '[data-xtab]', (e, b) => {
          const id = b.dataset.xtab;
          el.querySelectorAll('[data-xtab]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
          el.querySelectorAll('[data-xpane]').forEach((p) => p.classList.toggle('hidden', p.dataset.xpane !== id));
        });
      },
    };
  }

  /** Open a result in a drawer with full request/response/assertion/validation detail. */
  async function openResult(resultId, { onChange } = {}) {
    const d = drawer({ title: 'Loading result…', body: loading(8), width: 860 });
    try {
      const r = await api.get(`/api/results/${encodeURIComponent(resultId)}`);
      const view = exchangeView(r);
      d.el.querySelector('#d-title').textContent = r.title;
      d.el.querySelector('.drawer-head .titles').insertAdjacentHTML('beforeend', String(h`<div class="row wrap small muted mt-s" style="gap:8px">${badge(r.status)} ${pri(r.priority)} <span>${r.testType}</span><span>·</span><a href="/testcases?id=${r.testCaseId}" data-link>${r.testCaseId}</a>${r.storyKey ? h`<span>·</span><a href="/stories/${r.storyKey}" data-link>${r.storyKey}</a>` : ''}<span>·</span><span class="mono">${r.id}</span>${r.testCase && r.testCase.label ? prov(r.testCase.label) : ''}</div>`));
      d.setBody(view.html);
      view.bind(d.el.querySelector('.drawer-body'));
      const foot = h`<span class="small muted">${r.defectKey ? h`Linked defect <b>${r.defectKey}</b>` : r.status === 'failed' ? 'No defect has been created for this failure.' : ''}</span><span class="spacer"></span>
        <a class="btn" href="/explorer?fromResult=${r.id}" data-link>${ic('compass')} Open in explorer</a>
        ${r.status === 'failed' && !r.defectKey ? h`<button class="btn primary" data-preview-defect>${ic('bug')} Preview Jira defect</button>` : ''}`;
      const f = document.createElement('div'); f.className = 'drawer-foot'; f.innerHTML = String(foot);
      d.el.appendChild(f);
      const btn = f.querySelector('[data-preview-defect]');
      if (btn) btn.addEventListener('click', () => defectPreview(r.id, { onCreated: (def) => { d.close(); if (onChange) onChange(def); } }));
      f.querySelectorAll('[data-link]').forEach((a) => a.addEventListener('click', () => d.close()));
    } catch (e) { d.setBody(errorBox(e)); }
    return d;
  }

  // ── Defect preview → explicit create ──
  async function defectPreview(resultId, { onCreated } = {}) {
    let p;
    try { p = await api.post('/api/defects/preview', { resultId }); } catch (e) { toastError(e, 'Cannot draft defect'); return; }
    const dr = p.draft;
    const sevs = ['Critical', 'High', 'Medium', 'Low'];
    modal({
      title: 'Review Jira defect',
      subtitle: `Nothing is sent to Jira until you click "Create Jira defect". Target project: ${p.jira.project || '–'} (${p.jira.kind === 'demo' ? 'demo Jira' : 'Jira Cloud'}).`,
      size: 'xl',
      body: h`${p.existing ? h`<div class="callout warn">${ic('alert')}<div><b>A related defect already exists: ${p.existing.key}</b><div class="small">${p.existing.summary} — ${p.existing.status}. Consider updating it instead of creating a duplicate.</div></div></div>` : ''}
        ${!p.jira.available ? errorBox({ message: p.jira.explanation.title, info: p.jira.explanation }) : ''}
        <div class="form-grid mt">
          <label class="field full"><span>Summary</span><input class="input" name="summary" value="${dr.summary}" maxlength="240"></label>
          <label class="field"><span>Severity</span><select class="select" name="severity">${sevs.map((s) => h`<option ${s === dr.severity ? 'selected' : ''}>${s}</option>`)}</select></label>
          <label class="field"><span>Issue type</span><input class="input" value="${dr.issueType}" disabled></label>
          <label class="field"><span>Labels</span><input class="input" name="labels" value="${(dr.labels || []).join(', ')}"></label>
          <label class="field"><span>Components</span><input class="input" name="components" value="${(dr.components || []).join(', ')}"></label>
          <label class="field full"><span>Description (Markdown, secrets masked)</span><textarea class="input mono" name="description" rows="16" spellcheck="false">${dr.description}</textarea><small>Passwords, tokens, client secrets and session IDs are masked automatically and again on the server before sending.</small></label>
          ${dr.storyKey ? h`<label class="check-row full"><input type="checkbox" name="link" checked> Link the defect to story <b>${dr.storyKey}</b></label>` : ''}
        </div>`,
      foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-create ${!p.jira.available ? 'disabled' : ''}>${ic('jira')} Create Jira defect</button>`,
      onMount(el, close) {
        el.querySelector('[data-create]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
          const v = (n) => el.querySelector(`[name=${n}]`);
          const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
          try {
            const def = await api.post('/api/defects', { resultId, confirmed: true, summary: v('summary').value, description: v('description').value, severity: v('severity').value, priority: { Critical: 'Highest', High: 'High', Medium: 'Medium', Low: 'Low' }[v('severity').value], labels: list(v('labels').value), components: list(v('components').value), storyKey: dr.storyKey, linkToStory: v('link') ? v('link').checked : false });
            close();
            toast(h`${def.key} created${(def.activity || []).some((a) => a.action === 'linked') ? ` and linked to ${dr.storyKey}` : ''}.`, 'ok', 'Jira defect created');
            if (onCreated) onCreated(def);
          } catch (err) { toastError(err, 'Defect not created'); }
        }));
      },
    });
  }

  // ── Production safety ──
  /**
   * Run `send(confirmations)`; if the server answers with a production
   * confirmation requirement, ask the user (twice for DELETE) and retry.
   * `opts.allowReadOnly` adds a "Run read-only tests only" option (runs).
   */
  async function withProductionSafety(send, { allowReadOnly = false } = {}) {
    const conf = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await send(conf); } catch (e) {
        const code = e.info && e.info.code;
        if (e.status !== 409 || !/^PRODUCTION_/.test(code || '')) throw e;
        if (e.info.requires === 'confirmProductionWrites') {
          const choice = await productionDialog(e.info, allowReadOnly);
          if (!choice) return null;
          if (choice === 'readonly') conf.skipWrites = true; else conf.confirmProductionWrites = true;
        } else if (e.info.requires === 'confirmDelete') {
          const ok = await confirm({ title: 'Second confirmation: DELETE in Production', danger: true, message: h`<p><b>This operation will modify Salesforce production data.</b></p><p>${e.info.deleteCount ? `${e.info.deleteCount} DELETE operation(s)` : 'This DELETE'} will remove production records.</p>`, details: errorBox({ message: e.message, info: e.info }, { compact: true }), typeToConfirm: 'DELETE', confirmLabel: 'Confirm DELETE' });
          if (!ok) return null;
          conf.confirmDelete = true;
        } else throw e;
      }
    }
    return null;
  }
  function productionDialog(info, allowReadOnly) {
    return new Promise((resolve) => {
      let result = null;
      modal({
        title: 'This operation will modify Salesforce production data.', danger: true,
        body: h`<div class="callout error">${ic('shield')}<div><b>Production is read-only by default.</b><div class="small">${info.cause || ''}</div></div></div>
          ${info.evidence ? h`<ul class="list mt">${[].concat(info.evidence).map((x) => h`<li class="small">${x}</li>`)}</ul>` : ''}
          <label class="field mt"><span>Type <code>PRODUCTION</code> to allow data changes</span><input class="input" data-type autocomplete="off"></label>`,
        foot: h`<button class="btn" data-close>Cancel</button>${allowReadOnly ? h`<button class="btn" data-ro>${ic('lock')} Run read-only tests only</button>` : ''}<button class="btn danger" data-ok disabled>Allow production writes</button>`,
        onMount(el, close) {
          const ok = el.querySelector('[data-ok]');
          el.querySelector('[data-type]').addEventListener('input', (e) => { ok.disabled = e.target.value.trim() !== 'PRODUCTION'; });
          ok.addEventListener('click', () => { result = 'writes'; close(); });
          const ro = el.querySelector('[data-ro]');
          if (ro) ro.addEventListener('click', () => { result = 'readonly'; close(); });
        },
        onClose() { resolve(result); },
      });
    });
  }

  /** Start a run (with production safety) and navigate to the live execution view. */
  async function startRun(body, btn) {
    const p = QA.state.project;
    return withBusy(btn, async () => {
      try {
        const run = await withProductionSafety((conf) => api.post(`/api/runs?projectId=${encodeURIComponent(p.id)}`, { ...body, ...conf }), { allowReadOnly: true });
        if (!run) return null;
        toast(`Execution ${run.id} started with ${run.total} tests.`, 'ok', 'Run started');
        QA.router.go(`/execution/${run.id}`);
        return run;
      } catch (e) { toastError(e, 'Run not started'); return null; }
    });
  }

  function runnerPicker(p) {
    const runners = (p && p.connection && p.connection.runners) || {};
    const rows = [
      ['platform', 'Platform', 'Built-in runner. Always available. Masking, retries and Salesforce checks stay on.'],
      ['playwright', 'Playwright MCP', runners.playwright && runners.playwright.available ? 'ExecuteAutomation Playwright MCP (playwright_get / post / put / patch / delete).' : 'Not connected — set it on Connections → Playwright MCP.'],
      ['postman', 'Postman MCP', runners.postman && runners.postman.available ? 'Runs the synced collection in Postman.' : 'Not connected — set it on Connections → Postman / HTTP.'],
    ];
    const preferred = (runners.playwright && runners.playwright.available) ? 'playwright'
      : (runners.postman && runners.postman.available) ? 'postman' : 'platform';
    return h`<div class="field"><span>How should this run execute?</span>
      <select class="select" name="executor">${rows.map(([id, label, help]) => {
        const avail = id === 'platform' || (runners[id] && runners[id].available);
        return h`<option value="${id}" ${id === preferred ? 'selected' : ''} ${avail ? '' : 'disabled'}>${label}${avail ? '' : ' (connect first)'}</option>`;
      })}</select>
      <small>${rows.find((r) => r[0] === preferred)[2]} <a href="/projects/${p.id}?tab=connection" data-link>Connections</a></small>
    </div>`;
  }

  /** Dialog to pick a run selection (priority / type / story) and start it. */
  function runDialog({ preset = {}, title = 'Run tests' } = {}) {
    const m = QA.state.meta;
    const p = QA.state.project;
    modal({
      title, subtitle: `${p.name} · ${p.environment}${p.environment === 'Production' ? ' · read-only by default' : ''}`,
      body: h`<div class="stack">
        <div class="field"><span>Priority</span>${chipGroup('priority', m.priorities, preset.priority)}</div>
        <div class="field"><span>Test type</span>${chipGroup('testType', m.testTypes, preset.testType)}</div>
        <label class="field"><span>Story keys (comma separated, optional)</span><input class="input" name="storyKey" value="${[].concat(preset.storyKey || []).join(', ')}" placeholder="e.g. DEMO-101, DEMO-102"></label>
        <label class="field"><span>Run label</span><input class="input" name="label" value="${preset.label || ''}" placeholder="e.g. Sprint 24 regression"></label>
        <label class="check-row"><input type="checkbox" name="deps" checked> Include upstream setup tests that produce required variables</label>
        <label class="check-row"><input type="checkbox" name="postResultToJira" ${preset.postResultToJira ? 'checked' : ''}> After the run, post a pass/fail comment on the Jira story (not a defect)</label>
        ${runnerPicker(p)}
        <p class="small muted">Empty filters run every ready test. Drafts and disabled tests are skipped. Production writes still need confirmation.</p></div>`,
      foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>${ic('play')} Start run</button>`,
      onMount(el, close) {
        const sel = { priority: new Set([].concat(preset.priority || [])), testType: new Set([].concat(preset.testType || [])) };
        on(el, 'click', '[data-chip]', (e, c) => { const s = sel[c.dataset.chip]; s.has(c.dataset.value) ? s.delete(c.dataset.value) : s.add(c.dataset.value); c.classList.toggle('on'); c.setAttribute('aria-pressed', s.has(c.dataset.value)); });
        el.querySelector('[data-go]').addEventListener('click', async (e) => {
          const sk = el.querySelector('[name=storyKey]').value.split(',').map((x) => x.trim()).filter(Boolean);
          const filter = {};
          if (sel.priority.size) filter.priority = [...sel.priority];
          if (sel.testType.size) filter.testType = [...sel.testType];
          if (sk.length) filter.storyKey = sk;
          const execEl = el.querySelector('[name=executor]');
          const postResult = el.querySelector('[name=postResultToJira]') && el.querySelector('[name=postResultToJira]').checked;
          const run = await startRun({ filter, label: el.querySelector('[name=label]').value || undefined, resolveDependencies: el.querySelector('[name=deps]').checked, testCaseIds: preset.testCaseIds, executor: execEl ? execEl.value : 'auto', postResultToJira: postResult }, e.currentTarget);
          if (run) close();
        });
      },
    });
  }

  QA.components = { pageHead, pageIntro, tabs, kv, endpoint, statusCode, chipGroup, listController, exchangeView, openResult, defectPreview, withProductionSafety, startRun, runDialog, connectionNotice, projectRequired, layerTag, headersTable, bodyView, assertionsView, sfValidationView, analysisView };
})();
