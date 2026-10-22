/* Generic Postman-style HTTP / WebSocket / gRPC client mounted in the explorer. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, on, toast, toastError, withBusy, modal, empty, loading, errorBox, badge } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const AUTH = [
    ['inherit', 'Inherit'],
    ['none', 'No auth'],
    ['default', 'Salesforce session'],
    ['lowpriv', 'Low-privilege user'],
    ['invalid', 'Invalid token'],
    ['bearer', 'Bearer token'],
    ['basic', 'Basic auth'],
    ['apikey', 'API key'],
    ['oauth2', 'OAuth 2.0'],
  ];
  const BUILDER_TABS = [
    { id: 'params', label: 'Params' }, { id: 'headers', label: 'Headers' }, { id: 'body', label: 'Body' },
    { id: 'auth', label: 'Auth' }, { id: 'scripts', label: 'Pre-request' }, { id: 'tests', label: 'Tests' },
    { id: 'vars', label: 'Variables' },
    { id: 'code', label: 'Code' }, { id: 'curl', label: 'Import cURL' },
  ];
  const BODY_MODES = [
    ['none', 'None'],
    ['json', 'JSON'],
    ['text', 'Raw text'],
    ['xml', 'XML'],
    ['urlencoded', 'x-www-form-urlencoded'],
    ['formdata', 'form-data'],
    ['binary', 'Binary file'],
    ['graphql', 'GraphQL'],
  ];

  const kvRow = (r = {}) => ({ key: r.key || '', value: r.value === undefined || r.value === null ? '' : String(r.value), enabled: r.enabled !== false, secret: Boolean(r.secret), type: r.type || 'text', filename: r.filename || '' });
  const objRows = (o) => Object.entries(o || {}).map(([key, value]) => kvRow({ key, value }));
  const rowsObj = (rows) => Object.fromEntries((rows || []).filter((r) => r && r.key && r.enabled !== false).map((r) => [r.key, r.value]));

  function kvTable(name, rows, { secret = false, file = false } = {}) {
    const list = (rows && rows.length ? rows : [kvRow()]).concat([kvRow()]);
    return h`<div class="kv-editor" data-kv="${name}">
      ${list.map((r) => h`<div class="kv-row" data-kv-row>
        <label class="kv-on" title="Enabled"><input type="checkbox" data-k="on" ${r.enabled !== false ? 'checked' : ''}></label>
        <input class="input mono" data-k="key" placeholder="Key" value="${r.key}" title="${r.key || 'Key'}">
        <input class="input mono" data-k="val" placeholder="Value" value="${r.value}" ${r.secret ? 'type="password"' : ''} title="${r.secret ? (r.key ? `${r.key} (secret)` : 'Secret value') : (r.value || 'Value')}">
        ${secret ? h`<label class="kv-secret" title="Secret"><input type="checkbox" data-k="secret" ${r.secret ? 'checked' : ''}>${ic('lock')}<span class="sr-only">secret</span></label>` : ''}
        ${file ? h`<select class="select" data-k="type" style="width:90px"><option value="text" ${r.type !== 'file' ? 'selected' : ''}>Text</option><option value="file" ${r.type === 'file' ? 'selected' : ''}>File</option></select>` : ''}
        <button class="btn ghost xs" data-kv-del type="button" aria-label="Remove">${ic('x')}</button>
      </div>`)}
    </div>`;
  }

  function readKv(root, name) {
    const box = root.querySelector(`[data-kv="${name}"]`);
    if (!box) return [];
    return [...box.querySelectorAll('[data-kv-row]')].map((row) => {
      const type = (row.querySelector('[data-k=type]') || {}).value || 'text';
      return kvRow({
        key: row.querySelector('[data-k=key]').value.trim(),
        value: row.querySelector('[data-k=val]').value,
        enabled: row.querySelector('[data-k=on]').checked,
        secret: Boolean(row.querySelector('[data-k=secret]') && row.querySelector('[data-k=secret]').checked),
        type,
        filename: row.dataset.filename || '',
      });
    }).filter((r) => r.key);
  }

  function bindKv(root) {
    on(root, 'input', '[data-kv] [data-k]', (e, el) => {
      if (el.dataset.k === 'key') el.title = el.value || 'Key';
      else if (el.dataset.k === 'val' && el.type !== 'password') el.title = el.value || 'Value';
      if (el.dataset.k !== 'key') return;
      const editor = el.closest('[data-kv]');
      const rows = editor.querySelectorAll('[data-kv-row]');
      const last = rows[rows.length - 1];
      if (last.contains(el) && el.value) {
        const wantsSecret = Boolean(editor.querySelector('[data-k=secret]'));
        last.insertAdjacentHTML('afterend', String(kvTable('x', [kvRow()], { secret: wantsSecret }).toString().match(/<div class="kv-row"[\s\S]*?<\/div>/)));
      }
    });
    on(root, 'click', '[data-kv-del]', (e, el) => {
      const editor = el.closest('[data-kv]');
      el.closest('[data-kv-row]').remove();
      if (!editor.querySelector('[data-kv-row]')) {
        const wantsSecret = editor.getAttribute('data-kv') === 'envvals';
        editor.insertAdjacentHTML('beforeend', String(kvTable('x', [kvRow()], { secret: wantsSecret }).toString().match(/<div class="kv-row"[\s\S]*?<\/div>/)));
      }
    });
  }

  function authFields(req = {}) {
    const a = req.auth || 'default';
    const c = req.authConfig || {};
    return h`<div data-auth-fields>
      <div data-af="bearer" class="${a === 'bearer' ? '' : 'hidden'}">
        <label class="field"><span>Token</span><input class="input mono" name="auth_token" value="${c.token || ''}" placeholder="token — or {{accessToken}}"></label>
      </div>
      <div data-af="basic" class="${a === 'basic' ? '' : 'hidden'}">
        <div class="row wrap" style="gap:8px"><label class="field" style="flex:1"><span>Username</span><input class="input" name="auth_user" value="${c.username || ''}"></label>
        <label class="field" style="flex:1"><span>Password</span><input class="input" type="password" name="auth_pass" value="${c.password || ''}"></label></div>
      </div>
      <div data-af="apikey" class="${a === 'apikey' ? '' : 'hidden'}">
        <div class="row wrap" style="gap:8px"><label class="field" style="flex:1"><span>Key</span><input class="input mono" name="auth_key" value="${c.key || 'X-API-Key'}"></label>
        <label class="field" style="flex:1"><span>Value</span><input class="input mono" name="auth_keyval" value="${c.value || ''}"></label>
        <label class="field"><span>Add to</span><select class="select" name="auth_in"><option value="header" ${c.in !== 'query' ? 'selected' : ''}>Header</option><option value="query" ${c.in === 'query' ? 'selected' : ''}>Query</option></select></label></div>
      </div>
      <div data-af="oauth2" class="${a === 'oauth2' ? '' : 'hidden'}">
        <div class="row wrap" style="gap:8px">
          <label class="field"><span>Grant</span><select class="select" name="oauth_grant"><option value="client_credentials" ${c.grantType !== 'authorization_code' ? 'selected' : ''}>Client credentials</option><option value="authorization_code" ${c.grantType === 'authorization_code' ? 'selected' : ''}>Authorization code</option></select></label>
          <label class="field" style="flex:1"><span>Token URL</span><input class="input mono" name="oauth_token" value="${c.tokenUrl || ''}" placeholder="https://login.salesforce.com/services/oauth2/token"></label>
        </div>
        <div class="row wrap mt-s" style="gap:8px">
          <label class="field" style="flex:1"><span>Client ID</span><input class="input mono" name="oauth_id" value="${c.clientId || '{{clientId}}'}"></label>
          <label class="field" style="flex:1"><span>Client secret</span><input class="input mono" type="password" name="oauth_secret" value="${c.clientSecret || '{{clientSecret}}'}"></label>
        </div>
        <div class="row wrap mt-s" style="gap:8px">
          <label class="field" style="flex:1"><span>Auth URL (auth code)</span><input class="input mono" name="oauth_auth" value="${c.authUrl || ''}" placeholder="https://login.salesforce.com/services/oauth2/authorize"></label>
          <label class="field" style="flex:1"><span>Redirect URI</span><input class="input" name="oauth_redir" value="${c.redirectUri || 'http://localhost:1717/oauth/callback'}"></label>
        </div>
        <div class="row wrap mt-s" style="gap:8px">
          <label class="field" style="flex:1"><span>Scope</span><input class="input" name="oauth_scope" value="${c.scope || ''}"></label>
          <label class="field" style="flex:1"><span>Existing access token (optional)</span><input class="input mono" name="oauth_existing" value="${c.token || ''}"></label>
        </div>
        <label class="field mt-s"><span>Authorization code (auth-code grant)</span><input class="input mono" name="oauth_code" value="${c.code || ''}" placeholder="paste the code from the redirect URL"></label>
        <div class="row mt-s" style="gap:8px"><button class="btn sm" type="button" data-act="oauth-url">${ic('link')} Open authorize URL</button><span class="small muted">Open the authorize URL, then paste the returned code here and Send. Client credentials does not need a code.</span></div>
      </div>
    </div>`;
  }

  function bodyFields(req = {}) {
    const mode = req.bodyMode || 'json';
    return h`<div data-body-fields>
      <div class="row wrap" style="gap:8px;margin-bottom:8px"><label class="field"><span>Body</span><select class="select" name="bodyMode">${BODY_MODES.map(([v, l]) => h`<option value="${v}" ${v === mode ? 'selected' : ''}>${l}</option>`)}</select></label></div>
      <div data-bm="none" class="${mode === 'none' ? '' : 'hidden'}"><p class="small muted">No body will be sent.</p></div>
      <div data-bm="json" class="${mode === 'json' ? '' : 'hidden'}"><textarea class="input mono" name="body" rows="10" spellcheck="false" placeholder='{ "ok": true }'>${typeof req.body === 'string' ? req.body : (req.body ? JSON.stringify(req.body, null, 2) : '')}</textarea></div>
      <div data-bm="text" class="${mode === 'text' ? '' : 'hidden'}"><textarea class="input mono" name="bodyText" rows="10" spellcheck="false">${req.bodyMode === 'text' ? (req.body || '') : ''}</textarea></div>
      <div data-bm="xml" class="${mode === 'xml' ? '' : 'hidden'}"><textarea class="input mono" name="bodyXml" rows="10" spellcheck="false" placeholder="&lt;xml&gt;…&lt;/xml&gt;">${req.bodyMode === 'xml' ? (req.body || '') : ''}</textarea></div>
      <div data-bm="urlencoded" class="${mode === 'urlencoded' ? '' : 'hidden'}">${kvTable('urlencoded', req.form || [])}</div>
      <div data-bm="formdata" class="${mode === 'formdata' ? '' : 'hidden'}">${kvTable('formdata', req.form || [], { file: true })}</div>
      <div data-bm="binary" class="${mode === 'binary' ? '' : 'hidden'}"><label class="field"><span>File (sent as the request body)</span><input class="input" type="file" name="binaryFile"><span class="small muted" data-binname>${(req.binary && req.binary.filename) || ''}</span></label></div>
      <div data-bm="graphql" class="${mode === 'graphql' ? '' : 'hidden'}">
        <label class="field"><span>Query</span><textarea class="input mono" name="gqlQuery" rows="8" spellcheck="false">${(req.graphql && req.graphql.query) || ''}</textarea></label>
        <label class="field mt-s"><span>Variables (JSON)</span><textarea class="input mono" name="gqlVars" rows="5" spellcheck="false">${(req.graphql && req.graphql.variables) ? (typeof req.graphql.variables === 'string' ? req.graphql.variables : JSON.stringify(req.graphql.variables, null, 2)) : '{}'}</textarea></label>
        <div class="row mt-s"><button class="btn sm" type="button" data-act="gql-schema">${ic('search')} Fetch schema (introspection)</button></div>
        <pre class="code mt-s hidden" data-gql-schema></pre>
      </div>
    </div>`;
  }

  function builderHtml(req = {}, { sf = false } = {}) {
    const tab = 'params';
    const tabs = BUILDER_TABS;
    return h`<div data-builder>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <select class="select" name="method" aria-label="Method" style="width:110px">${METHODS.map((m) => h`<option ${m === (req.method || 'GET') ? 'selected' : ''}>${m}</option>`)}</select>
        <input class="input mono" name="path" aria-label="${sf ? 'Endpoint path or URL' : 'Request URL'}" style="flex:1;min-width:260px" value="${req.path || req.url || ''}" placeholder="${sf ? '/services/data/v{{apiVersion}}/limits or https://…' : 'https://api.example.com/v1/resources'}">
        <select class="select" name="auth" aria-label="Authentication" style="width:190px">${AUTH.map(([v, l]) => h`<option value="${v}" ${v === (req.auth || (sf ? 'default' : 'none')) ? 'selected' : ''}>${l}</option>`)}</select>
        <button class="btn primary" data-act="send" type="button">${ic('send')} Send</button>
      </div>
      <div class="mt" data-reqtabs>${C.tabs(tabs, tab, 'data-rt')}</div>
      <div data-rp="params">${kvTable('query', req.queryRows || objRows(req.query))}<p class="small muted">Disable a row to skip it. JSON mode is on Headers if you prefer a raw object.</p></div>
      <div data-rp="headers" class="hidden">${kvTable('headers', req.headerRows || objRows(req.headers))}<label class="check-row mt-s"><input type="checkbox" name="headersJson"> Advanced: JSON object</label><textarea class="input mono hidden" name="headersJsonText" rows="6">${req.headers && !req.headerRows ? JSON.stringify(req.headers, null, 2) : ''}</textarea></div>
      <div data-rp="body" class="hidden">${bodyFields(req)}</div>
      <div data-rp="auth" class="hidden">${authFields(req)}</div>
      <div data-rp="scripts" class="hidden"><textarea class="input mono" name="preRequest" rows="8" spellcheck="false" placeholder="// pm.environment.set('id', '{{$uuid}}')&#10;// pm.sendRequest({ url, method: 'GET' }, (err, res) => { ... })">${req.preRequest || ''}</textarea><p class="small muted">Sandboxed <code>pm</code> API: environment, variables, request, test, expect, sendRequest, console.</p></div>
      <div data-rp="tests" class="hidden"><textarea class="input mono" name="tests" rows="8" spellcheck="false" placeholder="pm.test('status is 200', () => pm.expect(pm.response.code).to.eql(200));">${req.tests || ''}</textarea></div>
      <div data-rp="vars" class="hidden">${kvTable('localvars', req.localRows || objRows(req.variables))}<p class="small muted">Local variables override collection and environment values for this request (<code>{{var}}</code>).</p></div>
      <div data-rp="code" class="hidden"><div class="row wrap" style="gap:8px">${['curl', 'fetch', 'python', 'node'].map((k) => h`<button class="btn sm" data-snip="${k}" type="button">${k}</button>`)}</div><pre class="code mt-s" data-snip-out></pre></div>
      <div data-rp="curl" class="hidden"><label class="field"><span>Paste a cURL command</span><textarea class="input mono" name="curlIn" rows="6" placeholder="curl -X POST https://…"></textarea></label><button class="btn sm mt-s" data-act="curl-import" type="button">${ic('upload')} Import into builder</button></div>
    </div>`;
  }

  function readAuth(root) {
    const auth = (root.querySelector('[name=auth]') || {}).value || 'none';
    const g = (n) => { const el = root.querySelector(`[name=${n}]`); return el ? el.value : ''; };
    const cfg = {};
    if (auth === 'bearer') cfg.token = g('auth_token');
    if (auth === 'basic') { cfg.username = g('auth_user'); cfg.password = g('auth_pass'); }
    if (auth === 'apikey') { cfg.key = g('auth_key'); cfg.value = g('auth_keyval'); cfg.in = g('auth_in') || 'header'; }
    if (auth === 'oauth2') {
      cfg.grantType = g('oauth_grant') || 'client_credentials';
      cfg.tokenUrl = g('oauth_token'); cfg.clientId = g('oauth_id'); cfg.clientSecret = g('oauth_secret');
      cfg.authUrl = g('oauth_auth'); cfg.redirectUri = g('oauth_redir'); cfg.scope = g('oauth_scope'); cfg.token = g('oauth_existing'); cfg.code = g('oauth_code');
    }
    return { auth, authConfig: cfg };
  }

  async function collect(root, { includeBinary = true } = {}) {
    const path = root.querySelector('[name=path]').value.trim();
    const method = root.querySelector('[name=method]').value;
    const { auth, authConfig } = readAuth(root);
    const useJsonH = root.querySelector('[name=headersJson]') && root.querySelector('[name=headersJson]').checked;
    let headerRows = readKv(root, 'headers');
    let headers = rowsObj(headerRows);
    if (useJsonH) {
      const t = root.querySelector('[name=headersJsonText]').value.trim();
      headers = t ? JSON.parse(t) : {};
      headerRows = objRows(headers);
    }
    const queryRows = readKv(root, 'query');
    const localRows = readKv(root, 'localvars');
    const bodyMode = (root.querySelector('[name=bodyMode]') || {}).value || 'json';
    let body = ''; let form = []; let graphql = {}; let binary = null;
    if (bodyMode === 'json') body = (root.querySelector('[name=body]') || {}).value || '';
    else if (bodyMode === 'text') body = (root.querySelector('[name=bodyText]') || {}).value || '';
    else if (bodyMode === 'xml') body = (root.querySelector('[name=bodyXml]') || {}).value || '';
    else if (bodyMode === 'urlencoded') form = readKv(root, 'urlencoded');
    else if (bodyMode === 'formdata') form = readKv(root, 'formdata');
    else if (bodyMode === 'graphql') {
      graphql = { query: (root.querySelector('[name=gqlQuery]') || {}).value || '', variables: (root.querySelector('[name=gqlVars]') || {}).value || '{}' };
      try { graphql.variables = JSON.parse(graphql.variables || '{}'); } catch (e) { throw Object.assign(new Error(`GraphQL variables must be JSON: ${e.message}`), { info: { action: 'Fix the Variables JSON.' } }); }
    } else if (bodyMode === 'binary' && includeBinary) {
      const inp = root.querySelector('[name=binaryFile]');
      if (inp && inp.files && inp.files[0]) {
        const file = inp.files[0];
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        binary = { filename: file.name, contentType: file.type || 'application/octet-stream', value: btoa(bin) };
      }
    }
    const variablesEl = root.querySelector('[name=variables]');
    let variables = {};
    if (variablesEl && variablesEl.value.trim()) {
      try { variables = JSON.parse(variablesEl.value); } catch (e) { throw Object.assign(new Error(`Variables must be JSON: ${e.message}`), { info: { action: 'Fix the Variables JSON.' } }); }
    }
    return {
      method, path, url: path, auth, authConfig, headers, headerRows, query: rowsObj(queryRows), queryRows,
      bodyMode, body, form, graphql, binary,
      preRequest: (root.querySelector('[name=preRequest]') || {}).value || '',
      tests: (root.querySelector('[name=tests]') || {}).value || '',
      localRows, variables: { ...rowsObj(localRows), ...variables }, apiType: /^https?:\/\//i.test(path) ? 'HTTP' : undefined,
    };
  }

  function bindBuilder(root, { onSend, kvRoot } = {}) {
    bindKv(kvRoot || root);
    on(root, 'click', '[data-rt]', (e, el) => {
      const tabs = BUILDER_TABS;
      root.querySelector('[data-reqtabs]').innerHTML = String(C.tabs(tabs, el.dataset.rt, 'data-rt'));
      root.querySelectorAll('[data-rp]').forEach((x) => x.classList.toggle('hidden', x.dataset.rp !== el.dataset.rt));
    });
    on(root, 'change', '[name=auth]', (e, el) => {
      root.querySelectorAll('[data-af]').forEach((p) => p.classList.toggle('hidden', p.dataset.af !== el.value));
    });
    on(root, 'change', '[name=bodyMode]', (e, el) => {
      root.querySelectorAll('[data-bm]').forEach((p) => p.classList.toggle('hidden', p.dataset.bm !== el.value));
    });
    on(root, 'change', '[name=headersJson]', (e, el) => {
      root.querySelector('[name=headersJsonText]').classList.toggle('hidden', !el.checked);
    });
    on(root, 'click', '[data-snip]', async (e, el) => withBusy(el, async () => {
      try {
        const b = await collect(root, { includeBinary: false });
        const r = await api.post('/api/lab/snippets', { method: b.method, url: b.path, headers: b.headers, body: b.body });
        root.querySelector('[data-snip-out]').textContent = r[el.dataset.snip] || '';
      } catch (err) { toastError(err); }
    }));
    on(root, 'click', '[data-act=curl-import]', (e, el) => withBusy(el, async () => {
      try {
        const parsed = await api.post('/api/lab/curl', { curl: root.querySelector('[name=curlIn]').value });
        apply(root, parsed);
        toast('cURL imported into the builder.', 'ok');
      } catch (err) { toastError(err, 'cURL not imported'); }
    }));
    on(root, 'click', '[data-act=oauth-url]', (e, el) => withBusy(el, async () => {
      try {
        const { authConfig } = readAuth(root);
        const r = await api.post('/api/lab/oauth/authorize-url', authConfig);
        window.open(r.url, '_blank', 'noopener');
      } catch (err) { toastError(err); }
    }));
    on(root, 'click', '[data-act=gql-schema]', (e, el) => withBusy(el, async () => {
      try {
        const b = await collect(root, { includeBinary: false });
        const r = await api.post(`/api/lab/graphql/introspect?projectId=${encodeURIComponent(QA.state.project.id)}`, { url: b.path, headers: b.headers, auth: b.auth, authConfig: b.authConfig });
        const box = root.querySelector('[data-gql-schema]');
        box.classList.remove('hidden');
        box.textContent = JSON.stringify((r.response && r.response.body) || r, null, 2).slice(0, 20000);
      } catch (err) { toastError(err, 'Introspection failed'); }
    }));
    if (onSend) on(root, 'click', '[data-act=send]', (e, el) => withBusy(el, () => onSend(el)));
  }

  function apply(root, req) {
    const set = (n, v) => { const el = root.querySelector(`[name=${n}]`); if (el && v !== undefined && v !== null) el.value = v; };
    if (req.method) set('method', req.method);
    if (req.path || req.url) set('path', req.path || req.url);
    if (req.auth) set('auth', req.auth);
    if (req.bodyMode) set('bodyMode', req.bodyMode);
    if (req.body !== undefined && req.body !== null) {
      const s = typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2);
      set('body', s); set('bodyText', s); set('bodyXml', s);
    }
    if (req.preRequest) set('preRequest', req.preRequest);
    if (req.tests) set('tests', req.tests);
    if (req.graphql) {
      set('gqlQuery', req.graphql.query || '');
      set('gqlVars', typeof req.graphql.variables === 'string' ? req.graphql.variables : JSON.stringify(req.graphql.variables || {}, null, 2));
    }
    const c = req.authConfig || {};
    set('auth_token', c.token); set('auth_user', c.username); set('auth_pass', c.password);
    set('auth_key', c.key); set('auth_keyval', c.value); set('auth_in', c.in);
    set('oauth_grant', c.grantType); set('oauth_token', c.tokenUrl); set('oauth_id', c.clientId);
    set('oauth_secret', c.clientSecret); set('oauth_auth', c.authUrl); set('oauth_redir', c.redirectUri); set('oauth_scope', c.scope); set('oauth_existing', c.token); set('oauth_code', c.code);
    root.querySelectorAll('[data-af]').forEach((p) => p.classList.toggle('hidden', p.dataset.af !== (req.auth || '')));
    if (req.bodyMode) root.querySelectorAll('[data-bm]').forEach((p) => p.classList.toggle('hidden', p.dataset.bm !== req.bodyMode));
    const fillKv = (name, rows) => {
      const box = root.querySelector(`[data-kv="${name}"]`);
      if (!box || !rows) return;
      box.outerHTML = String(kvTable(name, rows));
    };
    const asRows = (rows, obj) => (Array.isArray(rows) && rows.length ? rows : Array.isArray(obj) ? obj : objRows(obj));
    if (req.queryRows || req.query) fillKv('query', asRows(req.queryRows, req.query));
    if (req.headerRows || req.headers) fillKv('headers', asRows(req.headerRows, req.headers));
    if (req.form) fillKv(req.bodyMode === 'formdata' ? 'formdata' : 'urlencoded', req.form);
    if (req.localRows || req.variables) fillKv('localvars', asRows(req.localRows, req.variables));
  }

  function responseHtml(r) {
    const extra = [];
    if (r.cookies && r.cookies.length) extra.push({ id: 'cookies', label: 'Cookies', html: C.kv(r.cookies.map((c) => [`${c.name} (${c.domain}${c.path})`, `${c.value}${c.httpOnly ? ' · httpOnly' : ''}${c.secure ? ' · secure' : ''}`])) });
    if (r.console && r.console.length) extra.push({ id: 'console', label: 'Console', html: h`<pre class="console-log">${r.console.map((l) => `[${l.level}] ${l.source}: ${l.message}`).join('\n')}</pre>` });
    const view = C.exchangeView({ request: r.request, response: r.response, assertions: r.assertions || r.tests, correlationId: r.response && r.response.correlationId, status: (r.response && r.response.status < 400 && !(r.assertions || []).some((a) => a.result === 'FAIL')) ? 'passed' : 'failed' }, { extraTabs: extra });
    return { html: view.html, bind: view.bind, tests: r.assertions || r.tests };
  }

  async function mountFrontend(box, p, ctx) {
    const state = { protocol: ctx.query.protocol || 'http', side: ctx.query.side || 'collections', req: { method: 'GET', path: 'https://httpbin.org/get', auth: 'none', bodyMode: 'none' }, last: null, envId: null, colId: null, wsId: null };
    box.innerHTML = String(h`<div class="split lab-split">
      <aside class="card" style="align-self:start;position:sticky;top:72px;max-height:calc(100vh - 96px);overflow:auto">
        <div class="toolbar" style="padding:8px">${C.tabs([{ id: 'collections', label: 'Collections' }, { id: 'saved', label: 'Saved' }, { id: 'history', label: 'History' }, { id: 'envs', label: 'Env' }, { id: 'cookies', label: 'Cookies' }, { id: 'mocks', label: 'Mocks' }, { id: 'settings', label: 'Settings' }], state.side, 'data-fside')}</div>
        <div data-fside-body>${loading(8)}</div>
      </aside>
      <div class="stack" style="min-width:0">
        <div class="row wrap" style="gap:8px">${C.tabs([{ id: 'http', label: 'HTTP' }, { id: 'ws', label: 'WebSocket' }, { id: 'grpc', label: 'gRPC' }], state.protocol, 'data-proto')}</div>
        <div data-proto-pane="http" class="card"><div class="card-body" data-http-builder></div>
          <div class="card-body" style="padding-top:0"><div class="row" style="gap:8px"><span class="small muted" data-reqhint>Frontend / HTTP — full URL, any host.</span><span class="spacer"></span>
            <button class="btn sm" data-act="save">${ic('plus')} Save request</button>
            <button class="btn sm" data-act="save-ep">${ic('code')} Save as endpoint</button>
            <button class="btn sm" data-act="totest" disabled>${ic('wand')} Create test case from response</button>
          </div></div>
        </div>
        <div data-proto-pane="ws" class="${state.protocol === 'ws' ? '' : 'hidden'} card"><div class="card-body" data-ws></div></div>
        <div data-proto-pane="grpc" class="${state.protocol === 'grpc' ? '' : 'hidden'} card"><div class="card-body" data-grpc></div></div>
        <div class="card" data-response>${empty({ icon: 'send', title: 'No request sent yet', text: 'Enter an absolute http(s) URL and click Send. Collections, environments and mocks are in the left sidebar.' })}</div>
        <div class="card"><div class="card-head"><h2>Console</h2><button class="btn xs" data-act="clr-console">Clear</button></div><pre class="console-log" data-console></pre></div>
      </div>
    </div>`);

    const builderRoot = box.querySelector('[data-http-builder]');
    builderRoot.innerHTML = String(builderHtml(state.req, { sf: false }));
    bindBuilder(builderRoot, {
      kvRoot: box,
      onSend: async () => {
        let b;
        try { b = await collect(builderRoot); } catch (err) { toastError(err, 'Request not sent'); return; }
        const out = box.querySelector('[data-response]');
        try {
          const r = await C.withProductionSafety((conf) => api.post(`/api/explorer/execute?projectId=${p.id}`, { ...b, environmentId: state.envId, collectionId: state.colId, ...conf }));
          if (!r) return;
          state.last = { req: b, res: r };
          box.querySelector('[data-act=totest]').disabled = false;
          const view = responseHtml(r);
          out.innerHTML = String(h`<div class="card-head"><h2>Response</h2><div class="row" style="gap:14px"><span>${C.statusCode(r.response.status)}</span><span class="small muted">${fmt.ms(r.response.timeMs)} · ${fmt.bytes(r.response.sizeBytes)}</span></div></div><div class="card-body">${view.html}</div>`);
          view.bind(out);
          refreshConsole();
          if (state.side === 'history') drawSide();
        } catch (err) { out.innerHTML = String(h`<div class="card-body">${errorBox(err)}</div>`); }
      },
    });

    function renderTree(nodes, path = []) {
      return h`${(nodes || []).map((n, i) => {
        const here = path.concat(i);
        if (n.type === 'folder') {
          return h`<div class="tree-folder">
            <div class="tree-row"><span class="faint">${ic('folder')}</span><span class="truncate" title="${n.name}">${n.name}</span>
              <button class="btn ghost xs" data-fold="add" data-path="${here.join('.')}">+</button>
              <button class="btn ghost xs" data-fold="ren" data-path="${here.join('.')}">${ic('edit')}</button>
              <button class="btn ghost xs" data-fold="del" data-path="${here.join('.')}">${ic('x')}</button>
            </div>
            <div class="tree-children">${renderTree(n.item, here)}</div>
          </div>`;
        }
        return h`<div class="tree-row item"><button class="btn ghost xs" style="flex:1;justify-content:flex-start;min-width:0" data-open-req data-path="${here.join('.')}" title="${n.name}">${QA.ui.method(n.method)}<span class="truncate">${n.name}</span></button>
          <button class="btn ghost xs" data-mv="up" data-path="${here.join('.')}" title="Move up">↑</button>
          <button class="btn ghost xs" data-mv="down" data-path="${here.join('.')}" title="Move down">↓</button>
          <button class="btn ghost xs" data-fold="del" data-path="${here.join('.')}">${ic('x')}</button></div>`;
      })}`;
    }

    async function drawSide() {
      const body = box.querySelector('[data-fside-body]');
      box.querySelector('aside .toolbar').innerHTML = String(C.tabs([{ id: 'collections', label: 'Collections' }, { id: 'saved', label: 'Saved' }, { id: 'history', label: 'History' }, { id: 'envs', label: 'Env' }, { id: 'cookies', label: 'Cookies' }, { id: 'mocks', label: 'Mocks' }, { id: 'settings', label: 'Settings' }], state.side, 'data-fside'));
      try {
        if (state.side === 'collections') {
          const cols = await api.get(`/api/lab/collections?projectId=${p.id}`);
          if (!cols.length) { body.innerHTML = String(empty({ icon: 'folder', title: 'No collections', text: 'Import a Postman collection on HTTP / Postman, then edit folders here.', action: h`<a class="btn primary" href="/automation" data-link>Import collection</a>` })); return; }
          if (!state.colId) state.colId = cols[0].id;
          const tree = await api.get(`/api/lab/collections/${state.colId}/tree`);
          body.innerHTML = String(h`<div style="padding:8px"><select class="select" data-colid>${cols.map((c) => h`<option value="${c.id}" ${c.id === state.colId ? 'selected' : ''}>${c.name}</option>`)}</select>
            <div class="row mt-s" style="gap:6px"><button class="btn xs" data-fold="add" data-path="">${ic('plus')} Folder</button></div>
            <div class="mt-s"><span class="small muted">Collection variables</span>${kvTable('colvars', (tree.variable || []).map((v) => ({ key: v.key, value: v.value, enabled: !v.disabled })))}
            <button class="btn xs mt-s" data-act="save-colvars">Save collection vars</button></div></div>
            <div class="side-list">${renderTree(tree.tree)}</div>`);
        } else if (state.side === 'saved') {
          const saved = await api.get(`/api/requests?projectId=${p.id}`);
          const groups = saved.reduce((m, t) => { const k = `${t.collection || 'Default'}${t.extra && t.extra.folder ? '/' + t.extra.folder : ''}`; (m[k] = m[k] || []).push(t); return m; }, {});
          body.innerHTML = String(saved.length ? h`<div class="side-list">${Object.entries(groups).map(([g, items]) => h`<div class="side-group" title="${g}">${g}</div>${items.map((t) => h`<div class="item" style="display:flex;gap:6px;align-items:center"><button class="btn ghost xs" style="flex:1;justify-content:flex-start;min-width:0" data-saved="${t.id}" title="${t.name}">${QA.ui.method(t.method)}<span class="truncate">${t.name}</span></button><button class="btn ghost xs" data-delsaved="${t.id}">${ic('x')}</button></div>`)}`)}</div>` : empty({ icon: 'inbox', title: 'No saved requests', text: 'Save a request from the builder.' }));
        } else if (state.side === 'history') {
          const hist = await api.get(`/api/lab/history?projectId=${p.id}`);
          body.innerHTML = String((hist.items || []).length ? h`<div class="side-list">${hist.items.map((t) => h`<button class="item" data-hist="${t.id}" title="${t.url}"><span class="row" style="gap:6px">${QA.ui.method(t.method)}<span class="num ${t.status >= 400 ? 'text-error' : 'text-ok'}">${t.status || '–'}</span></span><div class="truncate small">${t.url}</div><div class="cell-sub">${fmt.ago(t.createdAt)} · ${fmt.ms(t.timeMs)}</div></button>`)}<div class="card-body"><button class="btn xs" data-act="clr-hist">Clear history</button></div></div>` : empty({ icon: 'history', title: 'No history yet', text: 'Every Send is logged here. Suite runs stay on Run tests.' }));
        } else if (state.side === 'envs') {
          const en = await api.get(`/api/lab/environments?projectId=${p.id}`);
          const cur = (en.items || []).find((e) => e.id === (state.envId || en.activeId)) || en.items[0];
          state.envId = cur ? cur.id : null;
          body.innerHTML = String(h`<div class="card-body stack">
            <select class="select" data-envid>${(en.items || []).map((e) => h`<option value="${e.id}" ${e.id === state.envId ? 'selected' : ''}>${e.name}${e.isActive ? ' (active)' : ''}</option>`)}</select>
            <div class="row wrap" style="gap:6px"><button class="btn xs" data-env="new">${ic('plus')} New</button><button class="btn xs" data-env="dup">Duplicate</button><button class="btn xs" data-env="del">Delete</button><button class="btn xs" data-env="act">Use</button></div>
            ${cur ? kvTable('envvals', cur.values || [], { secret: true }) : ''}
            <p class="small muted">Active environment values are merged into suite runs. For SFCC, set <code>organization_id</code> here or on Connections → Commerce Cloud (Realm / org ID).</p>
            <button class="btn sm primary" data-env="save">Save values</button>
            <label class="field"><span>Import Postman environment</span><input class="input" type="file" data-env-file accept=".json"></label>
            ${cur ? h`<button class="btn xs" data-env="export">Export</button>` : ''}
          </div>`);
        } else if (state.side === 'cookies') {
          const ck = await api.get(`/api/lab/cookies?projectId=${p.id}`);
          body.innerHTML = String(h`<div class="card-body"><button class="btn xs" data-act="add-cookie">Add cookie</button><button class="btn xs danger-outline" data-act="clr-cookies">Clear all</button></div>
            ${(ck.items || []).length ? h`<div class="side-list">${ck.items.map((c) => h`<div class="item"><div class="truncate" title="${c.name}=${c.value}"><b>${c.name}</b>=${c.value}</div><div class="cell-sub">${c.domain}${c.path} ${c.httpOnly ? 'httpOnly' : ''} ${c.secure ? 'secure' : ''}</div><div class="row" style="gap:4px"><button class="btn ghost xs" data-editcookie="${c.id}">${ic('edit')}</button><button class="btn ghost xs" data-delcookie="${c.id}">${ic('x')}</button></div></div>`)}</div>` : empty({ title: 'Cookie jar empty', text: 'Set-Cookie from responses is stored and sent to matching hosts.' })}`);
        } else if (state.side === 'mocks') {
          const mk = await api.get(`/api/lab/mocks?projectId=${p.id}`);
          body.innerHTML = String(h`<div class="card-body stack">
            <button class="btn sm primary" data-mock="new">${ic('plus')} New mock</button>
            ${(mk.items || []).map((m) => h`<div class="callout ${m.status === 'running' ? 'ok' : 'info'}"><div><b class="truncate" title="${m.name}" style="display:block">${m.name}</b><div class="small">${m.status}${m.origin ? ` · ${m.origin}` : ''}</div>
              <div class="row mt-s" style="gap:6px">${m.status === 'running' ? h`<button class="btn xs" data-mock="stop" data-id="${m.id}">Stop</button><button class="btn xs" data-mock="copy" data-url="${m.origin}">Copy URL</button>` : h`<button class="btn xs primary" data-mock="start" data-id="${m.id}">Start</button>`}
              <button class="btn xs" data-mock="edit" data-id="${m.id}">Examples</button>
              <button class="btn xs" data-mock="del" data-id="${m.id}">Delete</button></div></div></div>`)}
          </div>`);
        } else if (state.side === 'settings') {
          const s = await api.get(`/api/lab/settings?projectId=${p.id}`);
          body.innerHTML = String(h`<div class="card-body stack">
            <label class="check-row"><input type="checkbox" name="proxyEnabled" ${s.proxyEnabled ? 'checked' : ''}> Use HTTP(S) proxy</label>
            <label class="field"><span>Proxy URL</span><input class="input mono" name="proxyUrl" value="${s.proxyUrl || ''}" placeholder="http://127.0.0.1:8080"></label>
            <label class="check-row"><input type="checkbox" name="sslVerify" ${s.sslVerify ? 'checked' : ''}><span>Verify TLS certificates</span></label>
            <div class="callout warn">${ic('alert')}<div class="small">Disabling TLS verification is unsafe. Use it only against trusted lab hosts.</div></div>
            <label class="field"><span>Custom CA (PEM)</span><textarea class="input mono" name="caCert" rows="4" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label>
            <label class="field"><span>Client certificate (PEM)</span><textarea class="input mono" name="clientCert" rows="4"></textarea></label>
            <label class="field"><span>Client key (PEM)</span><textarea class="input mono" name="clientKey" rows="4"></textarea></label>
            <button class="btn sm primary" data-act="save-settings">Save connection settings</button>
            <p class="small muted">Applied to explorer Send and suite HTTP calls for this project.</p>
          </div>`);
        }
      } catch (e) { body.innerHTML = String(h`<div class="card-body">${errorBox(e, { compact: true })}</div>`); }
    }

    async function refreshConsole() {
      try {
        const r = await api.get(`/api/lab/console?projectId=${p.id}`);
        box.querySelector('[data-console]').textContent = (r.items || []).map((l) => `${l.createdAt} [${l.level}] ${l.source}: ${l.message}`).join('\n') || '(empty)';
      } catch { /* ignore */ }
    }

    on(box, 'click', '[data-fside]', (e, el) => { state.side = el.dataset.fside; drawSide(); });
    on(box, 'click', '[data-proto]', (e, el) => {
      state.protocol = el.dataset.proto;
      box.querySelectorAll('[data-proto]').forEach((b) => { b.classList.toggle('on', b === el); });
      box.querySelectorAll('[data-proto-pane]').forEach((pne) => pne.classList.toggle('hidden', pne.dataset.protoPane !== state.protocol));
    });
    on(box, 'change', '[data-colid]', (e, el) => { state.colId = el.value; drawSide(); });
    on(box, 'click', '[data-open-req]', async (e, el) => {
      try {
        const r = await api.get(`/api/lab/collections/${state.colId}/request?path=${encodeURIComponent(el.dataset.path)}`);
        apply(builderRoot, r);
        toast(`Opened “${r.name}”.`, 'ok');
      } catch (err) { toastError(err); }
    });
    on(box, 'click', '[data-fold]', (e, el) => withBusy(el, async () => {
      const act = el.dataset.fold;
      const path = el.dataset.path ? el.dataset.path.split('.').map(Number) : [];
      try {
        if (act === 'add') {
          const name = prompt('Folder name', 'New folder');
          if (!name) return;
          await api.post(`/api/lab/collections/${state.colId}/folder`, { name, parentPath: path });
        } else if (act === 'ren') {
          const name = prompt('Rename', '');
          if (!name) return;
          await api.post(`/api/lab/collections/${state.colId}/rename`, { name, path });
        } else if (act === 'del') {
          await api.post(`/api/lab/collections/${state.colId}/delete-item`, { path });
        }
        drawSide();
      } catch (err) { toastError(err); }
    }));
    on(box, 'click', '[data-mv]', (e, el) => withBusy(el, async () => {
      const path = el.dataset.path.split('.').map(Number);
      const parent = path.slice(0, -1);
      const idx = path[path.length - 1];
      const at = el.dataset.mv === 'up' ? Math.max(0, idx - 1) : idx + 1;
      try { await api.post(`/api/lab/collections/${state.colId}/move`, { from: path, toParent: parent, at }); drawSide(); } catch (err) { toastError(err); }
    }));
    on(box, 'click', '[data-saved]', async (e, el) => {
      const saved = await api.get(`/api/requests?projectId=${p.id}`);
      const t = saved.find((x) => x.id === el.dataset.saved);
      if (!t) return;
      apply(builderRoot, { ...t, ...(t.extra || {}) });
    });
    on(box, 'click', '[data-delsaved]', async (e, el) => { try { await api.del(`/api/requests/${el.dataset.delsaved}`); toast('Saved request deleted.', 'warn'); drawSide(); } catch (err) { toastError(err); } });
    on(box, 'click', '[data-hist]', async (e, el) => {
      try {
        const r = await api.get(`/api/lab/history/${el.dataset.hist}`);
        if (r.request) apply(builderRoot, { method: r.method, path: r.url, headers: (r.request && r.request.headers) || {}, body: r.request && r.request.body, auth: (r.request && r.request.auth) || 'none' });
        const view = responseHtml({ request: r.request, response: r.response, assertions: r.tests, console: r.console });
        const out = box.querySelector('[data-response]');
        out.innerHTML = String(h`<div class="card-head"><h2>History</h2></div><div class="card-body">${view.html}</div>`);
        view.bind(out);
      } catch (err) { toastError(err); }
    });
    on(box, 'click', '[data-act=clr-hist]', async () => { await api.del(`/api/lab/history?projectId=${p.id}`); drawSide(); });
    on(box, 'click', '[data-act=clr-console]', async () => { await api.del(`/api/lab/console?projectId=${p.id}`); refreshConsole(); });
    on(box, 'click', '[data-act=save-colvars]', (e, el) => withBusy(el, async () => {
      try {
        await api.put(`/api/lab/collections/${state.colId}/variables`, { values: readKv(box, 'colvars') });
        toast('Collection variables saved.', 'ok');
      } catch (err) { toastError(err); }
    }));
    on(box, 'click', '[data-delcookie]', async (e, el) => { await api.del(`/api/lab/cookies?projectId=${p.id}&id=${el.dataset.delcookie}`); drawSide(); });
    on(box, 'click', '[data-act=clr-cookies]', async () => { await api.del(`/api/lab/cookies?projectId=${p.id}`); drawSide(); });
    function cookieModal(c = {}) {
      modal({
        title: c.id ? 'Edit cookie' : 'Add cookie',
        body: h`<div class="form-grid">
          <label class="field"><span>Name</span><input class="input mono" name="cname" value="${c.name || ''}"></label>
          <label class="field"><span>Value</span><input class="input mono" name="cval" value="${c.value || ''}"></label>
          <label class="field"><span>Domain</span><input class="input mono" name="cdom" value="${c.domain || ''}" placeholder="example.com"></label>
          <label class="field"><span>Path</span><input class="input mono" name="cpath" value="${c.path || '/'}"></label>
          <label class="check-row"><input type="checkbox" name="chttp" ${c.httpOnly ? 'checked' : ''}> httpOnly (display only for browser cookies; sent by the server jar)</label>
          <label class="check-row"><input type="checkbox" name="csec" ${c.secure ? 'checked' : ''}> Secure</label>
        </div>`,
        foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Save</button>`,
        onMount(m, close) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            try {
              await api.put(`/api/lab/cookies?projectId=${p.id}`, {
                id: c.id, name: m.querySelector('[name=cname]').value, value: m.querySelector('[name=cval]').value,
                domain: m.querySelector('[name=cdom]').value, path: m.querySelector('[name=cpath]').value || '/',
                httpOnly: m.querySelector('[name=chttp]').checked, secure: m.querySelector('[name=csec]').checked,
              });
              close(); drawSide();
            } catch (err) { toastError(err); }
          });
        },
      });
    }
    on(box, 'click', '[data-editcookie]', async (e, el) => {
      const ck = await api.get(`/api/lab/cookies?projectId=${p.id}`);
      cookieModal((ck.items || []).find((x) => x.id === el.dataset.editcookie) || { id: el.dataset.editcookie });
    });
    on(box, 'click', '[data-act=add-cookie]', () => cookieModal({}));
    on(box, 'change', '[data-envid]', (e, el) => { state.envId = el.value; drawSide(); });
    on(box, 'click', '[data-env]', (e, el) => withBusy(el, async () => {
      const act = el.dataset.env;
      try {
        if (act === 'new') {
          const name = prompt('Environment name', 'Local');
          if (!name) return;
          const row = await api.post(`/api/lab/environments?projectId=${p.id}`, { name, values: [], isActive: true });
          state.envId = row.id;
        } else if (act === 'dup') { const row = await api.post(`/api/lab/environments/${state.envId}/duplicate`); state.envId = row.id; }
        else if (act === 'del') { await api.del(`/api/lab/environments/${state.envId}`); state.envId = null; }
        else if (act === 'act') { await api.post(`/api/lab/environments/${state.envId}/activate`); }
        else if (act === 'save') { await api.put(`/api/lab/environments/${state.envId}`, { values: readKv(box, 'envvals') }); toast('Environment saved.', 'ok'); }
        else if (act === 'export') { await api.download(`/api/lab/environments/${state.envId}/export`, 'environment.json'); }
        drawSide();
      } catch (err) { toastError(err); }
    }));
    on(box, 'change', '[data-env-file]', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const row = await api.post(`/api/lab/environments/import?projectId=${p.id}`, { environment: await f.text() }); state.envId = row.id; toast('Environment imported.', 'ok'); drawSide(); } catch (err) { toastError(err); }
    });
    on(box, 'click', '[data-act=save-settings]', (e, el) => withBusy(el, async () => {
      try {
        await api.put(`/api/lab/settings?projectId=${p.id}`, {
          proxyEnabled: box.querySelector('[name=proxyEnabled]').checked,
          proxyUrl: box.querySelector('[name=proxyUrl]').value,
          sslVerify: box.querySelector('[name=sslVerify]').checked,
          caCert: box.querySelector('[name=caCert]').value,
          clientCert: box.querySelector('[name=clientCert]').value,
          clientKey: box.querySelector('[name=clientKey]').value,
        });
        toast(box.querySelector('[name=sslVerify]').checked ? 'Connection settings saved.' : 'TLS verification is OFF for this project.', box.querySelector('[name=sslVerify]').checked ? 'ok' : 'warn');
      } catch (err) { toastError(err); }
    }));
    on(box, 'click', '[data-mock]', (e, el) => withBusy(el, async () => {
      const act = el.dataset.mock;
      try {
        if (act === 'new') {
          modal({
            title: 'New mock server',
            body: h`<div class="form-grid"><label class="field full"><span>Name</span><input class="input" name="mname" value="Local mock"></label>
              <label class="field full"><span>Example — method + path + status + body</span>
              <input class="input" name="mmethod" value="GET">
              <input class="input mono" name="mpath" value="/ping">
              <input class="input" name="mstatus" value="200">
              <textarea class="input mono" name="mbody" rows="4">{"ok":true}</textarea></label></div>`,
            foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Create</button>`,
            onMount(m, close) {
              m.querySelector('[data-go]').addEventListener('click', async () => {
                let body = m.querySelector('[name=mbody]').value; try { body = JSON.parse(body); } catch { /* text */ }
                await api.post(`/api/lab/mocks?projectId=${p.id}`, {
                  name: m.querySelector('[name=mname]').value,
                  collectionId: state.colId,
                  examples: [{ method: m.querySelector('[name=mmethod]').value, path: m.querySelector('[name=mpath]').value, status: Number(m.querySelector('[name=mstatus]').value || 200), body, enabled: true, headers: { 'Content-Type': 'application/json' } }],
                });
                close(); drawSide();
              });
            },
          });
          return;
        }
        if (act === 'start') { const r = await api.post(`/api/lab/mocks/${el.dataset.id}/start`); toast(`Mock running at ${r.origin}`, 'ok'); apply(builderRoot, { method: 'GET', path: r.origin + '/', auth: 'none', bodyMode: 'none' }); }
        if (act === 'stop') await api.post(`/api/lab/mocks/${el.dataset.id}/stop`);
        if (act === 'del') await api.del(`/api/lab/mocks/${el.dataset.id}`);
        if (act === 'copy') { await navigator.clipboard.writeText(el.dataset.url); toast('Mock URL copied.', 'ok'); }
        if (act === 'edit') {
          const list = await api.get(`/api/lab/mocks?projectId=${p.id}`);
          const mk = (list.items || []).find((x) => x.id === el.dataset.id);
          modal({
            title: 'Mock examples', size: 'wide',
            body: h`<textarea class="input mono" name="ex" rows="16">${JSON.stringify((mk && mk.examples) || [], null, 2)}</textarea>`,
            foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Save</button>`,
            onMount(m, close) {
              m.querySelector('[data-go]').addEventListener('click', async () => {
                await api.put(`/api/lab/mocks/${el.dataset.id}`, { examples: JSON.parse(m.querySelector('[name=ex]').value) });
                close(); drawSide();
              });
            },
          });
          return;
        }
        drawSide();
      } catch (err) { toastError(err); }
    }));

    on(box, 'click', '[data-act=save]', async () => {
      let b; try { b = await collect(builderRoot, { includeBinary: false }); } catch (err) { toastError(err); return; }
      modal({
        title: 'Save request', body: h`<div class="form-grid"><label class="field"><span>Name</span><input class="input" name="sname" value="${b.method} ${fmt.shortPath(b.path)}"></label><label class="field"><span>Collection</span><input class="input" name="scoll" value="HTTP"></label><label class="field"><span>Folder</span><input class="input" name="sfolder" placeholder="Auth/Login"></label></div>`,
        foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Save</button>`,
        onMount(el, close) {
          el.querySelector('[data-go]').addEventListener('click', async () => {
            try {
              await api.post(`/api/requests?projectId=${p.id}`, { name: el.querySelector('[name=sname]').value, collection: el.querySelector('[name=scoll]').value, folder: el.querySelector('[name=sfolder]').value, ...b, extra: { folder: el.querySelector('[name=sfolder]').value, bodyMode: b.bodyMode, authConfig: b.authConfig, preRequest: b.preRequest, tests: b.tests, queryRows: b.queryRows, headerRows: b.headerRows, form: b.form, graphql: b.graphql } });
              close(); toast('Request saved.', 'ok'); if (state.side === 'saved') drawSide();
            } catch (err) { toastError(err); }
          });
        },
      });
    });
    on(box, 'click', '[data-act=save-ep]', (e, el) => withBusy(el, async () => {
      try {
        const b = await collect(builderRoot, { includeBinary: false });
        const r = await api.post(`/api/projects/${p.id}/endpoints`, { method: b.method, path: b.path, body: b.body });
        toast(r.added === 0 ? 'That path is already an endpoint.' : 'Saved as a project endpoint.', r.added === 0 ? 'warn' : 'ok');
      } catch (err) { toastError(err); }
    }));
    on(box, 'click', '[data-act=totest]', (e, el) => withBusy(el, async () => {
      if (!state.last) return;
      try {
        const draft = await api.post(`/api/explorer/generate-test?projectId=${p.id}`, { ...state.last.req, response: state.last.res.response });
        modal({
          title: 'Create test case', size: 'wide',
          body: h`<div class="form-grid"><label class="field full"><span>Title</span><input class="input" name="title" value="${draft.title}"></label><label class="field full"><span>Assertions</span><textarea class="input mono" rows="10" name="assertions">${JSON.stringify(draft.assertions, null, 2)}</textarea></label></div>`,
          foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Create test case</button>`,
          onMount(m, close) {
            m.querySelector('[data-go]').addEventListener('click', async (ev) => withBusy(ev.currentTarget, async () => {
              try {
                const t = await api.post(`/api/testcases?projectId=${p.id}`, { ...draft, title: m.querySelector('[name=title]').value, assertions: JSON.parse(m.querySelector('[name=assertions]').value) });
                close(); toast(h`${t.id} created. <a href="/testcases?id=${t.id}" data-link>Open</a>`, 'ok', 'Test case created');
              } catch (err) { toastError(err); }
            }));
          },
        });
      } catch (err) { toastError(err); }
    }));

    // WebSocket pane
    const wsBox = box.querySelector('[data-ws]');
    wsBox.innerHTML = String(h`<div class="stack">
      <div class="row wrap" style="gap:8px"><input class="input mono" name="wsurl" style="flex:1" placeholder="wss://echo.websocket.events"><button class="btn primary" data-ws="connect">Connect</button><button class="btn" data-ws="disc">Disconnect</button></div>
      <label class="field"><span>Headers (JSON)</span><textarea class="input mono" name="wsheaders" rows="2" placeholder='{ "Authorization": "Bearer …" }'>{}</textarea></label>
      <div class="row wrap" style="gap:8px"><input class="input" name="wsmsg" style="flex:1" placeholder="Message"><button class="btn" data-ws="send">Send text</button><button class="btn" data-ws="sendjson">Send JSON</button></div>
      <pre class="console-log" data-wslog>(not connected)</pre>
    </div>`);
    let wsUnsub = null;
    const wsLog = (line) => { const el = wsBox.querySelector('[data-wslog]'); el.textContent = `${el.textContent}\n${line}`.trim(); };
    on(wsBox, 'click', '[data-ws]', (e, el) => withBusy(el, async () => {
      const act = el.dataset.ws;
      try {
        if (act === 'connect') {
          let headers = {}; try { headers = JSON.parse(wsBox.querySelector('[name=wsheaders]').value || '{}'); } catch (err) { throw Object.assign(new Error('Headers must be JSON'), { info: {} }); }
          const r = await api.post(`/api/lab/ws/connect?projectId=${p.id}`, { url: wsBox.querySelector('[name=wsurl]').value, headers });
          state.wsId = r.id;
          if (wsUnsub) wsUnsub();
          wsUnsub = api.stream(`/api/lab/ws/${r.id}/events`, { message: (m) => wsLog(`${m.type} ${m.data || m.message || m.code || ''}`), hello: (m) => wsLog(`session ${m.id} ${m.status}`) });
          wsLog(`connecting ${r.url}`);
        } else if (act === 'disc') {
          if (state.wsId) await api.post(`/api/lab/ws/${state.wsId}/close`, {});
          if (wsUnsub) wsUnsub();
          wsLog('disconnected');
        } else if (act === 'send' || act === 'sendjson') {
          if (!state.wsId) { toast('Connect first.', 'warn'); return; }
          const data = wsBox.querySelector('[name=wsmsg]').value;
          await api.post(`/api/lab/ws/${state.wsId}/send`, act === 'sendjson' ? { json: JSON.parse(data) } : { data });
        }
      } catch (err) { toastError(err); }
    }));

    // gRPC pane
    const gBox = box.querySelector('[data-grpc]');
    gBox.innerHTML = String(h`<div class="stack">
      <label class="field"><span>Target (host:port or https://host)</span><input class="input mono" name="grpctarget" placeholder="localhost:50051"></label>
      <label class="field"><span>Proto</span><textarea class="input mono" name="grpcproto" rows="10" spellcheck="false" placeholder="syntax = &quot;proto3&quot;;&#10;package hello;&#10;service Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }&#10;message HelloRequest { string name = 1; }&#10;message HelloReply { string message = 1; }"></textarea></label>
      <div class="row wrap" style="gap:8px"><button class="btn sm" data-grpc="parse">Parse proto</button>
        <select class="select" name="grpcsvc" style="min-width:160px"></select>
        <select class="select" name="grpcmethod" style="min-width:160px"></select></div>
      <label class="field"><span>Metadata (JSON object)</span><textarea class="input mono" name="grpcmeta" rows="2">{}</textarea></label>
      <label class="field"><span>Request message (JSON)</span><textarea class="input mono" name="grpcmsg" rows="6">{ "name": "QA" }</textarea></label>
      <button class="btn primary" data-grpc="call">${ic('send')} Unary call</button>
      <pre class="code" data-grpc-out></pre>
    </div>`);
    let grpcProto = '';
    on(gBox, 'click', '[data-grpc]', (e, el) => withBusy(el, async () => {
      try {
        if (el.dataset.grpc === 'parse') {
          grpcProto = gBox.querySelector('[name=grpcproto]').value;
          const r = await api.post('/api/lab/grpc/parse', { proto: grpcProto });
          const svc = gBox.querySelector('[name=grpcsvc]');
          svc.innerHTML = (r.services || []).map((s) => `<option value="${s.name}">${s.package ? s.package + '.' : ''}${s.name}</option>`).join('');
          const fill = () => {
            const s = (r.services || []).find((x) => x.name === svc.value);
            gBox.querySelector('[name=grpcmethod]').innerHTML = ((s && s.methods) || []).map((m) => `<option value="${m.name}">${m.name}${m.requestStream || m.responseStream ? ' (streaming — unsupported)' : ''}</option>`).join('');
          };
          svc.onchange = fill; fill();
          toast('Proto parsed.', 'ok');
        } else {
          grpcProto = gBox.querySelector('[name=grpcproto]').value;
          const r = await api.post(`/api/lab/grpc/call?projectId=${p.id}`, {
            target: gBox.querySelector('[name=grpctarget]').value,
            service: gBox.querySelector('[name=grpcsvc]').value,
            method: gBox.querySelector('[name=grpcmethod]').value,
            proto: grpcProto,
            metadata: JSON.parse(gBox.querySelector('[name=grpcmeta]').value || '{}'),
            payload: JSON.parse(gBox.querySelector('[name=grpcmsg]').value || '{}'),
          });
          gBox.querySelector('[data-grpc-out]').textContent = JSON.stringify(r, null, 2);
        }
      } catch (err) { toastError(err); }
    }));

    drawSide();
    refreshConsole();
    return () => { if (wsUnsub) wsUnsub(); };
  }

  QA.httpClient = { METHODS, AUTH, BODY_MODES, builderHtml, bindBuilder, collect, apply, kvTable, readKv, bindKv, objRows, rowsObj, responseHtml, mountFrontend, authFields };
})();
