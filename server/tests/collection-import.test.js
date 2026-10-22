'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-colimp-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { importCollection } = require('../engine/postman');
const {
  normalizeCollection, extractsFromScript, detectHints, matchProject, projectPayload,
  inferHttpOrigin, detectAuth,
} = require('../engine/collection-import');
const { seedFromProject, knownFallback, DEMO_ORG_ID } = require('../engine/run-vars');
const { validateProject } = require('../routes/core');
const { repo, now } = require('../db');
const { postmanFor } = require('../connectors');
const { encodeTestCaseBody } = require('../engine/runner');

test('normalizeCollection accepts v1, v2.1 wrap, and Postman API dump', () => {
  const v1 = normalizeCollection({
    name: 'Legacy Shop',
    requests: [
      { name: 'userinfo', method: 'GET', url: 'https://tnsi--q3.sandbox.my.salesforce.com/services/oauth2/userinfo', tests: 'pm.test("s", function(){ pm.response.to.have.status(200); });\npm.collectionVariables.set("organization_id", jsonData.organization_id);' },
    ],
  });
  assert.equal(v1.info.name, 'Legacy Shop');
  assert.ok(Array.isArray(v1.item));
  const wrapped = normalizeCollection({ collection: { info: { name: 'Wrapped' }, item: [{ name: 'a', request: { method: 'GET', url: 'https://example.com/x' } }] } });
  assert.equal(wrapped.info.name, 'Wrapped');
  const dump = normalizeCollection({ collections: [{ info: { name: 'A' }, item: [] }, { info: { name: 'B' }, item: [{ name: '1', request: { method: 'GET', url: '/x' } }] }] });
  assert.equal(dump.info.name, 'B');
});

test('importCollection reads extracts and Salesforce host from any version', () => {
  const drafts = importCollection({
    name: 'Org APIs',
    requests: [{
      name: 'Identity',
      method: 'GET',
      url: 'https://acme.my.salesforce.com/services/oauth2/userinfo',
      tests: 'var jsonData = pm.response.json();\npm.collectionVariables.set("organization_id", jsonData.organization_id);',
    }, {
      name: 'Connect org',
      method: 'GET',
      url: 'https://acme.my.salesforce.com/services/data/v68.0/connect/organization/{{organization_id}}',
    }],
  });
  const idn = drafts.find((d) => d.title === 'Identity');
  assert.ok(idn.extract.some((e) => e.var === 'organization_id' && e.path === '$.organization_id'));
  assert.equal(idn.apiType, 'REST');
  const hints = detectHints(normalizeCollection({
    name: 'Org APIs (UAT)',
    requests: [{ name: 'Identity', method: 'GET', url: 'https://acme.my.salesforce.com/services/oauth2/userinfo' }],
  }), drafts);
  assert.equal(hints.environment, 'UAT');
  assert.equal(hints.apiVersion, '68.0');
  assert.match(hints.instanceUrl, /acme\.my\.salesforce\.com/);
  assert.equal(hints.kind, 'core');
});

test('matchProject scores Salesforce host and creates a valid payload', () => {
  const hints = detectHints({
    info: { name: 'TNS B2B Commerce' },
    variable: [{ key: 'organization_id', value: '00Dxx000000ORGID' }, { key: 'apiVersion', value: '68.0' }],
    item: [{ name: 'limits', request: { method: 'GET', url: 'https://tnsi--q3.sandbox.my.salesforce.com/services/data/v68.0/limits' } }],
  });
  const hit = matchProject(hints, [{
    id: 'PRJ-001', name: 'TNS B2B Commerce', environment: 'UAT', status: 'active',
    instanceUrl: 'https://tnsi--q3.sandbox.my.salesforce.com', sfOrg: 'tnsi--q3',
    integrationConfig: { salesforceDetection: { orgId: '00Dxx000000ORGID' } },
  }]);
  assert.equal(hit.project.id, 'PRJ-001');
  const payload = projectPayload(hints);
  assert.equal(payload.name, 'TNS B2B Commerce');
  assert.equal(hints.orgKind, 'experience-b2b');
  assert.equal(payload.integrationConfig.orgKind, 'experience-b2b');
  assert.equal(payload.apiVersion, '68.0');
  assert.equal(payload.testDataConfig.variables.organization_id, '00Dxx000000ORGID');
});

test('matchProject does not reuse Experience B2B for an SFCC collection', () => {
  const hints = detectHints({
    info: { name: 'TNS SFCC B2C' },
    item: [{ name: 'shop', request: { method: 'GET', url: 'https://xyz-001.dx.commercecloud.salesforce.com/s/RefArch/dw/shop/v24_5/products/apple' } }],
  });
  assert.equal(hints.orgKind, 'sfcc-b2c');
  const hit = matchProject(hints, [{
    id: 'PRJ-001', name: 'TNS B2B Commerce', environment: 'UAT', status: 'active',
    instanceUrl: 'https://tnsi--q3.sandbox.my.salesforce.com',
    integrationConfig: { orgKind: 'experience-b2b', experience: { enabled: true } },
  }]);
  assert.equal(hit.project, null);
  const created = projectPayload(hints);
  assert.equal(created.integrationConfig.orgKind, 'sfcc-b2c');
  assert.equal(created.integrationConfig.commerce.enabled, true);
});

test('extractsFromScript reads collectionVariables.set', () => {
  const ex = extractsFromScript('pm.collectionVariables.set("organization_id", jsonData.organization_id);\npm.environment.set("accountId", pm.response.json().id);');
  assert.deepEqual(ex.find((e) => e.var === 'organization_id'), { var: 'organization_id', path: '$.organization_id' });
  assert.deepEqual(ex.find((e) => e.var === 'accountId'), { var: 'accountId', path: '$.id' });
});

test('seedFromProject fills organization_id for demo and aliases', () => {
  const demo = seedFromProject({ mode: 'demo', testDataConfig: { variables: {} }, integrationConfig: {} });
  assert.equal(demo.organization_id, DEMO_ORG_ID);
  const live = seedFromProject({
    mode: 'live',
    testDataConfig: { variables: { organizationId: '00Dxx000000LIVE' } },
    integrationConfig: {},
  });
  assert.equal(live.organization_id, '00Dxx000000LIVE');
  const vars = { organization_id: '00Dxx000000LIVE', instanceUrl: 'https://acme.my.salesforce.com' };
  assert.equal(knownFallback('organization_id', vars, { apiVersion: '68.0' }), '00Dxx000000LIVE');
  assert.equal(knownFallback('baseUrl', vars, {}), 'https://acme.my.salesforce.com');
  assert.equal(knownFallback('baseUrl', { httpBaseUrl: 'https://bff.example', instanceUrl: 'https://acme.my.salesforce.com' }, {}), 'https://bff.example');
});

test('seedFromProject maps Commerce orgId onto {{organization_id}}', () => {
  const live = seedFromProject({
    mode: 'live',
    orgKind: 'sfcc-b2c',
    testDataConfig: { variables: {} },
    integrationConfig: { commerce: { enabled: true, orgId: 'f_ecom_zzte_001' } },
  });
  assert.equal(live.organization_id, 'f_ecom_zzte_001');
  assert.equal(live.organizationId, 'f_ecom_zzte_001');
  assert.equal(live.ccOrgId, 'f_ecom_zzte_001');
  assert.equal(knownFallback('organization_id', { ccOrgId: 'f_ecom_zzte_001' }, {
    integrationConfig: { commerce: { orgId: 'f_ecom_zzte_001' } },
  }), 'f_ecom_zzte_001');
  const fromEnv = seedFromProject({
    mode: 'live',
    testDataConfig: { variables: { organization_id: 'from-testdata' } },
    integrationConfig: {},
  }, { environmentVars: { organization_id: 'from-env' } });
  assert.equal(fromEnv.organization_id, 'from-env');
});

test('SFCC collection organization_id becomes commerce orgId', () => {
  const hints = detectHints({
    info: { name: 'SFCC SLAS' },
    variable: [{ key: 'organization_id', value: 'f_ecom_zzte_001' }],
    item: [{
      name: 'Get Access Token',
      request: { method: 'POST', url: 'https://kv7kzm78.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/{{organization_id}}/oauth2/token' },
    }],
  });
  assert.equal(hints.orgKind, 'sfcc-b2c');
  assert.equal(hints.orgId, 'f_ecom_zzte_001');
  const created = projectPayload(hints);
  assert.equal(created.integrationConfig.commerce.orgId, 'f_ecom_zzte_001');
  assert.equal(created.testDataConfig.variables.organization_id, 'f_ecom_zzte_001');
});

test('inferHttpOrigin skips Salesforce hosts and detectAuth finds bearer', () => {
  const origin = inferHttpOrigin({
    variables: { baseUrl: 'https://acme.my.salesforce.com', httpBaseUrl: 'https://api.shop.example' },
    urls: ['https://acme.my.salesforce.com/services/data/v68.0/limits', 'https://api.shop.example/v1/orders', '{{baseUrl}}/v1/cart'],
  });
  assert.equal(origin, 'https://api.shop.example');
  const auth = detectAuth({
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
    item: [{ name: 'list', request: { method: 'GET', url: 'https://api.shop.example/v1/orders', header: [] } }],
  });
  assert.equal(auth.needsBearer, true);
  assert.equal(auth.leakedToken, '');
});

test('importCollection keeps {{baseUrl}} for frontend HTTP and tags bearer', () => {
  const drafts = importCollection({
    info: { name: 'BFF', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
    variable: [{ key: 'baseUrl', value: 'https://api.shop.example' }],
    item: [
      { name: 'Orders', request: { method: 'GET', url: '{{baseUrl}}/v1/orders' } },
      { name: 'Limits', request: { method: 'GET', url: 'https://acme.my.salesforce.com/services/data/v68.0/limits' } },
    ],
  });
  const http = drafts.find((d) => d.title === 'Orders');
  const sf = drafts.find((d) => d.title === 'Limits');
  assert.equal(http.apiType, 'HTTP');
  assert.equal(http.endpoint, '{{baseUrl}}/v1/orders');
  assert.ok(http.tags.includes('needs-http-token'));
  assert.equal(sf.apiType, 'REST');
  assert.equal(sf.endpoint, '/services/data/v68.0/limits');
  const hints = detectHints(normalizeCollection({
    info: { name: 'BFF' },
    variable: [{ key: 'baseUrl', value: 'https://api.shop.example' }],
    item: [{ name: 'Orders', request: { method: 'GET', url: '{{baseUrl}}/v1/orders' } }],
  }), drafts);
  assert.equal(hints.httpBaseUrl, 'https://api.shop.example');
  assert.equal(hints.kind, 'http');
  assert.equal(hints.orgKind, 'http');
  assert.equal(hints.instanceUrl, null);
  const payload = projectPayload(hints);
  assert.equal(payload.integrationConfig.http.baseUrl, 'https://api.shop.example');
  assert.equal(payload.instanceUrl, null);
  validateProject(payload);
});

test('projectPayload + validateProject: HTTP-only vs Salesforce vs SFCC', () => {
  const httpHints = detectHints({
    info: { name: 'Shop BFF' },
    variable: [{ key: 'baseUrl', value: 'https://api.shop.example' }],
    item: [{ name: 'Orders', request: { method: 'GET', url: '{{baseUrl}}/v1/orders' } }],
  });
  assert.equal(httpHints.kind, 'http');
  assert.equal(httpHints.orgKind, 'http');
  assert.equal(httpHints.instanceUrl, null);
  assert.equal(httpHints.httpBaseUrl, 'https://api.shop.example');
  const httpPayload = projectPayload(httpHints);
  assert.equal(httpPayload.instanceUrl, null);
  assert.equal(httpPayload.integrationConfig.orgKind, 'http');
  assert.equal(httpPayload.integrationConfig.http.baseUrl, 'https://api.shop.example');
  validateProject(httpPayload);

  const templateHints = detectHints({
    info: { name: 'Template BFF' },
    item: [{ name: 'Orders', request: { method: 'GET', url: 'https://{{baseUrl}}/v1/orders' } }],
  });
  assert.equal(templateHints.kind, 'http');
  assert.equal(templateHints.instanceUrl, null);
  assert.equal(templateHints.httpBaseUrl, null);
  validateProject(projectPayload(templateHints));

  const localhostHints = detectHints({
    info: { name: 'Local BFF' },
    variable: [{ key: 'baseUrl', value: 'http://localhost:8080' }],
    item: [{ name: 'Orders', request: { method: 'GET', url: '{{baseUrl}}/v1/orders' } }],
  });
  assert.equal(localhostHints.instanceUrl, null);
  assert.equal(localhostHints.httpBaseUrl, 'http://localhost:8080');
  validateProject(projectPayload(localhostHints));

  const sfHints = detectHints({
    info: { name: 'TNS B2B Commerce' },
    item: [{ name: 'limits', request: { method: 'GET', url: 'https://tnsi--q3.sandbox.my.salesforce.com/services/data/v68.0/limits' } }],
  });
  assert.equal(sfHints.kind, 'core');
  assert.match(sfHints.instanceUrl, /tnsi--q3\.sandbox\.my\.salesforce\.com/);
  const sfPayload = projectPayload(sfHints);
  assert.match(sfPayload.instanceUrl, /tnsi--q3/);
  validateProject(sfPayload);

  const sfccHints = detectHints({
    info: { name: 'TNS SFCC B2C' },
    item: [{ name: 'shop', request: { method: 'GET', url: 'https://xyz-001.dx.commercecloud.salesforce.com/s/RefArch/dw/shop/v24_5/products/apple' } }],
  });
  assert.equal(sfccHints.kind, 'sfcc');
  assert.match(sfccHints.instanceUrl, /commercecloud\.salesforce\.com/);
  validateProject(projectPayload(sfccHints));

  const mixedHints = detectHints({
    info: { name: 'Mixed shop' },
    variable: [{ key: 'baseUrl', value: 'https://api.shop.example' }],
    item: [
      { name: 'Orders', request: { method: 'GET', url: '{{baseUrl}}/v1/orders' } },
      { name: 'Limits', request: { method: 'GET', url: 'https://acme.my.salesforce.com/services/data/v68.0/limits' } },
    ],
  });
  assert.equal(mixedHints.instanceUrl, 'https://acme.my.salesforce.com');
  assert.equal(mixedHints.httpBaseUrl, 'https://api.shop.example');
  validateProject(projectPayload(mixedHints));

  const httpNamedLikeTns = detectHints({
    info: { name: 'TNS B2B Commerce' },
    variable: [{ key: 'baseUrl', value: 'http://localhost:8080' }],
    item: [{ name: 'Orders', request: { method: 'GET', url: '{{baseUrl}}/v1/orders' } }],
  });
  assert.equal(httpNamedLikeTns.instanceUrl, null);
  const tnsUrl = 'https://tnsi--q3.sandbox.my.salesforce.com';
  const hit = matchProject(httpNamedLikeTns, [{
    id: 'PRJ-001', name: 'TNS B2B Commerce', environment: 'UAT', status: 'active',
    instanceUrl: tnsUrl, integrationConfig: { orgKind: 'experience-b2b' },
  }]);
  if (hit.project) assert.equal(hit.project.instanceUrl, tnsUrl);
  assert.equal(projectPayload(httpNamedLikeTns).instanceUrl, null);
  validateProject(projectPayload(httpNamedLikeTns));

  assert.throws(
    () => validateProject({
      name: 'Bad SF', environment: 'UAT', apiVersion: '62.0',
      instanceUrl: 'https://api.shop.example',
      integrationConfig: { orgKind: 'core' },
    }),
    /Salesforce or Commerce Cloud host/,
  );
});

test('importCollection keeps formdata, graphql, nested folder, prerequest, auth, examples on extra', () => {
  const drafts = importCollection({
    info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{
      name: 'Catalog',
      item: [{
        name: 'Nested',
        item: [{
          name: 'Upload',
          request: {
            method: 'POST',
            url: { raw: 'https://api.shop.example/v1/upload' },
            description: 'Send a photo',
            auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key' }, { key: 'value', value: '{{apiKey}}' }, { key: 'in', value: 'header' }] },
            body: { mode: 'formdata', formdata: [{ key: 'title', value: 'hero', type: 'text' }, { key: 'file', src: '/tmp/a.png', type: 'file' }] },
            header: [],
          },
          event: [
            { listen: 'prerequest', script: { exec: ['pm.variables.set("nonce", "1");'] } },
            { listen: 'test', script: { exec: ['pm.test("ok", function(){ pm.expect(pm.response.code).to.eql(201); });'] } },
          ],
          response: [{ name: 'created', code: 201, status: 'Created', body: '{"id":1}' }],
        }],
      }],
    }, {
      name: 'Search',
      request: {
        method: 'POST',
        url: 'https://api.shop.example/graphql',
        body: { mode: 'graphql', graphql: { query: 'query Ping { ping }', variables: { n: 1 } } },
      },
    }],
  });
  const upload = drafts.find((d) => d.title === 'Upload');
  assert.equal(upload.extra.bodyMode, 'formdata');
  assert.equal(upload.extra.folder, 'Catalog / Nested');
  assert.ok(upload.extra.formData.some((x) => x.key === 'title'));
  assert.match(upload.extra.preRequest, /nonce/);
  assert.equal(upload.extra.auth.type, 'apikey');
  assert.equal(upload.extra.examples[0].code, 201);
  assert.equal(upload.extra.originalUrl, 'https://api.shop.example/v1/upload');
  assert.ok(upload.assertions.some((a) => a.type === 'status' && a.expected === 201));
  const gql = drafts.find((d) => d.title === 'Search');
  assert.equal(gql.extra.bodyMode, 'graphql');
  assert.equal(gql.extra.graphql.query, 'query Ping { ping }');
});

test('fromV1 keeps scripts, formdata, auth and examples', () => {
  const col = normalizeCollection({
    name: 'Legacy',
    folders: [{ id: 'f1', name: 'Auth' }],
    requests: [{
      name: 'Login', folder: 'f1', method: 'POST', url: 'https://api.shop.example/login',
      dataMode: 'formdata', data: [{ key: 'user', value: 'qa' }],
      preRequestScript: 'pm.variables.set("t", "1");',
      tests: 'pm.response.to.have.status(200);',
      description: 'form login',
      auth: { type: 'basic', basic: [{ key: 'username', value: 'qa' }] },
      responses: [{ name: 'ok', code: 200, body: '{}' }],
    }],
  });
  const drafts = importCollection(col);
  const login = drafts[0];
  assert.equal(login.extra.bodyMode, 'formdata');
  assert.equal(login.extra.folder, 'Auth');
  assert.match(login.extra.preRequest, /variables.set/);
  assert.equal(login.extra.auth.type, 'basic');
  assert.ok(login.extra.examples.length);
  assert.match(login.description, /form login/);
});

test('imported extra is persisted on test_cases and encoded by the runner', () => {
  const p = {
    id: 'PRJ-EXT', name: 'Extra persist', environment: 'QA', apiVersion: '62.0',
    mode: 'demo', status: 'active', createdAt: now(), updatedAt: now(), integrationConfig: {},
  };
  repo.insert('projects', p);
  const col = {
    info: { name: 'X', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{
      name: 'Form',
      request: { method: 'POST', url: 'https://api.shop.example/form', body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '{{n}}' }] } },
    }, {
      name: 'Gql',
      request: { method: 'POST', url: 'https://api.shop.example/graphql', body: { mode: 'graphql', graphql: { query: '{ ping }', variables: { n: '{{n}}' } } } },
    }],
  };
  const r = postmanFor(p).importDrafts(col);
  assert.equal(r.imported, 2);
  const form = repo.get('test_cases', r.ids[0]);
  assert.equal(form.extra.bodyMode, 'urlencoded');
  const missing = new Set();
  const encoded = encodeTestCaseBody(form, { n: '1' }, missing);
  assert.equal(encoded.bodyRaw, 'a=1');
  assert.match(encoded.contentType, /x-www-form-urlencoded/);
  const gql = repo.get('test_cases', r.ids[1]);
  const gqlEnc = encodeTestCaseBody(gql, { n: '1' }, new Set());
  const parsed = JSON.parse(gqlEnc.bodyRaw);
  assert.equal(parsed.query, '{ ping }');
  assert.equal(parsed.variables.n, '1');
  assert.match(gqlEnc.contentType, /json/);
});
