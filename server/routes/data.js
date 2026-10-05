'use strict';
/** Test data manager, API contracts and saved explorer requests. */
const crypto = require('node:crypto');
const { route, HttpError, required } = require('../http');
const { repo, all, now, audit, nextId } = require('../db');
const { salesforceFor } = require('../connectors');
const { buildPayload } = require('../engine/generator');
const contracts = require('../engine/contracts');
const { isProduction } = require('../engine/safety');
const { maskDeep } = require('../lib/mask');
const { projectFrom, getProject, paginate, inFilter, likeFilter } = require('./util');

// Test-data categories mirror the plan: positive, negative, boundary, security, integration, bulk, regression (+ performance).
const CATEGORIES = ['Positive', 'Negative', 'Boundary', 'Security', 'Integration', 'Bulk', 'Regression', 'Performance'];
const { parse: parseCsvText } = require('../lib/csv');
const parseCsv = (text) => parseCsvText(text).records;

// Hostile-but-harmless strings: Salesforce must store them as literal data (or reject them) — never interpret them.
const SECURITY_STRINGS = [
  ["SOQL injection probe", "x' OR Name != '"],
  ['Script tag (stored XSS probe)', '<script>alert(1)</script>'],
  ['HTML attribute breakout', '"><img src=x onerror=alert(1)>'],
  ['Formula injection probe', '=HYPERLINK("http://example.invalid","x")'],
  ['Path traversal probe', '../../etc/passwd'],
  ['Unicode / RTL override', 'QA \u202Etest\u202C \u00e9\u4e2d\u6587'],
  ['Null byte probe', 'QA\u0000value'],
];

// ── Test data ──
route('GET', '/api/testdata', (ctx) => {
  const p = projectFrom(ctx);
  const where = ['projectId = $p']; const params = { p: p.id };
  inFilter(where, params, 'category', ctx.query.category, 'ca');
  inFilter(where, params, 'object', ctx.query.object, 'ob');
  inFilter(where, params, 'storyKey', ctx.query.storyKey, 'sk');
  likeFilter(where, params, ['name', 'object', 'storyKey', 'notes'], ctx.query.q);
  return paginate('test_data', ctx, { where, params, sortable: ['name', 'category', 'object', 'createdAt'], defaultSort: 'createdAt' });
});

route('POST', '/api/testdata', (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['name', 'category']);
  if (!CATEGORIES.includes(ctx.body.category)) throw new HttpError(400, `Category must be one of ${CATEGORIES.join(', ')}.`);
  const row = { id: nextId('TD', 4), projectId: p.id, name: ctx.body.name, category: ctx.body.category, object: ctx.body.object || null, storyKey: ctx.body.storyKey || null, payload: maskDeep(ctx.body.payload || {}), notes: ctx.body.notes || null, createdAt: now(), updatedAt: now() };
  repo.insert('test_data', row);
  audit('testdata', 'testdata.created', { user: ctx.user, projectId: p.id, detail: { id: row.id } });
  return row;
});

route('PUT', '/api/testdata/:id', (ctx) => {
  const t = repo.get('test_data', ctx.params.id);
  if (!t) throw new HttpError(404, `Test data ${ctx.params.id} not found.`);
  const patch = { updatedAt: now() };
  for (const k of ['name', 'category', 'object', 'storyKey', 'payload', 'notes']) if (ctx.body[k] !== undefined) patch[k] = k === 'payload' ? maskDeep(ctx.body[k]) : ctx.body[k];
  if (patch.category && !CATEGORIES.includes(patch.category)) throw new HttpError(400, `Category must be one of ${CATEGORIES.join(', ')}.`);
  repo.update('test_data', t.id, patch);
  return repo.get('test_data', t.id);
});

route('DELETE', '/api/testdata/:id', (ctx) => {
  const t = repo.get('test_data', ctx.params.id);
  if (!t) throw new HttpError(404, `Test data ${ctx.params.id} not found.`);
  repo.remove('test_data', t.id);
  audit('testdata', 'testdata.deleted', { user: ctx.user, projectId: t.projectId, detail: { id: t.id } });
  return { deleted: true };
});

route('POST', '/api/testdata/generate', async (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['object', 'category']);
  const count = Math.min(50, Math.max(1, Number(ctx.body.count || 1)));
  const sf = salesforceFor(p);
  if (!sf.available) throw new HttpError(503, sf.unavailableExplanation().title, sf.unavailableExplanation());
  let d;
  try { d = await sf.describe(ctx.body.object); } catch (e) { throw new HttpError(502, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
  const out = [];
  for (let i = 0; i < count; i++) {
    let payload = buildPayload(d, ctx.body.fields || []);
    const cat = ctx.body.category;
    let note = 'Valid record with required fields.';
    const str = d.fields.find((f) => f.required && f.type === 'string');
    if (cat === 'Negative') {
      const req = d.fields.find((f) => f.required && f.type !== 'reference');
      if (req) { delete payload[req.name]; note = `Missing required field ${req.name} → expect REQUIRED_FIELD_MISSING.`; }
    } else if (cat === 'Boundary' && str) {
      payload = { ...payload, [str.name]: i % 2 ? `{{$randomString:${str.length + 1}}}` : `{{$randomString:${str.length}}}` };
      note = i % 2 ? `${str.name} length ${str.length + 1} → expect STRING_TOO_LONG.` : `${str.name} at max length ${str.length}.`;
    } else if (cat === 'Security' && str) {
      const [label, probe] = SECURITY_STRINGS[i % SECURITY_STRINGS.length];
      payload = { ...payload, [str.name]: probe.slice(0, str.length || 255) };
      note = `${label} in ${str.name}: expect the value to be stored verbatim (or rejected with 400) and never executed. Verify by reading the record back.`;
    } else if (cat === 'Bulk') {
      const cols = Object.keys(payload).filter((k) => !/\{\{\w+Id\}\}/.test(String(payload[k])));
      payload = { records: 500, columns: cols, template: Object.fromEntries(cols.map((k) => [k, payload[k]])) };
      note = `CSV template for a Bulk API 2.0 ingest job (${cols.join(', ')}); make unique/external-id columns unique per row with {{runId}}.`;
    } else if (cat === 'Performance') {
      note = 'Use with composite collections (≤200 records per call).';
    }
    const row = { id: nextId('TD', 4), projectId: p.id, name: `${d.name} ${cat.toLowerCase()} #${i + 1}`, category: cat, object: d.name, storyKey: ctx.body.storyKey || null, payload, notes: `${note} Metadata: ${p.mode === 'demo' ? 'ASSUMED (demo org)' : 'VERIFIED (live describe)'}.`, createdAt: now(), updatedAt: now() };
    repo.insert('test_data', row);
    out.push(row);
  }
  audit('testdata', 'testdata.generated', { user: ctx.user, projectId: p.id, detail: { object: d.name, category: ctx.body.category, count } });
  return { created: out.length, items: out };
});

route('POST', '/api/testdata/import', (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['content', 'format', 'category']);
  if (!CATEGORIES.includes(ctx.body.category)) throw new HttpError(400, `Category must be one of ${CATEGORIES.join(', ')}.`);
  let records;
  try {
    records = ctx.body.format === 'csv' ? parseCsv(String(ctx.body.content)) : [].concat(JSON.parse(ctx.body.content));
  } catch (e) { throw new HttpError(400, `Could not parse ${ctx.body.format.toUpperCase()}: ${e.message}`, { action: 'Check the file format. CSV needs a header row; JSON must be an object or array of objects.' }); }
  if (records.length > 1000) throw new HttpError(400, `File contains ${records.length} records; the import limit is 1000.`);
  const out = records.map((r, i) => {
    const row = { id: nextId('TD', 4), projectId: p.id, name: r.__name || `${ctx.body.object || 'Record'} import #${i + 1}`, category: ctx.body.category, object: ctx.body.object || null, storyKey: ctx.body.storyKey || null, payload: maskDeep(Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('__')))), notes: `Imported from ${ctx.body.format.toUpperCase()}`, createdAt: now(), updatedAt: now() };
    repo.insert('test_data', row);
    return row;
  });
  audit('testdata', 'testdata.imported', { user: ctx.user, projectId: p.id, detail: { count: out.length, format: ctx.body.format } });
  return { created: out.length };
});

/** Clean up records created by runs (never automatic in production). */
route('POST', '/api/testdata/cleanup', async (ctx) => {
  const p = projectFrom(ctx);
  if (isProduction(p)) throw new HttpError(409, 'Test data cleanup is disabled for Production.', { cause: 'Production data is never created or deleted automatically.', action: 'Review and remove records manually through your change process.' });
  const runs = ctx.body.runId ? [repo.get('runs', ctx.body.runId)].filter(Boolean) : repo.find('runs', 'projectId = $p', { p: p.id }, 'ORDER BY startedAt DESC LIMIT 20');
  const ids = [...new Set(runs.flatMap((r) => (r.createdRecords || []).map((c) => c.id)))];
  if (!ids.length) return { attempted: 0, deleted: 0, message: 'No tracked test records to clean up.' };
  if (ctx.body.confirmed !== true) return { preview: true, count: ids.length, message: `${ids.length} tracked record(s) would be deleted from ${p.environment}.` };
  const sf = salesforceFor(p);
  if (!sf.available) throw new HttpError(503, sf.unavailableExplanation().title, sf.unavailableExplanation());
  let deleted = 0; const errors = [];
  for (let i = 0; i < ids.length; i += 200) {
    const res = await sf.request({ method: 'DELETE', path: `/services/data/v${p.apiVersion}/composite/sobjects`, query: { ids: ids.slice(i, i + 200).join(','), allOrNone: 'false' } });
    if (res.status === 200 && Array.isArray(res.body)) deleted += res.body.filter((x) => x.success).length; else errors.push(`HTTP ${res.status}`);
  }
  for (const r of runs) repo.update('runs', r.id, { createdRecords: [] });
  audit('testdata', 'testdata.cleanup', { user: ctx.user, projectId: p.id, detail: { attempted: ids.length, deleted } });
  return { attempted: ids.length, deleted, errors };
});

// ── Contracts ──
route('GET', '/api/contracts', (ctx) => {
  const p = projectFrom(ctx);
  return all('SELECT id, name, kind, createdAt FROM contracts WHERE projectId = $p ORDER BY createdAt DESC', { p: p.id }).map((c) => {
    const full = repo.get('contracts', c.id);
    return { ...c, operations: contracts.listOperations(full.spec, full.kind).length, linkedTests: all("SELECT COUNT(*) AS n FROM test_cases WHERE contractRef LIKE $c", { c: `%${c.id}%` })[0].n };
  });
});

route('POST', '/api/contracts', (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['name', 'content']);
  let parsed;
  try { parsed = contracts.parse(ctx.body.content); } catch (e) { throw new HttpError(400, `Could not parse the specification: ${e.message}`, { action: 'Upload OpenAPI 3 / Swagger 2 (JSON or YAML) or a JSON Schema document.' }); }
  const c = { id: nextId('CT', 3), projectId: p.id, name: ctx.body.name, kind: parsed.kind, spec: parsed.spec, createdAt: now() };
  repo.insert('contracts', c);
  audit('contracts', 'contract.uploaded', { user: ctx.user, projectId: p.id, detail: { id: c.id, kind: c.kind } });
  return { id: c.id, name: c.name, kind: c.kind, operations: contracts.listOperations(c.spec, c.kind) };
});

route('GET', '/api/contracts/:id', (ctx) => {
  const c = repo.get('contracts', ctx.params.id);
  if (!c) throw new HttpError(404, `Contract ${ctx.params.id} not found.`);
  return { id: c.id, name: c.name, kind: c.kind, createdAt: c.createdAt, operations: contracts.listOperations(c.spec, c.kind), spec: c.spec };
});

route('DELETE', '/api/contracts/:id', (ctx) => {
  const c = repo.get('contracts', ctx.params.id);
  if (!c) throw new HttpError(404, `Contract ${ctx.params.id} not found.`);
  repo.remove('contracts', c.id);
  audit('contracts', 'contract.deleted', { user: ctx.user, projectId: c.projectId, detail: { id: c.id } });
  return { deleted: true };
});

/** Validate all results of a run against a contract. */
route('POST', '/api/contracts/:id/validate', (ctx) => {
  const c = repo.get('contracts', ctx.params.id);
  if (!c) throw new HttpError(404, `Contract ${ctx.params.id} not found.`);
  const runId = ctx.body.runId || (all('SELECT id FROM runs WHERE projectId = $p ORDER BY startedAt DESC LIMIT 1', { p: c.projectId })[0] || {}).id;
  if (!runId) throw new HttpError(409, 'No execution found to validate.', { action: 'Run tests first.' });
  const results = repo.find('run_results', "runId = $r AND status != 'skipped' AND status != 'blocked'", { r: runId }, 'ORDER BY seq');
  const checks = results.map((r) => {
    const v = contracts.validateExchange(c, { method: r.method, path: (r.request && r.request.url) || r.endpoint, status: r.statusCode, headers: (r.response && r.response.headers) || {}, body: r.response && r.response.body, requestBody: r.request && r.request.body });
    return { resultId: r.id, testCaseId: r.testCaseId, title: r.title, method: r.method, endpoint: r.endpoint, statusCode: r.statusCode, ...v };
  });
  const applicable = checks.filter((x) => x.status !== 'NOT_APPLICABLE');
  return { contractId: c.id, runId, total: checks.length, applicable: applicable.length, passed: applicable.filter((x) => x.status === 'PASS').length, failed: applicable.filter((x) => x.status === 'FAIL').length, checks };
});

/** Validate a single ad-hoc payload against an operation (contract playground). */
route('POST', '/api/contracts/:id/check', (ctx) => {
  const c = repo.get('contracts', ctx.params.id);
  if (!c) throw new HttpError(404, `Contract ${ctx.params.id} not found.`);
  let body = ctx.body.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { throw new HttpError(400, `Response body is not valid JSON: ${e.message}`); } }
  return contracts.validateExchange(c, { method: ctx.body.method || 'GET', path: ctx.body.path || '/', status: Number(ctx.body.status || 200), headers: ctx.body.headers || {}, body });
});

// ── Saved requests (API Explorer collections) ──
route('GET', '/api/requests', (ctx) => {
  const p = projectFrom(ctx);
  return repo.find('saved_requests', 'projectId = $p', { p: p.id }, 'ORDER BY collection, name');
});

route('POST', '/api/requests', (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['name', 'method', 'path']);
  if (Object.keys(ctx.body.headers || {}).some((h) => /^authorization$/i.test(h))) throw new HttpError(400, 'Saved requests cannot contain Authorization headers.');
  const r = { id: crypto.randomUUID(), projectId: p.id, name: ctx.body.name, collection: ctx.body.collection || 'Default', apiType: ctx.body.apiType || 'REST', method: String(ctx.body.method).toUpperCase(), path: ctx.body.path, headers: ctx.body.headers || {}, query: ctx.body.query || {}, body: ctx.body.body === undefined ? null : ctx.body.body, auth: ctx.body.auth || 'default', createdAt: now() };
  repo.insert('saved_requests', r);
  audit('explorer', 'request.saved', { user: ctx.user, projectId: p.id, detail: { name: r.name } });
  return r;
});

route('DELETE', '/api/requests/:id', (ctx) => {
  const r = repo.get('saved_requests', ctx.params.id);
  if (!r) throw new HttpError(404, `Saved request ${ctx.params.id} not found.`);
  repo.remove('saved_requests', r.id);
  return { deleted: true };
});
