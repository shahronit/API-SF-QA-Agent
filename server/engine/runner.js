'use strict';
/**
 * Test execution engine. Runs in the background, streams progress via an
 * EventEmitter (exposed over SSE), persists masked evidence, performs
 * Salesforce data validation and cleans up test data in non-production orgs.
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { repo, now, audit, all, get } = require('../db');
const { salesforceFor, commerceFor, connectorFor, isCommerceRequest, isHttpRequest, httpFor, postmanFor, playwrightFor } = require('../connectors');
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
const { seedFromProject, seedOrgFromSalesforce, seedAuthVars, knownFallback, applyCommerceOrg } = require('./run-vars');
const envs = require('./environments');
const { inferHttpOriginForProject, persistHttpOrigin } = require('./collection-import');
const bodyEncode = require('./body-encode');

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
    options: {
      confirmProductionWrites: Boolean(options.confirmProductionWrites),
      confirmDelete: Boolean(options.confirmDelete),
      testCaseIds: ordered.map((t) => t.id),
      filter: options.filter || null,
      executor: options.executor || 'auto',
      postResultToJira: Boolean(options.postResultToJira),
      storyKeys: Array.isArray(options.storyKeys) ? options.storyKeys.filter(Boolean).slice(0, 20) : undefined,
      proposalId: options.proposalId || null,
      traceability: options.traceability || null,
    },
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
    try { require('./jira-result').maybeComment(id).catch(() => {}); } catch { /* non-fatal */ }
  }));
  return run;
}

async function execute(run, project, testCases, state) {
  const sf = salesforceFor(project);
  const commerce = commerceFor(project);
  const emit = (e) => state.emitter.emit('event', { runId: run.id, ...e });
  const cc = (project.integrationConfig && project.integrationConfig.commerce) || {};
  const httpCfg = (project.integrationConfig && project.integrationConfig.http) || {};
  const activeEnv = envs.active(project.id);
  const colUid = ((project.integrationConfig || {}).postman || {}).collectionId || project.postmanCollection;
  const storedCol = colUid ? repo.one('collections', 'projectId = $p AND uid = $u', { p: project.id, u: colUid }) : null;
  const userVars = seedFromProject(project, {
    environmentVars: envs.valuesToMap(activeEnv && (activeEnv.values || activeEnv.envValues)),
    collectionVars: storedCol ? envs.collectionVars(storedCol) : {},
  });
  const looksLikeSfId = (v) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(String(v || ''));
  if (userVars.siteId && !looksLikeSfId(userVars.siteId)) {
    userVars.ccSiteId = userVars.ccSiteId || userVars.siteId;
    delete userVars.siteId;
  }
  if (userVars.orgId && !/^00D/i.test(String(userVars.orgId))) {
    userVars.ccOrgId = userVars.ccOrgId || userVars.orgId;
  }
  applyCommerceOrg(userVars, project);
  await seedOrgFromSalesforce(userVars, sf);
  const inferredHttp = inferHttpOriginForProject(project, testCases);
  if (inferredHttp) persistHttpOrigin(project, inferredHttp);
  await seedAuthVars(userVars, project, sf);
  const httpCfgLive = (project.integrationConfig && project.integrationConfig.http) || httpCfg;
  const sfBase = restApiOrigin(project.instanceUrl) || project.instanceUrl || '';
  const httpBase = String(httpCfgLive.baseUrl || userVars.httpBaseUrl || inferredHttp || '').replace(/\/$/, '');
  const vars = {
    apiVersion: project.apiVersion, runId: run.id.slice(-6),
    instanceUrl: sfBase,
    environment: project.environment,
    ccSiteId: cc.siteId || userVars.ccSiteId || (project.mode === 'demo' ? 'RefArch' : ''),
    ccOrgId: cc.orgId || userVars.ccOrgId || '',
    ccShortCode: cc.shortCode || userVars.ccShortCode || userVars.shortCode || '',
    ocapiVersion: cc.ocapiVersion || 'v24_5',
    httpBaseUrl: httpBase,
    baseUrl: sfBase || userVars.baseUrl || httpBase,
    ...userVars,
    httpBaseUrl: httpBase || userVars.httpBaseUrl || '',
  };
  const varSource = {}; // var -> testCase id that produced it
  const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0, apiErrors: 0, sfErrors: 0 };
  const created = [];
  const timings = [];
  const contractCache = {};
  emit({ type: 'run-start', total: testCases.length, environment: project.environment, demo: project.mode === 'demo' });

  const executor = String((run.options && run.options.executor) || 'auto').toLowerCase();
  const pm = postmanFor(project);
  const pw = playwrightFor(project);

  if (executor === 'playwright') {
    if (project.mode === 'demo') {
      emit({ type: 'notice', level: 'info', message: 'Demo projects use the platform simulator. Playwright MCP is skipped.' });
    } else if (!pw.canExecute) {
      await blockAll(run, project, testCases, state, { emit, counts, timings, created, sf, explanation: pw.unavailableExplanation() });
      return;
    } else {
      emit({ type: 'notice', level: 'info', message: 'Executing via Playwright MCP (API request tools).' });
      repo.update('runs', run.id, { options: { ...(run.options || {}), executor: 'playwright-mcp' } });
      await executeOnPlatform(run, project, testCases, state, { emit, counts, timings, created, sf, vars, varSource, contractCache, transport: pw });
      await finishRun(run, project, testCases, state, { emit, counts, timings, created, sf });
      return;
    }
  } else if (executor === 'postman') {
    if (project.mode === 'demo') {
      emit({ type: 'notice', level: 'info', message: 'Demo projects use the platform simulator. Postman MCP is skipped.' });
    } else if (!pm.canExecute) {
      await blockAll(run, project, testCases, state, { emit, counts, timings, created, sf, explanation: pm.unavailableExplanation() });
      return;
    } else {
      try {
        await executeViaPostman({ run, project, testCases, state, pm, emit, counts, timings, created });
        await finishRun(run, project, testCases, state, { emit, counts, timings, created, sf });
        return;
      } catch (e) {
        await blockAll(run, project, testCases, state, {
          emit, counts, timings, created, sf,
          explanation: e.explanation || { title: e.message, category: 'environment', action: 'Test Postman on Connections, then retry.' },
        });
        return;
      }
    }
  } else if (executor !== 'platform') {
    const usePostmanMcp = pm.canExecute && project.mode !== 'demo';
    if (usePostmanMcp) {
      try {
        await executeViaPostman({ run, project, testCases, state, pm, emit, counts, timings, created });
        await finishRun(run, project, testCases, state, { emit, counts, timings, created, sf });
        return;
      } catch (e) {
        const started = get('SELECT COUNT(*) AS n FROM run_results WHERE runId = $r', { r: run.id }).n;
        const title = (e.explanation && e.explanation.title) || e.message;
        const action = (e.explanation && e.explanation.action) || '';
        emit({
          type: 'notice',
          level: 'warning',
          message: started
            ? `Postman MCP could not finish this collection (${title}). Results already recorded from Postman are kept.`
            : `Postman MCP could not run this collection (${title}). Continuing with the platform runner — Postman MCP is optional.${action ? ` ${action}` : ' Set POSTMAN_API_KEY (or POSTMAN_<PREFIX>_API_KEY) and Test Postman on Connections if you want collection runs in Postman.'}`,
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
  }

  if (!sf.available && testCases.some((t) => !isCommerceRequest(t) && !isHttpRequest(t))) {
    emit({ type: 'notice', level: 'warning', message: require('../config').SF_UNAVAILABLE_MESSAGE });
  }
  if (!commerce.available && testCases.some((t) => isCommerceRequest(t))) {
    emit({ type: 'notice', level: 'warning', message: commerce.unavailableExplanation().title });
  }
  const http = httpFor(project);
  const httpNeedsOrigin = testCases.some((t) => isHttpRequest(t) && !/^https?:\/\//i.test(String(t.endpoint || '').replace(/^\{\{[^}]+\}\}/, '')));
  if (!http.available && !httpBase && httpNeedsOrigin) {
    emit({ type: 'notice', level: 'warning', message: http.unavailableExplanation().title });
  }

  await executeOnPlatform(run, project, testCases, state, { emit, counts, timings, created, sf, vars, varSource, contractCache });
  await finishRun(run, project, testCases, state, { emit, counts, timings, created, sf });
}

async function executeOnPlatform(run, project, testCases, state, { emit, counts, timings, created, vars, varSource, contractCache, transport } = {}) {
  const localVars = vars || {};
  const localSource = varSource || {};
  const localContracts = contractCache || {};
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
    const inner = connectorFor(project, tc);
    const conn = transport && typeof transport.wrap === 'function' ? transport.wrap(inner) : inner;
    const r = await executeOne({ tc, base, sf: conn, project, vars: localVars, varSource: localSource, run, created, contractCache: localContracts });
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
}

async function blockAll(run, project, testCases, state, { emit, counts, timings, created, sf, explanation }) {
  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const resultId = `${run.id}-${String(i + 1).padStart(4, '0')}`;
    const r = {
      id: resultId, runId: run.id, projectId: project.id, testCaseId: tc.id, seq: i + 1, title: tc.title, method: tc.method,
      endpoint: tc.endpoint, apiType: tc.apiType, testType: tc.testType, priority: tc.priority, storyKey: tc.storyKey,
      startedAt: now(), endedAt: now(), status: 'blocked', error: explanation, assertions: [],
    };
    r.analysis = analyse(r, tc);
    counts.blocked++;
    repo.insert('run_results', r);
    emit({ type: 'test-start', index: i, testCaseId: tc.id, title: tc.title });
    emit({ type: 'test-result', index: i, result: slim(r), counts });
  }
  repo.update('runs', run.id, { ...counts });
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
  if (run.options && run.options.traceability) summary.traceability = run.options.traceability;
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
  try { require('./jira-result').maybeComment(run.id).catch(() => {}); } catch { /* non-fatal */ }
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

const STRUCTURED_BODY = /^(formdata|form-data|multipart|urlencoded|x-www-form-urlencoded|graphql)$/i;

/** Encode an imported test body (form-data / urlencoded / GraphQL) or interpolate JSON/raw. */
function encodeTestCaseBody(tc, vars, missing) {
  const extra = tc.extra || {};
  const mode = String(extra.bodyMode || '').toLowerCase();
  if (STRUCTURED_BODY.test(mode)) {
    const encoded = bodyEncode.encode(mode, {
      body: interpolate(tc.body, vars, missing),
      bodyRaw: interpolate(tc.bodyRaw, vars, missing),
      form: interpolate(extra.formData || extra.form || extra.urlencoded, vars, missing),
      graphql: interpolate(extra.graphql, vars, missing),
    });
    const jsonBody = encoded.jsonBody;
    return {
      body: jsonBody,
      bodyRaw: jsonBody !== undefined ? undefined : (encoded.body == null ? undefined : encoded.body),
      contentType: encoded.contentType || null,
    };
  }
  return {
    body: tc.bodyRaw ? undefined : interpolate(tc.body, vars, missing),
    bodyRaw: tc.bodyRaw ? interpolate(tc.bodyRaw, vars, missing) : undefined,
    contentType: null,
  };
}

async function executeOne({ tc, base, sf, project, vars, varSource, run, created, contractCache }) {
  // 1. Draft / recommended tests are not executable.
  if (tc.status === 'draft') {
    return blockedResult(base, { title: 'Test is a draft (RECOMMENDED) and needs configuration before it can run.', cause: tc.description || 'Missing configuration.', action: 'Complete the configuration described on the test case and set its status to Ready.', category: 'configuration', evidence: [] });
  }
  // 2. Production safety
  const safety = checkOperation(project, tc, run.options || {});
  if (safety) return blockedResult(base, safety);

  // 3. Interpolate (fill org/collection aliases like organization_id, then retry once)
  const httpTest = isHttpRequest(tc);
  const localVars = {
    ...vars,
    baseUrl: httpTest ? (vars.httpBaseUrl || vars.baseUrl) : (vars.instanceUrl || vars.baseUrl),
  };
  const interpolateRound = () => {
    const missing = new Set();
    const encoded = encodeTestCaseBody(tc, localVars, missing);
    const body = encoded.body;
    const bodyRaw = encoded.bodyRaw;
    const reqVars = { ...localVars, req: body && typeof body === 'object' ? body : {} };
    let endpoint = interpolate(tc.endpoint, reqVars, missing);
    if (!isCommerceRequest({ ...tc, endpoint }) && !isHttpRequest({ ...tc, endpoint })) {
      endpoint = ensureSalesforceRestPath(endpoint, vars.apiVersion || project.apiVersion);
    }
    const headers = interpolate(tc.headers || {}, reqVars, missing);
    if (encoded.contentType) bodyEncode.applyContentType(headers, encoded.contentType);
    const query = interpolate(tc.query || {}, reqVars, missing);
    return { missing, body, bodyRaw, reqVars, endpoint, headers, query };
  };
  let round = interpolateRound();
  let unresolved = [...round.missing].filter((m) => !m.startsWith('$') && m !== 'accessToken' && m !== 'sessionId');
  let filledAny = false;
  for (const name of unresolved) {
    const filled = knownFallback(name, localVars, project);
    if (filled !== undefined && filled !== '') { localVars[name] = filled; vars[name] = filled; filledAny = true; }
  }
  if (filledAny) {
    round = interpolateRound();
    unresolved = [...round.missing].filter((m) => !m.startsWith('$') && m !== 'accessToken' && m !== 'sessionId');
  }
  if (unresolved.length) {
    if (httpTest && unresolved.every((v) => /^(baseUrl|httpBaseUrl)$/i.test(v))) {
      return blockedResult(base, { ...httpFor(project).unavailableExplanation(), category: 'configuration' });
    }
    const producers = unresolved.map((v) => varSource[v] ? `${v} ← ${varSource[v]}` : `${v} ← (no earlier test extracts it)`);
    const extracted = unresolved.some((v) => varSource[v]);
    const httpish = unresolved.some((v) => /^(baseUrl|httpBaseUrl|token|bearerToken|httpToken|accessToken)$/i.test(v));
    const orgish = unresolved.some((v) => /^(organization_id|organizationId|ccOrgId|orgId)$/i.test(v));
    const commerceish = orgish && (
      isCommerceRequest(tc)
      || String(project.orgKind || ((project.integrationConfig || {}).orgKind) || '').startsWith('sfcc')
      || Boolean(((project.integrationConfig || {}).commerce || {}).enabled)
    );
    return blockedResult(base, {
      title: extracted
        ? `Blocked: variable ${unresolved.map((v) => `{{${v}}}`).join(', ')} was not produced by an earlier test.`
        : `Blocked: variable ${unresolved.map((v) => `{{${v}}}`).join(', ')} is not set.`,
      cause: extracted
        ? 'This test depends on a value captured from an upstream test that failed, was skipped, or was not selected in this run.'
        : 'This value is a collection / org variable (not captured by another test in this run).',
      action: extracted
        ? 'Run the full suite (or include the upstream test) and fix the upstream failure first.'
        : (httpish
          ? 'Set the frontend HTTP base URL and bearer token on Connections → Postman / HTTP, then re-run.'
          : (commerceish
            ? 'Set Realm / org ID on Connections → Commerce Cloud (fills {{organization_id}} / {{organizationId}} for SLAS and SCAPI), or add organization_id on Test data or Try an API → Environments. Then re-run.'
            : 'Connect the Salesforce org so organization_id can be read from userinfo, or set the variable on Test data. Then re-run.')),
      actionLabel: extracted ? undefined : (httpish ? 'Set HTTP base URL' : (commerceish ? 'Set Commerce org ID' : 'Open Connections')),
      href: extracted ? undefined : `/projects/${project.id}?tab=connection${httpish ? '&focus=http' : (commerceish ? '&focus=cc' : '')}`,
      category: extracted ? 'dependency' : 'configuration',
      evidence: producers,
    });
  }
  const { body, bodyRaw, reqVars, headers, query } = round;
  let { endpoint } = round;
  if (httpTest && !/^https?:\/\//i.test(endpoint) && !httpFor(project).available && !vars.httpBaseUrl) {
    return blockedResult(base, { ...httpFor(project).unavailableExplanation(), category: 'configuration' });
  }
  const needsTok = (tc.tags || []).includes('needs-http-token') || ((project.integrationConfig || {}).http || {}).needsBearer;
  if (httpTest && needsTok && tc.auth !== 'none' && !localVars.httpToken && !localVars.accessToken && !localVars.token && !localVars.bearerToken) {
    return blockedResult(base, { ...httpFor(project).tokenMissingExplanation(), category: 'configuration' });
  }
  if (httpTest && tc.auth !== 'none') {
    const tok = localVars.httpToken || localVars.bearerToken || localVars.accessToken || localVars.token;
    if (tok && !Object.keys(headers || {}).some((h) => /^authorization$/i.test(h))) {
      headers.Authorization = `Bearer ${tok}`;
    }
  }
  if (!sf.available && !httpTest && !/^https?:\/\//i.test(endpoint)) return blockedResult(base, { ...sf.unavailableExplanation(), category: 'configuration' });

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
    if (ex.code === 'LOW_PRIVILEGE_USER_NOT_CONFIGURED' || ex.code === 'HTTP_BASE_URL_MISSING' || ex.code === 'HTTP_TOKEN_MISSING') {
      return blockedResult({ ...base, request: reqRecord }, ex);
    }
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

module.exports = { startRun, stopRun, getEmitter, isActive, executeOne, waitForRun, encodeTestCaseBody };
