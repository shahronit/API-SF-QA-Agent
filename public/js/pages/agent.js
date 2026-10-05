/* Agent console: natural-language commands mapped to agent modes (Discover … Report). */
(() => {
  const QA = window.QA;
  const { h, ic, fmt, badge, method, on, errorBox, toastError, withBusy, esc } = QA.ui;
  const C = QA.components;
  const api = QA.api;
  const history = []; // kept for the session while navigating

  const EXAMPLES = [
    'Analyze Jira story DEMO-101 and generate Salesforce API test cases.',
    'Test creating a Contact without a LastName.',
    'Check what happens with an invalid email on Contact.',
    'Verify Account rejects a value over the maximum field length.',
    'Test querying Account without an access token.',
    'Test deleting a non-existent Case.',
    'Discover all APIs related to Contact.',
    'Generate negative tests for the Account API.',
    'Run only P0 and P1 tests.',
    'Validate the API response against Salesforce.',
    'Analyze failed tests from the latest execution.',
    'Create Jira defects for confirmed failures.',
    'Show me APIs with failure rate above 10%.',
    'Generate a Postman collection for this API.',
    'Generate the QA execution report.',
  ];

  QA.pages.agent = {
    render(view) {
      const p = QA.state.project;
      if (!p) { view.innerHTML = String(C.projectRequired()); return null; }
      QA.router.setCrumbs([{ label: 'Agent console' }]);
      const modes = QA.state.meta.modes;
      view.innerHTML = String(h`${C.pageHead('Agent console', h`Describe a scenario in plain language — e.g. "Test creating a Contact without a LastName" — and the agent builds the test, runs it against ${p.name} and shows you the result right here. It also picks a mode — ${modes.join(', ')} — for broader requests. Jira defects and production writes always wait for your confirmation.`)}
        <div class="grid g-21"><div class="card" style="display:flex;flex-direction:column;min-height:560px">
          <div class="agent-log card-body" data-log style="flex:1;overflow-y:auto"></div>
          <form class="card-body row" data-form style="border-top:1px solid var(--border);gap:8px"><label class="sr-only" for="cmd">Command</label><input class="input" id="cmd" name="cmd" autocomplete="off" placeholder="e.g. Run the Account API regression suite in QA" style="flex:1"><button class="btn primary" type="submit">${ic('send')} Send</button></form>
        </div>
        <div class="stack"><div class="card"><div class="card-head"><h2>Try a command</h2></div><div class="card-body stack" style="gap:6px">${EXAMPLES.map((x) => h`<button class="btn sm ghost" style="justify-content:flex-start;white-space:normal;text-align:left;height:auto;padding:6px 8px" data-ex="${x}">${x}</button>`)}</div></div>
          <div class="card"><div class="card-head"><h2>Modes</h2></div><div class="card-body small">${modes.map((m) => h`<div style="margin-bottom:6px"><span class="mode-pill">${m}</span></div>`)}</div></div></div></div>`);
      const log = view.querySelector('[data-log]');
      const draw = () => {
        log.innerHTML = String(history.length ? h`${history.map((m) => (m.role === 'user' ? h`<div class="agent-msg user">${m.text}</div>` : renderReply(m)))}` : h`<div class="empty" style="padding:40px 16px">${ic('terminal')}<h3>Ask the agent</h3><p>Commands run against the current project and environment.</p></div>`);
        log.scrollTop = log.scrollHeight;
      };
      draw();
      const send = async (text, btn) => {
        if (!text.trim()) return;
        history.push({ role: 'user', text });
        draw();
        await withBusy(btn, async () => {
          try {
            const r = await C.withProductionSafety((conf) => api.post('/api/agent/command', { text, projectId: p.id, ...conf }));
            if (r) history.push({ role: 'agent', ...r });
            else history.push({ role: 'agent', mode: 'Discover', message: 'Cancelled — the production write was not confirmed.' });
          } catch (e) { history.push({ role: 'agent', mode: 'Error', message: e.message, error: e }); }
        });
        draw();
      };
      on(view, 'submit', '[data-form]', (e) => { e.preventDefault(); const i = view.querySelector('[name=cmd]'); const t = i.value; i.value = ''; send(t, e.target.querySelector('button')); });
      on(view, 'click', '[data-ex]', (e, el) => { view.querySelector('[name=cmd]').value = el.dataset.ex; view.querySelector('[name=cmd]').focus(); });
      on(log, 'click', '[data-dl]', async (e, el) => { try { await api.download(el.dataset.dl, el.dataset.name); } catch (err) { toastError(err); } });
      on(log, 'click', '[data-ex2]', (e, el) => { view.querySelector('[name=cmd]').value = el.dataset.ex2; });
      on(log, 'click', '[data-defect]', (e, el) => C.defectPreview(el.dataset.defect));
      on(log, 'click', '[data-result]', (e, el) => C.openResult(el.dataset.result));
      setTimeout(() => view.querySelector('[name=cmd]').focus(), 30);
      return null;
    },
  };

  /** Compact inline summary of an ad hoc scenario's single-call result. */
  function exchangeSummary(x) {
    if (!x) return '';
    const passCount = (x.assertions || []).filter((a) => a.result === 'PASS').length;
    const failCount = (x.assertions || []).filter((a) => a.result === 'FAIL').length;
    return h`<div class="card mt-s" style="background:var(--surface-2)"><div class="card-body" style="padding:10px 12px">
      <div class="row wrap" style="gap:8px;align-items:center">
        ${badge(x.status)}${method(x.request ? x.request.method : x.method)}<code class="mono small">${fmt.shortPath(x.endpoint || (x.request && x.request.url))}</code>
        ${x.statusCode ? h`<span class="small muted">HTTP ${x.statusCode}</span>` : ''}${x.responseMs !== undefined ? h`<span class="small muted">${fmt.ms(x.responseMs)}</span>` : ''}
      </div>
      ${x.assertions && x.assertions.length ? h`<div class="small muted mt-s">${passCount} assertion(s) passed${failCount ? `, ${failCount} failed` : ''}</div>` : ''}
      <div class="row wrap mt-s" style="gap:6px"><button class="btn xs" data-result="${x.id}">${ic('compass')} View full request/response</button></div>
    </div></div>`;
  }

  function classificationNote(cls) {
    if (!cls) return '';
    const tone = cls.needsApiTesting ? 'info' : 'warn';
    return h`<div class="callout ${tone} mt-s">${ic(cls.needsApiTesting ? 'check' : 'alert')}<div class="small"><b>Ticket relevance (ASSUMED, ${cls.confidence} confidence):</b> ${cls.needsApiTesting ? 'Looks like it needs API testing.' : 'May not need API testing.'} ${cls.reasons[0] || ''}</div></div>`;
  }

  function renderReply(m) {
    const d = m.data || {};
    const list = (rows, cols) => h`<div class="table-wrap mt-s"><table class="t"><tbody>${rows.slice(0, 10).map((r) => h`<tr>${cols.map((c) => h`<td class="small">${c(r)}</td>`)}</tr>`)}</tbody></table></div>${rows.length > 10 ? h`<div class="small muted">…and ${rows.length - 10} more</div>` : ''}`;
    return h`<div class="agent-msg"><div class="row" style="gap:8px;margin-bottom:4px"><span class="mode-pill" style="${m.mode === 'Error' ? 'background:var(--error-soft);color:var(--error-text)' : ''}">${m.mode}</span>${m.modeDescription ? h`<span class="small muted">${m.modeDescription}</span>` : ''}</div>
      <div>${m.message}</div>
      ${m.error ? errorBox(m.error) : ''}${m.explanation ? errorBox({ message: m.explanation.title, info: m.explanation }) : ''}
      ${m.requiresConfirmation ? h`<div class="callout error mt-s">${ic('shield')}<div class="small">Production writes need explicit confirmation on the execution screen.</div></div>` : ''}
      ${d.classification ? classificationNote(d.classification) : ''}
      ${m.exchange ? exchangeSummary(m.exchange) : ''}
      ${d.objects ? list(d.objects, [(o) => h`<span class="mono">${o.name || o}</span>`, (o) => o.label || '']) : ''}
      ${d.apis ? list(d.apis, [(a) => QA.ui.method(a.method), (a) => h`<code class="mono">${fmt.shortPath(a.path)}</code>`, (a) => a.name || a.description || '']) : ''}
      ${d.candidates ? list(d.candidates, [(c) => c.title, (c) => h`<span class="muted">${c.rootCause || ''}</span>`, (c) => (c.defectKey ? c.defectKey : h`<button class="btn xs" data-defect="${c.resultId}">${ic('bug')} Preview defect</button>`)]) : ''}
      ${d.mismatches ? list(d.mismatches, [(c) => c.title, (c) => h`<span class="muted">${(c.diffs || c.fields || []).map ? (c.diffs || c.fields || []).map((x) => (typeof x === 'string' ? x : `${x.field}: ${x.expected} → ${x.actual}`)).join('; ') : ''}</span>`]) : ''}
      ${d.endpoints ? list(d.endpoints, [(x) => QA.ui.method(x.method), (x) => h`<code class="mono">${fmt.shortPath(x.endpoint)}</code>`, (x) => `${x.failureRate}%`]) : ''}
      ${d.categories ? list(d.categories, [(c) => c.category, (c) => `${c.count}`]) : ''}
      ${m.examples ? h`<div class="row wrap mt-s" style="gap:6px">${m.examples.map((x) => h`<button class="chip" data-ex2="${x}">${x}</button>`)}</div>` : ''}
      <div class="row wrap mt-s" style="gap:6px">${m.navigate ? h`<a class="btn sm" href="${m.navigate}" data-link>${ic('chevronRight')} Open</a>` : ''}${m.download ? h`<button class="btn sm" data-dl="${m.download}" data-name="collection.json">${ic('download')} Download</button>` : ''}${(m.downloads || []).map((x) => h`<button class="btn sm" data-dl="${x.url}" data-name="report.${x.format}">${ic('download')} ${x.format.toUpperCase()}</button>`)}</div></div>`;
  }
})();
