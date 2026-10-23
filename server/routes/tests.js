'use strict';
/** Test scenarios and test case management. */
const { route, HttpError, required } = require('../http');
const { repo, all, get, now, audit, nextId } = require('../db');
const { prioritise } = require('../engine/priority');
const postman = require('../engine/postman');
const { projectFrom, getProject, paginate, inFilter, likeFilter, dateRange } = require('./util');

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'];
const TEST_TYPES = ['Functional', 'Negative', 'Boundary', 'Security', 'Integration', 'Regression', 'Contract', 'Performance'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const ASSERTION_TYPES = ['status', 'jsonpath', 'header', 'responseTime', 'sfError', 'schema', 'bodyContains'];

function validEndpoint(ep) {
  const s = String(ep || '').trim();
  return s.startsWith('/') || /^https?:\/\//i.test(s) || /^\{\{[A-Za-z_][\w]*\}\}/.test(s);
}

function hasTag(t, tag) {
  const tags = Array.isArray(t && t.tags) ? t.tags : [];
  return tags.includes(tag);
}

function validateTestCase(t, partial = false) {
  if (!partial) required(t, ['title', 'method', 'endpoint', 'testType']);
  if (t.method !== undefined && !METHODS.includes(String(t.method).toUpperCase())) throw new HttpError(400, `Method must be one of ${METHODS.join(', ')}.`);
  if (t.testType !== undefined && !TEST_TYPES.includes(t.testType)) throw new HttpError(400, `Test type must be one of ${TEST_TYPES.join(', ')}.`);
  if (t.priority !== undefined && t.priority !== null && !PRIORITIES.includes(t.priority)) throw new HttpError(400, 'Priority must be P0, P1, P2 or P3.');
  if (t.auth !== undefined && !['default', 'none', 'invalid', 'lowpriv'].includes(t.auth)) throw new HttpError(400, 'Auth must be default, none, invalid or lowpriv.');
  if (t.endpoint !== undefined && !validEndpoint(t.endpoint)) {
    throw new HttpError(400, 'Endpoint must be a path starting with /, an http(s) URL, or a template such as {{baseUrl}}/v1/orders.');
  }
  if (t.assertions !== undefined) {
    if (!Array.isArray(t.assertions)) throw new HttpError(400, 'assertions must be an array.');
    t.assertions.forEach((a, i) => { if (!ASSERTION_TYPES.includes(a.type)) throw new HttpError(400, `Assertion #${i + 1} has unknown type "${a.type}".`, { action: `Use one of ${ASSERTION_TYPES.join(', ')}.` }); });
  }
  const headerStr = JSON.stringify(t.headers || {});
  if (/authorization"\s*:\s*"(?!\s*Bearer\s*\{\{)/i.test(headerStr)) throw new HttpError(400, 'Do not hard-code Authorization headers in test cases.', { action: 'Authentication is injected at runtime from the secret store. Use the Auth setting (default/none/invalid/lowpriv) instead.' });
}

const EDITABLE = ['title', 'description', 'apiType', 'method', 'endpoint', 'auth', 'headers', 'query', 'body', 'bodyRaw', 'assertions', 'extract', 'sfValidation', 'contractRef', 'cleanup', 'timeoutMs', 'object', 'testType', 'priority', 'status', 'label', 'tags', 'storyKey', 'scenarioId', 'seq', 'automated', 'extra'];

// ── Scenarios ──
route('GET', '/api/scenarios', (ctx) => {
  const p = projectFrom(ctx);
  const where = ['s.projectId = $p']; const params = { p: p.id };
  inFilter(where, params, 's.storyKey', ctx.query.storyKey, 'sk');
  inFilter(where, params, 's.apiType', ctx.query.apiType, 'api');
  inFilter(where, params, 's.priority', ctx.query.priority, 'pr');
  inFilter(where, params, 's.status', ctx.query.status, 'st');
  inFilter(where, params, 's.type', ctx.query.type, 'ty');
  likeFilter(where, params, ['s.id', 's.title', 's.storyKey', 's.object'], ctx.query.q);
  const table = `scenarios s LEFT JOIN (SELECT scenarioId, COUNT(*) AS tests, SUM(CASE WHEN lastResult='passed' THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN lastResult='failed' THEN 1 ELSE 0 END) AS failed FROM test_cases GROUP BY scenarioId) c ON c.scenarioId = s.id`;
  return paginate(table, ctx, { where, params, columns: 's.*, COALESCE(c.tests,0) AS tests, COALESCE(c.passed,0) AS passed, COALESCE(c.failed,0) AS failed', sortable: ['s.id', 's.title', 's.storyKey', 's.priority', 's.type', 's.apiType', 's.status'], defaultSort: 's.id', defaultDir: 'ASC' });
});

route('PUT', '/api/scenarios/:id', (ctx) => {
  const s = repo.get('scenarios', ctx.params.id);
  if (!s) throw new HttpError(404, `Scenario ${ctx.params.id} not found.`);
  const patch = { updatedAt: now() };
  for (const k of ['title', 'description', 'priority', 'status', 'type']) if (ctx.body[k] !== undefined) patch[k] = ctx.body[k];
  repo.update('scenarios', s.id, patch);
  audit('tests', 'scenario.updated', { user: ctx.user, projectId: s.projectId, detail: { id: s.id } });
  return repo.get('scenarios', s.id);
});

route('DELETE', '/api/scenarios/:id', (ctx) => {
  const s = repo.get('scenarios', ctx.params.id);
  if (!s) throw new HttpError(404, `Scenario ${ctx.params.id} not found.`);
  const n = get('SELECT COUNT(*) AS n FROM test_cases WHERE scenarioId = $s', { s: s.id }).n;
  if (n && ctx.query.cascade !== 'true') throw new HttpError(409, `Scenario ${s.id} still has ${n} test case(s).`, { action: 'Delete or move its test cases first, or pass cascade=true.' });
  repo.find('test_cases', 'scenarioId = $s', { s: s.id }).forEach((t) => repo.remove('test_cases', t.id));
  repo.remove('scenarios', s.id);
  audit('tests', 'scenario.deleted', { user: ctx.user, projectId: s.projectId, detail: { id: s.id, testCases: n } });
  return { deleted: true };
});

// ── Test cases ──
route('GET', '/api/testcases', (ctx) => {
  const p = projectFrom(ctx);
  const where = ['projectId = $p']; const params = { p: p.id };
  inFilter(where, params, 'storyKey', ctx.query.storyKey, 'sk');
  inFilter(where, params, 'scenarioId', ctx.query.scenarioId, 'sc');
  inFilter(where, params, 'apiType', ctx.query.apiType, 'api');
  inFilter(where, params, 'testType', ctx.query.testType, 'tt');
  inFilter(where, params, 'priority', ctx.query.priority, 'pr');
  inFilter(where, params, 'status', ctx.query.status, 'st');
  inFilter(where, params, 'method', ctx.query.method, 'me');
  inFilter(where, params, 'lastResult', ctx.query.lastResult, 'lr');
  inFilter(where, params, 'label', ctx.query.label, 'lb');
  if (ctx.query.tag) { params.tag = `%"${ctx.query.tag}"%`; where.push('tags LIKE $tag'); }
  if (ctx.query.unlinked === 'true' || ctx.query.unlinked === '1') where.push("(storyKey IS NULL OR storyKey = '')");
  dateRange(where, params, 'lastRunAt', ctx.query.from, ctx.query.to);
  likeFilter(where, params, ['id', 'title', 'endpoint', 'storyKey'], ctx.query.q);
  const columns = 'id, projectId, scenarioId, storyKey, seq, title, apiType, method, endpoint, auth, testType, priority, status, label, tags, object, lastRunAt, lastResult, lastResponseMs, automated';
  const page = paginate('test_cases', ctx, { where, params, columns, sortable: ['seq', 'id', 'title', 'priority', 'testType', 'method', 'status', 'lastRunAt', 'lastResult', 'storyKey'], defaultSort: 'seq', defaultDir: 'ASC' });
  page.items = page.items.map((t) => ({ ...t, tags: typeof t.tags === 'string' ? JSON.parse(t.tags || '[]') : t.tags || [] }));
  return page;
});

route('GET', '/api/testcases/:id', (ctx) => {
  const t = repo.get('test_cases', ctx.params.id);
  if (!t) throw new HttpError(404, `Test case ${ctx.params.id} not found.`);
  const scenario = t.scenarioId ? repo.get('scenarios', t.scenarioId) : null;
  const history = all('SELECT id, runId, status, statusCode, responseMs, startedAt, defectKey FROM run_results WHERE testCaseId = $t ORDER BY startedAt DESC LIMIT 20', { t: t.id });
  const defects = all('SELECT id, key, summary, status, severity, url FROM defects WHERE testCaseId = $t', { t: t.id });
  return { ...t, scenario, history, defects };
});

route('POST', '/api/testcases', (ctx) => {
  const p = projectFrom(ctx);
  const b = ctx.body;
  validateTestCase(b);
  const id = nextId('TC', 5);
  const t = { id, projectId: p.id, createdAt: now(), updatedAt: now(), status: 'ready', label: 'ASSUMED', auth: 'default', apiType: 'REST', assertions: [{ type: 'status', op: 'lt', expected: 400 }], extract: [], headers: {}, query: {}, tags: [], automated: 1 };
  for (const k of EDITABLE) if (b[k] !== undefined) t[k] = b[k];
  t.method = String(t.method).toUpperCase();
  if (!t.seq) t.seq = (get('SELECT MAX(seq) AS m FROM test_cases WHERE projectId = $p', { p: p.id }).m || 0) + 10;
  if (!t.priority) {
    const story = t.storyKey ? repo.one('stories', 'projectId = $p AND key = $k', { p: p.id, k: t.storyKey }) : null;
    const pr = prioritise(t, { project: p, story: story || {} });
    t.priority = pr.priority; t.priorityReason = pr;
  }
  repo.insert('test_cases', t);
  audit('tests', 'testcase.created', { user: ctx.user, projectId: p.id, detail: { id } });
  return repo.get('test_cases', id);
});

route('PUT', '/api/testcases/:id', (ctx) => {
  const t = repo.get('test_cases', ctx.params.id);
  if (!t) throw new HttpError(404, `Test case ${ctx.params.id} not found.`);
  validateTestCase(ctx.body, true);
  const patch = { updatedAt: now() };
  for (const k of EDITABLE) if (ctx.body[k] !== undefined) patch[k] = ctx.body[k];
  if (patch.method) patch.method = String(patch.method).toUpperCase();
  if (patch.label && t.label === 'VERIFIED' && patch.label !== 'VERIFIED') { /* downgrade allowed */ }
  if (patch.label === 'VERIFIED' && t.label !== 'VERIFIED' && !ctx.body.confirmVerified) {
    throw new HttpError(400, 'A test can only be marked VERIFIED after confirming its metadata against a live org.', { action: 'Re-run discovery for the object, then save with confirmVerified=true.' });
  }
  repo.update('test_cases', t.id, patch);
  audit('tests', 'testcase.updated', { user: ctx.user, projectId: t.projectId, detail: { id: t.id, fields: Object.keys(patch).filter((k) => k !== 'updatedAt') } });
  return repo.get('test_cases', t.id);
});

route('POST', '/api/testcases/:id/duplicate', (ctx) => {
  const t = repo.get('test_cases', ctx.params.id);
  if (!t) throw new HttpError(404, `Test case ${ctx.params.id} not found.`);
  const id = nextId('TC', 5);
  const copy = { ...t, id, title: `${t.title} (copy)`, seq: t.seq + 1, lastRunAt: null, lastResult: null, lastResponseMs: null, createdAt: now(), updatedAt: now() };
  repo.insert('test_cases', copy);
  audit('tests', 'testcase.duplicated', { user: ctx.user, projectId: t.projectId, detail: { from: t.id, id } });
  return repo.get('test_cases', id);
});

function dropEmptyScenario(scenarioId) {
  if (!scenarioId) return false;
  const n = get('SELECT COUNT(*) AS n FROM test_cases WHERE scenarioId = $s', { s: scenarioId }).n;
  if (n) return false;
  const s = repo.get('scenarios', scenarioId);
  if (s) repo.remove('scenarios', s.id);
  return true;
}

route('DELETE', '/api/testcases/:id', (ctx) => {
  const t = repo.get('test_cases', ctx.params.id);
  if (!t) throw new HttpError(404, `Test case ${ctx.params.id} not found.`);
  repo.remove('test_cases', t.id);
  const scenarioRemoved = dropEmptyScenario(t.scenarioId);
  audit('tests', 'testcase.deleted', { user: ctx.user, projectId: t.projectId, detail: { id: t.id, title: t.title, scenarioRemoved } });
  return { deleted: true, scenarioRemoved };
});

function applyStoryKey(p, ids, storyKey, user) {
  const key = storyKey ? String(storyKey).trim().toUpperCase() : null;
  if (key && !/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new HttpError(400, 'Story key must look like PROJ-123.');
  if (key) {
    const story = repo.one('stories', 'projectId = $p AND key = $k', { p: p.id, k: key });
    if (!story) throw new HttpError(404, `Story ${key} is not on this project.`, { action: 'Open the Jira ticket (or add it) first, then attach tests.' });
  }
  const linked = [];
  for (const raw of ids || []) {
    const t = repo.get('test_cases', String(raw));
    if (!t || t.projectId !== p.id) continue;
    repo.update('test_cases', t.id, { storyKey: key, updatedAt: now() });
    linked.push(t.id);
  }
  audit('tests', key ? 'testcase.linked-story' : 'testcase.unlinked-story', { user, projectId: p.id, detail: { count: linked.length, storyKey: key, ids: linked } });
  return { updated: linked.length, storyKey: key, ids: linked };
}

route('POST', '/api/testcases/bulk', (ctx) => {
  const p = projectFrom(ctx);
  const ids = (ctx.body.ids || []).map(String);
  if (!ids.length) throw new HttpError(400, 'Select at least one test case.');
  if (ctx.body.storyKey !== undefined && !ctx.body.delete) {
    return applyStoryKey(p, ids, ctx.body.storyKey, ctx.user);
  }
  const patch = {};
  for (const k of ['priority', 'status', 'testType']) if (ctx.body[k]) patch[k] = ctx.body[k];
  validateTestCase(patch, true);
  let n = 0;
  const scenarios = new Set();
  for (const id of ids) {
    const t = repo.get('test_cases', id);
    if (t && t.projectId === p.id) {
      if (ctx.body.delete) { scenarios.add(t.scenarioId); repo.remove('test_cases', id); }
      else repo.update('test_cases', id, { ...patch, updatedAt: now() });
      n++;
    }
  }
  if (ctx.body.delete) scenarios.forEach((id) => dropEmptyScenario(id));
  audit('tests', ctx.body.delete ? 'testcase.bulk-deleted' : 'testcase.bulk-updated', { user: ctx.user, projectId: p.id, detail: { count: n, patch } });
  return { updated: n };
});

/** Automation preview for one test case: Postman item + Newman/Node snippet. */
route('POST', '/api/testcases/:id/automate', (ctx) => {
  const t = repo.get('test_cases', ctx.params.id);
  if (!t) throw new HttpError(404, `Test case ${ctx.params.id} not found.`);
  const p = getProject(t.projectId);
  const collection = postman.exportCollection(p, [t]);
  repo.update('test_cases', t.id, { automated: 1, updatedAt: now() });
  return {
    collection,
    newman: `npx newman run collections/${p.id}.postman_collection.json -e environments/${p.environment.toLowerCase()}.postman_environment.json --folder "${t.testType}" --reporters cli,htmlextra,junit`,
    node: `node api-tests/scripts/run-suite.js --project ${p.id} --tests ${t.id}`,
  };
});

route('GET', '/api/insights', (ctx) => {
  const p = projectFrom(ctx);
  const threshold = Number(ctx.query.failureRate || 10);
  const endpointStats = all(`SELECT method, endpoint, COUNT(*) AS runs, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, ROUND(AVG(responseMs)) AS avgMs
    FROM run_results WHERE projectId = $p GROUP BY method, endpoint HAVING runs > 0`, { p: p.id })
    .map((r) => ({ ...r, failureRate: Math.round((r.failed / r.runs) * 1000) / 10 }))
    .filter((r) => r.failureRate > threshold).sort((a, b) => b.failureRate - a.failureRate);
  const dupes = all(`SELECT method, endpoint, body, auth, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM test_cases WHERE projectId = $p GROUP BY method, endpoint, body, auth, query, assertions HAVING n > 1`, { p: p.id })
    .map((r) => ({ method: r.method, endpoint: r.endpoint, count: r.n, ids: r.ids.split(',') }));
  const types = Object.fromEntries(all('SELECT testType, COUNT(*) AS n FROM test_cases WHERE projectId = $p GROUP BY testType', { p: p.id }).map((r) => [r.testType, r.n]));
  const gaps = [];
  for (const t of ['Negative', 'Boundary', 'Security', 'Integration']) if (!types[t]) gaps.push({ label: 'RECOMMENDED', text: `No ${t} tests exist for this project.` });
  const uncovered = all(`SELECT key, summary FROM stories WHERE projectId = $p AND key NOT IN (SELECT DISTINCT storyKey FROM test_cases WHERE projectId = $p AND storyKey IS NOT NULL)`, { p: p.id });
  for (const s of uncovered) gaps.push({ label: 'RECOMMENDED', text: `${s.key} "${s.summary}" has no API tests.`, storyKey: s.key });
  const drafts = get("SELECT COUNT(*) AS n FROM test_cases WHERE projectId = $p AND status = 'draft'", { p: p.id }).n;
  if (drafts) gaps.push({ label: 'RECOMMENDED', text: `${drafts} draft test(s) need configuration (e.g. low-privilege user or integration endpoint) before they can run.` });
  return { threshold, failingEndpoints: endpointStats, duplicates: dupes, gaps, typeDistribution: types };
});

module.exports = { validateTestCase, applyStoryKey, hasTag, validEndpoint };
