'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-cli-gen-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DemoSalesforce } = require('../connectors/demo-salesforce');
const { cursorFor, detectCursorBin, parseWhoami } = require('../connectors/cursor-cli');
const { geminiFor } = require('../connectors/gemini-cli');
const {
  generateProposedSuite, pickCliOrder, unwrapCliJson, sanitizeCliProposal, mergeWithEngine,
  looksLikeSecretPath, looksLikeSecretText, safeLocalPath,
} = require('../engine/cli-generator');

const engineStub = {
  analysis: {
    objects: ['Contact'],
    operations: ['create'],
    apiTypes: ['REST API'],
    metadataLabel: 'ASSUMED',
    notes: [],
    describes: { Contact: { name: 'Contact', label: 'Contact', requiredFields: ['LastName'], fields: [{ name: 'LastName' }, { name: 'FirstName' }, { name: 'Email' }] } },
    fields: { Contact: ['LastName', 'Email'] },
  },
  scenarios: [{
    title: 'Contact — create', type: 'Functional', apiType: 'REST API', object: 'Contact', label: 'ASSUMED',
    testCases: [{ title: 'Create Contact', method: 'POST', endpoint: '/services/data/v{{apiVersion}}/sobjects/Contact', assertions: [{ type: 'status', op: 'eq', expected: 201 }], object: 'Contact', testType: 'Functional' }],
  }],
};

test('unwrapCliJson reads fenced JSON and agent result wrappers', () => {
  const inner = { scenarios: [{ title: 'X', testCases: [{ title: 't', method: 'GET', endpoint: '/limits', assertions: [{ type: 'status', expected: 200 }] }] }] };
  assert.equal(unwrapCliJson('```json\n' + JSON.stringify(inner) + '\n```').scenarios.length, 1);
  assert.equal(unwrapCliJson(JSON.stringify({ type: 'result', result: JSON.stringify(inner) })).scenarios.length, 1);
  assert.equal(unwrapCliJson('not json'), null);
});

test('sanitizeCliProposal drops invented sObjects and flags unknown fields', () => {
  const parsed = {
    scenarios: [
      {
        title: 'Invented object', object: 'InvoiceHub__c', type: 'Functional',
        testCases: [{ title: 'Create hub', method: 'POST', endpoint: '/services/data/v62.0/sobjects/InvoiceHub__c', assertions: [{ type: 'status', expected: 201 }] }],
      },
      {
        title: 'Contact extras', object: 'Contact', type: 'Functional',
        testCases: [{
          title: 'Create with mystery field', method: 'POST', endpoint: '/services/data/v{{apiVersion}}/sobjects/Contact',
          body: { LastName: 'X', Mystery__c: 'nope' },
          assertions: [{ type: 'status', expected: 201 }],
        }],
      },
    ],
  };
  const r = sanitizeCliProposal(parsed, engineStub);
  assert.equal(r.dropped.includes('InvoiceHub__c'), true);
  assert.equal(r.scenarios.some((s) => s.object === 'InvoiceHub__c'), false);
  assert.equal(r.scenarios.some((s) => s.object === 'Contact'), true);
  assert.equal(r.scenarios.find((s) => s.object === 'Contact').testCases[0].label, 'RECOMMENDED');
  assert.ok(r.notes.some((n) => /InvoiceHub__c/.test(n.text)));
});

test('mergeWithEngine keeps the engine baseline and appends new CLI tests', () => {
  const cli = [{
    title: 'Contact — negative', type: 'Negative', apiType: 'REST API', object: 'Contact',
    testCases: [{ title: 'Missing LastName', method: 'POST', endpoint: '/services/data/v{{apiVersion}}/sobjects/Contact', assertions: [{ type: 'status', expected: 400 }] }],
  }];
  const merged = mergeWithEngine(cli, engineStub);
  assert.ok(merged.some((s) => s.title === 'Contact — create'));
  assert.ok(merged.some((s) => s.title === 'Contact — negative'));
});

test('pickCliOrder respects Auto / Cursor / Gemini / engine', () => {
  const both = { integrationConfig: { scriptGenerator: 'auto', cursor: { enabled: true }, gemini: { enabled: true } } };
  assert.deepEqual(pickCliOrder(both), ['cursor', 'gemini']);
  assert.deepEqual(pickCliOrder({ integrationConfig: { scriptGenerator: 'cursor', cursor: { enabled: true } } }), ['cursor']);
  assert.deepEqual(pickCliOrder({ integrationConfig: { scriptGenerator: 'engine', cursor: { enabled: true } } }), []);
  assert.deepEqual(pickCliOrder({ integrationConfig: { endpoints: [] } }), []);
});

test('secret-looking docs and paths are rejected', () => {
  assert.equal(looksLikeSecretPath('/tmp/.env'), true);
  assert.equal(looksLikeSecretPath('/tmp/notes.md'), false);
  assert.equal(looksLikeSecretText('CURSOR_API_KEY=abc123'), true);
  assert.equal(looksLikeSecretText('Map Invoice.Number to Salesforce InvoiceNumber'), false);
  assert.equal(safeLocalPath('https://example.com/doc.md'), null);
});

test('Cursor Test connection explains a missing CLI in plain language', async () => {
  const adapter = cursorFor({ integrationConfig: { cursor: { enabled: true, bin: '/no/such/cursor-cli' } } });
  const r = await adapter.testConnection();
  assert.equal(r.ok, false);
  assert.match(r.title, /not installed/i);
});

test('Gemini Test connection explains a missing CLI in plain language', async () => {
  const adapter = geminiFor({ integrationConfig: { gemini: { enabled: true, bin: '/no/such/gemini-cli' } } });
  const r = await adapter.testConnection();
  assert.equal(r.ok, false);
  assert.match(r.title, /not installed/i);
});

test('generateProposedSuite falls back to the engine when Cursor CLI is missing', async () => {
  const project = {
    id: 'UT-CLI', apiVersion: '62.0', mode: 'demo', environment: 'QA',
    businessConfig: { slaMs: 2000 },
    integrationConfig: { scriptGenerator: 'cursor', cursor: { enabled: true, bin: '/no/such/cursor-cli' }, endpoints: [] },
  };
  const r = await generateProposedSuite({
    project,
    story: { key: 'UT-1', summary: 'Create a Contact via REST API', description: 'Create Contact records.', acceptanceCriteria: '- 201 on create' },
    sf: new DemoSalesforce(project),
  });
  assert.equal(r.source, 'engine');
  assert.ok(r.scenarios.length > 0);
  assert.ok(r.analysis.notes.some((n) => /not installed|built-in engine/i.test(n.text)));
});

test('detectCursorBin finds agent or cursor when present on this machine', () => {
  const found = detectCursorBin('');
  if (found) assert.match(found, /agent|cursor/);
});

test('parseWhoami treats Cursor whoami JSON as logged in / not logged in', () => {
  assert.equal(parseWhoami('{"status":"authenticated","isAuthenticated":true}').loggedIn, true);
  assert.equal(parseWhoami('{"status":"unauthenticated","isAuthenticated":false}').loggedIn, false);
  assert.equal(parseWhoami('not json').loggedIn, false);
});

test('Cursor and Gemini Connect fail clearly when the CLI is missing', () => {
  const cursor = cursorFor({ integrationConfig: { cursor: { enabled: true, bin: '/no/such/cursor-cli' } } }).startLogin();
  assert.equal(cursor.ok, false);
  assert.match(cursor.title, /not installed/i);
  const gemini = geminiFor({ integrationConfig: { gemini: { enabled: true, bin: '/no/such/gemini-cli' } } }).startLogin();
  assert.equal(gemini.ok, false);
  assert.match(gemini.title, /not installed/i);
});
