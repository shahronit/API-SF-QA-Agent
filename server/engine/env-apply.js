'use strict';
/**
 * Apply a Postman environment file to a project: store vars for {{interpolation}}
 * and fill Connections (Salesforce login, HTTP auth, Commerce SLAS). Credential
 * values use the same .env path as the Connections UI. Secret values are never
 * written to project JSON and are never returned in API payloads.
 */
const { repo, now, audit } = require('../db');
const { config, normRef, secretValues } = require('../config');
const { classifyLoginUrl, salesforceLoginOrigin } = require('../connectors/salesforce-org');
const { upsertEnv } = require('../lib/dotenv-write');
const { registerSecrets } = require('../lib/mask');
const envs = require('./environments');
const { inferHttpOrigin, asOrigin, persistHttpOrigin, httpSecretPairs } = require('./collection-import');

const SECRET_KEY = /secret|password|token|apikey|api[_-]?key|authorization|refresh|private[_-]?key|sfdx|clientid|client_id/i;

function isSecretKey(key) {
  return SECRET_KEY.test(String(key || ''));
}

function parseEnvDoc(raw) {
  let doc = raw;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch (e) {
      throw new Error(`Environment is not valid JSON: ${e.message}`);
    }
  }
  if (doc && doc.environment && (doc.environment.values || doc.environment.variable)) doc = doc.environment;
  if (!doc || typeof doc !== 'object') throw new Error('Not a Postman environment file.');
  const values = doc.values || doc.variable;
  if (!Array.isArray(values) && !doc.name) throw new Error('Not a Postman environment: expected `{ name, values }`.');
  return doc;
}

function envMap(doc) {
  const out = {};
  const secretKeys = [];
  for (const v of doc.values || doc.variable || []) {
    if (!v) continue;
    const key = String(v.key || v.name || '').trim();
    if (!key || v.enabled === false || v.disabled === true) continue;
    const val = v.value === undefined || v.value === null ? '' : String(v.value);
    if (isSecretKey(key) || v.type === 'secret') secretKeys.push(key);
    if (!val || /^\{\{/.test(val)) continue;
    out[key] = val;
  }
  return { vars: out, secretKeys: [...new Set(secretKeys)] };
}

function foldKey(k) {
  return String(k || '').toLowerCase().replace(/[-_]/g, '');
}

function pick(vars, keys) {
  const folded = {};
  for (const [k, v] of Object.entries(vars || {})) folded[foldKey(k)] = v;
  for (const k of keys) {
    if (vars[k]) return vars[k];
    const hit = folded[foldKey(k)];
    if (hit) return hit;
  }
  return '';
}

function publicEnvironment(row) {
  if (!row) return row;
  const values = (row.values || row.envValues || []).map((v) => {
    const key = v && v.key;
    const secret = Boolean(v && (v.secret || v.type === 'secret' || isSecretKey(key)));
    return { key, value: secret ? '' : (v && v.value) || '', enabled: !v || v.enabled !== false, secret };
  });
  return { id: row.id, name: row.name, isActive: row.isActive, values };
}

function canWriteDotEnv(opts = {}) {
  if (process.env.QA_DB_FILE || process.env.NODE_TEST_CONTEXT) return false;
  if (opts.writeEnv === false) return false;
  if (opts.writeEnv === true) return true;
  return Boolean(opts.loopback);
}

function isCommerceVars(vars) {
  const orgId = pick(vars, ['organization_id', 'organizationId', 'ccOrgId']);
  return Boolean(
    pick(vars, ['slas_access_token', 'slas_refresh_token', 'private_client_id', 'private_client_secret', 'public_client_id', 'shortCode', 'ccShortCode', 'short_code', 'ccClientId', 'ccClientSecret'])
    || (orgId && !/^00D/i.test(orgId))
  );
}

function emptyEnvKey(key, fillEmptyOnly) {
  if (!fillEmptyOnly) return true;
  return !process.env[key];
}

/** Build the same SF_/SFCC_/HTTP_ pairs the Connections UI saves via upsertEnv. */
function credentialEnvPairs(project, vars, { fillEmptyOnly = true, ref } = {}) {
  const prefix = normRef(ref || project.credentialRef || ((project.integrationConfig || {}).commerce || {}).credentialRef || ((project.integrationConfig || {}).http || {}).credentialRef);
  const pairs = {};
  const applied = [];
  const put = (key, value, label) => {
    if (!key || !value || !emptyEnvKey(key, fillEmptyOnly)) return;
    pairs[key] = value;
    if (label && !applied.includes(label)) applied.push(label);
  };
  const commerce = isCommerceVars(vars);
  const sfccId = pick(vars, ['private_client_id', 'ccClientId', 'client_id', 'public_client_id']);
  const sfccSecret = pick(vars, ['private_client_secret', 'ccClientSecret', 'client_secret']);
  const sfId = pick(vars, ['sfClientId', 'connectedAppClientId']);
  const sfSecret = pick(vars, ['sfClientSecret']);
  const sfUser = pick(vars, ['username', 'sfUsername', 'userName']);
  const httpTok = pick(vars, ['slas_access_token', 'access_token', 'auth_token', 'app_token', 'shorex_appToken', 'httpToken', 'bearerToken', 'apiKey', 'api_key', 'token']);
  const httpOrigin = inferHttpOrigin({ variables: vars, urls: Object.values(vars) })
    || asOrigin(pick(vars, ['httpBaseUrl', 'baseUrl', 'url', 'apiUrl', 'host']));
  const sfHost = /salesforce\.com|force\.com|demandware|commercecloud/i.test(String(httpOrigin || ''));

  if (commerce && prefix) {
    put(`SFCC_${prefix}_CLIENT_ID`, sfccId, 'Commerce client id');
    put(`SFCC_${prefix}_CLIENT_SECRET`, sfccSecret, 'Commerce client secret');
  } else if (prefix) {
    put(`SF_${prefix}_CLIENT_ID`, sfId || sfccId, 'Salesforce client id');
    put(`SF_${prefix}_CLIENT_SECRET`, sfSecret || sfccSecret, 'Salesforce client secret');
    if (sfUser) put(`SF_${prefix}_USERNAME`, sfUser, 'Salesforce username');
  }

  const httpPairs = httpSecretPairs(
    { ...project, credentialRef: prefix || project.credentialRef, integrationConfig: { ...(project.integrationConfig || {}), http: { ...((project.integrationConfig || {}).http || {}), credentialRef: prefix || ((project.integrationConfig || {}).http || {}).credentialRef } } },
    { token: httpTok, baseUrl: httpOrigin && !sfHost ? httpOrigin : '' },
  );
  for (const [k, v] of Object.entries(httpPairs)) {
    put(k, v, k.endsWith('_TOKEN') || k === 'HTTP_BEARER_TOKEN' ? 'HTTP bearer token' : 'HTTP base URL');
  }
  return { pairs, applied, prefix };
}

function applyEnvironmentToProject(project, raw, { user = 'system', fillEmptyOnly = true, loopback = false, writeEnv, ctx } = {}) {
  const doc = parseEnvDoc(raw);
  const { vars, secretKeys } = envMap(doc);
  const applied = [];
  const loop = loopback || (ctx && ctx.req && (() => {
    const ip = String((ctx.req.socket && ctx.req.socket.remoteAddress) || '');
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  })() && (config.host === '127.0.0.1' || config.host === 'localhost'));

  const envRow = envs.fromPostman(project.id, doc);
  applied.push(`Environment “${envRow.name}”`);

  const p = repo.get('projects', project.id) || project;
  const ic = { ...(p.integrationConfig || {}) };
  const tdc = { ...(p.testDataConfig || { autoCleanup: true, variables: {} }) };
  tdc.variables = { ...(tdc.variables || {}) };
  const patch = { updatedAt: now(), integrationConfig: ic, testDataConfig: tdc };
  const empty = (cur) => !fillEmptyOnly || cur === undefined || cur === null || cur === '';

  if (empty(p.credentialRef)) {
    const derived = normRef(p.credentialRef || ((ic.commerce || {}).credentialRef) || ((ic.http || {}).credentialRef) || p.id);
    if (derived && /^[A-Za-z0-9_]{1,40}$/.test(derived)) patch.credentialRef = derived;
  }
  const ref = patch.credentialRef || p.credentialRef;

  const login = pick(vars, ['loginUrl', 'instanceUrl', 'sfdcLoginUrl', 'sfLoginUrl']);
  if (login) {
    const origin = salesforceLoginOrigin(login) || classifyLoginUrl(login).origin;
    if (origin && empty(p.instanceUrl)) {
      patch.instanceUrl = origin;
      applied.push(`Salesforce login URL ${origin}`);
    }
  }

  const apiVersion = pick(vars, ['apiVersion', 'sfApiVersion']);
  if (/^\d{2}\.0$/.test(apiVersion) && (empty(p.apiVersion) || p.apiVersion === '62.0')) {
    patch.apiVersion = apiVersion;
    applied.push(`API version ${apiVersion}`);
  }

  const envName = pick(vars, ['environment', 'env']) || doc.name;
  const envWord = (config.environments || []).find((e) => new RegExp(`\\b${e}\\b`, 'i').test(String(envName || '')));
  if (envWord && empty(p.environment)) {
    patch.environment = envWord;
    applied.push(`Environment ${envWord}`);
  }

  const sfOrg = pick(vars, ['sfOrg', 'orgAlias', 'alias']);
  if (sfOrg && empty(p.sfOrg)) {
    patch.sfOrg = sfOrg;
    applied.push(`Org alias ${sfOrg}`);
  }

  const httpOrigin = inferHttpOrigin({ variables: vars, urls: Object.values(vars) })
    || asOrigin(pick(vars, ['httpBaseUrl', 'baseUrl', 'url', 'apiUrl', 'host']));
  const sfHost = /salesforce\.com|force\.com|demandware|commercecloud/i.test(String(httpOrigin || ''));
  const prevHttp = (ic.http && ic.http.baseUrl) || ((p.integrationConfig || {}).http || {}).baseUrl || '';
  if (httpOrigin && !sfHost && empty(prevHttp)) {
    persistHttpOrigin({ ...p, integrationConfig: ic, id: p.id }, httpOrigin);
    ic.http = { ...(ic.http || {}), baseUrl: String(httpOrigin).replace(/\/$/, ''), credentialRef: (ic.http && ic.http.credentialRef) || ref || p.credentialRef };
    applied.push(`HTTP base URL ${httpOrigin}`);
  } else if (ref && ic.http) {
    ic.http = { ...ic.http, credentialRef: ic.http.credentialRef || ref };
  }

  const orgId = pick(vars, ['organization_id', 'organizationId', 'ccOrgId']);
  const shortCode = pick(vars, ['shortCode', 'ccShortCode', 'short_code']);
  const siteId = pick(vars, ['siteId', 'ccSiteId', 'site_id']);
  const ccHost = pick(vars, ['ccHost', 'scapiHost', 'sfccHost']) || (sfHost && /demandware|commercecloud/i.test(login || '') ? login : '');
  const commerceCreds = isCommerceVars(vars);
  if (orgId || shortCode || siteId || ccHost || commerceCreds) {
    ic.commerce = { ...(ic.commerce || {}), enabled: true };
    if (ref && empty(ic.commerce.credentialRef)) ic.commerce.credentialRef = ref;
    if (orgId && !/^00D/i.test(orgId) && empty(ic.commerce.orgId)) {
      ic.commerce.orgId = orgId;
      applied.push(`Commerce org ID ${orgId}`);
    }
    if (shortCode && empty(ic.commerce.shortCode)) {
      ic.commerce.shortCode = shortCode;
      applied.push(`SCAPI short code ${shortCode}`);
    }
    if (siteId && empty(ic.commerce.siteId)) {
      ic.commerce.siteId = siteId;
      applied.push(`Site ${siteId}`);
    }
    if (ccHost) {
      try { ic.commerce.host = ic.commerce.host || new URL(/^https?:/i.test(ccHost) ? ccHost : `https://${ccHost}`).hostname; } catch { /* ignore */ }
    }
  }

  ic.postman = { ...(ic.postman || {}), variables: { ...((ic.postman || {}).variables || {}) } };
  for (const [k, v] of Object.entries(vars)) {
    if (isSecretKey(k)) continue;
    if (empty(tdc.variables[k])) tdc.variables[k] = v;
    if (empty(ic.postman.variables[k])) ic.postman.variables[k] = v;
  }
  if (orgId) {
    if (empty(tdc.variables.organization_id)) tdc.variables.organization_id = orgId;
    if (empty(tdc.variables.organizationId)) tdc.variables.organizationId = orgId;
  }

  const creds = credentialEnvPairs({ ...p, credentialRef: ref, integrationConfig: ic }, vars, { fillEmptyOnly, ref });
  const written = canWriteDotEnv({ writeEnv, loopback: loop }) && Object.keys(creds.pairs).length
    ? upsertEnv(creds.pairs)
    : [];
  for (const label of creds.applied) {
    if (label === 'HTTP base URL' && applied.some((a) => a.startsWith('HTTP base URL'))) continue;
    if (!applied.includes(label)) applied.push(label);
  }

  const secretVals = secretKeys.map((k) => vars[k]).filter((v) => typeof v === 'string' && v.length >= 6);
  const credSecrets = Object.entries(creds.pairs)
    .filter(([k]) => /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|CLIENT_ID|CLIENT_SECRET|REFRESH)/i.test(k))
    .map(([, v]) => v);
  registerSecrets([...secretValues(), ...secretVals, ...credSecrets]);

  repo.update('projects', p.id, patch);
  const updated = repo.get('projects', p.id);
  audit('project', 'environment.imported', {
    user, projectId: p.id,
    detail: { name: envRow.name, applied, credentials: creds.applied, envKeys: written.length ? written : Object.keys(creds.pairs) },
  });
  return {
    ok: true,
    environment: publicEnvironment(envRow),
    project: updated,
    applied,
    credentials: { keys: written.length ? written : Object.keys(creds.pairs) },
    secretsSkipped: [],
    variables: Object.keys(vars),
  };
}

module.exports = {
  parseEnvDoc, envMap, isSecretKey, publicEnvironment, credentialEnvPairs, applyEnvironmentToProject,
};
