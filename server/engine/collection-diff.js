'use strict';
/**
 * Compare an existing Postman collection with required API test coverage.
 * Never invent Salesforce endpoints — keys come from existing collection
 * items and from generated/imported test cases only.
 */
const CANON_VARS = {
  baseUrl: ['salesforceBaseUrl', 'sfBaseUrl', 'instanceUrl', 'orgUrl', 'host'],
  accessToken: ['token', 'sfToken', 'bearerToken', 'oauthToken'],
  apiVersion: ['version', 'sfApiVersion'],
  clientId: ['consumerKey', 'sfClientId'],
  clientSecret: ['consumerSecret', 'sfClientSecret'],
};

function canonicalPath(url) {
  let p = String(url || '');
  p = p.replace(/^https?:\/\/[^/]+/i, '');
  p = p.replace(/^\{\{[^}]+\}\}/, '');
  p = p.replace(/\{\{apiVersion\}\}/g, 'XX.X');
  p = p.replace(/\/services\/data\/v[\d.A-Za-z{}]+/g, '/services/data/vXX.X');
  p = p.replace(/\{\{[^}]+\}\}/g, '{{var}}');
  p = p.split('?')[0];
  p = p.replace(/\/[a-zA-Z0-9]{15,18}(?=\/|$)/g, '/{{id}}');
  p = p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  return p;
}

function requestKey(method, url) {
  return `${String(method || 'GET').toUpperCase()} ${canonicalPath(url)}`;
}

function flattenItems(items, folder = '') {
  const out = [];
  for (const it of items || []) {
    if (it.item) out.push(...flattenItems(it.item, [folder, it.name].filter(Boolean).join(' / ')));
    else out.push({ ...it, folder });
  }
  return out;
}

function itemUrl(it) {
  const r = it.request || {};
  if (typeof r.url === 'string') return r.url;
  return (r.url && r.url.raw) || '';
}

function collectVars(collection, extra = []) {
  const found = [];
  const add = (key, scope) => {
    if (!key) return;
    if (!found.some((v) => v.key === key && v.scope === scope)) found.push({ key, scope });
  };
  for (const v of collection.variable || []) add(v.key, 'collection');
  for (const v of extra) add(v.key || v, v.scope || 'environment');
  const walk = (items) => {
    for (const it of items || []) {
      if (it.item) walk(it.item);
      for (const v of it.variable || []) add(v.key, 'folder');
    }
  };
  walk(collection.item);
  return found;
}

function collectAuth(collection) {
  const kinds = [];
  const push = (auth, where) => {
    if (!auth || !auth.type || auth.type === 'noauth') return;
    kinds.push({ type: auth.type, where });
  };
  push(collection.auth, 'collection');
  for (const it of flattenItems(collection.item)) push((it.request && it.request.auth) || it.auth, it.name);
  return kinds;
}

function indexCollection(collection) {
  const items = flattenItems((collection && collection.item) || []);
  const requests = items.filter((it) => it.request).map((it) => {
    const method = String(it.request.method || 'GET').toUpperCase();
    const url = itemUrl(it);
    const tests = ((it.event || []).find((e) => e.listen === 'test') || {}).script;
    const prereq = ((it.event || []).find((e) => e.listen === 'prerequest') || {}).script;
    const exec = tests ? [].concat(tests.exec || []).join('\n') : '';
    return {
      name: it.name,
      folder: it.folder,
      method,
      url,
      key: requestKey(method, url),
      assertions: (exec.match(/pm\.test\(/g) || []).length,
      hasPrerequest: Boolean(prereq && [].concat(prereq.exec || []).join('').trim()),
      hasAuth: Boolean(it.request.auth && it.request.auth.type && it.request.auth.type !== 'noauth'),
      item: it,
    };
  });
  const byKey = new Map();
  const duplicates = [];
  for (const r of requests) {
    if (byKey.has(r.key)) duplicates.push({ kind: 'DUPLICATE', key: r.key, existing: byKey.get(r.key).name, extra: r.name });
    else byKey.set(r.key, r);
  }
  return {
    name: collection && collection.info && collection.info.name,
    requests,
    byKey,
    duplicates,
    variables: collectVars(collection),
    auth: collectAuth(collection),
  };
}

function requiredFromTests(tests) {
  return (tests || []).map((tc) => ({
    id: tc.id,
    title: tc.title,
    method: String(tc.method || 'GET').toUpperCase(),
    endpoint: tc.endpoint,
    key: requestKey(tc.method, tc.endpoint),
    testType: tc.testType,
    assertions: (tc.assertions || []).length,
    object: tc.object,
    storyKey: tc.storyKey,
    auth: tc.auth,
  }));
}

function aliasFor(proposed) {
  for (const [canonical, aliases] of Object.entries(CANON_VARS)) {
    if (proposed === canonical || aliases.includes(proposed)) return { canonical, aliases: [canonical, ...aliases] };
  }
  return null;
}

function variableWarnings(existingVars, proposedKeys) {
  const have = new Set(existingVars.map((v) => v.key));
  const warnings = [];
  for (const key of proposedKeys) {
    const alias = aliasFor(key);
    if (!alias) continue;
    const found = alias.aliases.find((a) => have.has(a));
    if (found && found !== key) {
      warnings.push({
        kind: 'DUPLICATE_VARIABLE',
        proposed: key,
        reuse: found,
        message: `{{${found}}} already exists. Reuse it instead of creating {{${key}}}.`,
      });
    }
  }
  return warnings;
}

const OBJECT_FOLDERS = { Account: 'Accounts', Contact: 'Contacts', Lead: 'Leads', Opportunity: 'Opportunities' };
function suggestedFolders(tests) {
  const objects = [...new Set((tests || []).map((t) => t.object).filter(Boolean))];
  const folders = ['Authentication'];
  for (const o of objects) folders.push(o.endsWith('__c') ? 'Custom Objects' : (OBJECT_FOLDERS[o] || o));
  if ((tests || []).some((t) => t.testType === 'Negative')) folders.push('Negative Tests');
  if ((tests || []).some((t) => t.testType === 'Regression')) folders.push('Regression');
  return [...new Set(folders)];
}

function diff(collection, tests, envVars = []) {
  const idx = indexCollection(collection || { info: { name: 'empty' }, item: [] });
  const required = requiredFromTests(tests);
  const existing = [];
  const missing = [];
  const changed = [];
  const recommended = [];

  for (const req of required) {
    const hit = idx.byKey.get(req.key);
    if (!hit) {
      missing.push({ kind: 'MISSING', key: req.key, title: req.title, testType: req.testType, method: req.method, endpoint: req.endpoint, testId: req.id });
      continue;
    }
    if (req.assertions > hit.assertions) {
      changed.push({
        kind: 'CHANGED',
        key: req.key,
        title: req.title,
        existingName: hit.name,
        addAssertions: req.assertions - hit.assertions,
        message: `Reuse "${hit.name}" and add ${req.assertions - hit.assertions} missing assertion(s) — do not create a duplicate request.`,
      });
    } else {
      existing.push({ kind: 'EXISTING', key: req.key, title: req.title, existingName: hit.name, folder: hit.folder, testId: req.id });
    }
  }

  const positives = required.filter((r) => r.testType === 'Functional' || !r.testType);
  for (const p of positives) {
    const negKey = p.key;
    const hasNeg = required.some((r) => r.key === negKey && r.testType === 'Negative')
      || idx.requests.some((r) => r.key === negKey && /negative|invalid|without/i.test(r.name));
    if (!hasNeg) {
      recommended.push({
        kind: 'RECOMMENDED',
        key: p.key,
        title: `Negative coverage for ${p.method} ${p.endpoint}`,
        reason: 'Required-field, duplicate, or unauthenticated variants are missing.',
      });
    }
  }

  const proposedVars = ['baseUrl', 'accessToken', 'apiVersion', 'clientId', 'clientSecret'];
  const vars = [...idx.variables, ...envVars.map((k) => ({ key: k, scope: 'environment' }))];
  const warnings = variableWarnings(vars, proposedVars);
  const reuseVars = vars.filter((v) => proposedVars.includes(v.key) || Object.values(CANON_VARS).flat().includes(v.key));

  return {
    collectionName: idx.name || 'Untitled collection',
    summary: {
      existing: existing.length,
      missing: missing.length,
      changed: changed.length,
      duplicate: idx.duplicates.length,
      recommended: recommended.length,
    },
    existing,
    missing,
    changed,
    duplicate: idx.duplicates,
    recommended,
    variables: { found: vars, reuse: reuseVars, warnings },
    auth: idx.auth,
    folders: suggestedFolders(tests),
    changes: [
      ...missing.map((m) => `Add missing request ${m.method} ${m.endpoint}`),
      ...changed.map((c) => `Add ${c.addAssertions} test assertion(s) to ${c.existingName}`),
      idx.auth.length ? 'Reuse existing collection authentication' : 'Add collection authentication (Bearer {{accessToken}})',
      reuseVars.some((v) => v.key === 'accessToken' || v.key === 'baseUrl') ? 'Reuse accessToken / baseUrl' : 'Add standard environment variables (empty secrets)',
    ],
  };
}

function mergeApproved(collection, tests, decision) {
  const { exportCollection } = require('./postman');
  const generated = exportCollection({ name: (collection.info && collection.info.name) || 'Salesforce API tests', environment: 'QA', apiVersion: '62.0', instanceUrl: '', sfOrg: '' }, tests);
  if (!decision || decision.mode === 'replace-missing-only') {
    const idx = indexCollection(collection);
    const extra = flattenItems(generated.item).filter((it) => it.request && !idx.byKey.has(requestKey(it.request.method, itemUrl(it))));
    const byFolder = {};
    for (const it of extra) {
      const folder = it.folder || 'Generated';
      (byFolder[folder] = byFolder[folder] || []).push(it);
    }
    const item = [...(collection.item || [])];
    for (const [folder, items] of Object.entries(byFolder)) {
      const existingFolder = item.find((x) => x.name === folder && Array.isArray(x.item));
      if (existingFolder) existingFolder.item.push(...items);
      else item.push({ name: folder, item: items });
    }
    return { ...collection, item };
  }
  return generated;
}

module.exports = {
  canonicalPath, requestKey, flattenItems, indexCollection, requiredFromTests,
  diff, variableWarnings, suggestedFolders, mergeApproved, CANON_VARS,
};
