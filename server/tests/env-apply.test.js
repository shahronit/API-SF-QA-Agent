'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-env-apply-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { repo, now } = require('../db');
const { applyEnvironmentToProject } = require('../engine/env-apply');
const envs = require('../engine/environments');

function projectRow(id, extra = {}) {
  return {
    id, name: 'Env apply', description: '', environment: 'QA', apiVersion: '62.0',
    mode: 'demo', status: 'active', createdAt: now(), updatedAt: now(),
    instanceUrl: null, sfOrg: null, integrationConfig: {}, testDataConfig: { autoCleanup: true, variables: {} },
    ...extra,
  };
}

const ENV = {
  name: 'QA Shop',
  values: [
    { key: 'loginUrl', value: 'https://acme--qa.sandbox.my.salesforce.com' },
    { key: 'apiVersion', value: '68.0' },
    { key: 'sfOrg', value: 'acme--qa' },
    { key: 'httpBaseUrl', value: 'https://api.shop.example' },
    { key: 'organization_id', value: 'f_ecom_zzte_001' },
    { key: 'shortCode', value: 'kv7kzm78' },
    { key: 'siteId', value: 'RefArch' },
    { key: 'clientSecret', value: 'super-secret-value' },
    { key: 'password', value: 'dont-store-me' },
    { key: 'apiKey', value: 'tok-should-not-echo' },
    { key: 'storefrontHost', value: 'shop.example' },
  ],
};

const PCL = {
  name: 'PCL-Automation - 004',
  values: [
    { key: 'private_client_id', value: 'priv-client-aaaa' },
    { key: 'private_client_secret', value: 'priv-secret-bbbb' },
    { key: 'public_client_id', value: 'pub-client-cccc' },
    { key: 'client_id', value: 'client-id-dddd' },
    { key: 'auth_token', value: 'auth-token-eeeeee' },
    { key: 'shorex_appToken', value: 'shorex-token-ffff' },
    { key: 'password', value: 'pcl-password-gggg' },
    { key: 'access_token', value: 'access-token-hhhh' },
    { key: 'slas_access_token', value: 'slas-access-iiiiii' },
    { key: 'slas_refresh_token', value: 'slas-refresh-jjjj' },
    { key: 'app_token', value: 'app-token-kkkkkk' },
    { key: 'shortCode', value: 'kv7kzm78' },
    { key: 'siteId', value: 'RefArch' },
    { key: 'organization_id', value: 'f_ecom_zzte_001' },
  ],
};

function storedMap(projectId) {
  const row = envs.list(projectId).find((e) => e.name === 'PCL-Automation - 004') || envs.list(projectId)[0];
  const out = {};
  for (const v of (row && row.values) || []) out[v.key] = v.value;
  return out;
}

test('applyEnvironmentToProject fills empty connections including credentials', () => {
  const p = projectRow('PRJ-ENV-1');
  repo.insert('projects', p);
  const r = applyEnvironmentToProject(p, ENV, { user: 'qa' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.secretsSkipped, []);
  assert.ok(r.credentials.keys.some((k) => /CLIENT_SECRET$/.test(k)));
  assert.doesNotMatch(JSON.stringify(r), /super-secret-value|dont-store-me|tok-should-not-echo/);
  assert.doesNotMatch(JSON.stringify(r.project), /super-secret-value|dont-store-me|tok-should-not-echo/);
  assert.match(r.project.instanceUrl, /acme--qa\.sandbox\.my\.salesforce\.com/);
  assert.equal(r.project.apiVersion, '68.0');
  assert.equal(r.project.sfOrg, 'acme--qa');
  assert.equal(r.project.integrationConfig.http.baseUrl, 'https://api.shop.example');
  assert.equal(r.project.integrationConfig.commerce.orgId, 'f_ecom_zzte_001');
  assert.equal(r.project.integrationConfig.commerce.shortCode, 'kv7kzm78');
  assert.equal(r.project.integrationConfig.commerce.siteId, 'RefArch');
  assert.equal(r.project.testDataConfig.variables.organization_id, 'f_ecom_zzte_001');
  assert.equal(r.project.testDataConfig.variables.storefrontHost, 'shop.example');
  assert.equal(r.project.testDataConfig.variables.password, undefined);
  const stored = envs.list(p.id);
  assert.ok(stored.some((e) => e.name === 'QA Shop'));
  const byKey = {};
  for (const v of stored[0].values) byKey[v.key] = v.value;
  assert.equal(byKey.clientSecret, 'super-secret-value');
  assert.equal(byKey.password, 'dont-store-me');
});

test('applyEnvironmentToProject maps PCL client ids, secrets and SLAS tokens into Connections', () => {
  const p = projectRow('PRJ-PCL-1');
  repo.insert('projects', p);
  const r = applyEnvironmentToProject(p, PCL, { user: 'qa' });
  assert.equal(r.ok, true);
  assert.equal(r.environment.name, 'PCL-Automation - 004');
  assert.deepEqual(r.secretsSkipped, []);
  assert.ok(r.credentials.keys.includes('SFCC_PRJ_PCL_1_CLIENT_ID'));
  assert.ok(r.credentials.keys.includes('SFCC_PRJ_PCL_1_CLIENT_SECRET'));
  assert.ok(r.credentials.keys.includes('HTTP_PRJ_PCL_1_TOKEN'));
  assert.ok(r.applied.includes('Commerce client id'));
  assert.ok(r.applied.includes('Commerce client secret'));
  assert.ok(r.applied.includes('HTTP bearer token'));
  assert.doesNotMatch(JSON.stringify(r), /priv-secret-bbbb|pcl-password-gggg|slas-access-iiiiii|slas-refresh-jjjj|auth-token-eeeeee|shorex-token-ffff|access-token-hhhh|app-token-kkkkkk/);
  const stored = storedMap(p.id);
  assert.equal(stored.private_client_id, 'priv-client-aaaa');
  assert.equal(stored.private_client_secret, 'priv-secret-bbbb');
  assert.equal(stored.public_client_id, 'pub-client-cccc');
  assert.equal(stored.client_id, 'client-id-dddd');
  assert.equal(stored.password, 'pcl-password-gggg');
  assert.equal(stored.slas_access_token, 'slas-access-iiiiii');
  assert.equal(stored.slas_refresh_token, 'slas-refresh-jjjj');
  assert.equal(stored.access_token, 'access-token-hhhh');
  assert.equal(stored.auth_token, 'auth-token-eeeeee');
  assert.equal(stored.app_token, 'app-token-kkkkkk');
  assert.equal(stored.shorex_appToken, 'shorex-token-ffff');
  const blob = JSON.stringify(r.project);
  assert.doesNotMatch(blob, /priv-secret-bbbb|pcl-password-gggg|slas-access-iiiiii/);
});

test('credential env keys fill empty-only unless overwrite', () => {
  const id = 'PRJ-OVW-1';
  const key = 'SFCC_PRJ_OVW_1_CLIENT_ID';
  process.env[key] = 'keep-existing';
  try {
    const p = projectRow(id);
    repo.insert('projects', p);
    const doc = {
      name: 'OVW',
      values: [
        { key: 'private_client_id', value: 'new-client-id-xx' },
        { key: 'private_client_secret', value: 'new-secret-yyyyyy' },
        { key: 'shortCode', value: 'abc' },
      ],
    };
    const r = applyEnvironmentToProject(p, doc, { fillEmptyOnly: true });
    assert.ok(!r.credentials.keys.includes(key));
    assert.ok(r.credentials.keys.includes('SFCC_PRJ_OVW_1_CLIENT_SECRET'));
    const over = applyEnvironmentToProject(repo.get('projects', id), doc, { fillEmptyOnly: false });
    assert.ok(over.credentials.keys.includes(key));
  } finally {
    delete process.env[key];
  }
});

test('applyEnvironmentToProject does not clobber filled connections unless overwrite', () => {
  const p = projectRow('PRJ-ENV-2', {
    instanceUrl: 'https://keep.my.salesforce.com',
    apiVersion: '64.0',
    sfOrg: 'keep--qa',
    integrationConfig: { http: { baseUrl: 'https://keep.example' } },
  });
  repo.insert('projects', p);
  const r = applyEnvironmentToProject(p, ENV, { fillEmptyOnly: true });
  assert.equal(r.project.instanceUrl, 'https://keep.my.salesforce.com');
  assert.equal(r.project.apiVersion, '64.0');
  assert.equal(r.project.sfOrg, 'keep--qa');
  assert.equal(r.project.integrationConfig.http.baseUrl, 'https://keep.example');
  const over = applyEnvironmentToProject(repo.get('projects', p.id), {
    name: 'QA Shop',
    values: [{ key: 'httpBaseUrl', value: 'https://other.example' }, { key: 'sfOrg', value: 'other--qa' }],
  }, { fillEmptyOnly: false });
  assert.equal(over.project.sfOrg, 'other--qa');
  assert.equal(over.project.integrationConfig.http.baseUrl, 'https://other.example');
});
