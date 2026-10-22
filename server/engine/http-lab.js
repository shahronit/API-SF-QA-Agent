'use strict';
/**
 * Generic explorer execute path: scripts, env interpolation, auth helpers,
 * cookies, body modes, history, console. Salesforce connectors still used for
 * org-relative paths when the user picks a Salesforce session auth mode.
 */
const crypto = require('node:crypto');
const { repo, now, audit } = require('../db');
const { interpolate } = require('../lib/template');
const { maskDeep, maskHeaders } = require('../lib/mask');
const { explainResponse, explainNetworkError } = require('../lib/errors');
const { evaluate } = require('./assertions');
const { checkOperation } = require('./safety');
const { connectorFor, isHttpRequest, isCommerceRequest } = require('../connectors');
const { restApiOrigin, ensureSalesforceRestPath } = require('../connectors/salesforce-org');
const transport = require('../lib/http-transport');
const { httpSettings } = transport;
const cookies = require('./cookie-jar');
const bodyEncode = require('./body-encode');
const { applyAuth } = require('./auth-apply');
const sandbox = require('./script-sandbox');
const envs = require('./environments');

const CORRELATION_HEADERS = ['x-correlation-id', 'x-request-id', 'x-b3-traceid', 'traceparent', 'x-amzn-trace-id'];

function rowsToObject(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r || !r.key || r.enabled === false || r.disabled) continue;
    out[r.key] = r.value === undefined || r.value === null ? '' : r.value;
  }
  return out;
}

function objectToRows(obj) {
  return Object.entries(obj || {}).map(([key, value]) => ({ key, value: value === undefined || value === null ? '' : String(value), enabled: true }));
}

function logLine(projectId, level, source, message, detail) {
  try {
    repo.insert('console_logs', {
      id: crypto.randomUUID(), projectId, level, source, message: String(message || '').slice(0, 4000),
      detail: detail || null, createdAt: now(),
    });
    const extra = repo.find('console_logs', 'projectId = $p', { p: projectId }, 'ORDER BY createdAt DESC LIMIT 500 OFFSET 400');
    for (const r of extra) repo.remove('console_logs', r.id);
  } catch { /* non-fatal */ }
}

function saveHistory(projectId, rec) {
  const row = {
    id: crypto.randomUUID(), projectId,
    method: rec.method, url: rec.url, status: rec.status || null,
    timeMs: rec.timeMs || null, sizeBytes: rec.sizeBytes || null,
    request: rec.request || null, response: rec.response || null,
    tests: rec.tests || null, console: rec.console || null,
    createdAt: now(),
  };
  repo.insert('request_history', row);
  const extra = repo.find('request_history', 'projectId = $p', { p: projectId }, 'ORDER BY createdAt DESC LIMIT 300 OFFSET 200');
  for (const r of extra) repo.remove('request_history', r.id);
  return row;
}

function activeCollection(project) {
  const uid = ((project.integrationConfig || {}).postman || {}).uid;
  if (uid) return repo.one('collections', 'projectId = $p AND uid = $u', { p: project.id, u: uid });
  return repo.find('collections', 'projectId = $p', { p: project.id }, 'ORDER BY updatedAt DESC')[0] || null;
}

async function transportSend(spec, { project, settings }) {
  const headers = { ...(spec.headers || spec.header || {}) };
  if (Array.isArray(spec.header)) {
    for (const h of spec.header) if (h && h.key) headers[h.key] = h.value;
  }
  let body = spec.body;
  if (body && typeof body === 'object' && body.mode) {
    const enc = bodyEncode.encode(body.mode, {
      body: body.raw, bodyRaw: body.raw, form: body.urlencoded || body.formdata, graphql: body.graphql, binary: body.file,
    });
    body = enc.body;
    if (enc.contentType) headers['Content-Type'] = headers['Content-Type'] || enc.contentType;
  } else if (body && typeof body === 'object') body = JSON.stringify(body);
  return transport.request({
    method: spec.method || 'GET',
    url: spec.url,
    headers,
    body,
    timeoutMs: spec.timeoutMs,
    settings,
    cookieJar: cookies.jarFor(project.id),
    followRedirects: spec.followRedirects !== false,
  });
}

async function execute(project, body, user) {
  const method = String(body.method || 'GET').toUpperCase();
  const pathIn = String(body.path || body.url || '').trim();
  if (!pathIn) {
    const err = new Error('URL is required.');
    err.status = 400;
    throw err;
  }
  const safety = checkOperation(project, { method, path: pathIn, body: body.body }, { confirmProductionWrites: body.confirmProductionWrites, confirmDelete: body.confirmDelete });
  if (safety) {
    const e = new Error(safety.title);
    e.status = 409;
    e.info = safety;
    throw e;
  }

  const environment = body.environmentId
    ? repo.get('http_environments', body.environmentId)
    : envs.active(project.id);
  const collection = body.collectionId ? repo.get('collections', body.collectionId) : activeCollection(project);
  const localVars = { ...(body.variables || {}), ...(body.localVars || {}) };
  let vars = {
    apiVersion: project.apiVersion,
    runId: 'explorer',
    instanceUrl: restApiOrigin(project.instanceUrl) || project.instanceUrl || '',
    httpBaseUrl: String(((project.integrationConfig || {}).http || {}).baseUrl || '').replace(/\/$/, ''),
    ...envs.mergeVars({ project, environment, collection, local: localVars }),
  };
  const cc = (project.integrationConfig && project.integrationConfig.commerce) || {};
  vars.ccSiteId = vars.ccSiteId || cc.siteId || '';
  vars.ccOrgId = vars.ccOrgId || cc.orgId || '';
  vars.ccShortCode = vars.ccShortCode || cc.shortCode || '';
  vars.ocapiVersion = vars.ocapiVersion || cc.ocapiVersion || 'v24_5';
  if (vars.ccOrgId) {
    vars.organization_id = vars.organization_id || vars.ccOrgId;
    vars.organizationId = vars.organizationId || vars.ccOrgId;
  }

  const logs = [];
  const settings = httpSettings(project);
  const sendRequest = (spec) => transportSend(spec, { project, settings });

  const reqState = {
    method,
    url: pathIn,
    path: pathIn,
    headers: body.headerRows ? rowsToObject(body.headerRows) : { ...(body.headers || {}) },
    query: body.queryRows ? rowsToObject(body.queryRows) : { ...(body.query || {}) },
    body: body.body,
    bodyRaw: body.bodyRaw,
  };

  if (body.preRequest) {
    const pre = await sandbox.runScript(body.preRequest, {
      eventName: 'prerequest',
      environment: envs.valuesToMap(environment && (environment.values || environment.envValues)),
      variables: vars,
      collection: envs.collectionVars(collection),
      request: reqState,
      logs,
      sendRequest,
    });
    Object.assign(vars, pre.variables, pre.environment, pre.collection);
    if (environment && Object.keys(pre.environment || {}).length) {
      const next = (environment.values || environment.envValues || []).map((v) => ({ ...v, value: pre.environment[v.key] !== undefined ? String(pre.environment[v.key]) : v.value }));
      for (const [k, v] of Object.entries(pre.environment)) {
        if (!next.some((r) => r.key === k)) next.push({ key: k, value: String(v), enabled: true, secret: false });
      }
      envs.update(environment.id, { values: next });
    }
    logs.push({ level: pre.ok ? 'info' : 'error', source: 'prerequest', message: pre.ok ? 'Pre-request script finished.' : pre.error });
  }

  const missing = new Set();
  let path = interpolate(reqState.path || reqState.url, vars, missing);
  const headers = interpolate({ ...reqState.headers }, vars, missing);
  const query = interpolate({ ...reqState.query }, vars, missing);
  let bodyVal = reqState.bodyRaw !== undefined && reqState.bodyRaw !== null && reqState.bodyRaw !== ''
    ? interpolate(reqState.bodyRaw, vars, missing)
    : interpolate(reqState.body, vars, missing);

  const authResult = await applyAuth({
    auth: body.auth || 'default',
    authConfig: interpolate(body.authConfig || {}, vars, missing),
    headers, query, vars, missing,
    transport, settings,
  });

  const mode = String(body.bodyMode || (body.apiType === 'SOAP' ? 'xml' : 'json')).toLowerCase();
  let encoded = { body: null, contentType: null, jsonBody: undefined };
  if (!['GET', 'HEAD'].includes(method) && mode !== 'none') {
    encoded = bodyEncode.encode(mode, {
      body: typeof bodyVal === 'object' ? bodyVal : undefined,
      bodyRaw: typeof bodyVal === 'string' ? bodyVal : (bodyVal == null ? '' : JSON.stringify(bodyVal)),
      form: interpolate(body.form || body.bodyRows || [], vars, missing),
      graphql: interpolate(body.graphql || {}, vars, missing),
      binary: body.binary,
    });
    bodyEncode.applyContentType(headers, encoded.contentType);
  }

  const unresolved = [...missing].filter((m) => !m.startsWith('$') && m !== 'sessionId' && m !== 'accessToken');
  if (unresolved.length) {
    const e = new Error(`Unresolved variable(s): ${unresolved.map((v) => `{{${v}}}`).join(', ')}.`);
    e.status = 400;
    e.info = { action: 'Set values in the Environment or Variables tab.' };
    throw e;
  }

  const abs = /^https?:\/\//i.test(path);
  if (!abs && !isCommerceRequest({ apiType: body.apiType, path }) && !isHttpRequest({ apiType: body.apiType || (abs ? 'HTTP' : ''), path })) {
    path = ensureSalesforceRestPath(path, project.apiVersion);
  }

  const useGeneric = abs || isHttpRequest({ apiType: body.apiType || (abs ? 'HTTP' : body.apiType), path }) || authResult.skipConnectorAuth && abs;
  let res;
  try {
    if (useGeneric && abs) {
      const u = new URL(path);
      for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') u.searchParams.set(k, v);
      res = await transport.request({
        method, url: u.toString(), headers,
        body: encoded.body,
        timeoutMs: body.timeoutMs || 30000,
        settings, cookieJar: cookies.jarFor(project.id),
        followRedirects: body.followRedirects !== false,
      });
    } else {
      const sf = connectorFor(project, { apiType: body.apiType, path });
      if (!sf.available && !abs) {
        const ex = sf.unavailableExplanation();
        const e = new Error(ex.title);
        e.status = 503;
        e.info = ex;
        throw e;
      }
      const payload = encoded.jsonBody !== undefined ? encoded.jsonBody : undefined;
      const bodyRaw = payload === undefined ? (encoded.body == null ? undefined : Buffer.isBuffer(encoded.body) ? encoded.body.toString('utf8') : encoded.body) : undefined;
      const cookie = cookies.cookieHeader(project.id, abs ? path : ((restApiOrigin(project.instanceUrl) || '') + path));
      if (cookie && !Object.keys(headers).some((h) => /^cookie$/i.test(h))) headers.Cookie = cookie;
      res = await sf.request({
        method, path, headers, query,
        body: payload, bodyRaw,
        auth: authResult.auth,
        apiType: body.apiType, timeoutMs: body.timeoutMs,
      });
      if (res && res.headers) {
        const sc = [];
        for (const [k, v] of Object.entries(res.headers)) if (/^set-cookie$/i.test(k)) sc.push(v);
        if (sc.length) cookies.storeFromResponse(project.id, res.url || path, sc.flatMap((x) => String(x).split(/,(?=[^ ;]+=)/)));
      }
    }
  } catch (e) {
    if (e.status) throw e;
    const ex = e.explanation || explainNetworkError(e, path);
    const err = new Error(ex.title || e.message);
    err.status = 502;
    err.info = ex;
    throw err;
  }

  res.correlationId = res.correlationId || CORRELATION_HEADERS.map((h) => {
    const k = Object.keys(res.headers || {}).find((x) => x.toLowerCase() === h);
    return k ? res.headers[k] : null;
  }).find(Boolean) || null;

  let tests = [];
  if (body.assertions && body.assertions.length) {
    tests = tests.concat(evaluate(interpolate(body.assertions, vars, new Set()), res));
  }
  let scriptTests = [];
  if (body.tests) {
    const after = await sandbox.runScript(body.tests, {
      eventName: 'test',
      environment: envs.valuesToMap(environment && (environment.values || environment.envValues)),
      variables: vars,
      collection: envs.collectionVars(collection),
      request: { method, url: res.url, headers, body: encoded.jsonBody !== undefined ? encoded.jsonBody : encoded.body },
      response: res,
      logs,
      sendRequest,
    });
    scriptTests = sandbox.testsAsAssertions(after.tests);
    tests = tests.concat(scriptTests);
    Object.assign(vars, after.variables, after.environment);
    if (environment && Object.keys(after.environment || {}).length) {
      const next = (environment.values || environment.envValues || []).map((v) => ({ ...v, value: after.environment[v.key] !== undefined ? String(after.environment[v.key]) : v.value }));
      envs.update(environment.id, { values: next });
    }
  }

  logs.push({
    level: res.status >= 400 ? 'warn' : 'info',
    source: 'http',
    message: `${method} ${res.url} → ${res.status} in ${res.timeMs} ms (${res.sizeBytes} B)`,
  });
  for (const line of logs) logLine(project.id, line.level, line.source, line.message, line.detail);

  const history = saveHistory(project.id, {
    method, url: res.url, status: res.status, timeMs: res.timeMs, sizeBytes: res.sizeBytes,
    request: { method, url: res.url, headers: maskHeaders(res.requestHeaders || headers), query, body: maskDeep(encoded.jsonBody !== undefined ? encoded.jsonBody : (Buffer.isBuffer(encoded.body) ? `[binary ${encoded.body.length} bytes]` : encoded.body)), auth: body.auth },
    response: { status: res.status, headers: maskHeaders(res.headers), body: maskDeep(res.body), timeMs: res.timeMs, sizeBytes: res.sizeBytes },
    tests, console: logs,
  });

  audit('explorer', 'request.executed', { user, projectId: project.id, detail: { method, path: String(res.url || path).split('?')[0], status: res.status, ms: res.timeMs } });

  return {
    request: { method, url: res.url, headers: maskHeaders(res.requestHeaders || headers), query, body: maskDeep(encoded.jsonBody !== undefined ? encoded.jsonBody : (Buffer.isBuffer(encoded.body) ? `[binary ${encoded.body.length} bytes]` : encoded.body)), auth: body.auth },
    response: { status: res.status, statusText: res.statusText, headers: maskHeaders(res.headers), body: maskDeep(res.body), text: typeof res.text === 'string' ? res.text.slice(0, 200 * 1024) : undefined, timeMs: res.timeMs, sizeBytes: res.sizeBytes, correlationId: res.correlationId },
    assertions: tests,
    tests: scriptTests,
    console: logs,
    cookies: cookies.matching(project.id, res.url),
    historyId: history.id,
    explanation: explainResponse({ status: res.status, body: res.body, method, url: res.url }),
    demo: project.mode === 'demo',
    oauth: authResult.oauth || null,
  };
}

const INTROSPECTION = `query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name } types { kind name description fields(includeDeprecated: true) { name description args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } } } }`;

async function introspect(project, { url, headers, auth, authConfig }) {
  const r = await execute(project, {
    method: 'POST', path: url, headers: { Accept: 'application/json', ...(headers || {}) },
    bodyMode: 'graphql', graphql: { query: INTROSPECTION, variables: {} },
    auth: auth || 'none', authConfig, followRedirects: true,
  }, 'system');
  return r;
}

module.exports = { execute, httpSettings, rowsToObject, objectToRows, saveHistory, logLine, introspect, INTROSPECTION };
