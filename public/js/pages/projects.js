/* Projects: multi-project configuration, environments, connections (presence only), integration settings. */
(() => {
  const QA = window.QA;
  const { h, ic, fmt, badge, prov, on, errorBox, loading, empty, toast, toastError, withBusy, esc, modal, confirm } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.projects = {
    render(view, ctx) {
      if (ctx.pattern === '/projects/new' || ctx.query.new === '1') return renderCreate(view);
      return ctx.params.id ? renderDetail(view, ctx.params.id, ctx.query) : renderList(view);
    },
    openCreate() { QA.router.go('/projects/new'); },
  };

  const CONN_SHORT = { connected: 'Connected', configured: 'Ready', demo: 'Demo', off: 'Off', unavailable: 'Not connected' };
  const connDot = (s) => h`<span class="badge ${s.status === 'connected' || s.status === 'configured' ? 'ok' : s.status === 'demo' ? 'demo' : s.status === 'off' ? 'plain' : 'unavailable'}" title="${s.label}">${CONN_SHORT[s.status] || s.label}</span>`;
  const resultCallout = (r) => (r ? h`<div class="callout ${r.ok ? 'ok' : 'error'} plain-result">${ic(r.ok ? 'check' : 'alert')}<div><b>${r.ok ? 'Connected' : 'Not connected'}</b><div class="small wrap">${r.text}</div></div></div>` : '');
  function plainSf(x) {
    if (!x) return null;
    if (x.ok) {
      const bits = [];
      if (x.demo) bits.push('demo simulator');
      if (x.org && x.org.ok) bits.push('org reachable');
      else if (x.latestApiVersion) bits.push('org reachable');
      if (x.mcp && x.mcp.ok) bits.push('MCP connected');
      if (x.cli && x.cli.ok) bits.push(x.cli.status === 'AUTHENTICATED' ? 'CLI authenticated' : 'CLI connected');
      const types = x.types || (x.detection && x.detection.types) || [];
      if (types.length) bits.push(types.join(', '));
      if (x.kind === 'sfcc') bits.push('SFCC host');
      if (x.autoConnected && x.autoConnected.length) bits.push(`auto-connected ${x.autoConnected.join(', ')}`);
      const extra = (x.detection && x.detection.explanation) || x.text || '';
      return { ok: true, text: `Pass — ${bits.join(', ') || 'Salesforce is reachable'}.${extra ? ` ${extra}` : ''}` };
    }
    const why = x.title || x.error || (x.mcp && x.mcp.title) || (x.org && x.org.title) || 'could not connect';
    return { ok: false, text: `Fail — ${why}` };
  }
  function plainPm(x) {
    if (!x) return null;
    if (x.ok) {
      const names = x.collectionNames || [];
      const n = x.collections != null ? x.collections : names.length;
      const listed = names.slice(0, 8).join(', ');
      const extra = names.length > 8 ? ` (+${names.length - 8} more)` : '';
      return { ok: true, text: n ? `Pass — found ${n} collection${n === 1 ? '' : 's'}${listed ? `: ${listed}${extra}` : '.'}` : 'Pass — Postman is reachable. No collections found yet.' };
    }
    return { ok: false, text: `Fail — ${x.title || x.error || 'could not reach Postman'}.` };
  }
  function plainOther(name, x) {
    if (!x) return null;
    return x.ok ? { ok: true, text: `Pass — ${name} is connected.` } : { ok: false, text: `Fail — ${x.title || x.error || `${name} is not connected`}.` };
  }
  function plainCli(name, x) {
    if (!x) return null;
    if (x.ok && x.loggedIn !== false) {
      const who = x.account && x.account !== 'logged in' ? ` as ${x.account}` : '';
      const bin = x.bin ? ` (${x.bin})` : '';
      return { ok: true, text: `Pass — ${name} is logged in${who}${bin}.` };
    }
    return { ok: false, text: `Fail — ${x.title || x.error || `${name} is not logged in`}${x.action ? ` ${x.action}` : ''}` };
  }

  async function importEnvironmentFile(projectId, file) {
    const text = await file.text();
    let environment;
    try { environment = JSON.parse(text); } catch (e) {
      throw Object.assign(new Error(`Environment is not valid JSON: ${e.message}`), { info: { action: 'Export a Postman environment ({ name, values }).' } });
    }
    return api.post(`/api/projects/${projectId}/environment-import`, { environment });
  }

  function envImportToast(r) {
    const name = r.environment && r.environment.name;
    toast(r.notice || (r.applied || []).join('; ') || 'Environment imported.', r.ok === false ? 'error' : 'ok', name ? `Imported ${name}` : 'Environment imported');
  }

  function envImportPicker(extraClass = '') {
    return h`<label class="btn ${extraClass}">${ic('upload')} Import Postman environment<input type="file" accept=".json,application/json" data-import-env hidden></label>`;
  }

  async function removeProject(p) {
    const ok = await confirm({
      title: `Delete ${p.name}?`,
      message: h`This permanently removes the project, its tests, runs, docs and history. This cannot be undone.`,
      confirmLabel: 'Delete project',
      danger: true,
      typeToConfirm: p.name,
    });
    if (!ok) return;
    try {
      await api.del(`/api/projects/${p.id}`);
      toast(`${p.name} deleted.`, 'warn');
      await QA.state.reloadProjects();
      QA.router.go('/projects');
    } catch (err) { toastError(err, 'Project not deleted'); }
  }

  function renderList(view) {
    QA.router.setCrumbs([{ label: 'Projects' }]);
    const S = QA.state;
    const rows = (S.projects || []).filter((r) => r.status !== 'archived');
    const cta = h`<a class="btn primary" href="/projects/new" data-link data-act="new">${ic('plus')} New project</a>
      <label class="btn">${ic('upload')} Import collection<input type="file" accept=".json,application/json" data-import-col hidden></label>
      ${envImportPicker()}`;
    view.innerHTML = String(h`${C.pageHead('Projects', 'Each project is one QA workspace: Salesforce backend APIs, HTTP/Postman frontend APIs, and one environment such as QA or Production.', cta)}
      ${C.pageIntro({ what: 'Open a card, create a workspace, or import an existing Postman collection. Import detects the Salesforce org and reuses a project or creates one.', next: 'Click New project, or Import collection (v1 / v2 / v2.1 JSON). Nothing here stores passwords.' })}
      ${rows.length ? h`<div class="project-grid">${rows.map((r) => h`<div class="card project-card ${r.id === S.projectId ? 'current' : ''}">
          <a href="/projects/${esc(r.id)}" data-link>
          <div class="card-head"><h2>${r.name}</h2>${r.id === S.projectId ? h`<span class="tag">Current</span>` : ''}</div>
          <div class="card-body">
            <p class="desc wrap">${r.description || 'No description yet.'}</p>
            <div class="meta-row">${r.environment === 'Production' ? h`<span class="badge failed plain">${ic('shield')} Production</span>` : h`<span class="tag">${r.environment}</span>`}<span class="tag">${r.mode === 'demo' ? 'Demo' : 'Live'}</span>${r.orgKind && r.orgKind !== 'core' && r.orgKind !== 'http' ? h`<span class="tag">${(r.connection.salesforce && r.connection.salesforce.types && r.connection.salesforce.types.filter((t) => t !== 'Salesforce Core')[0]) || r.orgKind}</span>` : ''}${r.sfOrg ? h`<span class="mono small">${r.sfOrg}</span>` : ''}</div>
            ${C.kv([
              ['Salesforce (backend)', connDot(r.connection.salesforce)],
              ['HTTP / Postman', connDot(r.connection.postman || { status: 'unavailable', label: 'Local collections' })],
              ['Jira', h`${connDot(r.connection.jira)}${r.jiraProjectKey ? h` <span class="cell-sub">${r.jiraProjectKey}</span>` : ''}`],
              ['Tests', fmt.num(r.stats.tests)],
              ['Last run', r.stats.lastRun ? h`${badge(r.stats.lastRun.failed ? 'failed' : 'passed', `${r.stats.lastRun.passed}/${r.stats.lastRun.total}`)} <span class="cell-sub">${fmt.ago(r.stats.lastRun.startedAt)}</span>` : 'Never'],
            ])}
          </div>
          </a>
          <div class="card-body" style="padding-top:0"><button class="btn sm danger-outline" data-del-project="${esc(r.id)}" data-del-name="${esc(r.name)}">${ic('trash')} Delete</button></div>
        </div>`)}</div>` : h`<div class="card project-empty">${empty({ icon: 'folder', title: 'No projects yet', text: 'Create a project to connect a Salesforce org and (optionally) Jira. You can try Demo mode with no credentials.', action: cta })}
        <div class="project-steps">
          <div class="step"><div class="n">1</div><b>Name the workspace</b><div class="cell-sub">Environment (QA, UAT, Production) and Demo or Live.</div></div>
          <div class="step"><div class="n">2</div><b>Connect Salesforce and Postman</b><div class="cell-sub">Status first, then a short Connect wizard — never the password itself.</div></div>
          <div class="step"><div class="n">3</div><b>Pull tickets and test</b><div class="cell-sub">How QA works walks through generate → run → report.</div></div>
        </div></div>`}`);
    on(view, 'click', '[data-del-project]', (e, el) => {
      e.preventDefault();
      e.stopPropagation();
      removeProject({ id: el.dataset.delProject, name: el.dataset.delName });
    });
    on(view, 'click', '[data-act=new]', (e) => { if (!e.target.closest('a[href]')) { e.preventDefault(); QA.router.go('/projects/new'); } });
    on(view, 'change', '[data-import-col]', (e, el) => withBusy(el, async () => {
      const f = el.files && el.files[0];
      if (!f) return;
      try {
        const collection = await f.text();
        const r = await api.post('/api/postman/import', { collection, auto: true });
        await QA.state.reloadProjects();
        if (r.project && r.project.id) QA.state.setProject(r.project.id);
        toast(r.notice || 'Collection imported as runnable tests.', 'ok', r.created ? 'Project created' : 'Collection imported');
        if (r.setupHref) toast('Set the HTTP base URL and token on Connections if these frontend tests need them.', 'warn', 'HTTP details');
        QA.router.go(r.testsHref || '/testcases');
      } catch (err) { toastError(err, 'Import failed'); }
      el.value = '';
    }));
    on(view, 'change', '[data-import-env]', (e, el) => withBusy(el, async () => {
      const f = el.files && el.files[0];
      if (!f) return;
      const pid = QA.state.projectId;
      if (!pid) { toast('Open a project first, then import the environment into Connections.', 'warn'); el.value = ''; return; }
      try {
        const r = await importEnvironmentFile(pid, f);
        await QA.state.reloadProjects();
        envImportToast(r);
        QA.router.go(`/projects/${pid}?tab=connection`);
      } catch (err) { toastError(err, 'Environment import failed'); }
      el.value = '';
    }));
    return null;
  }

  function projectFields(p) {
    const envs = QA.state.meta.environments;
    return h`<div class="stack project-fields">
      <div class="card"><div class="card-head"><h2>1. About this project</h2><span class="sub">Shown in the sidebar and reports</span></div><div class="card-body form-grid">
        <label class="field full"><span>Project name</span><input class="input" name="name" value="${p ? p.name : ''}" required placeholder="e.g. Acme Sales Cloud — QA"><small>A name your testers will recognise.</small></label>
        <label class="field full"><span>What is this project for?</span><textarea class="input wrap" name="description" rows="2" placeholder="e.g. API tests for the QA sandbox used by the sales team">${p ? p.description || '' : ''}</textarea></label>
        <label class="field"><span>Environment</span><select class="select" name="environment">${envs.map((e) => h`<option ${p && p.environment === e ? 'selected' : (!p && e === 'QA') ? 'selected' : ''}>${e}</option>`)}</select><small>Production is read-only unless you confirm every change.</small></label>
        <label class="field"><span>How should we connect?</span><select class="select" name="mode"><option value="live" ${!p || p.mode !== 'demo' ? 'selected' : ''}>Live Salesforce (browser login)</option><option value="demo" ${p && p.mode === 'demo' ? 'selected' : ''}>Try the demo (no real org needed)</option></select><small>Live uses the org login URL — you sign in in the browser on Connections. Pick Demo only to explore without an org.</small></label>
      </div></div>
      <div class="card"><div class="card-head"><h2>2. Salesforce (backend APIs)</h2><span class="sub">Org REST, Apex REST — no passwords on this screen. You can finish this on Connections after create.</span></div><div class="card-body form-grid">
        <label class="field"><span>Org nickname</span><input class="input" name="sfOrg" value="${p ? p.sfOrg || '' : ''}" placeholder="acme--qa"><small>Optional. Example: acme--qa</small></label>
        <label class="field"><span>API version</span><input class="input mono" name="apiVersion" value="${p ? p.apiVersion : '62.0'}" placeholder="62.0"><small>Usually 62.0 unless your org uses another.</small></label>
        <label class="field full"><span>Salesforce login URL</span><input class="input mono" name="instanceUrl" value="${p ? p.instanceUrl || '' : ''}" placeholder="https://login.salesforce.com"><small>My Domain, sandbox, login.salesforce.com, or an SFCC / Business Manager host. You log in in the browser next — do not paste a token.</small></label>
        <label class="field"><span>Secret prefix (optional)</span><input class="input mono" name="credentialRef" value="${p ? p.credentialRef || '' : ''}" placeholder="ACME_QA"><small>Advanced. Browser login does not need this. Never paste a secret.</small></label>
      </div></div>
      <div class="card"><div class="card-head"><h2>3. Jira (tickets → tests)</h2><span class="sub">Optional now — you can add this later</span></div><div class="card-body form-grid">
        <label class="field"><span>Jira site</span><input class="input mono" name="jiraUrl" value="${p ? p.jiraUrl || '' : ''}" placeholder="https://your-company.atlassian.net"></label>
        <label class="field"><span>Jira project key</span><input class="input mono" name="jiraProjectKey" value="${p ? p.jiraProjectKey || '' : ''}" placeholder="SALES"><small>The short key on tickets, e.g. SALES-123.</small></label>
        <label class="field"><span>Jira secret prefix</span><input class="input mono" name="jiraCredentialRef" value="${p ? p.jiraCredentialRef || '' : ''}" placeholder="optional"><small>Leave blank to use JIRA_EMAIL / JIRA_API_TOKEN.</small></label>
      </div></div>
      <div class="card"><div class="card-head"><h2>4. Postman (frontend / HTTP APIs)</h2><span class="sub">Optional — local collections are reused by default. Connect a workspace later.</span></div><div class="card-body form-grid">
        <label class="field full"><span>Postman workspace name</span><input class="input" name="postmanWorkspace" value="${p && p.integrationConfig && p.integrationConfig.postman ? p.integrationConfig.postman.workspace || '' : ''}" placeholder="Leave blank to reuse local collections"></label>
        ${p ? '' : h`<label class="field full"><span>Import Postman environment</span><input class="input" type="file" name="postmanEnvFile" accept=".json,application/json"><small>Fills empty Connections (login URL, API version, HTTP base, Commerce org, client ids, secrets and tokens).</small></label>`}
      </div></div>
    </div>`;
  }

  async function submitProject(p, root, thenGo) {
    const b = {};
    const envInput = root.querySelector('[name=postmanEnvFile]');
    const envFile = envInput && envInput.files && envInput.files[0];
    root.querySelectorAll('[name]').forEach((i) => {
      if (i.type === 'file') return;
      b[i.name] = i.value.trim() || null;
    });
    if (b.postmanWorkspace !== undefined) {
      b.integrationConfig = { ...((p && p.integrationConfig) || {}), postman: { ...((p && p.integrationConfig && p.integrationConfig.postman) || {}), workspace: b.postmanWorkspace || '' } };
      delete b.postmanWorkspace;
    }
    if (!b.name) { toast('Please enter a project name.', 'warn'); return; }
    const r = p ? await api.put(`/api/projects/${p.id}`, b) : await api.post('/api/projects', b);
    if (!p && envFile) {
      try {
        const imported = await importEnvironmentFile(r.id, envFile);
        envImportToast(imported);
      } catch (err) { toastError(err, 'Project created; environment was not applied'); }
    } else {
      toast(p ? `${r.name} saved.` : `${r.name} created. Next: check Salesforce and Postman status, then Connect if needed.`, 'ok');
    }
    await QA.state.reloadProjects();
    if (!p) QA.state.setProject(r.id);
    QA.router.go(thenGo || `/projects/${r.id}?tab=${p ? 'overview' : 'connection'}`);
    return r;
  }

  function renderCreate(view) {
    QA.router.setCrumbs([{ label: 'Projects', href: '/projects' }, { label: 'New project' }]);
    view.innerHTML = String(h`${C.pageHead('New project', 'Takes about a minute. You can use the built-in demo, or point at a real Salesforce org and Jira site.', h`<a class="btn" href="/projects" data-link>Back to projects</a><button class="btn primary" data-go>${ic('plus')} Create project</button>`)}
      ${C.pageIntro({ what: 'A project is the container for everything that follows: Jira tickets, Salesforce backend APIs, HTTP/Postman frontend APIs, tests, runs and defects.', next: 'Fill in a name and environment. Choose Demo if you want to click through without credentials. Click Create project, then open Connections.' })}
      <div data-form>${projectFields(null)}</div>
      <div class="form-actions mt"><a class="btn" href="/projects" data-link>Cancel</a><button class="btn primary" data-go>${ic('plus')} Create project</button></div>`);
    const go = (e, el) => withBusy(el, () => submitProject(null, view).catch((err) => toastError(err, 'Project not created')));
    on(view, 'click', '[data-go]', go);
    return null;
  }

  function projectForm(p) {
    if (!p) { QA.router.go('/projects/new'); return; }
    modal({
      title: `Edit ${p.name}`, size: 'wide',
      subtitle: 'Change the name, environment, or how this project connects. Passwords are never stored here.',
      body: projectFields(p),
      foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Save project</button>`,
      onMount(el, close) {
        el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
          try {
            await submitProject(p, el, `/projects/${p.id}`);
            close();
          } catch (err) { toastError(err, 'Project not saved'); }
        }));
      },
    });
  }

  async function renderDetail(view, id, query = {}) {
    QA.router.setCrumbs([{ label: 'Projects', href: '/projects' }, { label: id }]);
    view.innerHTML = String(loading(10));
    let p; let conn;
    try { [p, conn] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]); } catch (e) { view.innerHTML = String(errorBox(e)); return null; }
    QA.router.setCrumbs([{ label: 'Projects', href: '/projects' }, { label: p.name }]);
    const tabQ = typeof query === 'string' ? query : query.tab;
    const focus = typeof query === 'string' ? '' : (query.focus || '');
    let tab = tabQ || 'overview';
    const cfgTabs = { integration: ['integrationConfig', 'Integration endpoints, middleware and mappings used to generate integration tests.'], business: ['businessConfig', 'SLA, critical objects, low-privilege expectations and SOQL templates. These drive prioritisation and security tests.'], testdata: ['testDataConfig', 'Automatic cleanup and default variables available to tests as {{name}}. For SFCC SLAS/SCAPI, set organization_id here or on Connections → Commerce Cloud (Realm / org ID).'], notifications: ['notificationConfig', 'Who is notified when runs complete.'] };
    view.innerHTML = String(h`${C.pageHead(p.name, h`${p.environment} · ${p.sfOrg || 'no org alias'} · API v${p.apiVersion} · ${p.mode === 'demo' ? 'Demo (no live org)' : 'Live org'}`,
      h`${p.id !== QA.state.projectId ? h`<button class="btn" data-act="use">Work in this project</button>` : h`<span class="tag">Current project</span>`}<a class="btn" href="/workflow" data-link>${ic('layers')} How QA works</a><button class="btn" data-act="edit">${ic('edit')} Edit</button><button class="btn" data-act="archive">Archive</button><button class="btn danger-outline" data-act="delete">${ic('trash')} Delete</button>`)}
      ${C.pageIntro({ what: 'This workspace covers Salesforce backend APIs (org, Apex REST) and HTTP/Postman frontend APIs (custom REST, storefront, BFF). Connections, tests and reports hang off it.', next: 'Open Connections to see status, then Connect or Test. How QA works walks through tickets → tests. Secrets stay in .env.' })}
      ${p.environment === 'Production' ? h`<div class="callout error">${ic('shield')}<div class="small wrap"><b>Production project.</b> Read-only by default. Generated suites contain read-only smoke tests; any write requires explicit confirmation and DELETE a second confirmation. Test data is never created or deleted automatically.</div></div>` : ''}
      <div data-tabs></div><div data-pane></div>`);
    const TABS = [{ id: 'overview', label: 'Overview' }, { id: 'connection', label: 'Connections' }, { id: 'integration', label: 'Other systems' }, { id: 'business', label: 'Business rules' }, { id: 'testdata', label: 'Test data' }, { id: 'notifications', label: 'Notifications' }];
    const connUi = { sf: 'status', pm: 'status', pw: 'status', jira: 'status', cc: 'status', cursor: 'status', gemini: 'status' };
    const lastTest = { salesforce: null, postman: null, playwright: null, jira: null, commerce: null, cursor: null, gemini: null };
    const lastEnvImport = { result: null, error: null };
    const wiz = { sfMode: null, pmSrc: null };
    const pane = view.querySelector('[data-pane]');
    const draw = () => {
      view.querySelector('[data-tabs]').innerHTML = String(C.tabs(TABS, tab));
      if (tab === 'overview') {
        pane.innerHTML = String(h`<div class="grid g-2"><div class="card"><div class="card-head"><h2>Configuration</h2></div><div class="card-body">${C.kv([['Project id', h`<span class="mono">${p.id}</span>`], ['Environment', p.environment], ['Org kind', p.orgKind || 'core'], ['Salesforce org', p.sfOrg], ['Instance URL', p.instanceUrl ? h`<span class="mono small wrap">${p.instanceUrl}</span>` : null], ['API version', p.apiVersion], ['Jira project', p.jiraProjectKey], ['Jira URL', p.jiraUrl ? h`<span class="mono small wrap">${p.jiraUrl}</span>` : null], ['Postman collection', p.postmanCollection ? h`<span class="mono small wrap">${p.postmanCollection}</span>` : null], ['Automation repo', p.automationRepo ? h`<span class="wrap">${p.automationRepo}</span>` : null], ['Created', fmt.date(p.createdAt)]])}</div></div>
          <div class="card"><div class="card-head"><h2>Activity</h2></div><div class="card-body">${C.kv([['Test cases', fmt.num(p.stats.tests)], ['Last run', p.stats.lastRun ? h`<a href="/execution/${p.stats.lastRun.id}" data-link class="mono">${p.stats.lastRun.id}</a> · ${p.stats.lastRun.passed}/${p.stats.lastRun.total} passed · ${fmt.ago(p.stats.lastRun.startedAt)}` : 'Never'], ['Pass rate (last run)', p.stats.passRate === null || p.stats.passRate === undefined ? '–' : `${p.stats.passRate}%`], ['Salesforce (backend)', connDot(p.connection.salesforce)], ['HTTP / Postman (frontend)', connDot(p.connection.postman || { status: 'unavailable', label: 'Local collections' })], ['Jira', connDot(p.connection.jira)], ['Commerce Cloud', connDot(p.connection.commerce || { status: 'off', label: 'Not enabled' })], ['Metadata provenance', prov(p.connection.metadataLabel)]])}</div></div></div>`);
      } else if (tab === 'connection') {
        const c = conn.credentials;
        const mcp = conn.salesforceMcp || {};
        const cc = conn.commerce || {};
        const pre = c.salesforce.prefix || 'SF_<PREFIX>_';
        const row = (name, present, note) => h`<tr><td class="mono small">${name}</td><td>${present ? h`<span class="badge ok">Set</span>` : h`<span class="badge plain">Not set</span>`}</td><td class="small muted">${note || ''}</td></tr>`;
        const secretHint = conn.loopback
          ? 'This server is on loopback, so you can write secrets to local .env from here. They are never stored in the database or returned to the browser.'
          : 'Secrets stay in .env / your secret manager. Saving them from the UI is disabled because this server is not loopback-only.';
        const sf = p.connection.salesforce;
        const pm = p.connection.postman || { status: 'unavailable', label: 'Local collections' };
        const sfMode = wiz.sfMode || p.mode || 'demo';
        const pmSrc = wiz.pmSrc || ((conn.postman && conn.postman.workspace) ? 'workspace' : 'local');
        const envTable = (rows) => h`<div class="table-wrap mt"><table class="t"><thead><tr><th>Environment variable</th><th>Status</th><th>Purpose</th></tr></thead><tbody>${rows}</tbody></table></div>`;
        const sfDet = conn.salesforceDetection || {};
        const sfTypes = (sf.types && sf.types.length ? sf.types : (sfDet.types || []));
        const sfStatus = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker">${C.layerTag('backend')}<h2>Salesforce</h2><span class="sub">Browser login · Core, Experience Cloud B2B/B2C, SFCC B2B/B2C (separate orgs)</span></div>${connDot(sf)}</div><div class="card-body">
            <p class="conn-status-line wrap">${sf.status === 'demo' || p.mode === 'demo' ? 'Demo — backend tests use the simulator, no live org.' : sf.status === 'connected' || sf.status === 'configured' ? (sf.label || 'Salesforce is connected.') : (sf.label || 'Not connected.')}</p>
            ${C.kv([['Mode', p.mode === 'demo' ? 'Demo (no org)' : 'Live org'], ['Org kind', p.orgKind || sf.orgKind || sfDet.orgKind || '—'], ['Login URL', p.instanceUrl ? h`<span class="mono small wrap">${p.instanceUrl}</span>` : '—'], ['Detected APIs', sfTypes.length ? sfTypes.join(' · ') : '—'], ['Org id', sf.orgId || sfDet.orgId || '—'], ['Edition', sf.edition || sfDet.edition || '—'], ['Last test', lastTest.salesforce ? plainSf(lastTest.salesforce).text : 'Not tested yet']])}
            ${sf.explanation || sfDet.explanation ? h`<p class="small muted mt wrap">${sf.explanation || sfDet.explanation}</p>` : ''}
            <p class="small muted mt">${p.mode === 'demo' || sf.status === 'demo' ? 'Test the demo, or Log in to a live org (opens the Salesforce login page).' : (sf.status === 'connected' || sf.status === 'configured' ? 'Logged in. Test to refresh identity and detected API types. Edit only for MCP / optional connected-app.' : 'Enter the org URL and Log in. A browser window opens — finish signing in there, then Test. Do not paste an API key.')}</p>
            <div class="form-actions mt">
              <button class="btn primary" data-act="test">${ic('refresh')} Test connection</button>
              <button class="btn" data-act="login-sf">${ic('link')} Log in</button>
              <button class="btn" data-open="sf">${ic('link')} Connect</button>
              <button class="btn" data-conn-edit="sf">${ic('edit')} Edit</button>
            </div>
            <div data-out="sf">${resultCallout(plainSf(lastTest.salesforce))}</div>
          </div></div>`;
        const sfWizard = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker">${C.layerTag('backend')}<h2>${connUi.sf === 'edit' ? 'Edit Salesforce' : 'Connect Salesforce'}</h2><span class="sub">Log in in the browser. Tokens stay in Salesforce CLI.</span></div>${connDot(sf)}</div><div class="card-body wizard-steps">
            <div><div class="small muted" style="margin-bottom:8px">1. Demo or live org</div>
              <div class="choice-row">
                <button type="button" class="choice ${sfMode === 'demo' ? 'on' : ''}" data-sf-mode="demo"><b>Demo (no org)</b><p class="cell-sub">Explore backend APIs on the simulator.</p></button>
                <button type="button" class="choice ${sfMode === 'live' ? 'on' : ''}" data-sf-mode="live"><b>Live org</b><p class="cell-sub">Login URL, then browser sign-in.</p></button>
              </div>
              <input type="hidden" name="mode" value="${sfMode}">
            </div>
            <div data-sf-live class="${sfMode === 'live' ? '' : 'hidden'}">
              <div class="small muted" style="margin-bottom:8px">2. Org login URL</div>
              <div class="form-grid">
                <label class="field full"><span>Salesforce login URL</span><input class="input mono" name="instanceUrl" value="${p.instanceUrl || ''}" placeholder="https://login.salesforce.com"><small>My Domain, sandbox, login.salesforce.com, or SFCC (*.demandware.net / *.commercecloud.salesforce.com / Account Manager). Log in opens that page.</small></label>
                <label class="field"><span>Org alias (optional)</span><input class="input mono" name="sfOrg" value="${p.sfOrg || ''}" placeholder="acme--qa"><small>CLI alias after web login. Leave blank to use the project id.</small></label>
              </div>
            </div>
            <input type="hidden" name="apiVersion" value="${p.apiVersion || '62.0'}">
            <details class="adv-block" ${connUi.sf === 'edit' ? 'open' : ''}><summary>Advanced — MCP, connected-app (optional)</summary>
              <div class="adv-body">
                <div class="form-grid">
                  <label class="field full"><span>MCP HTTP URL</span><input class="input mono" name="mcpUrl" value="${mcp.url || ''}" placeholder="http://127.0.0.1:7443/mcp"><small>Streamable HTTP MCP for live describe/SOQL.</small></label>
                  <label class="field full"><span>MCP stdio command</span><input class="input mono" name="mcpCommand" value="${mcp.command || ''}" placeholder="npx -y @salesforce/mcp"></label>
                  <label class="field"><span>CLI org alias</span><input class="input mono" name="cliTarget" value="${(conn.salesforceCli && conn.salesforceCli.targetOrg) || p.sfOrg || ''}"></label>
                  <label class="field"><span>API version</span><input class="input mono" name="apiVersionAdv" value="${p.apiVersion || '62.0'}"></label>
                  <label class="field"><span>Credential prefix (optional)</span><input class="input mono" name="credentialRef" value="${p.credentialRef || ''}" placeholder="ACME_QA"><small>Only if you use a connected app in .env. Browser login does not need this.</small></label>
                </div>
                ${conn.loopback ? h`<div class="form-grid mt"><label class="field"><span>Auth flow</span><select class="select" name="sfAuthFlow"><option value="">—</option>${['client_credentials', 'jwt', 'refresh_token'].map((f) => h`<option ${c.salesforce.authFlow === f ? 'selected' : ''}>${f}</option>`)}</select></label>
                  <label class="field"><span>Connected-app client id</span><input class="input mono" name="sfClientId" autocomplete="off"></label>
                  <label class="field"><span>Client secret</span><input class="input mono" type="password" name="sfClientSecret" autocomplete="new-password"></label>
                  <label class="field"><span>Refresh token</span><input class="input mono" type="password" name="sfRefreshToken" autocomplete="new-password"></label></div>` : ''}
                <p class="small muted mt">${secretHint}</p>
                ${envTable(h`${row(`${pre}AUTH_FLOW`, Boolean(c.salesforce.authFlow), c.salesforce.authFlow ? `Flow: ${c.salesforce.authFlow}` : 'client_credentials | jwt | refresh_token')}
                  ${row(`${pre}CLIENT_ID`, c.salesforce.clientId, 'Connected app consumer key')}
                  ${row(`${pre}CLIENT_SECRET`, c.salesforce.clientSecret, 'OAuth secret')}
                  ${row(`${pre}MCP_URL`, c.salesforce.mcpUrl, 'Salesforce MCP HTTP endpoint')}
                  ${row(`${pre}MCP_COMMAND`, c.salesforce.mcpCommand, 'Salesforce MCP stdio command')}
                  ${row(`${pre}LOWPRIV_*`, c.salesforce.lowPrivilegeUser, 'Optional restricted user for FLS tests')}`)}
              </div>
            </details>
            <div class="form-actions">
              <button class="btn primary" data-act="login-sf">${ic('link')} Log in</button>
              <button class="btn" data-act="test">${ic('refresh')} Test Salesforce</button>
              <button class="btn" data-act="save-sf">${ic('check')} Save</button>
              <button class="btn" data-cancel="sf">Done</button>
            </div>
            <div data-out="sf">${resultCallout(plainSf(lastTest.salesforce))}</div>
          </div></div>`;
        const pmStatus = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker">${C.layerTag('frontend')}<h2>Postman / HTTP</h2><span class="sub">Custom REST, storefront, middleware, BFF</span></div>${connDot(pm)}</div><div class="card-body">
            <p class="conn-status-line wrap">${pm.status === 'demo' || p.mode === 'demo' ? 'Demo / local collections — ready for frontend HTTP API tests.' : (conn.postman && conn.postman.workspace) ? `Workspace “${conn.postman.workspace}” is configured.` : (pm.label || 'Local collections can be reused.')}</p>
            ${C.kv([['Source', (conn.postman && conn.postman.workspace) ? 'Postman workspace' : 'Local collections'], ['Workspace', (conn.postman && conn.postman.workspace) || '—'], ['Collection in use', (pm.collectionId || (conn.postman && conn.postman.collectionId)) ? h`<span class="mono small wrap">${pm.collectionId || conn.postman.collectionId}</span>` : 'None — Approve will create one unless you pick an existing collection'], ['Reuse existing', pm.reuseExisting || (conn.postman && conn.postman.reuseExisting) ? 'Yes' : 'No'], ['HTTP base URL', (conn.http && conn.http.baseUrl) || ((p.connection && p.connection.http && p.connection.http.baseUrl) || '—')], ['Last test', lastTest.postman ? plainPm(lastTest.postman).text : 'Not tested yet']])}
            <p class="small muted mt">${pm.status === 'configured' || pm.status === 'demo' || pm.status === 'connected' ? 'Use an existing collection on this project, then Run executes that collection. Saving Postman settings keeps the link.' : 'Reuse local collections by default, or Connect a workspace / MCP and pick an existing collection.'}</p>
            <div class="form-actions mt">
              <button class="btn primary" data-act="test-pm">${ic('refresh')} Test Postman</button>
              <button class="btn" data-act="pick-col">${ic('folder')} Use existing collection</button>
              <button class="btn" data-open="pm">${ic('link')} Connect</button>
              <button class="btn" data-conn-edit="pm">${ic('edit')} Edit</button>
              <a class="btn" href="/workflow/postman" data-link>Discover collections</a>
            </div>
            <div data-out="pm">${resultCallout(plainPm(lastTest.postman))}</div>
          </div></div>`;
        const pmWizard = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker">${C.layerTag('frontend')}<h2>${connUi.pm === 'edit' ? 'Edit Postman' : 'Connect Postman'}</h2><span class="sub">MCP runs approved collections. API key stays in .env.</span></div>${connDot(pm)}</div><div class="card-body wizard-steps">
            <div><div class="small muted" style="margin-bottom:8px">1. Where should we look?</div>
              <div class="choice-row">
                <button type="button" class="choice ${pmSrc === 'local' ? 'on' : ''}" data-pm-src="local"><b>Reuse local collections</b><p class="cell-sub">Default. Files under api-tests/collections/.</p></button>
                <button type="button" class="choice ${pmSrc === 'workspace' ? 'on' : ''}" data-pm-src="workspace"><b>Connect Postman workspace</b><p class="cell-sub">Search an existing workspace before creating anything.</p></button>
              </div>
            </div>
            <div data-pm-ws class="${pmSrc === 'workspace' ? '' : 'hidden'}">
              <div class="small muted" style="margin-bottom:8px">2. Workspace</div>
              <div class="form-grid">
                <label class="field"><span>Workspace name</span><input class="input" name="pmWorkspace" value="${(conn.postman && conn.postman.workspace) || ''}" placeholder="Workspace name or id"></label>
                <label class="field"><span>Environment name</span><input class="input" name="pmEnvironment" value="${(conn.postman && conn.postman.environment) || p.environment}"></label>
              </div>
            </div>
            <div>
              <div class="small muted" style="margin-bottom:8px">Frontend HTTP origin (same runner as Salesforce tests)</div>
              <div class="form-grid">
                <label class="field full"><span>HTTP base URL</span><input class="input mono" name="httpBaseUrl" value="${(conn.http && conn.http.baseUrl) || ''}" placeholder="https://api.your-bff.example"><small>Used for custom REST / BFF / middleware. Absolute https URLs on tests still run without this. Bearer token stays in .env as HTTP_&lt;PREFIX&gt;_TOKEN.</small></label>
                ${conn.loopback ? h`<label class="field full"><span>HTTP bearer token (optional, .env only)</span><input class="input mono" type="password" name="httpToken" autocomplete="new-password"></label>` : ''}
              </div>
            </div>
            <details class="adv-block" ${connUi.pm === 'edit' ? 'open' : ''}><summary>Advanced — MCP URL, command, API key</summary>
              <div class="adv-body">
                <div class="form-grid">
                  <label class="field full"><span>Postman MCP HTTP URL</span><input class="input mono" name="pmMcpUrl" value="${(conn.postman && conn.postman.mcpUrl) || ''}" placeholder="http://127.0.0.1:8765/mcp"></label>
                  <label class="field full"><span>Postman MCP stdio command</span><input class="input mono" name="pmMcpCommand" value="${(conn.postman && conn.postman.mcpCommand) || ''}" placeholder="npx -y @postman/postman-mcp-server"></label>
                  ${conn.loopback ? h`<label class="field full"><span>Postman API key (optional, .env only)</span><input class="input mono" type="password" name="pmApiKey" autocomplete="new-password"></label>` : ''}
                </div>
                <p class="small muted mt">${secretHint} Prefer <code>${(c.postman && c.postman.prefix) || 'POSTMAN_'}API_KEY</code> / <code>MCP_URL</code> / <code>MCP_COMMAND</code> in .env. After Approve, Run uses this MCP (<code>runCollection</code>).</p>
              </div>
            </details>
            <div class="form-actions">
              <button class="btn primary" data-act="test-pm">${ic('refresh')} Test Postman</button>
              <button class="btn" data-act="save-pm">${ic('check')} Save Postman connection</button>
              <button class="btn" data-act="pick-col">${ic('folder')} Use existing collection</button>
              <button class="btn" data-cancel="pm">Done</button>
              <a class="btn" href="/workflow/postman" data-link>Discover collections</a>
            </div>
            <div data-out="pm">${resultCallout(plainPm(lastTest.postman))}</div>
          </div></div>`;
        const pw = p.connection.playwright || { status: 'off', label: 'Not connected' };
        const pwCfg = conn.playwright || {};
        const pwStatus = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker"><h2>Playwright MCP</h2><span class="sub">API testing runner (GET/POST/PUT/PATCH/DELETE)</span></div>${connDot(pw)}</div><div class="card-body">
            <p class="conn-status-line wrap">${pw.label || 'Not connected.'}</p>
            ${C.kv([['MCP URL', pwCfg.mcpUrl ? h`<span class="mono small wrap">${pwCfg.mcpUrl}</span>` : '—'], ['Command', pwCfg.mcpCommand ? h`<span class="mono small wrap">${pwCfg.mcpCommand}</span>` : 'Default on Test if enabled'], ['Last test', lastTest.playwright ? (lastTest.playwright.ok ? `Pass — ${lastTest.playwright.title || 'connected'}` : `Fail — ${lastTest.playwright.title || 'not connected'}`) : 'Not tested yet']])}
            <p class="small muted mt">Uses ExecuteAutomation Playwright MCP (<code>playwright_get</code> / <code>post</code> / <code>put</code> / <code>patch</code> / <code>delete</code>). Official Microsoft Playwright MCP is browser-only. Pick this runner when you start a run.</p>
            <div class="form-actions mt">
              <button class="btn primary" data-act="test-pw">${ic('refresh')} Test Playwright</button>
              <button class="btn" data-open="pw">${ic('link')} Connect</button>
              <button class="btn" data-conn-edit="pw">${ic('edit')} Edit</button>
            </div>
            <div data-out="pw">${resultCallout(lastTest.playwright ? { ok: lastTest.playwright.ok, text: lastTest.playwright.title || (lastTest.playwright.ok ? 'Connected' : 'Not connected') } : null)}</div>
          </div></div>`;
        const pwWizard = () => h`<div class="card conn-card"><div class="card-head"><h2>${connUi.pw === 'edit' ? 'Edit Playwright MCP' : 'Connect Playwright MCP'}</h2>${connDot(pw)}</div><div class="card-body">
            <p class="small muted wrap">stdio command is enough. The server starts on demand. HTTP URL is optional if you already run the MCP yourself.</p>
            <div class="form-grid">
              <label class="field full"><span>Playwright MCP stdio command</span><input class="input mono" name="pwMcpCommand" value="${pwCfg.mcpCommand || ''}" placeholder="npx -y @executeautomation/playwright-mcp-server"></label>
              <label class="field full"><span>Playwright MCP HTTP URL (optional)</span><input class="input mono" name="pwMcpUrl" value="${pwCfg.mcpUrl || ''}" placeholder="http://127.0.0.1:8931/mcp"></label>
            </div>
            <p class="small muted mt">${secretHint} Prefer <code>${(c.playwright && c.playwright.prefix) || 'PLAYWRIGHT_'}MCP_COMMAND</code> / <code>MCP_URL</code> in .env.</p>
            <div class="form-actions">
              <button class="btn primary" data-act="test-pw">${ic('refresh')} Test Playwright</button>
              <button class="btn" data-act="save-pw">${ic('check')} Save Playwright connection</button>
              <button class="btn" data-cancel="pw">Done</button>
            </div>
            <div data-out="pw">${resultCallout(lastTest.playwright ? { ok: lastTest.playwright.ok, text: lastTest.playwright.title || (lastTest.playwright.ok ? 'Connected' : 'Not connected') } : null)}</div>
          </div></div>`;
        const jiraStatus = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker"><h2>Jira</h2><span class="sub">Tickets → API scripts (optional)</span></div>${connDot(p.connection.jira)}</div><div class="card-body">
            <p class="conn-status-line wrap">${p.connection.jira.label}</p>
            ${C.kv([['Site', p.jiraUrl ? h`<span class="mono small wrap">${p.jiraUrl}</span>` : '—'], ['Project', p.jiraProjectKey || '—'], ['Last test', lastTest.jira ? plainOther('Jira', lastTest.jira).text : 'Not tested yet']])}
            <div class="form-actions mt">
              <button class="btn" data-act="test-jira">${ic('refresh')} Test connection</button>
              <button class="btn" data-open="jira">${ic('link')} Connect</button>
              <button class="btn" data-conn-edit="jira">${ic('edit')} Edit</button>
            </div>
            <div data-out="jira">${resultCallout(plainOther('Jira', lastTest.jira))}</div>
          </div></div>`;
        const jiraWizard = () => h`<div class="card conn-card"><div class="card-head"><h2>${connUi.jira === 'edit' ? 'Edit Jira' : 'Connect Jira'}</h2>${connDot(p.connection.jira)}</div><div class="card-body">
            <div class="form-grid">
              <label class="field"><span>Jira URL</span><input class="input mono" name="jiraUrl" value="${p.jiraUrl || ''}" placeholder="https://your-company.atlassian.net"></label>
              <label class="field"><span>Jira project key</span><input class="input mono" name="jiraProjectKey" value="${p.jiraProjectKey || ''}" placeholder="PROJ"></label>
              <label class="field"><span>Jira credential prefix</span><input class="input mono" name="jiraCredentialRef" value="${p.jiraCredentialRef || ''}" placeholder="optional"></label>
              <label class="field full"><span>Default JQL</span><textarea class="input mono" rows="2" name="jql" placeholder="project = ${p.jiraProjectKey || 'PROJ'} AND issuetype in (Story, Task, Bug) ORDER BY updated DESC"></textarea></label>
              <label class="field"><span>Ticket key (optional)</span><input class="input mono" name="storyKey" placeholder="${p.jiraProjectKey || 'PROJ'}-123"><small>Leave empty only when you intend to generate for every matching ticket.</small></label>
              ${conn.loopback ? h`<label class="field"><span>Jira email</span><input class="input" name="jiraEmail" autocomplete="off"></label><label class="field"><span>Jira API token</span><input class="input mono" type="password" name="jiraApiToken" autocomplete="new-password"></label>` : ''}
            </div>
            <div class="form-actions mt">
              <button class="btn" data-act="test-jira">${ic('refresh')} Test connection</button>
              <button class="btn" data-act="save-jira">${ic('check')} Save Jira connection</button>
              <button class="btn" data-act="sync-jira">${ic('refresh')} Sync tickets</button>
              <button class="btn" data-act="gen-jira-all">${ic('wand')} Generate for all matching tickets</button>
              <button class="btn primary" data-act="gen-jira">${ic('wand')} Generate API scripts</button>
              <button class="btn" data-cancel="jira">Done</button>
            </div>
            <p class="small muted mt">Enter a ticket key to generate for that ticket only. Generate for all matching tickets is a separate action. Proposals still need review — nothing is written to Jira unless you approve with “post to Jira”. Sync-and-generate never auto-approves.</p>
            ${connUi.jira === 'edit' ? envTable(h`${row(`${c.jira.prefix || 'JIRA_'}EMAIL`, c.jira.configured, 'Atlassian account email')}${row(`${c.jira.prefix || 'JIRA_'}API_TOKEN`, c.jira.configured, 'Atlassian API token')}`) : ''}
            <div data-out="jira">${resultCallout(plainOther('Jira', lastTest.jira))}</div>
          </div></div>`;
        const ccStatus = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker"><h2>Commerce Cloud</h2><span class="sub">OCAPI / SCAPI (optional)</span></div>${connDot(p.connection.commerce || { status: 'off', label: 'Off' })}</div><div class="card-body">
            <p class="conn-status-line wrap">${(p.connection.commerce && p.connection.commerce.label) || 'Not enabled.'}</p>
            ${C.kv([['Host', cc.host || '—'], ['Site', cc.siteId || '—'], ['Realm / org ID', cc.orgId || '—'], ['Short code', cc.shortCode || '—'], ['Detected', (p.connection.commerce && p.connection.commerce.types && p.connection.commerce.types.length) ? p.connection.commerce.types.join(' · ') : (cc.enabled ? 'Enabled' : 'Off')], ['Last test', lastTest.commerce ? plainOther('Commerce Cloud', lastTest.commerce).text : 'Not tested yet']])}
            <div class="form-actions mt">
              <button class="btn" data-act="test-cc">${ic('refresh')} Test connection</button>
              <button class="btn" data-open="cc">${ic('link')} Connect</button>
              <button class="btn" data-conn-edit="cc">${ic('edit')} Edit</button>
            </div>
            <div data-out="cc">${resultCallout(plainOther('Commerce Cloud', lastTest.commerce))}</div>
          </div></div>`;
        const ccWizard = () => h`<div class="card conn-card"><div class="card-head"><h2>${connUi.cc === 'edit' ? 'Edit Commerce Cloud' : 'Connect Commerce Cloud'}</h2>${connDot(p.connection.commerce || { status: 'off', label: 'Off' })}</div><div class="card-body">
            <label class="field"><span class="check-row"><input type="checkbox" name="ccEnabled" ${cc.enabled ? 'checked' : ''}> Enable Commerce Cloud API testing on this project</span></label>
            <div class="form-grid mt">
              <label class="field"><span>OCAPI host</span><input class="input mono" name="ccHost" value="${cc.host || ''}" placeholder="xyz-001.dx.commercecloud.salesforce.com"></label>
              <label class="field"><span>Site ID</span><input class="input mono" name="ccSiteId" value="${cc.siteId || ''}" placeholder="RefArch"></label>
              <label class="field"><span>Realm / org ID</span><input class="input mono" name="ccOrgId" value="${cc.orgId || ''}" placeholder="f_ecom_zzte_001"><small>Fills <code>{{organization_id}}</code> and <code>{{organizationId}}</code> on SLAS/SCAPI requests (Get Access Token). Same value as in the Postman environment — not a .env secret.</small></label>
              <label class="field"><span>SCAPI short code</span><input class="input mono" name="ccShortCode" value="${cc.shortCode || ''}" placeholder="kv7kzm78"></label>
              <label class="field"><span>OCAPI version</span><input class="input mono" name="ccOcapiVersion" value="${cc.ocapiVersion || 'v24_5'}"></label>
              <label class="field"><span>Sample product id</span><input class="input mono" name="ccSampleProductId" value="${cc.sampleProductId || 'apple-iphone-15'}"></label>
              <label class="field"><span>SFCC credential prefix</span><input class="input mono" name="ccCredentialRef" value="${cc.credentialRef || p.credentialRef || ''}" placeholder="GLOBEX"></label>
              ${conn.loopback ? h`<label class="field"><span>SLAS / OCAPI client id</span><input class="input mono" name="ccClientId" autocomplete="off"></label>
              <label class="field"><span>Client secret</span><input class="input mono" type="password" name="ccClientSecret" autocomplete="new-password"></label>` : ''}
            </div>
            <div class="form-actions mt">
              <button class="btn" data-act="test-cc">${ic('refresh')} Test connection</button>
              <button class="btn primary" data-act="save-cc">${ic('check')} Save Commerce Cloud connection</button>
              <button class="btn" data-cancel="cc">Done</button>
            </div>
            ${connUi.cc === 'edit' ? envTable(h`${row(`${c.commerce.prefix || 'SFCC_'}CLIENT_ID`, c.commerce.clientId, 'SLAS or OCAPI client id')}${row(`${c.commerce.prefix || 'SFCC_'}CLIENT_SECRET`, c.commerce.clientSecret, 'SLAS or OCAPI client secret')}`) : ''}
            <div data-out="cc">${resultCallout(plainOther('Commerce Cloud', lastTest.commerce))}</div>
          </div></div>`;
        const cur = conn.cursor || {};
        const gem = conn.gemini || {};
        const cursorLogged = Boolean((p.connection.cursor && p.connection.cursor.loggedIn) || (conn.cursorLogin && conn.cursorLogin.loggedIn) || (lastTest.cursor && lastTest.cursor.loggedIn));
        const geminiLogged = Boolean((p.connection.gemini && p.connection.gemini.loggedIn) || (conn.geminiLogin && conn.geminiLogin.loggedIn) || (lastTest.gemini && lastTest.gemini.loggedIn));
        const cursorStatus = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker"><h2>Cursor</h2><span class="sub">CLI script generator</span></div>${connDot(p.connection.cursor || { status: 'unavailable', label: 'Not logged in' })}</div><div class="card-body">
            <p class="conn-status-line wrap">${(p.connection.cursor && p.connection.cursor.label) || (cursorLogged ? 'Logged in.' : 'Not logged in.')}</p>
            ${C.kv([['CLI', cur.bin || 'auto (cursor / agent)'], ['Login', cursorLogged ? 'Logged in' : 'Not logged in'], ['Last test', lastTest.cursor ? plainCli('Cursor', lastTest.cursor).text : 'Not tested yet']])}
            <p class="small muted mt">Connect runs <code>agent login</code> and opens a browser. Test checks <code>agent whoami</code>. No API key is collected or stored.</p>
            <div class="form-actions mt">
              <button class="btn" data-act="test-cursor">${ic('refresh')} Test connection</button>
              <button class="btn" data-act="login-cursor">${ic('link')} Connect</button>
              <button class="btn" data-conn-edit="cursor">${ic('edit')} Edit</button>
            </div>
            <div data-out="cursor">${resultCallout(plainCli('Cursor', lastTest.cursor))}</div>
          </div></div>`;
        const cursorWizard = () => h`<div class="card conn-card"><div class="card-head"><h2>Edit Cursor</h2>${connDot(p.connection.cursor || { status: 'unavailable', label: 'Not logged in' })}</div><div class="card-body">
            <label class="field"><span class="check-row"><input type="checkbox" name="cursorEnabled" ${cur.enabled ? 'checked' : ''}> Use Cursor CLI to generate API scripts on this project</span></label>
            <div class="form-grid mt">
              <label class="field"><span>CLI binary (optional)</span><input class="input mono" name="cursorBin" value="${cur.bin || ''}" placeholder="agent"><small>Leave blank to auto-detect <code>agent</code> (not the Cursor IDE <code>cursor</code> shim).</small></label>
            </div>
            <p class="small muted mt">Login is browser-based. This app never stores a Cursor API key or token.</p>
            <div class="form-actions mt">
              <button class="btn" data-act="test-cursor">${ic('refresh')} Test Cursor</button>
              <button class="btn primary" data-act="login-cursor">${ic('link')} Log in with Cursor</button>
              <button class="btn" data-act="save-cursor">${ic('check')} Save</button>
              <button class="btn" data-cancel="cursor">Done</button>
            </div>
            <div data-out="cursor">${resultCallout(plainCli('Cursor', lastTest.cursor))}</div>
          </div></div>`;
        const geminiStatus = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker"><h2>Gemini</h2><span class="sub">CLI script generator</span></div>${connDot(p.connection.gemini || { status: 'unavailable', label: 'Not logged in' })}</div><div class="card-body">
            <p class="conn-status-line wrap">${(p.connection.gemini && p.connection.gemini.label) || (geminiLogged ? 'Logged in.' : 'Not logged in.')}</p>
            ${C.kv([['CLI', gem.bin || 'gemini'], ['Login', geminiLogged ? 'Logged in' : 'Not logged in'], ['Last test', lastTest.gemini ? plainCli('Gemini', lastTest.gemini).text : 'Not tested yet']])}
            <p class="small muted mt">Gemini CLI has no login subcommand. Connect opens <code>gemini</code> so you can choose Sign in with Google. Test checks that Google sign-in session. No API key is collected or stored.</p>
            <div class="form-actions mt">
              <button class="btn" data-act="test-gemini">${ic('refresh')} Test connection</button>
              <button class="btn" data-act="login-gemini">${ic('link')} Connect</button>
              <button class="btn" data-conn-edit="gemini">${ic('edit')} Edit</button>
            </div>
            <div data-out="gemini">${resultCallout(plainCli('Gemini', lastTest.gemini))}</div>
          </div></div>`;
        const geminiWizard = () => h`<div class="card conn-card"><div class="card-head"><h2>Edit Gemini</h2>${connDot(p.connection.gemini || { status: 'unavailable', label: 'Not logged in' })}</div><div class="card-body">
            <label class="field"><span class="check-row"><input type="checkbox" name="geminiEnabled" ${gem.enabled ? 'checked' : ''}> Use Gemini CLI to generate API scripts on this project</span></label>
            <div class="form-grid mt">
              <label class="field"><span>CLI binary (optional)</span><input class="input mono" name="geminiBin" value="${gem.bin || ''}" placeholder="gemini"></label>
            </div>
            <p class="small muted mt">Login is Google sign-in in the Gemini CLI. This app never stores a Gemini API key or token.</p>
            <div class="form-actions mt">
              <button class="btn" data-act="test-gemini">${ic('refresh')} Test Gemini</button>
              <button class="btn primary" data-act="login-gemini">${ic('link')} Log in with Google</button>
              <button class="btn" data-act="save-gemini">${ic('check')} Save</button>
              <button class="btn" data-cancel="gemini">Done</button>
            </div>
            <div data-out="gemini">${resultCallout(plainCli('Gemini', lastTest.gemini))}</div>
          </div></div>`;
        const genPref = conn.scriptGenerator || 'auto';
        const docs = conn.contextDocs || [];
        const genDocsCard = () => h`<div class="card conn-card"><div class="card-head"><h2>Script generator</h2><span class="sub">Cursor, then Gemini, then built-in engine</span></div><div class="card-body">
            <p class="small muted wrap">Uses Cursor CLI / Gemini CLI if you are logged in, with the Jira ticket (and project integration docs) as context. You still review and approve. Nothing is auto-posted to Jira.</p>
            ${(() => {
              const g = conn.generators || (QA.state.meta && QA.state.meta.generators) || {};
              return C.kv([
                ['CURSOR_CLI_ENABLED', g.cursorCliEnabled ? 'true' : 'false'],
                ['Cursor CLI installed', g.cursorInstalled ? 'Yes' : 'No — Generate falls back to the engine'],
                ['GEMINI_CLI_ENABLED', g.geminiCliEnabled ? 'true' : 'false'],
                ['Gemini CLI installed', g.geminiInstalled ? 'Yes' : 'No — Generate falls back to the engine'],
                ['scriptGenerator', genPref],
              ]);
            })()}
            <label class="field mt"><span>When both are connected</span>
              <select class="select" name="scriptGenerator">
                <option value="auto" ${genPref === 'auto' ? 'selected' : ''}>Auto (Cursor, then Gemini, then engine)</option>
                <option value="cursor" ${genPref === 'cursor' ? 'selected' : ''}>Cursor</option>
                <option value="gemini" ${genPref === 'gemini' ? 'selected' : ''}>Gemini</option>
                <option value="engine" ${genPref === 'engine' ? 'selected' : ''}>Built-in engine</option>
              </select>
            </label>
            <label class="field mt"><span class="check-row"><input type="checkbox" name="postResultToJira" ${conn.postResultToJira ? 'checked' : ''}> After a run, post a pass/fail comment on the Jira story (never auto-file defects)</span></label>
            <div class="form-actions mt"><button class="btn" data-act="save-gen">${ic('check')} Save generator</button></div>
            <details class="mt"><summary class="small">CLI JSON contract</summary>
              <p class="small muted wrap">CLI generators must reply JSON only. Endpoint must start with <code>/</code>. Auth: default, none, invalid, lowpriv. Assertions: status, jsonpath, header, responseTime, sfError, schema, bodyContains. Unknown sObjects are dropped. No secrets.</p>
              <pre class="code small">${(conn.cliContract && conn.cliContract.shape) || '{ "scenarios": [{ "title", "type", "apiType", "object", "label", "testCases": [{ "title", "method", "endpoint", "assertions", "body", "query" }] }] }'}</pre>
            </details>
            <h3 class="mt">Context docs</h3>
            <p class="small muted">Integration-team notes pasted here (or a local file path) are added to the generate context. Jira remains primary. Secrets are rejected.</p>
            ${docs.length ? h`<ul class="list mt">${docs.map((d) => h`<li class="row wrap" style="gap:8px;align-items:flex-start"><div style="flex:1"><b>${d.name}</b><div class="cell-sub">${(d.body || '').slice(0, 120)}${(d.body || '').length > 120 ? '…' : ''}${d.filePath ? h` · <span class="mono">${d.filePath}</span>` : ''}</div></div><button class="btn xs" data-del-doc="${d.id}">Remove</button></li>`)}</ul>` : h`<p class="small muted mt">No docs yet.</p>`}
            <div class="form-grid mt">
              <label class="field full"><span>Name</span><input class="input" name="docName" placeholder="e.g. Invoice sync mapping"></label>
              <label class="field full"><span>Paste text</span><textarea class="input" rows="4" name="docBody" placeholder="Endpoints, mappings, field notes — no passwords."></textarea></label>
              <label class="field full"><span>Or local file path</span><input class="input mono" name="docPath" placeholder="/Users/you/docs/integration.md"></label>
            </div>
            <div class="form-actions mt"><button class="btn" data-act="add-doc">${ic('plus')} Add document</button></div>
          </div></div>`;
        pane.innerHTML = String(h`${C.connectionNotice(p)}
          <div class="callout info">${ic('layers')}<div class="small wrap"><b>Two API layers on this project.</b> Salesforce is backend (org APIs, Apex REST). Postman / HTTP is frontend (custom REST, storefront, middleware, BFF). Status first — Connect only when you need to change something. Secrets never leave .env.</div></div>
          <div class="card conn-card"><div class="card-head"><h2>Import Postman environment</h2><span class="sub">Fills empty Connections fields from the env file, including credentials.</span></div><div class="card-body">
            <p class="small muted wrap">Login URL, API version, environment name, org alias, HTTP base URL, Commerce orgId / shortCode / siteId, client ids, client secrets, passwords, SLAS/HTTP tokens, and test-data variables. Secret values are stored in Connections and are not shown in this notice.</p>
            <label class="field"><span>Postman environment JSON</span><input class="input" type="file" data-import-env accept=".json,application/json"></label>
            <div data-env-import-out>${lastEnvImport.error ? errorBox(lastEnvImport.error) : lastEnvImport.result ? h`<div class="callout ok">${ic('check')}<div class="small wrap"><b>${lastEnvImport.result.environment && lastEnvImport.result.environment.name ? lastEnvImport.result.environment.name : 'Environment imported'}</b><div>${lastEnvImport.result.notice || (lastEnvImport.result.applied || []).join(' · ') || 'Connections updated.'}</div></div></div>` : ''}</div>
          </div></div>
          <div class="stack project-connect">
            ${connUi.sf === 'status' ? sfStatus() : sfWizard()}
            ${connUi.pm === 'status' ? pmStatus() : pmWizard()}
            ${connUi.pw === 'status' ? pwStatus() : pwWizard()}
            ${connUi.cursor === 'status' ? cursorStatus() : cursorWizard()}
            ${connUi.gemini === 'status' ? geminiStatus() : geminiWizard()}
            ${genDocsCard()}
            <details class="conn-optional" ${(connUi.jira !== 'status' || connUi.cc !== 'status' || (p.connection.commerce && p.connection.commerce.status !== 'off')) ? 'open' : ''}><summary>Optional: Jira and Commerce Cloud</summary>
              <div class="stack mt" style="gap:var(--space-5)">
                ${connUi.jira === 'status' ? jiraStatus() : jiraWizard()}
                ${connUi.cc === 'status' ? ccStatus() : ccWizard()}
              </div>
            </details>
          </div>
          <div data-testout class="mt"></div>`);
      } else if (tab === 'integration') {
        drawIntegration();
      } else {
        const [field, help] = cfgTabs[tab];
        pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>${TABS.find((t) => t.id === tab).label}</h2><span class="small muted">${help}</span></div><div class="card-body">
          <textarea class="input mono" rows="22" data-cfg spellcheck="false" aria-label="${field} JSON">${JSON.stringify(p[field] || {}, null, 2)}</textarea>
          <div class="form-actions mt"><span class="small muted wrap">Secret-looking keys (password, secret, token) are rejected by the server.</span><span class="spacer"></span><button class="btn primary" data-save="${field}">Save</button></div></div></div>`);
      }
    };
    let epItems = [];
    async function drawIntegration() {
      const help = cfgTabs.integration[1];
      pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>Custom endpoints</h2><span class="small muted">${help}</span></div><div class="card-body">${loading(6)}</div></div>`);
      try {
        const r = await api.get(`/api/projects/${p.id}/endpoints`);
        epItems = r.items || [];
        const rest = { ...(p.integrationConfig || {}) };
        delete rest.endpoints;
        pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>Custom Apex REST / HTTP endpoints</h2>
            <div class="row wrap"><button class="btn sm primary" data-ep-add>${ic('plus')} Add endpoint</button>
              <button class="btn sm" data-ep-discover>${ic('search')} Discover Apex REST</button>
              <button class="btn sm" data-ep-openapi>${ic('upload')} Import OpenAPI</button>
              <button class="btn sm" data-ep-postman>${ic('folder')} Promote Postman</button></div></div>
            <div class="card-body"><p class="small wrap">These are custom Apex REST and BFF/middleware URLs used when generating integration tests. Standard REST, Experience Cloud and Commerce Cloud paths come from org detection — do not add them here.</p></div>
            ${epItems.length ? QA.ui.table({ rows: epItems, columns: [
              { key: 'method', label: 'Method', render: (e) => h`<span class="tag mono">${e.method}</span>` },
              { key: 'name', label: 'Endpoint', render: (e) => h`<div class="cell-title">${e.name}</div><div class="cell-sub mono">${e.path}${e.object ? ` · ${e.object}` : ''}</div>` },
              { key: 'source', label: 'Source', render: (e) => h`<span class="tag">${e.source}</span>` },
              { key: 'contract', label: 'Contract', render: (e) => h`<span class="small muted">${e.legacyContract ? 'Legacy SUCCESS / salesforceId' : (e.idPath || e.successPath || e.responseSchema ? 'Custom' : 'Status only')}</span>` },
              { key: 'actions', label: '', cls: 'actions', render: (e) => h`<button class="btn xs" data-ep-edit="${e.id}">${ic('edit')} Edit</button><button class="btn xs ghost" data-ep-del="${e.id}">${ic('trash')}</button>` },
            ] }) : empty({ icon: 'code', title: 'No custom endpoints yet', text: 'Add one, discover @RestResource classes from the org, or import OpenAPI / Postman requests.' })}
          </div>
          <details class="adv-block mt"><summary>Advanced — other integration JSON</summary>
            <div class="adv-body card-body">
              <p class="small muted wrap">Postman, HTTP, Commerce and CLI settings belong on Connections. This JSON is the rest of integrationConfig (endpoints are saved separately).</p>
              <textarea class="input mono" rows="12" data-cfg-rest spellcheck="false">${JSON.stringify(rest, null, 2)}</textarea>
              <div class="form-actions mt"><button class="btn primary" data-ep-save-adv>Save JSON</button></div>
            </div>
          </details>`);
      } catch (e) { pane.innerHTML = String(errorBox(e)); }
    }
    function parseJsonField(raw, label) {
      const t = String(raw || '').trim();
      if (!t) return null;
      try { return JSON.parse(t); } catch (err) { throw Object.assign(new Error(`${label} must be valid JSON: ${err.message}`), { info: { action: `Fix ${label}.` } }); }
    }
    function mappingFromForm(el) {
      const keys = [...el.querySelectorAll('[name="mapKey"]')].map((x) => x.value.trim());
      const vals = [...el.querySelectorAll('[name="mapVal"]')].map((x) => x.value.trim());
      const out = {};
      keys.forEach((k, i) => { if (k && vals[i]) out[k] = vals[i]; });
      return out;
    }
    function mappingHtml(mapping, fields) {
      const rows = Object.keys(mapping || {}).length ? Object.entries(mapping) : [['', '']];
      const opts = (fields || []).map((f) => f.name || f).filter(Boolean);
      return h`<div data-map>${rows.map(([k, v]) => h`<div class="row wrap mt-s" data-map-row style="gap:8px">
        <input class="input mono" name="mapKey" placeholder="API field" value="${k}" style="flex:1">
        <span class="muted">→</span>
        ${opts.length ? h`<select class="select" name="mapVal" style="flex:1"><option value="">Salesforce field</option>${opts.map((n) => h`<option ${n === v ? 'selected' : ''}>${n}</option>`)}</select>` : h`<input class="input mono" name="mapVal" placeholder="Salesforce field" value="${v}" style="flex:1">`}
        <button type="button" class="btn xs ghost" data-map-del aria-label="Remove mapping">${ic('x')}</button>
      </div>`)}<button type="button" class="btn xs mt-s" data-map-add>${ic('plus')} Mapping row</button></div>`;
    }
    function openEndpointEditor(ep) {
      const e = ep || { method: 'POST', path: '/services/apexrest/', successStatus: [200, 201], timeoutMs: 2000, errorStatus: 400, requestMapping: {}, samplePayload: {}, invalidPayload: null };
      modal({
        title: ep ? `Edit ${e.name}` : 'Add custom endpoint', size: 'xl',
        subtitle: 'Apex REST or HTTP/BFF only. Experience Cloud and SFCC catalog paths are not stored here.',
        body: h`<div class="form-grid">
          <label class="field"><span>Name</span><input class="input" name="name" value="${e.name || ''}" required></label>
          <label class="field"><span>Method</span><select class="select" name="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => h`<option ${e.method === m ? 'selected' : ''}>${m}</option>`)}</select></label>
          <label class="field full"><span>Path</span><input class="input mono" name="path" value="${e.path || ''}" placeholder="/services/apexrest/v1/invoices" required><small>Relative Apex REST, or an absolute HTTP URL / {{httpBaseUrl}}/…</small></label>
          <label class="field"><span>Salesforce object</span><input class="input mono" name="object" value="${e.object || ''}" placeholder="Contact"><small>Used for mapping and SOQL checks.</small></label>
          <label class="field"><span>Keywords (match stories)</span><input class="input" name="keywords" value="${(e.keywords || []).join(', ')}" placeholder="invoice, sap, erp"></label>
          <label class="field full"><span>Description</span><textarea class="input" rows="2" name="description">${e.description || ''}</textarea></label>
          <label class="field full"><span>Direction</span><input class="input" name="direction" value="${e.direction || ''}" placeholder="SAP → MuleSoft → Salesforce"></label>
          <label class="field full"><span>Sample payload (JSON)</span><textarea class="input mono" rows="6" name="samplePayload" spellcheck="false">${e.samplePayload ? JSON.stringify(e.samplePayload, null, 2) : ''}</textarea></label>
          <label class="field full"><span>Invalid payload (JSON, optional)</span><textarea class="input mono" rows="4" name="invalidPayload" spellcheck="false">${e.invalidPayload ? JSON.stringify(e.invalidPayload, null, 2) : ''}</textarea></label>
          <div class="field full"><span>Request mapping (API field → Salesforce field)</span><div data-map-host>${mappingHtml(e.requestMapping || {}, [])}</div>
            <button type="button" class="btn xs mt-s" data-load-fields>Load fields from describe</button></div>
          <label class="field"><span>Success statuses</span><input class="input mono" name="successStatus" value="${(e.successStatus || []).join(', ')}" placeholder="200, 201"></label>
          <label class="field"><span>Id JSONPath</span><input class="input mono" name="idPath" value="${e.idPath || ''}" placeholder="$.id"></label>
          <label class="field"><span>Success JSONPath</span><input class="input mono" name="successPath" value="${e.successPath || ''}" placeholder="$.status"></label>
          <label class="field"><span>Success value</span><input class="input mono" name="successValue" value="${e.successValue === undefined || e.successValue === null ? '' : e.successValue}" placeholder="SUCCESS"></label>
          <label class="field"><span>Error status</span><input class="input mono" name="errorStatus" value="${e.errorStatus || 400}"></label>
          <label class="field"><span>Error JSONPath</span><input class="input mono" name="errorPath" value="${e.errorPath || ''}" placeholder="$.message"></label>
          <label class="field full"><span>Response schema (JSON Schema, optional)</span><textarea class="input mono" rows="5" name="responseSchema" spellcheck="false">${e.responseSchema ? JSON.stringify(e.responseSchema, null, 2) : ''}</textarea></label>
          <label class="field"><span>Idempotency header</span><input class="input mono" name="idempotencyHeader" value="${e.idempotencyHeader || ''}" placeholder="Idempotency-Key"></label>
          <label class="field"><span>Duplicate expect statuses</span><input class="input mono" name="duplicateExpect" value="${(e.duplicateExpect || []).join(', ')}" placeholder="200, 409"></label>
          <label class="field"><span>Health path</span><input class="input mono" name="healthPath" value="${e.healthPath || ''}" placeholder="/services/apexrest/v1/erp/health"></label>
          <label class="field"><span>Timeout (ms)</span><input class="input" name="timeoutMs" type="number" value="${e.timeoutMs || 2000}"></label>
          <label class="field full"><span class="row" style="gap:8px;align-items:center"><input type="checkbox" name="legacyContract" ${e.legacyContract ? 'checked' : ''}> Legacy contract (assert $.status = SUCCESS and $.salesforceId)</span></label>
        </div>`,
        foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Save endpoint</button>`,
        onMount(el, close) {
          const host = el.querySelector('[data-map-host]');
          const refreshMap = (fields) => { host.innerHTML = String(mappingHtml(mappingFromForm(el), fields)); };
          el.addEventListener('click', (ev) => {
            if (ev.target.closest('[data-map-add]')) {
              const wrap = el.querySelector('[data-map]');
              wrap.insertAdjacentHTML('beforeend', String(h`<div class="row wrap mt-s" data-map-row style="gap:8px"><input class="input mono" name="mapKey" placeholder="API field" style="flex:1"><span class="muted">→</span><input class="input mono" name="mapVal" placeholder="Salesforce field" style="flex:1"><button type="button" class="btn xs ghost" data-map-del>${ic('x')}</button></div>`));
            }
            if (ev.target.closest('[data-map-del]')) ev.target.closest('[data-map-row]').remove();
          });
          el.querySelector('[data-load-fields]').addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
            const obj = el.querySelector('[name=object]').value.trim();
            if (!obj) { toast('Enter a Salesforce object API name first.', 'warn'); return; }
            try {
              const d = await api.get(`/api/projects/${p.id}/sobjects/${encodeURIComponent(obj)}`);
              refreshMap((d.fields || []).filter((f) => f.createable || f.updateable || f.name === 'Id'));
              toast(`Loaded ${d.fields.length} fields from ${d.name}.`, 'ok');
            } catch (err) { toastError(err, 'Could not describe object'); }
          }));
          if (e.object) el.querySelector('[data-load-fields]').click();
          el.querySelector('[data-go]').addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
            try {
              const v = (n) => { const nEl = el.querySelector(`[name=${n}]`); return nEl ? (nEl.type === 'checkbox' ? nEl.checked : nEl.value) : ''; };
              const body = {
                id: e.id, name: v('name'), method: v('method'), path: v('path'), object: v('object'),
                keywords: v('keywords'), description: v('description'), direction: v('direction'),
                samplePayload: parseJsonField(v('samplePayload'), 'Sample payload'),
                invalidPayload: parseJsonField(v('invalidPayload'), 'Invalid payload'),
                requestMapping: mappingFromForm(el),
                successStatus: v('successStatus'), idPath: v('idPath'), successPath: v('successPath'),
                successValue: v('successValue') === '' ? undefined : v('successValue'),
                errorStatus: Number(v('errorStatus')) || 400, errorPath: v('errorPath'),
                responseSchema: parseJsonField(v('responseSchema'), 'Response schema'),
                idempotencyHeader: v('idempotencyHeader'), duplicateExpect: v('duplicateExpect'),
                healthPath: v('healthPath'), timeoutMs: Number(v('timeoutMs')) || 2000,
                legacyContract: Boolean(v('legacyContract')), source: e.source || 'manual',
              };
              await api.post(`/api/projects/${p.id}/endpoints`, { endpoints: [body] });
              close(); toast('Endpoint saved.', 'ok'); drawIntegration();
            } catch (err) { toastError(err, 'Endpoint not saved'); }
          }));
        },
      });
    }
    if (tab === 'connection' && focus === 'http') connUi.pm = 'connect';
    if (tab === 'connection' && focus === 'playwright') connUi.pw = 'connect';
    if (tab === 'connection' && focus === 'cc') connUi.cc = 'edit';
    draw();
    if (tab === 'connection' && (focus === 'http' || focus === 'cc')) {
      const inp = pane.querySelector(focus === 'cc' ? '[name=ccOrgId]' : '[name=httpBaseUrl]');
      if (inp) {
        const field = inp.closest('.field');
        if (field) field.classList.add('flash-focus');
        inp.focus();
        inp.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    on(view, 'click', '[data-tab]', (e, el) => { tab = el.dataset.tab; QA.router.setQuery({ tab: tab === 'overview' ? '' : tab, focus: '' }); draw(); });
    on(view, 'click', '[data-act=edit]', () => projectForm(p));
    on(view, 'click', '[data-act=use]', () => { QA.state.setProject(p.id); });
    on(view, 'click', '[data-act=archive]', async () => {
      const ok = await confirm({ title: `Archive ${p.name}?`, message: 'The project is hidden from switchers and dashboards. History is kept. Use Delete if you want it gone permanently.', confirmLabel: 'Archive', danger: true });
      if (!ok) return;
      try { await api.del(`/api/projects/${p.id}?archive=true`); toast(`${p.name} archived.`, 'warn'); await QA.state.reloadProjects(); QA.router.go('/projects'); } catch (err) { toastError(err); }
    });
    on(view, 'click', '[data-act=delete]', () => removeProject(p));
    on(view, 'click', '[data-save]', (e, el) => withBusy(el, async () => {
      let v;
      try { v = JSON.parse(pane.querySelector('[data-cfg]').value); } catch (err) { toastError({ message: `Invalid JSON: ${err.message}`, info: { action: 'Fix the JSON syntax and save again.' } }, 'Not saved'); return; }
      try { p = await api.put(`/api/projects/${p.id}`, { [el.dataset.save]: v }); toast('Configuration saved.', 'ok'); QA.state.reloadProjects(); } catch (err) { toastError(err, 'Not saved'); }
    }));
    on(view, 'click', '[data-ep-add]', () => openEndpointEditor(null));
    on(view, 'click', '[data-ep-edit]', (e, el) => openEndpointEditor(epItems.find((x) => x.id === el.dataset.epEdit)));
    on(view, 'click', '[data-ep-del]', (e, el) => withBusy(el, async () => {
      const ok = await confirm({ title: 'Remove this endpoint?', message: 'Stories that linked it will fall back to keyword matching.', confirmLabel: 'Remove' });
      if (!ok) return;
      try { await api.del(`/api/projects/${p.id}/endpoints/${el.dataset.epDel}`); toast('Endpoint removed.', 'warn'); drawIntegration(); } catch (err) { toastError(err); }
    }));
    on(view, 'click', '[data-ep-discover]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/projects/${p.id}/endpoints/discover`, { apply: true });
        toast(`Found ${r.found} Apex REST resource(s); added ${r.added}.`, 'ok', 'Discovery complete');
        drawIntegration();
      } catch (err) { toastError(err, 'Discovery failed'); }
    }));
    on(view, 'click', '[data-ep-openapi]', () => {
      modal({
        title: 'Import OpenAPI / Swagger', size: 'wide', subtitle: 'Operations whose paths are Experience Cloud, SFCC or standard REST are skipped.',
        body: h`<label class="field"><span>File</span><input class="input" type="file" name="file" accept=".json,.yaml,.yml"></label>
          <label class="field"><span>Or paste the specification</span><textarea class="input mono" rows="12" name="spec" spellcheck="false"></textarea></label>`,
        foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Import as endpoints</button>`,
        onMount(el, close) {
          el.querySelector('[name=file]').addEventListener('change', async (ev) => { const f = ev.target.files[0]; if (f) el.querySelector('[name=spec]').value = await f.text(); });
          el.querySelector('[data-go]').addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
            try {
              const r = await api.post(`/api/projects/${p.id}/endpoints/from-openapi`, { spec: el.querySelector('[name=spec]').value });
              close(); toast(`Imported ${r.added} of ${r.found} operations.`, 'ok'); drawIntegration();
            } catch (err) { toastError(err, 'Import failed'); }
          }));
        },
      });
    });
    on(view, 'click', '[data-ep-postman]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/projects/${p.id}/endpoints/from-postman`, {});
        toast(`Promoted ${r.added} of ${r.found} Postman request(s).`, 'ok');
        drawIntegration();
      } catch (err) { toastError(err, 'Promote failed'); }
    }));
    on(view, 'click', '[data-ep-save-adv]', (e, el) => withBusy(el, async () => {
      let rest;
      try { rest = JSON.parse(pane.querySelector('[data-cfg-rest]').value); } catch (err) { toastError({ message: `Invalid JSON: ${err.message}` }, 'Not saved'); return; }
      try {
        p = await api.put(`/api/projects/${p.id}`, { integrationConfig: { ...rest, endpoints: epItems } });
        toast('Integration JSON saved.', 'ok'); QA.state.reloadProjects(); drawIntegration();
      } catch (err) { toastError(err, 'Not saved'); }
    }));
    const val = (n) => { const el = pane.querySelector(`[name=${n}]`); return el ? (el.type === 'checkbox' ? el.checked : el.value.trim()) : ''; };
    const clearSecrets = (names) => names.forEach((n) => { const el = pane.querySelector(`[name=${n}]`); if (el) el.value = ''; });
    const reloadConn = async () => {
      const [np, nc] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]);
      p = np; conn = nc;
      await QA.state.reloadProjects();
      draw();
    };
    on(view, 'change', '[data-import-env]', (e, el) => withBusy(el, async () => {
      const f = el.files && el.files[0];
      if (!f) return;
      try {
        const r = await importEnvironmentFile(p.id, f);
        lastEnvImport.result = r;
        lastEnvImport.error = null;
        envImportToast(r);
        await reloadConn();
      } catch (err) {
        lastEnvImport.error = err;
        lastEnvImport.result = null;
        toastError(err, 'Environment import failed');
        draw();
      }
      el.value = '';
    }));
    on(view, 'click', '[data-open]', (e, el) => { connUi[el.dataset.open] = 'connect'; if (el.dataset.open === 'sf') wiz.sfMode = wiz.sfMode || p.mode || 'demo'; if (el.dataset.open === 'pm') wiz.pmSrc = wiz.pmSrc || ((conn.postman && conn.postman.workspace) ? 'workspace' : 'local'); draw(); });
    on(view, 'click', '[data-conn-edit]', (e, el) => { connUi[el.dataset.connEdit] = 'edit'; if (el.dataset.connEdit === 'sf') wiz.sfMode = wiz.sfMode || p.mode || 'demo'; if (el.dataset.connEdit === 'pm') wiz.pmSrc = wiz.pmSrc || ((conn.postman && conn.postman.workspace) ? 'workspace' : 'local'); draw(); });
    on(view, 'click', '[data-cancel]', (e, el) => { connUi[el.dataset.cancel] = 'status'; draw(); });
    on(view, 'click', '[data-sf-mode]', (e, el) => {
      wiz.sfMode = el.dataset.sfMode;
      pane.querySelectorAll('[data-sf-mode]').forEach((b) => b.classList.toggle('on', b === el));
      const live = pane.querySelector('[data-sf-live]');
      if (live) live.classList.toggle('hidden', wiz.sfMode !== 'live');
      const mode = pane.querySelector('[name=mode]');
      if (mode) mode.value = wiz.sfMode;
    });
    on(view, 'click', '[data-pm-src]', (e, el) => {
      wiz.pmSrc = el.dataset.pmSrc;
      pane.querySelectorAll('[data-pm-src]').forEach((b) => b.classList.toggle('on', b === el));
      const ws = pane.querySelector('[data-pm-ws]');
      if (ws) ws.classList.toggle('hidden', wiz.pmSrc !== 'workspace');
    });
    const showOut = (key, node) => {
      const el = pane.querySelector(`[data-out=${key}]`) || pane.querySelector('[data-testout]');
      if (el) el.innerHTML = String(node || '');
    };
    const saveSf = async () => {
      const mode = wiz.sfMode || val('mode') || p.mode;
      await api.put(`/api/projects/${p.id}/connection`, {
        mode, apiVersion: val('apiVersionAdv') || val('apiVersion') || p.apiVersion, instanceUrl: val('instanceUrl'), sfOrg: val('sfOrg'), credentialRef: val('credentialRef'),
        salesforceMcp: { url: val('mcpUrl'), command: val('mcpCommand') },
        salesforceCli: { enabled: true, targetOrg: val('cliTarget') },
      });
      if (conn.loopback && (val('sfClientId') || val('sfClientSecret') || val('sfAuthFlow') || val('sfRefreshToken') || val('mcpUrl') || val('mcpCommand'))) {
        await api.post(`/api/projects/${p.id}/connection/secrets`, {
          credentialRef: val('credentialRef'),
          salesforce: { authFlow: val('sfAuthFlow'), loginUrl: val('instanceUrl'), clientId: val('sfClientId'), clientSecret: val('sfClientSecret'), refreshToken: val('sfRefreshToken'), mcpUrl: val('mcpUrl'), mcpCommand: val('mcpCommand') },
        });
        clearSecrets(['sfClientId', 'sfClientSecret', 'sfRefreshToken']);
      }
    };
    const savePw = async () => {
      const command = val('pwMcpCommand') || 'npx -y @executeautomation/playwright-mcp-server';
      await api.put(`/api/projects/${p.id}/connection`, { playwright: { mcpUrl: val('pwMcpUrl'), mcpCommand: command, enabled: true } });
      if (conn.loopback && (val('pwMcpUrl') || val('pwMcpCommand'))) {
        await api.post(`/api/projects/${p.id}/connection/secrets`, { playwright: { mcpUrl: val('pwMcpUrl'), mcpCommand: command } });
      }
    };
    const savePm = async () => {
      const src = wiz.pmSrc || ((conn.postman && conn.postman.workspace) ? 'workspace' : 'local');
      await api.put(`/api/projects/${p.id}/connection`, { postman: { workspace: src === 'local' ? '' : val('pmWorkspace'), environment: val('pmEnvironment'), mcpUrl: val('pmMcpUrl'), mcpCommand: val('pmMcpCommand') }, http: { baseUrl: val('httpBaseUrl') } });
      if (conn.loopback && (val('pmApiKey') || val('pmMcpUrl') || val('pmMcpCommand') || val('httpToken'))) {
        await api.post(`/api/projects/${p.id}/connection/secrets`, { postman: { apiKey: val('pmApiKey'), mcpUrl: val('pmMcpUrl'), mcpCommand: val('pmMcpCommand'), workspace: src === 'local' ? '' : val('pmWorkspace') }, http: { token: val('httpToken'), baseUrl: val('httpBaseUrl') } });
        clearSecrets(['pmApiKey', 'httpToken']);
      }
    };
    const saveCursor = async () => {
      const enabled = pane.querySelector('[name=cursorEnabled]') ? Boolean(val('cursorEnabled')) : true;
      const bin = pane.querySelector('[name=cursorBin]') ? val('cursorBin') : ((conn.cursor && conn.cursor.bin) || '');
      await api.put(`/api/projects/${p.id}/connection`, { cursor: { enabled, bin } });
    };
    const saveGemini = async () => {
      const enabled = pane.querySelector('[name=geminiEnabled]') ? Boolean(val('geminiEnabled')) : true;
      const bin = pane.querySelector('[name=geminiBin]') ? val('geminiBin') : ((conn.gemini && conn.gemini.bin) || '');
      await api.put(`/api/projects/${p.id}/connection`, { gemini: { enabled, bin } });
    };
    const startCliLogin = async (target) => {
      if (target === 'cursor' && connUi.cursor !== 'status') await saveCursor();
      if (target === 'gemini' && connUi.gemini !== 'status') await saveGemini();
      const r = await api.post(`/api/projects/${p.id}/connection/login?target=${target}`);
      showOut(target, resultCallout({ ok: true, text: r.text || r.title }));
      toast(r.title || 'Login started. Finish in the browser, then Test.', 'ok');
      await reloadConn();
    };
    const startSalesforceLogin = async () => {
      const mode = wiz.sfMode || val('mode') || p.mode;
      if (mode === 'demo' && connUi.sf !== 'status') {
        wiz.sfMode = 'live';
        const live = pane.querySelector('[data-sf-live]');
        if (live) live.classList.remove('hidden');
        pane.querySelectorAll('[data-sf-mode]').forEach((b) => b.classList.toggle('on', b.dataset.sfMode === 'live'));
      }
      if (connUi.sf !== 'status') await saveSf();
      const instanceUrl = val('instanceUrl') || p.instanceUrl;
      if (!instanceUrl && connUi.sf === 'status') {
        connUi.sf = 'connect';
        wiz.sfMode = 'live';
        draw();
        toast('Enter the org login URL, then Log in.', 'warn');
        return;
      }
      const r = await api.post(`/api/projects/${p.id}/connection/login?target=salesforce`, { instanceUrl, sfOrg: val('sfOrg') || p.sfOrg });
      showOut('sf', resultCallout({ ok: true, text: r.text || r.title }));
      toast(r.title || 'Login opened. Finish in the browser, then Test.', 'ok');
      await reloadConn();
    };
    on(view, 'click', '[data-act=test]', (e, el) => withBusy(el, async () => {
      try {
        if (connUi.sf !== 'status') await saveSf();
        const r = await api.post(`/api/projects/${p.id}/connection/test?target=salesforce`);
        lastTest.salesforce = r.salesforce;
        showOut('sf', resultCallout(plainSf(r.salesforce)));
        if (connUi.sf !== 'status') { await QA.state.reloadProjects(); const [np, nc] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]); p = np; conn = nc; }
      } catch (err) { showOut('sf', errorBox(err)); }
    }));
    on(view, 'click', '[data-act=test-pw]', (e, el) => withBusy(el, async () => {
      try {
        if (connUi.pw !== 'status') await savePw();
        const r = await api.post(`/api/projects/${p.id}/connection/test?target=playwright`);
        lastTest.playwright = r.playwright;
        showOut('pw', resultCallout({ ok: !!(r.playwright && r.playwright.ok), text: (r.playwright && (r.playwright.title || (r.playwright.ok ? 'Connected' : r.playwright.action))) || 'No response' }));
        if (connUi.pw !== 'status') { await QA.state.reloadProjects(); const [np, nc] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]); p = np; conn = nc; }
      } catch (err) { showOut('pw', errorBox(err)); }
    }));
    on(view, 'click', '[data-act=save-pw]', (e, el) => withBusy(el, async () => {
      try { await savePw(); toast('Playwright MCP saved.', 'ok'); await reloadConn(); connUi.pw = 'status'; draw(); } catch (err) { toastError(err); }
    }));
    on(view, 'click', '[data-act=test-pm]', (e, el) => withBusy(el, async () => {
      try {
        if (connUi.pm !== 'status') await savePm();
        const r = await api.post(`/api/projects/${p.id}/connection/test?target=postman`);
        lastTest.postman = r.postman;
        showOut('pm', resultCallout(plainPm(r.postman)));
        if (connUi.pm !== 'status') { await QA.state.reloadProjects(); const [np, nc] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]); p = np; conn = nc; }
      } catch (err) { showOut('pm', errorBox(err)); }
    }));
    on(view, 'click', '[data-act=pick-col]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.get(`/api/projects/${p.id}/postman/collections`);
        const items = r.items || [];
        showOut('pm', h`<div>
          <p class="small wrap">${items.length ? 'Choose a collection to use on this project instead of creating a new one.' : 'No collections found. Import a v2.1 JSON file on HTTP / Postman, or connect a workspace.'}</p>
          ${items.length ? QA.ui.table({ rows: items, columns: [
            { key: 'name', label: 'Collection', render: (c) => h`<div class="wrap">${c.name}${c.linked || (r.linkedCollectionId && c.uid === r.linkedCollectionId) ? ' · in use' : ''}</div><div class="cell-sub">${c.source || ''} · ${c.requestCount || 0} requests</div>` },
            { key: 'act', label: '', render: (c) => h`<button class="btn xs primary" data-act="use-col" data-uid="${c.uid}">Use this collection</button>` },
          ] }) : ''}
          <div class="row mt"><a class="btn" href="/automation" data-link>Import collection file</a></div>
        </div>`);
      } catch (err) { showOut('pm', errorBox(err)); }
    }));
    on(view, 'click', '[data-act=use-col]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/projects/${p.id}/postman/attach`, { uid: el.dataset.uid, importTests: true });
        toast(r.notice || `Using “${r.name}” on this project.`, r.missingHttp ? 'warn' : 'ok', r.missingHttp ? 'HTTP details needed' : 'Collection attached');
        await reloadConn();
        if (r.imported) {
          QA.router.go(r.testsHref || '/testcases');
          return;
        }
        if (r.missingHttp) {
          connUi.pm = 'connect';
          draw();
          const inp = pane.querySelector('[name=httpBaseUrl]');
          if (inp) {
            const field = inp.closest('.field');
            if (field) field.classList.add('flash-focus');
            inp.focus();
            inp.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      } catch (err) { toastError(err); }
    }));
    on(view, 'click', '[data-act=test-jira]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/projects/${p.id}/connection/test?target=jira`);
        lastTest.jira = r.jira;
        showOut('jira', resultCallout(plainOther('Jira', r.jira)));
      } catch (err) { showOut('jira', errorBox(err)); }
    }));
    on(view, 'click', '[data-act=test-cc]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/projects/${p.id}/connection/test?target=commerce`);
        lastTest.commerce = r.commerce;
        showOut('cc', resultCallout(plainOther('Commerce Cloud', r.commerce)));
      } catch (err) { showOut('cc', errorBox(err)); }
    }));
    on(view, 'click', '[data-act=test-cursor]', (e, el) => withBusy(el, async () => {
      try {
        if (connUi.cursor !== 'status') await saveCursor();
        const r = await api.post(`/api/projects/${p.id}/connection/test?target=cursor`);
        lastTest.cursor = r.cursor;
        showOut('cursor', resultCallout(plainCli('Cursor', r.cursor)));
        if (connUi.cursor !== 'status') { const [np, nc] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]); p = np; conn = nc; }
      } catch (err) { showOut('cursor', errorBox(err)); }
    }));
    on(view, 'click', '[data-act=test-gemini]', (e, el) => withBusy(el, async () => {
      try {
        if (connUi.gemini !== 'status') await saveGemini();
        const r = await api.post(`/api/projects/${p.id}/connection/test?target=gemini`);
        lastTest.gemini = r.gemini;
        showOut('gemini', resultCallout(plainCli('Gemini', r.gemini)));
        if (connUi.gemini !== 'status') { const [np, nc] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]); p = np; conn = nc; }
      } catch (err) { showOut('gemini', errorBox(err)); }
    }));
    on(view, 'click', '[data-act=save-sf]', (e, el) => withBusy(el, async () => {
      try {
        await saveSf();
        toast('Salesforce connection saved.', 'ok');
        await reloadConn();
      } catch (err) { toastError(err, 'Salesforce connection not saved'); }
    }));
    on(view, 'click', '[data-act=save-jira]', (e, el) => withBusy(el, async () => {
      try {
        await api.put(`/api/projects/${p.id}/connection`, { jiraUrl: val('jiraUrl'), jiraProjectKey: val('jiraProjectKey'), jiraCredentialRef: val('jiraCredentialRef') });
        if (conn.loopback && (val('jiraEmail') || val('jiraApiToken'))) {
          await api.post(`/api/projects/${p.id}/connection/secrets`, { jiraCredentialRef: val('jiraCredentialRef'), jira: { email: val('jiraEmail'), apiToken: val('jiraApiToken') } });
          clearSecrets(['jiraEmail', 'jiraApiToken']);
        }
        toast('Jira connection saved.', 'ok');
        await reloadConn();
      } catch (err) { toastError(err, 'Jira connection not saved'); }
    }));
    on(view, 'click', '[data-act=save-pm]', (e, el) => withBusy(el, async () => {
      try {
        await savePm();
        toast('Postman connection saved.', 'ok');
        await reloadConn();
      } catch (err) { toastError(err, 'Postman connection not saved'); }
    }));
    on(view, 'click', '[data-act=login-sf]', (e, el) => withBusy(el, async () => {
      try { await startSalesforceLogin(); } catch (err) { showOut('sf', errorBox(err)); toastError(err, 'Salesforce login did not start'); }
    }));
    on(view, 'click', '[data-act=login-cursor]', (e, el) => withBusy(el, async () => {
      try { await startCliLogin('cursor'); } catch (err) { showOut('cursor', errorBox(err)); toastError(err, 'Cursor login did not start'); }
    }));
    on(view, 'click', '[data-act=login-gemini]', (e, el) => withBusy(el, async () => {
      try { await startCliLogin('gemini'); } catch (err) { showOut('gemini', errorBox(err)); toastError(err, 'Gemini login did not start'); }
    }));
    on(view, 'click', '[data-act=save-cursor]', (e, el) => withBusy(el, async () => {
      try {
        await saveCursor();
        toast('Cursor settings saved.', 'ok');
        await reloadConn();
      } catch (err) { toastError(err, 'Cursor settings not saved'); }
    }));
    on(view, 'click', '[data-act=save-gemini]', (e, el) => withBusy(el, async () => {
      try {
        await saveGemini();
        toast('Gemini settings saved.', 'ok');
        await reloadConn();
      } catch (err) { toastError(err, 'Gemini settings not saved'); }
    }));
    on(view, 'click', '[data-act=save-gen]', (e, el) => withBusy(el, async () => {
      try {
        await api.put(`/api/projects/${p.id}/connection`, {
          scriptGenerator: val('scriptGenerator') || 'auto',
          postResultToJira: Boolean(pane.querySelector('[name=postResultToJira]') && pane.querySelector('[name=postResultToJira]').checked),
        });
        toast('Script generator saved.', 'ok');
        await reloadConn();
      } catch (err) { toastError(err, 'Generator not saved'); }
    }));
    on(view, 'click', '[data-act=add-doc]', (e, el) => withBusy(el, async () => {
      try {
        await api.post(`/api/projects/${p.id}/context-docs`, { name: val('docName'), body: val('docBody'), filePath: val('docPath') });
        toast('Context document added.', 'ok');
        await reloadConn();
      } catch (err) { toastError(err, 'Document not added'); }
    }));
    on(view, 'click', '[data-del-doc]', (e, el) => withBusy(el, async () => {
      try {
        await api.del(`/api/projects/${p.id}/context-docs/${el.dataset.delDoc}`);
        toast('Context document removed.', 'ok');
        await reloadConn();
      } catch (err) { toastError(err, 'Document not removed'); }
    }));
    on(view, 'click', '[data-act=save-cc]', (e, el) => withBusy(el, async () => {
      try {
        await api.put(`/api/projects/${p.id}/connection`, {
          commerce: {
            enabled: Boolean(val('ccEnabled')), host: val('ccHost'), siteId: val('ccSiteId'), orgId: val('ccOrgId'),
            shortCode: val('ccShortCode'), ocapiVersion: val('ccOcapiVersion'), credentialRef: val('ccCredentialRef'), sampleProductId: val('ccSampleProductId'),
          },
        });
        if (conn.loopback && (val('ccClientId') || val('ccClientSecret'))) {
          await api.post(`/api/projects/${p.id}/connection/secrets`, { commerce: { credentialRef: val('ccCredentialRef'), clientId: val('ccClientId'), clientSecret: val('ccClientSecret') } });
          clearSecrets(['ccClientId', 'ccClientSecret']);
        }
        toast('Commerce Cloud connection saved.', 'ok');
        await reloadConn();
      } catch (err) { toastError(err, 'Commerce Cloud connection not saved'); }
    }));
    on(view, 'click', '[data-act=sync-jira]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/stories/sync?projectId=${p.id}`, { jql: val('jql') || undefined });
        toast(`${r.synced} tickets synced from Jira.`, 'ok');
      } catch (err) { toastError(err, 'Jira sync failed'); }
    }));
    const showJiraGenerate = (r) => {
      const out = pane.querySelector('[data-testout]');
      if (!out) return;
      const scoped = r.scoped && (r.storyKeys || []).length;
      out.innerHTML = String(h`<div class="card"><div class="card-head"><h2>Generated from Jira</h2></div><div class="card-body">
        <p class="small">${scoped ? `Generated for ${(r.storyKeys || []).join(', ')}.` : `Synced ${r.synced} tickets · generated ${r.proposals.length} proposal(s)`}${r.skipped ? ` · skipped ${r.skipped} (classified as not needing API testing)` : ''}.</p>
        ${QA.ui.table({ rows: r.proposals, emptyState: empty({ title: 'No proposals', text: scoped ? 'That ticket was skipped or produced no suite.' : 'No synced tickets needed API testing.' }), columns: [
          { key: 'storyKey', label: 'Ticket', render: (x) => h`<a href="/stories/${x.storyKey}?proposal=${x.id}" data-link class="mono">${x.storyKey}</a>` },
          { key: 'summary', label: 'Summary' },
          { key: 'tests', label: 'Tests', cls: 'num' },
          { key: 'review', label: '', render: (x) => h`<a class="btn xs" href="/stories/${x.storyKey}?proposal=${x.id}" data-link>Review</a>` },
        ] })}
        ${r.errors && r.errors.length ? h`<p class="small text-error mt">${r.errors.map((x) => `${x.storyKey}: ${x.title}`).join(' · ')}</p>` : ''}
      </div></div>`);
    };
    on(view, 'click', '[data-act=gen-jira]', (e, el) => withBusy(el, async () => {
      try {
        const storyKey = val('storyKey');
        if (!storyKey) {
          toast('Enter a ticket key to generate for that ticket, or use Generate for all matching tickets.', 'warn');
          return;
        }
        const r = await api.post(`/api/stories/sync-and-generate?projectId=${p.id}`, { storyKey, jql: val('jql') || undefined, onlyNeedingApi: true });
        showJiraGenerate(r);
        toast(`Generated ${r.proposals.length} API script proposal(s) for ${storyKey}.`, 'ok');
      } catch (err) { toastError(err, 'Generate from Jira failed'); }
    }));
    on(view, 'click', '[data-act=gen-jira-all]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/stories/sync-and-generate?projectId=${p.id}`, { jql: val('jql') || undefined, onlyNeedingApi: true });
        showJiraGenerate(r);
        toast(`Generated ${r.proposals.length} API script proposal(s) from Jira.`, 'ok');
      } catch (err) { toastError(err, 'Generate from Jira failed'); }
    }));
    return null;
  }
})();
