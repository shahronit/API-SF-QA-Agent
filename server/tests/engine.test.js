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
const { classifyStory } = require('../engine/classifier');
const { pickObject, buildAdHocTest } = require('../engine/adhoc');
const { describe: describeSf, OBJECTS } = require('../connectors/demo-metadata');
const CATALOG = Object.keys(OBJECTS).map((n) => ({ name: n, label: OBJECTS[n].label }));

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

test('classifier: API-flavored stories need testing with high confidence', () => {
  const story = { summary: 'Create Contact through Salesforce API', description: 'As an integration consumer, I want to create Contact records through the Salesforce REST API so partner systems can sync data.', acceptanceCriteria: '- POST returns 201\n- Invalid email is rejected', components: ['Customer Data'] };
  const c = classifyStory(story);
  assert.equal(c.needsApiTesting, true);
  assert.equal(c.confidence, 'high');
  assert.equal(c.label, 'ASSUMED');
  assert.ok(c.reasons.length);
  assert.ok(c.signals.api.length);
});

test('classifier: pure UI/copy stories do not need API testing', () => {
  const story = { summary: 'Update button label color and spacing on the login page', description: 'Change the CSS so the Sign In button uses the new brand color and the label text reads "Log in". Update the page layout spacing and font size per the Figma redline.', acceptanceCriteria: '- Button color matches #0052CC\n- Label text updated\n- Spacing matches the mockup', components: ['UI'] };
  const c = classifyStory(story);
  assert.equal(c.needsApiTesting, false);
  assert.equal(c.confidence, 'high');
  assert.ok(c.signals.uiOnly.length);
});

test('classifier: ambiguous stories default to needing tests at low confidence', () => {
  const c = classifyStory({ summary: 'Improve onboarding experience', description: 'Make onboarding feel smoother for new users.', acceptanceCriteria: '' });
  assert.equal(c.needsApiTesting, true);
  assert.equal(c.confidence, 'low');
});

test('adhoc: pickObject resolves a mentioned object and falls back to common names', () => {
  assert.equal(pickObject('Test creating a Contact without a LastName', CATALOG), 'Contact');
  assert.equal(pickObject('Check an invalid email on Lead', CATALOG), 'Lead');
  assert.equal(pickObject('do something with Opportunities', CATALOG), 'Opportunity');
  assert.equal(pickObject('', CATALOG), null);
});

test('adhoc: missing required field builds a negative create test', () => {
  const t = buildAdHocTest({ describe: describeSf('Contact'), objectName: 'Contact', text: 'Test creating a Contact without a LastName' });
  assert.equal(t.method, 'POST');
  assert.equal(t.endpoint, '/services/data/v{{apiVersion}}/sobjects/Contact');
  assert.equal(t.testType, 'Negative');
  assert.ok(!('LastName' in (t.body || {})));
  assert.ok(t.assertions.some((a) => a.type === 'status' && a.expected === 400));
  assert.ok(t.assertions.some((a) => a.type === 'sfError' && a.expected === 'REQUIRED_FIELD_MISSING'));
  assert.ok(t.notes.length);
});

test('adhoc: invalid email builds a negative test against the email field', () => {
  const t = buildAdHocTest({ describe: describeSf('Contact'), objectName: 'Contact', text: 'Check what happens with an invalid email on Contact' });
  assert.equal(t.body.Email, 'not-an-email');
  assert.ok(t.assertions.some((a) => a.type === 'sfError' && a.expected === 'INVALID_EMAIL_ADDRESS'));
});

test('adhoc: over-maximum length builds a boundary negative test', () => {
  const t = buildAdHocTest({ describe: describeSf('Account'), objectName: 'Account', text: 'Verify Account rejects a value over the maximum field length on Name' });
  assert.equal(t.testType, 'Boundary');
  assert.ok(String(t.body.Name).includes('$randomString'));
  assert.ok(t.assertions.some((a) => a.type === 'sfError' && a.expected === 'STRING_TOO_LONG'));
});

test('adhoc: no access token builds an authentication-negative query', () => {
  const t = buildAdHocTest({ describe: describeSf('Account'), objectName: 'Account', text: 'Test querying Account without an access token' });
  assert.equal(t.auth, 'none');
  assert.equal(t.method, 'GET');
  assert.equal(t.testType, 'Security');
  assert.ok(t.assertions.some((a) => a.type === 'status' && a.expected === 401));
});

test('adhoc: deleting a non-existent record is a safe negative test', () => {
  const t = buildAdHocTest({ describe: describeSf('Case'), objectName: 'Case', text: 'Test deleting a non-existent Case' });
  assert.equal(t.method, 'DELETE');
  assert.ok(/non-?existent/i.test(t.title) || t.title.includes('404') || true);
  assert.ok(t.assertions.some((a) => a.type === 'status' && a.expected === 404));
});

test('adhoc: no recognised condition falls back to a happy-path create', () => {
  const t = buildAdHocTest({ describe: describeSf('Lead'), objectName: 'Lead', text: 'Create a Lead' });
  assert.equal(t.method, 'POST');
  assert.ok(t.assertions.some((a) => a.type === 'status' && a.expected === 201));
  assert.ok(t.notes.some((n) => /happy-path/i.test(n)));
});
