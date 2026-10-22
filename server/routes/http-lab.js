'use strict';
/** Generic HTTP lab: environments, cookies, history, console, curl, snippets,
 *  collection folders, GraphQL introspect, WebSocket, gRPC, mocks, TLS settings. */
const crypto = require('node:crypto');
const { route, HttpError, sse, raw, required } = require('../http');
const { repo, now, audit } = require('../db');
const { projectFrom } = require('./util');
const envs = require('../engine/environments');
const cookies = require('../engine/cookie-jar');
const curl = require('../engine/curl');
const lab = require('../engine/http-lab');
const ws = require('../engine/ws-sessions');
const grpc = require('../engine/grpc-unary');
const mocks = require('../engine/mock-server');
const postman = require('../engine/postman');

function wrap(fn) {
  return async (ctx) => {
    try { return await fn(ctx); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(e.status || 400, e.message, e.info || e.explanation || {});
    }
  };
}

// ── Environments ──
route('GET', '/api/lab/environments', (ctx) => {
  const p = projectFrom(ctx);
  return { items: envs.list(p.id), activeId: (envs.active(p.id) || {}).id || null };
});

route('POST', '/api/lab/environments', (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['name']);
  const row = envs.create(p.id, ctx.body);
  audit('explorer', 'environment.created', { user: ctx.user, projectId: p.id, detail: { name: row.name } });
  return row;
});

route('PUT', '/api/lab/environments/:id', (ctx) => {
  const row = repo.get('http_environments', ctx.params.id);
  if (!row) throw new HttpError(404, 'Environment not found.');
  return envs.update(row.id, ctx.body);
});

route('POST', '/api/lab/environments/:id/duplicate', (ctx) => {
  const row = envs.duplicate(ctx.params.id);
  if (!row) throw new HttpError(404, 'Environment not found.');
  return row;
});

route('POST', '/api/lab/environments/:id/activate', (ctx) => {
  const row = repo.get('http_environments', ctx.params.id);
  if (!row) throw new HttpError(404, 'Environment not found.');
  return envs.setActive(row.projectId, row.id);
});

route('DELETE', '/api/lab/environments/:id', (ctx) => {
  const r = envs.remove(ctx.params.id);
  if (!r) throw new HttpError(404, 'Environment not found.');
  return r;
});

route('POST', '/api/lab/environments/import', (ctx) => {
  const p = projectFrom(ctx);
  try { return envs.fromPostman(p.id, ctx.body.environment || ctx.body); } catch (e) {
    throw new HttpError(400, `Not a Postman environment: ${e.message}`);
  }
});

route('GET', '/api/lab/environments/:id/export', (ctx) => {
  const row = repo.get('http_environments', ctx.params.id);
  if (!row) throw new HttpError(404, 'Environment not found.');
  const p = repo.get('projects', row.projectId);
  return raw(JSON.stringify(envs.toPostman(row, p), null, 2), {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="${String(row.name).replace(/\W+/g, '-').toLowerCase()}.postman_environment.json"`,
  });
});

// ── Cookies ──
route('GET', '/api/lab/cookies', (ctx) => {
  const p = projectFrom(ctx);
  return { items: cookies.list(p.id) };
});

route('PUT', '/api/lab/cookies', (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['name', 'domain']);
  if (ctx.body.id) {
    const old = repo.get('http_cookies', ctx.body.id);
    if (old && old.projectId === p.id) {
      const domain = String(ctx.body.domain || old.domain || '').replace(/^\./, '').toLowerCase();
      const path = ctx.body.path || old.path || '/';
      const name = ctx.body.name || old.name;
      if (old.domain !== domain || old.path !== path || old.name !== name) repo.remove('http_cookies', old.id);
    }
  }
  return cookies.upsert(p.id, ctx.body, ctx.body.domain);
});

route('DELETE', '/api/lab/cookies', (ctx) => {
  const p = projectFrom(ctx);
  return cookies.clear(p.id, ctx.query.id || ctx.body.id);
});

// ── History + console ──
route('GET', '/api/lab/history', (ctx) => {
  const p = projectFrom(ctx);
  const items = repo.find('request_history', 'projectId = $p', { p: p.id }, 'ORDER BY createdAt DESC LIMIT 100');
  return { items };
});

route('GET', '/api/lab/history/:id', (ctx) => {
  const row = repo.get('request_history', ctx.params.id);
  if (!row) throw new HttpError(404, 'History item not found.');
  return row;
});

route('DELETE', '/api/lab/history', (ctx) => {
  const p = projectFrom(ctx);
  const rows = repo.find('request_history', 'projectId = $p', { p: p.id });
  for (const r of rows) repo.remove('request_history', r.id);
  return { deleted: rows.length };
});

route('GET', '/api/lab/console', (ctx) => {
  const p = projectFrom(ctx);
  return { items: repo.find('console_logs', 'projectId = $p', { p: p.id }, 'ORDER BY createdAt DESC LIMIT 200').reverse() };
});

route('DELETE', '/api/lab/console', (ctx) => {
  const p = projectFrom(ctx);
  const rows = repo.find('console_logs', 'projectId = $p', { p: p.id });
  for (const r of rows) repo.remove('console_logs', r.id);
  return { deleted: rows.length };
});

// ── cURL + snippets ──
route('POST', '/api/lab/curl', (ctx) => {
  try { return curl.parse(ctx.body.curl || ctx.body.command || ''); } catch (e) {
    throw new HttpError(400, e.message);
  }
});

route('POST', '/api/lab/snippets', (ctx) => curl.snippets(ctx.body || {}));

// ── Settings (proxy / TLS) ──
route('GET', '/api/lab/settings', (ctx) => {
  const p = projectFrom(ctx);
  const h = ((p.integrationConfig || {}).http || {});
  return {
    proxyUrl: h.proxyUrl || '',
    proxyEnabled: Boolean(h.proxyEnabled),
    sslVerify: h.sslVerify !== false,
    hasCa: Boolean(h.caCert),
    hasClientCert: Boolean(h.clientCert && h.clientKey),
  };
});

route('PUT', '/api/lab/settings', (ctx) => {
  const p = projectFrom(ctx);
  const ic = { ...(p.integrationConfig || {}) };
  ic.http = { ...(ic.http || {}) };
  const b = ctx.body || {};
  if (b.proxyUrl !== undefined) ic.http.proxyUrl = String(b.proxyUrl || '').trim();
  if (b.proxyEnabled !== undefined) ic.http.proxyEnabled = Boolean(b.proxyEnabled);
  if (b.sslVerify !== undefined) ic.http.sslVerify = Boolean(b.sslVerify);
  if (b.caCert !== undefined) ic.http.caCert = String(b.caCert || '');
  if (b.clientCert !== undefined) ic.http.clientCert = String(b.clientCert || '');
  if (b.clientKey !== undefined) ic.http.clientKey = String(b.clientKey || '');
  if (b.clientKeyPass !== undefined) ic.http.clientKeyPass = String(b.clientKeyPass || '');
  repo.update('projects', p.id, { integrationConfig: ic, updatedAt: now() });
  audit('explorer', 'http.settings', { user: ctx.user, projectId: p.id, detail: { sslVerify: ic.http.sslVerify, proxy: Boolean(ic.http.proxyEnabled) } });
  return { ok: true, sslVerify: ic.http.sslVerify !== false, proxyEnabled: Boolean(ic.http.proxyEnabled), proxyUrl: ic.http.proxyUrl || '' };
});

// ── Collection folder tree ──
function walkTree(items, folder = '') {
  return (items || []).map((it, i) => {
    if (it.item) {
      return { type: 'folder', name: it.name || 'Folder', index: i, folder, item: walkTree(it.item, [folder, it.name].filter(Boolean).join('/')) };
    }
    const r = typeof it.request === 'string' ? { method: 'GET', url: it.request } : (it.request || {});
    return { type: 'request', name: it.name || 'Request', index: i, folder, method: r.method || 'GET', url: typeof r.url === 'string' ? r.url : (r.url && r.url.raw) || '' };
  });
}

function getAt(items, path) {
  let cur = { item: items };
  const nodes = [{ parent: null, index: -1, node: cur }];
  for (const idx of path) {
    const node = (cur.item || [])[idx];
    if (!node) return null;
    nodes.push({ parent: cur, index: idx, node });
    cur = node;
  }
  return nodes[nodes.length - 1];
}

route('GET', '/api/lab/collections', (ctx) => {
  const p = projectFrom(ctx);
  return repo.find('collections', 'projectId = $p', { p: p.id }, 'ORDER BY name').map((c) => ({
    id: c.id, uid: c.uid, name: c.name, source: c.source, workspace: c.workspace,
    requestCount: postman.flattenItems((c.content && c.content.item) || []).length,
    updatedAt: c.updatedAt,
  }));
});

route('GET', '/api/lab/collections/:id/tree', (ctx) => {
  const c = repo.get('collections', ctx.params.id);
  if (!c) throw new HttpError(404, 'Collection not found.');
  return { id: c.id, name: c.name, variable: (c.content && c.content.variable) || [], tree: walkTree((c.content && c.content.item) || []) };
});

route('POST', '/api/lab/collections/:id/folder', (ctx) => {
  const c = repo.get('collections', ctx.params.id);
  if (!c) throw new HttpError(404, 'Collection not found.');
  const content = c.content || { item: [] };
  content.item = content.item || [];
  const parentPath = ctx.body.parentPath || [];
  const folder = { name: ctx.body.name || 'New folder', item: [] };
  if (!parentPath.length) content.item.push(folder);
  else {
    const hit = getAt(content.item, parentPath);
    if (!hit || !hit.node.item) throw new HttpError(400, 'Parent folder not found.');
    hit.node.item.push(folder);
  }
  repo.update('collections', c.id, { content, updatedAt: now() });
  return { ok: true, tree: walkTree(content.item) };
});

route('POST', '/api/lab/collections/:id/rename', (ctx) => {
  const c = repo.get('collections', ctx.params.id);
  if (!c) throw new HttpError(404, 'Collection not found.');
  const content = c.content || { item: [] };
  const hit = getAt(content.item, ctx.body.path || []);
  if (!hit || !hit.node) throw new HttpError(400, 'Item not found.');
  hit.node.name = ctx.body.name || hit.node.name;
  repo.update('collections', c.id, { content, updatedAt: now() });
  return { ok: true, tree: walkTree(content.item) };
});

route('POST', '/api/lab/collections/:id/delete-item', (ctx) => {
  const c = repo.get('collections', ctx.params.id);
  if (!c) throw new HttpError(404, 'Collection not found.');
  const content = c.content || { item: [] };
  const path = ctx.body.path || [];
  if (!path.length) throw new HttpError(400, 'Path is required.');
  const parentPath = path.slice(0, -1);
  const idx = path[path.length - 1];
  const list = parentPath.length ? (getAt(content.item, parentPath).node.item) : content.item;
  list.splice(idx, 1);
  repo.update('collections', c.id, { content, updatedAt: now() });
  return { ok: true, tree: walkTree(content.item) };
});

route('POST', '/api/lab/collections/:id/move', (ctx) => {
  const c = repo.get('collections', ctx.params.id);
  if (!c) throw new HttpError(404, 'Collection not found.');
  const content = c.content || { item: [] };
  const from = ctx.body.from || [];
  const toParent = ctx.body.toParent || [];
  if (!from.length) throw new HttpError(400, 'from path is required.');
  const fromParent = from.slice(0, -1);
  const fromIdx = from[from.length - 1];
  const fromList = fromParent.length ? getAt(content.item, fromParent).node.item : content.item;
  const [item] = fromList.splice(fromIdx, 1);
  const dest = toParent.length ? getAt(content.item, toParent).node : { item: content.item };
  dest.item = dest.item || [];
  const at = ctx.body.at === undefined ? dest.item.length : Number(ctx.body.at);
  dest.item.splice(at, 0, item);
  repo.update('collections', c.id, { content, updatedAt: now() });
  return { ok: true, tree: walkTree(content.item) };
});

route('GET', '/api/lab/collections/:id/request', (ctx) => {
  const c = repo.get('collections', ctx.params.id);
  if (!c) throw new HttpError(404, 'Collection not found.');
  const path = String(ctx.query.path || '').split('.').filter((x) => x !== '').map(Number);
  const hit = getAt((c.content && c.content.item) || [], path);
  if (!hit || !hit.node || !hit.node.request) throw new HttpError(404, 'Request not found.');
  const it = hit.node;
  const r = typeof it.request === 'string' ? { method: 'GET', url: it.request } : it.request;
  const url = typeof r.url === 'string' ? r.url : (r.url && r.url.raw) || '';
  const query = [];
  if (r.url && Array.isArray(r.url.query)) {
    for (const q of r.url.query) query.push({ key: q.key, value: q.value, enabled: !q.disabled });
  }
  const headers = (Array.isArray(r.header) ? r.header : []).map((h) => ({ key: h.key, value: h.value, enabled: !h.disabled }));
  const events = it.event || [];
  const pre = events.find((e) => e.listen === 'prerequest');
  const test = events.find((e) => e.listen === 'test');
  const body = r.body || {};
  return {
    name: it.name,
    method: r.method || 'GET',
    path: url,
    url,
    queryRows: query,
    headerRows: headers,
    bodyMode: body.mode === 'urlencoded' ? 'urlencoded' : body.mode === 'formdata' ? 'formdata' : body.mode === 'graphql' ? 'graphql' : body.mode === 'file' ? 'binary' : (body.mode === 'raw' && body.options && body.options.raw && /xml/i.test(body.options.raw.language) ? 'xml' : body.mode === 'raw' ? 'json' : 'none'),
    body: body.raw || '',
    form: body.urlencoded || body.formdata || [],
    graphql: body.graphql || {},
    preRequest: pre && pre.script ? [].concat(pre.script.exec || pre.script).join('\n') : '',
    tests: test && test.script ? [].concat(test.script.exec || test.script).join('\n') : '',
    auth: r.auth && r.auth.type ? r.auth.type : 'inherit',
    folder: path.join('/'),
  };
});

route('PUT', '/api/lab/collections/:id/variables', (ctx) => {
  const c = repo.get('collections', ctx.params.id);
  if (!c) throw new HttpError(404, 'Collection not found.');
  const content = c.content || { item: [] };
  content.variable = envs.normalizeValues(ctx.body.values || ctx.body.variable || []).map((v) => ({ key: v.key, value: v.value, disabled: !v.enabled }));
  repo.update('collections', c.id, { content, updatedAt: now() });
  return { ok: true, variable: content.variable };
});

// ── GraphQL ──
route('POST', '/api/lab/graphql/introspect', wrap(async (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['url']);
  return lab.introspect(p, ctx.body);
}));

// ── WebSocket ──
route('POST', '/api/lab/ws/connect', (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['url']);
  try { return ws.connect({ url: ctx.body.url, headers: ctx.body.headers || {}, protocols: ctx.body.protocols, projectId: p.id }); } catch (e) {
    throw new HttpError(e.status || 400, e.message);
  }
});

route('GET', '/api/lab/ws/:id', (ctx) => {
  const snap = ws.snapshot(ctx.params.id);
  if (!snap) throw new HttpError(404, 'WebSocket session not found.');
  return snap;
});

route('GET', '/api/lab/ws/:id/events', (ctx) => {
  const rec = ws.get(ctx.params.id);
  if (!rec) throw new HttpError(404, 'WebSocket session not found.');
  const push = sse(ctx.res);
  const onEvent = (e) => push('message', e);
  rec.emitter.on('event', onEvent);
  ctx.res.on('close', () => rec.emitter.off('event', onEvent));
  push('hello', { id: rec.id, status: rec.status, url: rec.url });
});

route('POST', '/api/lab/ws/:id/send', (ctx) => {
  try { return ws.send(ctx.params.id, ctx.body || {}); } catch (e) {
    throw new HttpError(e.status || 400, e.message);
  }
});

route('POST', '/api/lab/ws/:id/close', (ctx) => ws.close(ctx.params.id, ctx.body && ctx.body.code, ctx.body && ctx.body.reason));

// ── gRPC ──
route('POST', '/api/lab/grpc/parse', (ctx) => {
  const proto = grpc.parseProto(ctx.body.proto || ctx.body.text || '');
  return { package: proto.package, services: proto.services, messages: Object.fromEntries(Object.entries(proto.messages).map(([k, v]) => [k, v.fields])) };
});

route('POST', '/api/lab/grpc/call', wrap(async (ctx) => {
  required(ctx.body, ['target', 'service', 'method']);
  const p = projectFrom(ctx);
  const settings = lab.httpSettings(p);
  const result = await grpc.callUnary({
    target: ctx.body.target,
    packageName: ctx.body.package,
    service: ctx.body.service,
    method: ctx.body.method,
    payload: ctx.body.payload || ctx.body.message || {},
    proto: ctx.body.proto,
    metadata: ctx.body.metadata || {},
    settings,
    timeoutMs: ctx.body.timeoutMs,
  });
  audit('explorer', 'grpc.called', { user: ctx.user, projectId: p.id, detail: { service: ctx.body.service, method: ctx.body.method, status: result.grpcStatus } });
  return result;
}));

// ── OAuth helper ──
route('POST', '/api/lab/oauth/authorize-url', (ctx) => {
  const { authorizeUrl } = require('../engine/auth-apply');
  try { return { url: authorizeUrl(ctx.body || {}, ctx.body.variables || {}, new Set()) }; } catch (e) {
    throw new HttpError(400, e.message);
  }
});

// ── Mocks ──
route('GET', '/api/lab/mocks', (ctx) => {
  const p = projectFrom(ctx);
  return { items: mocks.list(p.id) };
});

route('POST', '/api/lab/mocks', (ctx) => {
  const p = projectFrom(ctx);
  let examples = ctx.body.examples || [];
  if (ctx.body.collectionId) {
    const c = repo.get('collections', ctx.body.collectionId);
    if (c) examples = examples.length ? examples : mocks.examplesFromCollection(c.content);
  }
  const row = mocks.create(p.id, { ...ctx.body, examples });
  audit('explorer', 'mock.created', { user: ctx.user, projectId: p.id, detail: { name: row.name } });
  return row;
});

route('PUT', '/api/lab/mocks/:id', (ctx) => {
  const row = repo.get('mock_servers', ctx.params.id);
  if (!row) throw new HttpError(404, 'Mock server not found.');
  const patch = {};
  if (ctx.body.name !== undefined) patch.name = ctx.body.name;
  if (ctx.body.examples !== undefined) patch.examples = ctx.body.examples;
  if (ctx.body.port !== undefined) patch.port = ctx.body.port;
  patch.updatedAt = now();
  repo.update('mock_servers', row.id, patch);
  if (mocks.running.has(row.id)) { mocks.stop(row.id); }
  return mocks.info(repo.get('mock_servers', row.id));
});

route('POST', '/api/lab/mocks/:id/start', wrap(async (ctx) => {
  const row = repo.get('mock_servers', ctx.params.id);
  if (!row) throw new HttpError(404, 'Mock server not found.');
  return mocks.start(row);
}));

route('POST', '/api/lab/mocks/:id/stop', (ctx) => {
  const row = repo.get('mock_servers', ctx.params.id);
  if (!row) throw new HttpError(404, 'Mock server not found.');
  return mocks.stop(row.id);
});

route('DELETE', '/api/lab/mocks/:id', (ctx) => {
  const row = repo.get('mock_servers', ctx.params.id);
  if (!row) throw new HttpError(404, 'Mock server not found.');
  mocks.stop(row.id);
  repo.remove('mock_servers', row.id);
  return { deleted: true };
});

module.exports = { walkTree };
