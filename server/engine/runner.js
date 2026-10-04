'use strict';
/**
 * Test execution engine. Runs in the background, streams progress via an
 * EventEmitter (exposed over SSE), persists masked evidence, performs
 * Salesforce data validation and cleans up test data in non-production orgs.
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { repo, now, nextId, audit, all } = require('../db');
const { salesforceFor } = require('../connectors');
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
  const emit = (e) => state.emitter.emit('event', { runId: run.id, ...e });
  const vars = {
    apiVersion: project.apiVersion, runId: run.id.slice(-6), instanceUrl: project.instanceUrl || '', environment: project.environment,
    ...(((project.testDataConfig || {}).variables) || {}),
  };
  const varSource = {}; // var -> testCase id that produced it
  const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0, apiErrors: 0, sfErrors: 0 };
  const created = [];
  const timings = [];
  const contractCache = {};
  emit({ type: 'run-start', total: testCases.length, environment: project.environment, demo: project.mode === 'demo' });

  if (!sf.available) {
    emit({ type: 'notice', level: 'warning', message: require('../config').SF_UNAVAILABLE_MESSAGE });
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
    const r = await executeOne({ tc, base, sf, project, vars, varSource, run, created, contractCache });
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

  // Cleanup test data (never in production).
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
  state.done = true;
  emit({ type: 'run-end', status: finalStatus, counts, avgResponseMs: avg, cleanup });
  setTimeout(() => active.delete(run.id), 5 * 60 * 1000).unref();
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
  const endpoint = interpolate(tc.endpoint, reqVars, missing);
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
  if (!sf.available) return blockedResult(base, { ...sf.unavailableExplanation(), category: 'configuration' });

  // 4. Execute
  let res;
  const reqRecord = { method: tc.method, url: endpoint, apiType: tc.apiType, auth: tc.auth, headers: maskHeaders(headers), query, body: maskDeep(body !== undefined ? body : bodyRaw) };
  try {
    res = await sf.request({ method: tc.method, path: endpoint, headers, query, body, bodyRaw, auth: tc.auth, apiType: tc.apiType === 'SOAP' ? 'SOAP' : tc.apiType, timeoutMs: tc.timeoutMs });
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
