'use strict';
/**
 * Configuration loader. Reads `.env` (without overriding real environment
 * variables) and exposes typed settings. Secret values are never exported to
 * API responses — use `credentialStatus()` to report presence only.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Under `node --test` the developer's real credentials and MCP commands must not leak into tests.
if (!process.env.NODE_TEST_CONTEXT && process.env.QA_SKIP_DOTENV !== 'true') loadDotEnv(path.join(ROOT, '.env'));

const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const config = {
  root: ROOT,
  port: Number(env('PORT', '4317')),
  host: env('HOST', '127.0.0.1'),
  dataDir: path.resolve(ROOT, env('DATA_DIR', './data')),
  appUser: env('APP_USER', 'qa.engineer'),
  seedDemo: env('SEED_DEMO', 'false') === 'true',
  jira: {
    sprintField: env('JIRA_SPRINT_FIELD', 'customfield_10020'),
    linkType: env('JIRA_LINK_TYPE', 'Relates'),
    defectIssueType: env('JIRA_DEFECT_ISSUE_TYPE', 'Bug'),
  },
  ai: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('AI_MODEL'),
  },
  environments: ['Development', 'QA', 'SIT', 'UAT', 'Pre-Production', 'Production'],
  version: '1.0.0',
};

config.ai.enabled = Boolean(config.ai.apiKey && config.ai.model);

/** Normalise a credential prefix to an env-var-safe token. */
function normRef(ref) {
  return String(ref || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Read Salesforce credentials for a prefix. Returns null if not configured. */
function salesforceCredentials(ref, variant = '') {
  const p = `SF_${normRef(ref)}_${variant ? variant + '_' : ''}`;
  const flow = env(p + 'AUTH_FLOW');
  const clientId = env(p + 'CLIENT_ID');
  if (!ref || !flow || !clientId) return null;
  return {
    flow,
    loginUrl: env(p + 'LOGIN_URL'),
    clientId,
    clientSecret: env(p + 'CLIENT_SECRET'),
    username: env(p + 'USERNAME'),
    privateKeyPath: env(p + 'PRIVATE_KEY_PATH'),
    refreshToken: env(p + 'REFRESH_TOKEN'),
  };
}

function jiraCredentials(ref) {
  const p = ref ? `JIRA_${normRef(ref)}_` : 'JIRA_';
  const email = env(p + 'EMAIL') || env('JIRA_EMAIL');
  const token = env(p + 'API_TOKEN') || env('JIRA_API_TOKEN');
  if (!email || !token) return null;
  return { email, token };
}

function salesforceMcpSettings(ref) {
  const p = `SF_${normRef(ref)}_`;
  const url = env(p + 'MCP_URL') || env('SF_MCP_URL');
  const command = env(p + 'MCP_COMMAND') || env('SF_MCP_COMMAND');
  if (!url && !command) return null;
  return { url, command, timeoutMs: Number(env(p + 'MCP_TIMEOUT_MS') || env('SF_MCP_TIMEOUT_MS') || 20000) };
}

function postmanSettings(ref) {
  const p = `POSTMAN_${normRef(ref)}_`;
  const url = env(p + 'MCP_URL') || env('POSTMAN_MCP_URL');
  const command = env(p + 'MCP_COMMAND') || env('POSTMAN_MCP_COMMAND');
  const apiKey = env(p + 'API_KEY') || env('POSTMAN_API_KEY');
  const workspace = env(p + 'WORKSPACE') || env('POSTMAN_WORKSPACE');
  if (!url && !command && !apiKey && !workspace) return null;
  return { url, command, apiKey, workspace, timeoutMs: Number(env(p + 'MCP_TIMEOUT_MS') || env('POSTMAN_MCP_TIMEOUT_MS') || 20000) };
}

function commerceCredentials(ref) {
  const p = `SFCC_${normRef(ref)}_`;
  const clientId = env(p + 'CLIENT_ID') || env('SFCC_CLIENT_ID');
  const clientSecret = env(p + 'CLIENT_SECRET') || env('SFCC_CLIENT_SECRET');
  if (!ref || !clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function httpCredentials(ref) {
  const p = ref ? `HTTP_${normRef(ref)}_` : 'HTTP_';
  const token = env(p + 'TOKEN') || env('HTTP_BEARER_TOKEN');
  const baseUrl = env(p + 'BASE_URL') || env('HTTP_BASE_URL');
  if (!token && !baseUrl) return null;
  return { token: token || '', baseUrl: baseUrl || '' };
}

function playwrightSettings(ref) {
  const p = `PLAYWRIGHT_${normRef(ref)}_`;
  const url = env(p + 'MCP_URL') || env('PLAYWRIGHT_MCP_URL');
  const command = env(p + 'MCP_COMMAND') || env('PLAYWRIGHT_MCP_COMMAND');
  if (!url && !command) return null;
  return { url, command, timeoutMs: Number(env(p + 'MCP_TIMEOUT_MS') || env('PLAYWRIGHT_MCP_TIMEOUT_MS') || 30000) };
}

/** Presence-only report — safe to send to the UI. */
function credentialStatus(sfRef, jiraRef, commerceRef) {
  const p = `SF_${normRef(sfRef)}_`;
  const has = (k) => Boolean(env(k));
  const mcp = salesforceMcpSettings(sfRef);
  const ccPrefix = commerceRef ? `SFCC_${normRef(commerceRef)}_` : (sfRef ? `SFCC_${normRef(sfRef)}_` : 'SFCC_');
  return {
    salesforce: {
      prefix: sfRef ? p : null,
      authFlow: env(p + 'AUTH_FLOW') || null,
      clientId: has(p + 'CLIENT_ID'),
      clientSecret: has(p + 'CLIENT_SECRET'),
      username: has(p + 'USERNAME'),
      privateKey: has(p + 'PRIVATE_KEY_PATH'),
      refreshToken: has(p + 'REFRESH_TOKEN'),
      lowPrivilegeUser: has(p + 'LOWPRIV_CLIENT_ID'),
      mcpUrl: Boolean((mcp && mcp.url) || has(p + 'MCP_URL')),
      mcpCommand: Boolean((mcp && mcp.command) || has(p + 'MCP_COMMAND')),
      configured: Boolean(salesforceCredentials(sfRef) || mcp),
    },
    jira: {
      configured: Boolean(jiraCredentials(jiraRef)),
      prefix: jiraRef ? `JIRA_${normRef(jiraRef)}_` : 'JIRA_',
    },
    commerce: {
      prefix: ccPrefix,
      clientId: has(ccPrefix + 'CLIENT_ID') || has('SFCC_CLIENT_ID'),
      clientSecret: has(ccPrefix + 'CLIENT_SECRET') || has('SFCC_CLIENT_SECRET'),
      configured: Boolean(commerceCredentials(commerceRef || sfRef)),
    },
    postman: {
      prefix: sfRef ? `POSTMAN_${normRef(sfRef)}_` : 'POSTMAN_',
      mcpUrl: Boolean(env(`POSTMAN_${normRef(sfRef)}_MCP_URL`) || env('POSTMAN_MCP_URL')),
      mcpCommand: Boolean(env(`POSTMAN_${normRef(sfRef)}_MCP_COMMAND`) || env('POSTMAN_MCP_COMMAND')),
      apiKey: Boolean(env(`POSTMAN_${normRef(sfRef)}_API_KEY`) || env('POSTMAN_API_KEY')),
      workspace: env(`POSTMAN_${normRef(sfRef)}_WORKSPACE`) || env('POSTMAN_WORKSPACE') || null,
      configured: Boolean(postmanSettings(sfRef)),
    },
    http: {
      prefix: sfRef ? `HTTP_${normRef(sfRef)}_` : 'HTTP_',
      token: Boolean(env(`HTTP_${normRef(sfRef)}_TOKEN`) || env('HTTP_BEARER_TOKEN')),
      baseUrl: env(`HTTP_${normRef(sfRef)}_BASE_URL`) || env('HTTP_BASE_URL') || null,
      configured: Boolean(httpCredentials(sfRef) || env('HTTP_BASE_URL') || env('HTTP_BEARER_TOKEN')),
    },
    playwright: {
      prefix: sfRef ? `PLAYWRIGHT_${normRef(sfRef)}_` : 'PLAYWRIGHT_',
      mcpUrl: Boolean(env(`PLAYWRIGHT_${normRef(sfRef)}_MCP_URL`) || env('PLAYWRIGHT_MCP_URL')),
      mcpCommand: Boolean(env(`PLAYWRIGHT_${normRef(sfRef)}_MCP_COMMAND`) || env('PLAYWRIGHT_MCP_COMMAND')),
      configured: Boolean(playwrightSettings(sfRef)),
    },
  };
}

/** All secret-looking values currently in the environment (for log masking). */
function secretValues() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 6) continue;
    if (/(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|CLIENT_ID|REFRESH)/i.test(k)) out.push(v);
  }
  return out;
}

const SF_UNAVAILABLE_MESSAGE = 'Salesforce MCP is unavailable. API test design and automation generation are available, but live Salesforce validation is disabled.';

module.exports = { SF_UNAVAILABLE_MESSAGE, config, salesforceCredentials, jiraCredentials, salesforceMcpSettings, commerceCredentials, httpCredentials, postmanSettings, playwrightSettings, credentialStatus, secretValues, normRef };
