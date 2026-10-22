'use strict';
/**
 * Classify a connected Salesforce org from real describe / SOQL / host probes.
 * Never invents object, package or site names — missing queries are skipped.
 */
const {
  classifyLoginUrl, publicDetection,
  TYPE_CORE, TYPE_EXPERIENCE_B2B, TYPE_EXPERIENCE_B2C, TYPE_SFCC_B2B, TYPE_SFCC_B2C,
  ORG_KIND, SPECIFIC_ORG_KINDS, normalizeTypeLabels, inferChannelFromText, inferSfccChannel,
  typeForOrgKind, typesForOrgKind, orgKindFromTypes, kindsFromTypes, familyOf, kindsCompatible,
  isExperienceType, isSfccType,
} = require('../connectors/salesforce-org');

const B2B_OBJECTS = ['WebStore', 'WebStoreNetwork', 'CommerceEntitlementPolicy', 'BuyerGroup', 'ProductCatalog', 'ccrz__E_Product__c', 'ccrz__E_Cart__c'];
const EXPERIENCE_OBJECTS = ['Network', 'Site', 'NetworkMember'];

function nameSet(catalog) {
  return new Set((catalog || []).map((o) => (typeof o === 'string' ? o : o && o.name)).filter(Boolean));
}

function packageKind(pkg) {
  const blob = `${pkg.name || ''} ${pkg.namespace || ''}`.toLowerCase();
  if (/\bccrz\b|cloudcraze|b2b commerce|b2bce|b2b_storefront/.test(blob)) return 'B2B Commerce';
  if (/\bexperience cloud\b|\bdigital experience\b/.test(blob)) return 'Experience Cloud';
  return null;
}

function storeChannel(store) {
  const type = String((store && (store.Type || store.type)) || '').toUpperCase();
  if (type === 'B2B' || type === 'B2C') return type.toLowerCase();
  return inferChannelFromText((store && (store.Name || store.name)) || '');
}

function classifyFromSignals({ loginKind, catalog, packages, networks, stores, org, host, probe, ambiguous, name, siteId, blob }) {
  const names = nameSet(catalog);
  const products = [];
  const types = [];
  const foundObjects = [...EXPERIENCE_OBJECTS, ...B2B_OBJECTS].filter((n) => names.has(n));
  const mappedStores = (stores || []).map((s) => ({
    id: s.Id || s.id, name: s.Name || s.name, type: s.Type || s.type || null,
  })).filter((s) => s.name || s.id);

  if (loginKind === 'sfcc') {
    const channel = inferSfccChannel({ host, name, siteId, blob });
    const type = channel === 'b2b' ? TYPE_SFCC_B2B : TYPE_SFCC_B2C;
    const orgKind = channel === 'b2b' ? ORG_KIND.SFCC_B2B : ORG_KIND.SFCC_B2C;
    types.push(type);
    products.push({ name: type, evidence: host ? `host ${host}` : 'SFCC login URL' });
    const reachable = (probe || []).some((c) => c.status && c.status < 500);
    return {
      connected: true,
      loginKind: 'sfcc',
      orgKind,
      types,
      products,
      host: host || null,
      instanceUrl: org && org.instanceUrl,
      explanation: reachable
        ? `This host is ${type} (Account Manager / Business Manager), not Core CRM. OCAPI and SCAPI testers are auto-connected from the storefront host. Experience Cloud and SFCC ${channel === 'b2b' ? 'B2C' : 'B2B'} stay on their own projects.`
        : `The URL is a Commerce Cloud (${type}) host. Testers are wired for OCAPI/SCAPI. Confirm Business Manager or Account Manager login completed in the browser.`,
      ambiguous: !reachable,
      probe: probe || [],
      sites: [],
      stores: [],
    };
  }

  types.push(TYPE_CORE);
  products.push({ name: 'Salesforce Core', evidence: 'Identity / org describe' });

  const pkgHits = (packages || []).map(packageKind).filter(Boolean);
  const hasExperience = EXPERIENCE_OBJECTS.some((n) => names.has(n)) || (networks || []).length > 0 || pkgHits.includes('Experience Cloud');
  const b2bObjects = B2B_OBJECTS.filter((n) => n !== 'WebStore' && n !== 'WebStoreNetwork' && names.has(n));
  const hasB2bPackage = pkgHits.includes('B2B Commerce') || b2bObjects.length > 0;
  const storeChannels = new Set(mappedStores.map(storeChannel).filter(Boolean));
  const hasB2bStore = storeChannels.has('b2b') || hasB2bPackage;
  const hasB2cStore = storeChannels.has('b2c');
  const hasWebStore = names.has('WebStore') || mappedStores.length > 0;

  if (hasB2bStore || (hasWebStore && !hasB2cStore && (hasB2bPackage || hasExperience || mappedStores.length))) {
    if (hasB2bStore || hasB2bPackage || (hasWebStore && !hasB2cStore)) types.push(TYPE_EXPERIENCE_B2B);
  }
  if (hasExperience && (hasB2cStore || (!hasWebStore && !hasB2bPackage))) {
    types.push(TYPE_EXPERIENCE_B2C);
  } else if (hasB2cStore) {
    types.push(TYPE_EXPERIENCE_B2C);
  }

  if (types.includes(TYPE_EXPERIENCE_B2B) || types.includes(TYPE_EXPERIENCE_B2C)) {
    if (hasExperience) products.push({ name: 'Experience Cloud', evidence: foundObjects.filter((n) => EXPERIENCE_OBJECTS.includes(n)).join(', ') || 'Network query' });
    if (types.includes(TYPE_EXPERIENCE_B2B)) products.push({ name: TYPE_EXPERIENCE_B2B, evidence: b2bObjects.join(', ') || mappedStores.filter((s) => storeChannel(s) !== 'b2c').map((s) => s.name).join(', ') || 'WebStore / B2B package' });
    if (types.includes(TYPE_EXPERIENCE_B2C)) products.push({ name: TYPE_EXPERIENCE_B2C, evidence: mappedStores.filter((s) => storeChannel(s) === 'b2c').map((s) => s.name).join(', ') || 'Network / D2C WebStore' });
  }
  for (const p of packages || []) {
    const kind = packageKind(p);
    if (kind) products.push({ name: p.name || p.namespace, namespace: p.namespace || null, evidence: 'InstalledSubscriberPackage' });
  }

  const orgKind = orgKindFromTypes(types, 'core') || ORG_KIND.CORE;
  let explanation;
  if (types.includes(TYPE_EXPERIENCE_B2B) && types.includes(TYPE_EXPERIENCE_B2C)) {
    explanation = 'Core CRM is connected. Both Experience Cloud B2B and Experience Cloud B2C storefronts were found — they are separate orgs/projects. This project keeps one channel; the other is created as a sibling project.';
  } else if (types.includes(TYPE_EXPERIENCE_B2B)) {
    explanation = 'Core CRM is connected. Experience Cloud B2B (storefront on Core) was found — those testers are auto-connected. Experience B2C and SFCC stay on their own projects.';
  } else if (types.includes(TYPE_EXPERIENCE_B2C)) {
    explanation = 'Core CRM is connected. Experience Cloud B2C (community / D2C on Core) was found — those testers are auto-connected. Experience B2B and SFCC stay on their own projects.';
  } else if (ambiguous) {
    explanation = 'Logged in to a Salesforce-compatible host. Treated as Core CRM. No Experience Cloud sites, B2B/B2C Commerce packages, or SFCC host signals were returned.';
  } else {
    explanation = 'No Experience Cloud B2B, Experience Cloud B2C, or SFCC host signals were found. Salesforce Core REST/SOAP/Apex testers are connected.';
  }

  return {
    connected: true,
    loginKind: 'core',
    orgKind,
    types: normalizeTypeLabels(types),
    products,
    sites: (networks || []).map((n) => ({ id: n.Id, name: n.Name, status: n.Status, urlPathPrefix: n.UrlPathPrefix })).filter((s) => s.name || s.id),
    stores: mappedStores,
    explanation,
    ambiguous: Boolean(ambiguous) && !hasExperience && !hasWebStore && !hasB2bPackage,
  };
}

async function probeSfccHost(host) {
  const h = String(host || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!h) return [];
  const origin = `https://${h}`;
  const paths = ['/on/demandware.store/Sites-Site', '/s/-/dw/shop/v24_5/'];
  const checks = [];
  for (const p of paths) {
    const url = origin + p;
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Accept: 'text/html, application/json' } });
      checks.push({ path: p, status: res.status });
    } catch {
      checks.push({ path: p, status: null });
    }
  }
  return checks;
}

async function querySafe(sf, soql, extra = {}) {
  if (!sf || typeof sf.query !== 'function') return [];
  try {
    const result = extra.tooling && typeof sf.queryTooling === 'function'
      ? await sf.queryTooling(soql)
      : await sf.query(soql);
    const records = (result && result.records) || (Array.isArray(result) ? result : []);
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

async function detectFromConnector(sf, { url, catalog, name, siteId } = {}) {
  const classified = classifyLoginUrl(url || (sf && sf.project && sf.project.instanceUrl) || '');
  const projectName = name || (sf && sf.project && sf.project.name) || '';
  const commerceSiteId = siteId || ((sf && sf.project && sf.project.integrationConfig && sf.project.integrationConfig.commerce) || {}).siteId || '';
  if (classified.kind === 'sfcc') {
    const probe = await probeSfccHost(classified.host);
    const base = classifyFromSignals({
      loginKind: 'sfcc', host: classified.host, probe, org: { instanceUrl: classified.origin },
      name: projectName, siteId: commerceSiteId,
    });
    return publicDetection({
      ...base,
      instanceUrl: classified.origin,
      host: classified.host,
      detectedAt: new Date().toISOString(),
    });
  }

  let org = {};
  if (sf && typeof sf.orgDisplay === 'function') {
    try { org = await sf.orgDisplay(); } catch { org = {}; }
  } else if (sf && typeof sf.testConnection === 'function') {
    try {
      const t = await sf.testConnection();
      org = { instanceUrl: t.instanceUrl, alias: t.alias, status: t.status, apiVersion: t.latestApiVersion || t.configuredApiVersion };
    } catch { org = {}; }
  }

  let list = catalog;
  if (!list && sf && typeof sf.describeGlobal === 'function') {
    try { list = await sf.describeGlobal(); } catch { list = []; }
  }
  list = list || [];
  const names = nameSet(list);

  const packages = names.size
    ? await querySafe(sf, 'SELECT SubscriberPackage.Name, SubscriberPackage.NamespacePrefix FROM InstalledSubscriberPackage LIMIT 100', { tooling: true })
      .then((rows) => rows.map((r) => ({
        name: (r.SubscriberPackage && r.SubscriberPackage.Name) || r.Name,
        namespace: (r.SubscriberPackage && r.SubscriberPackage.NamespacePrefix) || r.NamespacePrefix,
      })).filter((p) => p.name || p.namespace))
    : [];

  const networks = names.has('Network')
    ? await querySafe(sf, 'SELECT Id, Name, Status, UrlPathPrefix FROM Network LIMIT 50')
    : [];
  let stores = [];
  if (names.has('WebStore')) {
    stores = await querySafe(sf, 'SELECT Id, Name, Type FROM WebStore LIMIT 50');
    if (!stores.length) stores = await querySafe(sf, 'SELECT Id, Name FROM WebStore LIMIT 50');
  }

  let orgName = org.orgName || null;
  let edition = org.edition || null;
  const orgRows = names.has('Organization')
    ? await querySafe(sf, 'SELECT Id, Name, OrganizationType, IsSandbox FROM Organization LIMIT 1')
    : [];
  if (orgRows[0]) {
    orgName = orgRows[0].Name || orgName;
    edition = orgRows[0].OrganizationType || edition;
    if (orgRows[0].IsSandbox !== undefined) org.isSandbox = orgRows[0].IsSandbox;
    if (orgRows[0].Id) org.orgId = org.orgId || orgRows[0].Id;
  }

  const base = classifyFromSignals({
    loginKind: 'core',
    catalog: list,
    packages,
    networks,
    stores,
    org,
    ambiguous: classified.ambiguous,
    name: projectName,
  });
  return publicDetection({
    ...base,
    ...org,
    orgName,
    edition,
    instanceUrl: org.instanceUrl || classified.origin || null,
    host: classified.host || null,
    detectedAt: new Date().toISOString(),
  });
}

function projectOrgKind(project) {
  const ic = (project && project.integrationConfig) || {};
  if (ic.orgKind && (SPECIFIC_ORG_KINDS.has(ic.orgKind) || ic.orgKind === ORG_KIND.CORE || ic.orgKind === ORG_KIND.HTTP)) {
    return ic.orgKind;
  }
  return inferOrgKindFromProject(project);
}

function inferOrgKindFromProject(project) {
  if (!project) return ORG_KIND.CORE;
  const ic = project.integrationConfig || {};
  const det = ic.salesforceDetection || {};
  const fromTypes = orgKindFromTypes(normalizeTypeLabels(det.types), det.loginKind);
  if (fromTypes && fromTypes !== ORG_KIND.CORE) return fromTypes;
  const blob = `${project.name || ''} ${project.description || ''} ${JSON.stringify(ic.commerce || {})} ${JSON.stringify(ic.experience || {})}`;
  const commerceOn = Boolean(ic.commerce && (ic.commerce.enabled === true
    || ((ic.commerce.host || ic.commerce.siteId || ic.commerce.orgId) && !(ic.experience && ic.experience.enabled))));
  const experienceOn = Boolean(ic.experience && ic.experience.enabled);
  if (commerceOn && !experienceOn) {
    return inferSfccChannel({ host: ic.commerce.host, name: project.name, siteId: ic.commerce.siteId, blob }) === 'b2b'
      ? ORG_KIND.SFCC_B2B : ORG_KIND.SFCC_B2C;
  }
  if (experienceOn) {
    const storeChannels = new Set((ic.experience.stores || []).map(storeChannel).filter(Boolean));
    if (storeChannels.has('b2c') && !storeChannels.has('b2b')) return ORG_KIND.EXPERIENCE_B2C;
    if (storeChannels.has('b2b')) return ORG_KIND.EXPERIENCE_B2B;
    return inferChannelFromText(blob, { defaultChannel: 'b2b' }) === 'b2c' ? ORG_KIND.EXPERIENCE_B2C : ORG_KIND.EXPERIENCE_B2B;
  }
  if (det.loginKind === 'sfcc') {
    return inferSfccChannel({ host: det.host, name: project.name, blob }) === 'b2b' ? ORG_KIND.SFCC_B2B : ORG_KIND.SFCC_B2C;
  }
  const ch = inferChannelFromText(blob);
  if (ch === 'b2b' && /commerce|experience|webstore|storefront/i.test(blob) && !/sfcc|demandware|commerce cloud/i.test(blob)) {
    return ORG_KIND.EXPERIENCE_B2B;
  }
  if (ch === 'b2c' && /experience|community|d2c|webstore/i.test(blob) && !/sfcc|demandware|commerce cloud/i.test(blob)) {
    return ORG_KIND.EXPERIENCE_B2C;
  }
  if (/sfcc|demandware|commerce cloud/i.test(blob)) {
    return ch === 'b2b' ? ORG_KIND.SFCC_B2B : ORG_KIND.SFCC_B2C;
  }
  return ORG_KIND.CORE;
}

function applyOrgKindToProject(project, kind) {
  const ic = { ...(project.integrationConfig || {}) };
  const prevKind = ic.orgKind;
  const prevExp = Boolean((ic.experience || {}).enabled);
  const prevCc = (ic.commerce || {}).enabled;
  ic.orgKind = kind;
  const det = { ...(ic.salesforceDetection || {}) };
  det.types = typesForOrgKind(kind);
  det.orgKind = kind;
  if (kind.startsWith('sfcc')) det.loginKind = 'sfcc';
  else if (kind !== ORG_KIND.HTTP) det.loginKind = det.loginKind === 'sfcc' ? 'core' : (det.loginKind || 'core');
  ic.salesforceDetection = det;
  const channel = kind.endsWith('b2c') ? 'b2c' : kind.endsWith('b2b') ? 'b2b' : null;
  if (kind.startsWith('experience')) {
    ic.experience = { ...(ic.experience || {}), enabled: true, channel };
    if (ic.commerce) ic.commerce = { ...ic.commerce, enabled: false };
  } else if (kind.startsWith('sfcc')) {
    ic.commerce = { ...(ic.commerce || {}), enabled: true, channel };
    if (ic.experience) ic.experience = { ...ic.experience, enabled: false };
  } else {
    if (ic.experience) ic.experience = { ...ic.experience, enabled: false };
    if (ic.commerce) ic.commerce = { ...ic.commerce, enabled: false };
  }
  const changed = prevKind !== kind || prevExp !== Boolean((ic.experience || {}).enabled)
    || prevCc !== (ic.commerce || {}).enabled
    || JSON.stringify(((project.integrationConfig || {}).salesforceDetection || {}).types) !== JSON.stringify(det.types);
  return { ic, changed, kind };
}

function pickPrimaryKind(project, kinds) {
  const current = projectOrgKind(project);
  if (kinds.includes(current)) return current;
  const named = inferChannelFromText(`${project.name || ''} ${project.description || ''}`);
  if (named === 'b2b' && kinds.includes(ORG_KIND.EXPERIENCE_B2B)) return ORG_KIND.EXPERIENCE_B2B;
  if (named === 'b2c' && kinds.includes(ORG_KIND.EXPERIENCE_B2C)) return ORG_KIND.EXPERIENCE_B2C;
  if (named === 'b2b' && kinds.includes(ORG_KIND.SFCC_B2B)) return ORG_KIND.SFCC_B2B;
  if (named === 'b2c' && kinds.includes(ORG_KIND.SFCC_B2C)) return ORG_KIND.SFCC_B2C;
  return kinds.find((k) => SPECIFIC_ORG_KINDS.has(k)) || kinds[0] || ORG_KIND.CORE;
}

function autoConnectPatch(project, detection) {
  const det = publicDetection(detection) || {};
  det.types = normalizeTypeLabels(det.types);
  const detectedKinds = kindsFromTypes(det.types, det.loginKind);
  const detectedKind = det.orgKind || pickPrimaryKind(project, detectedKinds);
  det.orgKind = detectedKind;
  const currentKind = projectOrgKind(project);
  if (SPECIFIC_ORG_KINDS.has(currentKind) && SPECIFIC_ORG_KINDS.has(detectedKind)
      && currentKind !== detectedKind && !detectedKinds.includes(currentKind)
      && familyOf(currentKind) !== familyOf(detectedKind)) {
    return { patch: {}, cards: [], detection: det, skipped: 'org-kind-mismatch' };
  }
  const kind = (SPECIFIC_ORG_KINDS.has(currentKind) && detectedKinds.includes(currentKind))
    ? currentKind
    : detectedKind;
  const applied = applyOrgKindToProject({ ...project, integrationConfig: { ...(project.integrationConfig || {}), salesforceDetection: det } }, kind);
  const ic = applied.ic;
  ic.salesforceDetection = { ...det, types: typesForOrgKind(kind), orgKind: kind };
  const patch = { integrationConfig: ic, mode: 'live' };
  if (det.instanceUrl && !kind.startsWith('sfcc')) {
    const { restApiOrigin } = require('../connectors/salesforce-org');
    patch.instanceUrl = restApiOrigin(det.instanceUrl) || det.instanceUrl;
  } else if (det.instanceUrl && kind.startsWith('sfcc')) {
    patch.instanceUrl = det.instanceUrl;
  }
  if (det.alias) patch.sfOrg = det.alias;
  if (det.apiVersion && /^\d{2}(\.0)?$/.test(String(det.apiVersion))) {
    patch.apiVersion = String(det.apiVersion).includes('.') ? String(det.apiVersion) : `${det.apiVersion}.0`;
  }
  if (kind.startsWith('experience') || kind === ORG_KIND.CORE) {
    const prev = ic.salesforceCli || {};
    ic.salesforceCli = { enabled: true, bin: prev.bin || 'sf', targetOrg: det.alias || prev.targetOrg || project.sfOrg || '' };
    if (!ic.salesforceSource || ic.salesforceSource === 'mcp') ic.salesforceSource = 'cli';
    if (kind.startsWith('experience')) {
      ic.experience = {
        ...(ic.experience || {}),
        enabled: true,
        channel: kind === ORG_KIND.EXPERIENCE_B2C ? 'b2c' : 'b2b',
        sites: det.sites || (ic.experience && ic.experience.sites) || [],
        stores: (det.stores || []).filter((s) => {
          const ch = storeChannel(s);
          if (kind === ORG_KIND.EXPERIENCE_B2B) return ch !== 'b2c';
          if (kind === ORG_KIND.EXPERIENCE_B2C) return ch !== 'b2b';
          return true;
        }),
      };
    }
  }
  if (kind.startsWith('sfcc')) {
    const prev = ic.commerce || {};
    ic.commerce = {
      ...prev,
      enabled: true,
      channel: kind === ORG_KIND.SFCC_B2B ? 'b2b' : 'b2c',
      host: det.host || prev.host || String(det.instanceUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      siteId: prev.siteId || '',
      orgId: prev.orgId || '',
      shortCode: prev.shortCode || '',
      ocapiVersion: prev.ocapiVersion || 'v24_5',
      credentialRef: prev.credentialRef || project.credentialRef || null,
      sampleProductId: prev.sampleProductId || '',
    };
  }
  const cards = kind.startsWith('sfcc') ? [typeForOrgKind(kind)] : ['Salesforce Core'];
  if (kind.startsWith('experience')) cards.push(typeForOrgKind(kind));
  return { patch, cards, detection: ic.salesforceDetection, extraKinds: detectedKinds.filter((k) => k !== kind && SPECIFIC_ORG_KINDS.has(k)) };
}

function stripKindSuffix(name) {
  return String(name || '').replace(/\s+[—\-]\s+(Experience Cloud B2[BC]|SFCC B2[BC]|Salesforce Core)\s*$/i, '').trim();
}

function siblingName(project, kind) {
  const base = stripKindSuffix(project.name) || project.name || 'Salesforce';
  return `${base} — ${typeForOrgKind(kind)}`;
}

function ensureOrgKindSiblings(project, detection, extraKinds) {
  const extra = [...new Set([
    ...(extraKinds || []),
    ...kindsFromTypes((detection && detection.types) || [], detection && detection.loginKind),
  ])].filter((k) => SPECIFIC_ORG_KINDS.has(k) && k !== projectOrgKind(project));
  if (!extra.length) return [];
  let repo;
  let nextId;
  let now;
  try {
    ({ repo, nextId, now } = require('../db'));
  } catch { return []; }
  const existing = repo.find('projects', "status != 'archived'") || [];
  const created = [];
  for (const kind of extra) {
    const already = existing.find((p) => projectOrgKind(p) === kind && (
      (project.instanceUrl && p.instanceUrl && String(p.instanceUrl).replace(/\/$/, '') === String(project.instanceUrl).replace(/\/$/, ''))
      || (p.name === siblingName(project, kind))
    ));
    if (already) continue;
    const applied = applyOrgKindToProject({
      ...project,
      id: undefined,
      name: siblingName(project, kind),
      integrationConfig: { ...(project.integrationConfig || {}) },
    }, kind);
    const row = {
      id: nextId('PRJ', 3),
      name: siblingName(project, kind),
      description: `${typeForOrgKind(kind)} workspace split from ${project.name}. Experience B2B, Experience B2C, SFCC B2B and SFCC B2C are separate orgs.`,
      environment: project.environment,
      instanceUrl: kind.startsWith('sfcc') ? (detection.host ? `https://${detection.host}` : project.instanceUrl) : project.instanceUrl,
      sfOrg: project.sfOrg,
      apiVersion: project.apiVersion || '62.0',
      mode: project.mode || 'live',
      credentialRef: project.credentialRef,
      jiraProjectKey: project.jiraProjectKey,
      jiraUrl: project.jiraUrl,
      jiraCredentialRef: project.jiraCredentialRef,
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
      testDataConfig: project.testDataConfig || { autoCleanup: true, variables: {} },
      integrationConfig: applied.ic,
      businessConfig: project.businessConfig || { slaMs: 2000 },
    };
    repo.insert('projects', row);
    existing.push(row);
    created.push({ id: row.id, name: row.name, orgKind: kind });
  }
  return created;
}

function retagExistingProjects() {
  let repo;
  let now;
  try {
    ({ repo, now } = require('../db'));
  } catch { return []; }
  const updated = [];
  for (const p of repo.find('projects', "status != 'archived'") || []) {
    const kind = inferOrgKindFromProject(p);
    const applied = applyOrgKindToProject(p, kind);
    if (!applied.changed && p.integrationConfig && p.integrationConfig.orgKind === kind) continue;
    repo.update('projects', p.id, { integrationConfig: applied.ic, updatedAt: now() });
    updated.push({ id: p.id, name: p.name, orgKind: kind });
  }
  return updated;
}

module.exports = {
  classifyFromSignals, probeSfccHost, detectFromConnector, autoConnectPatch,
  projectOrgKind, inferOrgKindFromProject, applyOrgKindToProject,
  ensureOrgKindSiblings, retagExistingProjects, pickPrimaryKind,
  B2B_OBJECTS, EXPERIENCE_OBJECTS,
  TYPE_CORE, TYPE_EXPERIENCE_B2B, TYPE_EXPERIENCE_B2C, TYPE_SFCC_B2B, TYPE_SFCC_B2C,
  ORG_KIND, kindsCompatible, isExperienceType, isSfccType,
};
