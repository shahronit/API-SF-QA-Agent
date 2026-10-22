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

function applyBearer(headers, cfg, vars, missing) {
  const token = interpolate(String(cfg.token || cfg.accessToken || '').replace(/^Bearer\s+/i, ''), vars, missing);
  setHeader(headers, 'Authorization', `Bearer ${token}`);
}

function applyApiKey(headers, query, cfg, vars, missing) {
  const key = interpolate(String(cfg.key || 'X-API-Key'), vars, missing);
  const value = interpolate(String(cfg.value || cfg.apiKey || ''), vars, missing);
  const in_ = String(cfg.in || cfg.addTo || 'header').toLowerCase();
  if (in_ === 'query') query[key] = value;
  else setHeader(headers, key, value);
}

async function fetchOAuthToken(cfg, vars, missing, transport) {
  const tokenUrl = interpolate(String(cfg.tokenUrl || cfg.accessTokenUrl || ''), vars, missing);
  const grant = String(cfg.grantType || cfg.grant || 'client_credentials');
  if (!tokenUrl) throw Object.assign(new Error('OAuth 2.0 token URL is required.'), { status: 400 });
  const clientId = interpolate(String(cfg.clientId || ''), vars, missing);
  const clientSecret = interpolate(String(cfg.clientSecret || ''), vars, missing);
  const form = new URLSearchParams({ grant_type: grant === 'authorization_code' ? 'authorization_code' : 'client_credentials', client_id: clientId, client_secret: clientSecret });
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
async function applyAuth({ auth, authConfig = {}, headers, query, vars, missing, transport, settings }) {
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
    if (cfg.token) {
      applyBearer(headers, cfg, vars, missing);
      return { auth: 'none', skipConnectorAuth: true, oauth: { reused: true } };
    }
    const tok = await fetchOAuthToken(cfg, vars, missing, transport);
    setHeader(headers, 'Authorization', `${tok.tokenType === 'Bearer' || !tok.tokenType ? 'Bearer' : tok.tokenType} ${tok.token}`);
    return { auth: 'none', skipConnectorAuth: true, oauth: { tokenType: tok.tokenType } };
  }
  return { auth: mode || 'default', skipConnectorAuth: false };
}

module.exports = { applyAuth, authorizeUrl, fetchOAuthToken, SF_MODES, USER_MODES, setHeader, headerKey };
