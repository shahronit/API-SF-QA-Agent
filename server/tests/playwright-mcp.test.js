'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-pw-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { playwrightFor, parseResult } = require('../connectors/playwright');

function mockClient(handlers = {}) {
  const calls = [];
  const tools = [
    { name: 'playwright_get' }, { name: 'playwright_post' }, { name: 'playwright_put' },
    { name: 'playwright_patch' }, { name: 'playwright_delete' },
  ];
  return {
    available: true,
    tools,
    calls,
    ensure: async () => {},
    findTool(rx) { return tools.find((t) => rx.test(t.name)); },
    async callTool(name, args) {
      calls.push({ name, args });
      if (handlers[name]) return handlers[name](args, calls);
      if (name === 'playwright_get') return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 200, responseData: { ok: true } }) }] };
      if (name === 'playwright_post') return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 201, responseData: { id: '001xx' } }) }] };
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

const project = {
  id: 'PRJ-PW', name: 'Playwright unit', environment: 'QA', mode: 'live', apiVersion: '62.0',
  instanceUrl: 'https://acme.my.salesforce.com',
  integrationConfig: { playwright: { mcpCommand: 'npx -y @executeautomation/playwright-mcp-server' }, http: { baseUrl: 'https://api.shop.example' } },
};

test('parseResult reads ExecuteAutomation statusCode + responseData', () => {
  const r = parseResult({ content: [{ type: 'text', text: JSON.stringify({ statusCode: 201, responseData: { id: 'x' } }) }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 'x');
});

test('playwright GET uses playwright_get with bearer token and absolute Salesforce URL', async () => {
  const client = mockClient();
  const pw = playwrightFor(project, { client });
  const res = await pw.request({
    method: 'GET', path: '/services/data/v62.0/limits',
    headers: { Authorization: 'Bearer secret.token.value' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.executor, 'playwright-mcp');
  assert.equal(client.calls[0].name, 'playwright_get');
  assert.equal(client.calls[0].args.url, 'https://acme.my.salesforce.com/services/data/v62.0/limits');
  assert.equal(client.calls[0].args.token, 'secret.token.value');
  assert.ok(!client.calls[0].args.headers.Authorization);
});

test('playwright POST sends JSON body on frontend HTTP origin', async () => {
  const client = mockClient();
  const pw = playwrightFor(project, { client });
  const res = await pw.request({ method: 'POST', path: '/v1/orders', body: { sku: 'A' }, apiType: 'HTTP' });
  assert.equal(res.status, 201);
  assert.equal(client.calls[0].name, 'playwright_post');
  assert.equal(client.calls[0].args.url, 'https://api.shop.example/v1/orders');
  assert.equal(client.calls[0].args.value, JSON.stringify({ sku: 'A' }));
});

test('testConnection reports HTTP methods when tools exist', async () => {
  const pw = playwrightFor(project, { client: mockClient() });
  const t = await pw.testConnection();
  assert.equal(t.ok, true);
  assert.ok(t.tools.includes('GET'));
  assert.ok(t.tools.includes('POST'));
});

test('unavailable when no MCP URL or command is configured', () => {
  const pw = playwrightFor({ id: 'PRJ-X', mode: 'live', integrationConfig: {} });
  assert.equal(pw.canExecute, false);
  assert.equal(pw.unavailableExplanation().code, 'PLAYWRIGHT_MCP_UNAVAILABLE');
});
