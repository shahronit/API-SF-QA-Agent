'use strict';
/**
 * Minimal Model Context Protocol client (JSON-RPC 2.0) over HTTP or stdio.
 * No runtime dependencies. Used to talk to a Salesforce (or other) MCP server
 * for live metadata — describe, SOQL — when an MCP URL or command is configured.
 */
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { explainNetworkError } = require('../lib/errors');

class McpError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.explanation = { title: message, category: 'configuration', evidence: extra.evidence || [], action: extra.action || 'Check the MCP URL or command, then Test connections.', ...extra };
  }
}

function parseSseJson(text) {
  const blocks = String(text).split(/\n\n+/);
  const msgs = [];
  for (const b of blocks) {
    const data = b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try { msgs.push(JSON.parse(data)); } catch { /* ignore keepalive */ }
  }
  return msgs;
}

class McpClient {
  constructor({ url, command, timeoutMs = 20000, env } = {}) {
    this.url = url ? String(url).replace(/\/$/, '') : '';
    this.command = command ? String(command).trim() : '';
    this.timeoutMs = timeoutMs;
    this.env = env && typeof env === 'object' ? env : null;
    this.sessionId = null;
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.initialized = false;
    this.tools = [];
    this.events = new EventEmitter();
  }

  get available() { return Boolean(this.url || this.command); }

  async close() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
  }

  async ensure() {
    if (this.initialized) return;
    if (!this.available) throw new McpError('No MCP URL or command is configured.');
    const result = await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'salesforce-api-qa-platform', version: '1.0.0' },
    });
    await this.notify('notifications/initialized', {});
    this.initialized = true;
    try {
      const listed = await this.call('tools/list', {});
      this.tools = (listed && listed.tools) || [];
    } catch {
      this.tools = [];
    }
    return result;
  }

  findTool(rx) {
    return this.tools.find((t) => rx.test(t.name) || rx.test(t.description || ''));
  }

  async callTool(name, args, opts = {}) {
    await this.ensure();
    return this.call('tools/call', { name, arguments: args || {} }, opts);
  }

  async call(method, params, opts = {}) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    const timeoutMs = opts.timeoutMs || this.timeoutMs;
    if (this.url) return this.http(msg, false, timeoutMs);
    return this.stdio(msg, timeoutMs);
  }

  async notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params };
    if (this.url) {
      try { await this.http(msg, true); } catch { /* notification */ }
      return;
    }
    this.writeStdio(msg);
  }

  async http(msg, notify = false, timeoutMs = this.timeoutMs) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let res;
    try {
      res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new McpError(explainNetworkError(e, this.url).title, { cause: e.message, action: 'Confirm the MCP server is running and the URL is reachable from this machine.' });
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const ct = String(res.headers.get('content-type') || '');
    const text = await res.text();
    if (notify) return null;
    let body;
    if (ct.includes('text/event-stream')) {
      const msgs = parseSseJson(text);
      body = msgs.find((m) => m.id === msg.id) || msgs[msgs.length - 1];
    } else {
      try { body = JSON.parse(text); } catch {
        throw new McpError('MCP server did not return JSON-RPC.', { evidence: [text.slice(0, 200)], action: 'Use a Streamable HTTP or JSON MCP endpoint.' });
      }
    }
    if (!res.ok && !body) throw new McpError(`MCP HTTP ${res.status}`, { evidence: [text.slice(0, 200)] });
    if (body && body.error) throw new McpError(body.error.message || 'MCP error', { evidence: [JSON.stringify(body.error).slice(0, 300)] });
    return body ? body.result : null;
  }

  ensureProcess() {
    if (this.proc) return;
    const parts = this.command.match(/(?:[^\s"]+|"[^"]*")+/g).map((p) => p.replace(/^"|"$/g, ''));
    const env = this.env ? { ...process.env, ...this.env } : process.env;
    this.proc = spawn(parts[0], parts.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.proc.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.proc.stderr.on('data', () => { /* MCP servers log on stderr; ignore */ });
    this.proc.on('exit', () => {
      this.proc = null;
      this.initialized = false;
      for (const [, { reject }] of this.pending) reject(new McpError('MCP process exited.'));
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const s = this.buf.toString('utf8');
      const headerEnd = s.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const header = s.slice(0, headerEnd);
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue; }
        const len = Number(m[1]);
        const start = headerEnd + 4;
        if (this.buf.length < start + len) return;
        const json = this.buf.subarray(start, start + len).toString('utf8');
        this.buf = this.buf.subarray(start + len);
        this.dispatch(json);
        continue;
      }
      const nl = s.indexOf('\n');
      if (nl === -1) return;
      const line = s.slice(0, nl).trim();
      this.buf = this.buf.subarray(nl + 1);
      if (line.startsWith('{')) this.dispatch(line);
    }
  }

  dispatch(json) {
    let msg;
    try { msg = JSON.parse(json); } catch { return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new McpError(msg.error.message || 'MCP error'));
    else p.resolve(msg.result);
  }

  writeStdio(msg) {
    this.ensureProcess();
    const payload = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.proc.stdin.write(payload);
  }

  stdio(msg, timeoutMs = this.timeoutMs) {
    this.ensureProcess();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new McpError(`MCP stdio timed out calling ${msg.method}.`, { action: 'Check that the MCP command starts a server on stdio.' }));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.writeStdio(msg);
    });
  }
}

function toolText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const content = result.content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text || JSON.stringify(c)).join('\n');
  }
  return JSON.stringify(result);
}

function toolJson(result) {
  const text = toolText(result);
  try { return JSON.parse(text); } catch { return result; }
}

module.exports = { McpClient, McpError, toolText, toolJson };
