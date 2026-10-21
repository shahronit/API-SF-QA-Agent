'use strict';
/**
 * Salesforce CLI (`sf`). Browser login via `sf org login web` (verified flags:
 * --instance-url / -r, --alias / -a). Tokens stay in the CLI, not this app.
 * Never invents object/field names — only returns JSON from the CLI.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findBin, runCli, spawnDetached, openUrl } = require('../lib/cli-spawn');
const { config } = require('../config');
const { ConnectorError, normaliseDescribe } = require('./salesforce');
const { loginPlan, sanitizeOrgDisplay, classifyLoginUrl, restApiOrigin, ensureSalesforceRestPath } = require('./salesforce-org');

function envFlag(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

function detectSalesforceBin(configured) {
  if (configured && path.isAbsolute(configured)) return findBin([configured]);
  if (configured) return findBin([configured, 'sf']);
  return findBin(['sf']);
}

function cliSettings(project) {
  const ic = (project && project.integrationConfig) || {};
  const fromCfg = ic.salesforceCli || {};
  const det = ic.salesforceDetection || {};
  const enabled = fromCfg.enabled === true
    || envFlag(process.env.SF_CLI_ENABLED)
    || Boolean(fromCfg.targetOrg)
    || Boolean(det.connected && det.loginKind === 'core');
  return {
    enabled,
    bin: fromCfg.bin || process.env.SF_CLI_BIN || '',
    targetOrg: fromCfg.targetOrg || (project && project.sfOrg) || process.env.SF_TARGET_ORG || '',
    timeoutMs: Number(fromCfg.timeoutMs || process.env.SF_CLI_TIMEOUT_MS || 25000),
  };
}

function orgAlias(project, explicit) {
  const fromCfg = ((project && project.integrationConfig) || {}).salesforceCli || {};
  const raw = explicit || fromCfg.targetOrg || (project && project.sfOrg) || (project && project.id) || 'qa-org';
  return String(raw).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'qa-org';
}

class SalesforceCliAdapter {
  constructor(project) {
    this.project = project;
    this.kind = 'cli';
    this.settings = cliSettings(project);
    this.bin = detectSalesforceBin(this.settings.bin);
  }

  get available() {
    return Boolean(this.settings.enabled && this.bin);
  }

  get cachedLogin() {
    const det = ((this.project && this.project.integrationConfig) || {}).salesforceDetection || {};
    if (det.connected && det.loginKind === 'core') {
      return { at: Date.now(), loggedIn: true, account: det.alias || det.orgName || null };
    }
    return null;
  }

  unavailableExplanation() {
    if (!this.bin) {
      return {
        code: 'SALESFORCE_CLI_UNAVAILABLE',
        title: 'Salesforce CLI is not installed.',
        cause: '`sf` was not found on PATH (including ~/.local/bin).',
        action: 'Install Salesforce CLI (`sf`), enter the org login URL, then Log in. The CLI opens a browser (loopback OAuth).',
        category: 'configuration',
        evidence: [],
      };
    }
    return {
      code: 'SALESFORCE_CLI_NOT_LOGGED_IN',
      title: 'Salesforce CLI is not logged in to this org.',
      cause: 'No authenticated target org alias is available for this project.',
      action: 'Click Log in, finish Salesforce in the browser, then Test.',
      category: 'configuration',
      evidence: [],
    };
  }

  async run(args) {
    const { targetOrg, timeoutMs } = this.settings;
    if (!this.bin) throw new ConnectorError(this.unavailableExplanation());
    if (!targetOrg && !args.includes('--target-org') && !args.includes('-o')) {
      throw new ConnectorError({
        code: 'SF_CLI_NO_TARGET',
        title: 'No Salesforce CLI org alias is set.',
        cause: 'This project has not finished browser login, so there is no target org for `sf`.',
        action: 'Click Log in, finish Salesforce in the browser, then Test. The CLI alias is saved on this project — we do not use your default org.',
        category: 'configuration',
        evidence: [],
      });
    }
    const full = targetOrg && !args.includes('--target-org') && !args.includes('-o') ? [...args, '--target-org', targetOrg] : args;
    let r;
    try {
      r = await runCli(this.bin, full, { timeoutMs, cwd: config.root });
    } catch (e) {
      throw new ConnectorError({
        code: e.code || 'SF_CLI_SPAWN',
        title: e.title || 'Salesforce CLI could not be started.',
        cause: e.cause || e.message,
        action: e.action || 'Install Salesforce CLI (`sf`) and ensure it is on PATH.',
        category: 'configuration',
        evidence: [],
      });
    }
    let json;
    try { json = JSON.parse(r.stdout); } catch {
      throw new ConnectorError({
        code: 'SF_CLI_BAD_JSON',
        title: 'Salesforce CLI did not return JSON.',
        cause: (r.stderr || r.stdout || `exit ${r.code}`).slice(0, 240),
        action: 'Re-run the command with `--json` locally and confirm the target org alias.',
        category: 'environment',
        evidence: [(r.stderr || '').slice(-400)],
      });
    }
    if (r.code !== 0 && json.status !== 0) {
      throw new ConnectorError({
        code: 'SF_CLI_FAILED',
        title: (json.message || json.name || 'Salesforce CLI command failed') + '.',
        cause: json.message || r.stderr || `exit ${r.code}`,
        action: 'Run `sf org display --json` for the selected alias, then Test connection.',
        category: 'environment',
        evidence: [],
      });
    }
    return json.result !== undefined ? json.result : json;
  }

  startLogin(opts = {}) {
    if (!this.bin) return { ok: false, ...this.unavailableExplanation() };
    const instanceUrl = opts.instanceUrl || (this.project && this.project.instanceUrl) || '';
    const alias = opts.alias || orgAlias(this.project);
    const plan = loginPlan(instanceUrl, { alias, bin: this.bin });
    if (!plan.ok) return plan;
    if (plan.action === 'open-url') {
      openUrl(plan.loginUrl);
      return {
        ok: true,
        started: true,
        kind: 'sfcc',
        loginKind: 'sfcc',
        loginUrl: plan.loginUrl,
        host: plan.classified && plan.classified.host,
        command: `open ${plan.loginUrl}`,
        title: 'Commerce Cloud login opened.',
        text: 'Account Manager / Business Manager opened in your browser. Sign in there (this is not Core login.salesforce.com). Then click Test — we will detect SFCC and auto-connect OCAPI/SCAPI testers. Nothing is stored in this app.',
      };
    }
    spawnDetached(this.bin, plan.args, { cwd: config.root });
    const shown = `${path.basename(this.bin)} org login web --instance-url ${plan.loginUrl}${alias ? ` --alias ${alias}` : ''}`;
    return {
      ok: true,
      started: true,
      kind: 'cli',
      loginKind: 'core',
      alias,
      loginUrl: plan.loginUrl,
      command: shown,
      title: 'Salesforce login started.',
      text: `Salesforce CLI is opening ${plan.loginUrl} in your browser (loopback OAuth). Finish signing in, then click Test. Tokens stay in Salesforce CLI, not this app.`,
    };
  }

  async orgDisplay() {
    const result = await this.run(['org', 'display', '--json']);
    return sanitizeOrgDisplay(result);
  }

  async testConnection() {
    const t0 = Date.now();
    const result = await this.orgDisplay();
    const connected = /connect/i.test(String(result.status || '')) || Boolean(result.orgId || result.instanceUrl);
    return {
      ok: connected,
      kind: 'cli',
      alias: result.alias || this.settings.targetOrg || null,
      username: result.username || null,
      instanceUrl: result.instanceUrl || null,
      orgId: result.orgId || null,
      edition: result.edition || null,
      apiVersion: result.apiVersion || null,
      isSandbox: result.isSandbox,
      status: result.status || 'CONNECTED',
      ms: Date.now() - t0,
    };
  }

  async describeGlobal() {
    const result = await this.run(['sobject', 'list', '--json']);
    const list = Array.isArray(result) ? result : result.sobjects || result;
    return (list || []).map((o) => (typeof o === 'string' ? { name: o, label: o, custom: /__c$/.test(o) } : { name: o.name, label: o.label || o.name, custom: Boolean(o.custom) }));
  }

  async describe(name) {
    const raw = await this.run(['sobject', 'describe', '--sobject', name, '--json']);
    return normaliseDescribe(raw && raw.name ? raw : (raw && raw.result) || raw);
  }

  async query(soql) {
    const result = await this.run(['data', 'query', '--query', soql, '--json']);
    if (result && Array.isArray(result.records)) return result;
    if (Array.isArray(result)) return { totalSize: result.length, done: true, records: result };
    return result;
  }

  async queryTooling(soql) {
    const result = await this.run(['data', 'query', '--query', soql, '--use-tooling-api', '--json']);
    if (result && Array.isArray(result.records)) return result;
    if (Array.isArray(result)) return { totalSize: result.length, done: true, records: result };
    return result;
  }

  async request(r) {
    const auth = r.auth || 'default';
    const instanceUrl = restApiOrigin(this.project.instanceUrl) || String(this.project.instanceUrl || '').replace(/\/$/, '');
    const resourcePath = r.apiType === 'SOAP' ? (r.path || '/') : ensureSalesforceRestPath(r.path, this.project.apiVersion);
    if (auth === 'none' || auth === 'invalid') {
      if (!instanceUrl) {
        throw new ConnectorError({
          code: 'CLI_INSTANCE_MISSING',
          title: 'No instance URL is set for an unauthenticated request.',
          cause: 'Negative auth tests need the org’s *.my.salesforce.com origin — login.salesforce.com returns 403/410.',
          action: 'Log in so the instance URL is saved, then retry.',
          category: 'configuration',
          evidence: [],
        });
      }
      const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity', ...(r.headers || {}) };
      if (auth === 'invalid') headers.Authorization = 'Bearer 00DINVALIDTOKEN!QA.NegativeTest.InvalidToken';
      else delete headers.Authorization;
      const target = /^https?:\/\//.test(resourcePath) ? new URL(resourcePath) : new URL(instanceUrl + (resourcePath.startsWith('/') ? '' : '/') + resourcePath);
      for (const [k, v] of Object.entries(r.query || {})) if (v !== undefined && v !== '') target.searchParams.set(k, v);
      const started = performance.now();
      const res = await fetch(target, { method: r.method, headers, signal: AbortSignal.timeout(r.timeoutMs || 30000), redirect: 'manual' });
      const text = await res.text();
      let body = text;
      if ((res.headers.get('content-type') || '').includes('json') && text) {
        try { body = JSON.parse(text); } catch { /* keep */ }
      }
      return {
        status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()),
        body, text, timeMs: Math.round(performance.now() - started), sizeBytes: Buffer.byteLength(text),
        url: target.toString(), correlationId: null,
      };
    }
    if (!this.settings.targetOrg) {
      throw new ConnectorError({
        code: 'CLI_TARGET_MISSING',
        title: 'Salesforce CLI has no target org alias for API execution.',
        cause: 'Browser login should set an alias on this project.',
        action: 'Click Log in, finish in the browser, then Test.',
        category: 'configuration',
        evidence: [],
      });
    }
    let pathUrl = resourcePath || '/';
    if (!/^https?:\/\//.test(pathUrl)) {
      const u = new URL(pathUrl.startsWith('/') ? `https://placeholder.local${pathUrl}` : `https://placeholder.local/${pathUrl}`);
      for (const [k, v] of Object.entries(r.query || {})) if (v !== undefined && v !== '') u.searchParams.set(k, v);
      pathUrl = u.pathname + u.search;
    } else {
      pathUrl = ensureSalesforceRestPath(pathUrl, this.project.apiVersion);
    }
    const args = ['api', 'request', 'rest', pathUrl, '--target-org', this.settings.targetOrg, '--method', r.method || 'GET', '--include'];
    const headerMap = { Accept: 'application/json', 'Accept-Encoding': 'identity', ...(r.headers || {}) };
    if (!['GET', 'HEAD'].includes(String(r.method || 'GET').toUpperCase()) && r.body !== undefined && r.body !== null && (r.bodyRaw === undefined || r.bodyRaw === null || r.bodyRaw === '')) {
      if (!Object.keys(headerMap).some((h) => h.toLowerCase() === 'content-type')) headerMap['Content-Type'] = 'application/json';
    }
    for (const [k, v] of Object.entries(headerMap)) {
      if (v === undefined || v === null || v === '') continue;
      if (/^authorization$/i.test(k)) continue;
      args.push('--header', `${k}: ${v}`);
    }
    let tmp = null;
    if (r.bodyRaw !== undefined && r.bodyRaw !== null && r.bodyRaw !== '') {
      tmp = path.join(os.tmpdir(), `qa-sf-body-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(tmp, String(r.bodyRaw), { encoding: 'utf8', mode: 0o600 });
      args.push('--body', `@${tmp}`);
    } else if (r.body !== undefined && r.body !== null && !['GET', 'HEAD'].includes(r.method || 'GET')) {
      tmp = path.join(os.tmpdir(), `qa-sf-body-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(r.body), { encoding: 'utf8', mode: 0o600 });
      args.push('--body', `@${tmp}`);
    }
    const started = performance.now();
    let out;
    try {
      out = await runCli(this.bin, args, { timeoutMs: r.timeoutMs || this.settings.timeoutMs, cwd: config.root });
    } finally {
      if (tmp) try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    const parsed = parseCliHttp(out.stdout || out.stderr || '');
    parsed.timeMs = Math.round(performance.now() - started);
    parsed.url = instanceUrl ? instanceUrl + pathUrl : pathUrl;
    return parsed;
  }
}

function parseJsonFragment(text) {
  const s = String(text || '').trim();
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { /* continue */ }
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  const start = [iObj, iArr].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return undefined;
  const slice = s.slice(start);
  try { return JSON.parse(slice); } catch { /* continue */ }
  const end = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'));
  if (end > 0) {
    try { return JSON.parse(slice.slice(0, end + 1)); } catch { /* keep */ }
  }
  return undefined;
}

function parseCliHttp(stdout) {
  const text = String(stdout || '');
  try {
    const wrapped = JSON.parse(text);
    if (wrapped && typeof wrapped === 'object' && (wrapped.result || wrapped.body || wrapped.statusCode)) {
      const r = wrapped.result && typeof wrapped.result === 'object' ? wrapped.result : wrapped;
      const status = Number(r.status || r.statusCode || wrapped.status || 200);
      return {
        status, statusText: String(status), headers: r.headers || {},
        body: r.body !== undefined ? r.body : (r.data !== undefined ? r.data : r),
        text, sizeBytes: Buffer.byteLength(text), correlationId: null,
      };
    }
  } catch { /* not a JSON envelope */ }
  const split = text.search(/\r?\n\r?\n/);
  const head = split === -1 ? text : text.slice(0, split);
  const bodyText = split === -1 ? text : text.slice(split).replace(/^\r?\n\r?\n/, '');
  const m = text.match(/HTTP\/[\d.]+ (\d+)/);
  let status = m ? Number(m[1]) : 0;
  const parsedBody = parseJsonFragment(bodyText) !== undefined ? parseJsonFragment(bodyText) : parseJsonFragment(text);
  const body = parsedBody !== undefined ? parsedBody : bodyText;
  if (!status) status = parsedBody !== undefined ? 200 : 0;
  if (!status) status = 200;
  return {
    status, statusText: String(status), headers: {}, body, text: bodyText || text,
    sizeBytes: Buffer.byteLength(text), correlationId: null,
  };
}

module.exports = { SalesforceCliAdapter, cliSettings, detectSalesforceBin, orgAlias, loginPlan, classifyLoginUrl, parseCliHttp };
