/* Defects: Jira defects raised from failed tests; status sync and confirmed updates. */
(() => {
  const QA = window.QA;
  const { h, ic, fmt, badge, on, empty, toast, toastError, esc, drawer, loading, errorBox, withBusy, confirm } = QA.ui;
  const C = QA.components;
  const api = QA.api;
  const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
  const STATUSES = ['Open', 'In Progress', 'Reopened', 'Resolved', 'Closed'];

  QA.pages.defects = {
    render(view, ctx) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Defects' }]);
      view.innerHTML = String(h`${C.pageHead('Defects', h`Jira issues raised from failed tests. Click a result in an execution to create a defect. Secrets are always masked.`,
        h`<a class="btn" href="/execution" data-link>${ic('zap')} Find failed tests</a>`)}
        <div class="callout success" style="margin-bottom:16px">${ic('check')}<div class="small"><b>Workflow:</b> Test fails → you review → you preview draft → you click Create → linked to story.</div></div>
        <div data-list></div>`);
      const list = C.listController(view.querySelector('[data-list]'), {
        sort: 'createdAt', dir: 'DESC', q: ctx.query.q || '', searchPlaceholder: 'Search key, summary or endpoint',
        filters: { status: ctx.query.status || '', severity: ctx.query.severity || '' },
        toolbar: (s) => h`${C.chipGroup('severity', SEVERITIES, (s.filters.severity || '').split(','))}<select class="select" data-filter="status" aria-label="Status"><option value="">Any status</option>${STATUSES.map((x) => h`<option ${s.filters.status === x ? 'selected' : ''}>${x}</option>`)}</select>`,
        fetch: (q) => api.get(`/api/defects${api.qs({ projectId: p.id, ...q })}`),
        rowAttrs: (r) => `data-id="${esc(r.id)}"`,
        onRow: (r) => openDefect(r.id, list),
        emptyState: (s) => empty({ icon: 'bug', title: s.q || s.filters.status || s.filters.severity ? 'No defects match' : 'No defects yet', text: 'Open a failed result in an execution and choose "Preview Jira defect".' }),
        columns: [
          { key: 'key', label: 'Key', sortable: true, render: (r) => h`<b class="mono small">${r.key}</b>` },
          { key: 'summary', label: 'Summary', render: (r) => h`<div class="cell-title">${r.summary}</div><div class="cell-sub mono">${r.endpoint || ''}</div>` },
          { key: 'severity', label: 'Severity', sortable: true, render: (r) => badge(r.severity) },
          { key: 'status', label: 'Status', sortable: true, render: (r) => badge(r.status) },
          { key: 'storyKey', label: 'Story', render: (r) => (r.storyKey ? h`<a href="/stories/${r.storyKey}" data-link class="small">${r.storyKey}</a>` : '–') },
          { key: 'testCaseId', label: 'Test', render: (r) => h`<a href="/testcases?id=${r.testCaseId}" data-link class="mono small">${r.testCaseId}</a>` },
          { key: 'createdAt', label: 'Created', sortable: true, render: (r) => h`${fmt.ago(r.createdAt)}<div class="cell-sub">${r.createdBy}</div>` },
        ],
      });
      return null;
    },
  };

  async function openDefect(id, list) {
    const d = drawer({ title: 'Loading defect…', body: loading(8), foot: h``, width: 820 });
    let x;
    try { x = await api.get(`/api/defects/${encodeURIComponent(id)}`); } catch (e) { d.setBody(errorBox(e)); return; }
    d.el.querySelector('#d-title').textContent = `${x.key} · ${x.summary}`;
    d.setBody(h`<div class="row wrap" style="gap:8px;margin-bottom:14px">${badge(x.severity)}${badge(x.status)}${(x.labels || []).map((l) => h`<span class="tag">${l}</span>`)}</div>
      ${C.kv([['Jira', x.url ? h`<a href="${x.url}" target="_blank" rel="noopener">${x.key} ${QA.ui.ic('external')}</a>` : x.key], ['Story', x.storyKey ? h`<a href="/stories/${x.storyKey}" data-link>${x.storyKey}</a>` : null], ['Test case', h`<a href="/testcases?id=${x.testCaseId}" data-link>${x.testCaseId}</a>`], ['Execution', x.runId ? h`<a href="/execution/${x.runId}" data-link class="mono">${x.runId}</a>` : null], ['Result', x.resultId ? h`<button class="btn xs" data-res="${x.resultId}">Open request/response</button>` : null], ['Created', `${fmt.date(x.createdAt)} by ${x.createdBy}`], ['Resolved', x.resolvedAt ? fmt.date(x.resolvedAt) : null]])}
      <div class="form-grid mt">
        <label class="field"><span>Severity</span><select class="select" name="severity">${SEVERITIES.map((s) => h`<option ${x.severity === s ? 'selected' : ''}>${s}</option>`)}</select></label>
        <label class="field"><span>Status</span><select class="select" name="status">${STATUSES.map((s) => h`<option ${x.status === s ? 'selected' : ''}>${s}</option>`)}</select></label>
        <label class="field full"><span>Comment for Jira (optional)</span><textarea class="input" rows="2" name="comment" placeholder="e.g. Retested in QA run EX-…; still failing."></textarea></label>
      </div>
      <h3 class="mt">Description</h3><pre class="code" style="white-space:pre-wrap">${x.description || ''}</pre>`);
    d.setFoot(h`<button class="btn" data-act="sync">${ic('refresh')} Sync status from Jira</button><span class="spacer"></span><button class="btn" data-act="local">Save locally</button><button class="btn primary" data-act="push">${ic('jira')} Save and update Jira</button>`);
    on(d.el, 'click', '[data-res]', (e, el) => C.openResult(el.dataset.res));
    on(d.el, 'click', '[data-link]', () => d.close());
    const vals = () => ({ severity: d.el.querySelector('[name=severity]').value, status: d.el.querySelector('[name=status]').value, comment: d.el.querySelector('[name=comment]').value.trim() || undefined });
    on(d.el, 'click', '[data-act=local]', (e, el) => withBusy(el, async () => { try { const v = vals(); delete v.comment; await api.put(`/api/defects/${x.id}`, v); toast(`${x.key} saved locally. Jira was not changed.`, 'ok'); d.close(); list.reload(); QA.state.emit('defects-changed'); } catch (err) { toastError(err); } }));
    on(d.el, 'click', '[data-act=push]', (e, el) => withBusy(el, async () => {
      const v = vals();
      const ok = await confirm({ title: `Update ${x.key} in Jira?`, message: h`Severity <b>${v.severity}</b>, status <b>${v.status}</b>${v.comment ? ' and your comment' : ''} will be sent to Jira.`, confirmLabel: 'Update Jira' });
      if (!ok) return;
      try { await api.put(`/api/defects/${x.id}`, { ...v, pushToJira: true, confirmed: true }); toast(`${x.key} updated in Jira.`, 'ok'); d.close(); list.reload(); QA.state.emit('defects-changed'); } catch (err) { toastError(err, 'Jira not updated'); }
    }));
    on(d.el, 'click', '[data-act=sync]', (e, el) => withBusy(el, async () => { try { const r = await api.post(`/api/defects/${x.id}/sync`); toast(`${x.key} is ${r.status} in Jira.`, 'ok'); d.close(); list.reload(); QA.state.emit('defects-changed'); } catch (err) { toastError(err, 'Sync failed'); } }));
  }
})();
