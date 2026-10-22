'use strict';
/**
 * Playwright API-testing MCP adapter.
 * Talks to ExecuteAutomation's Playwright MCP (@executeautomation/playwright-mcp-server)
 * which exposes playwright_get / post / put / patch / delete. Official Microsoft
 * Playwright MCP is browser-only and is not used here.
 *
 * Requests still go through the platform runner (assertions, extracts, masking,
 * Production safety, Salesforce re-read). This connector is the HTTP transport.
 */
const { McpClient, McpError, toolJson } = require('./mcp');
const { playwrightSettings } = require('../config');
const { ConnectorError } = require('./salesforce');
const { restApiOrigin } = require('./salesforce-org');

const DEFAULT_MCP_COMMAND = 'npx -y @executeautomation/playwright-mcp-server';

const METHOD_TOOLS = {
  GET: [/^playwright_get$/i, /^get$/i],
  POST: [/^playwright_post$/i, /^post$/i],
  PUT: [/^playwright_put$/i, /^put$/i],
  PATCH: [/^playwright_patch$/i, /^patch$/i],
  DELETE: [/^playwright_delete$/i, /^delete$/i],
};

function settingsFor(project) {
  const env = playwrightSettings(project && project.credentialRef) || {};
  const cfg = ((project && project.integrationConfig) || {}).playwright || {};
  const url = env.url || cfg.mcpUrl || '';
  let command = env.command || cfg.mcpCommand || '';
  if (!url && !command && cfg.enabled && !process.env.NODE_TEST_CONTEXT && !process.env.QA_DB_FILE) {
    command = DEFAULT_MCP_COMMAND;
  }
  return {
    url,
    command,
    timeoutMs: Number(env.timeoutMs || cfg.timeoutMs || 30000),
    enabled: cfg.enabled !== false,
  };
}

function bearerFrom(headers) {
  const raw = headers && Object.entries(headers).find(([k]) => /^authorization$/i.test(k));
  if (!raw) return '';
  const v = String(raw[1] || '');
  const m = v.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

function headersWithoutAuth(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!/^authorization$/i.test(k)) out[k] = v;
  }
  return out;
}

function parseResult(raw) {
  const data = toolJson(raw);
  if (data == null) return { status: 0, body: null, text: '' };
  if (typeof data === 'number') return { status: data, body: null, text: String(data) };
  if (typeof data === 'string') {
    try { return parseResult(JSON.parse(data)); } catch { return { status: 0, body: data, text: data }; }
  }
  const status = Number(data.statusCode ?? data.status ?? data.code ?? 0);
  let body = data.responseData ?? data.body ?? data.data ?? data.json ?? null;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* keep string */ }
  }
  const text = typeof body === 'string' ? body : (body != null ? JSON.stringify(body) : (data.text || ''));
  return { status: Number.isFinite(status) ? status : 0, body, text, headers: data.headers || {} };
}

class PlaywrightConnector {
  constructor(project, opts = {}) {
    this.project = project;
    this.kind = 'playwright';
    this.settings = settingsFor(project);
    this.client = opts.client || new McpClient({
      url: this.settings.url,
      command: this.settings.command,
      timeoutMs: this.settings.timeoutMs,
    });
  }

  get available() { return this.client.available; }
  get canExecute() { return this.client.available; }

  missingHref() {
    const id = this.project && this.project.id;
    return id ? `/projects/${id}?tab=connection&focus=playwright` : '/projects';
  }

  unavailableExplanation() {
    return {
      code: 'PLAYWRIGHT_MCP_UNAVAILABLE',
      title: 'Playwright MCP is not connected.',
      cause: 'No Playwright MCP URL or stdio command is configured. Official Microsoft Playwright MCP is browser-only; this runner uses ExecuteAutomation Playwright MCP for HTTP API calls.',
      action: 'On Connections → Playwright MCP, set the MCP URL or command (default: npx -y @executeautomation/playwright-mcp-server), then Test.',
      actionLabel: 'Connect Playwright MCP',
      href: this.missingHref(),
      category: 'configuration',
      evidence: [],
    };
  }

  findMethodTool(method) {
    const rxs = METHOD_TOOLS[method] || METHOD_TOOLS.GET;
    for (const rx of rxs) {
      const t = this.client.findTool(rx);
      if (t) return t;
    }
    return this.client.tools.find((t) => new RegExp(method, 'i').test(t.name));
  }

  originFor(req) {
    const path = String((req && (req.path || req.endpoint)) || '');
    if (/^https?:\/\//i.test(path)) {
      try { return new URL(path).origin; } catch { return ''; }
    }
    if (/\/dw\/|shopper-|commercecloud|demandware/i.test(path)) {
      const cc = ((this.project && this.project.integrationConfig) || {}).commerce || {};
      const host = String(cc.host || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      return host ? `https://${host}` : '';
    }
    if (/\/services\/(data|apexrest|Soap|oauth2|async)/i.test(path) || /^\/(sobjects|query|queryAll|composite|connect|graphql|jobs|tooling|limits)\b/i.test(path)) {
      return restApiOrigin(this.project && this.project.instanceUrl) || (this.project && this.project.instanceUrl) || '';
    }
    const http = ((this.project && this.project.integrationConfig) || {}).http || {};
    return String(http.baseUrl || restApiOrigin(this.project && this.project.instanceUrl) || (this.project && this.project.instanceUrl) || '').replace(/\/$/, '');
  }

  absoluteUrl(req) {
    const path = String(req.path || req.endpoint || '/');
    let target;
    if (/^https?:\/\//i.test(path)) {
      target = new URL(path);
    } else {
      const origin = this.originFor(req);
      if (!origin) {
        throw new ConnectorError({
          ...this.unavailableExplanation(),
          code: 'PLAYWRIGHT_ORIGIN_MISSING',
          title: 'Playwright MCP has no origin URL for this request.',
          cause: 'The path is relative and the project has no Salesforce instance URL or frontend HTTP base URL.',
          action: 'Set the Salesforce instance URL or HTTP base URL on Connections, then re-run.',
        });
      }
      target = new URL(String(origin).replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`));
    }
    for (const [k, v] of Object.entries(req.query || {})) {
      if (v !== undefined && v !== '') target.searchParams.set(k, v);
    }
    return target.toString();
  }

  supports(req) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (!METHOD_TOOLS[method]) return false;
    const t = String((req && req.apiType) || '');
    if (/soap/i.test(t)) return false;
    return true;
  }

  async request(r) {
    await this.client.ensure();
    const method = String(r.method || 'GET').toUpperCase();
    const tool = this.findMethodTool(method);
    if (!tool) {
      throw new McpError(`The Playwright MCP server has no ${method} tool.`, {
        action: 'Use @executeautomation/playwright-mcp-server, which exposes playwright_get, playwright_post, playwright_put, playwright_patch and playwright_delete.',
        evidence: (this.client.tools || []).map((t) => t.name).slice(0, 12),
      });
    }
    const url = this.absoluteUrl(r);
    const headers = { ...(r.headers || {}) };
    if (r.auth === 'none') {
      Object.keys(headers).forEach((k) => { if (/^authorization$/i.test(k)) delete headers[k]; });
    }
    const token = bearerFrom(headers);
    const args = { url, headers: headersWithoutAuth(headers) };
    if (token) args.token = token;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      if (r.bodyRaw !== undefined && r.bodyRaw !== null && r.bodyRaw !== '') args.value = typeof r.bodyRaw === 'string' ? r.bodyRaw : JSON.stringify(r.bodyRaw);
      else if (r.body !== undefined && r.body !== null) args.value = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      else args.value = '';
    }
    const started = performance.now();
    let raw;
    try {
      raw = await this.client.callTool(tool.name, args, { timeoutMs: r.timeoutMs || this.settings.timeoutMs });
    } catch (e) {
      const err = e instanceof McpError ? e : new McpError(e.message, { cause: e.message });
      err.timeMs = Math.round(performance.now() - started);
      err.url = url;
      throw err;
    }
    const parsed = parseResult(raw);
    const text = parsed.text || (parsed.body != null ? JSON.stringify(parsed.body) : '');
    return {
      status: parsed.status,
      statusText: String(parsed.status),
      headers: parsed.headers || {},
      body: parsed.body,
      text,
      timeMs: Math.round(performance.now() - started),
      sizeBytes: Buffer.byteLength(text),
      url,
      correlationId: null,
      requestHeaders: headers,
      requestBody: args.value,
      executor: 'playwright-mcp',
    };
  }

  wrap(inner) {
    const self = this;
    return new Proxy(inner, {
      get(target, prop) {
        if (prop === 'request') {
          return async (req) => {
            if (!self.supports(req)) return target.request(req);
            const headers = { ...(req.headers || {}) };
            if (req.auth !== 'none' && typeof target.token === 'function' && !Object.keys(headers).some((k) => /^authorization$/i.test(k))) {
              try {
                const t = await target.token();
                if (t && t.accessToken) headers.Authorization = `Bearer ${t.accessToken}`;
              } catch { /* Playwright still sends the request; Salesforce auth may already be on headers */ }
            }
            return self.request({ ...req, headers });
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  async testConnection() {
    const t0 = Date.now();
    if (!this.client.available) return { ok: false, kind: 'playwright', ...this.unavailableExplanation(), ms: Date.now() - t0 };
    try {
      await this.client.ensure();
      const tools = (this.client.tools || []).map((t) => t.name);
      const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => this.findMethodTool(m));
      return {
        ok: methods.length > 0,
        kind: 'playwright',
        ms: Date.now() - t0,
        tools: methods,
        toolNames: tools.slice(0, 20),
        title: methods.length
          ? `Playwright MCP connected (${methods.join(', ')})`
          : 'Playwright MCP connected but has no HTTP API tools',
        action: methods.length ? undefined : 'Use @executeautomation/playwright-mcp-server for playwright_get / post / put / patch / delete.',
      };
    } catch (e) {
      return { ok: false, kind: 'playwright', ms: Date.now() - t0, ...(e.explanation || { title: e.message }) };
    }
  }
}

function playwrightFor(project, opts) {
  return new PlaywrightConnector(project, opts);
}

module.exports = { PlaywrightConnector, playwrightFor, settingsFor, DEFAULT_MCP_COMMAND, parseResult };
