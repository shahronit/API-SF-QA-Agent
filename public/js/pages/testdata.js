/* Test data manager: datasets by category, generation from describe, CSV/JSON import, tracked cleanup. */
(() => {
  const QA = window.QA;
  const { h, ic, fmt, on, empty, toast, toastError, withBusy, esc, modal, confirm, json } = QA.ui;
  const C = QA.components;
  const api = QA.api;
  const CATEGORIES = ['Positive', 'Negative', 'Boundary', 'Security', 'Integration', 'Bulk', 'Regression', 'Performance'];

  QA.pages.testdata = {
    render(view, ctx) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Test data' }]);
      const prod = p.environment === 'Production';
      view.innerHTML = String(h`${C.pageHead('Test data', 'Reusable request payloads (positive, negative, boundary, and so on). Records created in a run are cleaned up automatically outside Production.',
        h`<button class="btn" data-act="cleanup" ${prod ? 'disabled title="Disabled in Production"' : ''}>${ic('trash')} Clean up run data</button><button class="btn" data-act="import">${ic('upload')} Import CSV/JSON</button><button class="btn" data-act="new">${ic('plus')} New dataset</button><button class="btn primary" data-act="generate">${ic('wand')} Generate</button>`)}
        ${C.pageIntro({ what: 'Datasets tests can reuse as {{variables}}. They are not Salesforce records until a run creates them.', next: prod ? 'Production is read-only here — use payloads for verification only.' : 'Generate from an object describe, or import CSV/JSON. Clean up run data when a sandbox run left records behind.' })}
        ${prod ? h`<div class="callout error" style="margin-bottom:16px">${ic('shield')}<div class="small">Production: records are never created or deleted automatically. Use these payloads for read-only verification only.</div></div>` : ''}
        <div data-list></div>`);
      const list = C.listController(view.querySelector('[data-list]'), {
        sort: 'createdAt', searchPlaceholder: 'Search name, object, story or notes', filters: { category: ctx.query.category || '' },
        toolbar: (s) => C.chipGroup('category', CATEGORIES, (s.filters.category || '').split(',')),
        fetch: (q) => api.get(`/api/testdata${api.qs({ projectId: p.id, ...q })}`),
        rowAttrs: (r) => `data-id="${esc(r.id)}"`,
        onRow: (r) => editDialog(r, list),
        emptyState: () => empty({ icon: 'database', title: 'No test data', text: 'Generate datasets from object metadata or import a CSV/JSON file.' }),
        columns: [
          { key: 'id', label: 'Id', render: (r) => h`<span class="mono small">${r.id}</span>` },
          { key: 'name', label: 'Dataset', render: (r) => h`<div class="cell-title">${r.name}</div><div class="cell-sub">${r.notes || ''}</div>` },
          { key: 'category', label: 'Category', render: (r) => h`<span class="tag">${r.category}</span>` },
          { key: 'object', label: 'Object', render: (r) => h`<span class="mono small">${r.object || '–'}</span>` },
          { key: 'storyKey', label: 'Story', render: (r) => r.storyKey || '–' },
          { key: 'payload', label: 'Payload', render: (r) => h`<code class="mono small truncate" style="display:block;max-width:320px">${JSON.stringify(r.payload)}</code>` },
          { key: 'updatedAt', label: 'Updated', render: (r) => fmt.ago(r.updatedAt) },
        ],
      });

      on(view, 'click', '[data-act=new]', () => editDialog(null, list));
      on(view, 'click', '[data-act=generate]', () => {
        modal({
          title: 'Generate test data', subtitle: `Built from the object describe (${p.connection.metadataLabel}).`,
          body: h`<div class="form-grid"><label class="field"><span>Object</span><input class="input mono" name="object" placeholder="Contact" value="Contact"></label>
            <label class="field"><span>Category</span><select class="select" name="category">${CATEGORIES.map((c) => h`<option>${c}</option>`)}</select></label>
            <label class="field"><span>How many</span><input class="input" type="number" name="count" min="1" max="50" value="3"></label>
            <label class="field"><span>Story key (optional)</span><input class="input mono" name="storyKey"></label></div>`,
          foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>${ic('wand')} Generate</button>`,
          onMount(el, close) {
            el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
              const v = (n) => el.querySelector(`[name=${n}]`).value.trim();
              try { const r = await api.post(`/api/testdata/generate?projectId=${p.id}`, { object: v('object'), category: v('category'), count: Number(v('count')), storyKey: v('storyKey') || undefined }); close(); toast(`${r.created} datasets generated.`, 'ok'); list.reload(); } catch (err) { toastError(err, 'Generation failed'); }
            }));
          },
        });
      });
      on(view, 'click', '[data-act=import]', () => {
        modal({
          title: 'Import test data', size: 'wide', subtitle: 'CSV needs a header row. JSON can be an object or an array of objects. Secret-looking values are masked on import.',
          body: h`<div class="form-grid"><label class="field"><span>Format</span><select class="select" name="format"><option value="csv">CSV</option><option value="json">JSON</option></select></label>
            <label class="field"><span>Category</span><select class="select" name="category">${CATEGORIES.map((c) => h`<option>${c}</option>`)}</select></label>
            <label class="field"><span>Object</span><input class="input mono" name="object" placeholder="Account"></label>
            <label class="field"><span>File</span><input class="input" type="file" name="file" accept=".csv,.json,text/csv,application/json"></label>
            <label class="field full"><span>Or paste content</span><textarea class="input mono" rows="8" name="content" placeholder="Name,Industry&#10;QA Import 1,Banking"></textarea></label></div>`,
          foot: h`<button class="btn" data-close>Cancel</button><button class="btn primary" data-go>${ic('upload')} Import</button>`,
          onMount(el, close) {
            el.querySelector('[name=file]').addEventListener('change', async (e) => { const file = e.target.files[0]; if (!file) return; el.querySelector('[name=content]').value = await file.text(); el.querySelector('[name=format]').value = /\.json$/i.test(file.name) ? 'json' : 'csv'; });
            el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
              const v = (n) => el.querySelector(`[name=${n}]`).value;
              try { const r = await api.post(`/api/testdata/import?projectId=${p.id}`, { format: v('format'), category: v('category'), object: v('object').trim() || undefined, content: v('content') }); close(); toast(`${r.created} records imported.`, 'ok'); list.reload(); } catch (err) { toastError(err, 'Import failed'); }
            }));
          },
        });
      });
      on(view, 'click', '[data-act=cleanup]', (e, el) => withBusy(el, async () => {
        try {
          const prev = await api.post(`/api/testdata/cleanup?projectId=${p.id}`, {});
          if (!prev.preview) { toast(prev.message || 'Nothing to clean up.', 'info'); return; }
          const ok = await confirm({ title: 'Delete tracked test records?', message: h`${prev.message} Only records created by this platform's runs are included.`, confirmLabel: `Delete ${prev.count} records`, danger: true });
          if (!ok) return;
          const r = await api.post(`/api/testdata/cleanup?projectId=${p.id}`, { confirmed: true });
          toast(`${r.deleted} of ${r.attempted} records deleted.${r.errors && r.errors.length ? ` ${r.errors.length} errors.` : ''}`, r.errors && r.errors.length ? 'warn' : 'ok', 'Cleanup complete');
        } catch (err) { toastError(err, 'Cleanup failed'); }
      }));
      return null;
    },
  };

  function editDialog(r, list) {
    const p = QA.state.project;
    modal({
      title: r ? `Edit ${r.id}` : 'New dataset', size: 'wide',
      body: h`<div class="form-grid"><label class="field full"><span>Name</span><input class="input" name="name" value="${r ? r.name : ''}"></label>
        <label class="field"><span>Category</span><select class="select" name="category">${CATEGORIES.map((c) => h`<option ${r && r.category === c ? 'selected' : ''}>${c}</option>`)}</select></label>
        <label class="field"><span>Object</span><input class="input mono" name="object" value="${r ? r.object || '' : ''}"></label>
        <label class="field"><span>Story key</span><input class="input mono" name="storyKey" value="${r ? r.storyKey || '' : ''}"></label>
        <label class="field full"><span>Payload (JSON)</span><textarea class="input mono" rows="10" name="payload" spellcheck="false">${JSON.stringify(r ? r.payload : {}, null, 2)}</textarea><small>Reference in tests with variables; never store credentials here.</small></label>
        <label class="field full"><span>Notes</span><input class="input" name="notes" value="${r ? r.notes || '' : ''}"></label></div>`,
      foot: h`${r ? h`<button class="btn danger-outline" data-del>${ic('trash')} Delete</button>` : ''}<span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" data-go>Save</button>`,
      onMount(el, close) {
        el.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
          const v = (n) => el.querySelector(`[name=${n}]`).value.trim();
          let payload;
          try { payload = JSON.parse(v('payload') || '{}'); } catch (err) { toastError({ message: `Payload is not valid JSON: ${err.message}`, info: {} }); return; }
          const b = { name: v('name'), category: v('category'), object: v('object') || null, storyKey: v('storyKey') || null, payload, notes: v('notes') || null };
          try { if (r) await api.put(`/api/testdata/${r.id}`, b); else await api.post(`/api/testdata?projectId=${p.id}`, b); close(); toast('Dataset saved.', 'ok'); list.reload(); } catch (err) { toastError(err, 'Not saved'); }
        }));
        const del = el.querySelector('[data-del]');
        if (del) del.addEventListener('click', async () => { try { await api.del(`/api/testdata/${r.id}`); close(); toast('Dataset deleted.', 'warn'); list.reload(); } catch (err) { toastError(err); } });
      },
    });
  }
})();
