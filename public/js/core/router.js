/* History-API router. Pages register with QA.pages[name] = { title, render(view, ctx) → cleanup? }.
   Routes map URL patterns to page names; ctx = { params, query, path }. */
(() => {
  const QA = window.QA;
  const ROUTES = [
    ['/', 'dashboard'], ['/dashboard', 'dashboard'],
    ['/workflow', 'workflow'], ['/workflow/:step', 'workflow'],
    ['/projects/new', 'projects'], ['/projects', 'projects'], ['/projects/:id', 'projects'],
    ['/explorer', 'explorer'],
    ['/stories', 'stories'], ['/stories/:key', 'stories'], ['/generate/:id', 'stories'],
    ['/scenarios', 'scenarios'],
    ['/testcases', 'testcases'], ['/testcases/:id', 'testcases'],
    ['/execution', 'execution'], ['/execution/:runId', 'execution'],
    ['/defects', 'defects'], ['/defects/:id', 'defects'],
    ['/traceability', 'traceability'], ['/regression', 'traceability'],
    ['/testdata', 'testdata'],
    ['/contracts', 'contracts'],
    ['/reports', 'reports'],
    ['/automation', 'automation'],
    ['/insights', 'insights'],
    ['/agent', 'agent'],
    ['/logs', 'logs'],
  ].map(([pattern, page]) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
    return { pattern, page, re, keys };
  });

  let cleanup = null;
  let current = null;
  // Snapshot mode (static single-file build) keeps a virtual URL instead of using history.
  const SNAP = Boolean(window.__QA_SNAPSHOT__);
  let virtual = SNAP ? (window.__QA_SNAPSHOT_ROUTE__ || '/') : null;
  const here = () => new URL(SNAP ? virtual : location.href, 'http://snapshot.local');

  function match(path) {
    for (const r of ROUTES) {
      const m = path.match(r.re);
      if (m) return { page: r.page, pattern: r.pattern, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }

  /** Replace #view with a fresh element so listeners bound by the previous page are dropped
      and late async renders from that page land in a detached node. */
  function freshView() {
    const old = document.getElementById('view');
    const v = document.createElement('main');
    v.setAttribute('id', 'view');
    v.setAttribute('class', 'view');
    v.setAttribute('tabindex', '-1');
    old.parentNode.insertBefore(v, old);
    old.remove();
    return v;
  }

  async function render() {
    const view = freshView();
    const url = here();
    const m = match(url.pathname);
    if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
    cleanup = null;
    document.getElementById('overlay-root').innerHTML = '';
    if (!m || !QA.pages[m.page]) {
      view.innerHTML = String(QA.ui.empty({ icon: 'compass', title: 'Page not found', text: `${url.pathname} does not exist in this application.`, action: QA.ui.h`<a class="btn primary" href="/" data-link>Go to dashboard</a>` }));
      setCrumbs([{ label: 'Not found' }]);
      return;
    }
    const ctx = { params: m.params, query: Object.fromEntries(url.searchParams), path: url.pathname, pattern: m.pattern };
    current = { ...m, ctx };
    QA.state.emit('route', current);
    const page = QA.pages[m.page];
    view.innerHTML = '';
    view.scrollTop = 0;
    window.scrollTo(0, 0);
    try {
      cleanup = await page.render(view, ctx);
    } catch (e) {
      console.error(e);
      view.innerHTML = String(QA.ui.h`<div style="padding:24px">${QA.ui.errorBox(e.info ? e : { message: e.message, info: { cause: 'The page failed while rendering.', action: 'Reload the page. If it persists, check the browser console for details.' } })}</div>`);
    }
    if (!document.activeElement || document.activeElement === document.body) view.focus({ preventScroll: true });
  }

  function setCrumbs(items) {
    const el = document.getElementById('crumbs');
    const { h } = QA.ui;
    el.innerHTML = String(h`${items.map((c, i) => h`${i ? h`<span class="sep">/</span>` : ''}${c.href && i < items.length - 1 ? h`<a href="${c.href}" data-link>${c.label}</a>` : h`<span class="${i === items.length - 1 ? 'current' : ''}">${c.label}</span>`}`)}`);
    document.title = `${items[items.length - 1].label} · API QA Platform`;
  }

  function go(path, { replace = false } = {}) {
    if (SNAP) { virtual = path; return render(); }
    if (path === location.pathname + location.search) return render();
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
    render();
  }
  /** Update query string without re-rendering (for filter state). */
  function setQuery(params) {
    const url = here();
    for (const [k, v] of Object.entries(params)) { if (v === undefined || v === null || v === '') url.searchParams.delete(k); else url.searchParams.set(k, v); }
    if (SNAP) virtual = url.pathname + url.search; else history.replaceState({}, '', url.pathname + url.search);
  }

  window.addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link], [data-href]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const href = a.getAttribute('href') || a.getAttribute('data-href');
    if (!href || /^https?:/.test(href)) return;
    e.preventDefault();
    go(href);
  });

  QA.router = { go, render, setCrumbs, setQuery, match, get current() { return current; }, get path() { return here().pathname; } };
})();
