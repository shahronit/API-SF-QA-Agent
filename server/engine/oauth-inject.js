'use strict';
/**
 * Fill Salesforce OAuth token-endpoint placeholders from project credentials
 * at send time. Real values, `invalid`, and QA_PLACEHOLDER_* are left as-is.
 * Secrets are never returned to the browser — callers mask the body afterwards.
 */
const fs = require('node:fs');
const path = require('node:path');
const { salesforceCredentials, config } = require('../config');
const { signRS256 } = require('../lib/jwt');

function isTokenEndpoint(method, endpoint) {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  let p = String(endpoint || '');
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { return false; }
  }
  return /\/services\/oauth2\/token$/i.test(p.split('?')[0]);
}

function signedAssertion(creds, project) {
  if (!creds || creds.flow !== 'jwt' || !creds.privateKeyPath || !creds.clientId || !creds.username) return '';
  const keyPath = path.resolve(config.root, creds.privateKeyPath);
  if (!fs.existsSync(keyPath)) return '';
  const loginUrl = creds.loginUrl || (project && project.instanceUrl) || 'https://login.salesforce.com';
  const aud = /test\.salesforce\.com|sandbox/i.test(loginUrl) ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
  return signRS256(
    { iss: creds.clientId, sub: creds.username, aud, exp: Math.floor(Date.now() / 1000) + 180 },
    fs.readFileSync(keyPath, 'utf8'),
  );
}

/**
 * @param {object} project
 * @param {{ method?: string, path?: string, bodyRaw?: string }} req
 * @returns {string|undefined} body, unchanged unless a YOUR_* placeholder was filled
 */
function injectOAuthTokenBody(project, { method, path: reqPath, bodyRaw } = {}) {
  if (typeof bodyRaw !== 'string' || !bodyRaw) return bodyRaw;
  if (!isTokenEndpoint(method, reqPath)) return bodyRaw;
  if (!/YOUR_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|SIGNED_JWT)/.test(bodyRaw)) return bodyRaw;
  const creds = salesforceCredentials(project && project.credentialRef) || {};
  const params = new URLSearchParams(bodyRaw);
  let changed = false;
  const fill = (key, value) => {
    const cur = params.get(key);
    if (!cur || !/^YOUR_/i.test(cur)) return;
    if (value) {
      params.set(key, value);
      changed = true;
    } else if (key === 'client_secret') {
      params.delete(key);
      changed = true;
    }
  };
  fill('client_id', creds.clientId);
  fill('client_secret', creds.clientSecret);
  fill('refresh_token', creds.refreshToken);
  if (params.get('assertion') === 'YOUR_SIGNED_JWT') {
    const assertion = signedAssertion(creds, project);
    if (assertion) {
      params.set('assertion', assertion);
      changed = true;
    }
  }
  return changed ? params.toString() : bodyRaw;
}

module.exports = { injectOAuthTokenBody, isTokenEndpoint };
