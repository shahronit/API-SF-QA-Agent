'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-conn-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DemoCommerce } = require('../connectors/demo-commerce');
const { commerceFor, isCommerceRequest, isHttpRequest, connectorFor, salesforceFor } = require('../connectors');
const { generateSuite } = require('../engine/generator');
const { classifyStory } = require('../engine/classifier');
const { DemoSalesforce } = require('../connectors/demo-salesforce');

const project = (extra = {}) => ({
  id: 'UT-CC', apiVersion: '62.0', mode: 'demo', environment: 'QA',
  businessConfig: { slaMs: 2000 },
  integrationConfig: { commerce: { enabled: true, siteId: 'RefArch', orgId: 'f_ecom_zzte_001', shortCode: 'demo', ocapiVersion: 'v24_5', sampleProductId: 'apple-iphone-15' }, endpoints: [] },
  ...extra,
});

test('classifier: Commerce Cloud tickets need API testing', () => {
  const c = classifyStory({ summary: 'Shopper product search via SCAPI', description: 'Use the Commerce Cloud shopper API and OCAPI product search.' });
  assert.equal(c.needsApiTesting, true);
  assert.ok(c.reasons.some((r) => /Commerce Cloud/i.test(r)));
});

test('isCommerceRequest detects OCAPI/SCAPI paths', () => {
  assert.equal(isCommerceRequest({ apiType: 'OCAPI' }), true);
  assert.equal(isCommerceRequest({ path: '/s/RefArch/dw/shop/v24_5/products/x' }), true);
  assert.equal(isCommerceRequest({ endpoint: '/product/shopper-products/v1/organizations/o/products/x' }), true);
  assert.equal(isCommerceRequest({ apiType: 'HTTP', endpoint: '/shopper/auth/v1/organizations/{{organization_id}}/oauth2/token' }), true);
  assert.equal(isCommerceRequest({ apiType: 'REST', path: '/services/data/v62.0/limits' }), false);
});

test('demo Commerce Cloud: product, search, basket, auth', async () => {
  const cc = new DemoCommerce(project());
  const call = (method, path, body, extra = {}) => cc.request({ method, path, body, auth: 'default', ...extra });
  const tok = await call('POST', '/shopper/auth/v1/organizations/f_ecom_zzte_001/oauth2/token', null, { bodyRaw: 'grant_type=client_credentials' });
  assert.equal(tok.status, 200); assert.ok(tok.body.access_token);
  const p = await call('GET', '/s/RefArch/dw/shop/v24_5/products/apple-iphone-15');
  assert.equal(p.status, 200); assert.equal(p.body.id, 'apple-iphone-15'); assert.ok(p.body.price > 0);
  assert.equal((await call('GET', '/s/RefArch/dw/shop/v24_5/products/nope')).status, 404);
  const search = await call('GET', '/s/RefArch/dw/shop/v24_5/product_search', null, { query: { q: 'phone' } });
  assert.ok(search.body.count >= 1);
  assert.equal((await call('GET', '/s/RefArch/dw/shop/v24_5/products/apple-iphone-15', null, { auth: 'none' })).status, 401);
  const basket = await call('POST', '/s/RefArch/dw/shop/v24_5/baskets', {});
  assert.ok(basket.body.basket_id);
  const added = await call('POST', `/s/RefArch/dw/shop/v24_5/baskets/${basket.body.basket_id}/items`, { product_id: 'apple-iphone-15', quantity: 1 });
  assert.equal(added.body.product_items.length, 1);
  const scapi = await call('GET', '/product/shopper-products/v1/organizations/f_ecom_zzte_001/products/apple-iphone-15');
  assert.equal(scapi.status, 200); assert.equal(scapi.body.id, 'apple-iphone-15');
});

test('commerceFor is off when the project has not enabled Commerce Cloud', () => {
  const off = commerceFor({ mode: 'demo', integrationConfig: { endpoints: [] } });
  assert.equal(off.available, false);
  assert.equal(commerceFor(project()).available, true);
});

test('generator: Commerce Cloud story produces OCAPI and SCAPI tests', async () => {
  const p = project();
  const sf = new DemoSalesforce(p);
  const r = await generateSuite({
    project: p, sf,
    story: { key: 'GLX-501', summary: 'Shopper product catalog via Commerce Cloud OCAPI and SCAPI', description: 'Product get and product search on OCAPI Shop and the Shopper API. Guest basket add to cart.', acceptanceCriteria: '- GET product 200\n- search hits\n- unknown 404' },
  });
  assert.ok(r.analysis.apiTypes.some((t) => /Commerce Cloud/i.test(t)));
  const tests = r.scenarios.flatMap((s) => s.testCases);
  assert.ok(tests.some((t) => t.apiType === 'OCAPI' && /product_search/.test(t.endpoint)));
  assert.ok(tests.some((t) => t.apiType === 'OCAPI' && /products\/\{\{ocapiProductId\}\}/.test(t.endpoint)));
  assert.ok(tests.some((t) => t.apiType === 'SCAPI' && /shopper-products/.test(t.endpoint)));
  assert.ok(tests.some((t) => /baskets/.test(t.endpoint)));
  assert.ok(tests.every((t) => t.assertions.some((a) => a.type === 'status')));
});

test('SLAS token uses Basic auth for a private client and client_id for a public client', async () => {
  const { CommerceCloudConnector } = require('../connectors/commerce-cloud');
  const orig = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts.headers, body: String(opts.body) });
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-' + seen.length, expires_in: 1800 }) };
  };
  const projectFor = (id, ref) => ({
    id,
    credentialRef: ref,
    integrationConfig: { commerce: { shortCode: 'vqa8a34l', orgId: 'f_ecom_blnk_003', siteId: 'PCL', credentialRef: ref } },
  });
  process.env.SFCC_SLASPRIV_CLIENT_ID = 'private-client-id-0001';
  process.env.SFCC_SLASPRIV_CLIENT_SECRET = 'private-client-secret-0001';
  process.env.SFCC_SLASPUB_CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  process.env.SFCC_SLASPUB_CLIENT_SECRET = 'Private client secret when client was created in SLAS';
  try {
    const priv = await new CommerceCloudConnector(projectFor('P-PRIV', 'SLASPRIV')).token();
    const pub = await new CommerceCloudConnector(projectFor('P-PUB', 'SLASPUB')).token();
    assert.equal(priv.accessToken, 'tok-1');
    assert.equal(pub.accessToken, 'tok-2');
    const privForm = new URLSearchParams(seen[0].body);
    assert.match(seen[0].url, /\/shopper\/auth\/v1\/organizations\/f_ecom_blnk_003\/oauth2\/token$/);
    assert.equal(seen[0].headers.Authorization, `Basic ${Buffer.from('private-client-id-0001:private-client-secret-0001').toString('base64')}`);
    assert.equal(privForm.get('grant_type'), 'client_credentials');
    assert.equal(privForm.get('channel_id'), 'PCL');
    assert.equal(privForm.get('client_id'), null);
    assert.equal(privForm.get('client_secret'), null);
    const pubForm = new URLSearchParams(seen[1].body);
    assert.equal(seen[1].headers.Authorization, undefined);
    assert.equal(pubForm.get('client_id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(pubForm.get('channel_id'), 'PCL');
    assert.equal(pubForm.get('client_secret'), null);
  } finally {
    global.fetch = orig;
    delete process.env.SFCC_SLASPRIV_CLIENT_ID;
    delete process.env.SFCC_SLASPRIV_CLIENT_SECRET;
    delete process.env.SFCC_SLASPUB_CLIENT_ID;
    delete process.env.SFCC_SLASPUB_CLIENT_SECRET;
  }
});

test('SLAS without a secret says the private client secret is missing', async () => {
  const { CommerceCloudConnector } = require('../connectors/commerce-cloud');
  process.env.SFCC_SLASNONE_CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  delete process.env.SFCC_SLASNONE_CLIENT_SECRET;
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: 'invalid Authorization header' }) });
  try {
    const cc = new CommerceCloudConnector({
      id: 'P-NONE',
      credentialRef: 'SLASNONE',
      integrationConfig: { commerce: { shortCode: 'vqa8a34l', orgId: 'f_ecom_blnk_003', siteId: 'PCL', credentialRef: 'SLASNONE' } },
    });
    await assert.rejects(() => cc.token(), (err) => /private client secret is missing/i.test(err.message));
  } finally {
    global.fetch = orig;
    delete process.env.SFCC_SLASNONE_CLIENT_ID;
  }
});

test('a SLAS token request is form-encoded with Basic auth', async () => {
  const { CommerceCloudConnector } = require('../connectors/commerce-cloud');
  process.env.SFCC_SLASFORM_CLIENT_ID = 'form-client-id-0001';
  process.env.SFCC_SLASFORM_CLIENT_SECRET = 'form-client-secret-0001';
  const orig = global.fetch;
  let seen;
  global.fetch = async (url, opts) => {
    seen = { headers: opts.headers, body: String(opts.body) };
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{"access_token":"x"}', headers: { forEach() {} } };
  };
  try {
    const cc = new CommerceCloudConnector({
      id: 'P-FORM',
      credentialRef: 'SLASFORM',
      integrationConfig: { commerce: { shortCode: 'vqa8a34l', orgId: 'f_ecom_blnk_003', siteId: 'PCL', credentialRef: 'SLASFORM' } },
    });
    const res = await cc.request({
      method: 'POST',
      path: '/shopper/auth/v1/organizations/f_ecom_blnk_003/oauth2/token',
      body: { grant_type: 'client_credentials', channel_id: 'PCL' },
      auth: 'default',
    });
    assert.equal(res.status, 200);
    assert.equal(seen.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(seen.headers.Authorization, `Basic ${Buffer.from('form-client-id-0001:form-client-secret-0001').toString('base64')}`);
    assert.match(seen.body, /grant_type=client_credentials/);
    assert.match(seen.body, /channel_id=PCL/);
    assert.doesNotMatch(seen.body, /client_secret=/);
  } finally {
    global.fetch = orig;
    delete process.env.SFCC_SLASFORM_CLIENT_ID;
    delete process.env.SFCC_SLASFORM_CLIENT_SECRET;
  }
});

test('salesforceFor demo is unchanged (simulator, not MCP)', () => {
  const sf = salesforceFor(project());
  assert.equal(sf.kind, 'demo');
});
