'use strict';
/**
 * Scenario builders for the non-CRUD Salesforce API families named in a story:
 * Bulk API 2.0, Composite / Composite Graph, GraphQL, SOAP, Tooling, Platform
 * Events, Connect REST, OAuth 2.0 and query pagination.
 *
 * Everything here is driven by the story text (analysis.apiTypes) and the
 * describe metadata already discovered — no endpoints or fields are invented:
 * field names come from describe, endpoints are the documented Salesforce
 * paths. Production projects only receive read-only coverage.
 */
const csv = require('../lib/csv');

const has = (analysis, name) => analysis.apiTypes.includes(name);
const isProd = (b) => String(b.project.environment).toLowerCase() === 'production';
const scalar = (v) => v !== null && v !== undefined && typeof v !== 'object';

function requiredParents(d) {
  return d.fields.filter((f) => f.type === 'reference' && f.required && f.createable && f.referenceTo && f.referenceTo.length);
}

/** Create required parent records for `d` inside scenario `s`; returns { overrides } or null when a parent cannot be built. */
function parentSetup(b, s, d, analysis, h, prefix) {
  const overrides = {};
  for (const pf of requiredParents(d)) {
    const parentObj = pf.referenceTo[0];
    const pd = analysis.describes[parentObj];
    if (!pd) return null;
    const pVar = `${prefix}${h.camel(parentObj)}Id`;
    b.add(s, {
      title: `Setup: create parent ${parentObj} for ${d.name}.${pf.name}`, method: 'POST', endpoint: `${b.v}/sobjects/${parentObj}`,
      body: h.buildPayload(pd, []), assertions: [{ type: 'status', op: 'eq', expected: 201 }, { type: 'jsonpath', path: '$.id', op: 'matches', expected: h.SF_ID_RX }],
      extract: [{ var: pVar, path: '$.id' }], tags: ['setup'], priority: 'P1', cleanup: { object: parentObj, idVar: pVar },
    });
    overrides[pf.name] = `{{${pVar}}}`;
  }
  return overrides;
}

function targetObject(analysis) {
  return analysis.objects.find((o) => analysis.describes[o] && !o.endsWith('__e')) || null;
}

const unauth = (extra) => ({ auth: 'none', assertions: [{ type: 'status', op: 'eq', expected: 401 }], tags: ['authentication'], ...extra });

// ── Bulk API 2.0 ─────────────────────────────────────────────────────────────
function bulkScenarios(b, analysis, h) {
  const obj = targetObject(analysis);
  if (!obj) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: 'Bulk API 2.0 is mentioned but no target object could be identified, so no ingest-job tests were generated.' });
    return;
  }
  if (isProd(b)) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: `Production project: Bulk API 2.0 ingest tests for ${obj} were not generated (they create and modify records). Run them in a sandbox.` });
    return;
  }
  const d = analysis.describes[obj];
  const v = b.v;
  const s = b.scenario(`Bulk API 2.0 — ${d.label || obj} ingest job lifecycle with per-record results`, 'Integration', 'Bulk API 2.0', obj, `Create, upload, close and inspect a Bulk API 2.0 insert job for ${obj}. Verifies partial success: valid rows are inserted and invalid rows are reported in failedResults without failing the job.`);
  const overrides = parentSetup(b, s, d, analysis, h, 'bulk');
  if (overrides === null) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: `Bulk API 2.0: a required parent of ${obj} could not be described, so row data cannot be built automatically.` });
    return;
  }
  const mentioned = (analysis.fields || {})[obj] || [];
  const payload = Object.fromEntries(Object.entries(h.buildPayload(d, mentioned, overrides)).filter(([, val]) => scalar(val)));
  const cols = Object.keys(payload);
  const fieldOf = (n) => d.fields.find((f) => f.name === n);
  const badCol = cols.find((c) => fieldOf(c) && fieldOf(c).required && fieldOf(c).type !== 'reference') || cols.find((c) => fieldOf(c) && fieldOf(c).type === 'email');
  const badIsRequired = badCol && fieldOf(badCol).required;
  const cell = (val) => (typeof val === 'boolean' ? String(val) : val);
  const goodRows = [0, 1, 2].map(() => cols.map((c) => cell(payload[c])));
  const badRow = badCol ? cols.map((c) => (c === badCol ? (badIsRequired ? '' : 'not-an-email') : cell(payload[c]))) : null;
  const rows = [cols, ...goodRows, ...(badRow ? [badRow] : [])];
  const total = rows.length - 1;
  const failed = badRow ? 1 : 0;
  const base = `${v}/jobs/ingest`;
  const bulk = { apiType: 'Bulk API 2.0', testType: 'Integration' };

  b.add(s, { ...bulk, title: `Create a Bulk API 2.0 insert job for ${obj}`, method: 'POST', endpoint: base, body: { object: obj, operation: 'insert', contentType: 'CSV', lineEnding: 'LF' },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.id', op: 'exists' }, { type: 'jsonpath', path: '$.state', op: 'eq', expected: 'Open' }, { type: 'jsonpath', path: '$.operation', op: 'eq', expected: 'insert' }, { type: 'jsonpath', path: '$.object', op: 'eq', expected: obj }],
    extract: [{ var: 'bulkJobId', path: '$.id' }], tags: ['bulk-api'] });
  b.add(s, { ...bulk, title: `Upload ${total} CSV rows${badRow ? ' (one deliberately invalid)' : ''} to the job`, method: 'PUT', endpoint: `${base}/{{bulkJobId}}/batches`, headers: { 'Content-Type': 'text/csv' }, bodyRaw: csv.stringify(rows),
    assertions: [{ type: 'status', op: 'eq', expected: 201 }], tags: ['bulk-api'] });
  b.add(s, { ...bulk, title: 'Close the job (state=UploadComplete) so Salesforce starts processing', method: 'PATCH', endpoint: `${base}/{{bulkJobId}}`, body: { state: 'UploadComplete' },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.state', op: 'in', expected: ['UploadComplete', 'InProgress'] }], tags: ['bulk-api'] });
  b.add(s, { ...bulk, title: `Job completes: ${total} processed, ${failed} failed`, method: 'GET', endpoint: `${base}/{{bulkJobId}}`,
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.state', op: 'eq', expected: 'JobComplete' }, { type: 'jsonpath', path: '$.numberRecordsProcessed', op: 'eq', expected: total }, { type: 'jsonpath', path: '$.numberRecordsFailed', op: 'eq', expected: failed }],
    tags: ['bulk-api', 'poll'], description: 'Bulk jobs are asynchronous: on live orgs this request is retried (up to 30 s) until the job reaches JobComplete.' });
  b.add(s, { ...bulk, title: `successfulResults lists the ${total - failed} inserted rows with Salesforce Ids`, method: 'GET', endpoint: `${base}/{{bulkJobId}}/successfulResults`,
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'header', name: 'content-type', op: 'contains', expected: 'csv' }, { type: 'csv', path: 'header', op: 'contains', expected: 'sf__Id' }, { type: 'csv', path: 'rows', op: 'eq', expected: total - failed }, { type: 'csv', path: 'column:sf__Created', op: 'notContains', expected: 'false' }],
    cleanup: { object: obj, fromBulkResults: true }, tags: ['bulk-api', 'poll'] });
  if (badRow) {
    const code = badIsRequired ? 'REQUIRED_FIELD_MISSING' : 'INVALID_EMAIL_ADDRESS';
    b.add(s, { ...bulk, title: `failedResults reports the invalid row (${code}) without failing the job`, method: 'GET', endpoint: `${base}/{{bulkJobId}}/failedResults`,
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'csv', path: 'header', op: 'contains', expected: 'sf__Error' }, { type: 'csv', path: 'rows', op: 'eq', expected: 1 }, { type: 'csv', path: 'column:sf__Error', op: 'contains', expected: code }],
      tags: ['bulk-api', 'partial-failure', 'poll'] });
  }
  b.add(s, { ...bulk, title: 'Completed job appears in the job list', method: 'GET', endpoint: base,
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }], tags: ['bulk-api'] });
  b.add(s, { ...bulk, title: 'Delete the completed job', method: 'DELETE', endpoint: `${base}/{{bulkJobId}}`, assertions: [{ type: 'status', op: 'eq', expected: 204 }], tags: ['bulk-api', 'cleanup'] });

  // Negative / security
  const n = b.scenario(`Bulk API 2.0 — job validation and security for ${obj}`, 'Negative', 'Bulk API 2.0', obj, 'Invalid job definitions, wrong content types and bad lifecycle transitions are rejected with clear errors.');
  const neg = { apiType: 'Bulk API 2.0', testType: 'Negative', tags: ['bulk-api'] };
  b.add(n, { ...neg, title: 'Creating a job for a non-existent object is rejected', method: 'POST', endpoint: base, body: { object: 'QA_Not_A_Real_Object__c', operation: 'insert' },
    assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALIDJOB' }] });
  b.add(n, { ...neg, title: 'Creating a job with an invalid operation is rejected', method: 'POST', endpoint: base, body: { object: obj, operation: 'explode' },
    assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALIDJOB' }] });
  b.add(n, { ...neg, title: 'Creating an upsert job without externalIdFieldName is rejected', method: 'POST', endpoint: base, body: { object: obj, operation: 'upsert' },
    assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALIDJOB' }] });
  b.add(n, { ...neg, title: 'Create a job to test lifecycle errors', method: 'POST', endpoint: base, body: { object: obj, operation: 'insert' },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }], extract: [{ var: 'bulkNegJobId', path: '$.id' }], tags: ['bulk-api', 'setup'] });
  b.add(n, { ...neg, title: 'Closing a job that has no uploaded data is rejected', method: 'PATCH', endpoint: `${base}/{{bulkNegJobId}}`, body: { state: 'UploadComplete' },
    assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALIDJOB' }] });
  b.add(n, { ...neg, title: 'Uploading data with a non-CSV Content-Type is rejected', method: 'PUT', endpoint: `${base}/{{bulkNegJobId}}/batches`, headers: { 'Content-Type': 'text/plain' }, bodyRaw: csv.stringify([cols, goodRows[0]]),
    assertions: [{ type: 'status', op: 'eq', expected: 415 }] });
  b.add(n, { ...neg, title: 'Abort an open job', method: 'PATCH', endpoint: `${base}/{{bulkNegJobId}}`, body: { state: 'Aborted' },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.state', op: 'eq', expected: 'Aborted' }] });
  b.add(n, { ...neg, title: 'Uploading data to an aborted job is rejected', method: 'PUT', endpoint: `${base}/{{bulkNegJobId}}/batches`, headers: { 'Content-Type': 'text/csv' }, bodyRaw: csv.stringify([cols, goodRows[0]]),
    assertions: [{ type: 'status', op: 'eq', expected: 400 }] });
  b.add(n, { ...neg, title: 'Delete the aborted job', method: 'DELETE', endpoint: `${base}/{{bulkNegJobId}}`, assertions: [{ type: 'status', op: 'eq', expected: 204 }], tags: ['bulk-api', 'cleanup'] });
  b.add(n, { ...neg, testType: 'Security', title: 'Creating a job without an access token is rejected', method: 'POST', endpoint: base, body: { object: obj, operation: 'insert' }, ...unauth({ tags: ['authentication', 'bulk-api'] }) });

  // Idempotency: upserting the same external ids twice creates once and updates once.
  const ext = d.fields.find((f) => f.externalId && f.createable && f.name !== 'Id');
  if (ext) {
    const u = b.scenario(`Bulk API 2.0 — idempotent upsert by ${ext.name}`, 'Integration', 'Bulk API 2.0', obj, `Running the same upsert job twice must create each ${ext.name} once and update it the second time (no duplicates).`);
    const uOverrides = parentSetup(b, u, d, analysis, h, 'bulkUpsert');
    const upPayload = Object.fromEntries(Object.entries(h.buildPayload(d, mentioned, uOverrides || {})).filter(([, val]) => scalar(val)));
    const ucols = [...new Set([ext.name, ...Object.keys(upPayload)])];
    const urows = [ucols, ...[1, 2].map((i) => ucols.map((c) => (c === ext.name ? `QA-BULK-{{runId}}-${i}` : cell(upPayload[c]))))];
    const upBody = csv.stringify(urows);
    for (const run of [1, 2]) {
      const jv = `bulkUpsertJob${run}`;
      b.add(u, { ...bulk, title: `Upsert run ${run}: create job`, method: 'POST', endpoint: base, body: { object: obj, operation: 'upsert', externalIdFieldName: ext.name, lineEnding: 'LF' },
        assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.externalIdFieldName', op: 'eq', expected: ext.name }], extract: [{ var: jv, path: '$.id' }], tags: ['bulk-api', 'idempotency'] });
      b.add(u, { ...bulk, title: `Upsert run ${run}: upload the same 2 rows`, method: 'PUT', endpoint: `${base}/{{${jv}}}/batches`, headers: { 'Content-Type': 'text/csv' }, bodyRaw: upBody, assertions: [{ type: 'status', op: 'eq', expected: 201 }], tags: ['bulk-api', 'idempotency'] });
      b.add(u, { ...bulk, title: `Upsert run ${run}: close job`, method: 'PATCH', endpoint: `${base}/{{${jv}}}`, body: { state: 'UploadComplete' }, assertions: [{ type: 'status', op: 'eq', expected: 200 }], tags: ['bulk-api', 'idempotency'] });
      b.add(u, { ...bulk, title: `Upsert run ${run}: rows ${run === 1 ? 'are created' : 'are updated, not duplicated'}`, method: 'GET', endpoint: `${base}/{{${jv}}}/successfulResults`,
        assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'csv', path: 'rows', op: 'eq', expected: 2 }, run === 1 ? { type: 'csv', path: 'column:sf__Created', op: 'notContains', expected: 'false' } : { type: 'csv', path: 'column:sf__Created', op: 'notContains', expected: 'true' }],
        ...(run === 1 ? { cleanup: { object: obj, fromBulkResults: true } } : {}), tags: ['bulk-api', 'idempotency', 'poll'] });
    }
  }
}

// ── Composite / Composite Graph ──────────────────────────────────────────────
function compositeScenarios(b, analysis, h) {
  const obj = targetObject(analysis);
  const v = b.v;
  const prod = isProd(b);
  const comp = { apiType: 'Composite', testType: 'Functional' };
  if (prod || !obj) {
    const s = b.scenario('Composite API — read-only requests', 'Functional', 'Composite', obj || null, 'GET-only composite requests are safe against Production.');
    b.add(s, { ...comp, title: 'Composite request with GET subrequests returns one response per subrequest', method: 'POST', endpoint: `${v}/composite`,
      body: { allOrNone: false, compositeRequest: [{ method: 'GET', url: `${v}/limits`, referenceId: 'limits' }, { method: 'GET', url: `${v}/sobjects`, referenceId: 'objects' }] },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.compositeResponse', op: 'type', expected: 'array' }, { type: 'jsonpath', path: '$.compositeResponse[0].httpStatusCode', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.compositeResponse[1].httpStatusCode', op: 'eq', expected: 200 }],
      tags: ['composite'] });
    if (prod) analysis.gaps.push({ label: 'RECOMMENDED', text: 'Production project: composite write/rollback tests were not generated. Cover them in a sandbox.' });
    b.add(s, { ...comp, testType: 'Security', title: 'Composite request without an access token is rejected', method: 'POST', endpoint: `${v}/composite`, body: { compositeRequest: [{ method: 'GET', url: `${v}/limits`, referenceId: 'limits' }] }, ...unauth({ tags: ['authentication', 'composite'] }) });
    return;
  }
  const d = analysis.describes[obj];
  const mentioned = (analysis.fields || {})[obj] || [];
  const s = b.scenario(`Composite API — ${d.label || obj} multi-record transactions`, 'Functional', 'Composite', obj, `Composite collections, dependent subrequests with @{reference} and Composite Graph for ${obj}; verifies allOrNone rollback leaves no partial data.`);
  const overrides = parentSetup(b, s, d, analysis, h, 'comp');
  if (overrides === null) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: `Composite API: a required parent of ${obj} could not be described, so request bodies cannot be built automatically.` });
    return;
  }
  const payload = () => h.buildPayload(d, mentioned, overrides);
  const rec = (extra = {}) => ({ attributes: { type: obj }, ...payload(), ...extra });
  const marker = Object.keys(payload()).find((k) => { const f = d.fields.find((x) => x.name === k); return f && f.type === 'string' && !f.externalId && !f.unique && (f.length || 80) >= 14; });
  const clean = { object: obj, fromResponse: true };

  b.add(s, { ...comp, title: `sObject collection: create 2 ${obj} records (allOrNone=true)`, method: 'POST', endpoint: `${v}/composite/sobjects`, body: { allOrNone: true, records: [rec(), rec()] },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$[0].success', op: 'eq', expected: true }, { type: 'jsonpath', path: '$[1].success', op: 'eq', expected: true }, { type: 'jsonpath', path: '$[0].id', op: 'matches', expected: h.SF_ID_RX }],
    cleanup: { object: obj, fromCompositeResponse: true }, tags: ['composite'] });
  b.add(s, { ...comp, title: `sObject collection: one invalid record with allOrNone=false saves the valid one`, method: 'POST', endpoint: `${v}/composite/sobjects`, body: { allOrNone: false, records: [rec(), { attributes: { type: obj } }] },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$[0].success', op: 'eq', expected: true }, { type: 'jsonpath', path: '$[1].success', op: 'eq', expected: false }, { type: 'jsonpath', path: '$[1].errors[0].statusCode', op: 'exists' }],
    cleanup: { object: obj, fromCompositeResponse: true }, tags: ['composite', 'partial-failure'] });
  b.add(s, { ...comp, testType: 'Negative', title: 'sObject collection: one invalid record with allOrNone=true rolls everything back', method: 'POST', endpoint: `${v}/composite/sobjects`,
    body: { allOrNone: true, records: [rec(marker ? { [marker]: 'QA-RB-{{runId}}' } : {}), { attributes: { type: obj } }] },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$[0].success', op: 'eq', expected: false }, { type: 'jsonpath', path: '$[0].errors[0].statusCode', op: 'eq', expected: 'ALL_OR_NONE_OPERATION_ROLLED_BACK' }, { type: 'jsonpath', path: '$[1].success', op: 'eq', expected: false }],
    cleanup: { object: obj, fromCompositeResponse: true }, tags: ['composite', 'rollback'] });
  if (marker) {
    b.add(s, { ...comp, testType: 'Negative', title: 'Rolled-back record was not persisted (data check)', method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT COUNT() FROM ${obj} WHERE ${marker} = 'QA-RB-{{runId}}'` },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.totalSize', op: 'eq', expected: 0 }], tags: ['composite', 'rollback', 'data-validation'] });
  }
  b.add(s, { ...comp, title: `Composite: create ${obj} then read it back using @{reference}`, method: 'POST', endpoint: `${v}/composite`,
    body: { allOrNone: true, compositeRequest: [{ method: 'POST', url: `${v}/sobjects/${obj}`, referenceId: 'newRecord', body: payload() }, { method: 'GET', url: `${v}/sobjects/${obj}/@{newRecord.id}`, referenceId: 'readBack' }] },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.compositeResponse[0].httpStatusCode', op: 'eq', expected: 201 }, { type: 'jsonpath', path: '$.compositeResponse[1].httpStatusCode', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.compositeResponse[1].body.attributes.type', op: 'eq', expected: obj }],
    cleanup: clean, tags: ['composite', 'reference'] });
  b.add(s, { ...comp, testType: 'Negative', title: 'Composite allOrNone=true: a failing subrequest halts the transaction', method: 'POST', endpoint: `${v}/composite`,
    body: { allOrNone: true, compositeRequest: [{ method: 'POST', url: `${v}/sobjects/${obj}`, referenceId: 'ok', body: payload() }, { method: 'POST', url: `${v}/sobjects/${obj}`, referenceId: 'bad', body: {} }] },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.compositeResponse[1].httpStatusCode', op: 'eq', expected: 400 }, { type: 'jsonpath', path: '$.compositeResponse[0].httpStatusCode', op: 'eq', expected: 400 }],
    cleanup: clean, tags: ['composite', 'rollback'] });
  b.add(s, { ...comp, testType: 'Negative', title: 'Composite request with more than 25 subrequests is rejected', method: 'POST', endpoint: `${v}/composite`,
    body: { allOrNone: false, compositeRequest: Array.from({ length: 26 }, (_, i) => ({ method: 'GET', url: `${v}/limits`, referenceId: `r${i + 1}` })) },
    assertions: [{ type: 'status', op: 'eq', expected: 400 }], tags: ['composite', 'boundary'] });
  b.add(s, { ...comp, title: 'Composite Graph: independent graph creates records atomically', method: 'POST', endpoint: `${v}/composite/graph`,
    body: { graphs: [{ graphId: 'g1', compositeRequest: [{ method: 'POST', url: `${v}/sobjects/${obj}`, referenceId: 'a', body: payload() }, { method: 'GET', url: `${v}/sobjects/${obj}/@{a.id}`, referenceId: 'b' }] }] },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.graphs[0].isSuccessful', op: 'eq', expected: true }, { type: 'jsonpath', path: '$.graphs[0].graphId', op: 'eq', expected: 'g1' }],
    cleanup: clean, tags: ['composite', 'graph'] });
  b.add(s, { ...comp, testType: 'Negative', title: 'Composite Graph: a failing node fails the whole graph', method: 'POST', endpoint: `${v}/composite/graph`,
    body: { graphs: [{ graphId: 'g2', compositeRequest: [{ method: 'POST', url: `${v}/sobjects/${obj}`, referenceId: 'a', body: payload() }, { method: 'POST', url: `${v}/sobjects/${obj}`, referenceId: 'b', body: {} }] }] },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.graphs[0].isSuccessful', op: 'eq', expected: false }],
    cleanup: clean, tags: ['composite', 'graph', 'rollback'] });
  b.add(s, { ...comp, testType: 'Security', title: 'Composite request without an access token is rejected', method: 'POST', endpoint: `${v}/composite`, body: { compositeRequest: [{ method: 'GET', url: `${v}/limits`, referenceId: 'limits' }] }, ...unauth({ tags: ['authentication', 'composite'] }) });
}

// ── GraphQL ──────────────────────────────────────────────────────────────────
function graphqlScenarios(b, analysis, h) {
  const obj = targetObject(analysis);
  if (!obj) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: 'GraphQL is mentioned but no target object could be identified, so no GraphQL tests were generated.' });
    return;
  }
  const d = analysis.describes[obj];
  const mentioned = (analysis.fields || {})[obj] || [];
  const fieldNames = [...new Set([...mentioned, ...d.fields.filter((f) => f.required).map((f) => f.name), 'Name'])]
    .filter((n) => { const f = d.fields.find((x) => x.name === n); return f && !['reference', 'textarea', 'address', 'location'].includes(f.type) && n !== 'Id'; }).slice(0, 3);
  const sel = ['Id', ...fieldNames.map((f) => `${f} { value }`)].join(' ');
  const path = `$.data.uiapi.query.${obj}`;
  const gql = { apiType: 'GraphQL', testType: 'Functional', method: 'POST', endpoint: `${b.v}/graphql` };
  const q = (inner) => ({ query: inner });
  const s = b.scenario(`GraphQL — ${d.label || obj} read queries`, 'Functional', 'GraphQL', obj, `UI API GraphQL queries for ${obj}: fields, pagination envelope and validation errors.`);
  const noErrors = { type: 'jsonpath', path: '$.errors', op: 'notContains', expected: 'message', label: 'No GraphQL errors' };
  b.add(s, { ...gql, title: `Query first 5 ${obj} records with ${fieldNames.join(', ') || 'Id'}`, body: q(`query { uiapi { query { ${obj}(first: 5) { totalCount edges { node { ${sel} } } pageInfo { hasNextPage endCursor } } } } }`),
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, noErrors, { type: 'jsonpath', path: `${path}.edges`, op: 'type', expected: 'array' }, { type: 'jsonpath', path: `${path}.edges[0].node.Id`, op: 'matches', expected: h.SF_ID_RX }, { type: 'jsonpath', path: `${path}.edges.length`, op: 'lte', expected: 5 }],
    tags: ['graphql'] });
  b.add(s, { ...gql, testType: 'Boundary', title: 'first: 1 returns at most one edge and a pageInfo flag', body: q(`query { uiapi { query { ${obj}(first: 1) { edges { node { Id } } pageInfo { hasNextPage } } } } }`),
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, noErrors, { type: 'jsonpath', path: `${path}.edges.length`, op: 'lte', expected: 1 }, { type: 'jsonpath', path: `${path}.pageInfo.hasNextPage`, op: 'type', expected: 'boolean' }], tags: ['graphql', 'pagination'] });
  b.add(s, { ...gql, title: 'Variables are accepted', body: { query: `query Q($n: Int = 2) { uiapi { query { ${obj}(first: $n) { edges { node { Id } } } } } }`, variables: { n: 2 } },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, noErrors, { type: 'jsonpath', path: `${path}.edges.length`, op: 'lte', expected: 2 }], tags: ['graphql'] });
  const neg = { ...gql, testType: 'Negative', tags: ['graphql', 'error-contract'] };
  b.add(s, { ...neg, title: 'Unknown field returns a GraphQL validation error', body: q(`query { uiapi { query { ${obj} { edges { node { QA_Not_A_Field__c { value } } } } } } }`),
    assertions: [{ type: 'status', op: 'in', expected: [200, 400] }, { type: 'bodyContains', expected: 'QA_Not_A_Field__c' }, { type: 'jsonpath', path: `${path}.edges`, op: 'notExists' }] });
  b.add(s, { ...neg, title: 'Unknown object returns a GraphQL validation error', body: q('query { uiapi { query { QA_Not_An_Object__c { edges { node { Id } } } } } }'),
    assertions: [{ type: 'status', op: 'in', expected: [200, 400] }, { type: 'bodyContains', expected: 'QA_Not_An_Object__c' }, { type: 'jsonpath', path: '$.data.uiapi.query.QA_Not_An_Object__c', op: 'notExists' }] });
  b.add(s, { ...neg, title: 'Malformed query returns a syntax error and no data', body: q(`query { uiapi { query { ${obj}( { `),
    assertions: [{ type: 'status', op: 'in', expected: [200, 400] }, { type: 'jsonpath', path: '$.data', op: 'notExists' }] });
  b.add(s, { ...neg, testType: 'Boundary', title: 'first: 0 is rejected', body: q(`query { uiapi { query { ${obj}(first: 0) { edges { node { Id } } } } } }`),
    assertions: [{ type: 'status', op: 'in', expected: [200, 400] }, { type: 'jsonpath', path: `${path}.edges`, op: 'notExists' }] });
  b.add(s, { ...gql, testType: 'Security', title: 'GraphQL query without an access token is rejected', body: q(`query { uiapi { query { ${obj}(first: 1) { edges { node { Id } } } } } }`), ...unauth({ tags: ['authentication', 'graphql'] }) });
}

// ── SOAP ─────────────────────────────────────────────────────────────────────
const soapEnv = (bodyXml, session = '{{sessionId}}') => `<?xml version="1.0" encoding="utf-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">\n  <soapenv:Header><urn:SessionHeader><urn:sessionId>${session}</urn:sessionId></urn:SessionHeader></soapenv:Header>\n  <soapenv:Body>${bodyXml}</soapenv:Body>\n</soapenv:Envelope>`;

function soapScenarios(b, analysis) {
  const obj = targetObject(analysis);
  const soap = { apiType: 'SOAP', testType: 'Functional', method: 'POST', endpoint: '/services/Soap/u/{{apiVersion}}', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' } };
  const s = b.scenario('SOAP API — partner endpoint', 'Functional', 'SOAP', obj, 'Partner SOAP calls: session handling, queries and SOAP fault contracts (faults return HTTP 500).');
  b.add(s, { ...soap, title: 'getServerTimestamp returns a timestamp', bodyRaw: soapEnv('<urn:getServerTimestamp/>'),
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'header', name: 'content-type', op: 'contains', expected: 'xml' }, { type: 'bodyContains', expected: 'getServerTimestampResponse' }, { type: 'bodyContains', expected: '<timestamp>' }], tags: ['soap'] });
  if (obj) {
    b.add(s, { ...soap, title: `query: SELECT Id FROM ${obj} LIMIT 2 returns a result set`, bodyRaw: soapEnv(`<urn:query><urn:queryString>SELECT Id FROM ${obj} LIMIT 2</urn:queryString></urn:query>`),
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'bodyContains', expected: 'queryResponse' }, { type: 'bodyContains', expected: '<size>' }], tags: ['soap'] });
    b.add(s, { ...soap, testType: 'Negative', title: 'query on an unknown field returns an INVALID_FIELD SOAP fault', bodyRaw: soapEnv(`<urn:query><urn:queryString>SELECT QA_Not_A_Field__c FROM ${obj}</urn:queryString></urn:query>`),
      assertions: [{ type: 'status', op: 'eq', expected: 500 }, { type: 'bodyContains', expected: 'Fault' }, { type: 'bodyContains', expected: 'INVALID_FIELD' }], tags: ['soap', 'error-contract'] });
  }
  b.add(s, { ...soap, testType: 'Security', title: 'Invalid session id returns an INVALID_SESSION_ID fault', bodyRaw: soapEnv('<urn:getServerTimestamp/>', 'INVALID_SESSION_QA'),
    assertions: [{ type: 'status', op: 'eq', expected: 500 }, { type: 'bodyContains', expected: 'INVALID_SESSION_ID' }], tags: ['soap', 'authentication'] });
  b.add(s, { ...soap, testType: 'Negative', title: 'Request that is not a SOAP envelope returns a fault', bodyRaw: 'this is not xml',
    assertions: [{ type: 'status', op: 'in', expected: [400, 500] }, { type: 'bodyContains', expected: 'Fault' }], tags: ['soap', 'error-contract'] });
}

// ── Tooling API ──────────────────────────────────────────────────────────────
function toolingScenarios(b) {
  const t = { apiType: 'Tooling API', testType: 'Functional', method: 'GET', endpoint: `${b.v}/tooling/query` };
  const s = b.scenario('Tooling API — metadata queries', 'Functional', 'Tooling API', null, 'Read-only Tooling API queries for Apex and validation metadata, plus error contracts.');
  b.add(s, { ...t, title: 'Query ApexClass metadata', query: { q: 'SELECT Id, Name, ApiVersion, Status FROM ApexClass LIMIT 10' },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }, { type: 'jsonpath', path: '$.entityTypeName', op: 'eq', expected: 'ApexClass' }, { type: 'jsonpath', path: '$.done', op: 'eq', expected: true }], tags: ['tooling'] });
  b.add(s, { ...t, title: 'Query ValidationRule metadata', query: { q: 'SELECT Id, ValidationName, Active FROM ValidationRule LIMIT 20' },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }], tags: ['tooling'] });
  b.add(s, { ...t, testType: 'Negative', title: 'Query on an unsupported entity returns INVALID_TYPE', query: { q: 'SELECT Id FROM QA_Not_An_Entity' },
    assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_TYPE' }], tags: ['tooling', 'error-contract'] });
  b.add(s, { ...t, testType: 'Negative', title: 'Malformed query returns MALFORMED_QUERY', query: { q: 'SELECT FROM' },
    assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'MALFORMED_QUERY' }], tags: ['tooling', 'error-contract'] });
  b.add(s, { ...t, testType: 'Security', title: 'Tooling query without an access token is rejected', query: { q: 'SELECT Id FROM ApexClass LIMIT 1' }, ...unauth({ tags: ['authentication', 'tooling'] }) });
}

// ── Platform Events ─────────────────────────────────────────────────────────
function platformEventScenarios(b, analysis, h) {
  const evt = analysis.objects.find((o) => o.endsWith('__e') && analysis.describes[o]);
  if (!evt) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: 'Platform Events are mentioned but no event object (__e) was identified in the org metadata. Name the event in the story to generate publish tests.' });
    return;
  }
  analysis.gaps.push({ label: 'RECOMMENDED', text: `Delivery of ${evt} to subscribers (CometD / Pub-Sub API, replay ids, retention) cannot be validated over REST. Add a subscriber-side test if consumers are in scope.` });
  if (isProd(b)) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: `Production project: publishing ${evt} events was not generated (publishing triggers real subscribers).` });
    return;
  }
  const d = analysis.describes[evt];
  const payload = h.buildPayload(d, (analysis.fields || {})[evt] || []);
  const s = b.scenario(`Platform Events — publish ${d.label || evt}`, 'Integration', 'Platform Events', evt, `Publish ${evt} over the sObject REST endpoint and verify validation and authentication.`);
  const pe = { apiType: 'Platform Events', testType: 'Integration', method: 'POST', endpoint: `${b.v}/sobjects/${evt}` };
  b.add(s, { ...pe, title: `Publish a valid ${evt} event`, body: payload, assertions: [{ type: 'status', op: 'eq', expected: 201 }, { type: 'jsonpath', path: '$.success', op: 'eq', expected: true }, { type: 'jsonpath', path: '$.id', op: 'exists' }], tags: ['platform-events'] });
  const required = d.fields.find((f) => f.required && f.createable && payload[f.name] !== undefined);
  if (required) {
    const { [required.name]: _omit, ...without } = payload;
    b.add(s, { ...pe, testType: 'Negative', title: `Publishing without required ${required.name} is rejected`, body: without, assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'REQUIRED_FIELD_MISSING' }], tags: ['platform-events', 'validation'] });
  }
  b.add(s, { ...pe, testType: 'Negative', title: 'Publishing with an unknown field is rejected', body: { ...payload, QA_Not_A_Field__c: 'x' }, assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_FIELD' }], tags: ['platform-events', 'validation'] });
  b.add(s, { ...pe, testType: 'Security', title: 'Publishing without an access token is rejected', body: payload, ...unauth({ tags: ['authentication', 'platform-events'] }) });
}

// ── Connect REST ─────────────────────────────────────────────────────────────
function connectScenarios(b) {
  const s = b.scenario('Connect REST API — current user', 'Functional', 'Connect REST API', null, 'Read-only Connect REST resource for the authenticated user.');
  const c = { apiType: 'Connect REST API', testType: 'Functional', method: 'GET', endpoint: `${b.v}/chatter/users/me` };
  b.add(s, { ...c, title: 'Get the current user', assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.id', op: 'matches', expected: '^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$' }, { type: 'jsonpath', path: '$.name', op: 'exists' }], tags: ['connect-rest'] });
  b.add(s, { ...c, testType: 'Security', title: 'Current user without an access token is rejected', ...unauth({ tags: ['authentication', 'connect-rest'] }) });
}

// ── OAuth 2.0 ───────────────────────────────────────────────────────────────
function oauthScenarios(b) {
  const s = b.scenario('OAuth 2.0 — token endpoint and token handling', 'Security', 'OAuth 2.0', null, 'Negative token-endpoint flows (no credentials needed) and userinfo token validation. Positive flows use secrets and are exercised by the platform\'s own connection test.');
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const t = { apiType: 'OAuth 2.0', testType: 'Security', method: 'POST', endpoint: '/services/oauth2/token', headers: form, auth: 'none' };
  b.add(s, { ...t, title: 'Unsupported grant_type is rejected', bodyRaw: 'grant_type=qa_not_a_grant&client_id=QA_PLACEHOLDER_CLIENT_ID', assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'jsonpath', path: '$.error', op: 'eq', expected: 'unsupported_grant_type' }], tags: ['oauth', 'authentication'] });
  b.add(s, { ...t, title: 'Missing grant_type is rejected', bodyRaw: 'client_id=QA_PLACEHOLDER_CLIENT_ID', assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'jsonpath', path: '$.error', op: 'exists' }], tags: ['oauth', 'authentication'] });
  b.add(s, { ...t, title: 'Unknown client_id is rejected', bodyRaw: 'grant_type=client_credentials&client_id=invalid&client_secret=invalid', assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'jsonpath', path: '$.error', op: 'in', expected: ['invalid_client_id', 'invalid_client'] }, { type: 'jsonpath', path: '$.access_token', op: 'notExists' }], tags: ['oauth', 'authentication'] });
  b.add(s, { ...t, method: 'GET', endpoint: '/services/oauth2/userinfo', headers: {}, auth: 'default', title: 'userinfo with a valid token returns the user identity', assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.preferred_username', op: 'exists' }], tags: ['oauth', 'authentication'] });
  b.add(s, { ...t, method: 'GET', endpoint: '/services/oauth2/userinfo', headers: {}, auth: 'invalid', title: 'userinfo with an invalid token is rejected', assertions: [{ type: 'status', op: 'in', expected: [401, 403] }], tags: ['oauth', 'authentication'] });
  b.add(s, { ...t, method: 'GET', endpoint: `${b.v}/limits`, headers: {}, auth: 'invalid', title: 'REST API call with an invalid bearer token returns INVALID_SESSION_ID', assertions: [{ type: 'status', op: 'eq', expected: 401 }, { type: 'sfError', op: 'eq', expected: 'INVALID_SESSION_ID' }], tags: ['oauth', 'authentication'] });
}

// ── Pagination ───────────────────────────────────────────────────────────────
function paginationScenarios(b, analysis) {
  const obj = targetObject(analysis);
  if (!obj) return;
  const s = b.scenario(`REST query pagination — ${obj}`, 'Functional', 'REST API', obj, 'Query result envelope, batch size control and next-page locator handling.');
  const q = { apiType: 'REST', testType: 'Functional', method: 'GET', endpoint: `${b.v}/query` };
  b.add(s, { ...q, title: `Query ${obj} with a batch size returns a well-formed page`, headers: { 'Sforce-Query-Options': 'batchSize=200' }, query: { q: `SELECT Id FROM ${obj} LIMIT 5` },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.totalSize', op: 'type', expected: 'number' }, { type: 'jsonpath', path: '$.done', op: 'type', expected: 'boolean' }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }], tags: ['pagination'] });
  b.add(s, { ...q, testType: 'Boundary', title: 'LIMIT 1 returns totalSize 1 and a single record', query: { q: `SELECT Id FROM ${obj} LIMIT 1` },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.records.length', op: 'lte', expected: 1 }, { type: 'jsonpath', path: '$.totalSize', op: 'lte', expected: 1 }], tags: ['pagination', 'boundary'] });
  b.add(s, { ...q, testType: 'Negative', title: 'An invalid query locator is rejected', endpoint: `${b.v}/query/01gQA000000000AAAA`,
    assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_QUERY_LOCATOR' }], tags: ['pagination', 'error-contract'] });
}

/** Add scenarios for every API family the story mentions. */
function apiTypeScenarios(b, analysis, h) {
  if (has(analysis, 'Bulk API 2.0')) bulkScenarios(b, analysis, h);
  if (has(analysis, 'Composite API')) compositeScenarios(b, analysis, h);
  if (has(analysis, 'GraphQL API')) graphqlScenarios(b, analysis, h);
  if (has(analysis, 'SOAP API')) soapScenarios(b, analysis);
  if (has(analysis, 'Tooling API')) toolingScenarios(b);
  if (has(analysis, 'Platform Events')) platformEventScenarios(b, analysis, h);
  if (has(analysis, 'Connect REST API')) connectScenarios(b);
  if (has(analysis, 'OAuth 2.0')) oauthScenarios(b);
  if (has(analysis, 'Pagination')) paginationScenarios(b, analysis);
  if (has(analysis, 'Change Data Capture')) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: 'Change Data Capture: trigger the change over REST (covered by the CRUD tests) and validate the ChangeEvent on the subscriber side (Pub/Sub API / CometD). Event delivery, ordering and replay cannot be asserted over REST.' });
  }
}

module.exports = { apiTypeScenarios };
