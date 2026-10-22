'use strict';
/**
 * Salesforce MCP adapter. Uses a configured MCP server for metadata (describe,
 * SOQL). Live REST/SOAP execution still goes through SalesforceConnector when
 * org OAuth credentials are present.
 */
const { McpClient, McpError, toolJson } = require('./mcp');
const { salesforceMcpSettings } = require('../config');
const { ConnectorError, normaliseDescribe } = require('./salesforce');

function mcpSettings(project) {
  const fromEnv = salesforceMcpSettings(project.credentialRef) || {};
  const fromCfg = (project.integrationConfig && project.integrationConfig.salesforceMcp) || {};
  return {
    url: fromEnv.url || fromCfg.url || '',
    command: fromEnv.command || fromCfg.command || '',
    timeoutMs: Number(fromEnv.timeoutMs || fromCfg.timeoutMs || 20000),
  };
}

class SalesforceMcpAdapter {
  constructor(project) {
    this.project = project;
    this.kind = 'mcp';
    this.settings = mcpSettings(project);
    this.client = new McpClient(this.settings);
  }

  get available() { return this.client.available; }

  unavailableExplanation() {
    return {
      code: 'SALESFORCE_MCP_NOT_CONFIGURED',
      title: require('../config').SF_UNAVAILABLE_MESSAGE,
      cause: 'No Salesforce MCP URL or command is configured for this project.',
      action: 'On Connections, set an MCP HTTP URL (Streamable HTTP) or a stdio command such as `npx -y @salesforce/mcp`, then Test connections.',
      category: 'configuration',
      evidence: [require('../config').SF_UNAVAILABLE_MESSAGE],
    };
  }

  async testConnection() {
    const t0 = Date.now();
    const init = await this.client.ensure();
    return {
      ok: true,
      kind: 'mcp',
      transport: this.settings.url ? 'http' : 'stdio',
      protocol: init && init.protocolVersion,
      server: init && init.serverInfo,
      tools: this.client.tools.map((t) => t.name),
      ms: Date.now() - t0,
    };
  }

  async describeGlobal() {
    await this.client.ensure();
    const tool = this.client.findTool(/describe.?global|list.?sobject|list.?objects|get.?objects/i);
    if (!tool) throw new ConnectorError({ code: 'MCP_TOOL_MISSING', title: 'The MCP server has no describe-global tool.', cause: `Tools: ${(this.client.tools.map((t) => t.name).join(', ') || 'none')}.`, action: 'Use an MCP server that exposes Salesforce object listing, or connect the org over OAuth for live describe.', category: 'configuration', evidence: [] });
    const data = toolJson(await this.client.callTool(tool.name, {}));
    const list = Array.isArray(data) ? data : data.sobjects || data.objects || data.result || [];
    return list.map((o) => (typeof o === 'string' ? { name: o, label: o, custom: /__c$/.test(o) } : { name: o.name || o.qualifiedApiName, label: o.label || o.name, custom: Boolean(o.custom) }));
  }

  async describe(name) {
    await this.client.ensure();
    const tool = this.client.findTool(/describe.?sobject|describe.?object|get.?sobject|sobject.?describe/i);
    if (!tool) throw new ConnectorError({ code: 'MCP_TOOL_MISSING', title: `The MCP server cannot describe ${name}.`, cause: 'No describe tool is advertised.', action: 'Connect the org over OAuth so describe uses the REST API, or point MCP at a server that exposes describe.', category: 'configuration', evidence: [] });
    const args = {};
    const schema = (tool.inputSchema && tool.inputSchema.properties) || {};
    const key = Object.keys(schema).find((k) => /name|sobject|object/i.test(k)) || 'sobjectName';
    args[key] = name;
    const data = toolJson(await this.client.callTool(tool.name, args));
    if (data && data.name) return normaliseDescribe(data);
    if (data && data.result) return normaliseDescribe(data.result);
    throw new ConnectorError({ code: 'MCP_DESCRIBE_FAILED', title: `MCP describe for ${name} returned an unexpected shape.`, category: 'configuration', evidence: [] });
  }

  async query(soql) {
    await this.client.ensure();
    const tool = this.client.findTool(/soql|run.?query|query.?org/i);
    if (!tool) throw new ConnectorError({ code: 'MCP_TOOL_MISSING', title: 'The MCP server has no SOQL tool.', category: 'configuration', evidence: [] });
    const schema = (tool.inputSchema && tool.inputSchema.properties) || {};
    const key = Object.keys(schema).find((k) => /soql|query|q$/i.test(k)) || 'query';
    const data = toolJson(await this.client.callTool(tool.name, { [key]: soql }));
    if (data && Array.isArray(data.records)) return data;
    if (Array.isArray(data)) return { totalSize: data.length, done: true, records: data };
    return data;
  }

  async request() {
    throw new ConnectorError({
      code: 'MCP_EXECUTION_UNSUPPORTED',
      title: 'Salesforce MCP is connected for metadata, but live API execution needs org OAuth.',
      cause: 'MCP is used for describe/SOQL. Running tests still needs a connected-app client credentials, JWT or refresh-token flow.',
      action: 'Add SF_<PREFIX>_AUTH_FLOW / CLIENT_ID / CLIENT_SECRET (or JWT) on the Connections tab, then Test connections.',
      category: 'configuration',
      evidence: [],
    });
  }
}

/** Prefer MCP, then CLI, then REST for metadata. REST (OAuth) still runs HTTP tests. */
class HybridSalesforce {
  constructor(rest, mcp, cli) {
    this.rest = rest;
    this.mcp = mcp;
    this.cli = cli || null;
    this.project = rest.project || (mcp && mcp.project) || (cli && cli.project);
    this.kind = 'hybrid';
  }

  get available() { return Boolean((this.rest && this.rest.available) || (this.mcp && this.mcp.available) || (this.cli && this.cli.available)); }
  get hasLowPrivilegeUser() { return this.rest && this.rest.hasLowPrivilegeUser; }

  prefer() {
    return ((this.project && this.project.integrationConfig) || {}).salesforceSource || 'mcp';
  }

  metaChain() {
    const prefer = this.prefer();
    const order = prefer === 'cli'
      ? [this.cli, this.mcp, this.rest]
      : prefer === 'oauth'
        ? [this.rest, this.mcp, this.cli]
        : [this.mcp, this.cli, this.rest];
    return order.filter((x) => x && x.available);
  }

  unavailableExplanation() {
    if (this.mcp && !this.mcp.available && this.rest && !this.rest.available) return this.mcp.unavailableExplanation();
    if (this.rest && this.rest.available) return this.mcp ? this.mcp.unavailableExplanation() : this.rest.unavailableExplanation();
    if (this.cli && this.cli.available) return this.cli.unavailableExplanation();
    return (this.mcp && this.mcp.unavailableExplanation()) || (this.rest && this.rest.unavailableExplanation());
  }

  async testConnection() {
    const out = { ok: false, org: null, mcp: null, cli: null, source: this.prefer() };
    if (this.rest && this.rest.available) {
      try { out.org = await this.rest.testConnection(); } catch (e) { out.org = { ok: false, ...(e.explanation || { title: e.message }) }; }
    } else out.org = { ok: false, ...((this.rest && this.rest.unavailableExplanation()) || { title: 'Org OAuth is not configured.' }) };
    if (this.mcp && this.mcp.available) {
      try { out.mcp = await this.mcp.testConnection(); } catch (e) { out.mcp = { ok: false, ...(e.explanation || { title: e.message }) }; }
    } else out.mcp = { ok: false, ...((this.mcp && this.mcp.unavailableExplanation()) || { title: 'Salesforce MCP is not configured.' }) };
    if (this.cli && this.cli.available) {
      try { out.cli = await this.cli.testConnection(); } catch (e) { out.cli = { ok: false, ...(e.explanation || { title: e.message }) }; }
    } else out.cli = { ok: false, title: 'Salesforce CLI fallback was not used.' };
    out.ok = Boolean((out.org && out.org.ok) || (out.mcp && out.mcp.ok) || (out.cli && out.cli.ok));
    if (out.org && out.org.ok) Object.assign(out, { orgId: out.org.orgId, apiVersions: out.org.apiVersions, identity: out.org.identity });
    if (out.cli && out.cli.ok && out.cli.status) out.cliStatus = out.cli.status;
    return out;
  }

  async _first(method, args) {
    const chain = this.metaChain();
    let last;
    for (const c of chain) {
      if (typeof c[method] !== 'function') continue;
      try { return await c[method](...args); } catch (e) { last = e; }
    }
    if (last) throw last;
    throw new McpError('No Salesforce metadata source is available (MCP, CLI or org OAuth).');
  }

  async describeGlobal() { return this._first('describeGlobal', []); }
  async describe(name) {
    const d = await this._first('describe', [name]);
    return d && Array.isArray(d.fields) ? normaliseDescribe(d) : d;
  }
  async query(soql) { return this._first('query', [soql]); }
  async queryTooling(soql) { return this._first('queryTooling', [soql]); }
  async orgDisplay() { return this._first('orgDisplay', []); }

  async request(r) {
    if (this.rest && this.rest.available) return this.rest.request(r);
    if (this.cli && this.cli.available) return this.cli.request(r);
    if (this.mcp) return this.mcp.request(r);
    throw new McpError('Live API execution needs Salesforce CLI browser login or org OAuth.');
  }

  async limits() {
    if (this.rest.available) return this.rest.limits();
    throw new McpError('Org limits require the REST connector (OAuth).');
  }
}

module.exports = { SalesforceMcpAdapter, HybridSalesforce, mcpSettings };
