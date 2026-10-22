'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-sflogin-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLoginUrl, salesforceLoginOrigin, loginPlan, sanitizeOrgDisplay, maskUsername } = require('../connectors/salesforce-org');
const { normaliseDescribe } = require('../connectors/salesforce');
const { classifyFromSignals, autoConnectPatch, inferOrgKindFromProject, applyOrgKindToProject, TYPE_CORE, TYPE_EXPERIENCE_B2B, TYPE_EXPERIENCE_B2C, TYPE_SFCC_B2B, TYPE_SFCC_B2C, ORG_KIND } = require('../engine/salesforce-detect');
const { SalesforceCliAdapter } = require('../connectors/salesforce-cli');
const { classifyStory } = require('../engine/classifier');
const { generateSuite } = require('../engine/generator');
const { DemoSalesforce } = require('../connectors/demo-salesforce');

test('classifyLoginUrl: Core vs SFCC hosts', () => {
  assert.equal(classifyLoginUrl('https://login.salesforce.com').kind, 'core');
  assert.equal(classifyLoginUrl('https://test.salesforce.com').kind, 'core');
  assert.equal(classifyLoginUrl('https://acme--qa.sandbox.my.salesforce.com').kind, 'core');
  assert.equal(classifyLoginUrl('https://acme.lightning.force.com').loginUrl, 'https://acme.my.salesforce.com');
  assert.equal(classifyLoginUrl('https://account.demandware.com').kind, 'sfcc');
  assert.equal(classifyLoginUrl('https://xyz-001.dx.commercecloud.salesforce.com').kind, 'sfcc');
  assert.match(classifyLoginUrl('https://xyz-001.dx.commercecloud.salesforce.com').loginUrl, /on\/demandware\.store\/Sites-Site/);
  assert.equal(classifyLoginUrl('https://dev-abc.demandware.net').kind, 'sfcc');
  assert.equal(classifyLoginUrl('not a url').kind, 'invalid');
  assert.equal(salesforceLoginOrigin('https://acme.my.salesforce.com'), 'https://acme.my.salesforce.com');
  assert.equal(salesforceLoginOrigin('https://xyz-001.dx.commercecloud.salesforce.com'), 'https://xyz-001.dx.commercecloud.salesforce.com');
  assert.equal(salesforceLoginOrigin('https://api.shop.example'), '');
  assert.equal(salesforceLoginOrigin('https://{{baseUrl}}'), '');
  assert.equal(salesforceLoginOrigin('http://localhost:8080'), '');
});

test('loginPlan uses verified sf org login web flags only', () => {
  const plan = loginPlan('https://acme--qa.sandbox.my.salesforce.com', { alias: 'acme-qa' });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'sf-login-web');
  assert.deepEqual(plan.args, ['org', 'login', 'web', '--alias', 'acme-qa', '--instance-url', 'https://acme--qa.sandbox.my.salesforce.com']);
  assert.ok(!plan.args.includes('--json'));
  assert.ok(!plan.args.includes('--client-id'));
  const sfcc = loginPlan('https://account.demandware.com', { alias: 'cc' });
  assert.equal(sfcc.action, 'open-url');
  assert.equal(sfcc.loginKind, 'sfcc');
  assert.equal(sfcc.loginUrl, 'https://account.demandware.com');
});

test('sanitizeOrgDisplay strips tokens and masks username', () => {
  const out = sanitizeOrgDisplay({
    accessToken: '00Dxx0000000001!AQEA.secret.token.value.here',
    refreshToken: 'refresh-secret',
    sfdxAuthUrl: 'force://abc',
    username: 'qa.integration@example.com',
    orgId: '00D5g000000DEMOEAA',
    instanceUrl: 'https://acme.my.salesforce.com',
    connectedStatus: 'Connected',
    alias: 'acme-qa',
  });
  assert.equal(out.accessToken, undefined);
  assert.equal(out.refreshToken, undefined);
  assert.equal(out.sfdxAuthUrl, undefined);
  assert.equal(out.username, 'q***@example.com');
  assert.equal(out.orgId, '00D5g000000DEMOEAA');
  assert.equal(out.instanceUrl, 'https://acme.my.salesforce.com');
  assert.equal(maskUsername('ab'), '***');
});

test('classifyFromSignals: Core, Experience B2B/B2C, SFCC B2B/B2C', () => {
  const core = classifyFromSignals({ loginKind: 'core', catalog: [{ name: 'Account' }, { name: 'Contact' }], packages: [], networks: [], stores: [] });
  assert.deepEqual(core.types, [TYPE_CORE]);
  assert.match(core.explanation, /No Experience Cloud/);

  const expB2b = classifyFromSignals({
    loginKind: 'core',
    catalog: [{ name: 'Account' }, { name: 'Network' }, { name: 'WebStore' }],
    packages: [{ name: 'B2B Commerce', namespace: 'b2b' }],
    networks: [{ Id: '0DB000000000001', Name: 'Customer', Status: 'Live', UrlPathPrefix: 'customers' }],
    stores: [{ Id: '0ZE000000000001', Name: 'B2B Store', Type: 'B2B' }],
  });
  assert.ok(expB2b.types.includes(TYPE_CORE));
  assert.ok(expB2b.types.includes(TYPE_EXPERIENCE_B2B));
  assert.ok(!expB2b.types.includes(TYPE_EXPERIENCE_B2C));
  assert.equal(expB2b.orgKind, ORG_KIND.EXPERIENCE_B2B);
  assert.equal(expB2b.sites[0].name, 'Customer');

  const expB2c = classifyFromSignals({
    loginKind: 'core',
    catalog: [{ name: 'Account' }, { name: 'Network' }, { name: 'WebStore' }],
    packages: [],
    networks: [{ Id: '0DB000000000002', Name: 'Shop', Status: 'Live', UrlPathPrefix: 'shop' }],
    stores: [{ Id: '0ZE000000000002', Name: 'D2C Store', Type: 'B2C' }],
  });
  assert.ok(expB2c.types.includes(TYPE_EXPERIENCE_B2C));
  assert.ok(!expB2c.types.includes(TYPE_EXPERIENCE_B2B));
  assert.equal(expB2c.orgKind, ORG_KIND.EXPERIENCE_B2C);

  const sfcc = classifyFromSignals({ loginKind: 'sfcc', host: 'xyz-001.dx.commercecloud.salesforce.com', probe: [{ path: '/on/demandware.store/Sites-Site', status: 302 }] });
  assert.deepEqual(sfcc.types, [TYPE_SFCC_B2C]);
  assert.equal(sfcc.orgKind, ORG_KIND.SFCC_B2C);
  assert.ok(!sfcc.types.includes(TYPE_CORE));

  const sfccB2b = classifyFromSignals({ loginKind: 'sfcc', host: 'b2b-shop.demandware.net', name: 'TNS SFCC B2B', probe: [{ path: '/on/demandware.store/Sites-Site', status: 302 }] });
  assert.deepEqual(sfccB2b.types, [TYPE_SFCC_B2B]);
  assert.equal(sfccB2b.orgKind, ORG_KIND.SFCC_B2B);
});

test('autoConnectPatch persists non-secret Core and SFCC config', () => {
  const project = { id: 'PRJ-009', sfOrg: '', credentialRef: 'ACME', integrationConfig: {} };
  const core = autoConnectPatch(project, {
    connected: true, loginKind: 'core', instanceUrl: 'https://acme.my.salesforce.com', alias: 'acme-qa',
    orgId: '00Dxx0000000001', types: [TYPE_CORE, TYPE_EXPERIENCE_B2B], apiVersion: '62.0',
    sites: [{ name: 'Customer' }], stores: [],
  });
  assert.equal(core.patch.instanceUrl, 'https://acme.my.salesforce.com');
  assert.equal(core.patch.sfOrg, 'acme-qa');
  assert.equal(core.patch.integrationConfig.salesforceCli.enabled, true);
  assert.equal(core.patch.integrationConfig.experience.enabled, true);
  assert.ok(core.cards.includes('Salesforce Core'));
  assert.ok(core.cards.includes(TYPE_EXPERIENCE_B2B));
  assert.equal(core.patch.integrationConfig.orgKind, ORG_KIND.EXPERIENCE_B2B);
  assert.equal(core.patch.integrationConfig.experience.channel, 'b2b');
  assert.equal(core.patch.integrationConfig.salesforceDetection.accessToken, undefined);
  assert.ok(!core.patch.integrationConfig.salesforceDetection.username);

  const cc = autoConnectPatch(project, {
    connected: true, loginKind: 'sfcc', host: 'xyz-001.dx.commercecloud.salesforce.com',
    instanceUrl: 'https://xyz-001.dx.commercecloud.salesforce.com', types: [TYPE_SFCC_B2C],
  });
  assert.equal(cc.patch.integrationConfig.commerce.enabled, true);
  assert.equal(cc.patch.integrationConfig.orgKind, ORG_KIND.SFCC_B2C);
  assert.equal(cc.patch.integrationConfig.commerce.host, 'xyz-001.dx.commercecloud.salesforce.com');
  assert.ok(cc.cards.includes(TYPE_SFCC_B2C));
});

test('inferOrgKindFromProject retags lumped Experience/B2B and SFCC demo', () => {
  const tns = {
    name: 'TNS B2B Commerce',
    description: 'Pay - US storefront',
    integrationConfig: {
      salesforceDetection: { connected: true, loginKind: 'core', types: ['Salesforce Core', 'Experience / B2B Commerce'] },
      experience: { enabled: true, sites: [{ name: 'OneTNS Community' }], stores: [{ id: '0ZE', name: 'Pay - US' }] },
    },
  };
  assert.equal(inferOrgKindFromProject(tns), ORG_KIND.EXPERIENCE_B2B);
  const applied = applyOrgKindToProject(tns, ORG_KIND.EXPERIENCE_B2B);
  assert.equal(applied.ic.orgKind, 'experience-b2b');
  assert.deepEqual(applied.ic.salesforceDetection.types, [TYPE_CORE, TYPE_EXPERIENCE_B2B]);
  assert.equal(applied.ic.experience.enabled, true);
  assert.equal((applied.ic.commerce || {}).enabled, undefined);

  const globexCc = {
    name: 'Globex B2C Commerce Cloud',
    description: 'B2C storefront APIs',
    integrationConfig: { commerce: { enabled: true, host: 'demo-commerce.example.com', siteId: 'RefArch' } },
  };
  assert.equal(inferOrgKindFromProject(globexCc), ORG_KIND.SFCC_B2C);
});

test('normaliseDescribe turns CLI picklist objects into strings', () => {
  const d = normaliseDescribe({
    name: 'Account', label: 'Account',
    fields: [{
      name: 'Rating', label: 'Rating', type: 'picklist', createable: true, updateable: true,
      picklistValues: [{ value: 'Hot', active: true }, { value: 'Warm', active: true }, { value: 'Old', active: false }],
    }],
  });
  assert.deepEqual(d.fields[0].picklistValues, ['Hot', 'Warm']);
  const again = normaliseDescribe(d);
  assert.deepEqual(again.fields[0].picklistValues, ['Hot', 'Warm']);
});

test('Salesforce CLI Log in fails clearly when sf is missing', () => {
  const adapter = new SalesforceCliAdapter({
    id: 'PRJ-X', instanceUrl: 'https://login.salesforce.com',
    integrationConfig: { salesforceCli: { enabled: true, bin: '/no/such/sf-binary' } },
  });
  const r = adapter.startLogin({ instanceUrl: 'https://login.salesforce.com' });
  assert.equal(r.ok, false);
  assert.match(r.title, /not installed/i);
});

test('classifier: Experience Cloud / B2B tickets need API testing', () => {
  const c = classifyStory({ summary: 'Expose B2B Commerce WebStore catalog to the Experience Cloud site', description: 'Digital experience storefront APIs.' });
  assert.equal(c.needsApiTesting, true);
  assert.ok(c.reasons.some((r) => /Experience Cloud or B2B/i.test(r)));
});

test('generator: detected SFCC type wires Commerce Cloud tests', async () => {
  const p = {
    id: 'UT-DET', apiVersion: '62.0', mode: 'demo', environment: 'QA',
    businessConfig: { slaMs: 2000 },
    integrationConfig: {
      salesforceDetection: { connected: true, loginKind: 'sfcc', types: ['SFCC B2C'], orgKind: 'sfcc-b2c', host: 'demo.demandware.net' },
      commerce: { enabled: false, siteId: 'RefArch', orgId: 'f_ecom_zzte_001', shortCode: 'demo', ocapiVersion: 'v24_5', sampleProductId: 'apple-iphone-15' },
      endpoints: [],
    },
  };
  const r = await generateSuite({
    project: p, sf: new DemoSalesforce(p),
    story: { key: 'GLX-800', summary: 'Guest can view a product', description: 'Storefront product detail.', acceptanceCriteria: '- 200 on get' },
  });
  assert.ok(r.analysis.apiTypes.some((t) => /Commerce Cloud/i.test(t)));
  const tests = r.scenarios.flatMap((s) => s.testCases);
  assert.ok(tests.some((t) => t.apiType === 'OCAPI' || t.apiType === 'SCAPI'));
});
