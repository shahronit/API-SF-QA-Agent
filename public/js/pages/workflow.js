/* QA lifecycle: one coherent sequence from project setup through reporting. */
(() => {
  const QA = window.QA;
  const { h, ic, fmt, badge, on, errorBox, loading, empty, toast, toastError, withBusy, esc } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  const LEGACY = {
    project: 'connect', jira: 'connect', salesforce: 'connect', discovery: 'connect', postman: 'connect',
    generate: 'create', review: 'create', approve: 'create',
    execute: 'run', validate: 'run', analysis: 'run',
    defect: 'report', report: 'report',
  };

  const MARK = {
    completed: { icon: 'check', cls: 'ok', title: 'Completed' },
    in_progress: { icon: 'play', cls: 'now', title: 'In progress' },
    not_started: { icon: 'circle', cls: '', title: 'Not started' },
    failed: { icon: 'alert', cls: 'bad', title: 'Failed' },
    blocked: { icon: 'lock', cls: 'blocked', title: 'Blocked' },
    requires_approval: { icon: 'lock', cls: 'warn', title: 'Requires approval' },
  };

  function mark(status, current) {
    const m = MARK[status] || MARK.not_started;
    const cls = current ? 'now' : m.cls;
    return h`<span class="wf-mark ${cls}" title="${m.title}">${ic(current && status !== 'completed' ? 'dot' : m.icon, 'icon-sm')}</span>`;
  }

  QA.pages.workflow = {
    async render(view, ctx) {
      const S = QA.state;
      const p = S.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      const stepId = ctx.params.step;
      QA.router.setCrumbs([{ label: 'How QA works', href: '/workflow' }, ...(stepId ? [{ label: stepId }] : [])]);
      view.innerHTML = String(loading(8));
      let wf;
      try {
        if (stepId) await api.put(`/api/projects/${p.id}/workflow`, { currentStep: stepId });
        wf = await api.get(`/api/projects/${p.id}/workflow`);
        if (S.project) S.project.workflow = wf;
      } catch (e) { view.innerHTML = String(errorBox(e)); return null; }
      if (!stepId) {
        QA.router.setCrumbs([{ label: 'How QA works' }]);
        const current = wf.steps.find((s) => s.id === wf.currentStep) || wf.steps[0];
        view.innerHTML = String(h`${C.pageHead('How QA works', h`${p.name} (${p.environment}). You left off at: ${current.label}. ${completedLine(wf)}`,
          h`<a class="btn primary" href="/workflow/${current.id}" data-link data-primary>${ic('play')} Continue: ${current.label}</a>`)}
          ${C.pageIntro({ what: 'Four stages: connect the org, create tests from Jira, run them, then report. Review, Salesforce checks and defects live inside those stages.', next: 'Click Continue, or open a stage. You can jump around — completed stages stay ticked.' })}
          <div class="grid g-2">${wf.steps.map((s) => h`<a class="card project-card ${s.id === wf.currentStep ? 'current' : ''}" href="/workflow/${esc(s.id)}" data-link>
            <div class="card-head">${mark(s.status, s.id === wf.currentStep)}<h2>${s.label}</h2>${badge(s.status.replace(/_/g, '-'), s.status.replace(/_/g, ' '))}</div>
            <div class="card-body">
              <p class="desc wrap">${s.help}</p>
              <p class="small muted">${s.primary}</p>
            </div>
          </a>`)}</div>`);
        return null;
      }
      const step = wf.steps.find((s) => s.id === stepId) || wf.steps.find((s) => s.id === LEGACY[stepId]) || wf.steps[0];
      const next = wf.steps.find((s) => s.id === step.next) || null;
      QA.router.setCrumbs([{ label: 'How QA works', href: '/workflow' }, { label: step.label }]);
      view.innerHTML = String(h`
        ${C.pageHead(step.label, h`${p.name} (${p.environment}). ${badge(step.status.replace('_', '-'), step.status.replace(/_/g, ' '))}. ${next ? h`Up next: ${next.label}.` : 'This is the last step.'}`,
          h`${next ? h`<a class="btn primary" href="/workflow/${next.id}" data-link data-primary>${ic('chevronRight')} ${step.primary}</a>` : h`<a class="btn primary" href="/reports" data-link>${ic('download')} ${step.primary}</a>`}`)}
        ${C.pageIntro({ what: step.help || step.label, next: step.primary })}
        <div data-step></div>`);
      const pane = view.querySelector('[data-step]');
      try {
        await renderStep(pane, p, step, wf, ctx);
      } catch (e) { pane.innerHTML = String(errorBox(e)); }
      return null;
    },
  };

  function completedLine(wf) {
    const done = wf.steps.filter((s) => s.status === 'completed').map((s) => s.label);
    const open = wf.steps.filter((s) => s.status !== 'completed').map((s) => s.label);
    return h`${done.length ? h`Completed: ${done.join(', ')}. ` : ''}${open.length ? h`Still open: ${open.slice(0, 4).join(', ')}${open.length > 4 ? '…' : ''}.` : 'All steps complete.'}`;
  }

  async function renderStep(pane, p, step, wf, ctx = {}) {
    const requested = (ctx.params && ctx.params.step) || '';
    const innerId = (ctx.query && ctx.query.tab)
      || (LEGACY[requested] && requested !== step.id ? requested : null)
      || ((step.parts && step.parts[0] && step.parts[0].id) || step.id);
    const tabs = (step.parts || []).map((x) => ({ id: x.id, label: x.label || x.id }));
    pane.innerHTML = String(h`${tabs.length ? C.tabs(tabs, innerId) : ''}<div data-inner></div>`);
    const inner = pane.querySelector('[data-inner]');
    const fn = STEPS[innerId] || (step.parts && STEPS[step.parts[0].id]) || STEPS.project;
    if (fn) await fn(inner, p, step, wf);
    else inner.innerHTML = String(empty({ title: 'Nothing to show' }));
    if (tabs.length) {
      on(pane, 'click', '[data-tab]', (e, el) => {
        e.preventDefault();
        QA.router.go(`/workflow/${step.id}?tab=${el.dataset.tab}`);
      });
    }
  }

  const STEPS = {
    async project(pane, p) {
      const envs = QA.state.meta.environments;
      pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>About this project</h2><span class="sub">Passwords stay in .env — not on this screen.</span></div><div class="card-body">
        <div class="form-grid">
          <label class="field full"><span>Project name</span><input class="input" name="name" value="${p.name}"></label>
          <label class="field full"><span>Project description</span><textarea class="input wrap" name="description" rows="2">${p.description || ''}</textarea></label>
          <label class="field"><span>Salesforce environment</span><select class="select" name="environment">${envs.map((e) => h`<option ${p.environment === e ? 'selected' : ''}>${e}</option>`)}</select></label>
          <label class="field"><span>Salesforce org</span><input class="input mono" name="sfOrg" value="${p.sfOrg || ''}" placeholder="acme--qa"></label>
          <label class="field"><span>Jira project</span><input class="input mono" name="jiraProjectKey" value="${p.jiraProjectKey || ''}"></label>
          <label class="field"><span>Postman workspace</span><input class="input" name="postmanWorkspace" value="${(p.integrationConfig && p.integrationConfig.postman && p.integrationConfig.postman.workspace) || ''}" placeholder="Workspace name or id"></label>
          <label class="field"><span>Default API version</span><input class="input mono" name="apiVersion" value="${p.apiVersion || '62.0'}"></label>
        </div>
        <div class="row mt"><button class="btn primary" data-act="save">${ic('check')} Save project and continue</button><a class="btn" href="/projects/${p.id}" data-link>Open full project settings</a></div>
      </div></div>`);
      on(pane, 'click', '[data-act=save]', (e, el) => withBusy(el, async () => {
        const b = {};
        pane.querySelectorAll('[name]').forEach((i) => { b[i.name] = i.value.trim() || null; });
        const icfg = { ...(p.integrationConfig || {}), postman: { ...((p.integrationConfig || {}).postman || {}), workspace: b.postmanWorkspace || '' } };
        delete b.postmanWorkspace;
        try {
          await api.put(`/api/projects/${p.id}`, { ...b, integrationConfig: icfg });
          toast('Project saved.', 'ok');
          await QA.state.reloadProjects();
          QA.router.go('/workflow/jira');
        } catch (err) { toastError(err); }
      }));
    },

    async jira(pane, p) {
      pane.innerHTML = String(loading(6));
      const [opts, stories] = await Promise.all([
        api.get(`/api/projects/${p.id}/jira/options`),
        api.get(`/api/stories?projectId=${p.id}&pageSize=50`),
      ]);
      pane.innerHTML = String(h`<div class="grid g-21">
        <div class="card"><div class="card-head"><h2>Select a Jira requirement</h2></div><div class="card-body">
          <div class="form-grid">
            <label class="field"><span>Jira project</span><input class="input mono" value="${opts.projectKey || ''}" disabled></label>
            <label class="field"><span>Sprint</span><select class="select" data-f="sprint"><option value="">All sprints</option>${opts.sprints.map((s) => h`<option>${s}</option>`)}</select></label>
            <label class="field"><span>Issue type</span><select class="select" data-f="type"><option value="">Epic / Story / Task / Bug</option>${opts.issueTypes.map((s) => h`<option>${s}</option>`)}</select></label>
          </div>
          <div class="mt" data-list></div>
          <div class="row mt"><a class="btn" href="/stories" data-link>${ic('jira')} Open tickets</a><button class="btn primary" data-act="sync">${ic('refresh')} Pull from Jira</button></div>
        </div></div>
        <div class="card" data-preview><div class="card-body">${empty({ icon: 'jira', title: 'Select a ticket', text: 'Traceability starts here: Jira story → scenario → test → Postman request → execution → Salesforce validation → defect.' })}</div></div>
      </div>`);
      const drawList = () => {
        const sprint = pane.querySelector('[data-f=sprint]').value;
        const type = pane.querySelector('[data-f=type]').value;
        const rows = stories.items.filter((s) => (!sprint || s.sprint === sprint) && (!type || s.issueType === type));
        pane.querySelector('[data-list]').innerHTML = String(QA.ui.table({
          rows, emptyState: empty({ title: 'No tickets', text: 'Sync from Jira or add a story.' }),
          rowAttrs: (r) => `data-story="${esc(r.key)}"`,
          columns: [
            { key: 'key', label: 'Key', render: (r) => h`<span class="mono">${r.key}</span>` },
            { key: 'summary', label: 'Summary', render: (r) => h`<div class="wrap">${r.summary}</div>` },
            { key: 'issueType', label: 'Type' },
            { key: 'status', label: 'Status' },
          ],
        }));
      };
      drawList();
      on(pane, 'change', '[data-f]', drawList);
      on(pane, 'click', '[data-story]', (e, el) => {
        const s = stories.items.find((x) => x.key === el.dataset.story);
        if (!s) return;
        pane.querySelector('[data-preview]').innerHTML = String(h`<div class="card-head"><h2 class="wrap">${s.key} ${s.summary}</h2></div><div class="card-body">
          ${C.kv([['Type', s.issueType], ['Sprint', s.sprint], ['Priority', s.priority], ['Needs API testing', s.classification && s.classification.needsApiTesting ? 'Yes (ASSUMED)' : 'Advisory no']])}
          <h3 class="mt">Description</h3><div class="wrap small">${s.description || '—'}</div>
          <h3 class="mt">Acceptance criteria</h3><div class="wrap small">${s.acceptanceCriteria || '—'}</div>
          <div class="row mt"><a class="btn primary" href="/stories/${s.key}" data-link>Open story</a><a class="btn" href="/workflow/salesforce" data-link>Continue to Salesforce</a></div>
        </div>`);
      });
      on(pane, 'click', '[data-act=sync]', (e, el) => withBusy(el, async () => {
        try { const r = await api.post(`/api/stories/sync?projectId=${p.id}`, {}); toast(`${r.synced} tickets synced.`, 'ok'); QA.router.render(); } catch (err) { toastError(err); }
      }));
    },

    async salesforce(pane, p) {
      const conn = await api.get(`/api/projects/${p.id}/connection`);
      const src = conn.salesforceSource || 'mcp';
      const sf = p.connection.salesforce;
      pane.innerHTML = String(h`<div class="card"><div class="card-head"><div class="card-kicker">${C.layerTag('backend')}<h2>Salesforce (backend APIs)</h2></div>${badge(sf.status, sf.label)}</div><div class="card-body">
        <p class="conn-status-line wrap">${sf.label || 'Not connected.'} ${(sf.types && sf.types.length) ? sf.types.join(' · ') + '.' : ''} Org REST, Apex REST, Experience Cloud B2B/B2C and SFCC B2B/B2C testers follow the org kind detected after login — each kind is its own project.</p>
        <p class="small muted wrap">Log in opens the org login page in your browser (Salesforce CLI web login, or Account Manager / Business Manager for SFCC). Tokens stay in the CLI. MCP and connected-app settings stay under Advanced.</p>
        <div class="row mt wrap"><button class="btn primary" data-act="login-sf">${ic('link')} Log in</button><button class="btn" data-act="test">${ic('refresh')} Test Salesforce</button><a class="btn" href="/projects/${p.id}?tab=connection" data-link>Open Connections</a></div>
        <details class="adv-block"><summary>Advanced — metadata source</summary>
          <div class="adv-body">
            <div class="form-grid">
              <label class="field"><span>Preferred source</span><select class="select" name="salesforceSource">
                <option value="mcp" ${src === 'mcp' ? 'selected' : ''}>Salesforce MCP</option>
                <option value="cli" ${src === 'cli' ? 'selected' : ''}>Salesforce CLI</option>
                <option value="oauth" ${src === 'oauth' ? 'selected' : ''}>Org OAuth (REST)</option>
              </select></label>
              <label class="field"><span>CLI org alias</span><input class="input mono" name="cliTarget" value="${(conn.salesforceCli && conn.salesforceCli.targetOrg) || p.sfOrg || ''}"></label>
            </div>
            <div class="row mt"><button class="btn" data-act="save">${ic('check')} Save preference</button></div>
          </div>
        </details>
        <div data-out class="mt"></div>
      </div></div>`);
      on(pane, 'click', '[data-act=save]', (e, el) => withBusy(el, async () => {
        try {
          await api.put(`/api/projects/${p.id}/connection`, { salesforceSource: pane.querySelector('[name=salesforceSource]').value, salesforceCli: { enabled: true, targetOrg: pane.querySelector('[name=cliTarget]').value } });
          toast('Connection preference saved.', 'ok');
        } catch (err) { toastError(err); }
      }));
      on(pane, 'click', '[data-act=login-sf]', (e, el) => withBusy(el, async () => {
        try {
          const r = await api.post(`/api/projects/${p.id}/connection/login?target=salesforce`, { instanceUrl: p.instanceUrl });
          pane.querySelector('[data-out]').innerHTML = String(h`<div class="callout success">${ic('check')}<div><b>${r.title || 'Login started'}</b><div class="small wrap">${r.text || 'Finish in the browser, then Test.'}</div></div></div>`);
          toast(r.title || 'Login opened. Finish in the browser, then Test.', 'ok');
        } catch (err) { pane.querySelector('[data-out]').innerHTML = String(errorBox(err)); toastError(err, 'Salesforce login did not start'); }
      }));
      on(pane, 'click', '[data-act=test]', (e, el) => withBusy(el, async () => {
        try {
          const r = await api.post(`/api/projects/${p.id}/connection/test?target=salesforce`);
          const sfRes = r.salesforce || {};
          const bits = [];
          if (sfRes.demo) bits.push('demo simulator');
          if (sfRes.org && sfRes.org.ok) bits.push('org reachable');
          else if (sfRes.latestApiVersion) bits.push('org reachable');
          if (sfRes.mcp && sfRes.mcp.ok) bits.push('MCP connected');
          if (sfRes.cli && sfRes.cli.ok) bits.push(sfRes.cli.status === 'AUTHENTICATED' ? 'CLI authenticated' : 'CLI connected');
          const types = sfRes.types || (sfRes.detection && sfRes.detection.types) || [];
          if (types.length) bits.push(types.join(', '));
          pane.querySelector('[data-out]').innerHTML = String(sfRes.ok
            ? h`<div class="callout success">${ic('check')}<div><b>Pass</b><div class="small wrap">${bits.join(', ') || 'Salesforce is reachable'}. ${(sfRes.detection && sfRes.detection.explanation) || ''}</div></div></div>`
            : errorBox({ message: `Fail — ${sfRes.title || 'Salesforce connection failed'}`, info: { action: sfRes.action, cause: sfRes.cause } }));
        } catch (err) { pane.querySelector('[data-out]').innerHTML = String(errorBox(err)); }
      }));
    },

    async discovery(pane, p) {
      pane.innerHTML = String(loading(6));
      try {
        const d = await api.get(`/api/projects/${p.id}/sobjects`);
        pane.innerHTML = String(h`<div class="card"><div class="card-head"><div class="card-kicker">${C.layerTag('backend')}<h2>Salesforce API discovery</h2></div><span class="sub">${d.source || ''} · ${QA.ui.prov(d.label)}</span></div>
          ${QA.ui.table({ rows: d.objects.slice(0, 80), columns: [
            { key: 'label', label: 'Object', render: (o) => h`<div>${o.label}</div><div class="cell-sub mono">${o.name}</div>` },
            { key: 'custom', label: 'Custom', render: (o) => o.custom ? 'Yes' : 'No' },
            { key: 'open', label: '', render: (o) => h`<a class="btn xs" href="/explorer?object=${encodeURIComponent(o.name)}" data-link>Inspect</a>` },
          ] })}
          <div class="card-body"><p class="small muted wrap">This list is backend Salesforce objects. Frontend HTTP collections are the next step.</p><a class="btn primary" href="/explorer" data-link>${ic('code')} Open API Explorer</a><a class="btn" href="/workflow/postman" data-link>Continue to HTTP / Postman</a></div>
        </div>`);
      } catch (e) { pane.innerHTML = String(errorBox(e)); }
    },

    async postman(pane, p) {
      pane.innerHTML = String(h`<div class="card"><div class="card-head"><div class="card-kicker">${C.layerTag('frontend')}<h2>HTTP / Postman collections</h2></div><span class="sub">Frontend APIs: custom REST, storefront, middleware, BFF.</span></div>
        <div class="card-body">
          <div class="row wrap"><button class="btn primary" data-act="discover">${ic('search')} Analyze workspace</button>
            <button class="btn" data-act="use-existing">${ic('folder')} Use existing collection</button>
            <button class="btn" data-act="create">${ic('plus')} Create new collection</button>
            <a class="btn" href="/automation" data-link>Import collection file</a>
            <a class="btn" href="/projects/${p.id}?tab=connection" data-link>Postman connection</a></div>
          <p class="small muted mt wrap">Pick a collection this project already has, or import any Postman version (v1 / v2 / v2.1) on HTTP / Postman. Requests become Tests immediately and can run without generate/approve. Salesforce MCP/CLI is backend metadata only.</p>
          <div data-out class="mt">${loading(4)}</div>
        </div></div>`);
      const out = pane.querySelector('[data-out]');
      async function analyze() {
        out.innerHTML = String(loading(6));
        try {
          const r = await api.post(`/api/projects/${p.id}/postman/analyze`, {});
          drawAnalyze(out, p, r);
        } catch (e) { out.innerHTML = String(errorBox(e)); }
      }
      analyze();
      on(pane, 'click', '[data-act=discover]', analyze);
      on(pane, 'click', '[data-act=use-existing]', (e, el) => withBusy(el, async () => {
        out.innerHTML = String(loading(6));
        try {
          const r = await api.get(`/api/projects/${p.id}/postman/collections`);
          drawCollectionPicker(out, p, r.items || [], r);
        } catch (err) { out.innerHTML = String(errorBox(err)); }
      }));
      on(pane, 'click', '[data-act=create]', (e, el) => withBusy(el, async () => {
        try {
          const r = await api.post(`/api/projects/${p.id}/postman/create`, {});
          toast(r.postman && r.postman.mcp ? `Created and synced “${r.collection.name}” to Postman.` : `Created ${r.collection.name}${r.postman && r.postman.notice ? `. ${r.postman.notice}` : '.'}`, r.postman && r.postman.mcp ? 'ok' : 'warn');
          analyze();
        } catch (err) { toastError(err); }
      }));
    },

    async generate(pane, p) {
      const [stories, tests] = await Promise.all([
        api.get(`/api/stories?projectId=${p.id}&pageSize=40`),
        api.get(`/api/testcases${api.qs({ projectId: p.id, pageSize: 5, sort: 'seq', dir: 'ASC' })}`),
      ]);
      const g = (QA.state.meta && QA.state.meta.generators) || {};
      const ready = tests.total || (tests.items || []).length;
      pane.innerHTML = String(h`${ready ? h`<div class="callout ok" style="margin-bottom:16px">${ic('check')}<div class="small wrap"><b>${fmt.num(ready)} test(s) are already on this project</b> (including imported collections). They are runnable now — generate/approve is only for tickets that still have no tests. <a href="/testcases" data-link>Open Tests</a> · <button class="btn xs primary" data-act="run-ready">${ic('play')} Run tests</button></div></div>` : ''}
        <div class="card"><div class="card-head"><h2>Generate API tests</h2></div>
        <div class="card-body"><p class="small wrap">${ready ? 'Use generate when a Jira ticket has no tests yet.' : 'This project has no tests yet. Import a collection on HTTP / Postman, or generate from a Jira ticket (you still approve).'} Engine baseline plus Cursor CLI (${g.cursorInstalled ? (g.cursorCliEnabled ? 'enabled' : 'installed, flag off') : 'not installed'}) then Gemini CLI (${g.geminiInstalled ? (g.geminiCliEnabled ? 'enabled' : 'installed, flag off') : 'not installed'}).</p></div>
        ${QA.ui.table({ rows: stories.items, emptyState: empty({ title: 'No stories', text: ready ? 'Tests can still run from the Tests page. Sync Jira to attach them to a ticket.' : 'Sync Jira first, or import a collection.', action: h`<a class="btn primary" href="/automation" data-link>Import collection</a><a class="btn" href="/workflow/jira" data-link>Open Jira requirement</a>` }), columns: [
          { key: 'key', label: 'Jira', render: (s) => h`<a class="mono" href="/stories/${s.key}" data-link>${s.key}</a>` },
          { key: 'summary', label: 'Summary', render: (s) => h`<div class="wrap">${s.summary}</div>` },
          { key: 'coverage', label: 'Tests', render: (s) => fmt.num(s.coverage && s.coverage.tests) },
          { key: 'act', label: '', render: (s) => h`<a class="btn xs" href="/stories/${s.key}" data-link>Attach</a><button class="btn xs primary" data-gen="${s.key}">Generate</button>` },
        ] })}
        <div class="card-body"><a class="btn" href="/stories" data-link>Open Stories &amp; Tests</a><a class="btn" href="/testcases" data-link>Open Tests</a></div></div>`);
      on(pane, 'click', '[data-act=run-ready]', () => C.runDialog());
      on(pane, 'click', '[data-gen]', (e, el) => withBusy(el, async () => {
        try {
          const r = await api.post('/api/generate', { storyKey: el.dataset.gen, projectId: p.id });
          toast('Proposal ready for review.', 'ok');
          QA.router.go(`/generate/${r.id}`);
        } catch (err) { toastError(err); }
      }));
    },

    async review(pane, p) {
      const list = await api.get(`/api/proposals?projectId=${p.id}`);
      const pending = list.filter((x) => x.status === 'proposed');
      pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>Test review</h2><span class="sub">${pending.length} awaiting approval</span></div>
        ${QA.ui.table({ rows: list.slice(0, 30), emptyState: empty({ title: 'No proposals', text: 'Generate tests from a Jira story first.', action: h`<a class="btn primary" href="/workflow/generate" data-link>Generate tests</a>` }), columns: [
          { key: 'id', label: 'Proposal', render: (r) => h`<a class="mono" href="/generate/${r.id}" data-link>${r.id}</a>` },
          { key: 'storyKey', label: 'Jira' },
          { key: 'generator', label: 'Generator', render: (r) => h`<span class="tag mono">${r.generator || 'engine'}</span>` },
          { key: 'status', label: 'Status', render: (r) => badge(r.status) },
          { key: 'createdAt', label: 'Created', render: (r) => fmt.ago(r.createdAt) },
        ] })}</div>`);
    },

    async approve(pane, p) {
      await STEPS.review(pane, p);
      pane.insertAdjacentHTML('afterbegin', String(h`<div class="callout info" style="margin-bottom:16px">${ic('check')}<div class="small">Open a proposal to select, deselect, edit or approve tests. Approving upserts the suite into a Postman collection (via Postman MCP when connected). Nothing is written to Jira unless you choose that on the proposal.</div></div>`));
    },

    async execute(pane, p) {
      const runs = await api.get(`/api/runs?projectId=${p.id}&pageSize=8`);
      pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>API execution</h2><div class="row">
        <button class="btn primary" data-act="run">${ic('play')} Run all</button>
        <button class="btn" data-act="failed">${ic('refresh')} Re-run failed</button>
        <a class="btn" href="/execution" data-link>Open Test Runs</a></div></div>
        <div class="card-body">
          ${h`<div class="callout info">${ic('play')}<div class="small wrap">Start a run and pick the runner: Playwright MCP, Postman MCP, or the platform. Connect them on <a href="/projects/${p.id}?tab=connection" data-link>Connections</a>. Demo always uses the simulator. Tokens stay masked; Production writes still need confirmation.</div></div>`}
          <p class="small muted wrap mt">After a run, use the Salesforce data and Failures tabs here, or open Test Runs.</p>
        </div>
        ${QA.ui.table({ rows: runs.items, columns: [
          { key: 'id', label: 'Run', render: (r) => h`<a class="mono" href="/execution/${r.id}" data-link>${r.id}</a>` },
          { key: 'status', label: 'Status', render: (r) => badge(r.status) },
          { key: 'result', label: 'Result', render: (r) => h`${r.passed}/${r.total} passed · ${r.failed} failed` },
          { key: 'startedAt', label: 'When', render: (r) => fmt.ago(r.startedAt) },
        ] })}</div>`);
      on(pane, 'click', '[data-act=run]', () => C.runDialog());
      on(pane, 'click', '[data-act=failed]', () => C.startRun({ mode: 'failed' }));
    },

    async validate(pane, p) {
      const runs = await api.get(`/api/runs?projectId=${p.id}&pageSize=1`);
      const last = runs.items[0];
      if (!last) { pane.innerHTML = String(empty({ title: 'No execution yet', text: 'Run tests first.', action: h`<a class="btn primary" href="/workflow/execute" data-link>Execute tests</a>` })); return; }
      QA.router.go(`/execution/${last.id}?tab=data`);
    },

    async analysis(pane, p) {
      const runs = await api.get(`/api/runs?projectId=${p.id}&pageSize=1`);
      const last = runs.items[0];
      if (!last) { pane.innerHTML = String(empty({ title: 'No results yet', action: h`<a class="btn primary" href="/workflow/execute" data-link>Execute tests</a>` })); return; }
      QA.router.go(`/execution/${last.id}?tab=analysis`);
    },

    async defect(pane) {
      pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>Raise defects</h2></div><div class="card-body">
        <p class="small wrap">Open a failed result, preview the masked Jira draft, then create. Nothing is posted until you confirm.</p>
        <div class="row mt"><a class="btn primary" href="/defects" data-link>${ic('bug')} Open defects</a><a class="btn" href="/execution" data-link>Failed tests</a></div>
      </div></div>`);
    },

    async report(pane) {
      pane.innerHTML = String(h`<div class="card"><div class="card-head"><h2>Download report</h2></div><div class="card-body">
        <p class="small wrap">Export PDF, Excel, CSV or HTML. Tokens and credentials are masked. Traceability shows story → test → run → defect.</p>
        <div class="row mt"><a class="btn primary" href="/reports" data-link>${ic('download')} Open reports</a><a class="btn" href="/traceability" data-link>Traceability</a></div>
      </div></div>`);
    },
  };

  function collectionPickerTable(items, linkedId) {
    return QA.ui.table({
      rows: items,
      emptyState: empty({ title: 'No collections listed', text: 'Import a Collection v2.1 JSON file, or connect a Postman workspace.' }),
      columns: [
        { key: 'name', label: 'Collection', render: (c) => h`<div class="wrap">${c.name}${(c.linked || (linkedId && c.uid === linkedId)) ? ' · in use' : ''}</div><div class="cell-sub">${c.source || ''} · ${c.requestCount || 0} requests${c.score ? ` · match ${c.score}` : ''}</div>` },
        { key: 'workspace', label: 'Workspace', render: (c) => c.workspace || '—' },
        { key: 'act', label: '', render: (c) => h`<button class="btn xs primary" data-act="use-col" data-uid="${c.uid}">Use this collection</button>` },
      ],
    });
  }

  function bindUseCollection(root, p, after) {
    on(root, 'click', '[data-act=use-col]', (e, el) => withBusy(el, async () => {
      try {
        const r = await api.post(`/api/projects/${p.id}/postman/attach`, { uid: el.dataset.uid, importTests: true });
        toast(r.notice || `Using “${r.name}” on this project.`, 'ok');
        if (r.imported) {
          QA.router.go(r.testsHref || '/testcases');
          return;
        }
        if (after) await after();
      } catch (err) { toastError(err); }
    }));
  }

  function drawCollectionPicker(out, p, items, meta = {}) {
    const linked = meta.linkedCollectionId;
    out.innerHTML = String(h`
      <div class="callout info">${ic('folder')}<div class="small wrap">${linked ? `This project is linked to <code>${linked}</code>. Choose another collection to switch, or keep using it on Run.` : 'Choose an existing collection for this project. Approve and Run will reuse it instead of creating a new one.'}</div></div>
      ${collectionPickerTable(items, linked)}
      <div class="row mt"><a class="btn" href="/automation" data-link>Import a collection file</a></div>
    `);
    bindUseCollection(out, p, async () => {
      const r = await api.post(`/api/projects/${p.id}/postman/analyze`, {});
      drawAnalyze(out, p, r);
    });
  }

  function drawAnalyze(out, p, r) {
    const discovered = r.discovered || [];
    const linked = r.linkedCollectionId;
    if (r.action === 'create') {
      out.innerHTML = String(h`<div class="callout">${ic('info')}<div class="small wrap"><b>No collection auto-selected.</b> ${r.reason} Folders that would be created: ${(r.folders || []).join(', ') || 'only those required by tests'}.</div></div>
        ${discovered.length ? collectionPickerTable(discovered, linked) : ''}
        <div class="row mt"><a class="btn" href="/automation" data-link>Import collection file</a></div>`);
      bindUseCollection(out, p, async () => {
        const again = await api.post(`/api/projects/${p.id}/postman/analyze`, {});
        drawAnalyze(out, p, again);
      });
      return;
    }
    const d = r.diff || { summary: {}, existing: [], missing: [], changed: [], duplicate: [], recommended: [], variables: { warnings: [] }, changes: [] };
    const inUse = r.collection && (r.collection.linked || (linked && r.collection.uid === linked));
    out.innerHTML = String(h`
      <div class="callout ${r.action === 'reuse' ? 'success' : 'info'}">${ic(r.action === 'reuse' ? 'check' : 'layers')}<div class="small wrap"><b>${r.collection.name}</b> (${r.collection.source}). ${r.action === 'reuse' ? 'Existing requests will be reused. No duplicate POST will be created.' : 'Review the difference before anything is written to Postman.'}${inUse ? ' Linked to this project.' : ''}</div></div>
      <div class="row wrap mt"><button class="btn primary" data-act="use-col" data-uid="${r.collection.uid}">${inUse ? 'Keep using this collection' : `Use “${r.collection.name}”`}</button></div>
      <div class="stat-inline mt"><span><b>${d.summary.existing || 0}</b> existing</span><span><b>${d.summary.missing || 0}</b> missing</span><span><b>${d.summary.changed || 0}</b> changed</span><span><b>${d.summary.duplicate || 0}</b> duplicate</span><span><b>${d.summary.recommended || 0}</b> recommended</span></div>
      ${d.variables && d.variables.warnings && d.variables.warnings.length ? h`<div class="callout warn mt">${ic('alert')}<div class="small wrap">${d.variables.warnings.map((w) => w.message).join(' ')}</div></div>` : ''}
      ${QA.ui.table({ rows: [
        ...d.existing.map((x) => ({ kind: 'EXISTING', detail: x.existingName, key: x.key })),
        ...d.missing.map((x) => ({ kind: 'MISSING', detail: x.title, key: x.key })),
        ...d.changed.map((x) => ({ kind: 'CHANGED', detail: x.message, key: x.key })),
        ...d.duplicate.map((x) => ({ kind: 'DUPLICATE', detail: `${x.existing} / ${x.extra}`, key: x.key })),
        ...d.recommended.map((x) => ({ kind: 'RECOMMENDED', detail: x.title, key: x.key })),
      ], columns: [
        { key: 'kind', label: 'Kind', render: (x) => h`<span class="tag">${x.kind}</span>` },
        { key: 'key', label: 'Request', render: (x) => h`<code class="mono small wrap">${x.key}</code>` },
        { key: 'detail', label: 'Detail', render: (x) => h`<div class="wrap small">${x.detail}</div>` },
      ] })}
      ${discovered.length > 1 ? h`<h3 class="mt">Other collections</h3>${collectionPickerTable(discovered.filter((c) => c.uid !== r.collection.uid), linked)}` : ''}
      ${r.action === 'update' ? h`<div class="card mt"><div class="card-head"><h2>Collection: ${r.collection.name}</h2></div><div class="card-body">
        <ul class="list">${(d.changes || []).map((c) => h`<li class="small wrap">${c}</li>`)}</ul>
        <div class="row mt"><button class="btn primary" data-approve>${ic('check')} Approve changes</button><button class="btn" data-reject>Reject</button><a class="btn" href="/automation" data-link>Edit in CI export</a></div>
      </div></div>` : ''}
    `);
    const goProposal = async (status) => {
      const rec = await api.post(`/api/projects/${p.id}/postman/proposals`, { uid: r.collection.uid, collectionId: r.collection.id, diff: d });
      if (status === 'approve') await api.post(`/api/projects/${p.id}/postman/proposals/${rec.id}/approve`, {});
      else await api.post(`/api/projects/${p.id}/postman/proposals/${rec.id}/reject`, {});
      toast(status === 'approve' ? 'Collection update approved and synced to Postman when MCP is connected.' : 'Collection changes rejected.', status === 'approve' ? 'ok' : 'warn');
    };
    bindUseCollection(out, p, async () => {
      const again = await api.post(`/api/projects/${p.id}/postman/analyze`, {});
      drawAnalyze(out, p, again);
    });
    on(out, 'click', '[data-approve]', (e, el) => withBusy(el, () => goProposal('approve')));
    on(out, 'click', '[data-reject]', (e, el) => withBusy(el, () => goProposal('reject')));
  }

  QA.workflow = { mark, MARK };
})();
