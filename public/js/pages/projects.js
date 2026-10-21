/* Projects: multi-project configuration, environments, connections (presence only), integration settings. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, badge, prov, on, errorBox, loading, empty, toast, toastError, withBusy, esc, modal, confirm } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.projects = {
    render(view, ctx) {
      if (ctx.pattern === '/projects/new' || ctx.query.new === '1') return renderCreate(view);
      return ctx.params.id ? renderDetail(view, ctx.params.id, ctx.query.tab) : renderList(view);
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

  function renderList(view) {
    QA.router.setCrumbs([{ label: 'Projects' }]);
    const S = QA.state;
    const rows = S.projects;
    const cta = h`<a class="btn primary" href="/projects/new" data-link data-act="new">${ic('plus')} New project</a>`;
    view.innerHTML = String(h`${C.pageHead('Projects', 'Each project is one QA workspace: Salesforce backend APIs, HTTP/Postman frontend APIs, and one environment such as QA or Production.', cta)}
      ${C.pageIntro({ what: 'Open a card to see connection status, or start a new workspace. Nothing here stores passwords.', next: 'Click New project. Pick Demo to explore without an org, or Live when .env credentials are ready.' })}
      ${rows.length ? h`<div class="project-grid">${rows.map((r) => h`<a class="card project-card ${r.id === S.projectId ? 'current' : ''}" href="/projects/${esc(r.id)}" data-link>
          <div class="card-head"><h2>${r.name}</h2>${r.id === S.projectId ? h`<span class="tag">Current</span>` : ''}</div>
          <div class="card-body">
            <p class="desc wrap">${r.description || 'No description yet.'}</p>
            <div class="meta-row">${r.environment === 'Production' ? h`<span class="badge failed plain">${ic('shield')} Production</span>` : h`<span class="tag">${r.environment}</span>`}<span class="tag">${r.mode === 'demo' ? 'Demo' : 'Live'}</span>${r.sfOrg ? h`<span class="mono small">${r.sfOrg}</span>` : ''}</div>
            ${C.kv([
              ['Salesforce (backend)', connDot(r.connection.salesforce)],
              ['HTTP / Postman', connDot(r.connection.postman || { status: 'unavailable', label: 'Local collections' })],
              ['Jira', h`${connDot(r.connection.jira)}${r.jiraProjectKey ? h` <span class="cell-sub">${r.jiraProjectKey}</span>` : ''}`],
              ['Tests', fmt.num(r.stats.tests)],
              ['Last run', r.stats.lastRun ? h`${badge(r.stats.lastRun.failed ? 'failed' : 'passed', `${r.stats.lastRun.passed}/${r.stats.lastRun.total}`)} <span class="cell-sub">${fmt.ago(r.stats.lastRun.startedAt)}</span>` : 'Never'],
            ])}
          </div>
        </a>`)}</div>` : h`<div class="card project-empty">${empty({ icon: 'folder', title: 'No projects yet', text: 'Create a project to connect a Salesforce org and (optionally) Jira. You can try Demo mode with no credentials.', action: cta })}
        <div class="project-steps">
          <div class="step"><div class="n">1</div><b>Name the workspace</b><div class="cell-sub">Environment (QA, UAT, Production) and Demo or Live.</div></div>
          <div class="step"><div class="n">2</div><b>Connect Salesforce and Postman</b><div class="cell-sub">Status first, then a short Connect wizard — never the password itself.</div></div>
          <div class="step"><div class="n">3</div><b>Pull tickets and test</b><div class="cell-sub">How QA works walks through generate → run → report.</div></div>
        </div></div>`}`);
    on(view, 'click', '[data-act=new]', (e) => { if (!e.target.closest('a[href]')) { e.preventDefault(); QA.router.go('/projects/new'); } });
    return null;
  }

  function projectFields(p) {
    const envs = QA.state.meta.environments;
    return h`<div class="stack project-fields">
      <div class="card"><div class="card-head"><h2>1. About this project</h2><span class="sub">Shown in the sidebar and reports</span></div><div class="card-body form-grid">
        <label class="field full"><span>Project name</span><input class="input" name="name" value="${p ? p.name : ''}" required placeholder="e.g. Acme Sales Cloud — QA"><small>A name your testers will recognise.</small></label>
        <label class="field full"><span>What is this project for?</span><textarea class="input wrap" name="description" rows="2" placeholder="e.g. API tests for the QA sandbox used by the sales team">${p ? p.description || '' : ''}</textarea></label>
        <label class="field"><span>Environment</span><select class="select" name="environment">${envs.map((e) => h`<option ${p && p.environment === e ? 'selected' : (!p && e === 'QA') ? 'selected' : ''}>${e}</option>`)}</select><small>Production is read-only unless you confirm every change.</small></label>
        <label class="field"><span>How should we connect?</span><select class="select" name="mode"><option value="demo" ${!p || p.mode === 'demo' ? 'selected' : ''}>Try the demo (no real org needed)</option><option value="live" ${p && p.mode === 'live' ? 'selected' : ''}>Live Salesforce (browser login)</option></select><small>Pick Demo to explore. Live uses the org login URL — you sign in in the browser on Connections.</small></label>
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
      </div></div>
    </div>`;
  }

  async function submitProject(p, root, thenGo) {
    const b = {};
    root.querySelectorAll('[name]').forEach((i) => { b[i.name] = i.value.trim() || null; });
    if (b.postmanWorkspace !== undefined) {
      b.integrationConfig = { ...((p && p.integrationConfig) || {}), postman: { ...((p && p.integrationConfig && p.integrationConfig.postman) || {}), workspace: b.postmanWorkspace || '' } };
      delete b.postmanWorkspace;
    }
    if (!b.name) { toast('Please enter a project name.', 'warn'); return; }
    const r = p ? await api.put(`/api/projects/${p.id}`, b) : await api.post('/api/projects', b);
    toast(p ? `${r.name} saved.` : `${r.name} created. Next: check Salesforce and Postman status, then Connect if needed.`, 'ok');
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

  async function renderDetail(view, id, tabQ) {
    QA.router.setCrumbs([{ label: 'Projects', href: '/projects' }, { label: id }]);
    view.innerHTML = String(loading(10));
    let p; let conn;
    try { [p, conn] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]); } catch (e) { view.innerHTML = String(errorBox(e)); return null; }
    QA.router.setCrumbs([{ label: 'Projects', href: '/projects' }, { label: p.name }]);
    let tab = tabQ || 'overview';
    const cfgTabs = { integration: ['integrationConfig', 'Integration endpoints, middleware and mappings used to generate integration tests.'], business: ['businessConfig', 'SLA, critical objects, low-privilege expectations and SOQL templates. These drive prioritisation and security tests.'], testdata: ['testDataConfig', 'Automatic cleanup and default variables available to tests as {{name}}.'], notifications: ['notificationConfig', 'Who is notified when runs complete.'] };
    view.innerHTML = String(h`${C.pageHead(p.name, h`${p.environment} · ${p.sfOrg || 'no org alias'} · API v${p.apiVersion} · ${p.mode === 'demo' ? 'Demo (no live org)' : 'Live org'}`,
      h`${p.id !== QA.state.projectId ? h`<button class="btn" data-act="use">Work in this project</button>` : h`<span class="tag">Current project</span>`}<a class="btn" href="/workflow" data-link>${ic('layers')} How QA works</a><button class="btn" data-act="edit">${ic('edit')} Edit</button><button class="btn danger-outline" data-act="archive">Archive</button>`)}
      ${C.pageIntro({ what: 'This workspace covers Salesforce backend APIs (org, Apex REST) and HTTP/Postman frontend APIs (custom REST, storefront, BFF). Connections, tests and reports hang off it.', next: 'Open Connections to see status, then Connect or Test. How QA works walks through tickets → tests. Secrets stay in .env.' })}
      ${p.environment === 'Production' ? h`<div class="callout error">${ic('shield')}<div class="small wrap"><b>Production project.</b> Read-only by default. Generated suites contain read-only smoke tests; any write requires explicit confirmation and DELETE a second confirmation. Test data is never created or deleted automatically.</div></div>` : ''}
      <div data-tabs></div><div data-pane></div>`);
    const TABS = [{ id: 'overview', label: 'Overview' }, { id: 'connection', label: 'Connections' }, { id: 'integration', label: 'Other systems' }, { id: 'business', label: 'Business rules' }, { id: 'testdata', label: 'Test data' }, { id: 'notifications', label: 'Notifications' }];
    const connUi = { sf: 'status', pm: 'status', jira: 'status', cc: 'status', cursor: 'status', gemini: 'status' };
    const lastTest = { salesforce: null, postman: null, jira: null, commerce: null, cursor: null, gemini: null };
    const wiz = { sfMode: null, pmSrc: null };
    const pane = view.querySelector('[data-pane]');
    const draw = () => {
      view.querySelector('[data-tabs]').innerHTML = String(C.tabs(TABS, tab));
      if (tab === 'overview') {
        pane.innerHTML = String(h`<div class="grid g-2"><div class="card"><div class="card-head"><h2>Configuration</h2></div><div class="card-body">${C.kv([['Project id', h`<span class="mono">${p.id}</span>`], ['Environment', p.environment], ['Salesforce org', p.sfOrg], ['Instance URL', p.instanceUrl ? h`<span class="mono small wrap">${p.instanceUrl}</span>` : null], ['API version', p.apiVersion], ['Jira project', p.jiraProjectKey], ['Jira URL', p.jiraUrl ? h`<span class="mono small wrap">${p.jiraUrl}</span>` : null], ['Postman collection', p.postmanCollection ? h`<span class="mono small wrap">${p.postmanCollection}</span>` : null], ['Automation repo', p.automationRepo ? h`<span class="wrap">${p.automationRepo}</span>` : null], ['Created', fmt.date(p.createdAt)]])}</div></div>
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
        const sfStatus = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker">${C.layerTag('backend')}<h2>Salesforce</h2><span class="sub">Browser login · Core, Experience/B2B, B2C/SFCC</span></div>${connDot(sf)}</div><div class="card-body">
            <p class="conn-status-line wrap">${sf.status === 'demo' || p.mode === 'demo' ? 'Demo — backend tests use the simulator, no live org.' : sf.status === 'connected' || sf.status === 'configured' ? (sf.label || 'Salesforce is connected.') : (sf.label || 'Not connected.')}</p>
            ${C.kv([['Mode', p.mode === 'demo' ? 'Demo (no org)' : 'Live org'], ['Login URL', p.instanceUrl ? h`<span class="mono small wrap">${p.instanceUrl}</span>` : '—'], ['Detected APIs', sfTypes.length ? sfTypes.join(' · ') : '—'], ['Org id', sf.orgId || sfDet.orgId || '—'], ['Edition', sf.edition || sfDet.edition || '—'], ['Last test', lastTest.salesforce ? plainSf(lastTest.salesforce).text : 'Not tested yet']])}
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
            ${C.kv([['Source', (conn.postman && conn.postman.workspace) ? 'Postman workspace' : 'Local collections'], ['Workspace', (conn.postman && conn.postman.workspace) || '—'], ['HTTP base URL', (conn.http && conn.http.baseUrl) || ((p.connection && p.connection.http && p.connection.http.baseUrl) || '—')], ['Last test', lastTest.postman ? plainPm(lastTest.postman).text : 'Not tested yet']])}
            <p class="small muted mt">${pm.status === 'configured' || pm.status === 'demo' || pm.status === 'connected' ? 'Test Postman to list collections. After you Approve tests, Run uses this MCP to execute the synced collection.' : 'Reuse local collections by default, or Connect a workspace / MCP so Approve can push and Run can execute in Postman.'}</p>
            <div class="form-actions mt">
              <button class="btn primary" data-act="test-pm">${ic('refresh')} Test Postman</button>
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
              <button class="btn" data-cancel="pm">Done</button>
              <a class="btn" href="/workflow/postman" data-link>Discover collections</a>
            </div>
            <div data-out="pm">${resultCallout(plainPm(lastTest.postman))}</div>
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
              ${conn.loopback ? h`<label class="field"><span>Jira email</span><input class="input" name="jiraEmail" autocomplete="off"></label><label class="field"><span>Jira API token</span><input class="input mono" type="password" name="jiraApiToken" autocomplete="new-password"></label>` : ''}
            </div>
            <div class="form-actions mt">
              <button class="btn" data-act="test-jira">${ic('refresh')} Test connection</button>
              <button class="btn" data-act="save-jira">${ic('check')} Save Jira connection</button>
              <button class="btn" data-act="sync-jira">${ic('refresh')} Sync tickets</button>
              <button class="btn primary" data-act="gen-jira">${ic('wand')} Sync tickets and generate API scripts</button>
              <button class="btn" data-cancel="jira">Done</button>
            </div>
            <p class="small muted mt">Generation creates reviewable proposals (nothing is written to Jira unless you approve with “post to Jira”).</p>
            ${connUi.jira === 'edit' ? envTable(h`${row(`${c.jira.prefix || 'JIRA_'}EMAIL`, c.jira.configured, 'Atlassian account email')}${row(`${c.jira.prefix || 'JIRA_'}API_TOKEN`, c.jira.configured, 'Atlassian API token')}`) : ''}
            <div data-out="jira">${resultCallout(plainOther('Jira', lastTest.jira))}</div>
          </div></div>`;
        const ccStatus = () => h`<div class="card conn-card"><div class="card-head"><div class="card-kicker"><h2>Commerce Cloud</h2><span class="sub">OCAPI / SCAPI (optional)</span></div>${connDot(p.connection.commerce || { status: 'off', label: 'Off' })}</div><div class="card-body">
            <p class="conn-status-line wrap">${(p.connection.commerce && p.connection.commerce.label) || 'Not enabled.'}</p>
            ${C.kv([['Host', cc.host || '—'], ['Site', cc.siteId || '—'], ['Detected', (p.connection.commerce && p.connection.commerce.types && p.connection.commerce.types.length) ? p.connection.commerce.types.join(' · ') : (cc.enabled ? 'Enabled' : 'Off')], ['Last test', lastTest.commerce ? plainOther('Commerce Cloud', lastTest.commerce).text : 'Not tested yet']])}
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
              <label class="field"><span>Realm / org ID</span><input class="input mono" name="ccOrgId" value="${cc.orgId || ''}" placeholder="f_ecom_zzte_001"></label>
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
            <p class="small muted mt">Connect runs <code>agent login</code> (or <code>cursor login</code>) and opens a browser. Test checks <code>whoami</code>. No API key is collected or stored.</p>
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
              <label class="field"><span>CLI binary (optional)</span><input class="input mono" name="cursorBin" value="${cur.bin || ''}" placeholder="agent or cursor"><small>Leave blank to auto-detect <code>cursor</code> then <code>agent</code>.</small></label>
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
            <label class="field mt"><span>When both are connected</span>
              <select class="select" name="scriptGenerator">
                <option value="auto" ${genPref === 'auto' ? 'selected' : ''}>Auto (Cursor, then Gemini, then engine)</option>
                <option value="cursor" ${genPref === 'cursor' ? 'selected' : ''}>Cursor</option>
                <option value="gemini" ${genPref === 'gemini' ? 'selected' : ''}>Gemini</option>
                <option value="engine" ${genPref === 'engine' ? 'selected' : ''}>Built-in engine</option>
              </select>
            </label>
            <div class="form-actions mt"><button class="btn" data-act="save-gen">${ic('check')} Save generator</button></div>
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
          <div class="stack project-connect">
            ${connUi.sf === 'status' ? sfStatus() : sfWizard()}
            ${connUi.pm === 'status' ? pmStatus() : pmWizard()}
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
      } else {
        const [field, help] = cfgTabs[tab];
        pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>${TABS.find((t) => t.id === tab).label}</h2><span class="small muted">${help}</span></div><div class="card-body">
          <textarea class="input mono" rows="22" data-cfg spellcheck="false" aria-label="${field} JSON">${JSON.stringify(p[field] || {}, null, 2)}</textarea>
          <div class="form-actions mt"><span class="small muted wrap">Secret-looking keys (password, secret, token) are rejected by the server.</span><span class="spacer"></span><button class="btn primary" data-save="${field}">Save</button></div></div></div>`);
      }
    };
    draw();
    on(view, 'click', '[data-tab]', (e, el) => { tab = el.dataset.tab; QA.router.setQuery({ tab: tab === 'overview' ? '' : tab }); draw(); });
    on(view, 'click', '[data-act=edit]', () => projectForm(p));
    on(view, 'click', '[data-act=use]', () => { QA.state.setProject(p.id); });
    on(view, 'click', '[data-act=archive]', async () => {
      const ok = await confirm({ title: `Archive ${p.name}?`, message: 'The project is hidden from switchers and dashboards. History is kept.', confirmLabel: 'Archive', danger: true, typeToConfirm: p.id });
      if (!ok) return;
      try { await api.del(`/api/projects/${p.id}`); toast(`${p.name} archived.`, 'warn'); await QA.state.reloadProjects(); QA.router.go('/projects'); } catch (err) { toastError(err); }
    });
    on(view, 'click', '[data-save]', (e, el) => withBusy(el, async () => {
      let v;
      try { v = JSON.parse(pane.querySelector('[data-cfg]').value); } catch (err) { toastError({ message: `Invalid JSON: ${err.message}`, info: { action: 'Fix the JSON syntax and save again.' } }, 'Not saved'); return; }
      try { p = await api.put(`/api/projects/${p.id}`, { [el.dataset.save]: v }); toast('Configuration saved.', 'ok'); QA.state.reloadProjects(); } catch (err) { toastError(err, 'Not saved'); }
    }));
    const val = (n) => { const el = pane.querySelector(`[name=${n}]`); return el ? (el.type === 'checkbox' ? el.checked : el.value.trim()) : ''; };
    const clearSecrets = (names) => names.forEach((n) => { const el = pane.querySelector(`[name=${n}]`); if (el) el.value = ''; });
    const reloadConn = async () => {
      const [np, nc] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]);
      p = np; conn = nc;
      await QA.state.reloadProjects();
      draw();
    };
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
    on(view, 'click', '[data-act=test-pm]', (e, el) => withBusy(el, async () => {
      try {
        if (connUi.pm !== 'status') await savePm();
        const r = await api.post(`/api/projects/${p.id}/connection/test?target=postman`);
        lastTest.postman = r.postman;
        showOut('pm', resultCallout(plainPm(r.postman)));
        if (connUi.pm !== 'status') { await QA.state.reloadProjects(); const [np, nc] = await Promise.all([api.get(`/api/projects/${encodeURIComponent(id)}`), api.get(`/api/projects/${encodeURIComponent(id)}/connection`)]); p = np; conn = nc; }
      } catch (err) { showOut('pm', errorBox(err)); }
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
        await api.put(`/api/projects/${p.id}/connection`, { scriptGenerator: val('scriptGenerator') || 'auto' });
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
    on(view, 'click', '[data-act=gen-jira]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/stories/sync-and-generate?projectId=${p.id}`, { jql: val('jql') || undefined, onlyNeedingApi: true });
        const out = pane.querySelector('[data-testout]');
        out.innerHTML = String(h`<div class="card"><div class="card-head"><h2>Generated from Jira</h2></div><div class="card-body">
          <p class="small">Synced ${r.synced} tickets · generated ${r.proposals.length} proposal(s)${r.skipped ? ` · skipped ${r.skipped} (classified as not needing API testing)` : ''}.</p>
          ${QA.ui.table({ rows: r.proposals, emptyState: empty({ title: 'No proposals', text: 'No synced tickets needed API testing.' }), columns: [
            { key: 'storyKey', label: 'Ticket', render: (x) => h`<a href="/stories/${x.storyKey}?proposal=${x.id}" data-link class="mono">${x.storyKey}</a>` },
            { key: 'summary', label: 'Summary' },
            { key: 'tests', label: 'Tests', cls: 'num' },
            { key: 'review', label: '', render: (x) => h`<a class="btn xs" href="/stories/${x.storyKey}?proposal=${x.id}" data-link>Review</a>` },
          ] })}
          ${r.errors && r.errors.length ? h`<p class="small text-error mt">${r.errors.map((x) => `${x.storyKey}: ${x.title}`).join(' · ')}</p>` : ''}
        </div></div>`);
        toast(`Generated ${r.proposals.length} API script proposal(s) from Jira.`, 'ok');
      } catch (err) { toastError(err, 'Generate from Jira failed'); }
    }));
    return null;
  }
})();
