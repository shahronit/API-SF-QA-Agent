'use strict';
// API integration test: boots the real server on a temp database with demo data
// and exercises the safety-critical contracts end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 4400 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `qa-api-test-${process.pid}.db`);
let server;

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, text };
}

test.before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, QA_DB_FILE: DB, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  // First boot triggers a full demo-data seed (multiple projects, generated
  // suites and executions) — give it as much headroom as the other scripts
  // that wait on the same cold start (ui-smoke.js, build-snapshot.js).
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not start:\n' + log);
});

test.after(() => {
  if (server) server.kill();
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});

test('health and meta respond', async () => {
  const h = await api('GET', '/api/health');
  assert.equal(h.status, 200);
  const m = await api('GET', '/api/meta');
  assert.ok(m.body.environments.includes('Production'));
  assert.ok(m.body.modes.length >= 8);
});

test('state-changing requests must be JSON (CSRF guard)', async () => {
  const r = await fetch(BASE + '/api/stories', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.ok(r.status === 415 || r.status === 400);
});

test('projects never expose secrets and reject secret-looking fields', async () => {
  const list = await api('GET', '/api/projects');
  assert.equal(list.status, 200);
  assert.ok(!/client_?secret"\s*:\s*"[^"*]/i.test(list.text));
  const bad = await api('POST', '/api/projects', { name: 'Bad', environment: 'QA', mode: 'live', clientSecret: 'abc' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error && bad.body.action, 'errors carry an action');
});

test('unconfigured live project reports the exact unavailable message', async () => {
  const list = await api('GET', '/api/projects');
  const items = list.body.items || list.body;
  const unconfigured = items.find((p) => p.mode === 'live' && JSON.stringify(p).includes('unavailable'));
  assert.ok(unconfigured, 'seed includes an unconfigured live project');
  assert.ok(JSON.stringify(unconfigured).includes('Salesforce MCP is unavailable. API test design and automation generation are available, but live Salesforce validation is disabled.'));
});

test('production writes are blocked until confirmed; DELETE needs a second confirmation', async () => {
  const items = (await api('GET', '/api/projects')).body;
  const prod = (items.items || items).find((p) => p.environment === 'Production');
  const write = await api('POST', '/api/explorer/execute', { projectId: prod.id, method: 'POST', path: '/services/data/v62.0/sobjects/Account', body: { Name: 'X' } });
  assert.equal(write.status, 409);
  assert.equal(write.body.requires, 'confirmProductionWrites');
  assert.match(write.body.code, /^PRODUCTION_/);
  assert.match(JSON.stringify(write.body), /This operation will modify Salesforce production data\./);
  const del = await api('POST', '/api/explorer/execute', { projectId: prod.id, method: 'DELETE', path: '/services/data/v62.0/sobjects/Account/001000000000001AAA', confirmProductionWrites: true });
  assert.equal(del.status, 409);
  assert.equal(del.body.requires, 'confirmDelete');
  const read = await api('POST', '/api/explorer/execute', { projectId: prod.id, method: 'GET', path: '/services/data/v62.0/limits' });
  assert.notEqual(read.status, 409);
});

test('Jira defects are never created without explicit confirmation', async () => {
  const runs = (await api('GET', '/api/runs?projectId=PRJ-001&pageSize=50')).body.items;
  let failed;
  for (const run of runs) {
    const res = (await api('GET', `/api/runs/${run.id}/results?status=failed&pageSize=5`)).body.items;
    if (res.length) { failed = res[0]; break; }
  }
  assert.ok(failed, 'seeded history contains a failed result');
  const preview = await api('POST', '/api/defects/preview', { resultId: failed.id });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.draft && preview.body.draft.summary);
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{12,}/.test(preview.text), 'preview is masked');
  const before = (await api('GET', '/api/defects?pageSize=200')).body.total;
  const unconfirmed = await api('POST', '/api/defects', { resultId: failed.id, ...preview.body.draft });
  assert.ok(unconfirmed.status >= 400 && unconfirmed.status < 500);
  const after = (await api('GET', '/api/defects?pageSize=200')).body.total;
  assert.equal(after, before, 'no defect was created');
});

test('generation produces a proposal that is not saved until approved', async () => {
  const stories = (await api('GET', '/api/stories?projectId=PRJ-001')).body.items;
  const before = (await api('GET', '/api/testcases?projectId=PRJ-001&pageSize=1')).body.total;
  const gen = await api('POST', '/api/generate', { projectId: 'PRJ-001', storyKey: stories[0].key });
  assert.equal(gen.status, 200, gen.text.slice(0, 300));
  const proposal = gen.body.proposal || gen.body;
  assert.ok(proposal.id && proposal.scenarios.length);
  const labels = JSON.stringify(proposal);
  assert.ok(/ASSUMED/.test(labels), 'demo metadata is labelled ASSUMED, never VERIFIED');
  const mid = (await api('GET', '/api/testcases?projectId=PRJ-001&pageSize=1')).body.total;
  assert.equal(mid, before);
});
