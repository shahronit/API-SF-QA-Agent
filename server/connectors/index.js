'use strict';
const { SalesforceConnector, ConnectorError } = require('./salesforce');
const { DemoSalesforce } = require('./demo-salesforce');
const { SalesforceMcpAdapter, HybridSalesforce, mcpSettings } = require('./salesforce-mcp');
const { SalesforceCliAdapter } = require('./salesforce-cli');
const { classifyLoginUrl, loginPlan } = require('./salesforce-org');
const { JiraConnector } = require('./jira');
const { DemoJira } = require('./demo-jira');
const { CommerceCloudConnector } = require('./commerce-cloud');
const { DemoCommerce } = require('./demo-commerce');
const { postmanFor } = require('./postman');
const { httpFor } = require('./http');
const { cursorFor } = require('./cursor-cli');
const { geminiFor } = require('./gemini-cli');

function salesforceFor(project) {
  if (project.mode === 'demo') return new DemoSalesforce(project);
  const rest = new SalesforceConnector(project);
  const mcp = new SalesforceMcpAdapter(project);
  const cli = new SalesforceCliAdapter(project);
  if (mcp.available || cli.available) return new HybridSalesforce(rest, mcp, cli);
  return rest;
}

function jiraFor(project) {
  return project.mode === 'demo' ? new DemoJira(project) : new JiraConnector(project);
}

function commerceEnabled(project) {
  const c = (project.integrationConfig && project.integrationConfig.commerce) || {};
  if (c.enabled === false) return false;
  if (c.enabled === true) return true;
  return Boolean(c.host || c.shortCode || c.orgId || c.siteId);
}

function commerceFor(project) {
  if (project.mode === 'demo') {
    if (!commerceEnabled(project)) {
      return {
        available: false,
        kind: 'commerce-off',
        project,
        unavailableExplanation() {
          return {
            code: 'COMMERCE_OFF',
            title: 'Commerce Cloud is not enabled on this project.',
            cause: 'OCAPI/SCAPI tests need a storefront connection.',
            action: 'Open Connections → Salesforce Commerce Cloud, enable it, set site/org/short code, then Test connections.',
            category: 'configuration',
            evidence: [],
          };
        },
        async testConnection() { return { ok: false, ...this.unavailableExplanation() }; },
        async request() { const { ConnectorError } = require('./salesforce'); throw new ConnectorError(this.unavailableExplanation()); },
      };
    }
    return new DemoCommerce(project);
  }
  return new CommerceCloudConnector(project);
}

function isCommerceRequest(req = {}) {
  const t = String(req.apiType || '');
  const p = String(req.path || req.endpoint || '');
  return /^(OCAPI|SCAPI|Commerce Cloud)$/i.test(t)
    || /\/dw\/(shop|data)\//.test(p)
    || /shopper-(products|search|baskets|auth)/.test(p)
    || /commercecloud\.salesforce\.com/.test(p)
    || /demandware\.(net|com)/.test(p)
    || /\/dw\/oauth2\//.test(p);
}

function isSalesforceRequest(req = {}) {
  const p = String(req.path || req.endpoint || '');
  if (isCommerceRequest(req)) return false;
  return /\/services\/(data|apexrest|Soap|oauth2|async)/i.test(p)
    || /^\/(sobjects|query|queryAll|composite|connect|commerce|graphql|jobs|tooling|limits)\b/i.test(p)
    || /\/connect\/communities/i.test(p)
    || /\/commerce\/webstores/i.test(p)
    || (/my\.salesforce\.com|lightning\.force\.com/.test(p) && /\/services\//.test(p));
}

function isHttpRequest(req = {}) {
  if (isCommerceRequest(req) || isSalesforceRequest(req)) return false;
  const t = String(req.apiType || '');
  if (/^(HTTP|Postman)$/i.test(t)) return true;
  const p = String(req.path || req.endpoint || '');
  if (/^https?:\/\//i.test(p)) return true;
  const tags = req.tags || [];
  return tags.includes('frontend') || tags.includes('http-smoke');
}

function connectorFor(project, req) {
  if (isCommerceRequest(req)) return commerceFor(project);
  if (isHttpRequest(req)) return httpFor(project);
  return salesforceFor(project);
}

function metadataLabel(project) {
  return project.mode === 'demo' ? 'ASSUMED' : 'VERIFIED';
}

module.exports = {
  salesforceFor, jiraFor, commerceFor, connectorFor, isCommerceRequest, isSalesforceRequest, isHttpRequest, commerceEnabled,
  postmanFor, httpFor, cursorFor, geminiFor, metadataLabel, ConnectorError, mcpSettings,
  classifyLoginUrl, loginPlan,
};
