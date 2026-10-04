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

  const coverageBar = (c) => {
    if (!c || !c.tests) return h`<span class="faint small">No tests</span>`;
    return h`<div class="progress" style="width:120px" title="${c.passed} passed, ${c.failed} failed, ${c.blocked} blocked of ${c.tests}"><span style="width:${(c.passed / c.tests) * 100}%;background:var(--success)"></span><span style="width:${(c.failed / c.tests) * 100}%;background:var(--error)"></span><span style="width:${(c.blocked / c.tests) * 100}%;background:var(--warning)"></span></div><div class="cell-sub num">${c.tests} tests · ${c.executed} executed</div>`;
  };

  // ── List ──
  function renderList(view, ctx) {
    const p = QA.state.project;
    QA.router.setCrumbs([{ label: 'Jira stories' }]);
    const jira = p.connection && p.connection.jira;
    view.innerHTML = String(h`${C.pageHead('Stories & Test Generation', h`${jira ? `Syncing from ${p.jiraProjectKey}.` : 'Jira not configured.'} Select a story to generate API tests.`,
      h`<button class="btn" data-act="add">${ic('plus')} Add story</button><button class="btn primary" data-act="sync">${ic('zap')} Sync stories</button>`)}
      <div data-list></div>`);
    let sprints = [];
    const list = C.listController(view.querySelector('[data-list]'), {
      sort: 'key', dir: 'ASC', searchPlaceholder: 'Search key, summary or description', filters: { sprint: ctx.query.sprint || '' },
      toolbar: (s) => h`<select class="select" data-filter="sprint" aria-label="Sprint"><option value="">All sprints</option>${sprints.map((x) => h`<option ${s.filters.sprint === x ? 'selected' : ''}>${x}</option>`)}</select>`,
      fetch: async (q) => { const r = await api.get(`/api/stories${api.qs({ projectId: p.id, ...q })}`); if (r.sprints && r.sprints.join() !== sprints.join()) { sprints = r.sprints; setTimeout(() => list.renderToolbar(), 0); } return r; },
      rowAttrs: (r) => `data-id="${esc(r.id)}"`,
      onRow: (r) => QA.router.go(`/stories/${r.key}`),
      emptyState: () => empty({ icon: 'jira', title: 'No stories yet', text: 'Sync stories from Jira with a JQL query, or add one manually.', action: h`<button class="btn primary" data-act="sync">${ic('refresh')} Sync from Jira</button>` }),
      columns: [
        { key: 'key', label: 'Key', sortable: true, render: (r) => h`<b class="mono small">${r.key}</b>` },
        { key: 'summary', label: 'Summary', sortable: true, render: (r) => h`<div class="cell-title">${r.summary}</div><div class="cell-sub">${(r.components || []).join(', ')}${r.assignee ? ` · ${r.assignee}` : ''}</div>` },
        { key: 'status', label: 'Status', sortable: true, render: (r) => h`<span class="tag">${r.status}</span>` },
        { key: 'priority', label: 'Priority', sortable: true },
        { key: 'sprint', label: 'Sprint', sortable: true },
        { key: 'coverage', label: 'API test coverage', render: (r) => coverageBar(r.coverage) },
        { key: 'defects', label: 'Defects', cls: 'num', render: (r) => (r.defects ? h`<span class="text-error">${r.defects}</span>` : '0') },
        { key: 'actions', label: '', cls: 'actions', render: (r) => h`<button class="btn xs" data-gen="${r.key}">${ic('wand')} Generate</button>` },
      ],
    });
    on(view, 'click', '[data-gen]', (e, el) => generate(el.dataset.gen, el));
    on(view, 'click', '[data-act=sync]', () => syncDialog(list));
    on(view, 'click', '[data-act=add]', () => addDialog(list));
    return null;
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

  async function generate(storyKey, btn) {
    const p = QA.state.project;
    return withBusy(btn, async () => {
      try {
        const pr = await api.post(`/api/generate?projectId=${p.id}`, { storyKey });
        QA.router.go(`/stories/${storyKey}?proposal=${pr.id}`);
      } catch (e) { toastError(e, 'Generation failed'); }
    });
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
        h`${s.url ? h`<a class="btn" href="${s.url}" target="_blank" rel="noopener">${ic('external')} Open in Jira</a>` : ''}<button class="btn" data-act="impact">${ic('target')} Regression impact</button><button class="btn" data-act="run" ${cov.tests ? '' : 'disabled'}>${ic('play')} Run story tests</button><button class="btn primary" data-act="gen">${ic('wand')} Generate API tests</button>`)}
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
      <div class="mt" data-tabs></div><div class="card" data-pane></div>`);

    const drawTabs = () => { view.querySelector('[data-tabs]').innerHTML = String(C.tabs([{ id: 'tests', label: 'Test cases', n: s.tests.length }, { id: 'scenarios', label: 'Scenarios', n: s.scenarios.length }, { id: 'defects', label: 'Defects', n: s.defects.length }, { id: 'proposals', label: 'Generation history', n: s.proposals.length }], tab)); };
    const pane = view.querySelector('[data-pane]');
    const drawPane = () => {
      if (tab === 'tests') pane.innerHTML = String(QA.ui.table({ rows: s.tests, rowAttrs: (r) => `data-tc="${esc(r.id)}"`, emptyState: empty({ icon: 'wand', title: 'No test cases for this story', text: 'Generate API tests to propose scenarios for review.' }), columns: [
        { key: 'id', label: 'Id', render: (r) => h`<span class="mono small">${r.id}</span>` },
        { key: 'title', label: 'Test case', render: (r) => h`<div class="cell-title">${r.title}</div><div class="cell-sub">${C.endpoint(r.method, r.endpoint)}</div>` },
        { key: 'testType', label: 'Type' }, { key: 'priority', label: 'Pri', render: (r) => pri(r.priority) },
        { key: 'label', label: 'Provenance', render: (r) => prov(r.label) },
        { key: 'lastResult', label: 'Last result', render: (r) => (r.lastResult ? badge(r.lastResult) : h`<span class="faint small">Not run</span>`) },
      ] }));
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
    on(pane, 'click', 'tr[data-tc]', (e, el) => QA.router.go(`/testcases?id=${el.dataset.tc}`));
    on(pane, 'click', 'tr[data-prop]', (e, el) => QA.router.go(`/stories/${s.key}?proposal=${el.dataset.prop}`));
    on(view, 'click', '[data-act=gen]', (e, el) => generate(s.key, el));
    on(view, 'click', '[data-act=run]', () => C.runDialog({ preset: { storyKey: [s.key], label: `${s.key} story tests` }, title: `Run tests for ${s.key}` }));
    on(view, 'click', '[data-act=impact]', () => QA.router.go(`/regression?story=${s.key}`));
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
      <div class="step-flow" aria-label="Workflow"><span class="st done">${ic('check')} Analyse story</span><span class="ln"></span><span class="st done">${ic('check')} Generate scenarios</span><span class="ln"></span><span class="st ${editable ? 'now' : 'done'}">${editable ? '' : ic('check')} Review and approve</span><span class="ln"></span><span class="st ${editable ? '' : 'done'}">Save test cases</span><span class="ln"></span><span class="st">Optional Jira comment</span></div>
      ${a.metadataLabel === 'ASSUMED' ? h`<div class="callout warn mt">${ic('alert')}<div><b>Metadata is ASSUMED.</b> <span class="small">Objects and fields come from ${a.metadataSource || 'heuristics'}, not a live describe of the org. Confirm against the real org before treating results as VERIFIED.</span></div></div>` : a.metadataLabel === 'VERIFIED' ? h`<div class="callout ok mt">${ic('check')}<div class="small"><b>Metadata VERIFIED</b> against ${a.metadataSource}.</div></div>` : ''}
      <div class="grid g-12 mt">
        <div class="stack">
          <div class="card"><div class="card-head"><h2>Story analysis</h2>${prov(a.metadataLabel)}</div><div class="card-body">
            ${C.kv([['Objects', (a.objects || []).length ? h`${a.objects.map((o) => h`<span class="tag mono">${o}</span>`)}` : 'None detected'], ['Operations', (a.operations || []).join(', ') || '–'], ['API types', (a.apiTypes || []).join(', ') || '–'], ['Integration', a.integration ? 'Yes' : 'No'], ['Fields', Object.entries(a.fields || {}).map(([o, f]) => `${o}: ${f.join(', ')}`).join(' · ') || '–']])}
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
                <div class="row wrap small" style="gap:6px;margin-top:3px">${method(t.method)}<code class="mono small truncate" style="max-width:420px">${fmt.shortPath(t.endpoint)}</code>${pri(t.priority)}${prov(t.label)}${t.auth && t.auth !== 'default' ? h`<span class="tag">auth: ${t.auth}</span>` : ''}${t.sfValidation ? h`<span class="tag">${ic('database')} SF validation</span>` : ''}<button class="btn xs ghost" data-detail="${si}:${ti}">Details</button></div></div></div>`)}
          </details>`)}</div>
        </div>
      </div>
      ${editable ? h`<div class="card mt" style="position:sticky;bottom:12px;box-shadow:var(--shadow-pop)"><div class="card-body row wrap" style="gap:14px">
        <span><b data-count>${total()}</b> of ${allTests} test cases selected</span>
        <label class="check-row"><input type="checkbox" name="postToJira"> Post a coverage comment and label to ${pr.storyKey} in Jira</label>
        <span class="spacer"></span><button class="btn danger-outline" data-act="reject">Reject proposal</button><button class="btn primary" data-act="approve">${ic('check')} Approve selected</button></div></div>` : h`<div class="callout info mt">${ic('info')}<div class="small">This proposal was ${pr.status}${pr.decision && pr.decision.by ? ` by ${pr.decision.by}` : ''} ${fmt.ago(pr.decidedAt)}. Generate again from the story to create a new proposal.</div></div>`}`);

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
    on(view, 'click', '[data-act=reject]', async (e, el) => {
      const ok = await QA.ui.confirm({ title: 'Reject this proposal?', message: 'No test cases are saved and nothing is sent to Jira.', confirmLabel: 'Reject', danger: true });
      if (!ok) return;
      try { await api.post(`/api/proposals/${pr.id}/reject`, {}); toast('Proposal rejected.', 'warn'); QA.router.go(`/stories/${pr.storyKey}`); } catch (err) { toastError(err); }
    });
    on(view, 'click', '[data-act=approve]', (e, el) => withBusy(el, async () => {
      if (!total()) { toast('Select at least one test case to approve.', 'warn'); return; }
      const postToJira = view.querySelector('[name=postToJira]').checked;
      if (postToJira) {
        const ok = await QA.ui.confirm({ title: `Update ${pr.storyKey} in Jira?`, message: h`A comment summarising ${total()} approved test cases and the label <code>api-tests-generated</code> will be added to ${pr.storyKey}.`, confirmLabel: 'Approve and update Jira' });
        if (!ok) return;
      }
      const selected = Object.fromEntries(sel.map((s, i) => [i, [...s].sort((x, y) => x - y)]));
      try {
        const r = await api.post(`/api/proposals/${pr.id}/approve`, { selected, postToJira });
        toast(h`${r.tests} test cases in ${r.scenarios} scenarios saved.${r.jira ? (r.jira.ok ? ` Jira ${pr.storyKey} updated.` : ` Jira was not updated: ${r.jira.title}`) : ''}`, r.jira && !r.jira.ok ? 'warn' : 'ok', 'Proposal approved');
        QA.router.go(`/stories/${pr.storyKey}`);
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
