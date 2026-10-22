/* API client: JSON fetch with explanatory errors, SSE streams, downloads, GET cache. */
(() => {
  const QA = window.QA;

  class ApiError extends Error {
    constructor(status, info) {
      super((info && (info.error || info.title)) || `HTTP ${status}`);
      this.status = status;
      this.info = info || {};
    }
  }

  const cache = new Map(); // short-lived GET cache for lookups
  const SNAPSHOT = window.__QA_SNAPSHOT__ || null; // offline snapshot mode (docs/screens)

  async function request(method, url, body, { cacheMs = 0, signal } = {}) {
    if (SNAPSHOT) return snapshotResponse(method, url);
    const key = method === 'GET' && cacheMs ? url : null;
    if (key) {
      const c = cache.get(key);
      if (c && c.until > Date.now()) return c.data;
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ApiError(0, { error: 'Cannot reach the QA platform server.', cause: 'The server is not running or the network connection dropped.', action: 'Start it with `npm start` and reload the page.' });
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) throw new ApiError(res.status, typeof data === 'object' ? data : { error: String(data).slice(0, 300) });
    if (key) cache.set(key, { until: Date.now() + cacheMs, data });
    if (method !== 'GET') cache.clear();
    return data;
  }

  function snapshotResponse(method, url) {
    const u = new URL(url, 'http://x');
    const k = u.pathname + (u.search || '');
    const data = SNAPSHOT[k] ?? SNAPSHOT[u.pathname];
    if (method !== 'GET') return Promise.reject(new ApiError(405, { error: 'This is a read-only snapshot of the platform.', action: 'Run `npm start` to use the live application.' }));
    if (data === undefined) return Promise.reject(new ApiError(404, { error: `Not captured in snapshot: ${k}` }));
    return Promise.resolve(JSON.parse(JSON.stringify(data)));
  }

  const qs = (params) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      p.set(k, Array.isArray(v) ? v.join(',') : v);
    }
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  /** Subscribe to a server-sent-event stream. Returns an unsubscribe function. */
  function stream(url, handlers) {
    if (SNAPSHOT || typeof EventSource === 'undefined') return () => {};
    const es = new EventSource(url);
    for (const [event, fn] of Object.entries(handlers)) {
      if (event === 'error') es.onerror = fn;
      else es.addEventListener(event, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
    }
    return () => es.close();
  }

  /** Trigger a file download from an API URL (keeps auth/cookies, shows errors). */
  async function download(url, fallbackName) {
    if (SNAPSHOT) { QA.ui.toast('Downloads are disabled in the read-only snapshot.', 'warn'); return; }
    const res = await fetch(url);
    if (!res.ok) {
      const info = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new ApiError(res.status, info);
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName || 'download';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  QA.api = {
    ApiError, qs, stream, download, snapshot: Boolean(SNAPSHOT),
    get: (url, opts) => request('GET', url, undefined, opts),
    post: (url, body) => request('POST', url, body || {}),
    put: (url, body) => request('PUT', url, body || {}),
    patch: (url, body) => request('PATCH', url, body || {}),
    del: (url) => request('DELETE', url),
    clearCache: () => cache.clear(),
  };
})();
