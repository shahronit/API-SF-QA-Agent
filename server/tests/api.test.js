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

function seedTempDb() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'seed.js'), '--reset'], {
      env: { ...process.env, QA_DB_FILE: DB },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('seed failed:\n' + log))));
  });
}

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
  await seedTempDb();
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, QA_DB_FILE: DB, PORT: String(PORT), HOST: '127.0.0.1', SEED_DEMO: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
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

test('lists every non-archived project from the fixture DB', async () => {
  const list = await api('GET', '/api/projects');
  assert.equal(list.status, 200);
  const items = list.body.items || list.body;
  assert.ok(Array.isArray(items) && items.length >= 6, 'fixture DB includes all sample projects');
  assert.ok(items.every((p) => p.status !== 'archived'));
  assert.ok(items.some((p) => p.mode === 'demo') && items.some((p) => p.mode === 'live'));
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
  assert.ok(proposal.analysis && proposal.analysis.generator, 'records generator used');
  assert.ok(proposal.analysis.traceability, 'persists traceability metrics');
  const mid = (await api('GET', '/api/testcases?projectId=PRJ-001&pageSize=1')).body.total;
  assert.equal(mid, before);
});

test('global search works with and without a project filter', async () => {
  const all = await api('GET', '/api/search?q=acme');
  assert.equal(all.status, 200, all.text.slice(0, 200));
  const scoped = await api('GET', '/api/search?q=acme&projectId=PRJ-001');
  assert.equal(scoped.status, 200, scoped.text.slice(0, 200));
});

test('test-data generation covers every plan category without persisting secrets', async () => {
  for (const category of ['Positive', 'Negative', 'Boundary', 'Security', 'Integration', 'Bulk', 'Regression', 'Performance']) {
    const r = await api('POST', '/api/testdata/generate', { projectId: 'PRJ-001', object: 'Contact', category, count: 2 });
    assert.equal(r.status, 200, `${category}: ${r.text.slice(0, 200)}`);
    assert.equal(r.body.items[0].category, category);
    if (category === 'Bulk') assert.ok(r.body.items[0].payload.records && Array.isArray(r.body.items[0].payload.columns));
    if (category === 'Security') assert.match(r.body.items[0].notes, /verbatim|rejected/);
  }
});

test('run reports expose classification, impact, retest, risks and automation assets', async () => {
  const runs = (await api('GET', '/api/runs?projectId=PRJ-001&pageSize=50')).body.items;
  let report;
  for (const run of runs) {
    const r = await api('GET', `/api/reports/${run.id}`);
    if (r.status === 200 && r.body.failed && r.body.failed.length) { report = r.body; break; }
  }
  assert.ok(report, 'a seeded run with failures exists');
  assert.ok(Array.isArray(report.risks) && report.risks.length, 'risks are reported');
  assert.ok(report.automationAssets.postmanCollection.url && report.automationAssets.newmanCommand && report.automationAssets.tests.total > 0, 'automation assets are listed');
  const f = report.failed[0];
  assert.ok(f.classification && f.impact && f.retest, 'every failure carries classification, impact and retest');
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{12,}/.test(JSON.stringify(report)), 'report is masked');
  for (const format of ['json', 'csv', 'html', 'xlsx', 'pdf']) {
    const res = await fetch(`${BASE}/api/reports/${report.run.id}?format=${format}`);
    assert.equal(res.status, 200, `${format} export`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 100, `${format} export is not empty`);
    if (format === 'pdf') assert.equal(buf.subarray(0, 4).toString(), '%PDF');
    if (format === 'xlsx') assert.equal(buf.subarray(0, 2).toString(), 'PK');
    if (format === 'html') assert.match(buf.toString(), /Risks/);
  }
});

test('connections expose Salesforce MCP, Jira and Commerce Cloud and can save non-secret config', async () => {
  const c = await api('GET', '/api/projects/PRJ-001/connection');
  assert.equal(c.status, 200);
  assert.ok(c.body.credentials.salesforce);
  assert.ok(c.body.credentials.jira);
  assert.ok(c.body.credentials.commerce);
  assert.ok(c.body.credentials.postman);
  assert.equal(c.body.view.commerce.status, 'off');
  const saved = await api('PUT', '/api/projects/PRJ-001/connection', {
    commerce: { enabled: true, siteId: 'RefArch', orgId: 'f_ecom_zzte_001', shortCode: 'demo', host: 'demo-commerce.example.com' },
  });
  assert.equal(saved.status, 200, saved.text.slice(0, 200));
  assert.equal(saved.body.connection.commerce.status, 'demo');
  const test = await api('POST', '/api/projects/PRJ-001/connection/test');
  assert.equal(test.status, 200);
  assert.equal(test.body.commerce.ok, true);
  assert.ok(test.body.postman);
  await api('PUT', '/api/projects/PRJ-001/connection', { commerce: { enabled: false } });
});

test('workflow state persists and Postman discovery reuses collections', async () => {
  const wf = await api('GET', '/api/projects/PRJ-001/workflow');
  assert.equal(wf.status, 200, wf.text.slice(0, 300));
  assert.equal(wf.body.steps.length, 4);
  assert.ok(wf.body.steps.every((s) => s.status));
  const vis = await api('PUT', '/api/projects/PRJ-001/workflow', { currentStep: 'postman' });
  assert.equal(vis.body.currentStep, 'connect');
  const again = await api('GET', '/api/projects/PRJ-001/workflow');
  assert.equal(again.body.currentStep, 'connect');
  const found = await api('GET', '/api/projects/PRJ-001/postman/collections');
  assert.equal(found.status, 200, found.text.slice(0, 300));
  assert.ok(Array.isArray(found.body.items));
  const analyzed = await api('POST', '/api/projects/PRJ-001/postman/analyze', {});
  assert.equal(analyzed.status, 200, analyzed.text.slice(0, 400));
  assert.ok(['reuse', 'update', 'create'].includes(analyzed.body.action));
  if (analyzed.body.diff) {
    assert.ok(analyzed.body.diff.summary);
    assert.ok(!JSON.stringify(analyzed.body).includes('Account 2'));
  }
});

test('import and attach reuse an existing Postman collection on the project', async () => {
  const col = {
    info: { name: 'Existing Shop API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Health', request: { method: 'GET', url: 'https://api.shop.example/health', header: [] } }],
  };
  const attached = await api('POST', '/api/projects/PRJ-001/postman/attach', { collection: col, importTests: true });
  assert.equal(attached.status, 200, attached.text.slice(0, 400));
  assert.equal(attached.body.reuseExisting, true);
  assert.ok(attached.body.imported >= 1);
  const id = attached.body.collectionId;
  const saved = await api('PUT', '/api/projects/PRJ-001/connection', { postman: { workspace: 'QA workspace', environment: 'UAT' } });
  assert.equal(saved.status, 200, saved.text.slice(0, 300));
  const conn = await api('GET', '/api/projects/PRJ-001/connection');
  assert.equal(conn.body.postman.collectionId, id);
  assert.equal(conn.body.postman.reuseExisting, true);
  const listed = await api('GET', '/api/projects/PRJ-001/postman/collections');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.linkedCollectionId, id);
  const imp = await api('POST', '/api/postman/import?projectId=PRJ-001', { collection: col });
  assert.equal(imp.status, 200, imp.text.slice(0, 400));
  assert.equal(imp.body.reuseExisting, true);
  assert.equal(imp.body.imported, 0);
});

test('custom endpoints can be saved, discovered, imported, linked to a story, and skip Experience/SFCC paths', async () => {
  const list = await api('GET', '/api/projects/PRJ-001/endpoints');
  assert.equal(list.status, 200, list.text.slice(0, 200));
  assert.ok(list.body.items.some((e) => /apexrest\/v1\/invoices/.test(e.path)));
  const skipped = await api('POST', '/api/projects/PRJ-001/endpoints', { method: 'GET', path: '/services/data/v62.0/connect/communities' });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.added, 0);
  const created = await api('POST', '/api/projects/PRJ-001/endpoints', {
    endpoints: [{ name: 'Widget API', path: '/services/apexrest/v1/widgets', method: 'POST', object: 'Account', keywords: ['widget-qa'], idPath: '$.id', successPath: '$.ok', successValue: true, legacyContract: false, samplePayload: { name: 'W' } }],
  });
  assert.equal(created.status, 200, created.text.slice(0, 300));
  assert.ok(created.body.added >= 1);
  const widget = created.body.items.find((e) => e.path === '/services/apexrest/v1/widgets');
  assert.ok(widget && widget.id.startsWith('EP-'));
  const openapi = await api('POST', '/api/projects/PRJ-001/endpoints/from-openapi', {
    spec: { openapi: '3.0.3', info: { title: 'X', version: '1' }, paths: { '/services/apexrest/v1/from-oa': { post: { responses: { '200': { description: 'ok' } } } }, '/sobjects/Account': { post: { responses: { '201': { description: 'no' } } } } } },
  });
  assert.equal(openapi.status, 200, openapi.text.slice(0, 300));
  assert.ok(openapi.body.items.some((e) => e.path === '/services/apexrest/v1/from-oa'));
  assert.ok(!openapi.body.items.some((e) => /sobjects\/Account/.test(e.path)));
  const disc = await api('POST', '/api/projects/PRJ-001/endpoints/discover', { apply: true });
  assert.equal(disc.status, 200, disc.text.slice(0, 300));
  assert.ok(disc.body.found >= 1);
  const stories = (await api('GET', '/api/stories?projectId=PRJ-001')).body.items;
  const story = stories.find((s) => s.key === 'DEMO-103') || stories[0];
  const linked = await api('PATCH', `/api/stories/${story.key}?projectId=PRJ-001`, { endpointIds: [widget.id] });
  assert.equal(linked.status, 200, linked.text.slice(0, 300));
  assert.deepEqual(linked.body.endpointIds, [widget.id]);
  const tpl = await api('GET', '/api/explorer/templates?projectId=PRJ-001');
  assert.ok(tpl.body.some((t) => t.group && /Project/.test(t.group) && /widgets/.test(t.path)));
});

test('sync-and-generate produces proposals from Jira tickets', async () => {
  const r = await api('POST', '/api/stories/sync-and-generate?projectId=PRJ-001', { jql: 'text ~ "Create Contact through Salesforce API"', onlyNeedingApi: true });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.body.synced >= 1);
  assert.ok(r.body.proposals.length >= 1);
  assert.ok(r.body.proposals[0].id.startsWith('GEN-'));
  assert.ok(r.body.proposals[0].tests > 0);
  assert.equal(r.body.approved, false);
  assert.equal(r.body.scoped, false);
});

test('sync-and-generate with storyKey only proposes that ticket', async () => {
  const stories = (await api('GET', '/api/stories?projectId=PRJ-001')).body.items;
  assert.ok(stories.length >= 2, 'need at least two tickets to prove generate is not a project-wide fan-out');
  const target = stories.find((s) => s.key === 'DEMO-102') || stories[1];
  const others = new Set(stories.filter((s) => s.key !== target.key).map((s) => s.key));
  const r = await api('POST', '/api/stories/sync-and-generate?projectId=PRJ-001', {
    storyKey: target.key,
    issueKey: target.key,
    onlyNeedingApi: false,
  });
  assert.equal(r.status, 200, r.text.slice(0, 400));
  assert.equal(r.body.scoped, true);
  assert.deepEqual(r.body.storyKeys, [target.key]);
  assert.equal(r.body.synced, 1);
  assert.equal(r.body.selected, 1);
  assert.equal(r.body.proposals.length, 1, r.text.slice(0, 400));
  assert.equal(r.body.proposals[0].storyKey, target.key);
  assert.ok(!r.body.proposals.some((p) => others.has(p.storyKey)), 'must not propose suites for other tickets');
  assert.equal(r.body.approved, false);
});

test('POST /api/generate with issueKey only proposes that ticket', async () => {
  const gen = await api('POST', '/api/generate?projectId=PRJ-001', { issueKey: 'DEMO-108', inputSource: 'jira' });
  assert.equal(gen.status, 200, gen.text.slice(0, 300));
  assert.equal(gen.body.storyKey, 'DEMO-108');
  assert.equal(gen.body.status, 'proposed');
  assert.ok((gen.body.scenarios || []).length);
});

test('sync-and-generate approve flag is a documented no-op', async () => {
  const r = await api('POST', '/api/stories/sync-and-generate?projectId=PRJ-001', { onlyNeedingApi: true, approve: true });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.body.approved, false);
  assert.equal(r.body.approveIgnored, true);
  assert.match(String(r.body.approveNote || ''), /generate-only|ignored/i);
  assert.ok((r.body.proposals || []).every((p) => p.approved === false));
});

test('plan-from-docs creates a proposal that still requires approve', async () => {
  const stories = (await api('GET', '/api/stories?projectId=PRJ-001')).body.items;
  const story = stories[0];
  const doc = await api('POST', '/api/projects/PRJ-001/context-docs', { name: 'UT mapping', body: 'Map LastName on Contact. POST /services/data/v62.0/sobjects/Contact returns 201.' });
  assert.equal(doc.status, 200, doc.text.slice(0, 200));
  const plan = await api('POST', '/api/stories/plan-from-docs?projectId=PRJ-001', { storyKey: story.key, docIds: [doc.body.id] });
  assert.equal(plan.status, 200, plan.text.slice(0, 300));
  assert.equal(plan.body.approved, false);
  assert.equal(plan.body.status, 'proposed');
  assert.ok(plan.body.scenarios.length);
  const before = (await api('GET', '/api/testcases?projectId=PRJ-001&pageSize=1')).body.total;
  assert.ok(plan.body.analysis.traceability);
  const mid = (await api('GET', '/api/testcases?projectId=PRJ-001&pageSize=1')).body.total;
  assert.equal(mid, before, 'plan-from-docs must not save tests');
});

test('approve runNow starts a run without filing defects', async () => {
  const stories = (await api('GET', '/api/stories?projectId=PRJ-001')).body.items;
  const gen = await api('POST', '/api/generate', { projectId: 'PRJ-001', storyKey: stories[0].key });
  assert.equal(gen.status, 200, gen.text.slice(0, 300));
  const proposal = gen.body.proposal || gen.body;
  const approved = await api('POST', `/api/proposals/${proposal.id}/approve`, { runNow: true, selected: { 0: [0] } });
  assert.equal(approved.status, 200, approved.text.slice(0, 400));
  assert.ok(approved.body.tests > 0);
  assert.equal(approved.body.run && approved.body.run.started, true);
  assert.ok(approved.body.run.id);
  const run = await api('GET', `/api/runs/${approved.body.run.id}`);
  assert.equal(run.status, 200);
  assert.ok(['running', 'completed', 'stopped', 'error'].includes(run.body.status));
});

test('generate source jira ignores docs; docs-only requires a document', async () => {
  const stories = (await api('GET', '/api/stories?projectId=PRJ-001')).body.items;
  const story = stories[0];
  const doc = await api('POST', '/api/projects/PRJ-001/context-docs', { name: 'UT source mapping', body: 'Contact LastName required. POST /services/data/v62.0/sobjects/Contact returns 201.' });
  assert.equal(doc.status, 200, doc.text.slice(0, 200));
  const jiraOnly = await api('POST', '/api/generate?projectId=PRJ-001', { storyKey: story.key, inputSource: 'jira', docIds: [doc.body.id] });
  assert.equal(jiraOnly.status, 200, jiraOnly.text.slice(0, 300));
  assert.equal((jiraOnly.body.analysis || {}).inputSource, 'jira');
  assert.equal(((jiraOnly.body.analysis || {}).docsUsed || []).length, 0);
  const both = await api('POST', '/api/generate?projectId=PRJ-001', { storyKey: story.key, inputSource: 'jira+docs', docIds: [doc.body.id] });
  assert.equal(both.status, 200, both.text.slice(0, 300));
  assert.equal((both.body.analysis || {}).inputSource, 'jira+docs');
  assert.ok(((both.body.analysis || {}).docsUsed || []).length >= 1);
  const docsOnly = await api('POST', '/api/generate?projectId=PRJ-001', { storyKey: story.key, inputSource: 'docs', docIds: [doc.body.id] });
  assert.equal(docsOnly.status, 200, docsOnly.text.slice(0, 300));
  assert.equal((docsOnly.body.analysis || {}).inputSource, 'docs');
  const missing = await api('POST', '/api/generate?projectId=PRJ-001', { storyKey: story.key, inputSource: 'docs', docIds: [] });
  assert.equal(missing.status, 400);
});

test('delete one generated test and all tests for a story', async () => {
  const stories = (await api('GET', '/api/stories?projectId=PRJ-001')).body.items;
  const gen = await api('POST', '/api/generate', { projectId: 'PRJ-001', storyKey: stories[0].key, inputSource: 'jira' });
  assert.equal(gen.status, 200, gen.text.slice(0, 300));
  const approved = await api('POST', `/api/proposals/${gen.body.id}/approve`, { selected: { 0: [0, 1].filter((i) => (gen.body.scenarios[0].testCases || [])[i]) } });
  assert.equal(approved.status, 200, approved.text.slice(0, 400));
  assert.ok(approved.body.ids && approved.body.ids.length >= 1);
  const one = approved.body.ids[0];
  const delOne = await api('DELETE', `/api/testcases/${one}`);
  assert.equal(delOne.status, 200);
  assert.equal(delOne.body.deleted, true);
  const delAll = await api('DELETE', `/api/stories/${stories[0].key}/tests?projectId=PRJ-001`);
  assert.equal(delAll.status, 200, delAll.text.slice(0, 300));
  assert.equal(delAll.body.deleted, true);
  const left = await api('GET', `/api/stories/${stories[0].key}?projectId=PRJ-001`);
  assert.equal((left.body.tests || []).length, 0);
});

test('environment-import fills connections including credentials without echoing secrets', async () => {
  const created = await api('POST', '/api/projects', { name: 'Env import throwaway', environment: 'QA', mode: 'demo', apiVersion: '62.0' });
  assert.equal(created.status, 200, created.text.slice(0, 300));
  const id = created.body.id;
  const env = {
    name: 'PCL-Automation - 004',
    values: [
      { key: 'loginUrl', value: 'https://acme--qa.sandbox.my.salesforce.com' },
      { key: 'apiVersion', value: '68.0' },
      { key: 'httpBaseUrl', value: 'https://api.shop.example' },
      { key: 'organization_id', value: 'f_ecom_zzte_001' },
      { key: 'shortCode', value: 'kv7kzm78' },
      { key: 'siteId', value: 'RefArch' },
      { key: 'client_id', value: 'client-id-dddd' },
      { key: 'client_secret', value: 'super-secret-value' },
      { key: 'password', value: 'dont-store-me' },
      { key: 'access_token', value: 'access-token-hhhh' },
      { key: 'slas_access_token', value: 'slas-access-iiiiii' },
    ],
  };
  const r = await api('POST', `/api/projects/${id}/environment-import`, { environment: env });
  assert.equal(r.status, 200, r.text.slice(0, 400));
  assert.equal(r.body.ok, true);
  assert.equal((r.body.skippedKeys || []).length, 0, r.text.slice(0, 400));
  assert.doesNotMatch(r.body.notice || '', /skipped/i);
  const keys = (r.body.credentials && r.body.credentials.keys) || [];
  assert.ok(keys.some((k) => /CLIENT_ID$/.test(k)), JSON.stringify(keys));
  assert.ok(keys.some((k) => /CLIENT_SECRET$/.test(k)), JSON.stringify(keys));
  assert.ok(keys.some((k) => /TOKEN$/.test(k)), JSON.stringify(keys));
  assert.doesNotMatch(r.text, /super-secret-value|dont-store-me|access-token-hhhh|slas-access-iiiiii/);
  const p = await api('GET', `/api/projects/${id}`);
  assert.match(p.body.instanceUrl, /acme--qa/);
  assert.equal(p.body.apiVersion, '68.0');
  assert.equal(p.body.integrationConfig.http.baseUrl, 'https://api.shop.example');
  assert.equal(p.body.integrationConfig.commerce.orgId, 'f_ecom_zzte_001');
  const again = await api('POST', `/api/projects/${id}/environment-import`, {
    environment: { name: 'PCL-Automation - 004', values: [{ key: 'httpBaseUrl', value: 'https://other.example' }, { key: 'loginUrl', value: 'https://login.salesforce.com' }] },
  });
  assert.equal(again.status, 200, again.text.slice(0, 300));
  const p2 = await api('GET', `/api/projects/${id}`);
  assert.equal(p2.body.integrationConfig.http.baseUrl, 'https://api.shop.example');
  assert.match(p2.body.instanceUrl, /acme--qa/);
});

test('DELETE project removes it instead of only archiving', async () => {
  const created = await api('POST', '/api/projects', { name: 'Temp delete me', environment: 'QA', mode: 'demo', apiVersion: '62.0' });
  assert.equal(created.status, 200, created.text.slice(0, 300));
  const id = created.body.id;
  const gone = await api('DELETE', `/api/projects/${id}`);
  assert.equal(gone.status, 200, gone.text.slice(0, 300));
  assert.equal(gone.body.deleted, true);
  const again = await api('GET', `/api/projects/${id}`);
  assert.equal(again.status, 404);
  const archived = await api('POST', '/api/projects', { name: 'Temp archive me', environment: 'QA', mode: 'demo', apiVersion: '62.0' });
  const hid = await api('DELETE', `/api/projects/${archived.body.id}?archive=true`);
  assert.equal(hid.status, 200);
  assert.equal(hid.body.archived, true);
});

test('meta exposes CLI contract and generator flags', async () => {
  const m = await api('GET', '/api/meta');
  assert.equal(m.status, 200);
  assert.ok(m.body.cliContract && m.body.cliContract.shape);
  assert.ok(m.body.generators);
  assert.equal(typeof m.body.generators.cursorCliEnabled, 'boolean');
});
