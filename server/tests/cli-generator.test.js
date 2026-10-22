'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-cli-gen-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DemoSalesforce } = require('../connectors/demo-salesforce');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cursorFor, detectCursorBin, parseWhoami, isCursorIdeShim } = require('../connectors/cursor-cli');
const { geminiFor } = require('../connectors/gemini-cli');
const {
  generateProposedSuite, pickCliOrder, unwrapCliJson, sanitizeCliProposal, mergeWithEngine,
  looksLikeSecretPath, looksLikeSecretText, safeLocalPath, buildContextPack, normalizeTestCase,
  CLI_JSON_CONTRACT, normalizeInputSource,
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

test('normalizeInputSource maps Jira / docs / both', () => {
  assert.equal(normalizeInputSource('jira'), 'jira');
  assert.equal(normalizeInputSource('Jira tickets'), 'jira');
  assert.equal(normalizeInputSource('integration doc'), 'docs');
  assert.equal(normalizeInputSource('jira+docs'), 'jira+docs');
  assert.equal(normalizeInputSource('both'), 'jira+docs');
  assert.equal(normalizeInputSource('nope'), null);
});

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
  assert.equal(r.analysis.traceability.generator, 'engine');
  assert.equal(r.analysis.traceability.fallback, true);
});

test('normalizeTestCase requires a / endpoint and known auth/assertion types', () => {
  const invented = { objects: new Set(), fields: [] };
  const ok = normalizeTestCase({ title: 't', method: 'GET', endpoint: '/limits', assertions: [{ type: 'status', expected: 200 }], auth: 'none' }, { label: 'ASSUMED' }, invented);
  assert.equal(ok.auth, 'none');
  assert.equal(normalizeTestCase({ method: 'GET', endpoint: 'limits' }, {}, invented), null);
  const unknownAssert = normalizeTestCase({ method: 'GET', endpoint: '/limits', assertions: [{ type: 'regex' }] }, {}, invented);
  assert.equal(unknownAssert.assertions[0].type, 'status');
  const badAuth = normalizeTestCase({ method: 'GET', endpoint: '/limits', auth: 'admin', assertions: [{ type: 'status', expected: 200 }] }, {}, invented);
  assert.equal(badAuth.auth, 'default');
});

test('buildContextPack includes capped OpenAPI operations and the JSON contract', () => {
  const pack = buildContextPack({
    project: { id: 'UT-CLI', name: 'UT', environment: 'QA', apiVersion: '62.0' },
    story: { key: 'UT-1', summary: 'x', description: 'y', acceptanceCriteria: '- 201' },
    engine: engineStub,
    docs: [{ name: 'map.md', body: 'Contact.LastName' }],
    openapi: [{ method: 'POST', path: '/v1/invoices', id: 'createInvoice', summary: 'Create invoice' }],
  });
  assert.equal(pack.openapi[0].method, 'POST');
  assert.equal(pack.openapi[0].path, '/v1/invoices');
  assert.match(pack.instruction, /auth is one of/);
  assert.match(CLI_JSON_CONTRACT.shape, /scenarios/);
});

test('detectCursorBin prefers agent over the cursor IDE shim', () => {
  const agent = detectCursorBin('agent');
  const auto = detectCursorBin('');
  if (agent) assert.equal(auto, agent);
  else if (auto) assert.match(auto, /agent|cursor/);
});

test('isCursorIdeShim detects the installer cursor wrapper', () => {
  const shim = path.join(os.tmpdir(), `cursor-shim-${process.pid}`);
  fs.writeFileSync(shim, '#!/bin/sh\necho "Error: No Cursor IDE installation found. Use \'cursor agent\' or \'agent\' to run the agent."\n');
  assert.equal(isCursorIdeShim(shim), true);
  fs.unlinkSync(shim);
  assert.equal(isCursorIdeShim('/no/such/cursor-cli'), false);
});

test('parseWhoami treats Cursor whoami JSON as logged in / not logged in', () => {
  assert.equal(parseWhoami('{"status":"authenticated","isAuthenticated":true}').loggedIn, true);
  assert.equal(parseWhoami('{"status":"unauthenticated","isAuthenticated":false}').loggedIn, false);
  assert.equal(parseWhoami('not json').loggedIn, false);
  const real = parseWhoami('{"status":"authenticated","isAuthenticated":true,"userInfo":{"email":"qa@example.com"}}');
  assert.equal(real.loggedIn, true);
  assert.equal(real.account, 'qa@example.com');
});

test('Cursor and Gemini Connect fail clearly when the CLI is missing', () => {
  const cursor = cursorFor({ integrationConfig: { cursor: { enabled: true, bin: '/no/such/cursor-cli' } } }).startLogin();
  assert.equal(cursor.ok, false);
  assert.match(cursor.title, /not installed/i);
  const gemini = geminiFor({ integrationConfig: { gemini: { enabled: true, bin: '/no/such/gemini-cli' } } }).startLogin();
  assert.equal(gemini.ok, false);
  assert.match(gemini.title, /not installed/i);
});
