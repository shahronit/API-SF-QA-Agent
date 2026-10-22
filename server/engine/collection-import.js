'use strict';
/**
 * Normalise any Postman export (v1 / v2 / v2.1 / API wrap / dump) and detect
 * which QA project / Salesforce org it belongs to so import can reuse or create.
 * Collection JSON never keeps secrets.
 */
const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const { config } = require('../config');
const { classifyLoginUrl, salesforceLoginOrigin, inferChannelFromText, inferSfccChannel, typesForOrgKind, ORG_KIND } = require('../connectors/salesforce-org');
const { projectOrgKind, kindsCompatible } = require('./salesforce-detect');

const SECRET_KEY = /secret|password|token|apikey|api[_-]?key|authorization|refresh|private[_-]?key|sfdx/i;
const ENV_WORDS = config.environments || ['Development', 'QA', 'SIT', 'UAT', 'Pre-Production', 'Production'];

function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.values(v);
  return [];
}

function varList(list) {
  const out = {};
  for (const v of asArray(list)) {
    if (!v) continue;
    const key = String(v.key || v.id || v.name || '').trim();
    if (!key || SECRET_KEY.test(key)) continue;
    if (v.enabled === false || v.disabled === true) continue;
    const val = v.value === undefined || v.value === null ? '' : String(v.value);
    if (!val || /^\{\{/.test(val)) continue;
    if (SECRET_KEY.test(val) || /^(00D[A-Za-z0-9]{12,15}!|ATATT)/.test(val)) continue;
    out[key] = val;
  }
  return out;
}

function requestUrl(req) {
  if (!req) return '';
  if (typeof req === 'string') return req;
  const u = req.url;
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (u.raw) return u.raw;
  const host = asArray(u.host).join('.');
  const path = asArray(u.path).join('/');
  const proto = u.protocol || 'https';
  if (!host && !path) return '';
  return `${proto}://${host}${path ? (path.startsWith('/') ? path : `/${path}`) : ''}`;
}

function fromV1(col) {
  const folders = asArray(col.folders);
  const requests = asArray(col.requests);
  const byFolder = new Map(folders.map((f) => [f.id || f.name, { name: f.name || 'Folder', item: [] }]));
  const root = [];
  for (const r of requests) {
    const events = [];
    if (r.preRequestScript) events.push({ listen: 'prerequest', script: { exec: String(r.preRequestScript).split('\n') } });
    if (r.tests) events.push({ listen: 'test', script: { exec: String(r.tests).split('\n') } });
    let body;
    if (r.dataMode === 'raw' || r.rawModeData) body = { mode: 'raw', raw: r.rawModeData || r.data || '' };
    else if (r.dataMode === 'urlencoded' || r.dataMode === 'params') body = { mode: 'urlencoded', urlencoded: asArray(r.data) };
    else if (r.dataMode === 'binary' || r.dataMode === 'file') body = { mode: 'file', file: r.data || r.rawModeData };
    else if (Array.isArray(r.data) && r.dataMode === 'formdata') body = { mode: 'formdata', formdata: r.data };
    else if (r.data) body = { mode: 'raw', raw: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
    const item = {
      name: r.name || r.id || 'Request',
      request: {
        method: r.method || 'GET',
        header: typeof r.headers === 'string'
          ? r.headers.split(/\r?\n/).map((line) => {
            const i = line.indexOf(':');
            return i > 0 ? { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : null;
          }).filter(Boolean)
          : asArray(r.header || r.headers),
        url: r.url || r.path || '',
        description: r.description || '',
        body,
        auth: r.auth || undefined,
      },
      event: events,
      response: asArray(r.responses || r.response),
    };
    const folder = r.folder && byFolder.get(r.folder);
    if (folder) folder.item.push(item);
    else root.push(item);
  }
  return {
    info: { name: col.name || col.info && col.info.name || 'Imported collection', description: col.description || '', schema: SCHEMA },
    variable: col.variables || col.variable || [],
    item: [...byFolder.values()].filter((f) => f.item.length).concat(root),
  };
}

/**
 * Accept v1, v2, v2.1, `{ collection }`, `{ collections: [] }`, or a raw `item` array.
 */
function normalizeCollection(raw) {
  let col = raw;
  if (typeof col === 'string') {
    try { col = JSON.parse(col); } catch (e) {
      throw new Error(`Collection is not valid JSON: ${e.message}`);
    }
  }
  if (!col || typeof col !== 'object') throw new Error('Not a Postman collection.');
  if (col.environment && col.collection) {
    const envVars = varList(col.environment.values || col.environment.variable);
    col = col.collection;
    col.variable = [...asArray(col.variable), ...Object.entries(envVars).map(([key, value]) => ({ key, value }))];
  }
  if (Array.isArray(col.collections) && col.collections.length) {
    col = col.collections.reduce((best, c) => (asArray((c.item || c.requests)).length > asArray((best.item || best.requests)).length ? c : best), col.collections[0]);
  }
  if (col.collection && (col.collection.info || col.collection.item)) col = col.collection;
  if (col.requests && !col.item) col = fromV1(col);
  if (!col.info && Array.isArray(col.item)) col = { info: { name: 'Imported collection', schema: SCHEMA }, item: col.item, variable: col.variable || [] };
  if (!col.info && col.name && (col.folders || col.requests)) col = fromV1(col);
  if (!col.info || !Array.isArray(col.item)) {
    throw new Error('Not a Postman collection: export Collection v1, v2, or v2.1 JSON (or a Postman API dump).');
  }
  if (!col.info.schema) col.info.schema = SCHEMA;
  return col;
}

function extractsFromScript(code) {
  const out = [];
  const seen = new Set();
  const src = String(code || '');
  const setRx = /pm\.(?:collectionVariables|environment|variables)\.set\(\s*['"]([A-Za-z_][\w]*)['"]\s*,\s*(.*?)\s*\);/gs;
  const jsonPathFromExpr = (expr) => {
    const e = String(expr || '').trim();
    let m = e.match(/^(?:jsonData|json|body|data)\.([A-Za-z0-9_.'"[\]$]+)/);
    if (m) return '$.' + m[1].replace(/\['([^']+)'\]|\["([^"]+)"\]/g, (_, a, b) => `.${a || b}`).replace(/\[(\d+)\]/g, '.$1');
    m = e.match(/pm\.response\.json\(\)\.([A-Za-z0-9_.'"[\]$]+)/);
    if (m) return '$.' + m[1].replace(/\['([^']+)'\]|\["([^"]+)"\]/g, (_, a, b) => `.${a || b}`);
    m = e.match(/^(?:jsonData|json|body)\[['\"](\w+)['\"]\]/);
    if (m) return '$.' + m[1];
    return null;
  };
  for (const m of src.matchAll(setRx)) {
    const path = jsonPathFromExpr(m[2]);
    if (!path || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ var: m[1], path });
  }
  return out;
}

function collectionVariables(col, extraEnv) {
  return {
    ...varList(col.variable),
    ...varList(col.variables),
    ...(extraEnv ? varList(extraEnv.values || extraEnv.variable || extraEnv) : {}),
  };
}

function firstHostFromText(text) {
  const m = String(text || '').match(/https?:\/\/([a-z0-9.-]+)/i);
  return m ? m[0].replace(/\/$/, '') : '';
}

function walkRequestUrls(items, out = []) {
  for (const it of items || []) {
    if (it.item) walkRequestUrls(it.item, out);
    else if (it.request) out.push(requestUrl(typeof it.request === 'string' ? { url: it.request } : it.request));
  }
  return out;
}

function detectHints(col, drafts = [], extraEnv) {
  const vars = collectionVariables(col, extraEnv);
  const blob = JSON.stringify({ info: col.info, vars, item: col.item, drafts: drafts.map((d) => d.endpoint) });
  const name = String((col.info && col.info.name) || 'Imported collection').replace(/\s+[—\-]\s+Salesforce API tests.*$/i, '').trim();
  let environment = vars.environment;
  if (!ENV_WORDS.includes(environment)) {
    environment = ENV_WORDS.find((e) => new RegExp(`\\b${e}\\b`, 'i').test(`${name} ${blob}`)) || 'UAT';
  }
  const apiFromPath = blob.match(/\/services\/data\/v(\d{2}\.0)\b/);
  const apiVersion = /^\d{2}\.0$/.test(String(vars.apiVersion || '')) ? vars.apiVersion : (apiFromPath ? apiFromPath[1] : '62.0');
  const orgId = vars.organization_id || vars.organizationId || vars.ccOrgId
    || (/^00D/i.test(String(vars.orgId || '')) ? vars.orgId : (vars.orgId && !/^https?:/i.test(String(vars.orgId)) ? vars.orgId : ''));
  const requestUrls = walkRequestUrls(col.item);
  const urls = [
    vars.baseUrl, vars.instanceUrl, vars.loginUrl, vars.host, vars.url, vars.apiUrl,
    ...requestUrls,
    ...drafts.map((d) => d.endpoint),
    firstHostFromText(col.info && col.info.description),
  ].filter(Boolean);
  let instanceUrl = '';
  let kind = 'http';
  for (const u of urls) {
    const raw = String(u || '');
    const originMatch = raw.match(/^(https?:\/\/[A-Za-z0-9.-]+(?::\d+)?)/i);
    if (/\{\{/.test(raw) && !originMatch) continue;
    const abs = originMatch ? originMatch[1]
      : (/^https?:\/\//i.test(raw) ? raw : (vars.baseUrl && /^https?:\/\//i.test(vars.baseUrl) && !/\{\{/.test(String(vars.baseUrl)) ? String(vars.baseUrl).replace(/\/$/, '') + (raw.startsWith('/') ? raw : '') : ''));
    if (!abs && !/^https?:\/\//i.test(raw)) continue;
    const classified = classifyLoginUrl(abs || raw);
    const origin = salesforceLoginOrigin(classified.origin || abs || raw);
    if (origin && !instanceUrl) {
      instanceUrl = origin;
      kind = classified.kind === 'sfcc' ? 'sfcc' : 'core';
    }
  }
  const httpBaseUrl = inferHttpOrigin({ variables: vars, urls }) || '';
  const auth = detectAuth(col);
  let host = '';
  try { host = instanceUrl ? new URL(instanceUrl).hostname : (httpBaseUrl ? new URL(httpBaseUrl).hostname : ''); } catch { host = ''; }
  const sfOrg = vars.sfOrg || vars.orgAlias || (host && /\.my\.salesforce\.com$/i.test(host) ? host.split('.')[0] : '');
  const credentialRef = String(sfOrg || host.split('.')[0] || name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32).toUpperCase() || 'IMPORTED';
  const text = `${name} ${blob}`;
  let orgKind = ORG_KIND.HTTP;
  if (kind === 'sfcc') {
    orgKind = inferSfccChannel({ host, name, siteId: vars.siteId || vars.ccSiteId, blob: text }) === 'b2b' ? ORG_KIND.SFCC_B2B : ORG_KIND.SFCC_B2C;
  } else if (kind === 'core') {
    const ch = inferChannelFromText(text);
    if (/sfcc|demandware|commercecloud|ocapi|scapi/i.test(text) && !/\.my\.salesforce\.com/i.test(host)) {
      orgKind = ch === 'b2b' ? ORG_KIND.SFCC_B2B : ORG_KIND.SFCC_B2C;
    } else if (ch === 'b2c' && /experience|community|d2c|webstore/i.test(text)) {
      orgKind = ORG_KIND.EXPERIENCE_B2C;
    } else if (ch === 'b2b' || /webstore|b2b commerce|experience cloud/i.test(text)) {
      orgKind = ch === 'b2c' ? ORG_KIND.EXPERIENCE_B2C : ORG_KIND.EXPERIENCE_B2B;
    } else {
      orgKind = ORG_KIND.CORE;
    }
  }
  return {
    name: name || 'Imported collection',
    environment,
    apiVersion,
    instanceUrl: instanceUrl || null,
    httpBaseUrl: httpBaseUrl || null,
    sfOrg: sfOrg || '',
    orgId: orgId || '',
    kind,
    orgKind,
    uid: (col.info && (col.info._postman_id || col.info.uid)) || '',
    variables: vars,
    credentialRef,
    needsBearer: auth.needsBearer,
    leakedToken: auth.leakedToken,
    description: `Imported from Postman collection “${(col.info && col.info.name) || name}”.`,
  };
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function asOrigin(value) {
  const s = String(value || '').trim().replace(/\/$/, '');
  if (!s || /\{\{/.test(s)) return '';
  const href = /^https?:\/\//i.test(s) ? s : (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/i.test(s) ? `https://${s}` : '');
  if (!href) return '';
  try { return new URL(href).origin; } catch { return ''; }
}

function isSalesforceHost(origin) {
  return /salesforce\.com|force\.com|demandware|commercecloud/i.test(String(origin || ''));
}

function inferHttpOrigin({ variables = {}, urls = [] } = {}) {
  for (const key of ['httpBaseUrl', 'baseUrl', 'url', 'apiUrl', 'api_url', 'host', 'origin', 'serviceUrl', 'bffUrl']) {
    const origin = asOrigin(variables[key]);
    if (origin && !isSalesforceHost(origin)) return origin;
  }
  const counts = new Map();
  for (const u of urls) {
    const raw = String(u || '');
    const abs = raw.replace(/^\{\{[^}]+\}\}/, '');
    if (!/^https?:\/\//i.test(abs) && !/^https?:\/\//i.test(raw)) continue;
    const origin = asOrigin(/^https?:\/\//i.test(raw) ? raw : abs);
    if (!origin || isSalesforceHost(origin)) continue;
    counts.set(origin, (counts.get(origin) || 0) + 1);
  }
  let best = '', n = 0;
  for (const [origin, c] of counts) if (c > n) { best = origin; n = c; }
  return best;
}

function detectAuth(col) {
  let needsBearer = false;
  let leakedToken = '';
  const consider = (auth, headers) => {
    const type = String((auth && auth.type) || '');
    if (/bearer|oauth2|apikey|jwt/i.test(type)) needsBearer = true;
    for (const row of asArray(auth && (auth.bearer || auth.oauth2 || auth.apikey))) {
      const val = String((row && row.value) || '');
      if (/token|key|access/i.test(String((row && row.key) || 'token')) && val && !/\{\{/.test(val) && val.length > 16) leakedToken = leakedToken || val.replace(/^Bearer\s+/i, '');
    }
    for (const h of asArray(headers)) {
      if (!h || !/^authorization$/i.test(h.key) || h.disabled) continue;
      needsBearer = true;
      const val = String(h.value || '');
      if (/^Bearer\s+\S+/i.test(val) && !/\{\{/.test(val)) leakedToken = leakedToken || val.replace(/^Bearer\s+/i, '');
    }
  };
  consider(col && col.auth, []);
  const walk = (items) => {
    for (const it of items || []) {
      if (it.item) walk(it.item);
      else if (it.request && typeof it.request === 'object') consider(it.request.auth || (col && col.auth), it.request.header);
    }
  };
  walk(col && col.item);
  if (leakedToken.length < 16) leakedToken = '';
  return { needsBearer, leakedToken };
}

function persistHttpOrigin(project, origin) {
  if (!project || !origin) return project;
  const prev = ((project.integrationConfig || {}).http || {}).baseUrl;
  if (prev) return project;
  const { repo, now } = require('../db');
  const ic = { ...(project.integrationConfig || {}) };
  ic.http = {
    ...(ic.http || {}),
    baseUrl: String(origin).replace(/\/$/, ''),
    credentialRef: (ic.http && ic.http.credentialRef) || project.credentialRef,
  };
  repo.update('projects', project.id, { integrationConfig: ic, updatedAt: now() });
  project.integrationConfig = ic;
  return project;
}

function httpSecretPairs(project, { token, baseUrl } = {}) {
  const { normRef } = require('../config');
  const ref = normRef(((project.integrationConfig || {}).http || {}).credentialRef || project.credentialRef);
  const prefix = ref ? `HTTP_${ref}_` : 'HTTP_';
  const pairs = {};
  if (token) pairs[`${prefix}TOKEN`] = token;
  if (baseUrl) pairs[`${prefix}BASE_URL`] = String(baseUrl).replace(/\/$/, '');
  return pairs;
}

function inferHttpOriginForProject(project, testCases = []) {
  const tdv = ((project.testDataConfig || {}).variables) || {};
  const pm = ((project.integrationConfig || {}).postman || {}).variables || {};
  const configured = ((project.integrationConfig || {}).http || {}).baseUrl;
  if (configured) return String(configured).replace(/\/$/, '');
  let origin = inferHttpOrigin({ variables: { ...pm, ...tdv }, urls: testCases.map((t) => t.endpoint) });
  if (origin) return origin;
  try {
    const { repo } = require('../db');
    const stored = repo.find('collections', 'projectId = $p', { p: project.id });
    for (const row of stored) {
      const col = row.content;
      if (!col || !col.item) continue;
      origin = inferHttpOrigin({ variables: collectionVariables(col), urls: walkRequestUrls(col.item) });
      if (origin) return origin;
    }
  } catch { /* collections table optional during unit tests */ }
  return '';
}

function matchProject(hints, projects) {
  let best = null;
  let bestScore = 0;
  const hintKind = hints.orgKind || (hints.kind === 'sfcc' ? ORG_KIND.SFCC_B2C : hints.kind === 'core' ? ORG_KIND.CORE : ORG_KIND.HTTP);
  for (const p of projects || []) {
    if (!p || p.status === 'archived') continue;
    const pKind = projectOrgKind(p);
    if (!kindsCompatible(hintKind, pKind)) continue;
    let score = 0;
    const det = (p.integrationConfig && p.integrationConfig.salesforceDetection) || {};
    const tdv = (p.testDataConfig && p.testDataConfig.variables) || {};
    const pm = (p.integrationConfig && p.integrationConfig.postman) || {};
    if (hints.uid && (p.postmanCollection === hints.uid || pm.collectionId === hints.uid)) score += 80;
    if (hints.instanceUrl && hostOf(p.instanceUrl) && hostOf(p.instanceUrl) === hostOf(hints.instanceUrl)) score += 50;
    if (hints.orgId && [det.orgId, tdv.organization_id, tdv.organizationId, tdv.orgId].includes(hints.orgId)) score += 45;
    if (hints.sfOrg && p.sfOrg && String(p.sfOrg).toLowerCase() === String(hints.sfOrg).toLowerCase()) score += 25;
    const pn = String(p.name || '').toLowerCase();
    const hn = String(hints.name || '').toLowerCase();
    if (pn && hn && pn === hn) score += 30;
    else if (pn && hn && (pn.includes(hn) || hn.includes(pn))) score += 12;
    if (hints.environment && p.environment === hints.environment) score += 6;
    const httpHost = hostOf(((p.integrationConfig || {}).http || {}).baseUrl);
    if (hints.httpBaseUrl && httpHost && httpHost === hostOf(hints.httpBaseUrl)) score += 40;
    if (hintKind && pKind && hintKind === pKind && hintKind !== ORG_KIND.HTTP) score += 35;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 20 ? { project: best, score: bestScore } : { project: null, score: bestScore };
}

function projectPayload(hints) {
  const variables = { ...(hints.variables || {}) };
  if (hints.orgId) {
    variables.organization_id = variables.organization_id || hints.orgId;
    variables.organizationId = variables.organizationId || hints.orgId;
    if (!variables.orgId || /^00D/i.test(String(hints.orgId))) variables.orgId = variables.orgId || hints.orgId;
  }
  const orgKind = hints.orgKind || (hints.kind === 'sfcc' ? ORG_KIND.SFCC_B2C : hints.kind === 'core' ? ORG_KIND.CORE : ORG_KIND.HTTP);
  const ic = {
    orgKind,
    postman: { reuseExisting: true },
    http: {
      credentialRef: hints.credentialRef || undefined,
      ...(hints.httpBaseUrl ? { baseUrl: hints.httpBaseUrl } : {}),
      ...(hints.needsBearer ? { needsBearer: true } : {}),
    },
  };
  ic.salesforceDetection = {
    orgId: hints.orgId || undefined,
    connected: false,
    loginKind: orgKind.startsWith('sfcc') ? 'sfcc' : (hints.kind === 'core' ? 'core' : null),
    types: typesForOrgKind(orgKind),
    orgKind,
  };
  if (orgKind.startsWith('experience')) {
    ic.experience = { enabled: true, channel: orgKind === ORG_KIND.EXPERIENCE_B2C ? 'b2c' : 'b2b', sites: [], stores: [] };
  }
  if (orgKind.startsWith('sfcc') || hints.kind === 'sfcc') {
    ic.commerce = {
      enabled: true,
      channel: orgKind === ORG_KIND.SFCC_B2B ? 'b2b' : 'b2c',
      host: hostOf(hints.instanceUrl),
      ...(hints.orgId && !/^00D/i.test(String(hints.orgId)) ? { orgId: hints.orgId } : {}),
    };
  }
  return {
    name: hints.name,
    description: hints.description,
    environment: ENV_WORDS.includes(hints.environment) ? hints.environment : 'UAT',
    apiVersion: /^\d{2}\.0$/.test(String(hints.apiVersion || '')) ? hints.apiVersion : '62.0',
    instanceUrl: orgKind === ORG_KIND.HTTP ? null : (salesforceLoginOrigin(hints.instanceUrl) || null),
    sfOrg: hints.sfOrg || null,
    mode: hints.instanceUrl ? 'live' : 'live',
    credentialRef: /^[A-Za-z0-9_]{1,40}$/.test(hints.credentialRef || '') ? hints.credentialRef : 'IMPORTED',
    testDataConfig: { autoCleanup: true, variables },
    integrationConfig: ic,
    businessConfig: { slaMs: 2000 },
  };
}

module.exports = {
  SCHEMA, normalizeCollection, collectionVariables, extractsFromScript,
  detectHints, matchProject, projectPayload, varList, requestUrl,
  inferHttpOrigin, inferHttpOriginForProject, persistHttpOrigin, detectAuth, asOrigin, httpSecretPairs,
};
