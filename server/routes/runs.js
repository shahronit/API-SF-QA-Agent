'use strict';
/** Test execution: start/stop runs, stream progress (SSE), results, analysis, explorer. */
const { route, HttpError, sse } = require('../http');
const { repo, all, get, audit, decode } = require('../db');
const { connectorFor, isCommerceRequest, isHttpRequest } = require('../connectors');
const runner = require('../engine/runner');
const { checkOperation, isProduction, PRODUCTION_WARNING } = require('../engine/safety');
const { summarise } = require('../engine/analyzer');
const { evaluate } = require('../engine/assertions');
const { interpolate } = require('../lib/template');
const { maskDeep, maskHeaders } = require('../lib/mask');
const { explainResponse } = require('../lib/errors');
const { prioritise } = require('../engine/priority');
const { compareRuns, flakyTests, qualityGate } = require('../engine/run-compare');
const { projectFrom, getProject, paginate, inFilter, likeFilter, dateRange } = require('./util');

function selectTests(p, body) {
  const where = ['projectId = $p']; const params = { p: p.id };
  if (Array.isArray(body.testCaseIds) && body.testCaseIds.length) inFilter(where, params, 'id', body.testCaseIds.join(','), 'id');
  const f = body.filter || {};
  if (f.priority) inFilter(where, params, 'priority', [].concat(f.priority).join(','), 'pr');
  if (f.testType) inFilter(where, params, 'testType', [].concat(f.testType).join(','), 'tt');
  if (f.storyKey) inFilter(where, params, 'storyKey', [].concat(f.storyKey).join(','), 'sk');
  if (f.apiType) inFilter(where, params, 'apiType', [].concat(f.apiType).join(','), 'api');
  if (f.lastResult) inFilter(where, params, 'lastResult', [].concat(f.lastResult).join(','), 'lr');
  if (f.tag) { params.tag = `%"${f.tag}"%`; where.push('tags LIKE $tag'); }
  if (!body.includeDrafts) where.push("status != 'draft'");
  where.push("status != 'disabled'");
  return repo.find('test_cases', where.join(' AND '), params, 'ORDER BY seq');
}

/** Pull in upstream tests that produce variables a selected test needs. */
function withDependencies(p, tests) {
  const all = repo.find('test_cases', "projectId = $p AND status != 'disabled'", { p: p.id }, 'ORDER BY seq');
  const producers = {};
  for (const t of all) for (const e of t.extract || []) if (!producers[e.var]) producers[e.var] = t;
  const selected = new Map(tests.map((t) => [t.id, t]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of [...selected.values()]) {
      const text = JSON.stringify([t.endpoint, t.body, t.bodyRaw, t.query, t.headers, t.assertions]);
      for (const m of text.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)) {
        const prod = producers[m[1]];
        if (prod && !selected.has(prod.id) && prod.seq < t.seq) { selected.set(prod.id, prod); changed = true; }
      }
    }
  }
  return [...selected.values()].sort((a, b) => a.seq - b.seq);
}

/** Traceability of the latest approved proposal for the run's story (single-story runs only). */
function traceabilityFor(p, tests) {
  const keys = [...new Set(tests.map((t) => t.storyKey).filter(Boolean))];
  if (keys.length !== 1) return null;
  const [pr] = repo.find('proposals', "projectId = $p AND storyKey = $k AND status = 'approved'", { p: p.id, k: keys[0] }, 'ORDER BY decidedAt DESC LIMIT 1');
  return (pr && pr.analysis && pr.analysis.traceability) || null;
}

route('POST', '/api/runs', (ctx) => {
  const p = projectFrom(ctx);
  const b = ctx.body;
  let tests;
  if (b.mode === 'failed') {
    const last = get("SELECT id FROM runs WHERE projectId = $p AND status IN ('completed','stopped') ORDER BY startedAt DESC LIMIT 1", { p: p.id });
    if (!last) throw new HttpError(409, 'There is no previous run to take failed tests from.', { action: 'Run the suite first.' });
    const ids = all("SELECT DISTINCT testCaseId FROM run_results WHERE runId = $r AND status IN ('failed','blocked')", { r: b.fromRunId || last.id }).map((r) => r.testCaseId);
    if (!ids.length) throw new HttpError(409, 'The last run has no failed or blocked tests to re-run.');
    tests = selectTests(p, { testCaseIds: ids });
  } else {
    tests = selectTests(p, b);
  }
  if (!tests.length) {
    const ready = repo.count('test_cases', "projectId = $p AND status != 'draft' AND status != 'disabled'", { p: p.id });
    throw new HttpError(400, 'No executable test cases match this selection.', {
      cause: ready
        ? 'The filter matched nothing, or all matches are drafts/disabled.'
        : 'This project has no ready tests yet.',
      action: ready
        ? 'Clear the story/priority filters, or pick tests on the Tests page and Run selected.'
        : 'Import a Postman collection to get runnable tests immediately, or generate from a Jira ticket (that path still needs approve).',
    });
  }
  if (b.resolveDependencies !== false) tests = withDependencies(p, tests);
  if (tests.length > 2000) throw new HttpError(400, `Selection contains ${tests.length} tests; the per-run maximum is 2000.`, { action: 'Split the run by story, priority or test type.' });

  // Production safety: refuse to start if writes are present without confirmation.
  if (isProduction(p)) {
    const writes = tests.filter((t) => checkOperation(p, t, {}));
    const deletes = tests.filter((t) => String(t.method).toUpperCase() === 'DELETE');
    if (writes.length && !b.confirmProductionWrites && !b.skipWrites) {
      throw new HttpError(409, PRODUCTION_WARNING, { code: 'PRODUCTION_CONFIRMATION_REQUIRED', requires: 'confirmProductionWrites', writeCount: writes.length, deleteCount: deletes.length, cause: `${writes.length} of ${tests.length} selected tests modify data in Production.`, action: 'Confirm production writes, run read-only tests only, or switch to a non-production environment.' });
    }
    if (deletes.length && b.confirmProductionWrites && !b.confirmDelete && !b.skipWrites) {
      throw new HttpError(409, `${PRODUCTION_WARNING} ${deletes.length} DELETE operation(s) require a second confirmation.`, { code: 'PRODUCTION_DELETE_CONFIRMATION_REQUIRED', requires: 'confirmDelete', deleteCount: deletes.length, action: 'Confirm the DELETE operations explicitly.' });
    }
    if (b.skipWrites) tests = tests.filter((t) => !checkOperation(p, t, {}));
    if (!tests.length) throw new HttpError(400, 'All selected tests modify data; nothing left to run in read-only mode.');
    audit('safety', b.confirmProductionWrites ? 'production.writes-confirmed' : 'production.read-only-run', { user: ctx.user, projectId: p.id, detail: { tests: tests.length, deletesConfirmed: Boolean(b.confirmDelete) } });
  }
  const executor = ['playwright', 'postman', 'platform'].includes(String(b.executor || '').toLowerCase()) ? String(b.executor).toLowerCase() : 'auto';
  const storyKeys = [].concat((b.filter && b.filter.storyKey) || b.storyKeys || []).filter(Boolean);
  const run = runner.startRun({
    project: p, testCases: tests, user: ctx.user,
    options: {
      confirmProductionWrites: b.confirmProductionWrites, confirmDelete: b.confirmDelete, label: b.label,
      trigger: b.mode === 'failed' ? 'rerun-failed' : b.trigger || 'manual', filter: b.filter, executor,
      postResultToJira: Boolean(b.postResultToJira),
      storyKeys,
      traceability: traceabilityFor(p, tests),
    },
  });
  return { ...run, testCaseIds: undefined };
});

route('GET', '/api/runs', (ctx) => {
  const p = projectFrom(ctx);
  const where = ['projectId = $p']; const params = { p: p.id };
  inFilter(where, params, 'status', ctx.query.status, 'st');
  inFilter(where, params, 'environment', ctx.query.environment, 'env');
  dateRange(where, params, 'startedAt', ctx.query.from, ctx.query.to);
  likeFilter(where, params, ['id', 'label', 'user'], ctx.query.q);
  return paginate('runs', ctx, { where, params, columns: 'id, projectId, environment, user, label, trigger, status, startedAt, endedAt, total, passed, failed, blocked, skipped, apiErrors, sfErrors, avgResponseMs', sortable: ['startedAt', 'total', 'failed', 'status'], defaultSort: 'startedAt' });
});

route('GET', '/api/runs/:id', (ctx) => {
  const r = repo.get('runs', ctx.params.id);
  if (!r) throw new HttpError(404, `Execution ${ctx.params.id} not found.`);
  return { ...r, active: runner.isActive(r.id), jiraActivity: all("SELECT ts, user, action, detail FROM audit_log WHERE category = 'jira' AND detail LIKE $r ORDER BY ts", { r: `%${r.id}%` }).map((x) => decode('audit_log', x)) };
});

route('GET', '/api/runs/:id/compare', (ctx) => {
  const cmp = compareRuns(ctx.params.id, ctx.query.baseline);
  if (!cmp) throw new HttpError(404, `Execution ${ctx.params.id} not found.`);
  if (ctx.query.baseline && ctx.query.baseline !== 'previous' && !cmp.baseline) throw new HttpError(404, `Baseline execution ${ctx.query.baseline} not found.`);
  const ids = new Set(all('SELECT testCaseId FROM run_results WHERE runId = $r', { r: ctx.params.id }).map((x) => x.testCaseId));
  return { ...cmp, flaky: flakyTests(repo.get('runs', ctx.params.id).projectId, { testCaseIds: ids }) };
});

route('GET', '/api/runs/:id/gate', (ctx) => {
  const q = ctx.query;
  const gate = qualityGate(ctx.params.id, { minPassRate: q.minPassRate, requireP0: q.requireP0, maxBlocked: q.maxBlocked, maxNewFailures: q.maxNewFailures, baseline: q.baseline });
  if (!gate) throw new HttpError(404, `Execution ${ctx.params.id} not found.`);
  return gate;
});

route('GET', '/api/flaky', (ctx) => {
  const p = projectFrom(ctx);
  return { projectId: p.id, window: Number(ctx.query.window) || 5, items: flakyTests(p.id, { window: ctx.query.window }) };
});

route('GET', '/api/runs/:id/results', (ctx) => {
  const r = repo.get('runs', ctx.params.id);
  if (!r) throw new HttpError(404, `Execution ${ctx.params.id} not found.`);
  const where = ['runId = $r']; const params = { r: r.id };
  inFilter(where, params, 'status', ctx.query.status, 'st');
  inFilter(where, params, 'priority', ctx.query.priority, 'pr');
  inFilter(where, params, 'testType', ctx.query.testType, 'tt');
  likeFilter(where, params, ['title', 'endpoint', 'testCaseId'], ctx.query.q);
  const page = paginate('run_results', ctx, { where, params, columns: 'id, runId, testCaseId, seq, title, method, endpoint, apiType, testType, priority, storyKey, status, statusCode, responseMs, sizeBytes, defectKey, correlationId, analysis, error, sfValidation', sortable: ['seq', 'status', 'responseMs', 'priority'], defaultSort: 'seq', defaultDir: 'ASC' });
  page.items = page.items.map((x) => ({ ...x, reason: x.status !== 'passed' ? (x.analysis && x.analysis.rootCause) || (x.error && x.error.title) || null : null, sfValidation: x.sfValidation ? x.sfValidation.status : null, analysis: x.analysis ? { category: x.analysis.category, classification: x.analysis.classification, defectCandidate: x.analysis.defectCandidate } : null, error: undefined }));
  return page;
});

route('GET', '/api/runs/:id/stream', (ctx) => {
  const r = repo.get('runs', ctx.params.id);
  if (!r) throw new HttpError(404, `Execution ${ctx.params.id} not found.`);
  const push = sse(ctx.res);
  push('snapshot', { run: { id: r.id, status: r.status, total: r.total, passed: r.passed, failed: r.failed, blocked: r.blocked, skipped: r.skipped }, active: runner.isActive(r.id) });
  const em = runner.getEmitter(r.id);
  if (!em || !runner.isActive(r.id)) { push('run-end', { status: r.status, counts: { passed: r.passed, failed: r.failed, blocked: r.blocked, skipped: r.skipped } }); ctx.res.end(); return; }
  const onEvent = (e) => { push(e.type, e); if (e.type === 'run-end') setTimeout(() => ctx.res.end(), 50); };
  em.on('event', onEvent);
  ctx.res.on('close', () => em.off('event', onEvent));
});

route('POST', '/api/runs/:id/stop', (ctx) => {
  const r = repo.get('runs', ctx.params.id);
  if (!r) throw new HttpError(404, `Execution ${ctx.params.id} not found.`);
  const ok = runner.stopRun(r.id);
  if (!ok) throw new HttpError(409, `Execution ${r.id} is not running (status ${r.status}).`);
  audit('execution', 'run.stop-requested', { user: ctx.user, projectId: r.projectId, detail: { runId: r.id } });
  return { stopping: true };
});

route('GET', '/api/runs/:id/analysis', async (ctx) => {
  const r = repo.get('runs', ctx.params.id);
  if (!r) throw new HttpError(404, `Execution ${ctx.params.id} not found.`);
  const results = repo.find('run_results', 'runId = $r', { r: r.id }, 'ORDER BY seq');
  const s = summarise(results);
  const p = getProject(r.projectId);
  // Regression recommendation: P0/P1 tests touching objects with failures.
  const failingObjects = [...new Set(results.filter((x) => x.status === 'failed').map((x) => (repo.get('test_cases', x.testCaseId) || {}).object).filter(Boolean))];
  const regression = failingObjects.length ? all(`SELECT id, title, priority, object FROM test_cases WHERE projectId = $p AND priority IN ('P0','P1') AND object IN (${failingObjects.map((_, i) => `$o${i}`).join(',')}) ORDER BY seq LIMIT 30`, { p: p.id, ...Object.fromEntries(failingObjects.map((o, i) => [`o${i}`, o])) }) : [];
  return { runId: r.id, ...s, aiSummary: (r.summary && r.summary.aiSummary) || null, regressionRecommendation: { label: 'RECOMMENDED', objects: failingObjects, tests: regression }, failures: results.filter((x) => x.status !== 'passed' && x.status !== 'skipped').map((x) => ({ resultId: x.id, testCaseId: x.testCaseId, title: x.title, status: x.status, statusCode: x.statusCode, analysis: x.analysis, defectKey: x.defectKey })) };
});

route('GET', '/api/results/:id', (ctx) => {
  const r = repo.get('run_results', ctx.params.id);
  if (!r) throw new HttpError(404, `Result ${ctx.params.id} not found.`);
  const tc = repo.get('test_cases', r.testCaseId);
  return { ...r, testCase: tc ? { id: tc.id, title: tc.title, storyKey: tc.storyKey, scenarioId: tc.scenarioId, label: tc.label } : null };
});

// ── API Explorer ──
route('POST', '/api/explorer/execute', async (ctx) => {
  const p = projectFrom(ctx);
  const lab = require('../engine/http-lab');
  try {
    return await lab.execute(p, ctx.body || {}, ctx.user);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(e.status || 502, e.message || (e.explanation && e.explanation.title) || 'Request failed', e.info || e.explanation || {});
  }
});

route('POST', '/api/explorer/generate-test', (ctx) => {
  const p = projectFrom(ctx);
  const b = ctx.body;
  const res = b.response || {};
  const assertions = [{ type: 'status', op: 'eq', expected: res.status || 200 }];
  if (res.timeMs) assertions.push({ type: 'responseTime', op: 'lt', expected: Math.max(1000, Math.ceil((res.timeMs * 3) / 100) * 100) });
  if (res.body && typeof res.body === 'object' && !Array.isArray(res.body)) {
    for (const k of Object.keys(res.body).slice(0, 4)) {
      if (k === 'attributes') continue;
      const v = res.body[k];
      assertions.push(['string', 'number', 'boolean'].includes(typeof v) && !/Date$|^Id$|^id$/.test(k) ? { type: 'jsonpath', path: `$.${k}`, op: 'eq', expected: v } : { type: 'jsonpath', path: `$.${k}`, op: 'exists' });
    }
  }
  if (Array.isArray(res.body) && res.body[0] && res.body[0].errorCode) assertions.push({ type: 'sfError', op: 'eq', expected: res.body[0].errorCode });
  let body = null; let bodyRaw = null;
  if (typeof b.body === 'string' && b.body.trim()) { try { body = JSON.parse(b.body); } catch { bodyRaw = b.body; } } else if (b.body && typeof b.body === 'object') body = b.body;
  const draft = {
    title: b.title || `${String(b.method || 'GET').toUpperCase()} ${String(b.path || '').split('?')[0].split('/').slice(-2).join('/')}`,
    apiType: b.apiType || (/^https?:\/\//i.test(String(b.path || '')) ? 'HTTP' : 'REST'), method: String(b.method || 'GET').toUpperCase(), endpoint: String(b.path || '').replace(`/v${p.apiVersion}/`, '/v{{apiVersion}}/'),
    query: b.query || {}, headers: b.headers || {}, body, bodyRaw, auth: b.auth || 'default', assertions,
    testType: (res.status || 200) >= 400 ? 'Negative' : 'Functional', label: 'ASSUMED', status: 'ready', storyKey: b.storyKey || null,
    description: 'Generated from an API Explorer request. Review assertions before adding to regression.',
  };
  draft.priority = prioritise(draft, { project: p }).priority;
  return draft;
});

route('GET', '/api/explorer/templates', (ctx) => {
  const v = '/services/data/v{{apiVersion}}';
  const { explorerTemplates } = require('../engine/endpoints');
  const { getProject } = require('./util');
  let projectOverlay = [];
  if (ctx.query.projectId) {
    try { projectOverlay = explorerTemplates(getProject(ctx.query.projectId)); } catch { projectOverlay = []; }
  }
  return [
    ...projectOverlay,
    { group: 'REST API', name: 'API versions', method: 'GET', path: '/services/data' },
    { group: 'REST API', name: 'Org limits', method: 'GET', path: `${v}/limits` },
    { group: 'REST API', name: 'Describe global', method: 'GET', path: `${v}/sobjects` },
    { group: 'REST API', name: 'Describe Contact', method: 'GET', path: `${v}/sobjects/Contact/describe` },
    { group: 'REST API', name: 'Create Contact', method: 'POST', path: `${v}/sobjects/Contact`, body: { FirstName: 'QA', LastName: 'Explorer {{$timestamp}}', Email: '{{$randomEmail}}' } },
    { group: 'REST API', name: 'SOQL query', method: 'GET', path: `${v}/query`, query: { q: 'SELECT Id, Name FROM Account ORDER BY Name LIMIT 5' } },
    { group: 'REST API', name: 'Upsert Account by External Id', method: 'PATCH', path: `${v}/sobjects/Account/External_Id__c/QA-EXPLORER-1`, body: { Name: 'QA Upsert Account' } },
    { group: 'Composite API', name: 'Composite: Account + Contact', method: 'POST', path: `${v}/composite`, body: { allOrNone: true, compositeRequest: [{ method: 'POST', url: `/services/data/v{{apiVersion}}/sobjects/Account`, referenceId: 'acct', body: { Name: 'QA Composite {{$timestamp}}' } }, { method: 'POST', url: `/services/data/v{{apiVersion}}/sobjects/Contact`, referenceId: 'con', body: { LastName: 'Composite', AccountId: '@{acct.id}' } }] } },
    { group: 'Composite API', name: 'sObject collection (2 records)', method: 'POST', path: `${v}/composite/sobjects`, body: { allOrNone: false, records: [{ attributes: { type: 'Account' }, Name: 'QA Coll 1' }, { attributes: { type: 'Account' }, Name: 'QA Coll 2' }] } },
    { group: 'Composite Graph API', name: 'Composite graph', method: 'POST', path: `${v}/composite/graph`, body: { graphs: [{ graphId: 'g1', compositeRequest: [{ method: 'POST', url: `/services/data/v{{apiVersion}}/sobjects/Account`, referenceId: 'a1', body: { Name: 'QA Graph' } }] }] } },
    { group: 'GraphQL API', name: 'GraphQL: first 5 Accounts', method: 'POST', path: `${v}/graphql`, body: { query: 'query { uiapi { query { Account(first: 5) { edges { node { Id Name { value } } } } } } }' } },
    { group: 'Bulk API 2.0', name: 'Create ingest job', method: 'POST', path: `${v}/jobs/ingest`, body: { object: 'Account', operation: 'insert', contentType: 'CSV', lineEnding: 'LF' } },
    { group: 'Bulk API 2.0', name: 'Upload CSV to a job (replace JOB_ID)', method: 'PUT', path: `${v}/jobs/ingest/JOB_ID/batches`, headers: { 'Content-Type': 'text/csv' }, body: 'FirstName,LastName,Email\nQA,Bulk One,bulk1@example.com\nQA,Bulk Two,bulk2@example.com\n', note: 'Replace JOB_ID with the id returned by "Create ingest job". Expect HTTP 201.' },
    { group: 'Bulk API 2.0', name: 'Close the job (replace JOB_ID)', method: 'PATCH', path: `${v}/jobs/ingest/JOB_ID`, body: { state: 'UploadComplete' } },
    { group: 'Bulk API 2.0', name: 'Job status (replace JOB_ID)', method: 'GET', path: `${v}/jobs/ingest/JOB_ID` },
    { group: 'Bulk API 2.0', name: 'Successful results (replace JOB_ID)', method: 'GET', path: `${v}/jobs/ingest/JOB_ID/successfulResults` },
    { group: 'Bulk API 2.0', name: 'Failed results (replace JOB_ID)', method: 'GET', path: `${v}/jobs/ingest/JOB_ID/failedResults` },
    { group: 'Bulk API 2.0', name: 'Unprocessed records (replace JOB_ID)', method: 'GET', path: `${v}/jobs/ingest/JOB_ID/unprocessedrecords` },
    { group: 'Bulk API 2.0', name: 'List ingest jobs', method: 'GET', path: `${v}/jobs/ingest` },
    { group: 'Tooling API', name: 'Tooling: Apex classes', method: 'GET', path: `${v}/tooling/query`, query: { q: 'SELECT Id, Name, ApiVersion, Status FROM ApexClass LIMIT 20' } },
    { group: 'Tooling API', name: 'Tooling: validation rules', method: 'GET', path: `${v}/tooling/query`, query: { q: 'SELECT Id, ValidationName, Active, EntityDefinitionId FROM ValidationRule LIMIT 50' } },
    { group: 'Platform Events', name: 'Publish Order_Event__e', method: 'POST', path: `${v}/sobjects/Order_Event__e`, body: { Order_Number__c: 'ORD-{{$timestamp}}', Status__c: 'Submitted', Amount__c: 199.99 } },
    { group: 'Apex REST', name: 'Contact sync (middleware → SF)', method: 'POST', path: '/services/apexrest/v1/contacts/sync', body: { externalId: 'MW-{{$uuid}}', firstName: 'Mia', lastName: 'Chen', email: '{{$randomEmail}}', accountNumber: 'ACC-1001' } },
    { group: 'Apex REST', name: 'Invoice (ERP → MuleSoft → SF)', method: 'POST', path: '/services/apexrest/v1/invoices', body: { invoiceNumber: 'INV-{{$timestamp}}', erpInvoiceId: 'SAP-{{$timestamp}}', accountExternalId: 'ERP-ACC-1001', amount: 2500, currency: 'USD', status: 'Issued' } },
    { group: 'Connect REST', name: 'Current user', method: 'GET', path: `${v}/chatter/users/me` },
    { group: 'OAuth', name: 'User info', method: 'GET', path: '/services/oauth2/userinfo' },
    { group: 'OAuth', name: 'Token: client credentials (replace placeholders)', method: 'POST', path: '/services/oauth2/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET', note: 'Replace the placeholders with your connected app values only for a one-off check — never save real secrets into templates or saved requests.' },
    { group: 'OAuth', name: 'Token: refresh token (replace placeholders)', method: 'POST', path: '/services/oauth2/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&client_id=YOUR_CLIENT_ID&refresh_token=YOUR_REFRESH_TOKEN', note: 'Placeholders only — do not store real refresh tokens here.' },
    { group: 'OAuth', name: 'Token: JWT bearer (replace placeholders)', method: 'POST', path: '/services/oauth2/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=YOUR_SIGNED_JWT', note: 'The assertion is a JWT signed with your connected app certificate; generate it outside the browser.' },
    { group: 'OAuth', name: 'Token: invalid grant_type (negative)', method: 'POST', path: '/services/oauth2/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=qa_not_a_grant&client_id=QA_PLACEHOLDER_CLIENT_ID', note: 'Expect HTTP 400 with error=unsupported_grant_type.' },
    { group: 'OAuth', name: 'Revoke a token (replace placeholder)', method: 'POST', path: '/services/oauth2/revoke', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=YOUR_ACCESS_OR_REFRESH_TOKEN' },
    { group: 'SOAP API', name: 'getServerTimestamp (partner)', method: 'POST', apiType: 'SOAP', path: '/services/Soap/u/{{apiVersion}}', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' }, body: '<?xml version="1.0" encoding="utf-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">\n  <soapenv:Header><urn:SessionHeader><urn:sessionId>{{sessionId}}</urn:sessionId></urn:SessionHeader></soapenv:Header>\n  <soapenv:Body><urn:getServerTimestamp/></soapenv:Body>\n</soapenv:Envelope>' },
    { group: 'SOAP API', name: 'query (partner)', method: 'POST', apiType: 'SOAP', path: '/services/Soap/u/{{apiVersion}}', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' }, body: '<?xml version="1.0" encoding="utf-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">\n  <soapenv:Header><urn:SessionHeader><urn:sessionId>{{sessionId}}</urn:sessionId></urn:SessionHeader></soapenv:Header>\n  <soapenv:Body><urn:query><urn:queryString>SELECT Id, Name FROM Account LIMIT 3</urn:queryString></urn:query></soapenv:Body>\n</soapenv:Envelope>' },
    { group: 'SOAP API', name: 'Apex SOAP web service (replace ClassName / method)', method: 'POST', apiType: 'SOAP', path: '/services/Soap/class/ClassName', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' }, body: '<?xml version="1.0" encoding="utf-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cls="http://soap.sforce.com/schemas/class/ClassName">\n  <soapenv:Header><cls:SessionHeader><cls:sessionId>{{sessionId}}</cls:sessionId></cls:SessionHeader></soapenv:Header>\n  <soapenv:Body><cls:methodName><cls:arg>value</cls:arg></cls:methodName></soapenv:Body>\n</soapenv:Envelope>', note: 'Apex SOAP: an Apex class exposing `webservice static` methods. Replace ClassName and methodName with your own class — the WSDL is available from Setup → Apex Classes → Generate WSDL.' },
    { group: 'Change Data Capture', name: 'CDC: subscribe via Pub/Sub API', method: 'GET', path: `${v}/sobjects/ContactChangeEvent/describe`, note: 'CDC/Platform Event subscription uses the gRPC Pub/Sub API, which is outside this HTTP explorer. Use this describe to verify the channel exists, then validate downstream effects with SOQL.' },
    { group: 'Metadata API', name: 'Metadata API (SOAP)', method: 'POST', apiType: 'SOAP', path: '/services/Soap/m/{{apiVersion}}', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' }, body: '<?xml version="1.0" encoding="utf-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">\n  <soapenv:Header><met:SessionHeader><met:sessionId>{{sessionId}}</met:sessionId></met:SessionHeader></soapenv:Header>\n  <soapenv:Body><met:listMetadata><met:queries><met:type>CustomObject</met:type></met:queries><met:asOfVersion>{{apiVersion}}</met:asOfVersion></met:listMetadata></soapenv:Body>\n</soapenv:Envelope>' },
    { group: 'Commerce Cloud OCAPI', name: 'OCAPI: product search (live catalog)', method: 'GET', apiType: 'OCAPI', path: '/s/{{ccSiteId}}/dw/shop/v24_5/product_search', query: { q: 'a', count: 8 } },
    { group: 'Commerce Cloud OCAPI', name: 'OCAPI: get product by id from search', method: 'GET', apiType: 'OCAPI', path: '/s/{{ccSiteId}}/dw/shop/v24_5/products/{{ocapiProductId}}', note: 'Set ocapiProductId from a product_search hit — do not invent a SKU.' },
    { group: 'Commerce Cloud OCAPI', name: 'OCAPI: create basket', method: 'POST', apiType: 'OCAPI', path: '/s/{{ccSiteId}}/dw/shop/v24_5/baskets', body: {} },
    { group: 'Commerce Cloud SCAPI', name: 'SCAPI: shopper product search', method: 'GET', apiType: 'SCAPI', path: '/search/shopper-search/v1/organizations/{{ccOrgId}}/product-search', query: { q: 'a', limit: 8 } },
    { group: 'Commerce Cloud SCAPI', name: 'SCAPI: shopper product by id', method: 'GET', apiType: 'SCAPI', path: '/product/shopper-products/v1/organizations/{{ccOrgId}}/products/{{scapiProductId}}' },
    { group: 'Commerce Cloud SCAPI', name: 'SLAS: client credentials token', method: 'POST', apiType: 'SCAPI', path: '/shopper/auth/v1/organizations/{{ccOrgId}}/oauth2/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', note: 'Client id/secret are injected from SFCC_<PREFIX>_* — do not paste them here. Browser login is not a SLAS token.' },
    { group: 'Experience Cloud', name: 'Connect REST: list communities', method: 'GET', path: `${v}/connect/communities` },
    { group: 'B2B Commerce', name: 'Commerce API: list web stores', method: 'GET', path: `${v}/commerce/webstores` },
    { group: 'Frontend HTTP', name: 'GET frontend origin', method: 'GET', apiType: 'HTTP', path: '{{httpBaseUrl}}/', note: 'Set the frontend base URL on Connections → Postman / HTTP.' },
    { group: 'Frontend HTTP', name: 'GET absolute URL (example)', method: 'GET', apiType: 'HTTP', path: 'https://httpbin.org/get', note: 'Replace with your BFF / middleware URL. Auth token comes from HTTP_<PREFIX>_TOKEN if set.' },
  ];
});

module.exports = { selectTests, withDependencies };
