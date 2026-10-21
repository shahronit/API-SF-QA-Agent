/* Test scenarios: grouped coverage per story, with inline priority/status edits. */
(() => {
  const QA = window.QA;
  const { h, ic, badge, prov, pri, on, empty, toast, toastError, esc, confirm } = QA.ui;
  const C = QA.components;
  const api = QA.api;

  QA.pages.scenarios = {
    render(view, ctx) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Test scenarios' }]);
      const m = QA.state.meta;
      view.innerHTML = String(h`${C.pageHead('Test scenarios', 'Groups of tests by intent (happy path, negative, boundary, security, integration), each tied to a Jira ticket.',
        h`<a class="btn primary" href="/stories" data-link>${ic('wand')} Generate from a ticket</a>`)}
        ${C.pageIntro({ what: 'A scenario is a folder of related tests for one ticket. Useful when you want coverage by intent rather than a flat test list.', next: 'Generate from a Jira ticket if this list is empty. Open Tests to edit individual cases.' })}
        <div data-list></div>`);
      const list = C.listController(view.querySelector('[data-list]'), {
        sort: 's.id', dir: 'ASC', searchPlaceholder: 'Search id, title, story or object',
        filters: { type: ctx.query.type || '', priority: ctx.query.priority || '', storyKey: ctx.query.storyKey || '' },
        toolbar: (s) => h`${C.chipGroup('type', m.testTypes.filter((t) => ['Functional', 'Negative', 'Boundary', 'Security', 'Integration'].includes(t)), (s.filters.type || '').split(','))}
          <select class="select" data-filter="priority" aria-label="Priority"><option value="">All priorities</option>${m.priorities.map((x) => h`<option ${s.filters.priority === x ? 'selected' : ''}>${x}</option>`)}</select>`,
        fetch: (q) => api.get(`/api/scenarios${api.qs({ projectId: p.id, ...q })}`),
        rowAttrs: (r) => `data-id="${esc(r.id)}"`,
        onRow: (r) => QA.router.go(`/testcases?scenarioId=${r.id}`),
        emptyState: () => empty({ icon: 'layers', title: 'No scenarios', text: 'Approve a generated proposal to create scenarios.' }),
        columns: [
          { key: 'id', label: 'Id', sortable: true, sortKey: 's.id', render: (r) => h`<span class="mono small">${r.id}</span>` },
          { key: 'title', label: 'Scenario', sortable: true, sortKey: 's.title', render: (r) => h`<div class="cell-title">${r.title}</div><div class="cell-sub">${r.description || ''}</div>` },
          { key: 'storyKey', label: 'Story', sortable: true, sortKey: 's.storyKey', render: (r) => (r.storyKey ? h`<a href="/stories/${r.storyKey}" data-link class="small">${r.storyKey}</a>` : '–') },
          { key: 'type', label: 'Type', sortable: true, sortKey: 's.type' },
          { key: 'apiType', label: 'API', sortable: true, sortKey: 's.apiType', render: (r) => h`<span class="small">${r.apiType || '–'}</span>` },
          { key: 'priority', label: 'Priority', sortable: true, sortKey: 's.priority', render: (r) => h`<select class="select" data-pri="${r.id}" aria-label="Priority for ${r.id}" style="height:26px;width:64px">${m.priorities.map((x) => h`<option ${r.priority === x ? 'selected' : ''}>${x}</option>`)}</select>` },
          { key: 'label', label: 'Provenance', render: (r) => prov(r.label) },
          { key: 'tests', label: 'Tests', render: (r) => h`<span class="num">${r.tests}</span><div class="cell-sub">${r.passed} passed${r.failed ? h` · <span class="text-error">${r.failed} failed</span>` : ''}</div>` },
          { key: 'status', label: 'Status', sortable: true, sortKey: 's.status', render: (r) => badge(r.status) },
          { key: 'actions', label: '', cls: 'actions', render: (r) => h`<button class="btn xs ghost" data-del="${r.id}" aria-label="Delete ${r.id}">${ic('trash')}</button>` },
        ],
      });
      on(view, 'change', '[data-pri]', async (e, el) => {
        try { await api.put(`/api/scenarios/${el.dataset.pri}`, { priority: el.value }); toast(`${el.dataset.pri} set to ${el.value}.`, 'ok'); } catch (err) { toastError(err); list.reload(); }
      });
      on(view, 'click', '[data-del]', async (e, el) => {
        const ok = await confirm({ title: `Delete scenario ${el.dataset.del}?`, message: 'Its test cases are deleted too. Execution history is kept.', confirmLabel: 'Delete scenario', danger: true });
        if (!ok) return;
        try { const r = await api.del(`/api/scenarios/${el.dataset.del}`); toast(`Scenario deleted${r && r.testCases ? ` with ${r.testCases} test cases` : ''}.`, 'warn'); list.reload(); } catch (err) { toastError(err); }
      });
      return null;
    },
  };
})();
