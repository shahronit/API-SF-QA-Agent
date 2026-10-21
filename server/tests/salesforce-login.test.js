'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-sflogin-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLoginUrl, loginPlan, sanitizeOrgDisplay, maskUsername } = require('../connectors/salesforce-org');
const { normaliseDescribe } = require('../connectors/salesforce');
const { classifyFromSignals, autoConnectPatch, TYPE_CORE, TYPE_EXPERIENCE_B2B, TYPE_B2C, TYPE_SFCC } = require('../engine/salesforce-detect');
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

test('classifyFromSignals: Core, Experience/B2B, SFCC', () => {
  const core = classifyFromSignals({ loginKind: 'core', catalog: [{ name: 'Account' }, { name: 'Contact' }], packages: [], networks: [], stores: [] });
  assert.deepEqual(core.types, [TYPE_CORE]);
  assert.match(core.explanation, /No Experience Cloud/);

  const exp = classifyFromSignals({
    loginKind: 'core',
    catalog: [{ name: 'Account' }, { name: 'Network' }, { name: 'WebStore' }],
    packages: [{ name: 'B2B Commerce', namespace: 'b2b' }],
    networks: [{ Id: '0DB000000000001', Name: 'Customer', Status: 'Live', UrlPathPrefix: 'customers' }],
    stores: [{ Id: '0ZE000000000001', Name: 'B2B Store' }],
  });
  assert.ok(exp.types.includes(TYPE_CORE));
  assert.ok(exp.types.includes(TYPE_EXPERIENCE_B2B));
  assert.equal(exp.sites[0].name, 'Customer');

  const sfcc = classifyFromSignals({ loginKind: 'sfcc', host: 'xyz-001.dx.commercecloud.salesforce.com', probe: [{ path: '/on/demandware.store/Sites-Site', status: 302 }] });
  assert.ok(sfcc.types.includes(TYPE_SFCC));
  assert.ok(sfcc.types.includes(TYPE_B2C));
  assert.ok(!sfcc.types.includes(TYPE_CORE));
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
  assert.ok(core.cards.includes('Experience / B2B Commerce'));
  assert.equal(core.patch.integrationConfig.salesforceDetection.accessToken, undefined);
  assert.ok(!core.patch.integrationConfig.salesforceDetection.username);

  const cc = autoConnectPatch(project, {
    connected: true, loginKind: 'sfcc', host: 'xyz-001.dx.commercecloud.salesforce.com',
    instanceUrl: 'https://xyz-001.dx.commercecloud.salesforce.com', types: [TYPE_B2C, TYPE_SFCC],
  });
  assert.equal(cc.patch.integrationConfig.commerce.enabled, true);
  assert.equal(cc.patch.integrationConfig.commerce.host, 'xyz-001.dx.commercecloud.salesforce.com');
  assert.ok(cc.cards.includes('B2C Commerce / SFCC'));
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
      salesforceDetection: { connected: true, loginKind: 'sfcc', types: ['B2C Commerce', 'SFCC'], host: 'demo.demandware.net' },
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
