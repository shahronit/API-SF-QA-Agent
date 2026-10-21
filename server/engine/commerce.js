'use strict';
/**
 * Commerce Cloud OCAPI + SCAPI scenario builder.
 * Product ids come from a live (or demo) catalog search — never invented
 * hostnames or default SKUs such as apple-iphone-15 on a live storefront.
 * Production projects only get read coverage.
 */

function commerceCfg(project) {
  return (project.integrationConfig && project.integrationConfig.commerce) || {};
}

function enabled(project) {
  return require('../connectors').commerceEnabled(project);
}

function isProd(project) {
  return String(project.environment).toLowerCase() === 'production';
}

function commerceScenarios(b, analysis) {
  const project = b.project;
  const c = commerceCfg(project);
  if (!enabled(project) && !analysis.apiTypes.some((t) => /Commerce Cloud/i.test(t))) return;

  const demo = project.mode === 'demo';
  const site = c.siteId || (demo ? 'RefArch' : '{{ccSiteId}}');
  const org = c.orgId || (demo ? 'f_ecom_zzte_001' : '{{ccOrgId}}');
  const ver = c.ocapiVersion || 'v24_5';
  const shop = `/s/${site}/dw/shop/${ver}`;
  const knownId = (analysis.commerceCatalog && analysis.commerceCatalog.productId) || c.sampleProductId || null;
  const searchTerm = c.searchQuery || (demo ? 'phone' : 'a');
  const label = demo ? 'ASSUMED' : analysis.metadataLabel || 'ASSUMED';

  if (!c.siteId && !c.orgId && !demo) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: 'Commerce Cloud is connected but siteId/orgId are not set. Generated paths use {{ccSiteId}} / {{ccOrgId}} — set them on Connections before treating results as VERIFIED.' });
  }
  if (!demo && !c.host && !(c.shortCode && c.orgId)) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: 'B2C / SFCC testers need a storefront host (OCAPI) or shortCode+orgId (SCAPI), plus SFCC_<PREFIX>_CLIENT_ID / CLIENT_SECRET in .env. Browser login alone does not issue a SLAS token.' });
  }

  const ocapi = b.scenario('Commerce Cloud OCAPI — catalog search then product and basket', 'Functional', 'OCAPI', 'Product', 'Shop API: search the live catalog, retrieve the first hit, optionally add it to a guest basket. Auth is the SLAS/OCAPI client.');
  ocapi.label = label;
  const oc = { apiType: 'OCAPI', tags: ['commerce-cloud', 'ocapi'] };

  b.add(ocapi, {
    ...oc, title: 'OCAPI: obtain a client credentials token', method: 'POST',
    endpoint: c.shortCode && c.orgId
      ? `/shopper/auth/v1/organizations/${org}/oauth2/token`
      : '/dw/oauth2/access_token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    bodyRaw: 'grant_type=client_credentials',
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.access_token', op: 'exists' }],
    extract: [{ var: 'sfccToken', path: '$.access_token' }], testType: 'Functional',
  });
  b.add(ocapi, {
    ...oc, title: `OCAPI: product search "${searchTerm}" returns hits`, method: 'GET',
    endpoint: `${shop}/product_search`, query: { q: searchTerm, count: 8 },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.hits', op: 'type', expected: 'array' }],
    extract: [{ var: 'ocapiProductId', path: '$.hits[0].product_id' }], testType: 'Functional',
  });
  b.add(ocapi, {
    ...oc, title: 'OCAPI: get the first searched product', method: 'GET',
    endpoint: `${shop}/products/{{ocapiProductId}}`,
    assertions: [
      { type: 'status', op: 'eq', expected: 200 },
      { type: 'jsonpath', path: '$.id', op: 'eq', expected: '{{ocapiProductId}}' },
    ],
    testType: 'Functional',
  });
  if (knownId && knownId !== '{{ocapiProductId}}') {
    b.add(ocapi, {
      ...oc, title: `OCAPI: get catalog product ${knownId}`, method: 'GET', endpoint: `${shop}/products/${knownId}`,
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.id', op: 'eq', expected: knownId }],
      testType: 'Functional',
    });
  }
  b.add(ocapi, {
    ...oc, title: 'OCAPI: unknown product id is not found', method: 'GET',
    endpoint: `${shop}/products/qa-does-not-exist-{{runId}}`,
    assertions: [{ type: 'status', op: 'eq', expected: 404 }], testType: 'Negative',
  });
  b.add(ocapi, {
    ...oc, title: 'OCAPI: unauthenticated product search is rejected', method: 'GET',
    endpoint: `${shop}/product_search`, query: { q: searchTerm, count: 1 }, auth: 'none',
    assertions: [{ type: 'status', op: 'in', expected: [401, 403] }], testType: 'Security',
    tags: ['commerce-cloud', 'ocapi', 'authentication'],
  });

  if (!isProd(project)) {
    b.add(ocapi, {
      ...oc, title: 'OCAPI: create an empty basket', method: 'POST', endpoint: `${shop}/baskets`, body: {},
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.basket_id', op: 'exists' }],
      extract: [{ var: 'ocapiBasketId', path: '$.basket_id' }], testType: 'Functional',
    });
    b.add(ocapi, {
      ...oc, title: 'OCAPI: add the searched product to the basket', method: 'POST',
      endpoint: `${shop}/baskets/{{ocapiBasketId}}/items`,
      body: { product_id: '{{ocapiProductId}}', quantity: 1 },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.product_items', op: 'type', expected: 'array' }],
      testType: 'Functional',
    });
    b.add(ocapi, {
      ...oc, title: 'OCAPI: adding an unknown product to the basket is rejected', method: 'POST',
      endpoint: `${shop}/baskets/{{ocapiBasketId}}/items`,
      body: { product_id: 'qa-does-not-exist', quantity: 1 },
      assertions: [{ type: 'status', op: 'in', expected: [400, 404] }], testType: 'Negative',
    });
  } else {
    analysis.gaps.push({ label: 'RECOMMENDED', text: 'Production project: Commerce Cloud basket (write) tests were not generated. Run them in a non-production storefront.' });
  }

  const scapi = b.scenario('Commerce Cloud SCAPI — Shopper search then product', 'Functional', 'SCAPI', 'Product', 'Shopper APIs: search the catalog, then get the first product. Uses the same SLAS client as OCAPI.');
  scapi.label = label;
  const sc = { apiType: 'SCAPI', tags: ['commerce-cloud', 'scapi'] };
  const orgPath = `/product/shopper-products/v1/organizations/${org}`;
  b.add(scapi, {
    ...sc, title: 'SCAPI: shopper product search', method: 'GET',
    endpoint: `/search/shopper-search/v1/organizations/${org}/product-search`, query: { q: searchTerm, limit: 8 },
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.hits', op: 'type', expected: 'array' }],
    extract: [{ var: 'scapiProductId', path: '$.hits[0].productId' }], testType: 'Functional',
  });
  b.add(scapi, {
    ...sc, title: 'SCAPI: get the first searched shopper product', method: 'GET',
    endpoint: `${orgPath}/products/{{scapiProductId}}`,
    assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.id', op: 'eq', expected: '{{scapiProductId}}' }],
    testType: 'Functional',
  });
  b.add(scapi, {
    ...sc, title: 'SCAPI: unknown product id is not found', method: 'GET',
    endpoint: `${orgPath}/products/qa-does-not-exist-{{runId}}`,
    assertions: [{ type: 'status', op: 'eq', expected: 404 }], testType: 'Negative',
  });
  if (!isProd(project)) {
    b.add(scapi, {
      ...sc, title: 'SCAPI: create a shopper basket', method: 'POST',
      endpoint: `/checkout/shopper-baskets/v1/organizations/${org}/baskets`, body: {},
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.basketId', op: 'exists' }],
      extract: [{ var: 'scapiBasketId', path: '$.basketId' }], testType: 'Functional',
    });
    b.add(scapi, {
      ...sc, title: 'SCAPI: add the searched product to the shopper basket', method: 'POST',
      endpoint: `/checkout/shopper-baskets/v1/organizations/${org}/baskets/{{scapiBasketId}}/items`,
      body: { productId: '{{scapiProductId}}', quantity: 1 },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }], testType: 'Functional',
    });
  }
}

module.exports = { commerceScenarios, commerceCfg, enabled };
