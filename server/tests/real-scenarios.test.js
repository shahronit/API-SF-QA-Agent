'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-real-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isHttpRequest, isSalesforceRequest, isCommerceRequest, connectorFor } = require('../connectors');
const { parseAcceptance, applyAcceptance } = require('../engine/acceptance');
const { importCollection } = require('../engine/postman');
const { generateSuite, detectObjects, recordIdVar } = require('../engine/generator');
const { DemoSalesforce } = require('../connectors/demo-salesforce');
const { HttpConnector } = require('../connectors/http');
const { restApiOrigin, ensureSalesforceRestPath, normalizeSalesforcePath } = require('../connectors/salesforce-org');
const { parseCliHttp } = require('../connectors/salesforce-cli');
const { exportEnvironment } = require('../engine/postman');

test('connector routing: Salesforce vs Commerce vs frontend HTTP', () => {
  assert.equal(isSalesforceRequest({ endpoint: '/services/data/v62.0/sobjects/Contact' }), true);
  assert.equal(isSalesforceRequest({ endpoint: '/sobjects/Contact' }), true);
  assert.equal(isCommerceRequest({ endpoint: '/s/RefArch/dw/shop/v24_5/product_search' }), true);
  assert.equal(isHttpRequest({ apiType: 'HTTP', endpoint: 'https://api.example.com/orders' }), true);
  assert.equal(isHttpRequest({ endpoint: 'https://api.example.com/orders' }), true);
  assert.equal(isHttpRequest({ endpoint: '/services/data/v62.0/limits' }), false);
  const p = { id: 'P', mode: 'demo', environment: 'QA', integrationConfig: { http: { baseUrl: 'https://api.example.com' }, commerce: { enabled: true } } };
  assert.equal(connectorFor(p, { apiType: 'HTTP', endpoint: '/v1/health' }).kind, 'http');
  assert.equal(connectorFor(p, { apiType: 'OCAPI', endpoint: '/s/x/dw/shop/v24_5/products/a' }).kind, 'demo-commerce');
  assert.equal(isCommerceRequest({ apiType: 'HTTP', endpoint: '/shopper/auth/v1/organizations/{{organization_id}}/oauth2/token' }), true);
  assert.equal(connectorFor(p, { apiType: 'HTTP', endpoint: '/shopper/auth/v1/organizations/{{organization_id}}/oauth2/token' }).kind, 'demo-commerce');
});

test('HttpConnector: absolute URLs run without a configured base URL', () => {
  const http = new HttpConnector({ id: 'P', mode: 'live', integrationConfig: {} });
  assert.equal(http.available, false);
  assert.equal(http.originFor('https://api.example.com/v1'), '');
});

test('acceptance criteria map Then status onto matching tests', () => {
  const items = parseAcceptance({
    summary: 'Create Contact',
    acceptanceCriteria: 'Then the API returns 201\nWhen LastName is missing the API returns 400\nResponse within 2 seconds',
  });
  assert.ok(items.some((i) => i.status === 201));
  assert.ok(items.some((i) => i.status === 400 && i.negative));
  assert.ok(items.some((i) => i.responseTimeMs === 2000));
  const scenarios = [{
    testCases: [
      { title: 'Create Contact', method: 'POST', testType: 'Functional', assertions: [{ type: 'status', op: 'eq', expected: 201 }] },
      { title: 'Create Contact without LastName', method: 'POST', testType: 'Negative', assertions: [{ type: 'status', op: 'eq', expected: 400 }] },
    ],
  }];
  const mapped = applyAcceptance(scenarios, items);
  assert.ok(mapped.length);
  assert.ok(scenarios[0].testCases[0].assertions.some((a) => a.type === 'responseTime' || a.label && /Jira AC/.test(a.label)));
});

test('Postman import: non-Salesforce URLs become HTTP frontend tests', () => {
  const drafts = importCollection({
    info: { name: 'BFF', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'list orders', request: { method: 'GET', url: { raw: 'https://bff.example.com/v1/orders' } } },
      { name: 'sf limits', request: { method: 'GET', url: { raw: '{{baseUrl}}/services/data/v62.0/limits' } } },
    ],
  });
  const http = drafts.find((d) => d.title === 'list orders');
  const sf = drafts.find((d) => d.title === 'sf limits');
  assert.equal(http.apiType, 'HTTP');
  assert.match(http.endpoint, /bff\.example\.com/);
  assert.ok((http.tags || []).includes('frontend'));
  assert.equal(sf.apiType, 'REST');
});

test('generator: Experience objects add Connect REST community tests', async () => {
  const p = {
    id: 'UT-EXP', apiVersion: '62.0', mode: 'demo', environment: 'QA',
    businessConfig: { slaMs: 2000 },
    integrationConfig: { experience: { enabled: true, sites: [] }, endpoints: [] },
  };
  const sf = new DemoSalesforce(p);
  const dg = sf.describeGlobal.bind(sf);
  const desc = sf.describe.bind(sf);
  sf.describeGlobal = async () => [...(await dg()), { name: 'Network', label: 'Network' }];
  sf.describe = async (n) => {
    if (n === 'Network') {
      return {
        name: 'Network', label: 'Network', keyPrefix: '0DB', queryable: true, createable: false,
        fields: [{ name: 'Id', type: 'id' }, { name: 'Name', type: 'string', label: 'Name' }, { name: 'Status', type: 'string' }, { name: 'UrlPathPrefix', type: 'string' }],
        childRelationships: [],
      };
    }
    return desc(n);
  };
  const r = await generateSuite({
    project: p, sf,
    story: { key: 'EXP-1', summary: 'Experience Cloud site lists communities', description: 'Digital experience Connect REST.', acceptanceCriteria: 'Then GET communities returns 200' },
  });
  const tests = r.scenarios.flatMap((s) => s.testCases);
  assert.ok(tests.some((t) => /connect\/communities/.test(t.endpoint)));
});

test('REST API host is My Domain, not login or Lightning (avoids HTTP 410/403)', () => {
  assert.equal(restApiOrigin('https://login.salesforce.com'), '');
  assert.equal(restApiOrigin('https://test.salesforce.com'), '');
  assert.equal(restApiOrigin('https://acme.lightning.force.com'), 'https://acme.my.salesforce.com');
  assert.equal(restApiOrigin('https://tnsi--q3.sandbox.my.salesforce.com'), 'https://tnsi--q3.sandbox.my.salesforce.com');
  const env = exportEnvironment({ name: 'P', environment: 'QA', apiVersion: '68.0', instanceUrl: 'https://login.salesforce.com' });
  assert.equal(env.values.find((v) => v.key === 'baseUrl').value, 'https://your-domain.my.salesforce.com');
  assert.equal(env.values.find((v) => v.key === 'loginUrl').value, 'https://login.salesforce.com');
});

test('generated REST paths always include /services/data/vXX.X', () => {
  assert.equal(ensureSalesforceRestPath('/sobjects/Account', '68.0'), '/services/data/v68.0/sobjects/Account');
  assert.equal(ensureSalesforceRestPath('/connect/communities', '68.0'), '/services/data/v68.0/connect/communities');
  assert.equal(
    ensureSalesforceRestPath('https://acme.lightning.force.com/services/data/v62.0/sobjects/Contact', '68.0'),
    '/services/data/v68.0/sobjects/Contact',
  );
  assert.equal(normalizeSalesforcePath('/sobjects/WebStore/describe'), '/services/data/v{{apiVersion}}/sobjects/WebStore/describe');
  assert.equal(ensureSalesforceRestPath('/services/apexrest/v1/orders', '68.0'), '/services/apexrest/v1/orders');
});

test('CLI HTTP dump is parsed as JSON (not the raw header block)', () => {
  const raw = [
    'HTTP/1.1 200 OK',
    'date: Fri, 09 Oct 2026 12:25:20 GMT',
    'content-type: application/json;charset=UTF-8',
    '',
    '{"done":true,"records":[{"Id":"001xx0000000001"}]}',
  ].join('\n');
  const oneLine = 'HTTP/1.1 200 OK date: Fri content-type: application/json {"done":true,"totalSize":1,"records":[]}';
  const a = parseCliHttp(raw);
  const b = parseCliHttp(oneLine);
  assert.equal(a.status, 200);
  assert.equal(a.body.done, true);
  assert.equal(a.body.records[0].Id, '001xx0000000001');
  assert.equal(b.status, 200);
  assert.equal(b.body.done, true);
});

test('storefront copy does not generate Site/Image CRUD or {{siteId}}=RefArch', async () => {
  assert.equal(recordIdVar('Site'), 'siteRecordId');
  assert.equal(recordIdVar('Contact'), 'contactId');
  const catalog = [{ name: 'Site', label: 'Site' }, { name: 'Image', label: 'Image' }, { name: 'WebStore', label: 'Web Store' }, { name: 'Account', label: 'Account' }];
  assert.deepEqual(detectObjects('Hero banner image on the Experience Cloud site storefront', catalog), []);
  assert.ok(detectObjects('Query FROM Site WHERE Id != null', catalog).includes('Site'));
  const p = {
    id: 'UT-SITE', apiVersion: '68.0', mode: 'demo', environment: 'QA',
    businessConfig: { slaMs: 2000 },
    integrationConfig: {
      experience: { enabled: true, sites: [], stores: [{ id: '0ZE000000000001', name: 'B2B' }] },
      commerce: { enabled: false, siteId: 'RefArch' },
      endpoints: [],
    },
  };
  const sf = new DemoSalesforce(p);
  const dg = sf.describeGlobal.bind(sf);
  sf.describeGlobal = async () => [...(await dg()), { name: 'Site', label: 'Site' }, { name: 'WebStore', label: 'Web Store' }];
  const r = await generateSuite({
    project: p, sf,
    story: { key: 'TNS-1', summary: 'Guest cannot add products on the Experience Cloud site', description: 'Storefront cart and hero image.', acceptanceCriteria: 'Then GET cart returns 200' },
  });
  const tests = r.scenarios.flatMap((s) => s.testCases);
  assert.ok(!tests.some((t) => /\/sobjects\/Site\b/.test(t.endpoint)));
  assert.ok(!tests.some((t) => /\{\{siteId\}\}/.test(t.endpoint) && /sobjects/.test(t.endpoint)));
  assert.ok(tests.some((t) => /connect\/communities/.test(t.endpoint) || /commerce\/webstores/.test(t.endpoint) || /search\/products/.test(t.endpoint)));
});
