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

loadDotEnv(path.join(ROOT, '.env'));

const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const config = {
  root: ROOT,
  port: Number(env('PORT', '4317')),
  host: env('HOST', '127.0.0.1'),
  dataDir: path.resolve(ROOT, env('DATA_DIR', './data')),
  appUser: env('APP_USER', 'qa.engineer'),
  seedDemo: env('SEED_DEMO', 'true') !== 'false',
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

/** Presence-only report — safe to send to the UI. */
function credentialStatus(sfRef, jiraRef) {
  const p = `SF_${normRef(sfRef)}_`;
  const has = (k) => Boolean(env(k));
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
      configured: Boolean(salesforceCredentials(sfRef)),
    },
    jira: {
      configured: Boolean(jiraCredentials(jiraRef)),
      prefix: jiraRef ? `JIRA_${normRef(jiraRef)}_` : 'JIRA_',
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

module.exports = { SF_UNAVAILABLE_MESSAGE, config, salesforceCredentials, jiraCredentials, credentialStatus, secretValues, normRef };
