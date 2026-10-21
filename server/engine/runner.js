'use strict';
/**
 * Test execution engine. Runs in the background, streams progress via an
 * EventEmitter (exposed over SSE), persists masked evidence, performs
 * Salesforce data validation and cleans up test data in non-production orgs.
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { repo, now, nextId, audit, all, get } = require('../db');
const { salesforceFor, commerceFor, connectorFor, isCommerceRequest, isHttpRequest, httpFor, postmanFor } = require('../connectors');
const { restApiOrigin, ensureSalesforceRestPath } = require('../connectors/salesforce-org');
const { interpolate } = require('../lib/template');
const { maskDeep, maskHeaders, maskText } = require('../lib/mask');
const { explainResponse } = require('../lib/errors');
const { evaluate } = require('./assertions');
const { validateRecord } = require('./validator');
const { analyse, summarise } = require('./analyzer');
const { checkOperation, isProduction } = require('./safety');
const contracts = require('./contracts');
const ai = require('./ai');

const active = new Map(); // runId -> { emitter, stopRequested, done }
const MAX_BODY = 200 * 1024;

function truncateBody(body, text) {
  if (text && text.length > MAX_BODY) return { truncated: true, preview: text.slice(0, MAX_BODY), originalSize: text.length };
  return body;
}

function getEmitter(runId) {
  const a = active.get(runId);
  return a ? a.emitter : null;
}

function isActive(runId) {
  const a = active.get(runId);
  return Boolean(a && !a.done);
}

function stopRun(runId) {
  const a = active.get(runId);
  if (!a || a.done) return false;
  a.stopRequested = true;
  a.emitter.emit('event', { type: 'stopping', runId });
  return true;
}

/**
 * Start a run. Returns the run row immediately; execution continues async.
 * @param {object} p { project, testCases, user, options: {confirmProductionWrites, confirmDelete, label, trigger}, backdate }
 */
function startRun({ project, testCases, user, options = {} }) {
  const id = `EX-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const ordered = [...testCases].sort((a, b) => a.seq - b.seq);
  const run = {
    id, projectId: project.id, environment: project.environment, user, label: options.label || null, trigger: options.trigger || 'manual',
    status: 'running', startedAt: now(), total: ordered.length, passed: 0, failed: 0, blocked: 0, skipped: 0, apiErrors: 0, sfErrors: 0,
    options: { confirmProductionWrites: Boolean(options.confirmProductionWrites), confirmDelete: Boolean(options.confirmDelete), testCaseIds: ordered.map((t) => t.id), filter: options.filter || null },
    jiraActivity: [], createdRecords: [],
  };
  repo.insert('runs', run);
  audit('execution', 'run.started', { user, projectId: project.id, detail: { runId: id, total: run.total, trigger: run.trigger, environment: project.environment } });
  try { require('./workflow').touch(project.id, 'execute', 'in_progress', { runId: id }); } catch { /* non-fatal */ }
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const state = { emitter, stopRequested: false, done: false };
  active.set(id, state);
  setImmediate(() => execute(run, project, ordered, state).catch((e) => {
    console.error('[runner] run crashed', e);
    repo.update('runs', id, { status: 'error', endedAt: now(), summary: { error: e.message } });
    state.done = true;
    emitter.emit('event', { type: 'run-end', runId: id, status: 'error', error: e.message });
  }));
  return run;
}

async function execute(run, project, testCases, state) {
  const sf = salesforceFor(project);
  const commerce = commerceFor(project);
  const emit = (e) => state.emitter.emit('event', { runId: run.id, ...e });
  const cc = (project.integrationConfig && project.integrationConfig.commerce) || {};
  const httpCfg = (project.integrationConfig && project.integrationConfig.http) || {};
  const userVars = { ...(((project.testDataConfig || {}).variables) || {}) };
  const looksLikeSfId = (v) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(String(v || ''));
  if (userVars.siteId && !looksLikeSfId(userVars.siteId)) {
    userVars.ccSiteId = userVars.ccSiteId || userVars.siteId;
    delete userVars.siteId;
  }
  if (userVars.orgId && !looksLikeSfId(userVars.orgId) && !/^00D/i.test(String(userVars.orgId))) {
    userVars.ccOrgId = userVars.ccOrgId || userVars.orgId;
    delete userVars.orgId;
  }
  const vars = {
    apiVersion: project.apiVersion, runId: run.id.slice(-6),
    instanceUrl: restApiOrigin(project.instanceUrl) || project.instanceUrl || '',
    environment: project.environment,
    ccSiteId: cc.siteId || userVars.ccSiteId || (project.mode === 'demo' ? 'RefArch' : ''),
    ccOrgId: cc.orgId || userVars.ccOrgId || '',
    ccShortCode: cc.shortCode || userVars.ccShortCode || userVars.shortCode || '',
    ocapiVersion: cc.ocapiVersion || 'v24_5',
    httpBaseUrl: String(httpCfg.baseUrl || '').replace(/\/$/, ''),
    ...userVars,
  };
  const varSource = {}; // var -> testCase id that produced it
  const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0, apiErrors: 0, sfErrors: 0 };
  const created = [];
  const timings = [];
  const contractCache = {};
  emit({ type: 'run-start', total: testCases.length, environment: project.environment, demo: project.mode === 'demo' });

  const pm = postmanFor(project);
  const usePostmanMcp = pm.canExecute && project.mode !== 'demo';
  if (usePostmanMcp) {
    try {
      await executeViaPostman({ run, project, testCases, state, pm, emit, counts, timings, created });
      await finishRun(run, project, testCases, state, { emit, counts, timings, created, sf });
      return;
    } catch (e) {
      const started = get('SELECT COUNT(*) AS n FROM run_results WHERE runId = $r', { r: run.id }).n;
      emit({
        type: 'notice',
        level: 'warning',
        message: `Postman MCP could not run this collection (${(e.explanation && e.explanation.title) || e.message}).${started ? ' Results already recorded from Postman are kept.' : ' Falling back to the platform runner.'}`,
      });
      if (started) {
        await finishRun(run, project, testCases, state, { emit, counts, timings, created, sf });
        return;
      }
    }
  } else if (project.mode !== 'demo' && (pm.settings.url || pm.settings.command || pm.settings.apiKeyPresent)) {
    emit({
      type: 'notice',
      level: 'warning',
      message: 'Postman MCP is configured but not reachable. Running tests in the platform instead. Test Postman on Connections, then retry.',
    });
  }

  if (!sf.available && testCases.some((t) => !isCommerceRequest(t) && !isHttpRequest(t))) {
    emit({ type: 'notice', level: 'warning', message: require('../config').SF_UNAVAILABLE_MESSAGE });
  }
  if (!commerce.available && testCases.some((t) => isCommerceRequest(t))) {
    emit({ type: 'notice', level: 'warning', message: commerce.unavailableExplanation().title });
  }
  const http = httpFor(project);
  if (!http.available && testCases.some((t) => isHttpRequest(t) && !/^https?:\/\//i.test(String(t.endpoint || '')))) {
    emit({ type: 'notice', level: 'warning', message: http.unavailableExplanation().title });
  }

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const resultId = `${run.id}-${String(i + 1).padStart(4, '0')}`;
    const base = {
      id: resultId, runId: run.id, projectId: project.id, testCaseId: tc.id, seq: i + 1, title: tc.title, method: tc.method,
      endpoint: tc.endpoint, apiType: tc.apiType, testType: tc.testType, priority: tc.priority, storyKey: tc.storyKey, startedAt: now(),
    };
    if (state.stopRequested) {
      const r = { ...base, status: 'skipped', error: { title: 'Execution stopped by user before this test ran.', category: 'stopped' }, endedAt: now() };
      repo.insert('run_results', r);
      counts.skipped++;
      emit({ type: 'test-result', index: i, result: slim(r), counts });
      continue;
    }
    emit({ type: 'test-start', index: i, testCaseId: tc.id, title: tc.title });
    const r = await executeOne({ tc, base, sf: connectorFor(project, tc), project, vars, varSource, run, created, contractCache });
    if (r.responseMs) timings.push(r.responseMs);
    counts[r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : r.status === 'blocked' ? 'blocked' : 'skipped']++;
    if (r.error && r.error.category && ['environment', 'configuration', 'authentication'].includes(r.error.category)) counts.apiErrors++;
    if (r.sfValidation && ['FAIL', 'ERROR'].includes(r.sfValidation.status)) counts.sfErrors++;
    r.analysis = analyse(r, tc);
    r.endedAt = now();
    repo.insert('run_results', r);
    repo.update('test_cases', tc.id, { lastRunAt: r.endedAt, lastResult: r.status, lastResponseMs: r.responseMs || null });
    repo.update('runs', run.id, { ...counts });
    emit({ type: 'test-result', index: i, result: slim(r), counts });
  }

  await finishRun(run, project, testCases, state, { emit, counts, timings, created, sf });
}

async function executeViaPostman({ run, project, testCases, state, pm, emit, counts, timings, created }) {
  emit({ type: 'notice', level: 'info', message: 'Executing via Postman MCP.' });
  let accessToken;
  try {
    const sf = salesforceFor(project);
    if (typeof sf.token === 'function' && sf.available) {
      const t = await sf.token();
      accessToken = t && t.accessToken;
    }
  } catch { /* collection prerequest / Postman env may still authenticate */ }
  const mcp = await pm.runApproved(testCases, { accessToken, runId: run.id });
  accessToken = undefined;
  repo.update('runs', run.id, { options: { ...(run.options || {}), executor: 'postman-mcp', collectionId: mcp.collectionId || null } });
  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const resultId = `${run.id}-${String(i + 1).padStart(4, '0')}`;
    const base = {
      id: resultId, runId: run.id, projectId: project.id, testCaseId: tc.id, seq: i + 1, title: tc.title, method: tc.method,
      endpoint: tc.endpoint, apiType: tc.apiType, testType: tc.testType, priority: tc.priority, storyKey: tc.storyKey, startedAt: now(),
    };
    emit({ type: 'test-start', index: i, testCaseId: tc.id, title: tc.title });
    const mapped = (mcp.results && mcp.results[i]) || {
      status: 'blocked',
      error: { title: 'Postman MCP did not return a result for this test.', category: 'environment' },
      assertions: [],
    };
    const r = { ...base, ...mapped, endedAt: now() };
    r.analysis = analyse(r, tc);
    if (r.responseMs) timings.push(r.responseMs);
    counts[r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : r.status === 'blocked' ? 'blocked' : 'skipped']++;
    if (r.error && r.error.category && ['environment', 'configuration', 'authentication'].includes(r.error.category)) counts.apiErrors++;
    repo.insert('run_results', r);
    repo.update('test_cases', tc.id, { lastRunAt: r.endedAt, lastResult: r.status, lastResponseMs: r.responseMs || null });
    repo.update('runs', run.id, { ...counts });
    emit({ type: 'test-result', index: i, result: slim(r), counts });
  }
}

async function finishRun(run, project, testCases, state, { emit, counts, timings, created, sf }) {
  const cleanup = { attempted: 0, deleted: 0, errors: [] };
  const autoCleanup = ((project.testDataConfig || {}).autoCleanup) !== false;
  if (created.length && autoCleanup && !isProduction(project) && sf.available) {
    emit({ type: 'cleanup-start', count: created.length });
    const ids = [...new Set(created.map((c) => c.id))].reverse();
    for (let k = 0; k < ids.length; k += 200) {
      const chunk = ids.slice(k, k + 200);
      cleanup.attempted += chunk.length;
      try {
        const res = await sf.request({ method: 'DELETE', path: `/services/data/v${project.apiVersion}/composite/sobjects`, query: { ids: chunk.join(','), allOrNone: 'false' } });
        if (res.status === 200 && Array.isArray(res.body)) cleanup.deleted += res.body.filter((x) => x.success).length;
        else cleanup.errors.push(`HTTP ${res.status}`);
      } catch (e) {
        cleanup.errors.push(e.explanation ? e.explanation.title : e.message);
      }
    }
  } else if (created.length && isProduction(project)) {
    cleanup.errors.push('Production: records are never deleted automatically. Review created records manually.');
  }

  const results = all('SELECT * FROM run_results WHERE runId = $r ORDER BY seq', { r: run.id }).map((x) => require('../db').decode('run_results', x));
  const summary = summarise(results);
  summary.cleanup = cleanup;
  summary.p95Ms = percentile(timings, 95);
  summary.p50Ms = percentile(timings, 50);
  if (ai.enabled() && counts.failed) {
    summary.aiSummary = await ai.summariseRun({ ...run, ...counts }, results.filter((x) => x.status === 'failed')).catch(() => null);
  }
  const finalStatus = state.stopRequested ? 'stopped' : 'completed';
  const avg = timings.length ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) : null;
  repo.update('runs', run.id, { ...counts, status: finalStatus, endedAt: now(), avgResponseMs: avg, summary, createdRecords: created.slice(0, 500) });
  audit('execution', 'run.finished', { user: run.user, projectId: project.id, detail: { runId: run.id, status: finalStatus, ...counts } });
  try {
    const wf = require('./workflow');
    wf.touch(project.id, 'execute', finalStatus === 'completed' ? 'completed' : 'failed', { runId: run.id, ...counts });
    wf.touch(project.id, 'validate', counts.sfErrors ? 'failed' : 'completed', { sfErrors: counts.sfErrors });
    wf.touch(project.id, 'analysis', 'completed', { failed: counts.failed });
    wf.touch(project.id, 'report', 'completed', { runId: run.id });
  } catch { /* non-fatal */ }
  state.done = true;
  emit({ type: 'run-end', status: finalStatus, counts, avgResponseMs: avg, cleanup });
  setTimeout(() => active.delete(run.id), 5 * 60 * 1000).unref();
}

const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
/** Collect ids of records created by a composite/graph response (skips failed sub-responses). */
function createdIdsFrom(node, out = []) {
  if (Array.isArray(node)) { for (const x of node) createdIdsFrom(x, out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.httpStatusCode === 'number' && node.httpStatusCode >= 300) return out;
  if (typeof node.id === 'string' && SF_ID.test(node.id) && node.success !== false && node.created !== false) out.push(node.id);
  for (const [k, v] of Object.entries(node)) if (k !== 'id' && v && typeof v === 'object') createdIdsFrom(v, out);
  return out;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

function slim(r) {
  return {
    id: r.id, seq: r.seq, testCaseId: r.testCaseId, title: r.title, method: r.method, endpoint: r.endpoint, status: r.status,
    statusCode: r.statusCode || null, responseMs: r.responseMs || null, priority: r.priority, testType: r.testType,
    failedAssertions: (r.assertions || []).filter((a) => a.result === 'FAIL').length,
    sfValidation: r.sfValidation ? r.sfValidation.status : null, defectKey: r.defectKey || null,
    reason: r.status !== 'passed' ? (r.analysis && r.analysis.rootCause) || (r.error && r.error.title) || null : null,
  };
}

function blockedResult(base, explanation) {
  return { ...base, status: 'blocked', error: explanation, assertions: [] };
}

async function executeOne({ tc, base, sf, project, vars, varSource, run, created, contractCache }) {
  // 1. Draft / recommended tests are not executable.
  if (tc.status === 'draft') {
    return blockedResult(base, { title: 'Test is a draft (RECOMMENDED) and needs configuration before it can run.', cause: tc.description || 'Missing configuration.', action: 'Complete the configuration described on the test case and set its status to Ready.', category: 'configuration', evidence: [] });
  }
  // 2. Production safety
  const safety = checkOperation(project, tc, run.options || {});
  if (safety) return blockedResult(base, safety);

  // 3. Interpolate
  const missing = new Set();
  const body = tc.bodyRaw ? undefined : interpolate(tc.body, vars, missing);
  const bodyRaw = tc.bodyRaw ? interpolate(tc.bodyRaw, vars, missing) : undefined;
  const reqVars = { ...vars, req: body && typeof body === 'object' ? body : {} };
  let endpoint = interpolate(tc.endpoint, reqVars, missing);
  if (!isCommerceRequest({ ...tc, endpoint }) && !isHttpRequest({ ...tc, endpoint })) {
    endpoint = ensureSalesforceRestPath(endpoint, vars.apiVersion || project.apiVersion);
  }
  const headers = interpolate(tc.headers || {}, reqVars, missing);
  const query = interpolate(tc.query || {}, reqVars, missing);
  const unresolved = [...missing].filter((m) => !m.startsWith('$') && m !== 'accessToken' && m !== 'sessionId');
  if (unresolved.length) {
    const producers = unresolved.map((v) => varSource[v] ? `${v} ← ${varSource[v]}` : `${v} ← (no earlier test extracts it)`);
    return blockedResult(base, {
      title: `Blocked: variable ${unresolved.map((v) => `{{${v}}}`).join(', ')} was not produced by an earlier test.`,
      cause: 'This test depends on a value captured from an upstream test that failed, was skipped, or was not selected in this run.',
      action: 'Run the full suite (or include the upstream test) and fix the upstream failure first.', category: 'dependency', evidence: producers,
    });
  }
  if (!sf.available && !/^https?:\/\//i.test(endpoint)) return blockedResult(base, { ...sf.unavailableExplanation(), category: 'configuration' });

  // 4. Execute
  let res;
  const reqRecord = { method: tc.method, url: endpoint, apiType: tc.apiType, auth: tc.auth, headers: maskHeaders(headers), query, body: maskDeep(body !== undefined ? body : bodyRaw) };
  try {
    const reqArgs = { method: tc.method, path: endpoint, headers, query, body, bodyRaw, auth: tc.auth, apiType: tc.apiType === 'SOAP' ? 'SOAP' : tc.apiType, timeoutMs: tc.timeoutMs };
    res = await sf.request(reqArgs);
    // Asynchronous Salesforce work (Bulk 2.0 jobs …): tests tagged `poll` re-issue the request until
    // their assertions pass (up to 15 × 2 s). Live orgs only — the demo simulator answers immediately.
    if ((tc.tags || []).includes('poll') && project.mode !== 'demo') {
      for (let i = 0; i < 15; i++) {
        const interim = evaluate(interpolate(tc.assertions || [], reqVars, new Set()), res);
        if (!interim.some((a) => a.result === 'FAIL')) break;
        await new Promise((r) => setTimeout(r, 2000));
        res = await sf.request(reqArgs);
      }
    }
  } catch (e) {
    const ex = e.explanation || { title: e.message, category: 'environment', evidence: [], action: 'Check connectivity.' };
    if (ex.code === 'LOW_PRIVILEGE_USER_NOT_CONFIGURED') return blockedResult({ ...base, request: reqRecord }, ex);
    return { ...base, status: 'failed', request: { ...reqRecord, url: e.url || endpoint }, responseMs: e.timeMs || null, error: ex, assertions: [] };
  }
  reqRecord.url = res.url;
  reqRecord.headers = maskHeaders(res.requestHeaders || headers);
  const response = { status: res.status, headers: maskHeaders(res.headers), body: maskDeep(truncateBody(res.body, res.text)), timeMs: res.timeMs, sizeBytes: res.sizeBytes };

  // 5. Assertions (expected values may reference variables)
  const assertions = interpolate(tc.assertions || [], reqVars, new Set());
  const assertionResults = evaluate(assertions, res);

  // 6. Extract variables for downstream tests
  for (const ex of tc.extract || []) {
    try {
      const { getPath } = require('../lib/template');
      const v = getPath(res.body, ex.path);
      if (v !== undefined && v !== null) { vars[ex.var] = v; varSource[ex.var] = `${tc.id} ${tc.title}`; }
    } catch { /* ignore bad path */ }
  }
  // 7. Track created records for cleanup
  if (tc.cleanup && res.status < 300) {
    if (tc.cleanup.fromCompositeResponse && Array.isArray(res.body)) {
      for (const x of res.body) if (x && x.success && x.id) created.push({ object: tc.cleanup.object, id: x.id, testCaseId: tc.id });
    } else if (tc.cleanup.fromResponse) {
      // Composite / graph responses: every successful (2xx) sub-response that returned a record id.
      for (const id of createdIdsFrom(res.body)) created.push({ object: tc.cleanup.object, id, testCaseId: tc.id });
    } else if (tc.cleanup.fromBulkResults) {
      // Bulk 2.0 successfulResults CSV: rows with sf__Created=true were inserted by this job.
      const parsed = require('../lib/csv').parse(typeof res.body === 'string' ? res.body : res.text || '');
      for (const r of parsed.records) if (r.sf__Id && String(r.sf__Created).toLowerCase() === 'true') created.push({ object: tc.cleanup.object, id: r.sf__Id, testCaseId: tc.id });
    } else if (tc.cleanup.idVar && vars[tc.cleanup.idVar] && varSource[tc.cleanup.idVar] && varSource[tc.cleanup.idVar].startsWith(tc.id)) {
      created.push({ object: tc.cleanup.object, id: vars[tc.cleanup.idVar], testCaseId: tc.id });
    }
  }

  // 8. Salesforce data validation
  let sfValidation = null;
  const statusOk = assertionResults.filter((a) => a.type === 'status').every((a) => a.result === 'PASS');
  if (tc.sfValidation && statusOk && res.status < 300) {
    const spec = tc.sfValidation;
    const id = spec.idVar ? vars[spec.idVar] : spec.id;
    sfValidation = await validateRecord(sf, { object: spec.object, id, expected: interpolate(spec.expected || {}, reqVars, new Set()), related: spec.related });
    sfValidation.label = project.mode === 'demo' ? 'ASSUMED' : 'VERIFIED';
  }

  // 9. Contract validation
  let contract = null;
  if (tc.contractRef && tc.contractRef.contractId) {
    try {
      contract = contracts.validateAgainst(tc.contractRef.contractId, contractCache, { method: tc.method, path: res.url, status: res.status, headers: res.headers, body: res.body, requestBody: body });
    } catch (e) { contract = { status: 'ERROR', violations: [{ rule: 'contract', message: e.message }] }; }
  }

  const failed = assertionResults.some((a) => a.result === 'FAIL') || (sfValidation && ['FAIL'].includes(sfValidation.status)) || (contract && contract.status === 'FAIL');
  const error = res.status >= 400 && failed ? explainResponse({ status: res.status, body: res.body, method: tc.method, url: res.url }) : null;
  return {
    ...base, status: failed ? 'failed' : 'passed', statusCode: res.status, responseMs: res.timeMs, sizeBytes: res.sizeBytes,
    request: reqRecord, response, assertions: assertionResults, sfValidation, contract, error, correlationId: res.correlationId ? maskText(res.correlationId) : null,
  };
}

/** Resolve when a run finishes (used by seeding, CLI and tests). */
function waitForRun(runId) {
  return new Promise((resolve) => {
    const a = active.get(runId);
    if (!a || a.done) return resolve(repo.get('runs', runId));
    a.emitter.on('event', (e) => { if (e.type === 'run-end') setImmediate(() => resolve(repo.get('runs', runId))); });
  });
}

module.exports = { startRun, stopRun, getEmitter, isActive, executeOne, waitForRun };
