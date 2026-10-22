'use strict';
/**
 * Live Salesforce connector. Tokens are obtained via OAuth 2.0 (client
 * credentials, JWT bearer, or refresh token) from env-var credentials and are
 * cached in memory only — never persisted, logged or returned to the UI.
 */
const fs = require('node:fs');
const path = require('node:path');
const { salesforceCredentials, config } = require('../config');
const { signRS256 } = require('../lib/jwt');
const { explainResponse, explainNetworkError } = require('../lib/errors');
const { restApiOrigin, ensureSalesforceRestPath } = require('./salesforce-org');

const tokenCache = new Map(); // key -> { accessToken, instanceUrl, expiresAt }

const CORRELATION_HEADERS = ['x-correlation-id', 'x-request-id', 'x-b3-traceid', 'traceparent', 'x-amzn-trace-id', 'sforce-call-options'];

class ConnectorError extends Error {
  constructor(explanation) {
    super(explanation.title);
    this.explanation = explanation;
  }
}

class SalesforceConnector {
  constructor(project) {
    this.project = project;
    this.kind = 'live';
    this.creds = salesforceCredentials(project.credentialRef);
    this.lowPrivCreds = salesforceCredentials(project.credentialRef, 'LOWPRIV');
  }

  get available() { return Boolean(this.creds); }
  get hasLowPrivilegeUser() { return Boolean(this.lowPrivCreds); }

  unavailableExplanation() {
    return {
      code: 'SALESFORCE_NOT_CONFIGURED',
      title: require('../config').SF_UNAVAILABLE_MESSAGE,
      cause: `No credentials found for prefix SF_${String(this.project.credentialRef || '<unset>').toUpperCase()}_* in the server environment.`,
      action: 'Add the SF_<PREFIX>_AUTH_FLOW / CLIENT_ID / … variables to .env (see .env.example) and restart, or switch the project to demo mode.',
      category: 'configuration',
      evidence: [require('../config').SF_UNAVAILABLE_MESSAGE],
    };
  }

  async token(variant = 'default') {
    const creds = variant === 'lowpriv' ? this.lowPrivCreds : this.creds;
    if (!creds) {
      if (variant === 'lowpriv') {
        throw new ConnectorError({
          code: 'LOW_PRIVILEGE_USER_NOT_CONFIGURED', title: 'No low-privilege user configured',
          cause: 'Authorization tests need a second, restricted integration user.',
          action: `Configure SF_${String(this.project.credentialRef).toUpperCase()}_LOWPRIV_* variables.`, category: 'configuration', evidence: [],
        });
      }
      throw new ConnectorError(this.unavailableExplanation());
    }
    const key = `${this.project.id}:${variant}`;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 30000) return cached;

    const loginUrl = (creds.loginUrl || this.project.instanceUrl || 'https://login.salesforce.com').replace(/\/$/, '');
    const form = new URLSearchParams();
    if (creds.flow === 'client_credentials') {
      form.set('grant_type', 'client_credentials');
      form.set('client_id', creds.clientId);
      form.set('client_secret', creds.clientSecret);
    } else if (creds.flow === 'jwt') {
      const keyPath = path.resolve(config.root, creds.privateKeyPath || '');
      if (!creds.privateKeyPath || !fs.existsSync(keyPath)) {
        throw new ConnectorError({ code: 'JWT_KEY_MISSING', title: 'JWT private key file not found', cause: 'PRIVATE_KEY_PATH is unset or points to a missing file.', action: 'Set SF_<PREFIX>_PRIVATE_KEY_PATH to the connected-app certificate private key.', category: 'configuration', evidence: [] });
      }
      const aud = /test\.salesforce\.com|sandbox/.test(loginUrl) ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
      const assertion = signRS256({ iss: creds.clientId, sub: creds.username, aud, exp: Math.floor(Date.now() / 1000) + 180 }, fs.readFileSync(keyPath, 'utf8'));
      form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      form.set('assertion', assertion);
    } else if (creds.flow === 'refresh_token') {
      form.set('grant_type', 'refresh_token');
      form.set('client_id', creds.clientId);
      if (creds.clientSecret) form.set('client_secret', creds.clientSecret);
      form.set('refresh_token', creds.refreshToken);
    } else {
      throw new ConnectorError({ code: 'UNSUPPORTED_AUTH_FLOW', title: `Unsupported auth flow "${creds.flow}"`, cause: 'AUTH_FLOW must be client_credentials, jwt or refresh_token.', action: 'Correct SF_<PREFIX>_AUTH_FLOW.', category: 'configuration', evidence: [] });
    }

    let res; let body;
    const url = `${loginUrl}/services/oauth2/token`;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(20000) });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      throw new ConnectorError(explainNetworkError(e, url));
    }
    if (!res.ok || !body.access_token) {
      const ex = explainResponse({ status: res.status, body, method: 'POST', url });
      throw new ConnectorError({ ...ex, title: `OAuth token request failed: ${ex.title}` });
    }
    const entry = {
      accessToken: body.access_token,
      instanceUrl: (body.instance_url || this.project.instanceUrl || loginUrl).replace(/\/$/, ''),
      expiresAt: Date.now() + 25 * 60 * 1000,
    };
    tokenCache.set(key, entry);
    return entry;
  }

  /**
   * Execute an API request.
   * @param {object} r { method, path, headers, query, body, bodyRaw, auth: default|none|invalid|lowpriv, timeoutMs, apiType }
   * @returns {Promise<{status, statusText, headers, body, text, timeMs, sizeBytes, url, correlationId}>}
   */
  async request(r) {
    const auth = r.auth || 'default';
    let instanceUrl = restApiOrigin(this.project.instanceUrl) || String(this.project.instanceUrl || '').replace(/\/$/, '');
    const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity', ...(r.headers || {}) };
    if (auth === 'default' || auth === 'lowpriv') {
      const t = await this.token(auth === 'lowpriv' ? 'lowpriv' : 'default');
      instanceUrl = restApiOrigin(t.instanceUrl) || t.instanceUrl || instanceUrl;
      headers.Authorization = `Bearer ${t.accessToken}`;
    } else if (auth === 'invalid') {
      headers.Authorization = 'Bearer 00DINVALIDTOKEN!QA.NegativeTest.InvalidToken';
    }
    // auth === 'none' (and helper-applied Bearer/Basic) keeps caller Authorization.
    if (!instanceUrl) {
      throw new ConnectorError({
        code: 'SF_INSTANCE_MISSING',
        title: 'No Salesforce API host is set.',
        cause: 'The login URL (login.salesforce.com / Lightning) is not a REST API host and returns HTTP 403/410.',
        action: 'Log in, then Test — we save the org’s *.my.salesforce.com instance URL for API calls.',
        category: 'configuration',
        evidence: [],
      });
    }
    if (r.apiType === 'SOAP' && headers.Authorization && r.bodyRaw && r.bodyRaw.includes('{{sessionId}}')) {
      r.bodyRaw = r.bodyRaw.replace(/\{\{sessionId\}\}/g, headers.Authorization.replace('Bearer ', ''));
    }
    const path = r.apiType === 'SOAP' || r.apiType === 'HTTP' ? (r.path || '/') : ensureSalesforceRestPath(r.path, this.project.apiVersion);
    const target = /^https?:\/\//.test(path) ? new URL(path) : new URL(instanceUrl + (path.startsWith('/') ? '' : '/') + path);
    const apiHost = (() => { try { return new URL(instanceUrl).host; } catch { return ''; } })();
    if (apiHost && target.host !== apiHost && headers.Authorization && auth !== 'invalid') {
      // Never forward a Salesforce token to a foreign host.
      delete headers.Authorization;
    }
    for (const [k, v] of Object.entries(r.query || {})) if (v !== undefined && v !== '') target.searchParams.set(k, v);

    let payload;
    if (r.bodyRaw !== undefined && r.bodyRaw !== null && r.bodyRaw !== '') {
      payload = r.bodyRaw;
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = r.apiType === 'SOAP' ? 'text/xml; charset=UTF-8' : 'application/json';
    } else if (r.body !== undefined && r.body !== null && !['GET', 'HEAD'].includes(r.method)) {
      payload = JSON.stringify(r.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    if (r.apiType === 'SOAP' && !Object.keys(headers).some((h) => h.toLowerCase() === 'soapaction')) headers.SOAPAction = '""';

    const started = performance.now();
    let res;
    try {
      res = await fetch(target, { method: r.method, headers, body: payload, signal: AbortSignal.timeout(r.timeoutMs || 30000), redirect: 'manual' });
    } catch (e) {
      const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      const err = new ConnectorError(explainNetworkError(isTimeout ? { code: 'TIMEOUT', message: `No response within ${r.timeoutMs || 30000} ms` } : e, target.toString()));
      err.timeMs = Math.round(performance.now() - started);
      err.url = target.toString();
      throw err;
    }
    const text = await res.text();
    const timeMs = Math.round(performance.now() - started);
    const resHeaders = Object.fromEntries(res.headers.entries());
    let body = text;
    if ((resHeaders['content-type'] || '').includes('json') && text) {
      try { body = JSON.parse(text); } catch { /* keep text */ }
    }
    if (res.status === 401 && auth === 'default') tokenCache.delete(`${this.project.id}:default`);
    const correlationId = CORRELATION_HEADERS.map((h) => resHeaders[h]).find(Boolean) || null;
    return {
      status: res.status, statusText: res.statusText, headers: resHeaders, body, text,
      timeMs, sizeBytes: Buffer.byteLength(text), url: target.toString(), correlationId,
      requestHeaders: headers, requestBody: payload,
    };
  }

  v() { return `/services/data/v${this.project.apiVersion}`; }

  async ensureOk(res, what) {
    if (res.status >= 200 && res.status < 300) return res.body;
    throw new ConnectorError({ ...explainResponse({ status: res.status, body: res.body, method: 'GET', url: res.url }), title: `${what}: ${explainResponse({ status: res.status, body: res.body }).title}` });
  }

  async describeGlobal() {
    const res = await this.request({ method: 'GET', path: `${this.v()}/sobjects` });
    const body = await this.ensureOk(res, 'describeGlobal failed');
    return body.sobjects.map((o) => ({ name: o.name, label: o.label, custom: o.custom, keyPrefix: o.keyPrefix, queryable: o.queryable, createable: o.createable, updateable: o.updateable, deletable: o.deletable }));
  }

  async describe(objectName) {
    if (!/^[A-Za-z0-9_]+$/.test(objectName)) throw new ConnectorError({ code: 'INVALID_OBJECT', title: 'Invalid object API name', cause: 'Object names may only contain letters, digits and underscores.', action: 'Correct the object name.', category: 'test design', evidence: [objectName] });
    const res = await this.request({ method: 'GET', path: `${this.v()}/sobjects/${objectName}/describe` });
    const d = await this.ensureOk(res, `describe ${objectName} failed`);
    return normaliseDescribe(d);
  }

  async query(soql) {
    const res = await this.request({ method: 'GET', path: `${this.v()}/query`, query: { q: soql } });
    return this.ensureOk(res, 'SOQL query failed');
  }

  async queryTooling(soql) {
    const res = await this.request({ method: 'GET', path: `${this.v()}/tooling/query`, query: { q: soql } });
    return this.ensureOk(res, 'Tooling query failed');
  }

  async orgDisplay() {
    const { sanitizeOrgDisplay } = require('./salesforce-org');
    const res = await this.request({ method: 'GET', path: '/services/oauth2/userinfo' });
    const body = await this.ensureOk(res, 'Identity (userinfo) failed');
    return sanitizeOrgDisplay({
      username: body.preferred_username || body.username,
      orgId: body.organization_id,
      instanceUrl: body.urls && body.urls.custom_domain ? String(body.urls.custom_domain).replace(/\/$/, '') : this.project.instanceUrl,
      status: 'Connected',
    });
  }

  async limits() {
    const res = await this.request({ method: 'GET', path: `${this.v()}/limits` });
    return this.ensureOk(res, 'limits failed');
  }

  async testConnection() {
    const t0 = Date.now();
    const res = await this.request({ method: 'GET', path: '/services/data' });
    const versions = await this.ensureOk(res, 'Version discovery failed');
    const latest = Array.isArray(versions) ? versions[versions.length - 1] : null;
    return { ok: true, ms: Date.now() - t0, latestApiVersion: latest && latest.version, configuredApiVersion: this.project.apiVersion, supported: Array.isArray(versions) && versions.some((v) => v.version === this.project.apiVersion) };
  }
}

/** CLI/REST describe may return picklists as strings or `{ value, active }` objects. */
function picklistStrings(values) {
  return (values || []).map((p) => {
    if (typeof p === 'string') return p;
    if (!p || p.active === false) return null;
    return p.value || p.label || null;
  }).filter((v) => typeof v === 'string' && v);
}

function normaliseDescribe(d) {
  return {
    name: d.name, label: d.label, keyPrefix: d.keyPrefix, custom: d.custom,
    createable: d.createable, updateable: d.updateable, deletable: d.deletable, queryable: d.queryable,
    fields: (d.fields || []).map((f) => ({
      name: f.name, label: f.label, type: f.type, length: f.length, precision: f.precision, scale: f.scale,
      nillable: f.nillable, createable: f.createable, updateable: f.updateable, defaultedOnCreate: f.defaultedOnCreate,
      unique: f.unique, externalId: f.externalId, calculated: f.calculated, custom: f.custom,
      required: f.createable && !f.nillable && !f.defaultedOnCreate,
      referenceTo: f.referenceTo, relationshipName: f.relationshipName,
      picklistValues: picklistStrings(f.picklistValues),
      restrictedPicklist: f.restrictedPicklist,
    })),
    childRelationships: (d.childRelationships || []).filter((c) => c.relationshipName).slice(0, 60).map((c) => ({ childSObject: c.childSObject, field: c.field, relationshipName: c.relationshipName })),
    recordTypeInfos: (d.recordTypeInfos || []).map((r) => ({ name: r.name, developerName: r.developerName, active: r.active, defaultRecordTypeMapping: r.defaultRecordTypeMapping })),
  };
}

module.exports = { SalesforceConnector, ConnectorError, normaliseDescribe, picklistStrings };
