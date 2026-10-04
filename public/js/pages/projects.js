/* Projects: multi-project configuration, environments, connections (presence only), integration settings. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, badge, prov, on, errorBox, loading, empty, toast, toastError, withBusy, esc, modal, confirm } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.projects = {
    render(view, ctx) {
      return ctx.params.id ? renderDetail(view, ctx.params.id, ctx.query.tab) : renderList(view);
    },
  };

  const connDot = (s) => h`<span class="badge ${s.status === 'connected' || s.status === 'configured' ? 'ok' : s.status === 'demo' ? 'demo' : 'unavailable'}">${s.label}</span>`;

  function renderList(view) {
    QA.router.setCrumbs([{ label: 'Projects' }]);
    const S = QA.state;
    const rows = S.projects;
    view.innerHTML = String(h`${C.pageHead('Projects', 'Each project pairs a Salesforce org and environment with a Jira project. Credentials stay in environment variables or your secret manager — never in this UI.', h`<button class="btn primary" data-act="new">${ic('plus')} New project</button>`)}
      <div class="card">${QA.ui.table({ rows, rowAttrs: (r) => `data-href="/projects/${esc(r.id)}"`, emptyState: empty({ icon: 'folder', title: 'No projects yet', text: 'Create a project to connect a Salesforce org and Jira project.', action: h`<button class="btn primary" data-act="new">${ic('plus')} New project</button>` }), columns: [
        { key: 'name', label: 'Project', render: (r) => h`<div class="cell-title">${r.name}${r.id === S.projectId ? h` <span class="tag">current</span>` : ''}</div><div class="cell-sub">${r.description || ''}</div>` },
        { key: 'environment', label: 'Environment', render: (r) => (r.environment === 'Production' ? h`<span class="badge failed plain">${ic('shield')} Production</span>` : h`<span class="tag">${r.environment}</span>`) },
        { key: 'sfOrg', label: 'Salesforce org', render: (r) => h`<div class="mono small">${r.sfOrg || '–'}</div><div class="cell-sub">API v${r.apiVersion}</div>` },
        { key: 'conn', label: 'Salesforce', render: (r) => connDot(r.connection.salesforce) },
        { key: 'jira', label: 'Jira', render: (r) => h`${connDot(r.connection.jira)}<div class="cell-sub">${r.jiraProjectKey || ''}</div>` },
        { key: 'tests', label: 'Tests', cls: 'num', render: (r) => fmt.num(r.stats.tests) },
        { key: 'last', label: 'Last run', render: (r) => (r.stats.lastRun ? h`${badge(r.stats.lastRun.failed ? 'failed' : 'passed', `${r.stats.lastRun.passed}/${r.stats.lastRun.total}`)}<div class="cell-sub">${fmt.ago(r.stats.lastRun.startedAt)}</div>` : h`<span class="faint small">Never</span>`) },
        { key: 'mode', label: 'Mode', render: (r) => h`<span class="tag">${r.mode}</span>` },
      ] })}</div>`);
    on(view, 'click', '[data-act=new]', () => projectForm(null));
    return null;
  }

  function projectForm(p) {
    const envs = QA.state.meta.environments;
    modal({
      title: p ? `Edit ${p.name}` : 'New project', size: 'wide',
      subtitle: 'Reference credentials by prefix only. Secrets are read from environment variables on the server.',
      body: h`<div class="form-grid">
        <label class="field full"><span>Project name</span><input class="input" name="name" value="${p ? p.name : ''}" required></label>
        <label class="field"><span>Environment</span><select class="select" name="environment">${envs.map((e) => h`<option ${p && p.environment === e ? 'selected' : ''}>${e}</option>`)}</select></label>
        <label class="field"><span>Mode</span><select class="select" name="mode"><option value="live" ${p && p.mode === 'live' ? 'selected' : ''}>Live (real Salesforce + Jira)</option><option value="demo" ${p && p.mode === 'demo' ? 'selected' : ''}>Demo (simulator)</option></select></label>
        <label class="field"><span>Salesforce org alias</span><input class="input mono" name="sfOrg" value="${p ? p.sfOrg || '' : ''}" placeholder="acme--qa"></label>
        <label class="field"><span>API version</span><input class="input mono" name="apiVersion" value="${p ? p.apiVersion : '62.0'}" placeholder="62.0"></label>
        <label class="field full"><span>Instance URL</span><input class="input mono" name="instanceUrl" value="${p ? p.instanceUrl || '' : ''}" placeholder="https://your-org--qa.sandbox.my.salesforce.com"></label>
        <label class="field"><span>Credential prefix</span><input class="input mono" name="credentialRef" value="${p ? p.credentialRef || '' : ''}" placeholder="ACME_QA"><small>Reads SF_&lt;PREFIX&gt;_CLIENT_ID, …_CLIENT_SECRET, etc.</small></label>
        <label class="field"><span>Jira project key</span><input class="input mono" name="jiraProjectKey" value="${p ? p.jiraProjectKey || '' : ''}" placeholder="PROJ"></label>
        <label class="field"><span>Jira URL</span><input class="input mono" name="jiraUrl" value="${p ? p.jiraUrl || '' : ''}" placeholder="https://your-company.atlassian.net"></label>
        <label class="field"><span>Jira credential prefix (optional)</span><input class="input mono" name="jiraCredentialRef" value="${p ? p.jiraCredentialRef || '' : ''}" placeholder="Uses JIRA_EMAIL / JIRA_API_TOKEN"></label>
        <label class="field full"><span>Description</span><input class="input" name="description" value="${p ? p.description || '' : ''}"></label>
      </div>`,
      foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>${p ? 'Save project' : 'Create project'}</button>`,
      onMount(el, close) {
        el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
          const b = {};
          el.querySelectorAll('[name]').forEach((i) => { b[i.name] = i.value.trim() || null; });
          if (!b.name) { toast('Project name is required.', 'warn'); return; }
          try {
            const r = p ? await api.put(`/api/projects/${p.id}`, b) : await api.post('/api/projects', b);
            close();
            toast(`${r.name} ${p ? 'saved' : 'created'}.`, 'ok');
            await QA.state.reloadProjects();
            if (!p) QA.state.setProject(r.id);
            QA.router.go(`/projects/${r.id}`);
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
    view.innerHTML = String(h`${C.pageHead(p.name, h`${p.environment} · ${p.sfOrg || 'no org alias'} · API v${p.apiVersion} · ${p.mode} mode`,
      h`${p.id !== QA.state.projectId ? h`<button class="btn" data-act="use">Switch to this project</button>` : h`<span class="tag">Current project</span>`}<button class="btn" data-act="edit">${ic('edit')} Edit</button><button class="btn danger-outline" data-act="archive">Archive</button>`)}
      ${p.environment === 'Production' ? h`<div class="callout error" style="margin-bottom:16px">${ic('shield')}<div class="small"><b>Production project.</b> Read-only by default. Generated suites contain read-only smoke tests; any write requires explicit confirmation and DELETE a second confirmation. Test data is never created or deleted automatically.</div></div>` : ''}
      <div data-tabs></div><div data-pane></div>`);
    const TABS = [{ id: 'overview', label: 'Overview' }, { id: 'connection', label: 'Connections' }, { id: 'integration', label: 'Integration' }, { id: 'business', label: 'Business rules' }, { id: 'testdata', label: 'Test data' }, { id: 'notifications', label: 'Notifications' }];
    const pane = view.querySelector('[data-pane]');
    const draw = () => {
      view.querySelector('[data-tabs]').innerHTML = String(C.tabs(TABS, tab));
      if (tab === 'overview') {
        pane.innerHTML = String(h`<div class="grid g-2"><div class="card"><div class="card-head"><h2>Configuration</h2></div><div class="card-body">${C.kv([['Project id', h`<span class="mono">${p.id}</span>`], ['Environment', p.environment], ['Salesforce org', p.sfOrg], ['Instance URL', p.instanceUrl ? h`<span class="mono small">${p.instanceUrl}</span>` : null], ['API version', p.apiVersion], ['Jira project', p.jiraProjectKey], ['Jira URL', p.jiraUrl], ['Postman collection', p.postmanCollection ? h`<span class="mono small">${p.postmanCollection}</span>` : null], ['Automation repo', p.automationRepo], ['Created', fmt.date(p.createdAt)]])}</div></div>
          <div class="card"><div class="card-head"><h2>Activity</h2></div><div class="card-body">${C.kv([['Test cases', fmt.num(p.stats.tests)], ['Last run', p.stats.lastRun ? h`<a href="/execution/${p.stats.lastRun.id}" data-link class="mono">${p.stats.lastRun.id}</a> · ${p.stats.lastRun.passed}/${p.stats.lastRun.total} passed · ${fmt.ago(p.stats.lastRun.startedAt)}` : 'Never'], ['Pass rate (last run)', p.stats.passRate === null || p.stats.passRate === undefined ? '–' : `${p.stats.passRate}%`], ['Salesforce', connDot(p.connection.salesforce)], ['Jira', connDot(p.connection.jira)], ['Metadata provenance', prov(p.connection.metadataLabel)]])}</div></div></div>`);
      } else if (tab === 'connection') {
        const c = conn.credentials;
        const pre = c.salesforce.prefix || 'SF_<PREFIX>_';
        const row = (name, present, note) => h`<tr><td class="mono small">${name}</td><td>${present ? h`<span class="badge ok">Set</span>` : h`<span class="badge plain">Not set</span>`}</td><td class="small muted">${note || ''}</td></tr>`;
        pane.innerHTML = String(h`${C.connectionNotice(p)}<div class="grid g-2">
          <div class="card"><div class="card-head"><h2>Salesforce credentials</h2>${connDot(p.connection.salesforce)}</div><div class="card-body flush"><div class="table-wrap"><table class="t"><thead><tr><th>Environment variable</th><th>Status</th><th>Purpose</th></tr></thead><tbody>
            ${row(`${pre}AUTH_FLOW`, Boolean(c.salesforce.authFlow), c.salesforce.authFlow ? `Flow: ${c.salesforce.authFlow}` : 'client_credentials | jwt | refresh_token')}
            ${row(`${pre}CLIENT_ID`, c.salesforce.clientId, 'Connected app consumer key')}
            ${row(`${pre}CLIENT_SECRET`, c.salesforce.clientSecret, 'client_credentials / refresh_token flows')}
            ${row(`${pre}USERNAME`, c.salesforce.username, 'JWT bearer flow')}
            ${row(`${pre}PRIVATE_KEY_PATH`, c.salesforce.privateKey, 'JWT bearer flow (path to .pem, never the key itself)')}
            ${row(`${pre}REFRESH_TOKEN`, c.salesforce.refreshToken, 'refresh_token flow')}
            ${row(`${pre}LOWPRIV_*`, c.salesforce.lowPrivilegeUser, 'Optional low-privilege user for security tests')}
          </tbody></table></div></div></div>
          <div class="card"><div class="card-head"><h2>Jira credentials</h2>${connDot(p.connection.jira)}</div><div class="card-body flush"><div class="table-wrap"><table class="t"><thead><tr><th>Environment variable</th><th>Status</th><th>Purpose</th></tr></thead><tbody>
            ${row(`${c.jira.prefix || 'JIRA_'}EMAIL`, c.jira.configured, 'Atlassian account email')}
            ${row(`${c.jira.prefix || 'JIRA_'}API_TOKEN`, c.jira.configured, 'Atlassian API token')}
          </tbody></table></div><div class="card-body small muted">Only presence is shown. Values are never sent to the browser, logged or written to reports.</div></div></div></div>
          <div class="row mt"><button class="btn primary" data-act="test">${ic('refresh')} Test connections</button><span class="small muted">Calls the Salesforce limits endpoint and Jira /myself with the configured credentials.</span></div><div data-testout class="mt"></div>`);
      } else {
        const [field, help] = cfgTabs[tab];
        pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>${TABS.find((t) => t.id === tab).label}</h2><span class="small muted">${help}</span></div><div class="card-body">
          <textarea class="input mono" rows="22" data-cfg spellcheck="false" aria-label="${field} JSON">${JSON.stringify(p[field] || {}, null, 2)}</textarea>
          <div class="row mt"><span class="small muted">Secret-looking keys (password, secret, token) are rejected by the server.</span><span class="spacer"></span><button class="btn primary" data-save="${field}">Save</button></div></div></div>`);
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
    on(view, 'click', '[data-act=test]', (e, el) => withBusy(el, async () => {
      const out = pane.querySelector('[data-testout]');
      try {
        const r = await api.post(`/api/projects/${p.id}/connection/test`);
        const block = (name, x) => (x.ok ? h`<div class="callout ok">${ic('check')}<div><b>${name}: connected</b><div class="small">${Object.entries(x).filter(([k]) => !['ok'].includes(k)).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</div></div></div>` : errorBox({ message: `${name}: ${x.title || 'not connected'}`, info: x }));
        out.innerHTML = String(h`<div class="grid g-2">${block('Salesforce', r.salesforce)}${block('Jira', r.jira)}</div>`);
      } catch (err) { out.innerHTML = String(errorBox(err)); }
    }));
    return null;
  }
})();
