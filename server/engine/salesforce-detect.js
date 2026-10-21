'use strict';
/**
 * Classify a connected Salesforce org from real describe / SOQL / host probes.
 * Never invents object, package or site names — missing queries are skipped.
 */
const { classifyLoginUrl, publicDetection, TYPE_CORE, TYPE_EXPERIENCE_B2B, TYPE_B2C, TYPE_SFCC } = require('../connectors/salesforce-org');

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

function classifyFromSignals({ loginKind, catalog, packages, networks, stores, org, host, probe, ambiguous }) {
  const names = nameSet(catalog);
  const products = [];
  const types = [];
  const foundObjects = [...EXPERIENCE_OBJECTS, ...B2B_OBJECTS].filter((n) => names.has(n));

  if (loginKind === 'sfcc') {
    types.push(TYPE_B2C, TYPE_SFCC);
    products.push({ name: 'Salesforce Commerce Cloud', evidence: host ? `host ${host}` : 'SFCC login URL' });
    const reachable = (probe || []).some((c) => c.status && c.status < 500);
    return {
      connected: true,
      loginKind: 'sfcc',
      types,
      products,
      host: host || null,
      instanceUrl: org && org.instanceUrl,
      explanation: reachable
        ? 'This host is Salesforce B2C Commerce / SFCC (Account Manager / Business Manager), not Core CRM. OCAPI and SCAPI testers are auto-connected from the storefront host.'
        : 'The URL is a Commerce Cloud (SFCC) host. Testers are wired for OCAPI/SCAPI. Confirm Business Manager or Account Manager login completed in the browser.',
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
  const hasB2b = B2B_OBJECTS.some((n) => names.has(n)) || (stores || []).length > 0 || pkgHits.includes('B2B Commerce');
  if (hasExperience || hasB2b) {
    types.push(TYPE_EXPERIENCE_B2B);
    if (hasExperience) products.push({ name: 'Experience Cloud', evidence: foundObjects.filter((n) => EXPERIENCE_OBJECTS.includes(n)).join(', ') || 'Network query' });
    if (hasB2b) products.push({ name: 'B2B Commerce', evidence: foundObjects.filter((n) => B2B_OBJECTS.includes(n)).join(', ') || 'WebStore / B2B package' });
  }
  for (const p of packages || []) {
    const kind = packageKind(p);
    if (kind) products.push({ name: p.name || p.namespace, namespace: p.namespace || null, evidence: 'InstalledSubscriberPackage' });
  }

  let explanation;
  if (hasExperience && hasB2b) {
    explanation = 'Core CRM is connected. Experience Cloud sites and B2B Commerce (storefront on Core) were found in org metadata — those testers are auto-connected.';
  } else if (hasExperience) {
    explanation = 'Core CRM is connected. Experience Cloud (Network/Site) is present — Experience testers are auto-connected.';
  } else if (hasB2b) {
    explanation = 'Core CRM is connected. B2B Commerce objects or packages were found — B2B testers are auto-connected.';
  } else if (ambiguous) {
    explanation = 'Logged in to a Salesforce-compatible host. Treated as Core CRM. No Experience Cloud sites, B2B Commerce packages, or SFCC host signals were returned.';
  } else {
    explanation = 'No Experience Cloud sites, B2B Commerce packages, or SFCC host signals were found. Salesforce Core REST/SOAP/Apex testers are connected.';
  }

  return {
    connected: true,
    loginKind: 'core',
    types,
    products,
    sites: (networks || []).map((n) => ({ id: n.Id, name: n.Name, status: n.Status, urlPathPrefix: n.UrlPathPrefix })).filter((s) => s.name || s.id),
    stores: (stores || []).map((s) => ({ id: s.Id, name: s.Name })).filter((s) => s.name || s.id),
    explanation,
    ambiguous: Boolean(ambiguous) && !hasExperience && !hasB2b,
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

async function detectFromConnector(sf, { url, catalog } = {}) {
  const classified = classifyLoginUrl(url || (sf && sf.project && sf.project.instanceUrl) || '');
  if (classified.kind === 'sfcc') {
    const probe = await probeSfccHost(classified.host);
    const base = classifyFromSignals({ loginKind: 'sfcc', host: classified.host, probe, org: { instanceUrl: classified.origin } });
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
  const stores = names.has('WebStore')
    ? await querySafe(sf, 'SELECT Id, Name FROM WebStore LIMIT 50')
    : [];

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

function autoConnectPatch(project, detection) {
  const det = publicDetection(detection) || {};
  const ic = { ...(project.integrationConfig || {}) };
  ic.salesforceDetection = det;
  const patch = { integrationConfig: ic, mode: 'live' };
  if (det.instanceUrl) {
    const { restApiOrigin } = require('../connectors/salesforce-org');
    patch.instanceUrl = restApiOrigin(det.instanceUrl) || det.instanceUrl;
  }
  if (det.alias) patch.sfOrg = det.alias;
  if (det.apiVersion && /^\d{2}(\.0)?$/.test(String(det.apiVersion))) {
    patch.apiVersion = String(det.apiVersion).includes('.') ? String(det.apiVersion) : `${det.apiVersion}.0`;
  }
  if (det.loginKind === 'core') {
    const prev = ic.salesforceCli || {};
    ic.salesforceCli = { enabled: true, bin: prev.bin || 'sf', targetOrg: det.alias || prev.targetOrg || project.sfOrg || '' };
    if (!ic.salesforceSource || ic.salesforceSource === 'mcp') ic.salesforceSource = 'cli';
    ic.experience = {
      enabled: (det.types || []).includes(TYPE_EXPERIENCE_B2B),
      sites: det.sites || [],
      stores: det.stores || [],
    };
  }
  if (det.loginKind === 'sfcc' || (det.types || []).includes(TYPE_SFCC) || (det.types || []).includes(TYPE_B2C)) {
    const prev = ic.commerce || {};
    ic.commerce = {
      ...prev,
      enabled: true,
      host: det.host || prev.host || String(det.instanceUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      siteId: prev.siteId || '',
      orgId: prev.orgId || '',
      shortCode: prev.shortCode || '',
      ocapiVersion: prev.ocapiVersion || 'v24_5',
      credentialRef: prev.credentialRef || project.credentialRef || null,
      sampleProductId: prev.sampleProductId || '',
    };
  }
  const cards = ['Salesforce Core'];
  if ((det.types || []).includes(TYPE_EXPERIENCE_B2B)) cards.push('Experience / B2B Commerce');
  if ((det.types || []).includes(TYPE_B2C) || (det.types || []).includes(TYPE_SFCC)) cards.push('B2C Commerce / SFCC');
  return { patch, cards, detection: det };
}

module.exports = {
  classifyFromSignals, probeSfccHost, detectFromConnector, autoConnectPatch,
  B2B_OBJECTS, EXPERIENCE_OBJECTS, TYPE_CORE, TYPE_EXPERIENCE_B2B, TYPE_B2C, TYPE_SFCC,
};
