'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-auth-token-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { applyAuth, isSalesforceTarget } = require('../engine/auth-apply');
const { injectOAuthTokenBody } = require('../engine/oauth-inject');
const { maskDeep, registerSecrets } = require('../lib/mask');
const { secretValues } = require('../config');

const REF = 'TOKENTEST';
const PROJECT = {
  id: 'p-token',
  mode: 'live',
  credentialRef: REF,
  instanceUrl: 'https://acme.my.salesforce.com',
  apiVersion: '62.0',
};

function setCreds({ flow = 'refresh_token', refresh = 'refresh-token-acme-zzzz', secret = 'client-secret-acme-yyyy' } = {}) {
  process.env[`SF_${REF}_AUTH_FLOW`] = flow;
  process.env[`SF_${REF}_CLIENT_ID`] = 'client-id-acme-xxxx';
  process.env[`SF_${REF}_CLIENT_SECRET`] = secret;
  process.env[`SF_${REF}_REFRESH_TOKEN`] = refresh;
  process.env[`SF_${REF}_LOGIN_URL`] = 'https://acme.my.salesforce.com';
  registerSecrets(secretValues());
}

describe('project auth tokens', { concurrency: 1 }, () => {
test('Bearer with no token uses the project access token on the org only', async () => {
  const headers = {};
  let called = 0;
  const ok = await applyAuth({
    auth: 'bearer',
    authConfig: { token: '{{accessToken}}' },
    headers, query: {}, vars: {}, missing: new Set(),
    project: PROJECT,
    target: '/services/data/v62.0/limits',
    resolveToken: async () => { called += 1; return '00DxxPROJECTACCESSTOKENVALUE0001'; },
  });
  assert.equal(called, 1);
  assert.equal(headers.Authorization, 'Bearer 00DxxPROJECTACCESSTOKENVALUE0001');
  assert.equal(ok.oauth.source, 'project');

  const foreign = {};
  await assert.rejects(() => applyAuth({
    auth: 'bearer',
    authConfig: {},
    headers: foreign, query: {}, vars: {}, missing: new Set(),
    project: PROJECT,
    target: 'https://api.example.com/v1/orders',
    resolveToken: async () => { called += 1; return 'should-not-send'; },
  }), (e) => e.status === 400 && /Paste a bearer token/.test(e.message));
  assert.equal(called, 1);
  assert.equal(foreign.Authorization, undefined);

  const pasted = {};
  await applyAuth({
    auth: 'bearer',
    authConfig: { token: 'pasted-by-user' },
    headers: pasted, query: {}, vars: {}, missing: new Set(),
    project: PROJECT,
    target: 'https://api.example.com/v1/orders',
    resolveToken: async () => { called += 1; return 'nope'; },
  });
  assert.equal(called, 1);
  assert.equal(pasted.Authorization, 'Bearer pasted-by-user');
});

test('OAuth 2.0 with no token URL uses the project token; refresh grant fills a blank refresh token', async () => {
  setCreds();
  const headers = {};
  await applyAuth({
    auth: 'oauth2',
    authConfig: {},
    headers, query: {}, vars: {}, missing: new Set(),
    project: PROJECT,
    target: 'https://acme.my.salesforce.com/services/data/v62.0/limits',
    resolveToken: async () => ({ accessToken: 'from-project-flow' }),
  });
  assert.equal(headers.Authorization, 'Bearer from-project-flow');

  let sent = '';
  const authed = {};
  await applyAuth({
    auth: 'oauth2',
    authConfig: {
      grantType: 'refresh_token',
      tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
      clientId: '{{clientId}}',
      clientSecret: '',
      refreshToken: '',
    },
    headers: authed, query: {}, vars: {}, missing: new Set(),
    project: PROJECT,
    target: 'https://acme.my.salesforce.com/services/data',
    transport: { async request(spec) { sent = spec.body; return { status: 200, body: { access_token: 'exchanged-access', token_type: 'Bearer' } }; } },
  });
  const form = new URLSearchParams(sent);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'refresh-token-acme-zzzz');
  assert.equal(form.get('client_id'), 'client-id-acme-xxxx');
  assert.equal(form.get('client_secret'), 'client-secret-acme-yyyy');
  assert.equal(authed.Authorization, 'Bearer exchanged-access');
  assert.equal(isSalesforceTarget('https://login.salesforce.com/services/oauth2/token', PROJECT), true);
  assert.equal(isSalesforceTarget('https://api.example.com/token', PROJECT), false);
});

test('token endpoint placeholders are filled and then masked', () => {
  setCreds();
  const raw = injectOAuthTokenBody(PROJECT, {
    method: 'POST',
    path: '/services/oauth2/token',
    bodyRaw: 'grant_type=refresh_token&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&refresh_token=YOUR_REFRESH_TOKEN',
  });
  const filled = new URLSearchParams(raw);
  assert.equal(filled.get('client_id'), 'client-id-acme-xxxx');
  assert.equal(filled.get('client_secret'), 'client-secret-acme-yyyy');
  assert.equal(filled.get('refresh_token'), 'refresh-token-acme-zzzz');

  const kept = new URLSearchParams(injectOAuthTokenBody(PROJECT, {
    method: 'POST',
    path: 'https://acme.my.salesforce.com/services/oauth2/token',
    bodyRaw: 'grant_type=client_credentials&client_id=already-real-id&client_secret=YOUR_CLIENT_SECRET',
  }));
  assert.equal(kept.get('client_id'), 'already-real-id');
  assert.equal(kept.get('client_secret'), 'client-secret-acme-yyyy');

  const negative = 'grant_type=qa_not_a_grant&client_id=QA_PLACEHOLDER_CLIENT_ID';
  assert.equal(injectOAuthTokenBody(PROJECT, { method: 'POST', path: '/services/oauth2/token', bodyRaw: negative }), negative);
  assert.equal(injectOAuthTokenBody(PROJECT, {
    method: 'POST', path: '/services/data/v62.0/sobjects/Account',
    bodyRaw: 'client_id=YOUR_CLIENT_ID',
  }), 'client_id=YOUR_CLIENT_ID');

  const masked = maskDeep(raw);
  assert.equal(raw.includes('refresh-token-acme-zzzz'), true);
  assert.equal(raw.includes('client-secret-acme-yyyy'), true);
  assert.equal(masked.includes('refresh-token-acme-zzzz'), false);
  assert.equal(masked.includes('client-secret-acme-yyyy'), false);
});

test('JWT assertion placeholder is signed only for the jwt flow', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keyFile = path.join(os.tmpdir(), `qa-jwt-${process.pid}.pem`);
  fs.writeFileSync(keyFile, pem, { mode: 0o600 });
  process.env[`SF_${REF}_AUTH_FLOW`] = 'jwt';
  process.env[`SF_${REF}_CLIENT_ID`] = 'client-id-acme-xxxx';
  process.env[`SF_${REF}_USERNAME`] = 'integration.user@example.com';
  process.env[`SF_${REF}_PRIVATE_KEY_PATH`] = keyFile;
  process.env[`SF_${REF}_LOGIN_URL`] = 'https://acme.my.salesforce.com';
  const body = 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=YOUR_SIGNED_JWT';
  const signed = new URLSearchParams(injectOAuthTokenBody(PROJECT, { method: 'POST', path: '/services/oauth2/token', bodyRaw: body }));
  assert.notEqual(signed.get('assertion'), 'YOUR_SIGNED_JWT');
  assert.match(signed.get('assertion'), /^eyJ/);

  process.env[`SF_${REF}_AUTH_FLOW`] = 'refresh_token';
  assert.equal(injectOAuthTokenBody(PROJECT, { method: 'POST', path: '/services/oauth2/token', bodyRaw: body }), body);
  fs.unlinkSync(keyFile);
});
});
