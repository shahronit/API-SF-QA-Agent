'use strict';
/**
 * Postman MCP helpers: documented tool names, id extraction, and mapping
 * runCollection output onto the platform run_results shape. No secrets here.
 */
const { maskDeep, maskHeaders } = require('../lib/mask');

const TOOLS = {
  createCollection: [/^createCollection$/i, /create.?collection/i],
  putCollection: [/^putCollection$/i, /put.?collection|update.?collection|replace.?collection/i],
  getCollections: [/^getCollections$/i, /list.?collection|get.?collections/i],
  getCollection: [/^getCollection$/i, /get.?collection$/i],
  createEnvironment: [/^createEnvironment$/i, /create.?environment/i],
  putEnvironment: [/^putEnvironment$/i, /put.?environment|update.?environment|replace.?environment/i],
  getEnvironments: [/^getEnvironments$/i, /list.?environment|get.?environments/i],
  runCollection: [/^runCollection$/i, /run.?collection|execute.?collection/i],
  getWorkspaces: [/^getWorkspaces$/i, /list.?workspace|get.?workspaces/i],
};

function findNamedTool(client, key) {
  const [exact, fuzzy] = TOOLS[key] || [];
  if (!client || !client.tools) return null;
  const exactHit = exact && client.tools.find((t) => exact.test(t.name));
  if (exactHit) return exactHit;
  if (typeof client.findTool === 'function' && fuzzy) return client.findTool(fuzzy);
  return client.tools.find((t) => fuzzy && (fuzzy.test(t.name) || fuzzy.test(t.description || ''))) || null;
}

function pickId(data, keys = ['id', 'uid', 'collectionId', 'environmentId']) {
  if (data == null) return null;
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (typeof data !== 'object') return null;
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const inner of [data.collection, data.environment, data.data, data.result, data.body]) {
    const found = pickId(inner, keys);
    if (found) return found;
  }
  return null;
}

function listFrom(data, keys = ['collections', 'environments', 'workspaces', 'items']) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function matchByName(list, name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  return list.find((x) => String(x.name || (x.info && x.info.name) || '').toLowerCase() === n)
    || list.find((x) => String(x.name || '').toLowerCase().includes(n));
}

function itemName(ex) {
  if (!ex || typeof ex !== 'object') return '';
  return String(
    (ex.item && (ex.item.name || ex.item.id))
    || ex.name
    || ex.requestName
    || (ex.request && ex.request.name)
    || '',
  );
}

function statusCodeFrom(ex) {
  const r = ex && (ex.response || ex);
  const c = r.code || r.status || r.statusCode || (r.body && r.body.code);
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
}

function responseMsFrom(ex) {
  const r = ex && (ex.response || ex);
  const n = Number(r.responseTime || r.time || r.timeMs || ex.responseTime || ex.time);
  return Number.isFinite(n) ? n : null;
}

function assertionList(ex) {
  const raw = (ex && (ex.assertions || ex.tests || ex.testResults)) || [];
  return (Array.isArray(raw) ? raw : []).map((a) => {
    const failed = Boolean(a.error || a.err || a.result === 'FAIL' || a.passed === false || a.status === 'failed');
    return {
      type: a.type || 'postman',
      label: a.assertion || a.name || a.test || a.label || 'test',
      result: failed ? 'FAIL' : 'PASS',
      message: a.error && (a.error.message || a.error.test) || a.message || null,
    };
  });
}

function executionsFrom(raw) {
  if (!raw) return [];
  const d = raw.run || raw.result || raw;
  if (Array.isArray(d.executions)) return d.executions;
  if (Array.isArray(d.results)) return d.results;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d.testResults)) return d.testResults;
  if (Array.isArray(raw.executions)) return raw.executions;
  if (Array.isArray(raw.results)) return raw.results;
  if (Array.isArray(raw)) return raw;
  return [];
}

function matchTestCase(name, testCases) {
  const n = String(name || '');
  return testCases.find((tc) => n === `${tc.id} ${tc.title}` || n.startsWith(`${tc.id} `) || n === tc.id)
    || testCases.find((tc) => n.includes(tc.id));
}

function requestFrom(ex, tc) {
  const req = (ex && (ex.request || ex)) || {};
  const url = typeof req.url === 'string' ? req.url : (req.url && (req.url.raw || req.url.href)) || (tc && tc.endpoint) || '';
  const headers = req.header
    ? Object.fromEntries((Array.isArray(req.header) ? req.header : []).filter((h) => h && h.key).map((h) => [h.key, h.value]))
    : (req.headers || {});
  return {
    method: req.method || (tc && tc.method) || 'GET',
    url,
    apiType: tc && tc.apiType,
    auth: tc && tc.auth,
    headers: maskHeaders(headers),
    query: req.query || {},
    body: maskDeep(req.body && req.body.raw ? req.body.raw : req.body),
  };
}

function responseFrom(ex) {
  const r = (ex && ex.response) || {};
  const body = r.body !== undefined ? r.body : r.json || r.stream || r.text;
  let parsed = body;
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { parsed = body; }
  }
  const headers = r.header
    ? Object.fromEntries((Array.isArray(r.header) ? r.header : []).filter((h) => h && h.key).map((h) => [h.key, h.value]))
    : (r.headers || {});
  return {
    status: statusCodeFrom(ex),
    headers: maskHeaders(headers),
    body: maskDeep(parsed),
    timeMs: responseMsFrom(ex),
    sizeBytes: r.responseSize || r.size || null,
  };
}

function execStatus(ex, assertions) {
  const s = String(ex.status || ex.result || '').toLowerCase();
  if (s === 'blocked') return 'blocked';
  if (s === 'skipped' || s === 'skip') return 'skipped';
  if (s === 'failed' || s === 'fail' || s === 'error') return 'failed';
  if (ex.error || ex.err) return 'failed';
  if (assertions.some((a) => a.result === 'FAIL')) return 'failed';
  return 'passed';
}

/**
 * Map a Postman MCP runCollection payload onto one result per test case (same order).
 * Extra Postman items (Salesforce validation follow-ups) are ignored.
 */
function mapMcpRunToResults(raw, testCases) {
  const executions = executionsFrom(raw);
  const used = new Set();
  const byTc = new Map();
  for (const ex of executions) {
    const tc = matchTestCase(itemName(ex), testCases);
    if (!tc || used.has(tc.id)) continue;
    used.add(tc.id);
    const assertions = assertionList(ex);
    const status = execStatus(ex, assertions);
    const response = responseFrom(ex);
    byTc.set(tc.id, {
      status,
      statusCode: response.status,
      responseMs: response.timeMs,
      sizeBytes: response.sizeBytes,
      request: requestFrom(ex, tc),
      response,
      assertions,
      error: status === 'failed' && ex.error
        ? { title: String(ex.error.message || ex.error), category: 'api' }
        : null,
      executor: 'postman-mcp',
    });
  }
  return testCases.map((tc) => {
    if (byTc.has(tc.id)) return byTc.get(tc.id);
    if (!executions.length) {
      return {
        status: 'blocked',
        statusCode: null,
        responseMs: null,
        sizeBytes: null,
        request: { method: tc.method, url: tc.endpoint, apiType: tc.apiType },
        response: null,
        assertions: [],
        error: { title: 'Postman MCP returned no per-request results for this test.', category: 'environment', action: 'Check the Postman collection run output, or run in the platform.' },
        executor: 'postman-mcp',
      };
    }
    return {
      status: 'blocked',
      statusCode: null,
      responseMs: null,
      sizeBytes: null,
      request: { method: tc.method, url: tc.endpoint, apiType: tc.apiType },
      response: null,
      assertions: [],
      error: { title: 'This test was not present in the Postman MCP run output.', category: 'environment' },
      executor: 'postman-mcp',
    };
  });
}

function environmentPayload(exported) {
  return {
    name: exported.name,
    values: (exported.values || []).map((v) => ({
      key: v.key,
      value: v.type === 'secret' ? '' : (v.value || ''),
      type: v.type || 'default',
      enabled: v.enabled !== false,
    })),
  };
}

function withRuntimeSecrets(exported, secrets = {}) {
  const payload = environmentPayload(exported);
  for (const row of payload.values) {
    if (row.key === 'accessToken' && secrets.accessToken) row.value = secrets.accessToken;
    if (row.key === 'lowPrivAccessToken' && secrets.lowPrivAccessToken) row.value = secrets.lowPrivAccessToken;
  }
  return payload;
}

function collectionHasEmptySecrets(collection) {
  const text = JSON.stringify(collection);
  if (/"clientSecret"\s*:\s*"[^"]+"/i.test(text) && !/"clientSecret"\s*:\s*""/.test(text) && !/\{\{clientSecret\}\}/.test(text)) return false;
  return true;
}

module.exports = {
  TOOLS,
  findNamedTool,
  pickId,
  listFrom,
  matchByName,
  mapMcpRunToResults,
  environmentPayload,
  withRuntimeSecrets,
  collectionHasEmptySecrets,
  executionsFrom,
  matchTestCase,
};
