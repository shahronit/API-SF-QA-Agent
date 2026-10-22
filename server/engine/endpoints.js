'use strict';
/**
 * Custom Apex REST / HTTP (BFF, middleware) endpoint catalog on a project.
 * Experience Cloud and SFCC paths are not stored here — those come from org detection.
 */
const crypto = require('node:crypto');
const { listOperations, requestSchema, parse: parseContract } = require('./contracts');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const SKIP_PATH = /\/services\/data\/|\/sobjects\/|\/composite|\/jobs\/ingest|\/graphql|\/tooling\/|\/connect\/communities|\/commerce\/webstores|\/dw\/(shop|data)\/|shopper-(products|search|baskets|auth)|\/Soap\//i;

function endpointIdFrom(method, path) {
  return `EP-${crypto.createHash('sha1').update(`${String(method || 'POST').toUpperCase()} ${String(path || '')}`).digest('hex').slice(0, 8)}`;
}

function newEndpointId(method, path) {
  if (method || path) return endpointIdFrom(method, path);
  return `EP-${crypto.randomBytes(3).toString('hex')}`;
}

function normalizePath(path) {
  let p = String(path || '').trim();
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      if (/salesforce\.com|force\.com/i.test(u.hostname) && u.pathname.startsWith('/services/apexrest')) {
        return u.pathname.replace(/\/$/, '') || u.pathname;
      }
      return `${u.origin}${u.pathname}`.replace(/\/$/, '') || p;
    } catch { /* keep */ }
  }
  if (!p.startsWith('/') && !p.startsWith('{{')) p = `/${p}`;
  if (/^\/v\d+\//.test(p) || /^\/[A-Za-z0-9_\-/*]+$/.test(p)) {
    if (!/^\/services\//i.test(p) && !/^https?:/i.test(p) && !p.startsWith('{{') && !p.startsWith('/dw/')) {
      /* urlMapping without prefix — Apex REST */
      if (!SKIP_PATH.test(p)) p = `/services/apexrest${p.startsWith('/') ? p : `/${p}`}`;
    }
  }
  return p.replace(/\/$/, '') || p;
}

function isSkippedPath(path) {
  const p = String(path || '');
  if (/apexrest/i.test(p)) return false;
  if (/^\{\{httpBaseUrl\}\}/i.test(p) || (/^https?:\/\//i.test(p) && !/salesforce\.com|force\.com|demandware|commercecloud/i.test(p))) return false;
  return SKIP_PATH.test(p);
}

function kindOf(path) {
  const p = String(path || '');
  if (/apexrest/i.test(p)) return 'apex-rest';
  if (/^https?:\/\//i.test(p) && !/salesforce\.com|force\.com/i.test(p)) return 'http';
  if (p.startsWith('{{httpBaseUrl}}') || (p.startsWith('/') && !p.startsWith('/services/'))) return 'http';
  return 'apex-rest';
}

function asKeywords(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 24);
  return String(v || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 24);
}

function asStatusList(v, fallback) {
  if (v == null || v === '') return fallback;
  const arr = Array.isArray(v) ? v : String(v).split(/[,\s]+/).map((n) => Number(n)).filter((n) => n >= 100 && n <= 599);
  return arr.length ? arr : fallback;
}

function asMapping(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const key = String(k || '').trim();
    const field = String(val || '').trim();
    if (!key || !field || /secret|password|token/i.test(key) || /secret|password|token/i.test(field)) continue;
    out[key] = field;
  }
  return out;
}

function asTransform(v) {
  if (!Array.isArray(v)) return [];
  return v.map((row) => ({
    field: String((row && row.field) || '').trim(),
    expected: row && row.expected,
  })).filter((r) => r.field && !/secret|password|token/i.test(r.field)).slice(0, 20);
}

function normalizeEndpoint(raw, { keepId } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const path = normalizePath(raw.path || raw.endpoint || raw.url);
  if (!path || isSkippedPath(path)) return null;
  const method = METHODS.has(String(raw.method || 'POST').toUpperCase()) ? String(raw.method || 'POST').toUpperCase() : 'POST';
  const id = keepId && raw.id && /^EP-[A-Za-z0-9]+$/i.test(raw.id)
    ? raw.id
    : newEndpointId(method, path);
  const keywords = asKeywords(raw.keywords);
  const name = String(raw.name || `${method} ${path}`).trim().slice(0, 120);
  return {
    id,
    name,
    path,
    method,
    object: String(raw.object || '').trim(),
    keywords: keywords.length ? keywords : asKeywords(name),
    description: String(raw.description || '').slice(0, 2000),
    direction: String(raw.direction || '').slice(0, 120),
    samplePayload: raw.samplePayload && typeof raw.samplePayload === 'object' ? raw.samplePayload : (raw.body && typeof raw.body === 'object' ? raw.body : null),
    secondPayload: raw.secondPayload && typeof raw.secondPayload === 'object' ? raw.secondPayload : null,
    retryPayload: raw.retryPayload && typeof raw.retryPayload === 'object' ? raw.retryPayload : null,
    invalidPayload: raw.invalidPayload && typeof raw.invalidPayload === 'object' ? raw.invalidPayload : null,
    requestMapping: asMapping(raw.requestMapping),
    transformChecks: asTransform(raw.transformChecks),
    successStatus: asStatusList(raw.successStatus, [200, 201]),
    idPath: raw.idPath === false || raw.idPath === null ? '' : String(raw.idPath == null ? '' : raw.idPath).trim(),
    successPath: String(raw.successPath == null ? '' : raw.successPath).trim(),
    successValue: raw.successValue === undefined ? 'SUCCESS' : raw.successValue,
    responseSchema: raw.responseSchema && typeof raw.responseSchema === 'object' ? raw.responseSchema : null,
    errorStatus: Number(raw.errorStatus) >= 400 ? Number(raw.errorStatus) : 400,
    errorPath: String(raw.errorPath == null ? '' : raw.errorPath).trim(),
    errorValue: raw.errorValue,
    legacyContract: raw.legacyContract === true ? true : (raw.legacyContract === false ? false : null),
    idempotencyHeader: String(raw.idempotencyHeader || '').trim(),
    duplicateExpect: asStatusList(raw.duplicateExpect, []),
    healthPath: String(raw.healthPath || '').trim(),
    timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 2000,
    source: ['manual', 'apex-rest', 'openapi', 'postman', 'explorer'].includes(raw.source) ? raw.source : 'manual',
    kind: kindOf(path),
  };
}

function listEndpoints(project) {
  const raw = ((project && project.integrationConfig) || {}).endpoints || [];
  return (Array.isArray(raw) ? raw : []).map((e) => normalizeEndpoint(e, { keepId: true })).filter(Boolean);
}

function mergeEndpoints(current, incoming) {
  const map = new Map();
  for (const e of current || []) {
    const n = normalizeEndpoint(e, { keepId: true });
    if (n) map.set(`${n.method} ${n.path}`, n);
  }
  const added = [];
  for (const e of incoming || []) {
    const n = normalizeEndpoint(e, { keepId: true });
    if (!n) continue;
    const key = `${n.method} ${n.path}`;
    const prev = map.get(key);
    if (prev) {
      map.set(key, {
        ...n,
        id: prev.id,
        name: prev.name && prev.source === 'manual' ? prev.name : n.name,
        object: n.object || prev.object,
        keywords: n.keywords.length ? n.keywords : prev.keywords,
        requestMapping: Object.keys(n.requestMapping).length ? n.requestMapping : prev.requestMapping,
        samplePayload: n.samplePayload || prev.samplePayload,
        invalidPayload: n.invalidPayload || prev.invalidPayload,
      });
    } else {
      added.push(n);
      map.set(key, n);
    }
  }
  return { endpoints: [...map.values()], added: added.length };
}

function matchEndpoints(endpoints, story) {
  const list = (endpoints || []).map((e) => normalizeEndpoint(e, { keepId: true })).filter(Boolean);
  const ids = Array.isArray(story && story.endpointIds) ? story.endpointIds.map(String) : [];
  if (ids.length) return list.filter((e) => ids.includes(e.id));
  const text = `${(story && story.summary) || ''} ${(story && story.description) || ''} ${(story && story.acceptanceCriteria) || ''} ${((story && story.components) || []).join(' ')}`.toLowerCase();
  return list.filter((e) => {
    if (e.path && text.includes(String(e.path).toLowerCase())) return true;
    return (e.keywords || []).some((k) => k && text.includes(String(k).toLowerCase()));
  });
}

function usesLegacyContract(e) {
  if (!e) return false;
  if (e.legacyContract === true) return true;
  if (e.legacyContract === false) return false;
  return !e.successPath && !e.responseSchema && (!e.idPath || e.idPath === '$.salesforceId');
}

async function querySafe(sf, soql, extra = {}) {
  if (!sf) return [];
  try {
    const result = extra.tooling && typeof sf.queryTooling === 'function' ? await sf.queryTooling(soql) : await sf.query(soql);
    const records = (result && result.records) || (Array.isArray(result) ? result : []);
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

function parseRestResource(body, className) {
  const src = String(body || '');
  const map = src.match(/@RestResource\s*\(\s*urlMapping\s*=\s*['"]([^'"]+)['"]/i);
  if (!map) return [];
  let mapping = map[1].replace(/\/\*$/, '').replace(/\/$/, '');
  if (!mapping.startsWith('/')) mapping = `/${mapping}`;
  const path = `/services/apexrest${mapping}`;
  const methods = [...src.matchAll(/@Http(Get|Post|Put|Patch|Delete)\b/gi)].map((m) => m[1].toUpperCase());
  const unique = [...new Set(methods.length ? methods : ['POST'])];
  return unique.filter((m) => METHODS.has(m)).map((method) => ({
    name: `${className || 'Apex REST'} ${method}`,
    path,
    method,
    keywords: [className, mapping.replace(/\//g, ' ').trim()].filter(Boolean),
    source: 'apex-rest',
    kind: 'apex-rest',
    legacyContract: false,
    description: `Discovered from Apex class ${className || ''} (@RestResource urlMapping='${map[1]}'). Sample body and Salesforce mapping still need to be set.`,
  }));
}

const DEMO_APEX = [
  {
    name: 'Contact sync API', path: '/services/apexrest/v1/contacts/sync', method: 'POST', object: 'Contact',
    keywords: ['contact sync', 'mulesoft', 'middleware'], source: 'apex-rest', legacyContract: true,
    samplePayload: { externalId: 'MW-QA-{{runId}}', firstName: 'Mia', lastName: 'Chen {{runId}}', email: '{{$randomEmail}}' },
    requestMapping: { firstName: 'FirstName', lastName: 'LastName', email: 'Email' },
    idPath: '$.salesforceId',
  },
  {
    name: 'ERP invoice sync', path: '/services/apexrest/v1/invoices', method: 'POST', object: 'Invoice__c',
    keywords: ['invoice', 'sap', 'erp'], source: 'apex-rest', legacyContract: true,
    samplePayload: { invoiceNumber: 'INV-QA-{{runId}}', amount: 2500.5, currency: 'EUR', status: 'Issued' },
    requestMapping: { invoiceNumber: 'Name', amount: 'Amount__c', currency: 'Currency__c', status: 'Status__c' },
    idPath: '$.salesforceId',
  },
  {
    name: 'Web lead intake API', path: '/services/apexrest/v1/leads', method: 'POST', object: 'Lead',
    keywords: ['lead intake', 'web lead'], source: 'apex-rest', legacyContract: true,
    samplePayload: { lastName: 'Mehta {{runId}}', company: 'Northwind QA', email: '{{$randomEmail}}' },
    requestMapping: { lastName: 'LastName', company: 'Company', email: 'Email' },
    idPath: '$.salesforceId',
  },
];

async function discoverApexRest(sf, project) {
  if (project && project.mode === 'demo') {
    return DEMO_APEX.map((e) => normalizeEndpoint(e)).filter(Boolean);
  }
  let rows = await querySafe(sf, "SELECT Id, Name, Body FROM ApexClass WHERE Status = 'Active' AND NamespacePrefix = null AND Body LIKE '%RestResource%' LIMIT 80", { tooling: true });
  if (!rows.length) {
    rows = await querySafe(sf, "SELECT Id, Name, Body FROM ApexClass WHERE Status = 'Active' LIMIT 40", { tooling: true });
  }
  const found = [];
  for (const r of rows) {
    found.push(...parseRestResource(r.Body, r.Name));
  }
  return found.map((e) => normalizeEndpoint(e)).filter(Boolean);
}

function exampleFromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 5) return {};
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const t = schema.type || (schema.properties ? 'object' : (schema.items ? 'array' : 'string'));
  if (t === 'object' || schema.properties) {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties || {})) out[k] = exampleFromSchema(v, depth + 1);
    return out;
  }
  if (t === 'array') return [exampleFromSchema(schema.items || { type: 'string' }, depth + 1)];
  if (t === 'integer' || t === 'number') return 1;
  if (t === 'boolean') return true;
  if (schema.format === 'email') return '{{$randomEmail}}';
  if (schema.format === 'date') return '{{$today}}';
  if (schema.format === 'uuid') return '{{$uuid}}';
  return 'QA';
}

function fromOpenApi(specOrText) {
  let spec = specOrText;
  let kind = 'openapi';
  if (typeof specOrText === 'string') {
    const parsed = parseContract(specOrText);
    spec = parsed.spec;
    kind = parsed.kind;
  } else if (specOrText && specOrText.swagger) {
    spec = specOrText;
    kind = 'swagger';
  } else if (specOrText && (specOrText.openapi || specOrText.paths)) {
    spec = specOrText;
    kind = specOrText.openapi ? 'openapi' : 'openapi';
  } else {
    const parsed = parseContract(specOrText);
    spec = parsed.spec;
    kind = parsed.kind;
  }
  if (kind === 'jsonschema') return [];
  const ops = listOperations(spec, kind);
  const out = [];
  for (const op of ops) {
    if (isSkippedPath(op.path)) continue;
    const item = (spec.paths || {})[op.path] || {};
    const rawOp = item[String(op.method || '').toLowerCase()] || {};
    const schema = requestSchema(kind, rawOp);
    const sample = schema ? exampleFromSchema(schema) : null;
    const responses = rawOp.responses || {};
    const success = Object.keys(responses).map(Number).filter((n) => n >= 200 && n < 300);
    out.push(normalizeEndpoint({
      name: op.summary || op.id || `${op.method} ${op.path}`,
      path: op.path,
      method: op.method,
      samplePayload: sample && typeof sample === 'object' && !Array.isArray(sample) ? sample : sample,
      successStatus: success.length ? success : [200, 201],
      keywords: [op.summary, op.id].filter(Boolean),
      description: rawOp.description || op.summary || '',
      source: 'openapi',
      legacyContract: false,
      responseSchema: (responses['200'] || responses['201'] || {}).content
        ? ((responses['200'] || responses['201']).content['application/json'] || {}).schema
        : (responses['200'] || responses['201'] || {}).schema || null,
    }));
  }
  return out.filter(Boolean);
}

function fromPostmanDrafts(drafts) {
  return (drafts || []).map((d) => {
    if (!d || !d.endpoint) return null;
    if (isSkippedPath(d.endpoint) && !/apexrest/i.test(d.endpoint)) return null;
    if (!/apexrest/i.test(d.endpoint) && d.apiType && !['HTTP', 'Apex REST'].includes(d.apiType)) return null;
    return normalizeEndpoint({
      name: d.title,
      path: d.endpoint,
      method: d.method,
      samplePayload: d.body && typeof d.body === 'object' ? d.body : null,
      keywords: [d.title],
      description: d.description || '',
      source: 'postman',
      legacyContract: false,
      successStatus: (d.assertions || []).filter((a) => a.type === 'status' && a.op === 'eq').map((a) => a.expected),
    });
  }).filter(Boolean);
}

function fromExplorer({ method, path, body } = {}) {
  let sample = null;
  if (body && typeof body === 'object') sample = body;
  else if (typeof body === 'string' && body.trim()) {
    try { sample = JSON.parse(body); } catch { sample = null; }
  }
  return normalizeEndpoint({
    name: `${method || 'POST'} ${path}`,
    path, method, samplePayload: sample, source: 'explorer', legacyContract: false,
    keywords: [path],
  });
}

function explorerTemplates(project) {
  return listEndpoints(project).map((e) => ({
    group: e.kind === 'http' ? 'Project HTTP' : 'Project Apex REST',
    name: e.name,
    method: e.method,
    path: e.path,
    body: e.samplePayload || undefined,
    apiType: e.kind === 'http' ? 'HTTP' : 'Apex REST',
    note: e.description || `Project endpoint ${e.id}`,
    endpointId: e.id,
  }));
}

module.exports = {
  newEndpointId, endpointIdFrom, normalizePath, normalizeEndpoint, listEndpoints, mergeEndpoints, matchEndpoints,
  usesLegacyContract, isSkippedPath, discoverApexRest, parseRestResource, fromOpenApi, fromPostmanDrafts,
  fromExplorer, explorerTemplates, exampleFromSchema, DEMO_APEX,
};
