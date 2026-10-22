'use strict';
/**
 * Seed run variables from project config, collection import, environments, and the org.
 * {{organization_id}} is an org/collection value — not an upstream extract.
 * SFCC Postman collections use organization_id for the Commerce realm (f_ecom_…),
 * which lives on Connections → Commerce Cloud — not a separate secret.
 */
const DEMO_ORG_ID = '00D5g000000DEMOEAA';
const DEMO_CC_ORG_ID = 'f_ecom_zzte_001';

function isSfOrgId(v) {
  return /^00D[a-zA-Z0-9]{12,15}$/i.test(String(v || ''));
}

function applyOrgId(vars, orgId) {
  if (!orgId) return vars;
  const id = String(orgId);
  vars.organization_id = vars.organization_id || id;
  vars.organizationId = vars.organizationId || id;
  if (!vars.orgId || isSfOrgId(id)) vars.orgId = vars.orgId || id;
  return vars;
}

function commerceCfg(project) {
  return (project && project.integrationConfig && project.integrationConfig.commerce) || {};
}

function isSfccProject(project) {
  const kind = String((project && project.orgKind) || ((project && project.integrationConfig) || {}).orgKind || '');
  const cc = commerceCfg(project);
  return kind.startsWith('sfcc') || Boolean(cc.enabled || cc.orgId || cc.host || cc.shortCode);
}

/** Map Commerce Cloud realm/org ID onto {{organization_id}} / {{organizationId}} / {{ccOrgId}}. */
function applyCommerceOrg(vars, project) {
  if (!vars) return vars;
  const cc = commerceCfg(project);
  const fromVars = vars.ccOrgId
    || (vars.orgId && !isSfOrgId(vars.orgId) ? vars.orgId : '')
    || (vars.organization_id && !isSfOrgId(vars.organization_id) ? vars.organization_id : '')
    || (vars.organizationId && !isSfOrgId(vars.organizationId) ? vars.organizationId : '');
  const commerceId = cc.orgId || fromVars;
  if (!commerceId) return vars;
  vars.ccOrgId = vars.ccOrgId || commerceId;
  const preferCommerce = isSfccProject(project);
  if (!vars.organization_id || (preferCommerce && isSfOrgId(vars.organization_id))) vars.organization_id = commerceId;
  if (!vars.organizationId || (preferCommerce && isSfOrgId(vars.organizationId))) vars.organizationId = commerceId;
  return vars;
}

function seedFromProject(project, extras = {}) {
  const userVars = { ...(((project.testDataConfig || {}).variables) || {}) };
  const det = (project.integrationConfig && project.integrationConfig.salesforceDetection) || {};
  const pm = (project.integrationConfig && project.integrationConfig.postman) || {};
  const pmVars = pm.variables && typeof pm.variables === 'object' ? pm.variables : {};
  const colVars = extras.collectionVars && typeof extras.collectionVars === 'object' ? extras.collectionVars : {};
  const envVars = extras.environmentVars && typeof extras.environmentVars === 'object' ? extras.environmentVars : {};
  const vars = { ...pmVars, ...colVars, ...userVars, ...envVars };
  const orgId = vars.organization_id || vars.organizationId
    || (isSfOrgId(vars.orgId) ? vars.orgId : '')
    || det.orgId || '';
  applyOrgId(vars, orgId);
  applyCommerceOrg(vars, project);
  if (project.mode === 'demo' && !vars.organization_id) {
    applyOrgId(vars, isSfccProject(project) ? DEMO_CC_ORG_ID : DEMO_ORG_ID);
    if (isSfccProject(project)) applyCommerceOrg(vars, project);
  }
  const http = (project.integrationConfig && project.integrationConfig.http) || {};
  if (http.baseUrl && !vars.httpBaseUrl) vars.httpBaseUrl = String(http.baseUrl).replace(/\/$/, '');
  return vars;
}

async function seedOrgFromSalesforce(vars, sf) {
  if (vars.organization_id) return vars;
  if (!sf || !sf.available) return vars;
  try {
    if (typeof sf.orgDisplay === 'function') {
      const d = await sf.orgDisplay();
      if (d && d.orgId) applyOrgId(vars, d.orgId);
    }
  } catch { /* identity is optional; tests still run with collection vars */ }
  return vars;
}

function knownFallback(name, vars, project) {
  if (vars[name] !== undefined && vars[name] !== '') return vars[name];
  const cc = commerceCfg(project);
  const commerceId = cc.orgId || vars.ccOrgId || (!isSfOrgId(vars.orgId) ? vars.orgId : '');
  const orgAlias = vars.organizationId || vars.organization_id || (isSfOrgId(vars.orgId) ? vars.orgId : '') || commerceId;
  const aliases = {
    organization_id: orgAlias,
    organizationId: orgAlias,
    orgId: vars.organization_id || vars.organizationId || vars.orgId || commerceId,
    ccOrgId: vars.ccOrgId || commerceId || vars.organization_id || vars.organizationId,
    ccSiteId: vars.ccSiteId || cc.siteId,
    ccShortCode: vars.ccShortCode || vars.shortCode || cc.shortCode,
    baseUrl: vars.httpBaseUrl || vars.instanceUrl,
    instanceUrl: vars.instanceUrl || vars.baseUrl,
    httpBaseUrl: vars.httpBaseUrl,
    apiVersion: project && project.apiVersion,
  };
  if (aliases[name]) return aliases[name];
  return undefined;
}

async function seedAuthVars(vars, project, sf) {
  const { httpCredentials } = require('../config');
  const ref = ((project.integrationConfig || {}).http || {}).credentialRef || project.credentialRef;
  const creds = httpCredentials(ref);
  if (creds && creds.token) {
    vars.httpToken = creds.token;
    vars.bearerToken = vars.bearerToken || creds.token;
    if (!vars.token) vars.token = creds.token;
  }
  if (creds && creds.baseUrl && !vars.httpBaseUrl) vars.httpBaseUrl = String(creds.baseUrl).replace(/\/$/, '');
  try {
    if (sf && sf.available && typeof sf.token === 'function') {
      const t = await sf.token();
      if (t && t.accessToken) vars.accessToken = t.accessToken;
    }
  } catch { /* Salesforce token is optional for frontend HTTP */ }
  if (!vars.accessToken && creds && creds.token) vars.accessToken = creds.token;
  return vars;
}

module.exports = {
  applyOrgId, applyCommerceOrg, seedFromProject, seedOrgFromSalesforce, seedAuthVars, knownFallback,
  isSfOrgId, DEMO_ORG_ID, DEMO_CC_ORG_ID,
};
