'use strict';
/**
 * Generic frontend HTTP connector (custom REST, BFF, middleware, storefront).
 * Runs the same execute path as Salesforce/Commerce. Tokens come from
 * HTTP_<PREFIX>_TOKEN in the environment — never from the UI or DB.
 */
const { httpCredentials } = require('../config');
const { explainNetworkError } = require('../lib/errors');
const { ConnectorError } = require('./salesforce');

const CORRELATION_HEADERS = ['x-correlation-id', 'x-request-id', 'x-b3-traceid', 'traceparent', 'x-amzn-trace-id'];

function httpCfg(project) {
  return ((project && project.integrationConfig) || {}).http || {};
}

class HttpConnector {
  constructor(project) {
    this.project = project;
    this.kind = 'http';
    this.cfg = httpCfg(project);
    this.creds = httpCredentials(this.cfg.credentialRef || (project && project.credentialRef));
    this.baseUrl = String(this.cfg.baseUrl || (this.creds && this.creds.baseUrl) || '').replace(/\/$/, '');
  }

  get available() {
    return Boolean(this.baseUrl);
  }

  missingHref() {
    const id = this.project && this.project.id;
    return id ? `/projects/${id}?tab=connection&focus=http` : '/projects';
  }

  unavailableExplanation() {
    return {
      code: 'HTTP_BASE_URL_MISSING',
      title: 'Frontend HTTP base URL is not set.',
      cause: 'This test is a custom REST / BFF / middleware call, not a Salesforce org API. The collection did not include a usable origin.',
      action: 'Set the frontend base URL (and bearer token if the API needs one) on Connections → Postman / HTTP.',
      actionLabel: 'Set HTTP base URL',
      href: this.missingHref(),
      category: 'configuration',
      evidence: [],
    };
  }

  tokenMissingExplanation() {
    return {
      code: 'HTTP_TOKEN_MISSING',
      title: 'Frontend HTTP bearer token is not set.',
      cause: 'This collection uses Bearer / OAuth on the frontend API. Tokens are never stored in the database — they live in .env.',
      action: 'On Connections → Postman / HTTP, paste the bearer token (loopback writes HTTP_<PREFIX>_TOKEN to local .env).',
      actionLabel: 'Add bearer token',
      href: this.missingHref(),
      category: 'configuration',
      evidence: [],
    };
  }

  originFor(path) {
    if (/^https?:\/\//i.test(path)) return '';
    if (!this.baseUrl) {
      throw new ConnectorError(this.unavailableExplanation());
    }
    return this.baseUrl;
  }

  async request(r) {
    const auth = r.auth || 'default';
    const headers = { Accept: 'application/json', ...(r.headers || {}) };
    if (auth === 'default' && this.creds && this.creds.token) {
      headers.Authorization = `Bearer ${this.creds.token}`;
    } else if (auth === 'invalid') {
      headers.Authorization = 'Bearer INVALID.HTTP.TOKEN';
    }
    // auth === 'none' keeps a caller-supplied Authorization (Bearer / Basic / OAuth helpers).
    const origin = this.originFor(r.path);
    const target = /^https?:\/\//i.test(r.path)
      ? new URL(r.path)
      : new URL(origin + (String(r.path).startsWith('/') ? r.path : '/' + r.path));
    for (const [k, v] of Object.entries(r.query || {})) if (v !== undefined && v !== '') target.searchParams.set(k, v);

    let payload;
    if (r.bodyRaw !== undefined && r.bodyRaw !== null && r.bodyRaw !== '') {
      payload = r.bodyRaw;
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = r.apiType === 'SOAP' ? 'text/xml; charset=UTF-8' : 'application/json';
      }
    } else if (r.body !== undefined && r.body !== null && !['GET', 'HEAD'].includes(String(r.method || 'GET').toUpperCase())) {
      payload = JSON.stringify(r.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }

    const started = performance.now();
    const { request: transportRequest, httpSettings } = require('../lib/http-transport');
    const cookies = require('../engine/cookie-jar');
    let res;
    try {
      res = await transportRequest({
        method: r.method, url: target.toString(), headers, body: payload,
        timeoutMs: r.timeoutMs || 30000,
        settings: httpSettings(this.project),
        cookieJar: this.project && this.project.id ? cookies.jarFor(this.project.id) : null,
        followRedirects: r.followRedirects !== false,
      });
    } catch (e) {
      const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'TIMEOUT');
      const err = new ConnectorError(explainNetworkError(isTimeout ? { code: 'TIMEOUT', message: `No response within ${r.timeoutMs || 30000} ms` } : e, target.toString()));
      err.timeMs = e.timeMs || Math.round(performance.now() - started);
      err.url = target.toString();
      throw err;
    }
    const resHeaders = res.headers || {};
    const correlationId = CORRELATION_HEADERS.map((h) => {
      const k = Object.keys(resHeaders).find((x) => x.toLowerCase() === h);
      return k ? resHeaders[k] : null;
    }).find(Boolean) || null;
    return {
      status: res.status, statusText: res.statusText, headers: resHeaders, body: res.body, text: res.text,
      timeMs: res.timeMs, sizeBytes: res.sizeBytes,
      url: res.url || target.toString(), correlationId, requestHeaders: res.requestHeaders || headers, requestBody: payload,
    };
  }

  async testConnection() {
    const t0 = Date.now();
    if (!this.baseUrl) return { ok: false, ...this.unavailableExplanation() };
    try {
      const res = await this.request({ method: 'GET', path: '/', auth: this.creds && this.creds.token ? 'default' : 'none' });
      return {
        ok: res.status < 500,
        kind: 'http',
        baseUrl: this.baseUrl,
        statusCode: res.status,
        ms: Date.now() - t0,
        token: Boolean(this.creds && this.creds.token),
        title: res.status < 500 ? `Frontend HTTP reachable (HTTP ${res.status})` : `Frontend HTTP returned HTTP ${res.status}`,
      };
    } catch (e) {
      return { ok: false, kind: 'http', baseUrl: this.baseUrl, ms: Date.now() - t0, ...(e.explanation || { title: e.message }) };
    }
  }
}

function httpFor(project) {
  return new HttpConnector(project);
}

module.exports = { HttpConnector, httpFor, httpCfg };
