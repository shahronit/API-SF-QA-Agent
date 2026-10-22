'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-wf-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalPath, requestKey, diff, variableWarnings, suggestedFolders, indexCollection } = require('../engine/collection-diff');
const workflow = require('../engine/workflow');
const { repo, now } = require('../db');
const { postmanFor } = require('../connectors');

test('collection-diff canonicalises Salesforce versioned paths', () => {
  assert.equal(canonicalPath('{{baseUrl}}/services/data/v62.0/sobjects/Account'), '/services/data/vXX.X/sobjects/Account');
  assert.equal(
    requestKey('POST', '/services/data/v59.0/sobjects/Account'),
    requestKey('post', '{{baseUrl}}/services/data/v62.0/sobjects/Account'),
  );
});

test('collection-diff reuses existing Account POST and flags missing negatives', () => {
  const collection = {
    info: { name: 'Salesforce Account API' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}' }] },
    variable: [{ key: 'baseUrl', value: 'https://example.my.salesforce.com' }, { key: 'accessToken', value: '' }],
    item: [
      { name: 'Authentication', item: [{ name: 'Get token', request: { method: 'POST', url: '{{loginUrl}}/services/oauth2/token' } }] },
      { name: 'Accounts', item: [
        { name: 'Create Account', request: { method: 'POST', url: '{{baseUrl}}/services/data/v62.0/sobjects/Account' }, event: [{ listen: 'test', script: { exec: ['pm.test("created", function(){})'] } }] },
        { name: 'Get Account', request: { method: 'GET', url: '{{baseUrl}}/services/data/v62.0/sobjects/Account/{{id}}' } },
      ] },
    ],
  };
  const tests = [
    { id: 'TC-1', title: 'Create Account', method: 'POST', endpoint: '/services/data/v{{apiVersion}}/sobjects/Account', testType: 'Functional', assertions: [{}, {}, {}], object: 'Account' },
    { id: 'TC-2', title: 'Create Account without LastName', method: 'POST', endpoint: '/services/data/v{{apiVersion}}/sobjects/Account', testType: 'Negative', assertions: [{}], object: 'Account' },
    { id: 'TC-3', title: 'Query Contact', method: 'GET', endpoint: '/services/data/v{{apiVersion}}/query', testType: 'Functional', assertions: [{}], object: 'Contact' },
  ];
  const d = diff(collection, tests);
  assert.equal(d.existing.some((x) => x.key.includes('POST') && x.key.includes('Account')), true);
  assert.ok(d.changed.some((x) => /assertion/i.test(x.message)), 'reuse existing POST and add missing assertions');
  assert.ok(d.missing.some((x) => x.endpoint.includes('query')), 'new query request is missing');
  assert.ok(!d.missing.some((x) => /Account 2/.test(x.title)));
  assert.deepEqual(d.variables.warnings, []);
  assert.ok(suggestedFolders(tests).includes('Accounts'));
  assert.ok(suggestedFolders(tests).includes('Contacts'));
  assert.ok(!suggestedFolders(tests).includes('Leads'));
});

test('duplicate variable warning prefers {{baseUrl}} over {{salesforceBaseUrl}}', () => {
  const w = variableWarnings([{ key: 'baseUrl', scope: 'environment' }], ['salesforceBaseUrl', 'baseUrl']);
  assert.equal(w[0].reuse, 'baseUrl');
  assert.match(w[0].message, /salesforceBaseUrl/);
});

test('duplicate requests in a collection are reported', () => {
  const col = {
    info: { name: 'dup' },
    item: [
      { name: 'A', request: { method: 'POST', url: '/services/data/v62.0/sobjects/Account' } },
      { name: 'Account 2', request: { method: 'POST', url: '{{baseUrl}}/services/data/v59.0/sobjects/Account' } },
    ],
  };
  const idx = indexCollection(col);
  assert.equal(idx.duplicates.length, 1);
  assert.equal(idx.duplicates[0].extra, 'Account 2');
});

test('workflow compute: new project is in progress until stories and tests exist', () => {
  const p = {
    id: 'PRJ-WF', name: 'Workflow Unit', description: '', environment: 'QA', apiVersion: '62.0',
    mode: 'demo', sfOrg: 'unit', jiraProjectKey: 'WF', status: 'active', createdAt: now(), updatedAt: now(),
    integrationConfig: {},
  };
  repo.insert('projects', p);
  const state = workflow.getState(p);
  assert.equal(state.steps.length, 4);
  assert.equal(state.steps.find((s) => s.id === 'connect').status, 'in_progress');
  assert.equal(state.currentStep, 'connect');
  workflow.visit(p, 'salesforce');
  const again = workflow.getState(repo.get('projects', p.id));
  assert.equal(again.currentStep, 'connect');
  workflow.visit(p, 'create');
  assert.equal(workflow.getState(repo.get('projects', p.id)).currentStep, 'create');
});

test('demo Postman connector discovers local collections without MCP', async () => {
  const pm = postmanFor({
    id: 'PRJ-WF', name: 'Workflow Unit', environment: 'QA', mode: 'demo', apiVersion: '62.0',
    sfOrg: 'unit', jiraProjectKey: 'WF', integrationConfig: {},
  });
  const t = await pm.testConnection();
  assert.equal(t.ok, true);
  const found = await pm.search({ project: 'Workflow', org: 'unit', environment: 'QA' });
  assert.ok(Array.isArray(found));
});
