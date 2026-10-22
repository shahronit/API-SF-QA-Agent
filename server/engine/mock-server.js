'use strict';
/**
 * Local mock HTTP server. Matches method + path (and optional header) against
 * stored examples and returns the configured status/body. Loopback only.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { repo, now } = require('../db');
const { assertLoopbackListen } = require('../lib/http-transport');

const running = new Map(); // id -> { server, port, host }

function matchExample(examples, req) {
  const method = String(req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', 'http://mock.local');
  const path = url.pathname;
  const list = examples || [];
  return list.find((ex) => {
    if (ex.enabled === false) return false;
    if (String(ex.method || 'GET').toUpperCase() !== method) return false;
    const p = String(ex.path || '/');
    if (p === path) return true;
    if (p.includes('*') && new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(path)) return true;
    if (p.startsWith(':') || p.includes('/:')) {
      const rx = new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '[^/]+') + '$');
      return rx.test(path);
    }
    return false;
  }) || list.find((ex) => String(ex.method || 'GET').toUpperCase() === method && (ex.path === '*' || ex.path === '/*'));
}

function handle(examples, req, res) {
  const started = Date.now();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const ex = matchExample(examples, req);
    if (!ex) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'X-Mock-Hit': 'none' });
      res.end(JSON.stringify({ error: 'No mock example matches this method and path.', method: req.method, path: req.url }));
      return;
    }
    const headers = { 'X-Mock-Example': ex.name || ex.path || 'example', 'X-Mock-Ms': String(Date.now() - started), ...(ex.headers || {}) };
    const status = Number(ex.status || 200);
    let body = ex.body;
    if (body && typeof body === 'object') {
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    } else if (body == null) body = '';
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'text/plain; charset=utf-8';
    res.writeHead(status, headers);
    res.end(String(body));
  });
}

function start(row) {
  if (running.has(row.id)) return info(row);
  assertLoopbackListen('127.0.0.1');
  const examples = row.examples || [];
  const server = http.createServer((req, res) => handle(examples, req, res));
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(row.port || 0, '127.0.0.1', () => {
      const addr = server.address();
      const rec = { server, port: addr.port, host: '127.0.0.1' };
      running.set(row.id, rec);
      repo.update('mock_servers', row.id, { status: 'running', port: addr.port, updatedAt: now() });
      resolve(info({ ...row, port: addr.port, status: 'running' }));
    });
  });
}

function stop(id) {
  const rec = running.get(id);
  if (rec) {
    try { rec.server.close(); } catch { /* ignore */ }
    running.delete(id);
  }
  const row = repo.get('mock_servers', id);
  if (row) repo.update('mock_servers', id, { status: 'stopped', updatedAt: now() });
  return { id, status: 'stopped' };
}

function info(row) {
  const rec = running.get(row.id);
  const port = (rec && rec.port) || row.port;
  const origin = port ? `http://127.0.0.1:${port}` : null;
  return { ...row, status: rec ? 'running' : (row.status || 'stopped'), port: port || null, origin, url: origin };
}

function list(projectId) {
  return repo.find('mock_servers', 'projectId = $p', { p: projectId }, 'ORDER BY createdAt DESC').map(info);
}

function create(projectId, body) {
  const row = {
    id: crypto.randomUUID(),
    projectId,
    name: body.name || 'Mock server',
    port: body.port ? Number(body.port) : null,
    status: 'stopped',
    collectionId: body.collectionId || null,
    examples: body.examples || [],
    createdAt: now(),
    updatedAt: now(),
  };
  repo.insert('mock_servers', row);
  return info(row);
}

function examplesFromCollection(content) {
  const out = [];
  const walk = (items, folder) => {
    for (const it of items || []) {
      if (it.item) walk(it.item, [folder, it.name].filter(Boolean).join(' / '));
      else if (it.request) {
        const r = typeof it.request === 'string' ? { method: 'GET', url: it.request } : it.request;
        let path = '';
        const u = r.url;
        if (typeof u === 'string') {
          try { path = new URL(u.replace(/^\{\{[^}]+\}\}/, 'https://x')).pathname; } catch { path = u; }
        } else if (u && u.path) path = '/' + [].concat(u.path).join('/');
        else if (u && u.raw) {
          try { path = new URL(String(u.raw).replace(/^\{\{[^}]+\}\}/, 'https://x')).pathname; } catch { path = '/'; }
        }
        const body = r.body && r.body.raw ? r.body.raw : (r.body && r.body.graphql ? r.body.graphql : '');
        out.push({
          name: [folder, it.name].filter(Boolean).join(' / '),
          method: String(r.method || 'GET').toUpperCase(),
          path: path || '/',
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: body || { mock: true, name: it.name },
          enabled: true,
        });
      }
    }
  };
  walk(content && content.item, '');
  return out;
}

function shutdownAll() {
  for (const [id, rec] of running) {
    try { rec.server.close(); } catch { /* ignore */ }
    running.delete(id);
  }
}

process.on('exit', shutdownAll);

module.exports = { start, stop, list, create, info, matchExample, examplesFromCollection, running };
