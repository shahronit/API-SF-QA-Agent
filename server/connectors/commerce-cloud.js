'use strict';
/**
 * Live Salesforce B2C Commerce Cloud connector (OCAPI Shop + SCAPI Shopper).
 * Tokens come from env credentials (SLAS client_credentials or OCAPI OAuth)
 * and are cached in memory only.
 */
const { commerceCredentials } = require('../config');
const { explainResponse, explainNetworkError } = require('../lib/errors');
const { ConnectorError } = require('./salesforce');

const tokenCache = new Map();

function commerceCfg(project) {
  return (project.integrationConfig && project.integrationConfig.commerce) || {};
}

class CommerceCloudConnector {
  constructor(project) {
    this.project = project;
    this.kind = 'live-commerce';
    this.cfg = commerceCfg(project);
    this.creds = commerceCredentials(this.cfg.credentialRef || project.credentialRef);
  }

  get available() {
    return Boolean(this.cfg.host || this.cfg.shortCode || this.cfg.orgId);
  }

  unavailableExplanation() {
    return {
      code: 'COMMERCE_NOT_CONFIGURED',
      title: 'Salesforce Commerce Cloud is not connected. OCAPI/SCAPI tests cannot run against a live storefront.',
      cause: `Need SFCC_<PREFIX>_CLIENT_ID / CLIENT_SECRET and a host or shortCode+orgId on the project.`,
      action: 'Open Connections → Commerce Cloud, save the storefront identifiers and credential prefix, then add SFCC_<PREFIX>_* to .env (or use Save to .env on loopback) and Test connections.',
      category: 'configuration',
      evidence: [],
    };
  }

  async token() {
    if (!this.creds) throw new ConnectorError(this.unavailableExplanation());
    const key = this.project.id + ':sfcc';
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 30000) return cached;

    let url; let headers; let body;
    if (this.cfg.shortCode && this.cfg.orgId) {
      url = `https://${this.cfg.shortCode}.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/${this.cfg.orgId}/oauth2/token`;
      body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.creds.clientId, client_secret: this.creds.clientSecret });
      headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    } else {
      url = 'https://account.demandware.com/dw/oauth2/access_token';
      const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64');
      body = new URLSearchParams({ grant_type: 'client_credentials' });
      headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: `Basic ${basic}` };
    }
    let res; let json;
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
      json = await res.json().catch(() => ({}));
    } catch (e) {
      throw new ConnectorError(explainNetworkError(e, url));
    }
    if (!res.ok || !json.access_token) {
      throw new ConnectorError({ ...explainResponse({ status: res.status, body: json, method: 'POST', url }), title: `Commerce Cloud token request failed (${res.status})` });
    }
    const entry = { accessToken: json.access_token, expiresAt: Date.now() + Math.max(60, Number(json.expires_in || 900) - 60) * 1000 };
    tokenCache.set(key, entry);
    return entry;
  }

  originFor(path) {
    if (/^https?:\/\//i.test(path)) return '';
    if (/\/dw\/(shop|data)\//.test(path) || path.startsWith('/s/')) {
      const host = (this.cfg.host || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!host) throw new ConnectorError({ code: 'COMMERCE_HOST_MISSING', title: 'Commerce Cloud OCAPI host is not set.', action: 'Set the Business Manager / storefront host on Connections (e.g. xyz-001.dx.commercecloud.salesforce.com).', category: 'configuration', evidence: [] });
      return `https://${host}`;
    }
    const sc = this.cfg.shortCode;
    if (!sc) throw new ConnectorError({ code: 'COMMERCE_SHORTCODE_MISSING', title: 'Commerce Cloud short code is not set.', action: 'Set the SCAPI short code on Connections.', category: 'configuration', evidence: [] });
    return `https://${sc}.api.commercecloud.salesforce.com`;
  }

  async request(r) {
    const auth = r.auth || 'default';
    const headers = { Accept: 'application/json', ...(r.headers || {}) };
    if (auth === 'default' || auth === 'lowpriv') {
      const t = await this.token();
      headers.Authorization = `Bearer ${t.accessToken}`;
    } else if (auth === 'invalid') {
      headers.Authorization = 'Bearer INVALID.SFCC.TOKEN';
    } else {
      delete headers.Authorization;
    }
    const origin = this.originFor(r.path);
    const target = /^https?:\/\//.test(r.path) ? new URL(r.path) : new URL(origin + (r.path.startsWith('/') ? r.path : '/' + r.path));
    for (const [k, v] of Object.entries(r.query || {})) if (v !== undefined && v !== '') target.searchParams.set(k, v);
    let payload;
    if (r.bodyRaw !== undefined && r.bodyRaw !== null && r.bodyRaw !== '') {
      payload = r.bodyRaw;
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    } else if (r.body !== undefined && r.body !== null && !['GET', 'HEAD'].includes(r.method)) {
      payload = JSON.stringify(r.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const started = performance.now();
    let res;
    try {
      res = await fetch(target, { method: r.method, headers, body: payload, signal: AbortSignal.timeout(r.timeoutMs || 30000), redirect: 'manual' });
    } catch (e) {
      throw new ConnectorError(explainNetworkError(e, String(target)));
    }
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    const hdrs = {};
    res.headers.forEach((v, k) => { hdrs[k] = v; });
    return {
      status: res.status, statusText: res.statusText, headers: hdrs, body, text,
      timeMs: Math.round(performance.now() - started), sizeBytes: Buffer.byteLength(text || ''),
      url: String(target), correlationId: hdrs['x-correlation-id'] || hdrs['sfdc-request-id'] || null,
    };
  }

  async testConnection() {
    const t0 = Date.now();
    if (!this.creds) {
      const { probeSfccHost } = require('../engine/salesforce-detect');
      const host = (this.cfg.host || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!host) return { ok: false, ...this.unavailableExplanation() };
      const probe = await probeSfccHost(host);
      const reachable = probe.some((c) => c.status && c.status < 500);
      return {
        ok: reachable,
        kind: 'sfcc-host',
        host,
        siteId: this.cfg.siteId || null,
        probe,
        ms: Date.now() - t0,
        title: reachable ? 'SFCC host reachable' : 'SFCC host did not respond',
        text: reachable
          ? 'Business Manager / OCAPI host responded. Live shopper calls still need a SLAS client in .env (Advanced) — testers are wired from this host.'
          : 'Could not reach the Commerce Cloud host. Confirm the URL and that you can open Business Manager in the browser.',
      };
    }
    await this.token();
    const site = this.cfg.siteId || 'RefArch';
    const ver = this.cfg.ocapiVersion || 'v24_5';
    const checks = {};
    if (this.cfg.host) {
      const res = await this.request({ method: 'GET', path: `/s/${site}/dw/shop/${ver}/product_search`, query: { q: 'a', count: 1 }, auth: 'default' });
      checks.ocapi = { status: res.status, ok: res.status < 400 };
    }
    if (this.cfg.shortCode && this.cfg.orgId) {
      const res = await this.request({ method: 'GET', path: `/search/shopper-search/v1/organizations/${this.cfg.orgId}/product-search`, query: { q: 'a', limit: 1 }, auth: 'default' });
      checks.scapi = { status: res.status, ok: res.status < 400 };
    }
    const ok = Object.values(checks).some((c) => c.ok) || (!this.cfg.host && !(this.cfg.shortCode && this.cfg.orgId));
    let catalog = null;
    if (this.creds) {
      try { catalog = await this.fetchCatalogSample(); } catch { catalog = null; }
    }
    return {
      ok: ok || Object.keys(checks).length === 0, kind: 'live-commerce', siteId: site, orgId: this.cfg.orgId,
      shortCode: this.cfg.shortCode, checks, catalog, ms: Date.now() - t0,
      needsSlas: !this.creds,
    };
  }

  async fetchCatalogSample() {
    if (!this.creds) return { productId: null, reason: 'no-slas' };
    const site = this.cfg.siteId;
    const ver = this.cfg.ocapiVersion || 'v24_5';
    const q = this.cfg.searchQuery || 'a';
    if (this.cfg.host && site) {
      const res = await this.request({ method: 'GET', path: `/s/${site}/dw/shop/${ver}/product_search`, query: { q, count: 1 }, auth: 'default' });
      const hit = res.body && Array.isArray(res.body.hits) ? res.body.hits[0] : null;
      const id = hit && (hit.product_id || hit.productId || (hit.product && hit.product.id));
      if (id) return { productId: String(id), source: 'ocapi-search', siteId: site };
    }
    if (this.cfg.shortCode && this.cfg.orgId) {
      const res = await this.request({
        method: 'GET',
        path: `/search/shopper-search/v1/organizations/${this.cfg.orgId}/product-search`,
        query: { q, limit: 1 },
        auth: 'default',
      });
      const hit = res.body && Array.isArray(res.body.hits) ? res.body.hits[0] : null;
      const id = hit && (hit.productId || (hit.representedProduct && hit.representedProduct.id) || hit.product_id);
      if (id) return { productId: String(id), source: 'scapi-search', orgId: this.cfg.orgId };
    }
    return { productId: null, reason: 'empty-catalog' };
  }
}

module.exports = { CommerceCloudConnector, commerceCfg };
