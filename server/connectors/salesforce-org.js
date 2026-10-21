'use strict';
/**
 * Salesforce login URL classification (Core CRM vs B2C / SFCC) and safe
 * identity shaping. Tokens and passwords are never kept here.
 */

const SECRET_KEYS = /^(accessToken|refreshToken|clientSecret|sfdxAuthUrl|password|authCode|privateKey|clientId)$/i;

const SFCC_HOST = /(^|\.)demandware\.(net|com)$|(^|\.)commercecloud\.salesforce\.com$|^account(-pod\d+)?\.demandware\.com$/i;
const CORE_HOST = /(^|\.)(salesforce|force|cloudforce|salesforce-setup|salesforce-sites)\.com$/i;

function maskUsername(u) {
  if (!u || typeof u !== 'string') return null;
  const at = u.indexOf('@');
  if (at > 1) return `${u[0]}***${u.slice(at)}`;
  if (u.length <= 3) return '***';
  return `${u.slice(0, 2)}***`;
}

function parseHref(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
  try { return new URL(href); } catch { return null; }
}

/**
 * Classify a user-entered Salesforce / SFCC login or instance URL.
 * Core: login.salesforce.com, My Domain, sandbox, Lightning.
 * SFCC: Account Manager, Business Manager, demandware / commercecloud hosts.
 */
function classifyLoginUrl(input) {
  const u = parseHref(input);
  if (!String(input || '').trim()) return { kind: 'empty', origin: '', host: '', loginUrl: '' };
  if (!u) return { kind: 'invalid', origin: '', host: '', loginUrl: '', error: 'Not a valid URL.' };
  if (u.protocol !== 'https:') {
    return { kind: 'invalid', origin: '', host: u.hostname, loginUrl: '', error: 'Login URL must use https://.' };
  }
  const host = u.hostname.toLowerCase();
  const origin = u.origin;

  if (SFCC_HOST.test(host)) {
    const isAccountManager = /^account(-pod\d+)?\.demandware\.com$/i.test(host);
    const loginUrl = isAccountManager ? origin : `${origin}/on/demandware.store/Sites-Site`;
    return {
      kind: 'sfcc',
      origin,
      host,
      loginUrl,
      accountManager: 'https://account.demandware.com',
      types: ['B2C Commerce / SFCC'],
    };
  }

  let loginOrigin = origin;
  if (/\.lightning\.force\.com$/i.test(host)) {
    loginOrigin = `https://${host.replace(/\.lightning\.force\.com$/i, '.my.salesforce.com')}`;
  }

  if (CORE_HOST.test(host)) {
    return { kind: 'core', origin: loginOrigin, host: new URL(loginOrigin).hostname, loginUrl: loginOrigin, types: ['Salesforce Core'] };
  }

  return {
    kind: 'core',
    origin,
    host,
    loginUrl: origin,
    ambiguous: true,
    types: ['Salesforce Core'],
  };
}

function normalizeLoginUrl(input) {
  const c = classifyLoginUrl(input);
  return c.origin || '';
}

/** Verified `sf org login web` flags: --instance-url / -r, --alias / -a. Do not invent flags. */
function loginPlan(instanceUrl, { alias } = {}) {
  const classified = classifyLoginUrl(instanceUrl || 'https://login.salesforce.com');
  if (classified.kind === 'invalid') {
    return { ok: false, title: classified.error || 'Enter a Salesforce or Commerce Cloud https URL.', classified };
  }
  if (classified.kind === 'empty') {
    return {
      ok: true,
      action: 'sf-login-web',
      loginKind: 'core',
      loginUrl: 'https://login.salesforce.com',
      alias: alias || '',
      args: alias
        ? ['org', 'login', 'web', '--alias', alias, '--instance-url', 'https://login.salesforce.com']
        : ['org', 'login', 'web', '--instance-url', 'https://login.salesforce.com'],
      classified: { ...classified, kind: 'core', loginUrl: 'https://login.salesforce.com', origin: 'https://login.salesforce.com', host: 'login.salesforce.com' },
    };
  }
  if (classified.kind === 'sfcc') {
    return {
      ok: true,
      action: 'open-url',
      loginKind: 'sfcc',
      loginUrl: classified.loginUrl,
      alias: alias || '',
      classified,
    };
  }
  const args = ['org', 'login', 'web'];
  if (alias) args.push('--alias', alias);
  if (classified.loginUrl) args.push('--instance-url', classified.loginUrl);
  return { ok: true, action: 'sf-login-web', loginKind: 'core', loginUrl: classified.loginUrl, alias: alias || '', args, classified };
}

function sanitizeOrgDisplay(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw.result && typeof raw.result === 'object' ? raw.result : raw;
  const out = {};
  const alias = src.alias || src.username || null;
  if (alias && !SECRET_KEYS.test('alias')) out.alias = String(alias);
  if (src.username) out.username = maskUsername(String(src.username));
  const orgId = src.orgId || src.id || null;
  if (orgId && /^00D/i.test(String(orgId))) out.orgId = String(orgId);
  else if (src.orgId) out.orgId = String(src.orgId);
  if (src.instanceUrl) out.instanceUrl = String(src.instanceUrl).replace(/\/$/, '');
  if (src.loginUrl || src.sfdcLoginUrl) out.loginUrl = String(src.loginUrl || src.sfdcLoginUrl).replace(/\/$/, '');
  if (src.connectedStatus || src.status) out.status = src.connectedStatus || src.status;
  if (src.isSandbox !== undefined) out.isSandbox = Boolean(src.isSandbox);
  if (src.organizationType || src.edition) out.edition = src.organizationType || src.edition;
  if (src.apiVersion) out.apiVersion = String(src.apiVersion);
  return out;
}

function publicDetection(det) {
  if (!det || typeof det !== 'object') return null;
  return {
    connected: Boolean(det.connected),
    loginKind: det.loginKind || null,
    instanceUrl: det.instanceUrl || null,
    host: det.host || null,
    orgId: det.orgId || null,
    orgName: det.orgName || null,
    alias: det.alias || null,
    username: det.username ? maskUsername(det.username) : null,
    edition: det.edition || null,
    apiVersion: det.apiVersion || null,
    isSandbox: det.isSandbox,
    types: Array.isArray(det.types) ? det.types.slice() : [],
    products: Array.isArray(det.products) ? det.products.slice(0, 40) : [],
    sites: Array.isArray(det.sites) ? det.sites.slice(0, 40) : [],
    stores: Array.isArray(det.stores) ? det.stores.slice(0, 40) : [],
    explanation: det.explanation || '',
    ambiguous: Boolean(det.ambiguous),
    detectedAt: det.detectedAt || null,
  };
}

const TYPE_CORE = 'Salesforce Core';
const TYPE_EXPERIENCE_B2B = 'Experience / B2B Commerce';
const TYPE_B2C = 'B2C Commerce';
const TYPE_SFCC = 'SFCC';

const LOGIN_HOST = /^(login|test|test\d*|cs\d+)\.salesforce\.com$/i;
const REST_RESOURCE = /^(sobjects|query|queryAll|composite|connect|commerce|graphql|jobs|tooling|limits|recent|search|parameterizedSearch|ui-api|wave|actions|appMenu|tabs|theme|support|process|emailConnect|knowledgeManagement)\b/i;

/**
 * Origin that serves REST/SOAP (`*.my.salesforce.com`). Login and Lightning
 * hosts return HTTP 403/410 for `/services/data` — never use them as baseUrl.
 */
function restApiOrigin(input) {
  const c = classifyLoginUrl(input);
  if (!c.origin) return '';
  const host = (c.host || '').toLowerCase();
  if (LOGIN_HOST.test(host)) return '';
  if (/\.my\.site\.com$/i.test(host) || /\.salesforce-sites\.com$/i.test(host)) return '';
  return String(c.origin).replace(/\/$/, '');
}

function loginOauthOrigin(input) {
  const c = classifyLoginUrl(input);
  if (!c.origin) return 'https://login.salesforce.com';
  const host = (c.host || '').toLowerCase();
  if (LOGIN_HOST.test(host)) return c.origin.replace(/\/$/, '');
  return restApiOrigin(input) || c.origin.replace(/\/$/, '');
}

/** Path only, no origin. Lightning/login URLs become `/services/...`. */
function toRestPath(endpoint) {
  let p = String(endpoint || '').trim();
  if (!p) return '/';
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = u.pathname + u.search;
    } catch { /* keep */ }
  }
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

/**
 * Generated scripts often omit `/services/data/vXX.X`. Calling `/sobjects/...`
 * or `/connect/...` on the org host is a Lightning route → HTTP 410/403.
 */
function ensureSalesforceRestPath(endpoint, apiVersion) {
  const p = toRestPath(endpoint);
  if (/^\/services\//i.test(p)) {
    return p.replace(/\/services\/data\/v(?:\{\{apiVersion\}\}|\d+(?:\.\d+)?)/ig, `/services/data/v${String(apiVersion || '62.0').replace(/^v/i, '')}`);
  }
  const pathOnly = p.replace(/^\//, '').split('?')[0];
  if (REST_RESOURCE.test(pathOnly)) {
    const v = String(apiVersion || '62.0').replace(/^v/i, '');
    const q = p.includes('?') ? p.slice(p.indexOf('?')) : '';
    const resource = p.split('?')[0];
    return `/services/data/v${v}${resource}${q}`;
  }
  return p;
}

/** Template form stored on test cases (`v{{apiVersion}}`). */
function normalizeSalesforcePath(endpoint) {
  let p = toRestPath(endpoint);
  p = p.replace(/\/services\/data\/v\d+(?:\.\d+)?/ig, '/services/data/v{{apiVersion}}');
  const pathOnly = p.replace(/^\//, '').split('?')[0];
  if (!/^\/services\//i.test(p) && REST_RESOURCE.test(pathOnly)) {
    const q = p.includes('?') ? p.slice(p.indexOf('?')) : '';
    return `/services/data/v{{apiVersion}}${p.split('?')[0]}${q}`;
  }
  return p;
}

module.exports = {
  classifyLoginUrl, normalizeLoginUrl, loginPlan, sanitizeOrgDisplay, publicDetection,
  maskUsername, restApiOrigin, loginOauthOrigin, toRestPath, ensureSalesforceRestPath, normalizeSalesforcePath,
  TYPE_CORE, TYPE_EXPERIENCE_B2B, TYPE_B2C, TYPE_SFCC,
};
