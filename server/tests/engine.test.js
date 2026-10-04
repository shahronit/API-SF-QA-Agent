'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-unit-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, compare } = require('../engine/assertions');
const { checkOperation, isModifying, PRODUCTION_WARNING } = require('../engine/safety');
const { prioritise } = require('../engine/priority');
const { analyse } = require('../engine/analyzer');
const contracts = require('../engine/contracts');
const reports = require('../engine/reports');

const prod = { name: 'Prod', environment: 'Production' };
const qa = { name: 'QA', environment: 'QA' };

test('assertions: operators and assertion types', () => {
  assert.ok(compare('eq', 1, 1));
  assert.ok(compare('in', 201, [200, 201]));
  assert.ok(compare('lt', 10, 20));
  assert.ok(compare('contains', 'hello world', 'world'));
  assert.ok(compare('matches', 'a0B000000000001AAA', '^[a-zA-Z0-9]{18}$'));
  assert.ok(!compare('exists', undefined));
  const res = { status: 400, headers: { 'content-type': 'application/json' }, body: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'x' }], timeMs: 120 };
  const out = evaluate([{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'REQUIRED_FIELD_MISSING' }, { type: 'responseTime', op: 'lt', expected: 100 }, { type: 'header', name: 'content-type', op: 'contains', expected: 'json' }], res);
  assert.deepEqual(out.map((a) => a.result), ['PASS', 'PASS', 'FAIL', 'PASS']);
  assert.ok(out.every((a) => typeof a.check === 'string' && a.check.length > 0), 'every result carries a readable check description');
});

test('safety: production is read-only; DELETE needs a second confirmation', () => {
  assert.equal(checkOperation(qa, { method: 'DELETE', path: '/x' }), null);
  assert.equal(checkOperation(prod, { method: 'GET', path: '/x' }), null);
  const w = checkOperation(prod, { method: 'POST', path: '/services/data/v62.0/sobjects/Account' });
  assert.equal(w.title, PRODUCTION_WARNING);
  assert.equal(w.requires, 'confirmProductionWrites');
  const d = checkOperation(prod, { method: 'DELETE', path: '/x' }, { confirmProductionWrites: true });
  assert.equal(d.requires, 'confirmDelete');
  assert.equal(checkOperation(prod, { method: 'DELETE', path: '/x' }, { confirmProductionWrites: true, confirmDelete: true }), null);
  assert.equal(isModifying({ method: 'POST', path: '/services/data/v62.0/graphql', body: { query: 'query { uiapi { query { Account { edges { node { Id } } } } } }' } }), false);
  assert.equal(isModifying({ method: 'POST', path: '/services/data/v62.0/graphql', body: { query: 'mutation { uiapi { AccountCreate } }' } }), true);
});

test('priority: seven factors, critical security on critical objects ranks high', () => {
  const p = prioritise({ method: 'POST', endpoint: '/services/data/v{{apiVersion}}/sobjects/Contact', testType: 'Security', object: 'Contact', auth: 'none' }, { project: { businessConfig: { criticalObjects: ['Contact'], highTrafficObjects: ['Contact'] } }, story: { priority: 'Highest' } });
  assert.ok(['P0', 'P1'].includes(p.priority));
  assert.equal(Object.keys(p.factors).length, 7);
  const low = prioritise({ method: 'GET', endpoint: '/services/data', testType: 'Boundary' }, { project: {} });
  assert.ok(['P2', 'P3'].includes(low.priority));
});

test('analyzer: data mismatch after 2xx is a persistence defect, labelled ASSUMED', () => {
  const a = analyse({ status: 'failed', statusCode: 204, assertions: [], sfValidation: { status: 'FAIL', object: 'Account', comparisons: [{ field: 'Rating', expected: 'Hot', actual: 'Warm', match: false }] }, response: { status: 204 } }, { testType: 'Functional' });
  assert.match(a.category, /persist|automation/i);
  assert.ok(a.action && a.evidence.length);
  assert.ok(['ASSUMED', 'VERIFIED', 'RECOMMENDED'].includes(a.label));
});

test('contracts: OpenAPI YAML parse, operation lookup and violations', () => {
  const spec = `openapi: 3.0.3
info:
  title: T
  version: "1"
paths:
  /services/apexrest/v1/leads:
    post:
      operationId: createLead
      responses:
        "201":
          description: created
          content:
            application/json:
              schema:
                type: object
                required: [id, status]
                properties:
                  id: { type: string }
                  status: { type: string, enum: [CREATED] }
`;
  const parsed = contracts.parse(spec);
  assert.equal(parsed.kind, 'openapi');
  const c = { id: 'CT', kind: parsed.kind, spec: parsed.spec };
  assert.equal(contracts.validateExchange(c, { method: 'POST', path: 'https://x.my.salesforce.com/services/apexrest/v1/leads', status: 201, body: { id: '00Q', status: 'CREATED' } }).status, 'PASS');
  const bad = contracts.validateExchange(c, { method: 'POST', path: '/services/apexrest/v1/leads', status: 201, body: { status: 'NOPE' } });
  assert.equal(bad.status, 'FAIL');
  assert.ok(bad.violations.length >= 2);
  const undeclared = contracts.validateExchange(c, { method: 'POST', path: '/services/apexrest/v1/leads', status: 500, body: {} });
  assert.equal(undeclared.status, 'FAIL');
});

test('reports: CSV export guards against formula injection', () => {
  const csv = reports.toCsv({ results: [{ seq: 1, id: 'TC-1', title: '=HYPERLINK("x")', storyKey: 'S-1', testType: 'Functional', priority: 'P1', method: 'GET', endpoint: '/x', status: 'passed', statusCode: 200, responseMs: 5, sfValidation: '', defectKey: '' }] });
  assert.ok(csv.includes("'=HYPERLINK"));
});
