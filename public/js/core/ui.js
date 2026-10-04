/* UI kit: safe templating, formatting, overlays, toasts, tables and states. */
(() => {
  const QA = window.QA;
  const icon = QA.icon;

  // ── Safe HTML templating ──
  class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const raw = (s) => new Safe(String(s ?? ''));
  function val(v) {
    if (v === null || v === undefined || v === false) return '';
    if (v instanceof Safe) return v.s;
    if (Array.isArray(v)) return v.map(val).join('');
    return esc(v);
  }
  /** Tagged template: interpolated values are escaped unless wrapped with raw()/h``. */
  function h(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) out += val(values[i]) + strings[i + 1];
    return new Safe(out);
  }
  const ic = (name, cls) => raw(icon(name, cls));

  // ── Formatting ──
  const fmt = {
    num: (n) => (n === null || n === undefined || Number.isNaN(n) ? '–' : Number(n).toLocaleString()),
    pct: (n) => (n === null || n === undefined ? '–' : `${Number(n).toFixed(Number(n) % 1 ? 1 : 0)}%`),
    ms: (n) => (n === null || n === undefined ? '–' : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`),
    bytes: (n) => (n === null || n === undefined ? '–' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`),
    date: (s) => (s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–'),
    day: (s) => (s ? new Date(s.length === 10 ? s + 'T12:00:00Z' : s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '–'),
    ago(s) {
      if (!s) return '–';
      const d = (Date.now() - new Date(s).getTime()) / 1000;
      if (d < 60) return 'just now';
      if (d < 3600) return `${Math.floor(d / 60)} min ago`;
      if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
      if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
      return fmt.day(s);
    },
    duration(a, b) {
      if (!a) return '–';
      const s = Math.max(0, ((b ? new Date(b) : new Date()) - new Date(a)) / 1000);
      return s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
    },
    shortPath(p) { return String(p || '').replace(/^\/services\/data\/v[\d.{}A-Za-z]+/, '').split('?')[0] || p; },
  };

  // ── Badges ──
  const STATUS_LABEL = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', skipped: 'Skipped', running: 'Running', completed: 'Completed', stopped: 'Stopped', error: 'Error', ready: 'Ready', draft: 'Draft', disabled: 'Disabled', active: 'Active', archived: 'Archived', PASS: 'Pass', FAIL: 'Fail', BLOCKED: 'Blocked', ERROR: 'Error', proposed: 'Proposed', approved: 'Approved', rejected: 'Rejected', demo: 'Demo', configured: 'Configured', unavailable: 'Unavailable' };
  const badge = (status, label) => (status ? h`<span class="badge ${String(status).replace(/[^A-Za-z0-9_-]/g, '')}">${label || STATUS_LABEL[status] || status}</span>` : h`<span class="faint">–</span>`);
  const prov = (l) => (l ? h`<span class="prov ${l}" title="${l === 'VERIFIED' ? 'Confirmed against live Salesforce metadata' : l === 'ASSUMED' ? 'Inferred (demo metadata, naming or heuristics) — not a verified org fact' : 'Suggested coverage that needs confirmation or configuration'}">${l}</span>` : '');
  const pri = (p) => (p ? h`<span class="pri ${p}" title="${{ P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' }[p] || ''}">${p}</span>` : '');
  const method = (m) => h`<span class="method ${m}">${m}</span>`;

  // ── Toasts ──
  function toast(message, kind = 'info', title) {
    const root = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = String(h`<div>${title ? h`<b>${title}</b>` : ''}${message}</div><button class="x" aria-label="Dismiss">×</button>`);
    el.querySelector('.x').onclick = () => el.remove();
    root.appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4500);
    if (QA.state && QA.state.notify && kind !== 'info') QA.state.notify({ title: title || (kind === 'ok' ? 'Done' : kind === 'error' ? 'Error' : 'Notice'), message, kind });
  }
  function toastError(err, title = 'Request failed') {
    const e = err && err.info ? err.info : {};
    toast(h`${err.message}${e.action ? h`<div class="muted small mt-s">${e.action}</div>` : ''}`, 'error', title);
  }

  // ── Overlays ──
  const overlayRoot = () => document.getElementById('overlay-root');
  let lastFocus = null;
  function trapKeys(el, close) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        const f = [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
  }

  /**
   * Open a modal. `body` can be Safe HTML; `onMount(el, close)` binds events.
   * Returns { el, close }.
   */
  function modal({ title, subtitle, body, foot, size = '', danger = false, onMount, onClose }) {
    lastFocus = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = String(h`<div class="modal ${size} ${danger ? 'danger' : ''}" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="modal-head"><div style="flex:1;min-width:0"><h2 id="m-title">${title}</h2>${subtitle ? h`<p>${subtitle}</p>` : ''}</div><button class="icon-btn" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="modal-body">${body || ''}</div>${foot ? h`<div class="modal-foot">${foot}</div>` : ''}</div>`);
    const close = () => { scrim.remove(); if (onClose) onClose(); if (lastFocus && lastFocus.focus) lastFocus.focus(); };
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    scrim.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    trapKeys(scrim, close);
    overlayRoot().appendChild(scrim);
    const el = scrim.querySelector('.modal');
    if (onMount) onMount(el, close);
    const first = el.querySelector('[autofocus]') || el.querySelector('.modal-body input, .modal-body select, .modal-body textarea') || el.querySelector('.modal-foot .btn.primary, .modal-foot .btn.danger');
    setTimeout(() => (first || el.querySelector('[data-close]')).focus(), 20);
    return { el, close };
  }

  /** Promise-based confirmation dialog. Optional `typeToConfirm` requires typing a phrase. */
  function confirm({ title, message, confirmLabel = 'Confirm', danger = false, typeToConfirm, details }) {
    return new Promise((resolve) => {
      let done = false;
      const m = modal({
        title, danger,
        body: h`<div>${message}</div>${details ? h`<div class="mt">${details}</div>` : ''}${typeToConfirm ? h`<label class="field mt"><span>Type <code>${typeToConfirm}</code> to continue</span><input class="input" data-type autocomplete="off"></label>` : ''}`,
        foot: h`<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok ${typeToConfirm ? 'disabled' : ''}>${confirmLabel}</button>`,
        onMount(el, close) {
          const ok = el.querySelector('[data-ok]');
          const inp = el.querySelector('[data-type]');
          if (inp) inp.addEventListener('input', () => { ok.disabled = inp.value.trim() !== typeToConfirm; });
          ok.addEventListener('click', () => { done = true; close(); resolve(true); });
        },
        onClose() { if (!done) resolve(false); },
      });
      return m;
    });
  }

  function drawer({ title, subtitle, body, foot, onMount, onClose, width }) {
    lastFocus = document.activeElement;
    const wrap = document.createElement('div');
    wrap.innerHTML = String(h`<div class="drawer-scrim"></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="d-title" ${width ? raw(`style="width:min(${width}px,96vw)"`) : ''}>
      <div class="drawer-head"><div class="titles"><h2 id="d-title">${title}</h2>${subtitle ? h`<div class="muted small mt-s">${subtitle}</div>` : ''}</div><button class="icon-btn" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="drawer-body">${body || ''}</div>${foot ? h`<div class="drawer-foot">${foot}</div>` : ''}</aside>`);
    const close = () => { wrap.remove(); if (onClose) onClose(); if (lastFocus && lastFocus.focus) lastFocus.focus(); };
    wrap.querySelector('.drawer-scrim').addEventListener('click', close);
    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    trapKeys(wrap, close);
    overlayRoot().appendChild(wrap);
    const el = wrap.querySelector('.drawer');
    if (onMount) onMount(el, close);
    setTimeout(() => el.querySelector('[data-close]').focus(), 20);
    return { el, close, setBody(html) { el.querySelector('.drawer-body').innerHTML = String(html); }, setFoot(html) { const f = el.querySelector('.drawer-foot'); if (f) f.innerHTML = String(html); } };
  }

  // ── Events ──
  /** Delegated event binding: on(root, 'click', '[data-action=x]', (e, el) => …). */
  function on(root, type, selector, fn) {
    root.addEventListener(type, (e) => {
      const el = e.target.closest(selector);
      if (el && root.contains(el)) fn(e, el);
    });
  }
  function debounce(fn, ms = 250) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  async function withBusy(btn, fn) {
    if (!btn) return fn();
    btn.classList.add('loading'); btn.disabled = true;
    try { return await fn(); } finally { btn.classList.remove('loading'); btn.disabled = false; }
  }

  // ── States ──
  const loading = (rows = 6) => h`<div class="card-body">${Array.from({ length: rows }, (_, i) => h`<div class="skeleton sk-line" style="width:${90 - (i % 3) * 18}%"></div>`)}</div>`;
  const empty = ({ icon: i = 'inbox', title, text, action }) => h`<div class="empty">${ic(i)}<h3>${title}</h3>${text ? h`<p>${text}</p>` : ''}${action || ''}</div>`;
  /** Actionable error state built from an ApiError: error, cause, evidence, action. */
  function errorBox(err, { compact = false } = {}) {
    const i = (err && err.info) || {};
    return h`<div class="callout error" role="alert">${ic('alert')}<div><b>${err.message || i.title || 'The request failed'}</b>
      ${!compact ? h`<dl>${i.cause ? h`<dt>Possible cause</dt><dd>${i.cause}</dd>` : ''}${i.evidence && i.evidence.length ? h`<dt>Evidence</dt><dd>${[].concat(i.evidence).join(' · ')}</dd>` : ''}${i.action ? h`<dt>Recommended action</dt><dd>${i.action}</dd>` : ''}</dl>` : i.action ? h`<div class="small mt-s">${i.action}</div>` : ''}</div></div>`;
  }

  // ── JSON viewer with syntax highlight ──
  function json(v, { max = 200000 } = {}) {
    let s;
    if (typeof v === 'string') {
      try { s = JSON.stringify(JSON.parse(v), null, 2); } catch { s = v; }
    } else s = JSON.stringify(v, null, 2);
    if (s === undefined) s = '';
    if (s.length > max) s = s.slice(0, max) + '\n… (truncated for display)';
    const out = esc(s).replace(/(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (m, str, colon, bool) => {
      if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
      if (bool) return `<span class="b">${m}</span>`;
      if (m === 'null') return `<span class="z">${m}</span>`;
      return `<span class="n">${m}</span>`;
    });
    return raw(`<pre class="code">${out}</pre>`);
  }

  /**
   * Render a data table.
   * columns: [{ key, label, sortable, render(row) → Safe|string, cls, width }]
   */
  function table({ columns, rows, sort, dir, selectable, selected = new Set(), rowAttrs, emptyState }) {
    if (!rows.length && emptyState) return emptyState;
    return h`<div class="table-wrap"><table class="t"><thead><tr>
      ${selectable ? h`<th class="check"><input type="checkbox" data-select-all aria-label="Select all" ${rows.length && rows.every((r) => selected.has(r.id)) ? 'checked' : ''}></th>` : ''}
      ${columns.map((c) => h`<th class="${c.sortable ? 'sortable' : ''} ${c.cls || ''}" ${c.sortable ? raw(`data-sort="${esc(c.sortKey || c.key)}" tabindex="0" aria-sort="${sort === (c.sortKey || c.key) ? (dir === 'ASC' ? 'ascending' : 'descending') : 'none'}"`) : ''} ${c.width ? raw(`style="width:${c.width}"`) : ''}>${c.label}${c.sortable && sort === (c.sortKey || c.key) ? h`<span class="arrow">${dir === 'ASC' ? '▲' : '▼'}</span>` : ''}</th>`)}
    </tr></thead><tbody>
      ${rows.map((r) => h`<tr ${rowAttrs ? raw(rowAttrs(r)) : ''} class="${selected.has(r.id) ? 'selected' : ''} ${rowAttrs ? 'clickable' : ''}">
        ${selectable ? h`<td class="check"><input type="checkbox" data-select="${r.id}" aria-label="Select ${r.id}" ${selected.has(r.id) ? 'checked' : ''}></td>` : ''}
        ${columns.map((c) => h`<td class="${c.cls || ''}">${c.render ? c.render(r) : r[c.key] ?? ''}</td>`)}
      </tr>`)}
    </tbody></table></div>`;
  }

  function pager(page) {
    if (!page || page.total === undefined) return '';
    const from = page.total ? (page.page - 1) * page.pageSize + 1 : 0;
    const to = Math.min(page.total, page.page * page.pageSize);
    return h`<div class="pager"><span class="num">${fmt.num(from)}–${fmt.num(to)} of ${fmt.num(page.total)}</span>
      <div class="row"><select class="select" data-page-size aria-label="Rows per page" style="height:28px">${[10, 25, 50, 100].map((n) => h`<option value="${n}" ${n === page.pageSize ? 'selected' : ''}>${n} / page</option>`)}</select>
      <button class="btn sm" data-page="${page.page - 1}" ${page.page <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="num small">Page ${page.page} of ${page.pages}</span>
      <button class="btn sm" data-page="${page.page + 1}" ${page.page >= page.pages ? 'disabled' : ''}>Next</button></div></div>`;
  }

  function copyText(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'ok'), () => toast('Clipboard is not available in this browser context.', 'warn'));
  }

  QA.ui = { h, raw, esc, ic, fmt, badge, prov, pri, method, toast, toastError, modal, confirm, drawer, on, debounce, withBusy, loading, empty, errorBox, json, table, pager, copyText, Safe };
})();
