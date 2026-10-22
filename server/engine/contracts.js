'use strict';
/**
 * API contract validation for OpenAPI 3.x, Swagger 2.0 and plain JSON Schema.
 * Validates status codes, required headers, request and response bodies, and
 * error contracts. Violations are reported as { rule, path, message }.
 */
const { repo } = require('../db');
const { validate } = require('../lib/jsonschema');
const { parseSpecText } = require('../lib/yaml');

function detectKind(spec) {
  if (spec && spec.openapi) return 'openapi';
  if (spec && spec.swagger) return 'swagger';
  if (spec && (spec.$schema || spec.type || spec.properties)) return 'jsonschema';
  throw new Error('Unrecognised specification: expected an OpenAPI 3 document (openapi:), Swagger 2.0 (swagger:) or a JSON Schema.');
}

function parse(text) {
  const spec = typeof text === 'string' ? parseSpecText(text) : text;
  return { spec, kind: detectKind(spec) };
}

function listOperations(spec, kind) {
  if (kind === 'jsonschema') return [{ id: 'schema', method: 'ANY', path: '*', summary: spec.title || 'JSON Schema', responses: ['*'] }];
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths || {})) {
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
      if (!item[m]) continue;
      ops.push({ id: item[m].operationId || `${m.toUpperCase()} ${p}`, method: m.toUpperCase(), path: p, summary: item[m].summary || '', responses: Object.keys(item[m].responses || {}) });
    }
  }
  return ops;
}

function pathToRegex(p, basePath = '') {
  const full = (basePath + p).replace(/\/+/g, '/');
  return new RegExp('^' + full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '[^/]+') + '/?$');
}

function findOperation(spec, kind, method, urlPath) {
  const basePaths = kind === 'swagger' ? [spec.basePath || ''] : ['', ...((spec.servers || []).map((s) => { try { return new URL(s.url, 'https://x').pathname.replace(/\/$/, ''); } catch { return ''; } }))];
  for (const [p, item] of Object.entries(spec.paths || {})) {
    const op = item[method.toLowerCase()];
    if (!op) continue;
    for (const bp of basePaths) if (pathToRegex(p, bp).test(urlPath)) return { path: p, op, item };
  }
  return null;
}

function responseSchema(kind, op, status) {
  const resp = (op.responses || {})[String(status)] || (op.responses || {})[`${String(status)[0]}XX`] || (op.responses || {}).default;
  if (!resp) return { declared: false };
  if (kind === 'swagger') return { declared: true, schema: resp.schema, headers: resp.headers };
  const content = resp.content || {};
  const media = content['application/json'] || content[Object.keys(content)[0]];
  return { declared: true, schema: media && media.schema, headers: resp.headers };
}

function requestSchema(kind, op) {
  if (kind === 'swagger') {
    const b = (op.parameters || []).find((x) => x.in === 'body');
    return b && b.schema;
  }
  const c = op.requestBody && op.requestBody.content;
  return c && (c['application/json'] || c[Object.keys(c)[0]] || {}).schema;
}

/**
 * Validate one exchange against a stored contract.
 * @returns {{status: 'PASS'|'FAIL'|'NOT_APPLICABLE', operation, violations}}
 */
function validateExchange(contract, { method, path, status, headers = {}, body, requestBody }) {
  const { spec, kind } = { spec: contract.spec, kind: contract.kind };
  const violations = [];
  if (kind === 'jsonschema') {
    validate(spec, body, spec).forEach((e) => violations.push({ rule: `response.${e.rule}`, path: e.path, message: e.message }));
    return { status: violations.length ? 'FAIL' : 'PASS', operation: 'JSON Schema', violations };
  }
  let urlPath = path;
  try { urlPath = new URL(path, 'https://x').pathname; } catch { /* keep */ }
  const found = findOperation(spec, kind, method, urlPath);
  if (!found) return { status: 'NOT_APPLICABLE', operation: null, violations: [{ rule: 'operation', path: urlPath, message: `No ${method} ${urlPath} operation is declared in the contract.` }] };
  const opName = found.op.operationId || `${method} ${found.path}`;
  const rs = responseSchema(kind, found.op, status);
  if (!rs.declared) {
    violations.push({ rule: 'status', path: '$', message: `Status ${status} is not declared for ${opName}. Declared: ${Object.keys(found.op.responses || {}).join(', ')}` });
  } else {
    if (rs.schema && body !== '' && body !== undefined) {
      validate(rs.schema, body, spec).forEach((e) => violations.push({ rule: `response.${e.rule}`, path: e.path, message: e.message }));
    }
    for (const [h, def] of Object.entries(rs.headers || {})) {
      if (def && def.required && !Object.keys(headers).some((k) => k.toLowerCase() === h.toLowerCase())) {
        violations.push({ rule: 'header.required', path: h, message: `Required response header ${h} is missing.` });
      }
    }
  }
  const reqSchema = requestSchema(kind, found.op);
  if (reqSchema && requestBody !== undefined && status < 400) {
    validate(reqSchema, requestBody, spec).forEach((e) => violations.push({ rule: `request.${e.rule}`, path: e.path, message: e.message }));
  }
  return { status: violations.length ? 'FAIL' : 'PASS', operation: opName, violations };
}

function validateAgainst(contractId, cache, exchange) {
  if (!cache[contractId]) cache[contractId] = repo.get('contracts', contractId);
  const c = cache[contractId];
  if (!c) return { status: 'ERROR', violations: [{ rule: 'contract', message: `Contract ${contractId} not found.` }] };
  return validateExchange(c, exchange);
}

function pathOf(endpoint) {
  const raw = String(endpoint || '');
  try { return new URL(raw, 'https://x').pathname; } catch { return raw.split('?')[0]; }
}

function attachToScenarios(project, scenarios) {
  if (!project || !project.id) return 0;
  let list = [];
  try { list = repo.find('contracts', 'projectId = $p', { p: project.id }); } catch { return 0; }
  if (!list.length) return 0;
  let n = 0;
  for (const s of scenarios || []) {
    for (const tc of s.testCases || []) {
      if (tc.contractRef && tc.contractRef.contractId) continue;
      const urlPath = pathOf(tc.endpoint).replace(/\{\{[^}]+\}\}/g, 'x');
      for (const c of list) {
        if (!c.spec) continue;
        const found = findOperation(c.spec, c.kind, tc.method || 'GET', urlPath);
        if (!found) continue;
        tc.contractRef = { contractId: c.id };
        tc.tags = [...new Set([...(tc.tags || []), 'contract'])];
        n++;
        break;
      }
    }
  }
  return n;
}

module.exports = { parse, listOperations, validateExchange, validateAgainst, detectKind, findOperation, attachToScenarios, requestSchema };
