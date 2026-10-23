/* Jira stories: list, story detail, and the generate → review → approve workflow. */
(() => {
  const QA = window.QA;
  const { h, raw, ic, fmt, badge, prov, pri, method, on, errorBox, loading, empty, toast, toastError, withBusy, esc, modal, json } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.stories = {
    render(view, ctx) {
      if (!QA.state.project) { view.innerHTML = String(C.projectRequired()); return null; }
      if (ctx.pattern === '/generate/:id') return renderProposal(view, ctx.params.id, null);
      if (ctx.params.key && ctx.query.proposal) return renderProposal(view, ctx.query.proposal, ctx.params.key);
      if (ctx.params.key) return renderStory(view, ctx.params.key);
      return renderList(view, ctx);
    },
  };

  const relevanceBadge = (cls) => {
    if (!cls) return h`<span class="faint small">–</span>`;
    const tone = cls.needsApiTesting ? (cls.confidence === 'high' ? 'ok' : '') : 'warn';
    const label = cls.needsApiTesting ? 'Needed' : 'Not needed';
    return h`<span class="badge ${tone}" title="${(cls.reasons || []).join(' ')} (ASSUMED, ${cls.confidence} confidence)">${label}</span>`;
  };

  const coverageBar = (c) => {
    if (!c || !c.tests) return h`<span class="faint small">No tests</span>`;
    return h`<div class="progress" style="width:120px" title="${c.passed} passed, ${c.failed} failed, ${c.blocked} blocked of ${c.tests}"><span style="width:${(c.passed / c.tests) * 100}%;background:var(--success)"></span><span style="width:${(c.failed / c.tests) * 100}%;background:var(--error)"></span><span style="width:${(c.blocked / c.tests) * 100}%;background:var(--warning)"></span></div><div class="cell-sub num">${c.tests} tests · ${c.executed} executed</div>`;
  };

  // ── List ──
  function renderList(view, ctx) {
    const p = QA.state.project;
    QA.router.setCrumbs([{ label: 'Jira stories' }]);
    const jira = p.connection && p.connection.jira;
    view.innerHTML = String(h`${C.pageHead('Jira tickets', h`${jira ? `Tickets from ${p.jiraProjectKey}.` : 'Jira is not connected yet.'} Open a ticket to generate API tests for that ticket only.`,
      h`<button class="btn" data-act="add">${ic('plus')} Add ticket</button><button class="btn" data-act="sync">${ic('zap')} Pull from Jira</button><button class="btn" data-act="gen-all">${ic('wand')} Generate all tickets</button><button class="btn primary" data-act="gen-jira">${ic('wand')} Generate tests</button>`)}
      ${C.pageIntro({ what: 'These are the Jira stories for this project. If tests were imported from a collection, open a ticket and attach them — they are already runnable. Generate API tests only when a ticket has no tests yet; that path still needs review and approve.', next: jira ? 'Open a ticket to attach imported tests or generate a new suite. You review and approve generated suites before they become tests.' : 'Add a Jira site on the project Connections tab, or add a ticket by hand to try the flow in Demo.' })}
      <div data-list></div>`);
    let sprints = [];
    const list = C.listController(view.querySelector('[data-list]'), {
      sort: 'key', dir: 'ASC', searchPlaceholder: 'Search key, summary or description', filters: { sprint: ctx.query.sprint || '' },
      toolbar: (s) => h`<select class="select" data-filter="sprint" aria-label="Sprint"><option value="">All sprints</option>${sprints.map((x) => h`<option ${s.filters.sprint === x ? 'selected' : ''}>${x}</option>`)}</select>`,
      fetch: async (q) => { const r = await api.get(`/api/stories${api.qs({ projectId: p.id, ...q })}`); if (r.sprints && r.sprints.join() !== sprints.join()) { sprints = r.sprints; setTimeout(() => list.renderToolbar(), 0); } return r; },
      rowAttrs: (r) => `data-id="${esc(r.id)}"`,
      onRow: (r) => QA.router.go(`/stories/${r.key}`),
      emptyState: () => empty({ icon: 'jira', title: 'No tickets yet', text: 'Pull tickets from Jira, or add one by hand to try generating tests.', action: h`<button class="btn primary" data-act="sync">${ic('refresh')} Pull from Jira</button>` }),
      columns: [
        { key: 'key', label: 'Key', sortable: true, render: (r) => h`<b class="mono small">${r.key}</b>` },
        { key: 'summary', label: 'Summary', sortable: true, render: (r) => h`<div class="cell-title">${r.summary}</div><div class="cell-sub">${(r.components || []).join(', ')}${r.assignee ? ` · ${r.assignee}` : ''}</div>` },
        { key: 'status', label: 'Status', sortable: true, render: (r) => h`<span class="tag">${r.status}</span>` },
        { key: 'priority', label: 'Priority', sortable: true },
        { key: 'sprint', label: 'Sprint', sortable: true },
        { key: 'relevance', label: 'API testing', render: (r) => relevanceBadge(r.classification) },
        { key: 'coverage', label: 'API test coverage', render: (r) => coverageBar(r.coverage) },
        { key: 'defects', label: 'Defects', cls: 'num', render: (r) => (r.defects ? h`<span class="text-error">${r.defects}</span>` : '0') },
        { key: 'actions', label: '', cls: 'actions', render: (r) => h`<button class="btn xs" data-gen="${r.key}">${ic('wand')} Generate</button>` },
      ],
    });
    on(view, 'click', '[data-gen]', (e, el) => { e.stopPropagation(); generate(el.dataset.gen, el, { inputSource: 'jira' }); });
    on(view, 'click', '[data-act=sync]', () => syncDialog(list));
    on(view, 'click', '[data-act=add]', () => addDialog(list));
    on(view, 'click', '[data-act=gen-jira]', () => generateFromJira(list));
    on(view, 'click', '[data-act=gen-all]', () => generateFromJira(list, { generateAll: true }));
    return null;
  }

  const INPUT_SOURCES = [
    { id: 'jira', label: 'Jira ticket', hint: 'Ticket summary, description and acceptance criteria only.' },
    { id: 'docs', label: 'Integration doc', hint: 'Selected integration documents only.' },
    { id: 'jira+docs', label: 'Jira ticket + Integration doc', hint: 'Combine the ticket with selected documents.' },
  ];

  function sourcePicker(selected) {
    return h`<fieldset class="stack" style="gap:8px;border:0;padding:0;margin:0 0 12px">
      <legend class="small" style="font-weight:600;margin-bottom:6px">Generate from</legend>
      ${INPUT_SOURCES.map((x) => h`<label class="check-row"><input type="radio" name="inputSource" value="${x.id}" ${selected === x.id ? 'checked' : ''}> <span><b>${x.label}</b><div class="cell-sub">${x.hint}</div></span></label>`)}
    </fieldset>`;
  }

  function pickedSource(root) {
    const el = root.querySelector('[name=inputSource]:checked');
    return (el && el.value) || 'jira';
  }

  function sourceLabel(id) {
    return (INPUT_SOURCES.find((x) => x.id === id) || { label: id || 'Jira ticket + Integration doc' }).label;
  }

  function generateFromJira(list, opts = {}) {
    const p = QA.state.project;
    const presetKey = String(opts.storyKey || '').trim().toUpperCase();
    const presetAll = Boolean(opts.generateAll);
    modal({
      title: presetAll ? 'Generate API tests for all tickets' : 'Generate API tests',
      subtitle: presetAll
        ? 'Creates a proposal for every ticket matching JQL (or the default project query). You still review and approve each suite.'
        : 'Generates for one Jira ticket. Cursor CLI / Gemini CLI overlay extra scenarios if you are logged in. You still review and approve.',
      body: h`${sourcePicker('jira')}
        <div data-ticket-fields>
          <label class="field"><span>Jira ticket</span>
            <input class="input mono" name="storyKey" list="gen-story-keys" value="${presetKey}" placeholder="${p.jiraProjectKey || 'PROJ'}-123" autocomplete="off">
            <datalist id="gen-story-keys"></datalist>
            <small>Required unless you generate from integration docs only, or generate for every matching ticket.</small>
          </label>
          <label class="field"><span class="row" style="gap:8px;align-items:center"><input type="checkbox" name="generateAll" ${presetAll ? 'checked' : ''}> Generate for every ticket matching JQL</span></label>
        </div>
        <div data-jira-fields ${presetAll ? '' : 'hidden'}>
          <label class="field"><span>JQL (optional)</span><textarea class="input mono" rows="3" name="jql" placeholder="project = ${p.jiraProjectKey || 'PROJ'} AND issuetype = Story"></textarea></label>
          <label class="field"><span class="row" style="gap:8px;align-items:center"><input type="checkbox" name="onlyApi" checked> Only tickets classified as needing API testing</span></label>
        </div>
        <p class="small muted" data-docs-hint hidden>Uses integration docs on this project. Tests are stored on a local DOC story if you do not pick a ticket.</p>`,
      foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>${ic('wand')} Generate</button>`,
      onMount(el, close) {
        const syncHint = () => {
          const src = pickedSource(el);
          const all = el.querySelector('[name=generateAll]') && el.querySelector('[name=generateAll]').checked;
          const jira = el.querySelector('[data-jira-fields]');
          const ticket = el.querySelector('[data-ticket-fields]');
          const docs = el.querySelector('[data-docs-hint]');
          if (ticket) ticket.hidden = src === 'docs';
          if (jira) jira.hidden = src === 'docs' || !all;
          if (docs) docs.hidden = src === 'jira';
        };
        el.querySelectorAll('[name=inputSource]').forEach((r) => r.addEventListener('change', syncHint));
        const allCb = el.querySelector('[name=generateAll]');
        if (allCb) allCb.addEventListener('change', syncHint);
        syncHint();
        api.get(`/api/stories${api.qs({ projectId: p.id, pageSize: 100 })}`).then((r) => {
          const dl = el.querySelector('#gen-story-keys');
          if (!dl) return;
          dl.innerHTML = String(h`${(r.items || []).map((s) => h`<option value="${s.key}">${s.summary || s.key}</option>`)}`);
        }).catch(() => {});
        el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
          try {
            const inputSource = pickedSource(el);
            const generateAll = Boolean(el.querySelector('[name=generateAll]') && el.querySelector('[name=generateAll]').checked);
            const storyKey = ((el.querySelector('[name=storyKey]') && el.querySelector('[name=storyKey]').value) || '').trim().toUpperCase();
            if (inputSource === 'docs' && !generateAll) {
              const pr = await api.post(`/api/generate?projectId=${p.id}`, { inputSource: 'docs', storyKey: storyKey || undefined });
              close();
              toast('Proposal ready for review.', 'ok');
              list.reload();
              QA.router.go(`/stories/${pr.storyKey}?proposal=${pr.id}`);
              return;
            }
            if (generateAll) {
              const r = await api.post(`/api/stories/sync-and-generate?projectId=${p.id}`, {
                jql: el.querySelector('[name=jql]').value.trim() || undefined,
                onlyNeedingApi: el.querySelector('[name=onlyApi]').checked,
                inputSource,
              });
              close();
              toast(`Synced ${r.synced} · generated ${r.proposals.length} proposal(s).`, 'ok', 'Scripts generated');
              list.reload();
              if (r.proposals[0]) QA.router.go(`/stories/${r.proposals[0].storyKey}?proposal=${r.proposals[0].id}`);
              return;
            }
            if (!storyKey) {
              toast('Enter the Jira ticket to generate for, or check generate for every matching ticket.', 'warn');
              return;
            }
            const pr = await api.post(`/api/generate?projectId=${p.id}`, { storyKey, inputSource });
            close();
            toast(`Proposal ready for ${pr.storyKey || storyKey}.`, 'ok');
            list.reload();
            QA.router.go(`/stories/${pr.storyKey || storyKey}?proposal=${pr.id}`);
          } catch (err) { toastError(err, 'Generate failed'); }
        }));
      },
    });
  }

  function syncDialog(list) {
    const p = QA.state.project;
    modal({
      title: 'Sync stories from Jira', subtitle: `Reads issues from ${p.jiraProjectKey}. Nothing is written to Jira.`,
      body: h`<label class="field"><span>JQL (optional)</span><textarea class="input mono" rows="3" name="jql" placeholder="project = ${p.jiraProjectKey} AND issuetype = Story AND sprint in openSprints()"></textarea><small>Leave empty to fetch recent stories in ${p.jiraProjectKey}.</small></label>`,
      foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>${ic('refresh')} Sync</button>`,
      onMount(el, close) {
        el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
          try { const r = await api.post(`/api/stories/sync?projectId=${p.id}`, { jql: el.querySelector('[name=jql]').value.trim() || undefined }); close(); toast(`${r.synced} stories synced from Jira.`, 'ok', 'Sync complete'); list.reload(); } catch (err) { toastError(err, 'Sync failed'); }
        }));
      },
    });
  }

  function addDialog(list) {
    const p = QA.state.project;
    modal({
      title: 'Add story manually', subtitle: 'Use this when Jira is unavailable. The story stays local to this platform.', size: 'wide',
      body: h`<div class="form-grid"><label class="field"><span>Key</span><input class="input mono" name="key" placeholder="${p.jiraProjectKey || 'PROJ'}-123" required></label>
        <label class="field"><span>Sprint</span><input class="input" name="sprint"></label>
        <label class="field full"><span>Summary</span><input class="input" name="summary" required></label>
        <label class="field full"><span>Description</span><textarea class="input" rows="4" name="description"></textarea></label>
        <label class="field full"><span>Acceptance criteria (one per line)</span><textarea class="input" rows="5" name="acceptanceCriteria"></textarea></label></div>`,
      foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Add story</button>`,
      onMount(el, close) {
        el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
          const v = (n) => el.querySelector(`[name=${n}]`).value.trim();
          try { const s = await api.post(`/api/stories?projectId=${p.id}`, { key: v('key').toUpperCase(), summary: v('summary'), sprint: v('sprint') || null, description: v('description'), acceptanceCriteria: v('acceptanceCriteria'), status: 'To Do', issueType: 'Story' }); close(); toast(`${s.key} added.`, 'ok'); list.reload(); } catch (err) { toastError(err, 'Story not added'); }
        }));
      },
    });
  }

  function attachTestsDialog(story, after) {
    const p = QA.state.project;
    modal({
      title: `Attach tests to ${story.key}`,
      subtitle: 'Pick imported or unlinked tests. They stay executable; this only stores the ticket key.',
      size: 'wide',
      body: h`<div data-attach>${loading(6)}</div>`,
      foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>${ic('check')} Attach selected</button>`,
      onMount(el, close) {
        const box = el.querySelector('[data-attach]');
        api.get(`/api/testcases${api.qs({ projectId: p.id, unlinked: 'true', pageSize: 200, sort: 'seq', dir: 'ASC' })}`).then((r) => {
          const rows = r.items || [];
          if (!rows.length) {
            box.innerHTML = String(empty({ icon: 'upload', title: 'No unlinked tests', text: 'Import a Postman collection first, or unlink a test from its current ticket.', action: h`<a class="btn" href="/automation" data-link data-close>${ic('upload')} Import collection</a>` }));
            return;
          }
          box.innerHTML = String(h`<p class="small muted">${rows.length} test(s) with no ticket yet. Tick the ones that belong to ${story.key}.</p>
            ${QA.ui.table({ rows, selectable: true, rowAttrs: (t) => `data-id="${esc(t.id)}"`, columns: [
              { key: 'id', label: 'Id', render: (t) => h`<span class="mono small">${t.id}</span>` },
              { key: 'title', label: 'Test', render: (t) => h`<div class="cell-title">${t.title}${(t.tags || []).includes('imported') ? h` <span class="tag">imported</span>` : ''}</div><div class="cell-sub">${C.endpoint(t.method, t.endpoint)}</div>` },
              { key: 'testType', label: 'Type' },
            ] })}`);
        }).catch((err) => { box.innerHTML = String(errorBox(err)); });
        el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
          const ids = [...el.querySelectorAll('[data-select]:checked')].map((x) => x.dataset.select);
          if (!ids.length) { toast('Select at least one test case.', 'warn'); return; }
          try {
            const r = await api.post(`/api/stories/${encodeURIComponent(story.key)}/link-tests?projectId=${p.id}`, { ids });
            close();
            toast(`Attached ${r.linked || r.updated} test(s) to ${story.key}.`, 'ok');
            if (after) after();
          } catch (err) { toastError(err, 'Not attached'); }
        }));
      },
    });
  }

  async function generate(storyKey, btn, extra = {}) {
    const p = QA.state.project;
    return withBusy(btn, async () => {
      try {
        const body = { ...extra, storyKey };
        if (body.inputSource === 'jira') delete body.docIds;
        if (body.inputSource === 'docs' && !(body.docIds && body.docIds.length)) {
          toast('Select at least one integration document.', 'warn');
          return;
        }
        const pr = await api.post(`/api/generate?projectId=${p.id}`, body);
        QA.router.go(`/stories/${pr.storyKey || storyKey}?proposal=${pr.id}`);
      } catch (e) { toastError(e, 'Generation failed'); }
    });
  }

  function generatorBanner(a) {
    const tr = a.traceability || {};
    const gen = a.generator || tr.generator || 'engine';
    const label = gen === 'cursor-cli' ? 'Cursor CLI' : gen === 'gemini-cli' ? 'Gemini CLI' : 'Built-in engine';
    const fallback = (tr.fallbackNotes || []).join(' ') || (tr.fallback ? 'CLI was unavailable or returned invalid JSON; the built-in engine produced this suite.' : '');
    return h`<div class="callout ${tr.fallback || gen === 'engine' ? 'info' : 'ok'} mt">${ic('wand')}<div>
      <b>Generator used: ${label}</b> <span class="mono small">(${gen})</span>
      ${fallback ? h`<div class="small mt-s">${fallback}</div>` : h`<div class="small mt-s">Cursor CLI, then Gemini CLI, then the engine. Extra CLI scenarios were merged onto the engine baseline. Unknown sObjects were dropped.</div>`}
    </div></div>`;
  }

  function metricsCard(a) {
    const tr = a.traceability || {};
    const labels = tr.labels || {};
    const cli = tr.cli || {};
    return h`<div class="card"><div class="card-head"><h2>Traceability</h2></div><div class="card-body">
      ${C.kv([
        ['Generator', a.generator || tr.generator || 'engine'],
        ['AC mapped', tr.acMappedPct == null ? '–' : `${tr.acMappedPct}% (${tr.acMapped || 0} of ${tr.acLines || 0})`],
        ['CLI keep rate', cli.keepRate == null ? 'No CLI extras' : `${cli.keepRate}% (${cli.keptScenarios || 0} kept / ${cli.rawScenarios || 0} raw)`],
        ['Dropped objects', (cli.droppedObjects || []).length ? (cli.droppedObjects || []).join(', ') : 'None'],
        ['VERIFIED', fmt.num(labels.VERIFIED || 0)],
        ['ASSUMED', fmt.num(labels.ASSUMED || 0)],
        ['RECOMMENDED', fmt.num(labels.RECOMMENDED || 0)],
        ['Source', sourceLabel(a.inputSource || tr.inputSource)],
        ['Docs used', (tr.docsUsed || []).length ? (tr.docsUsed || []).join(', ') : 'None'],
        ['Doc rules mapped', tr.docRules ? `${tr.docRulesMapped || 0} of ${tr.docRules}` : '–'],
        ['OpenAPI ops in pack', fmt.num(tr.openapiOps || 0)],
      ])}
      ${(tr.acUnmapped || []).length ? h`<div class="callout warn mt">${ic('alert')}<div class="small wrap"><b>AC without a test.</b> Add or edit a test before approving:<ul>${tr.acUnmapped.map((t) => h`<li>${t}</li>`)}</ul></div></div>` : ''}
    </div></div>`;
  }

  function cliContractHint() {
    const c = (QA.state.meta && QA.state.meta.cliContract) || {};
    return h`<details class="mt"><summary class="small">CLI JSON contract</summary>
      <p class="small muted wrap">Reply JSON only. Endpoint must start with <code>/</code>. Auth: ${(c.auth || ['default', 'none', 'invalid', 'lowpriv']).join(', ')}. Assertions: ${(c.assertionTypes || ['status', 'jsonpath', 'header', 'responseTime', 'sfError', 'schema', 'bodyContains']).join(', ')}. Unknown sObjects are dropped. No secrets.</p>
      <pre class="code small">${c.shape || '{ "scenarios": [{ "title", "type", "apiType", "object", "label", "testCases": [{ "title", "method", "endpoint", "assertions", "body", "query" }] }] }'}</pre>
    </details>`;
  }

  // ── Story detail ──
  async function renderStory(view, key) {
    const p = QA.state.project;
    QA.router.setCrumbs([{ label: 'Jira stories', href: '/stories' }, { label: key }]);
    view.innerHTML = String(loading(10));
    let s;
    try { s = await api.get(`/api/stories/${encodeURIComponent(key)}?projectId=${p.id}`); } catch (e) { view.innerHTML = String(errorBox(e)); return null; }
    const cov = s.coverage || { tests: 0, passed: 0, failed: 0, blocked: 0, executed: 0 };
    let tab = 'tests';
    const ac = String(s.acceptanceCriteria || '').split('\n').map((x) => x.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
    view.innerHTML = String(h`${C.pageHead(h`<span class="mono" style="font-size:20px">${s.key}</span> ${s.summary}`, h`${s.issueType || 'Story'} · ${s.status} · ${s.priority || 'No priority'} · ${s.sprint || 'No sprint'}${s.assignee ? ` · ${s.assignee}` : ''} · synced ${fmt.ago(s.syncedAt)}`,
        h`${s.url ? h`<a class="btn" href="${s.url}" target="_blank" rel="noopener">${ic('external')} Open in Jira</a>` : ''}<button class="btn" data-act="impact">${ic('target')} Regression impact</button><button class="btn" data-act="attach">${ic('plus')} Attach tests</button><button class="btn" data-act="run" ${cov.tests ? '' : 'disabled'}>${ic('play')} Run story tests</button><button class="btn danger-outline" data-act="del-all" ${cov.tests ? '' : 'disabled'}>${ic('trash')} Delete all generated</button><button class="btn primary" data-act="gen">${ic('wand')} Generate API tests for ${s.key}</button>`)}
      <p class="small muted" style="margin:0 0 12px">Imported collection tests can be attached here and edited. Generate from Jira / docs only if this ticket has no tests yet — you still review and approve generated suites.</p>
      <div class="card" style="margin-bottom:12px"><div class="card-body">${sourcePicker('jira+docs')}</div></div>
      <div class="grid g-21">
        <div class="card"><div class="card-head"><h2>Requirement</h2></div><div class="card-body">
          <p style="margin-top:0;white-space:pre-wrap">${s.description || 'No description.'}</p>
          <h3 class="mt">Acceptance criteria</h3>${ac.length ? h`<ol class="small" style="padding-left:18px;margin:8px 0 0">${ac.map((x) => h`<li style="margin-bottom:4px">${x}</li>`)}</ol>` : h`<p class="small muted">No acceptance criteria. Generated coverage will be marked RECOMMENDED where requirements are unclear.</p>`}
        </div></div>
        <div class="card"><div class="card-head"><h2>Coverage</h2></div><div class="card-body">
          ${C.kv([['Scenarios', fmt.num(s.scenarios.length)], ['Test cases', fmt.num(cov.tests)], ['Executed', fmt.num(cov.executed)], ['Passed', h`<span class="text-ok">${cov.passed}</span>`], ['Failed', cov.failed ? h`<span class="text-error">${cov.failed}</span>` : '0'], ['Blocked', fmt.num(cov.blocked)], ['Defects', fmt.num(s.defects.length)]])}
          <div class="mt">${coverageBar(cov)}</div>
        </div></div>
      </div>
      <div class="card mt" data-docs>${loading(3)}</div>
      <div class="card mt" data-ep-link>${loading(3)}</div>
      <div class="mt" data-tabs></div><div class="card" data-pane></div>`);

    const drawTabs = () => { view.querySelector('[data-tabs]').innerHTML = String(C.tabs([{ id: 'tests', label: 'Test cases', n: s.tests.length }, { id: 'scenarios', label: 'Scenarios', n: s.scenarios.length }, { id: 'defects', label: 'Defects', n: s.defects.length }, { id: 'proposals', label: 'Generation history', n: s.proposals.length }], tab)); };
    const pane = view.querySelector('[data-pane]');
    const drawPane = () => {
      if (tab === 'tests') pane.innerHTML = String(h`${s.tests.length ? h`<div class="row wrap" style="gap:8px;margin-bottom:8px"><button class="btn xs danger-outline" data-act="del-sel">${ic('trash')} Delete selected</button><span class="small muted">Tick rows to delete one or more tests.</span></div>` : ''}
        ${QA.ui.table({ rows: s.tests, selectable: true, rowAttrs: (r) => `data-tc="${esc(r.id)}"`, emptyState: empty({ icon: 'wand', title: 'No test cases for this story', text: 'Attach tests imported from a Postman collection, or generate a suite to review and approve.', action: h`<button class="btn primary" data-act="attach">${ic('plus')} Attach tests</button>` }), columns: [
        { key: 'id', label: 'Id', render: (r) => h`<span class="mono small">${r.id}</span>` },
        { key: 'title', label: 'Test case', render: (r) => h`<div class="cell-title">${r.title}${(r.tags || []).includes('imported') ? h` <span class="tag">imported</span>` : ''}</div><div class="cell-sub">${C.endpoint(r.method, r.endpoint)}</div>` },
        { key: 'testType', label: 'Type' }, { key: 'priority', label: 'Pri', render: (r) => pri(r.priority) },
        { key: 'label', label: 'Provenance', render: (r) => prov(r.label) },
        { key: 'lastResult', label: 'Last result', render: (r) => (r.lastResult ? badge(r.lastResult) : h`<span class="faint small">Not run</span>`) },
        { key: 'actions', label: '', cls: 'actions', render: (r) => h`<button class="btn xs danger-outline" data-del-tc="${r.id}" aria-label="Delete ${r.id}">${ic('trash')}</button>` },
      ] })}`);
      else if (tab === 'scenarios') pane.innerHTML = String(QA.ui.table({ rows: s.scenarios, emptyState: empty({ title: 'No scenarios' }), columns: [
        { key: 'id', label: 'Id', render: (r) => h`<span class="mono small">${r.id}</span>` }, { key: 'title', label: 'Scenario', render: (r) => h`<div class="cell-title">${r.title}</div><div class="cell-sub">${r.description || ''}</div>` },
        { key: 'type', label: 'Type' }, { key: 'apiType', label: 'API' }, { key: 'priority', label: 'Pri', render: (r) => pri(r.priority) }, { key: 'label', label: 'Provenance', render: (r) => prov(r.label) },
      ] }));
      else if (tab === 'defects') pane.innerHTML = String(QA.ui.table({ rows: s.defects, emptyState: empty({ icon: 'bug', title: 'No defects linked', text: 'Defects created from failed tests are linked to this story.' }), columns: [
        { key: 'key', label: 'Key', render: (r) => (r.url ? h`<a href="${r.url}" target="_blank" rel="noopener">${r.key}</a>` : r.key) }, { key: 'summary', label: 'Summary' }, { key: 'severity', label: 'Severity', render: (r) => badge(r.severity) }, { key: 'status', label: 'Status', render: (r) => badge(r.status) },
      ] }));
      else pane.innerHTML = String(QA.ui.table({ rows: s.proposals, rowAttrs: (r) => `data-prop="${esc(r.id)}"`, emptyState: empty({ title: 'No generation history' }), columns: [
        { key: 'id', label: 'Proposal', render: (r) => h`<span class="mono small">${r.id}</span>` }, { key: 'status', label: 'Status', render: (r) => badge(r.status) }, { key: 'createdAt', label: 'Generated', render: (r) => fmt.date(r.createdAt) }, { key: 'decidedAt', label: 'Decided', render: (r) => fmt.date(r.decidedAt) },
      ] }));
    };
    drawTabs(); drawPane();
    on(view, 'click', '[data-tab]', (e, el) => { tab = el.dataset.tab; drawTabs(); drawPane(); });
    on(pane, 'click', 'tr[data-tc]', (e, el) => {
      if (e.target.closest('button, input, a')) return;
      QA.router.go(`/testcases?id=${el.dataset.tc}`);
    });
    on(pane, 'click', 'tr[data-prop]', (e, el) => QA.router.go(`/stories/${s.key}?proposal=${el.dataset.prop}`));
    on(view, 'click', '[data-act=gen]', (e, el) => {
      const inputSource = pickedSource(view);
      const ids = [...view.querySelectorAll('[name=docId]:checked')].map((x) => x.value);
      generate(s.key, el, { inputSource, docIds: ids });
    });
    on(view, 'click', '[data-act=del-all]', async (e, el) => {
      const ok = await QA.ui.confirm({ title: `Delete all generated tests for ${s.key}?`, message: `${s.tests.length} test case(s) and their scenarios will be removed. Run history is kept.`, confirmLabel: 'Delete all', danger: true });
      if (!ok) return;
      try {
        const r = await api.del(`/api/stories/${encodeURIComponent(s.key)}/tests?projectId=${p.id}`);
        toast(`Deleted ${r.tests} test case(s).`, 'warn');
        QA.router.render();
      } catch (err) { toastError(err); }
    });
    on(pane, 'click', '[data-del-tc]', async (e, el) => {
      e.stopPropagation();
      const id = el.dataset.delTc;
      const ok = await QA.ui.confirm({ title: `Delete ${id}?`, message: 'Execution history is kept.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try { await api.del(`/api/testcases/${id}`); toast(`${id} deleted.`, 'warn'); QA.router.render(); } catch (err) { toastError(err); }
    });
    on(pane, 'change', '[data-select-all]', (e, el) => {
      pane.querySelectorAll('[data-select]').forEach((cb) => { cb.checked = el.checked; });
    });
    on(pane, 'click', '[data-act=del-sel]', async () => {
      const ids = [...pane.querySelectorAll('[data-select]:checked')].map((x) => x.dataset.select);
      if (!ids.length) { toast('Select at least one test case.', 'warn'); return; }
      const ok = await QA.ui.confirm({ title: `Delete ${ids.length} test case(s)?`, message: 'Execution history is kept.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try { await api.post(`/api/testcases/bulk?projectId=${p.id}`, { ids, delete: true }); toast(`${ids.length} test case(s) deleted.`, 'warn'); QA.router.render(); } catch (err) { toastError(err); }
    });
    on(view, 'click', '[data-act=attach]', () => attachTestsDialog(s, () => QA.router.render()));
    on(view, 'click', '[data-act=run]', () => C.runDialog({ preset: { storyKey: [s.key], label: `${s.key} story tests` }, title: `Run tests for ${s.key}` }));
    on(view, 'click', '[data-act=impact]', () => QA.router.go(`/regression?story=${s.key}`));
    (async () => {
      const docsBox = view.querySelector('[data-docs]');
      if (docsBox) {
        try {
          const r = await api.get(`/api/projects/${p.id}/context-docs`);
          const items = r.items || [];
          docsBox.innerHTML = String(h`<div class="card-head"><h2>Integration docs</h2><span class="sub">Paste or pick local files — remote URLs stay blocked</span></div>
            <div class="card-body">
              <p class="small wrap">When you generate from <b>Integration doc</b> or <b>Jira ticket + Integration doc</b>, checked documents are the spec. Jira ticket alone ignores them.</p>
              ${items.length ? h`<div class="stack" style="gap:6px">${items.map((d) => h`<label class="check-row"><input type="checkbox" name="docId" value="${d.id}" checked> <span><b>${d.name}</b><div class="cell-sub">${(d.body || '').slice(0, 140)}${(d.body || '').length > 140 ? '…' : ''}</div></span></label>`)}</div>` : h`<p class="small muted">No docs on this project yet. Paste one below or add it on Connections.</p>`}
              <div class="form-grid mt">
                <label class="field full"><span>Name</span><input class="input" name="docName" placeholder="e.g. Invoice sync mapping"></label>
                <label class="field full"><span>Paste text</span><textarea class="input" rows="3" name="docBody" placeholder="Endpoints, mappings, field notes — no passwords."></textarea></label>
                <label class="field full"><span>Or local file path</span><input class="input mono" name="docPath" placeholder="/Users/you/docs/integration.md"></label>
              </div>
              <div class="form-actions mt">
                <button class="btn" data-act="add-story-doc">${ic('plus')} Add document</button>
                <button class="btn primary" data-act="plan-docs">${ic('wand')} Generate from integration doc</button>
              </div>
              ${cliContractHint()}
            </div>`);
          on(docsBox, 'click', '[data-act=add-story-doc]', (e, el) => withBusy(el, async () => {
            const name = docsBox.querySelector('[name=docName]').value.trim();
            const body = docsBox.querySelector('[name=docBody]').value;
            const filePath = docsBox.querySelector('[name=docPath]').value.trim();
            try {
              await api.post(`/api/projects/${p.id}/context-docs`, { name, body, filePath });
              toast('Context document added.', 'ok');
              QA.router.render();
            } catch (err) { toastError(err, 'Document not added'); }
          }));
          on(docsBox, 'click', '[data-act=plan-docs]', (e, el) => {
            const docIds = [...docsBox.querySelectorAll('[name=docId]:checked')].map((x) => x.value);
            generate(s.key, el, { inputSource: 'docs', docIds });
          });
        } catch (e) { docsBox.innerHTML = String(h`<div class="card-body">${errorBox(e, { compact: true })}</div>`); }
      }
      const box = view.querySelector('[data-ep-link]');
      if (!box) return;
      try {
        const r = await api.get(`/api/projects/${p.id}/endpoints`);
        const items = r.items || [];
        const selected = new Set((s.endpointIds || []).map(String));
        box.innerHTML = String(h`<div class="card-head"><h2>Linked endpoints</h2><button class="btn sm" data-act="save-eps">${ic('check')} Save links</button></div>
          <div class="card-body">
            <p class="small wrap">When links are set, Generate uses these custom Apex REST / HTTP endpoints instead of keyword matching. Experience Cloud and Commerce Cloud are not listed here.</p>
            ${items.length ? h`<div class="stack" style="gap:6px">${items.map((e) => h`<label class="check-row"><input type="checkbox" name="epid" value="${e.id}" ${selected.has(e.id) ? 'checked' : ''}> <span><b>${e.name}</b> <span class="mono small muted">${e.method} ${e.path}</span></span></label>`)}</div>` : empty({ title: 'No custom endpoints', text: 'Add them on Project → Other systems, then link them here.', action: h`<a class="btn sm" href="/projects/${p.id}?tab=integration" data-link>Open Other systems</a>` })}
          </div>`);
        on(box, 'click', '[data-act=save-eps]', (e, el) => withBusy(el, async () => {
          const endpointIds = [...box.querySelectorAll('[name=epid]:checked')].map((x) => x.value);
          try {
            const updated = await api.patch(`/api/stories/${encodeURIComponent(s.key)}?projectId=${p.id}`, { endpointIds });
            s.endpointIds = updated.endpointIds;
            toast(endpointIds.length ? `Linked ${endpointIds.length} endpoint(s) to ${s.key}.` : `Cleared endpoint links on ${s.key}.`, 'ok');
          } catch (err) { toastError(err, 'Links not saved'); }
        }));
      } catch (e) { box.innerHTML = String(h`<div class="card-body">${errorBox(e, { compact: true })}</div>`); }
    })();
    return null;
  }

  // ── Proposal review ──
  async function renderProposal(view, proposalId, storyKey) {
    const p = QA.state.project;
    QA.router.setCrumbs([{ label: 'Jira stories', href: '/stories' }, ...(storyKey ? [{ label: storyKey, href: `/stories/${storyKey}` }] : []), { label: `Review ${proposalId}` }]);
    view.innerHTML = String(loading(10));
    let pr;
    try { pr = await api.get(`/api/proposals/${encodeURIComponent(proposalId)}`); } catch (e) { view.innerHTML = String(errorBox(e)); return null; }
    const a = pr.analysis || {};
    const editable = pr.status === 'proposed';
    const sel = pr.scenarios.map((s) => new Set(s.testCases.map((t, i) => (t.status === 'draft' ? null : i)).filter((i) => i !== null)));
    const total = () => sel.reduce((n, x) => n + x.size, 0);
    const allTests = pr.scenarios.reduce((n, s) => n + s.testCases.length, 0);
    const byType = pr.scenarios.reduce((m, s) => { m[s.type] = (m[s.type] || 0) + s.testCases.length; return m; }, {});

    view.innerHTML = String(h`${C.pageHead(h`Review generated tests for <span class="mono">${pr.storyKey}</span>`, h`${a.summary || ''} · Proposal ${pr.id} · ${badge(pr.status)} · generated by ${pr.createdBy} ${fmt.ago(pr.createdAt)}${a.generationMs ? ` in ${fmt.ms(a.generationMs)}` : ''}`)}
      <div class="step-flow" aria-label="Workflow"><span class="st done">${ic('check')} Analyse story</span><span class="ln"></span><span class="st done">${ic('check')} Generate scenarios</span><span class="ln"></span><span class="st ${editable ? 'now' : 'done'}">${editable ? '' : ic('check')} Review and approve</span><span class="ln"></span><span class="st ${editable ? '' : 'done'}">Save test cases</span><span class="ln"></span><span class="st">Optional run / Jira</span></div>
      ${generatorBanner(a)}
      ${a.metadataLabel === 'ASSUMED' ? h`<div class="callout warn mt">${ic('alert')}<div><b>Metadata is ASSUMED.</b> <span class="small">Objects and fields come from ${a.metadataSource || 'heuristics'}, not a live describe of the org. Confirm against the real org before treating results as VERIFIED.</span></div></div>` : a.metadataLabel === 'VERIFIED' ? h`<div class="callout ok mt">${ic('check')}<div class="small"><b>Metadata VERIFIED</b> against ${a.metadataSource}.</div></div>` : ''}
      ${a.classification && !a.classification.needsApiTesting ? h`<div class="callout warn mt">${ic('alert')}<div><b>This ticket may not need API testing (ASSUMED, ${a.classification.confidence} confidence).</b> <span class="small">${a.classification.reasons.join(' ')} Review the proposed scenarios carefully before approving — there may be nothing worth keeping.</span></div></div>` : ''}
      <div class="grid g-12 mt">
        <div class="stack">
          ${metricsCard(a)}
          ${cliContractHint()}
          <div class="card"><div class="card-head"><h2>Story analysis</h2>${prov(a.metadataLabel)}</div><div class="card-body">
            ${C.kv([['Objects', (a.objects || []).length ? h`${a.objects.map((o) => h`<span class="tag mono">${o}</span>`)}` : 'None detected'], ['Operations', (a.operations || []).join(', ') || '–'], ['API types', (a.apiTypes || []).join(', ') || '–'], ['Integration', a.integration ? 'Yes' : 'No'], ['Matched endpoints', (a.matchedEndpoints || []).length ? h`${a.matchedEndpoints.map((e) => h`<span class="tag mono">${e.method} ${e.name}</span>`)}` : 'None'], ['Fields', Object.entries(a.fields || {}).map(([o, f]) => `${o}: ${f.join(', ')}`).join(' · ') || '–']])}
          </div></div>
          ${(a.acceptanceCriteria || []).length ? h`<div class="card"><div class="card-head"><h2>Acceptance criteria</h2></div><div class="card-body"><ol class="small" style="padding-left:18px;margin:0">${a.acceptanceCriteria.map((x) => h`<li style="margin-bottom:4px">${x}</li>`)}</ol></div></div>` : ''}
          ${(a.gaps || []).length || (a.notes || []).length ? h`<div class="card"><div class="card-head"><h2>Gaps and recommendations</h2></div><div class="card-body stack" style="gap:10px">${[...(a.gaps || []), ...(a.notes || []).map((n) => (typeof n === 'string' ? { label: 'ASSUMED', text: n } : n))].map((g) => h`<div class="row" style="align-items:flex-start;gap:8px">${prov(g.label || 'RECOMMENDED')}<span class="small">${g.text}</span></div>`)}</div></div>` : ''}
          <div class="card"><div class="card-head"><h2>Coverage by type</h2></div><div class="card-body">${raw(QA.charts.hbars({ items: Object.entries(byType).map(([k, v]) => ({ label: k, value: v })) }))}</div></div>
        </div>
        <div class="card"><div class="card-head"><h2>Proposed scenarios <span class="sub">${pr.scenarios.length} scenarios · ${allTests} test cases</span></h2>${editable ? h`<div class="row"><button class="btn xs" data-all="1">Select all</button><button class="btn xs" data-all="0">Select none</button></div>` : ''}</div>
          <div class="tree" data-tree>${pr.scenarios.map((s, si) => h`<details ${si < 3 ? 'open' : ''}><summary><span class="row" style="gap:8px;flex:1;min-width:0">${editable ? h`<input type="checkbox" data-sc="${si}" aria-label="Select scenario" ${sel[si].size === s.testCases.length ? 'checked' : ''}>` : ''}<b class="truncate">${s.title}</b><span class="spacer"></span><span class="tag">${s.type}</span>${pri(s.priority)}${prov(s.label)}<span class="small muted num">${s.testCases.length}</span></span></summary>
            ${s.description ? h`<p class="small muted" style="margin:4px 0 8px 26px">${s.description}</p>` : ''}
            ${s.testCases.map((t, ti) => h`<div class="leaf" style="display:flex;gap:10px;align-items:flex-start">
              ${editable ? h`<input type="checkbox" data-t="${si}:${ti}" ${sel[si].has(ti) ? 'checked' : ''} aria-label="Select test" style="margin-top:3px">` : ''}
              <div style="flex:1;min-width:0"><div class="row wrap" style="gap:6px"><span>${t.title}</span>${t.status === 'draft' ? badge('draft') : ''}</div>
                <div class="row wrap small" style="gap:6px;margin-top:3px">${method(t.method)}<code class="mono small truncate" style="max-width:420px">${fmt.shortPath(t.endpoint)}</code>${pri(t.priority)}${prov(t.label)}${t.auth && t.auth !== 'default' ? h`<span class="tag">auth: ${t.auth}</span>` : ''}${t.sfValidation ? h`<span class="tag">${ic('database')} SF validation</span>` : ''}<button class="btn xs ghost" data-detail="${si}:${ti}">Details</button>${editable ? h`<button class="btn xs danger-outline" data-rm="${si}:${ti}" aria-label="Remove test">${ic('trash')}</button>` : ''}</div></div></div>`)}
          </details>`)}</div>
        </div>
      </div>
      ${editable ? h`<div class="card mt" style="position:sticky;bottom:12px;box-shadow:var(--shadow-pop)"><div class="card-body row wrap" style="gap:14px">
        <span><b data-count>${total()}</b> of ${allTests} test cases selected</span>
        <label class="check-row"><input type="checkbox" name="runNow"> Run after approve</label>
        <label class="check-row"><input type="checkbox" name="postToJira"> Post a coverage comment and label to ${pr.storyKey} in Jira</label>
        <label class="check-row"><input type="checkbox" name="postResultToJira"> After the run, post a pass/fail comment (not a defect)</label>
        <span class="spacer"></span><button class="btn danger-outline" data-act="clear-proposed">Remove all from proposal</button><button class="btn danger-outline" data-act="reject">Reject proposal</button><button class="btn primary" data-act="approve">${ic('check')} Approve selected</button></div></div>` : h`<div class="callout info mt">${ic('info')}<div class="small">This proposal was ${pr.status}${pr.decision && pr.decision.by ? ` by ${pr.decision.by}` : ''} ${fmt.ago(pr.decidedAt)}. Generate again from the story to create a new proposal.</div></div>`}`);

    const sync = () => {
      view.querySelectorAll('[data-t]').forEach((cb) => { const [si, ti] = cb.dataset.t.split(':').map(Number); cb.checked = sel[si].has(ti); });
      view.querySelectorAll('[data-sc]').forEach((cb) => { const si = Number(cb.dataset.sc); cb.checked = sel[si].size === pr.scenarios[si].testCases.length; cb.indeterminate = sel[si].size > 0 && !cb.checked; });
      const c = view.querySelector('[data-count]'); if (c) c.textContent = total();
    };
    sync();
    on(view, 'click', 'summary input', (e) => e.stopPropagation());
    on(view, 'change', '[data-t]', (e, el) => { const [si, ti] = el.dataset.t.split(':').map(Number); el.checked ? sel[si].add(ti) : sel[si].delete(ti); sync(); });
    on(view, 'change', '[data-sc]', (e, el) => { const si = Number(el.dataset.sc); sel[si] = el.checked ? new Set(pr.scenarios[si].testCases.map((_, i) => i)) : new Set(); sync(); });
    on(view, 'click', '[data-all]', (e, el) => { pr.scenarios.forEach((s, si) => { sel[si] = el.dataset.all === '1' ? new Set(s.testCases.map((_, i) => i)) : new Set(); }); sync(); });
    on(view, 'click', '[data-detail]', (e, el) => { const [si, ti] = el.dataset.detail.split(':').map(Number); testDetail(pr.scenarios[si].testCases[ti]); });
    on(view, 'click', '[data-rm]', async (e, el) => {
      const [si, ti] = el.dataset.rm.split(':').map(Number);
      const ok = await QA.ui.confirm({ title: 'Remove this test from the proposal?', message: 'It will not be saved when you approve. Other tests stay.', confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      try { await api.patch(`/api/proposals/${pr.id}`, { removeTests: [{ si, ti }] }); QA.router.render(); } catch (err) { toastError(err); }
    });
    on(view, 'click', '[data-act=clear-proposed]', async () => {
      const ok = await QA.ui.confirm({ title: 'Remove every test from this proposal?', message: 'The proposal stays open but empty. Reject it if you want to discard it.', confirmLabel: 'Remove all', danger: true });
      if (!ok) return;
      try { await api.patch(`/api/proposals/${pr.id}`, { clearAll: true }); QA.router.render(); } catch (err) { toastError(err); }
    });
    on(view, 'click', '[data-act=reject]', async (e, el) => {
      const ok = await QA.ui.confirm({ title: 'Reject this proposal?', message: 'No test cases are saved and nothing is sent to Jira.', confirmLabel: 'Reject', danger: true });
      if (!ok) return;
      try { await api.post(`/api/proposals/${pr.id}/reject`, {}); toast('Proposal rejected.', 'warn'); QA.router.go(`/stories/${pr.storyKey}`); } catch (err) { toastError(err); }
    });
    on(view, 'click', '[data-act=approve]', (e, el) => withBusy(el, async () => {
      if (!total()) { toast('Select at least one test case to approve.', 'warn'); return; }
      const postToJira = view.querySelector('[name=postToJira]').checked;
      const runNow = view.querySelector('[name=runNow]') && view.querySelector('[name=runNow]').checked;
      const postResultToJira = view.querySelector('[name=postResultToJira]') && view.querySelector('[name=postResultToJira]').checked;
      if (postToJira) {
        const ok = await QA.ui.confirm({ title: `Update ${pr.storyKey} in Jira?`, message: h`A comment summarising ${total()} approved test cases and the label <code>api-tests-generated</code> will be added to ${pr.storyKey}.`, confirmLabel: 'Approve and update Jira' });
        if (!ok) return;
      }
      const selected = Object.fromEntries(sel.map((s, i) => [i, [...s].sort((x, y) => x - y)]));
      try {
        const r = await api.post(`/api/proposals/${pr.id}/approve`, { selected, postToJira, runNow, postResultToJira });
        const pm = r.postman || {};
        const pmBit = pm.mcp ? ` Synced to Postman collection${pm.name ? ` “${pm.name}”` : ''}.`
          : (pm.notice ? ` ${pm.notice}` : ' Saved locally — connect Postman MCP to push the collection.');
        const runBit = r.run && r.run.started ? ` Run ${r.run.id} started.` : (r.run && r.run.title ? ` Run not started: ${r.run.title}` : '');
        toast(h`${r.tests} test cases in ${r.scenarios} scenarios saved.${pmBit}${runBit}${r.jira ? (r.jira.ok ? ` Jira ${pr.storyKey} updated.` : ` Jira was not updated: ${r.jira.title}`) : ''}`, (r.jira && !r.jira.ok) || (pm.ok === false) || (r.run && r.run.started === false) ? 'warn' : 'ok', 'Proposal approved');
        if (r.run && r.run.started && r.run.id) QA.router.go(`/execution/${r.run.id}`);
        else if (r.run && !r.run.started && /^PRODUCTION_/.test(r.run.code || '') && r.ids && r.ids.length) {
          const run = await C.startRun({ testCaseIds: r.ids, postResultToJira, label: `Approved ${pr.id} · ${pr.storyKey}` }, el);
          if (!run) QA.router.go(`/stories/${pr.storyKey}`);
        } else QA.router.go(`/stories/${pr.storyKey}`);
      } catch (err) { toastError(err, 'Approval failed'); }
    }));
    return null;
  }

  function testDetail(t) {
    const f = t.priorityReason && t.priorityReason.factors;
    modal({
      title: t.title, subtitle: `${t.testType} · ${t.priority} · ${t.label}`, size: 'xl',
      body: h`<div class="grid g-2"><div><h3>Request</h3><div class="row" style="gap:8px;margin:8px 0">${method(t.method)}<code class="mono small" style="word-break:break-all">${t.endpoint}</code></div>
        ${t.auth && t.auth !== 'default' ? h`<p class="small"><span class="tag">auth: ${t.auth}</span></p>` : ''}
        ${t.body !== undefined && t.body !== null ? json(t.body) : t.bodyRaw ? h`<pre class="code">${t.bodyRaw}</pre>` : h`<p class="small muted">No body.</p>`}
        ${t.extra ? h`<div class="small mt wrap">${t.extra.folder ? h`<div>Folder <code class="mono">${t.extra.folder}</code></div>` : ''}${t.extra.bodyMode ? h`<div>Body mode <code class="mono">${t.extra.bodyMode}</code></div>` : ''}${t.extra.originalUrl ? h`<div class="mono wrap">${t.extra.originalUrl}</div>` : ''}${t.extra.formData ? json(t.extra.formData) : ''}${t.extra.graphql ? json(t.extra.graphql) : ''}${t.extra.preRequest ? h`<h3 class="mt">Pre-request</h3><pre class="code">${t.extra.preRequest}</pre>` : ''}${t.extra.examples && t.extra.examples.length ? h`<h3 class="mt">Examples</h3>${json(t.extra.examples)}` : ''}</div>` : ''}
        ${(t.extract || []).length ? h`<h3 class="mt">Extract variables</h3><ul class="list small">${t.extract.map((x) => h`<li><code class="mono">{{${x.var}}}</code> ← <code class="mono">${x.path}</code></li>`)}</ul>` : ''}
        ${t.sfValidation ? h`<h3 class="mt">Salesforce validation</h3>${json(t.sfValidation)}` : ''}</div>
        <div><h3>Assertions</h3><ul class="list small" style="margin-top:8px">${(t.assertions || []).map((x) => h`<li><code class="mono">${x.type}${x.path ? ` ${x.path}` : ''}${x.name ? ` ${x.name}` : ''} ${x.op || ''} ${x.expected === undefined ? '' : JSON.stringify(x.expected)}</code>${x.label ? h`<div class="muted">${x.label}</div>` : ''}</li>`)}</ul>
        ${f ? h`<h3 class="mt">Priority factors <span class="small muted">(score ${t.priorityReason.score})</span></h3>${raw(QA.charts.hbars({ items: Object.entries(f).map(([k, v]) => ({ label: k.replace(/([A-Z])/g, ' $1').toLowerCase(), value: v, max: 3, display: `${v} × ${t.priorityReason.weights[k]}` })) }))}` : ''}
        ${t.description ? h`<h3 class="mt">Notes</h3><p class="small">${t.description}</p>` : ''}</div></div>`,
      foot: h`<button class="btn" data-close>Close</button>`,
    });
  }

  QA.pages.stories.generate = generate;
})();
