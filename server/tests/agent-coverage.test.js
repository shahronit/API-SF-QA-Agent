'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-agent-cov-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAcceptance, parseDocRules, applyAcceptance } = require('../engine/acceptance');
const { relevance, terms } = require('../engine/http-scenarios');
const { compareRuns, flakyTests, qualityGate } = require('../engine/run-compare');
const { generateSuite } = require('../engine/generator');
const { DemoSalesforce } = require('../connectors/demo-salesforce');
const { repo, now } = require('../db');
const { maskDeep } = require('../lib/mask');

const tc = (o) => ({ testType: 'Functional', method: 'POST', assertions: [{ type: 'status', op: 'eq', expected: 201 }], ...o });

test('AC without a status code still maps to the test that covers it', () => {
  const items = parseAcceptance({ acceptanceCriteria: '- LastName is required; requests without it are rejected\n- Only integration users with Contact create permission may create Contacts' });
  const scenarios = [{ testCases: [
    tc({ title: 'Create Contact without required LastName', testType: 'Negative', assertions: [{ type: 'status', op: 'eq', expected: 400 }] }),
    tc({ title: 'Create Contact without an access token', testType: 'Security', auth: 'none', assertions: [{ type: 'status', op: 'in', expected: [401, 403] }] }),
  ] }];
  const mapped = applyAcceptance(scenarios, items);
  assert.deepEqual(new Set(mapped.map((m) => m.ac)), new Set(items.map((i) => i.text)));
  assert.ok(mapped.every((m) => m.check), 'mapping uses `check`, not the masked `assertion` key');
  assert.equal(maskDeep({ m: mapped }).m[0].check, mapped[0].check);
});

test('auth criteria with a status never rewrite unrelated negative tests', () => {
  const items = parseAcceptance({ acceptanceCriteria: 'Unauthenticated requests are rejected with 401' });
  const neg = tc({ title: 'Create Contact with malformed Email', testType: 'Negative', assertions: [{ type: 'status', op: 'eq', expected: 400 }] });
  applyAcceptance([{ testCases: [neg] }], items);
  assert.equal(neg.assertions[0].expected, 400);
});

test('lower-case "when" mid-sentence is not split into a new criterion', () => {
  const items = parseAcceptance({ acceptanceCriteria: 'Rating must be one of the standard values when provided\nGiven a Lead When posted Then 201' });
  assert.equal(items[0].text, 'Rating must be one of the standard values when provided');
  assert.equal(items.length, 4);
});

test('integration doc rules become traceable checks alongside Jira AC', () => {
  const rules = parseDocRules([{ name: 'Spec', body: 'POST /sobjects/Contact creates a contact. LastName is required; missing LastName returns 400 REQUIRED_FIELD_MISSING. Response time under 2000 ms.' }]);
  assert.ok(rules.every((r) => r.source === 'doc'));
  const code = rules.find((r) => r.errorCode === 'REQUIRED_FIELD_MISSING');
  assert.ok(code && code.status === 400);
  assert.ok(rules.some((r) => r.responseTimeMs === 2000));
  assert.ok(!rules.some((r) => /creates a contact/.test(r.text)), 'descriptive sentences are not rules');
  const neg = tc({ title: 'Create Contact without required LastName', testType: 'Negative', assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'REQUIRED_FIELD_MISSING' }] });
  const mapped = applyAcceptance([{ testCases: [neg] }], [code]);
  assert.ok(mapped.some((m) => m.check === 'sfError' && m.source === 'doc'));
});

test('collection requests are only promoted when relevant to the story', () => {
  const story = terms('Create Contact through Salesforce API. LastName is required.');
  assert.equal(relevance(story, { title: 'SCAPI - Create basket', endpoint: '/checkout/shopper-baskets/v1/baskets' }), false);
  assert.equal(relevance(story, { title: 'Get App Token', endpoint: 'https://gw.example.com/auth/token' }), false);
  assert.equal(relevance(story, { title: 'Create contact', endpoint: '{{baseUrl}}/v1/contacts' }), true);
});

test('generated Contact suite traces every AC and adds no unrelated frontend tests', async () => {
  const project = { id: 'PRJ-COV', name: 'Cov', environment: 'QA', mode: 'demo', apiVersion: '62.0', integrationConfig: { http: { baseUrl: 'https://shop.example.com' } }, businessConfig: { slaMs: 2000 } };
  const story = {
    key: 'COV-1', summary: 'Create Contact through Salesforce API', description: 'Integration creates contacts.',
    acceptanceCriteria: '- Given a valid payload with LastName, the API returns 201 with the new Contact Id\n- Email must be a valid address; invalid emails are rejected with a clear error\n- LastName is required; requests without it are rejected\n- The created Contact is retrievable and all submitted fields are persisted',
  };
  const { analysis, scenarios } = await generateSuite({ project, story, sf: new DemoSalesforce(project) });
  const acTexts = analysis.acceptance.filter((a) => a.source !== 'doc').map((a) => a.text);
  const mapped = new Set(analysis.acceptanceMapped.map((m) => m.ac));
  assert.deepEqual(acTexts.filter((t) => !mapped.has(t)), []);
  assert.ok(!scenarios.some((s) => /Frontend HTTP/.test(s.title)), scenarios.map((s) => s.title).join(' | '));
});

test('run comparison, flaky detection and quality gate', () => {
  const pid = 'PRJ-CMP';
  repo.insert('projects', { id: pid, name: 'Cmp', environment: 'QA', apiVersion: '62.0', mode: 'demo', status: 'active', createdAt: now(), updatedAt: now() });
  const outcomes = [
    // [TC-A, TC-B, TC-C] per run, oldest first
    ['passed', 'passed', 'failed'],
    ['failed', 'passed', 'failed'],
    ['passed', 'failed', 'passed'],
  ];
  const ids = outcomes.map((row, i) => {
    const id = `EX-CMP-${i}`;
    const startedAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    const passed = row.filter((s) => s === 'passed').length;
    repo.insert('runs', { id, projectId: pid, environment: 'QA', user: 't', status: 'completed', startedAt, endedAt: startedAt, total: 3, passed, failed: 3 - passed });
    row.forEach((status, j) => repo.insert('run_results', {
      id: `${id}-${j}`, runId: id, projectId: pid, testCaseId: `TC-${'ABC'[j]}`, seq: j, title: `T${j}`, method: 'GET', endpoint: '/x',
      priority: j === 1 ? 'P0' : 'P2', status, statusCode: status === 'passed' ? 200 : 500, responseMs: i === 2 && j === 0 ? 900 : 100,
    }));
    return id;
  });
  const cmp = compareRuns(ids[2], 'previous');
  assert.equal(cmp.baseline.id, ids[1]);
  assert.deepEqual(cmp.newlyFailing.map((x) => x.testCaseId), ['TC-B']);
  assert.deepEqual(cmp.fixed.map((x) => x.testCaseId).sort(), ['TC-A', 'TC-C']);
  assert.deepEqual(cmp.slower.map((x) => x.testCaseId), ['TC-A']);
  assert.equal(cmp.verdict, 'regressed');
  assert.deepEqual(flakyTests(pid).map((x) => x.testCaseId), ['TC-A']);
  const gate = qualityGate(ids[2], { minPassRate: 60, maxNewFailures: 0 });
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.checks.filter((c) => !c.ok).map((c) => c.name).sort(), ['new-failures', 'p0-all-pass']);
  assert.equal(qualityGate(ids[0], { minPassRate: 60, requireP0: false }).passed, true);
  assert.equal(compareRuns(ids[0]).baseline, null);
});
