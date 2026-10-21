/* Audit log: who did what, when — executions, Jira writes, safety confirmations, exports. */
(() => {
  const QA = window.QA;
  const { h, fmt, esc, empty } = QA.ui;
  const C = QA.components;
  const api = QA.api;
  const CATS = ['execution', 'jira', 'safety', 'generation', 'tests', 'explorer', 'discovery', 'testdata', 'contracts', 'automation', 'report', 'project', 'agent'];

  QA.pages.logs = {
    render(view, ctx) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Audit log' }]);
      view.innerHTML = String(h`${C.pageHead('Audit log', 'Who did what, when — runs, Jira writes, production confirmations, exports and config changes. Details are masked.')}
        ${C.pageIntro({ what: 'A read-only trail for this project. Use it when you need to explain a change or a production confirmation.', next: 'Filter by category or search for a user, action or id. Nothing on this screen can change Salesforce or Jira.' })}
        <div data-list></div>`);
      C.listController(view.querySelector('[data-list]'), {
        sort: 'ts', dir: 'DESC', searchPlaceholder: 'Search action, user or detail', pageSize: 50, filters: { category: ctx.query.category || '' },
        toolbar: (s) => h`<select class="select" data-filter="category" aria-label="Category"><option value="">All categories</option>${CATS.map((c) => h`<option ${s.filters.category === c ? 'selected' : ''}>${c}</option>`)}</select>`,
        fetch: (q) => api.get(`/api/audit${api.qs({ projectId: p.id, ...q })}`),
        rowAttrs: (r) => `data-id="${esc(r.id)}"`,
        emptyState: () => empty({ icon: 'log', title: 'No audit entries', text: 'Actions in this project are recorded here.' }),
        columns: [
          { key: 'ts', label: 'When', render: (r) => h`<span class="nowrap" title="${r.ts}">${fmt.date(r.ts)}</span>` },
          { key: 'user', label: 'User' },
          { key: 'category', label: 'Category', render: (r) => h`<span class="tag ${r.category === 'safety' ? '' : ''}" style="${r.category === 'safety' ? 'background:var(--error-soft);color:var(--error-text)' : r.category === 'jira' ? 'background:var(--primary-soft);color:var(--primary)' : ''}">${r.category}</span>` },
          { key: 'action', label: 'Action', render: (r) => h`<span class="mono small">${r.action}</span>` },
          { key: 'detail', label: 'Detail', render: (r) => h`<code class="mono small" style="display:block;max-width:560px;white-space:pre-wrap;word-break:break-word">${r.detail ? JSON.stringify(r.detail) : ''}</code>` },
        ],
      });
      return null;
    },
  };
})();
