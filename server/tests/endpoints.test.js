'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-ep-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeEndpoint, isSkippedPath, parseRestResource, fromOpenApi, matchEndpoints,
  mergeEndpoints, usesLegacyContract, explorerTemplates, fromExplorer, fromPostmanDrafts,
} = require('../engine/endpoints');
const { generateSuite } = require('../engine/generator');
const { DemoSalesforce } = require('../connectors/demo-salesforce');

test('skips Experience Cloud, SFCC and standard REST paths; keeps Apex REST and HTTP', () => {
  assert.equal(isSkippedPath('/services/data/v62.0/sobjects/Account'), true);
  assert.equal(isSkippedPath('/services/data/v{{apiVersion}}/connect/communities'), true);
  assert.equal(isSkippedPath('/services/data/v62.0/commerce/webstores'), true);
  assert.equal(isSkippedPath('/s/RefArch/dw/shop/v24_5/products'), true);
  assert.equal(isSkippedPath('/search/shopper-search/v1/organizations/x/product-search'), true);
  assert.equal(isSkippedPath('/services/apexrest/v1/invoices'), false);
  assert.equal(isSkippedPath('https://bff.example.com/orders'), false);
  assert.equal(normalizeEndpoint({ path: '/sobjects/Contact', method: 'POST' }), null);
  assert.ok(normalizeEndpoint({ path: '/v1/invoices', method: 'POST' }).path.startsWith('/services/apexrest'));
});

test('parseRestResource reads @RestResource urlMapping and @Http methods', () => {
  const src = `@RestResource(urlMapping='/v1/orders/*')\nglobal class OrderApi {\n  @HttpPost global static void create() {}\n  @HttpGet global static void show() {}\n}`;
  const found = parseRestResource(src, 'OrderApi');
  assert.equal(found.length, 2);
  assert.ok(found.every((e) => e.path === '/services/apexrest/v1/orders'));
  assert.deepEqual(found.map((e) => e.method).sort(), ['GET', 'POST']);
});

test('OpenAPI import keeps custom paths and drops standard Salesforce REST', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    paths: {
      '/services/apexrest/v1/widgets': {
        post: {
          summary: 'Create widget',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
          responses: { '201': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } },
        },
      },
      '/services/data/v62.0/sobjects/Account': { post: { responses: { '201': { description: 'x' } } } },
    },
  };
  const items = fromOpenApi(spec);
  assert.equal(items.length, 1);
  assert.equal(items[0].path, '/services/apexrest/v1/widgets');
  assert.equal(items[0].legacyContract, false);
  assert.equal(items[0].samplePayload.name, 'QA');
});

test('story endpointIds win over keyword matching', () => {
  const a = normalizeEndpoint({ name: 'A', path: '/services/apexrest/a', method: 'POST', keywords: ['invoice'] });
  const b = normalizeEndpoint({ name: 'B', path: '/services/apexrest/b', method: 'POST', keywords: ['invoice'] });
  const keyed = matchEndpoints([a, b], { summary: 'invoice from SAP', endpointIds: [b.id] });
  assert.deepEqual(keyed.map((e) => e.id), [b.id]);
  const byKw = matchEndpoints([a, b], { summary: 'invoice from SAP' });
  assert.equal(byKw.length, 2);
});

test('mergeEndpoints is idempotent on method+path', () => {
  const a = { name: 'One', path: '/services/apexrest/v1/x', method: 'POST' };
  const first = mergeEndpoints([], [a]);
  const second = mergeEndpoints(first.endpoints, [a]);
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(second.endpoints.length, 1);
  assert.equal(second.endpoints[0].id, first.endpoints[0].id);
});

test('legacy contract is off for imported endpoints and on for SalesforceId SUCCESS defaults', () => {
  assert.equal(usesLegacyContract(normalizeEndpoint({ path: '/services/apexrest/x', method: 'POST', legacyContract: false, idPath: '$.id' })), false);
  assert.equal(usesLegacyContract(normalizeEndpoint({ path: '/services/apexrest/x', method: 'POST', idPath: '$.salesforceId' })), true);
  const explorer = fromExplorer({ method: 'POST', path: '/services/apexrest/v1/ping', body: { ok: true } });
  assert.equal(explorer.source, 'explorer');
  assert.equal(usesLegacyContract(explorer), false);
});

test('Postman drafts skip OCAPI/SCAPI; explorerTemplates overlay uses project endpoints', () => {
  const drafts = fromPostmanDrafts([
    { title: 'Shop', endpoint: '/s/RefArch/dw/shop/v24_5/products', method: 'GET', apiType: 'OCAPI' },
    { title: 'BFF', endpoint: 'https://api.example.com/checkout', method: 'POST', apiType: 'HTTP', body: { cart: 1 } },
  ]);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].path, /api\.example\.com\/checkout/);
  const t = explorerTemplates({ integrationConfig: { endpoints: [{ name: 'Ping', path: '/services/apexrest/ping', method: 'GET' }] } });
  assert.equal(t[0].group, 'Project Apex REST');
  assert.equal(t[0].path, '/services/apexrest/ping');
});

test('generator uses custom contract paths instead of hardcoded SUCCESS/salesforceId', async () => {
  const ep = normalizeEndpoint({
    name: 'Widget API', path: '/services/apexrest/v1/widgets', method: 'POST', object: 'Account',
    keywords: ['widget'], samplePayload: { name: 'W' },
    idPath: '$.id', successPath: '$.ok', successValue: true, legacyContract: false,
    successStatus: [200],
  });
  const p = {
    id: 'UT-EP', apiVersion: '62.0', mode: 'demo', environment: 'QA',
    businessConfig: { slaMs: 2000 },
    integrationConfig: { endpoints: [ep] },
  };
  const sf = new DemoSalesforce(p);
  const r = await generateSuite({
    project: p, sf,
    story: { key: 'UT-EP-1', summary: 'Post a widget from middleware', description: 'External system widget sync.', acceptanceCriteria: 'Then POST returns 200', endpointIds: [ep.id] },
  });
  const tests = r.scenarios.flatMap((s) => s.testCases);
  const happy = tests.find((t) => /valid payload/.test(t.title));
  assert.ok(happy, 'happy-path test exists');
  assert.ok(happy.assertions.some((a) => a.path === '$.id'));
  assert.ok(happy.assertions.some((a) => a.path === '$.ok' && a.expected === true));
  assert.ok(!happy.assertions.some((a) => a.path === '$.status' && a.expected === 'SUCCESS'));
  assert.ok(!happy.assertions.some((a) => a.path === '$.salesforceId'));
  assert.equal(r.analysis.matchedEndpoints[0].id, ep.id);
});

test('idempotency and health tests are generated only when configured', async () => {
  const ep = normalizeEndpoint({
    name: 'Pay', path: '/services/apexrest/v1/pay', method: 'POST', object: 'Payment__c',
    keywords: ['pay'], samplePayload: { amount: 1 },
    idempotencyHeader: 'Idempotency-Key', duplicateExpect: [200], healthPath: '/services/apexrest/v1/pay/health',
    timeoutMs: 1500, legacyContract: true, idPath: '$.salesforceId',
  });
  const p = { id: 'UT-EP2', apiVersion: '62.0', mode: 'demo', environment: 'QA', businessConfig: { slaMs: 2000 }, integrationConfig: { endpoints: [ep] } };
  const r = await generateSuite({
    project: p, sf: new DemoSalesforce(p),
    story: { key: 'UT-EP-2', summary: 'pay webhook', description: 'middleware pay', acceptanceCriteria: '', endpointIds: [ep.id] },
  });
  const tests = r.scenarios.flatMap((s) => s.testCases);
  const blob = tests.map((t) => `${t.title} ${t.endpoint} ${(t.headers && t.headers['Idempotency-Key']) || ''}`).join('\n');
  assert.match(blob, /Idempotency-Key/);
  assert.match(blob, /duplicate business key/);
  assert.match(blob, /pay\/health/);
});
