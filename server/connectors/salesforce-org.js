'use strict';
/**
 * Salesforce login URL classification (Core CRM vs B2C / SFCC) and safe
 * identity shaping. Tokens and passwords are never kept here.
 */

const SECRET_KEYS = /^(accessToken|refreshToken|clientSecret|sfdxAuthUrl|password|authCode|privateKey|clientId)$/i;

const SFCC_HOST = /(^|\.)demandware\.(net|com)$|(^|\.)commercecloud\.salesforce\.com$|^account(-pod\d+)?\.demandware\.com$/i;
const CORE_HOST = /(^|\.)(salesforce|force|cloudforce|salesforce-setup|salesforce-sites)\.com$/i;

const TYPE_CORE = 'Salesforce Core';
const TYPE_EXPERIENCE_B2B = 'Experience Cloud B2B';
const TYPE_EXPERIENCE_B2C = 'Experience Cloud B2C';
const TYPE_SFCC_B2B = 'SFCC B2B';
const TYPE_SFCC_B2C = 'SFCC B2C';

const ORG_KIND = {
  CORE: 'core',
  EXPERIENCE_B2B: 'experience-b2b',
  EXPERIENCE_B2C: 'experience-b2c',
  SFCC_B2B: 'sfcc-b2b',
  SFCC_B2C: 'sfcc-b2c',
  HTTP: 'http',
};
const SPECIFIC_ORG_KINDS = new Set([
  ORG_KIND.EXPERIENCE_B2B, ORG_KIND.EXPERIENCE_B2C, ORG_KIND.SFCC_B2B, ORG_KIND.SFCC_B2C,
]);

const TYPE_ALIASES = {
  'Experience / B2B Commerce': TYPE_EXPERIENCE_B2B,
  'Experience Cloud': TYPE_EXPERIENCE_B2C,
  'B2C Commerce': TYPE_SFCC_B2C,
  SFCC: TYPE_SFCC_B2C,
  'B2C Commerce / SFCC': TYPE_SFCC_B2C,
};

function normalizeTypeLabels(types) {
  const out = [];
  const seen = new Set();
  for (const raw of types || []) {
    const t = TYPE_ALIASES[raw] || raw;
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function inferChannelFromText(blob, { defaultChannel } = {}) {
  const t = String(blob || '').toLowerCase();
  const b2b = /\bb2b\b/.test(t);
  const b2c = /\bb2c\b|\bd2c\b/.test(t);
  if (b2b && !b2c) return 'b2b';
  if (b2c && !b2b) return 'b2c';
  if (b2b && b2c) {
    if (/experience\s*(cloud\s*)?b2b|\bb2b\s*commerce\b|\bsfcc\s*b2b\b/.test(t)) return 'b2b';
    if (/experience\s*(cloud\s*)?b2c|\bsfcc\s*b2c\b|\bb2c\s*commerce\b/.test(t)) return 'b2c';
  }
  return defaultChannel || null;
}

function inferSfccChannel({ host, name, siteId, blob } = {}) {
  return inferChannelFromText(`${name || ''} ${host || ''} ${siteId || ''} ${blob || ''}`, { defaultChannel: 'b2c' });
}

function typeForOrgKind(kind) {
  switch (kind) {
    case ORG_KIND.EXPERIENCE_B2B: return TYPE_EXPERIENCE_B2B;
    case ORG_KIND.EXPERIENCE_B2C: return TYPE_EXPERIENCE_B2C;
    case ORG_KIND.SFCC_B2B: return TYPE_SFCC_B2B;
    case ORG_KIND.SFCC_B2C: return TYPE_SFCC_B2C;
    case ORG_KIND.CORE: return TYPE_CORE;
    default: return null;
  }
}

function typesForOrgKind(kind) {
  const t = typeForOrgKind(kind);
  if (!t) return [];
  if (String(kind).startsWith('experience')) return [TYPE_CORE, t];
  return [t];
}

function orgKindFromTypes(types, loginKind) {
  const t = normalizeTypeLabels(types);
  if (t.includes(TYPE_EXPERIENCE_B2B)) return ORG_KIND.EXPERIENCE_B2B;
  if (t.includes(TYPE_EXPERIENCE_B2C)) return ORG_KIND.EXPERIENCE_B2C;
  if (t.includes(TYPE_SFCC_B2B)) return ORG_KIND.SFCC_B2B;
  if (t.includes(TYPE_SFCC_B2C)) return ORG_KIND.SFCC_B2C;
  if (loginKind === 'sfcc') return ORG_KIND.SFCC_B2C;
  if (t.includes(TYPE_CORE)) return ORG_KIND.CORE;
  return null;
}

function kindsFromTypes(types, loginKind) {
  const t = normalizeTypeLabels(types);
  const kinds = [];
  if (t.includes(TYPE_EXPERIENCE_B2B)) kinds.push(ORG_KIND.EXPERIENCE_B2B);
  if (t.includes(TYPE_EXPERIENCE_B2C)) kinds.push(ORG_KIND.EXPERIENCE_B2C);
  if (t.includes(TYPE_SFCC_B2B)) kinds.push(ORG_KIND.SFCC_B2B);
  if (t.includes(TYPE_SFCC_B2C)) kinds.push(ORG_KIND.SFCC_B2C);
  if (loginKind === 'sfcc' && !kinds.some((k) => k.startsWith('sfcc'))) kinds.push(ORG_KIND.SFCC_B2C);
  if (!kinds.length && t.includes(TYPE_CORE)) kinds.push(ORG_KIND.CORE);
  return kinds;
}

function familyOf(kind) {
  if (!kind) return null;
  if (String(kind).startsWith('experience')) return 'experience';
  if (String(kind).startsWith('sfcc')) return 'sfcc';
  return kind;
}

function kindsCompatible(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  if (a === ORG_KIND.HTTP || b === ORG_KIND.HTTP) return true;
  if (a === ORG_KIND.CORE && familyOf(b) === 'experience') return true;
  if (b === ORG_KIND.CORE && familyOf(a) === 'experience') return true;
  return false;
}

function isExperienceType(t) {
  const n = TYPE_ALIASES[t] || t;
  return n === TYPE_EXPERIENCE_B2B || n === TYPE_EXPERIENCE_B2C;
}

function isSfccType(t) {
  const n = TYPE_ALIASES[t] || t;
  return n === TYPE_SFCC_B2B || n === TYPE_SFCC_B2C;
}

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
      types: [inferSfccChannel({ host }) === 'b2b' ? TYPE_SFCC_B2B : TYPE_SFCC_B2C],
      orgKind: inferSfccChannel({ host }) === 'b2b' ? ORG_KIND.SFCC_B2B : ORG_KIND.SFCC_B2C,
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

/**
 * Origin only when the host is a definite Salesforce Core / Experience or
 * SFCC host. Template values and ordinary HTTP origins must not be persisted
 * as `instanceUrl`.
 */
function salesforceLoginOrigin(input) {
  const raw = String(input || '').trim();
  if (!raw || /\{\{/.test(raw)) return '';
  const c = classifyLoginUrl(raw);
  if (!c.origin || !/^https:\/\//i.test(c.origin)) return '';
  if (c.kind === 'sfcc') return c.origin;
  if (c.kind === 'core' && !c.ambiguous) return c.origin;
  return '';
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
    types: normalizeTypeLabels(Array.isArray(det.types) ? det.types : []),
    orgKind: det.orgKind || orgKindFromTypes(det.types, det.loginKind) || null,
    products: Array.isArray(det.products) ? det.products.slice(0, 40) : [],
    sites: Array.isArray(det.sites) ? det.sites.slice(0, 40) : [],
    stores: Array.isArray(det.stores) ? det.stores.slice(0, 40) : [],
    explanation: det.explanation || '',
    ambiguous: Boolean(det.ambiguous),
    detectedAt: det.detectedAt || null,
  };
}

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
  classifyLoginUrl, normalizeLoginUrl, salesforceLoginOrigin, loginPlan, sanitizeOrgDisplay, publicDetection,
  maskUsername, restApiOrigin, loginOauthOrigin, toRestPath, ensureSalesforceRestPath, normalizeSalesforcePath,
  TYPE_CORE, TYPE_EXPERIENCE_B2B, TYPE_EXPERIENCE_B2C, TYPE_SFCC_B2B, TYPE_SFCC_B2C,
  ORG_KIND, SPECIFIC_ORG_KINDS, normalizeTypeLabels, inferChannelFromText, inferSfccChannel,
  typeForOrgKind, typesForOrgKind, orgKindFromTypes, kindsFromTypes, familyOf, kindsCompatible,
  isExperienceType, isSfccType,
};
