'use strict';
/**
 * Apply request-level auth helpers. Salesforce session modes stay selectable
 * (default / lowpriv / invalid / none). User-chosen Authorization is not stripped.
 */
const { interpolate } = require('../lib/template');

const SF_MODES = new Set(['default', 'lowpriv', 'invalid', 'none', 'inherit', 'salesforce', 'sf-session']);
const USER_MODES = new Set(['bearer', 'basic', 'apikey', 'api-key', 'oauth2', 'oauth']);

function headerKey(headers, name) {
  return Object.keys(headers || {}).find((h) => h.toLowerCase() === name.toLowerCase());
}

function setHeader(headers, name, value) {
  const existing = headerKey(headers, name);
  if (existing) headers[existing] = value;
  else headers[name] = value;
}

function applyBasic(headers, cfg, vars, missing) {
  const user = interpolate(String(cfg.username || cfg.user || ''), vars, missing);
  const pass = interpolate(String(cfg.password || cfg.pass || ''), vars, missing);
  setHeader(headers, 'Authorization', `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`);
}

function isPlaceholder(value) {
  const s = String(value || '').trim();
  return !s || /^\{\{[^}]+\}\}$/.test(s) || /^YOUR_[A-Z0-9_]+$/i.test(s);
}

/** A token the user actually supplied. Blank and {{accessToken}} / YOUR_* count as absent. */
function pastedToken(cfg, vars, missing) {
  const raw = String(cfg.token || cfg.accessToken || '').replace(/^Bearer\s+/i, '').trim();
  if (isPlaceholder(raw)) return '';
  const value = String(interpolate(raw, vars, missing) || '').trim();
  return isPlaceholder(value) ? '' : value;
}

function salesforceHosts(project) {
  const { restApiOrigin, loginOauthOrigin, classifyLoginUrl } = require('../connectors/salesforce-org');
  const { salesforceCredentials } = require('../config');
  const hosts = new Set();
  const add = (input) => {
    if (!input) return;
    const c = classifyLoginUrl(input);
    if (c && c.host) hosts.add(String(c.host).toLowerCase());
    for (const origin of [restApiOrigin(input), loginOauthOrigin(input), c && c.origin]) {
      if (!origin) continue;
      try { hosts.add(new URL(origin).hostname.toLowerCase()); } catch { /* ignore malformed */ }
    }
  };
  if (project) {
    add(project.instanceUrl);
    const creds = salesforceCredentials(project.credentialRef);
    if (creds && creds.loginUrl) add(creds.loginUrl);
    const loginUrl = (creds && creds.loginUrl) || project.instanceUrl || '';
    if (loginUrl && classifyLoginUrl(loginUrl).kind === 'core') {
      hosts.add(/test\.salesforce\.com|sandbox|cs\d+/i.test(loginUrl) ? 'test.salesforce.com' : 'login.salesforce.com');
    }
  }
  return hosts;
}

/** Relative /services paths and this project's instance or login host. Not other APIs. */
function isSalesforceTarget(target, project) {
  const raw = String(target || '').trim();
  if (!raw) return false;
  if (!/^https?:\/\//i.test(raw)) {
    const { ensureSalesforceRestPath } = require('../connectors/salesforce-org');
    const pathOnly = ensureSalesforceRestPath(raw, (project && project.apiVersion) || '62.0').split('?')[0];
    return /^\/services\//i.test(pathOnly);
  }
  try {
    return salesforceHosts(project).has(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function foreignTokenError() {
  return Object.assign(new Error('Paste a bearer token for this host. Project Salesforce tokens are only sent to this org.'), {
    status: 400,
    info: {
      code: 'TOKEN_HOST_MISMATCH',
      title: 'Paste a bearer token for this host.',
      cause: 'Project Salesforce tokens are only attached to this org.',
      action: 'Paste a token for this host, or send the request to the connected Salesforce org.',
      category: 'configuration',
      evidence: [],
    },
  });
}

function refreshMissingError() {
  return Object.assign(new Error('Refresh token is not configured for this project.'), {
    status: 400,
    info: {
      code: 'REFRESH_TOKEN_MISSING',
      title: 'Refresh token is not configured for this project.',
      cause: 'AUTH_FLOW is refresh_token but SF_<PREFIX>_REFRESH_TOKEN is empty.',
      action: 'Set the refresh token on Connections, or switch AUTH_FLOW to client_credentials.',
      category: 'configuration',
      evidence: [],
    },
  });
}

async function obtainProjectAccessToken({ project, resolveToken }) {
  if (typeof resolveToken === 'function') {
    const t = await resolveToken();
    const token = typeof t === 'string' ? t : (t && t.accessToken);
    if (!token) throw Object.assign(new Error('Salesforce did not return an access token.'), { status: 502 });
    return token;
  }
  const { salesforceCredentials } = require('../config');
  const creds = project && project.mode !== 'demo' ? salesforceCredentials(project.credentialRef) : null;
  if (creds && creds.flow === 'refresh_token' && !creds.refreshToken) throw refreshMissingError();
  const { salesforceFor } = require('../connectors');
  const sf = salesforceFor(project);
  if (typeof sf.token !== 'function') {
    const info = typeof sf.unavailableExplanation === 'function' ? sf.unavailableExplanation() : null;
    throw Object.assign(new Error((info && info.title) || 'Salesforce credentials are not configured.'), { status: 400, info });
  }
  try {
    const t = await sf.token();
    if (!t || !t.accessToken) throw Object.assign(new Error('Salesforce did not return an access token.'), { status: 502 });
    return t.accessToken;
  } catch (e) {
    if (e.status) throw e;
    const info = e.explanation || null;
    throw Object.assign(new Error((info && info.title) || e.message || 'Salesforce token request failed.'), {
      status: info && info.category === 'configuration' ? 400 : 502,
      info,
    });
  }
}

async function attachProjectToken({ headers, project, target, resolveToken }) {
  if (!isSalesforceTarget(target, project)) throw foreignTokenError();
  const accessToken = await obtainProjectAccessToken({ project, resolveToken });
  setHeader(headers, 'Authorization', `Bearer ${accessToken}`);
}

function applyBearer(headers, cfg, vars, missing) {
  const token = pastedToken(cfg, vars, missing);
  setHeader(headers, 'Authorization', `Bearer ${token}`);
}

function applyApiKey(headers, query, cfg, vars, missing) {
  const key = interpolate(String(cfg.key || 'X-API-Key'), vars, missing);
  const value = interpolate(String(cfg.value || cfg.apiKey || ''), vars, missing);
  const in_ = String(cfg.in || cfg.addTo || 'header').toLowerCase();
  if (in_ === 'query') query[key] = value;
  else setHeader(headers, key, value);
}

function grantName(cfg) {
  const grant = String(cfg.grantType || cfg.grant || 'client_credentials');
  if (grant === 'authorization_code') return 'authorization_code';
  if (grant === 'refresh_token') return 'refresh_token';
  return 'client_credentials';
}

function fillRefreshFromProject(cfg, project) {
  if (grantName(cfg) !== 'refresh_token') return cfg;
  const tokenUrl = String(cfg.tokenUrl || cfg.accessTokenUrl || '').trim();
  if (!tokenUrl || !isSalesforceTarget(tokenUrl, project)) return cfg;
  const { salesforceCredentials } = require('../config');
  const creds = salesforceCredentials(project && project.credentialRef);
  const next = { ...cfg };
  if (isPlaceholder(next.refreshToken)) {
    if (!creds || !creds.refreshToken) throw refreshMissingError();
    next.refreshToken = creds.refreshToken;
  }
  if (isPlaceholder(next.clientId) && creds && creds.clientId) next.clientId = creds.clientId;
  if (isPlaceholder(next.clientSecret) && creds && creds.clientSecret) next.clientSecret = creds.clientSecret;
  return next;
}

async function fetchOAuthToken(cfg, vars, missing, transport) {
  const tokenUrl = interpolate(String(cfg.tokenUrl || cfg.accessTokenUrl || ''), vars, missing);
  const grant = grantName(cfg);
  if (!tokenUrl) throw Object.assign(new Error('OAuth 2.0 token URL is required.'), { status: 400 });
  const clientId = interpolate(String(cfg.clientId || ''), vars, missing);
  const clientSecret = interpolate(String(cfg.clientSecret || ''), vars, missing);
  const form = new URLSearchParams({ grant_type: grant, client_id: clientId });
  if (grant !== 'refresh_token' || clientSecret) form.set('client_secret', clientSecret);
  if (grant === 'refresh_token') {
    const refreshToken = interpolate(String(cfg.refreshToken || ''), vars, missing);
    if (!refreshToken || isPlaceholder(refreshToken)) {
      throw Object.assign(new Error('OAuth refresh token is required.'), { status: 400, info: refreshMissingError().info });
    }
    form.set('refresh_token', refreshToken);
  }
  if (grant === 'authorization_code') {
    form.set('code', interpolate(String(cfg.code || ''), vars, missing));
    if (cfg.redirectUri) form.set('redirect_uri', interpolate(String(cfg.redirectUri), vars, missing));
  }
  if (cfg.scope) form.set('scope', interpolate(String(cfg.scope), vars, missing));
  const res = await transport.request({
    method: 'POST',
    url: tokenUrl,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    followRedirects: false,
    settings: cfg.settings || {},
  });
  const body = res.body && typeof res.body === 'object' ? res.body : {};
  const token = body.access_token || body.accessToken;
  if (!token) {
    throw Object.assign(new Error(`OAuth token request failed (HTTP ${res.status}).`), { status: 502, info: { body } });
  }
  return { token, tokenType: body.token_type || 'Bearer', raw: body };
}

function authorizeUrl(cfg, vars, missing) {
  const authUrl = interpolate(String(cfg.authUrl || cfg.authorizationUrl || ''), vars, missing);
  if (!authUrl) throw Object.assign(new Error('OAuth 2.0 authorization URL is required.'), { status: 400 });
  const u = new URL(authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', interpolate(String(cfg.clientId || ''), vars, missing));
  if (cfg.redirectUri) u.searchParams.set('redirect_uri', interpolate(String(cfg.redirectUri), vars, missing));
  if (cfg.scope) u.searchParams.set('scope', interpolate(String(cfg.scope), vars, missing));
  if (cfg.state) u.searchParams.set('state', interpolate(String(cfg.state), vars, missing));
  return u.toString();
}

/**
 * Mutates headers/query. Returns { auth, skipConnectorAuth }.
 * skipConnectorAuth = true means the HTTP/SF connector must not overwrite Authorization.
 */
async function applyAuth({ auth, authConfig = {}, headers, query, vars, missing, transport, settings, project, target, resolveToken }) {
  const mode = String(auth || 'default').toLowerCase();
  const cfg = { ...authConfig, settings };
  if (mode === 'none' || mode === 'noauth' || mode === 'no-auth') {
    return { auth: 'none', skipConnectorAuth: true };
  }
  if (mode === 'inherit' || mode === 'salesforce' || mode === 'sf-session') {
    return { auth: mode === 'inherit' ? 'default' : (mode === 'salesforce' || mode === 'sf-session' ? 'default' : mode), skipConnectorAuth: false };
  }
  if (SF_MODES.has(mode) && !USER_MODES.has(mode)) {
    return { auth: mode === 'inherit' ? 'default' : mode, skipConnectorAuth: false };
  }
  if (mode === 'bearer') {
    if (!pastedToken(cfg, vars, missing)) {
      await attachProjectToken({ headers, project, target, resolveToken });
      return { auth: 'none', skipConnectorAuth: true, oauth: { source: 'project' } };
    }
    applyBearer(headers, cfg, vars, missing);
    return { auth: 'none', skipConnectorAuth: true };
  }
  if (mode === 'basic') {
    applyBasic(headers, cfg, vars, missing);
    return { auth: 'none', skipConnectorAuth: true };
  }
  if (mode === 'apikey' || mode === 'api-key') {
    applyApiKey(headers, query, cfg, vars, missing);
    return { auth: 'none', skipConnectorAuth: true };
  }
  if (mode === 'oauth2' || mode === 'oauth') {
    if (pastedToken(cfg, vars, missing)) {
      applyBearer(headers, cfg, vars, missing);
      return { auth: 'none', skipConnectorAuth: true, oauth: { reused: true } };
    }
    const tokenUrl = String(cfg.tokenUrl || cfg.accessTokenUrl || '').trim();
    if (!tokenUrl) {
      await attachProjectToken({ headers, project, target, resolveToken });
      return { auth: 'none', skipConnectorAuth: true, oauth: { source: 'project' } };
    }
    const ready = fillRefreshFromProject(cfg, project);
    const tok = await fetchOAuthToken(ready, vars, missing, transport);
    setHeader(headers, 'Authorization', `${tok.tokenType === 'Bearer' || !tok.tokenType ? 'Bearer' : tok.tokenType} ${tok.token}`);
    return { auth: 'none', skipConnectorAuth: true, oauth: { tokenType: tok.tokenType } };
  }
  return { auth: mode || 'default', skipConnectorAuth: false };
}

module.exports = { applyAuth, authorizeUrl, fetchOAuthToken, isSalesforceTarget, SF_MODES, USER_MODES, setHeader, headerKey };
