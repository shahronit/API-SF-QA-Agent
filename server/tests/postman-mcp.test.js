'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-pm-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { repo, now } = require('../db');
const { exportCollection, exportEnvironment } = require('../engine/postman');
const {
  findNamedTool, pickId, mapMcpRunToResults, environmentPayload, withRuntimeSecrets, matchTestCase,
} = require('../engine/postman-mcp');
const { postmanFor } = require('../connectors');

const projectRow = (id = 'PRJ-PM') => ({
  id, name: 'Postman MCP Unit', description: '', environment: 'QA', apiVersion: '62.0',
  mode: 'demo', sfOrg: 'unit', jiraProjectKey: 'PM', status: 'active',
  instanceUrl: 'https://acme.my.salesforce.com',
  createdAt: now(), updatedAt: now(), integrationConfig: {},
});

const tests = [
  { id: 'TC-00001', title: 'Get limits', method: 'GET', endpoint: '/services/data/v{{apiVersion}}/limits', apiType: 'REST', testType: 'Functional', priority: 'P1', label: 'ASSUMED', seq: 1, status: 'ready', headers: {}, assertions: [{ type: 'status', op: 'lt', expected: 400 }], extract: [] },
  { id: 'TC-00002', title: 'Create Account', method: 'POST', endpoint: '/services/data/v{{apiVersion}}/sobjects/Account', apiType: 'REST', testType: 'Functional', priority: 'P0', label: 'ASSUMED', seq: 2, status: 'ready', headers: {}, body: { Name: 'X' }, assertions: [{ type: 'status', op: 'eq', expected: 201 }], extract: [] },
];

function mockClient(handlers = {}) {
  const calls = [];
  const tools = [
    { name: 'createCollection' }, { name: 'putCollection' }, { name: 'getCollections' }, { name: 'getCollection' },
    { name: 'createEnvironment' }, { name: 'putEnvironment' }, { name: 'getEnvironments' },
    { name: 'runCollection' }, { name: 'getWorkspaces' },
  ];
  const client = {
    available: true,
    tools,
    calls,
    ensure: async () => {},
    findTool(rx) { return tools.find((t) => rx.test(t.name)); },
    async callTool(name, args) {
      calls.push({ name, args });
      if (handlers[name]) return handlers[name](args, calls);
      if (name === 'getCollection') return { collection: { info: { name: args.collectionId, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] } };
      if (name === 'getCollections') return { collections: [] };
      if (name === 'getEnvironments') return { environments: [] };
      if (name === 'getWorkspaces') return { workspaces: [] };
      if (name === 'createCollection') return { collection: { id: '99-col', uid: '99-col', name: args.collection.info.name } };
      if (name === 'putCollection') return { collection: { id: args.collectionId } };
      if (name === 'createEnvironment') return { environment: { id: '99-env' } };
      if (name === 'putEnvironment') return { environment: { id: args.environmentId || '99-env' } };
      if (name === 'runCollection') {
        return {
          run: {
            executions: tests.map((tc) => ({
              item: { name: `${tc.id} ${tc.title}` },
              request: { method: tc.method, url: { raw: `{{baseUrl}}${tc.endpoint}` }, header: [{ key: 'Authorization', value: 'Bearer 00Dxx0000000001!secret.token.value.here' }] },
              response: { code: tc.method === 'POST' ? 201 : 200, responseTime: 12, header: [], body: { id: '001xx0000000001AAA', success: true } },
              assertions: [{ assertion: 'status', error: null }],
            })),
          },
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  return client;
}

test('findNamedTool prefers official Postman MCP names over fuzzy matches', () => {
  const client = { tools: [{ name: 'createCollectionFolder' }, { name: 'createCollection' }], findTool(rx) { return this.tools.find((t) => rx.test(t.name)); } };
  assert.equal(findNamedTool(client, 'createCollection').name, 'createCollection');
  assert.equal(pickId({ collection: { id: '12-abc' } }), '12-abc');
  assert.equal(pickId({ environment: { uid: 'e1' } }, ['id', 'uid', 'environmentId']), 'e1');
});

test('mapMcpRunToResults aligns Newman-style executions to test cases and masks tokens', () => {
  const raw = {
    run: {
      executions: [
        {
          item: { name: 'TC-00001 Get limits' },
          request: { method: 'GET', url: { raw: 'https://acme.my.salesforce.com/services/data/v62.0/limits' }, header: [{ key: 'Authorization', value: 'Bearer 00Dxx0000000001!AQEA.secret.token.value.here' }] },
          response: { code: 200, responseTime: 40, body: { DailyApiRequests: { Max: 15000 } } },
          assertions: [{ assertion: 'HTTP status < 400', error: null }],
        },
        {
          item: { name: 'TC-00001 ↳ Validate Account in Salesforce' },
          response: { code: 200, responseTime: 9, body: { records: [] } },
          assertions: [],
        },
        {
          item: { name: 'TC-00002 Create Account' },
          request: { method: 'POST', url: { raw: '{{baseUrl}}/services/data/v62.0/sobjects/Account' } },
          response: { code: 400, responseTime: 8, body: [{ errorCode: 'REQUIRED_FIELD_MISSING' }] },
          assertions: [{ assertion: 'status', error: { message: 'expected 201' } }],
        },
      ],
    },
  };
  const mapped = mapMcpRunToResults(raw, tests);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].status, 'passed');
  assert.equal(mapped[0].statusCode, 200);
  assert.equal(mapped[1].status, 'failed');
  assert.equal(mapped[1].statusCode, 400);
  const blob = JSON.stringify(mapped);
  assert.doesNotMatch(blob, /00Dxx0000000001!/);
  assert.doesNotMatch(blob, /AQEA\.secret/);
  assert.match(mapped[0].request.headers.Authorization, /••••|Bearer/);
});

test('mapMcpRunToResults blocks tests missing from MCP output', () => {
  const mapped = mapMcpRunToResults({ run: { executions: [{ item: { name: 'TC-00001 Get limits' }, response: { code: 200 }, assertions: [] }] } }, tests);
  assert.equal(mapped[0].status, 'passed');
  assert.equal(mapped[1].status, 'blocked');
});

test('matchTestCase reads the TC-id prefix used by exportCollection', () => {
  assert.equal(matchTestCase('TC-00002 Create Account', tests).id, 'TC-00002');
  assert.equal(matchTestCase('unrelated', tests), undefined);
});

test('environment payload keeps secrets empty; runtime inject is not persisted in export', () => {
  const env = exportEnvironment(projectRow());
  const empty = environmentPayload(env);
  assert.equal(empty.values.find((v) => v.key === 'accessToken').value, '');
  assert.equal(empty.values.find((v) => v.key === 'clientSecret').value, '');
  assert.equal(empty.values.find((v) => v.key === 'baseUrl').value, 'https://acme.my.salesforce.com');
  assert.doesNotMatch(empty.values.find((v) => v.key === 'baseUrl').value, /login\.salesforce\.com|lightning\.force\.com/);
  const live = withRuntimeSecrets(env, { accessToken: '00DxxSECRETTOKENVALUEHERE' });
  assert.equal(live.values.find((v) => v.key === 'accessToken').value, '00DxxSECRETTOKENVALUEHERE');
  assert.equal(environmentPayload(env).values.find((v) => v.key === 'accessToken').value, '');
});

test('exported collection has no secret values', () => {
  const col = exportCollection(projectRow(), tests);
  const text = JSON.stringify(col);
  assert.match(text, /\{\{accessToken\}\}/);
  assert.match(text, /\{\{baseUrl\}\}/);
  assert.doesNotMatch(text, /"clientSecret":\s*"[^"{]/);
  assert.doesNotMatch(text, /00D[A-Za-z0-9]+!/);
});

test('syncApproved creates then updates a Postman collection via documented MCP tools', async () => {
  const p = projectRow('PRJ-PM-SYNC');
  repo.insert('projects', p);
  const client = mockClient();
  const pm = postmanFor(p, { client });
  const first = await pm.syncApproved(tests);
  assert.equal(first.ok, true);
  assert.equal(first.mcp, true);
  assert.equal(first.collectionId, '99-col');
  assert.ok(client.calls.some((c) => c.name === 'createCollection'));
  const create = client.calls.find((c) => c.name === 'createCollection');
  assert.equal(create.args.collection.info.name.includes('Postman MCP Unit'), true);
  assert.doesNotMatch(JSON.stringify(create.args.collection), /"clientSecret":\s*"[^"{]/);

  p.integrationConfig = { postman: { collectionId: '99-col', environmentId: '99-env' } };
  const pm2 = postmanFor(p, { client });
  const second = await pm2.syncApproved(tests);
  assert.equal(second.ok, true);
  assert.ok(client.calls.some((c) => c.name === 'putCollection' && c.args.collectionId === '99-col'));
});

test('runApproved maps MCP results and wipes accessToken from the Postman environment', async () => {
  const p = projectRow('PRJ-PM-RUN');
  repo.insert('projects', p);
  tests.forEach((t, i) => repo.insert('test_cases', {
    ...t, projectId: p.id, scenarioId: null, storyKey: null, description: null, auth: 'default',
    query: {}, bodyRaw: null, extract: [], sfValidation: null, cleanup: null, timeoutMs: null,
    object: null, priorityReason: null, tags: [], automated: 1, createdAt: now(), updatedAt: now(),
    seq: i + 1,
  }));
  const client = mockClient();
  const pm = postmanFor(p, { client });
  const out = await pm.runApproved(tests, { accessToken: '00Dxx0000000001!RUNTIME.secret.token.value', runId: 'EX-1' });
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].status, 'passed');
  assert.doesNotMatch(JSON.stringify(out.results), /RUNTIME\.secret/);
  const envPuts = client.calls.filter((c) => c.name === 'putEnvironment' || c.name === 'createEnvironment');
  assert.ok(envPuts.length >= 2, 'runtime inject plus wipe');
  const last = envPuts[envPuts.length - 1];
  const tokenRow = (last.args.environment.values || []).find((v) => v.key === 'accessToken');
  assert.equal(tokenRow.value, '');
});

test('attachExisting links a collection so runApproved does not create a new one', async () => {
  const p = projectRow('PRJ-PM-ATTACH');
  repo.insert('projects', p);
  const existing = {
    info: { name: 'Storefront API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', _postman_id: 'col-existing-1' },
    item: [{ name: 'List products', request: { method: 'GET', url: 'https://shop.example/products', header: [] } }],
  };
  const client = mockClient({
    getCollection: () => ({ collection: { id: 'col-existing-1', ...existing } }),
    getCollections: () => ({ collections: [{ id: 'col-existing-1', uid: 'col-existing-1', name: 'Storefront API' }] }),
  });
  const pm = postmanFor(p, { client });
  const attached = await pm.attachExisting({ uid: 'col-existing-1', importTests: true });
  assert.equal(attached.ok, true);
  assert.equal(attached.reuseExisting, true);
  assert.equal(attached.collectionId, 'col-existing-1');
  assert.equal(attached.imported, 1);
  const again = await pm.attachExisting({ uid: 'col-existing-1', importTests: true });
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 1);
  const row = repo.get('projects', p.id);
  assert.equal(row.integrationConfig.postman.collectionId, 'col-existing-1');
  assert.equal(row.integrationConfig.postman.reuseExisting, true);

  const tcs = repo.find('test_cases', 'projectId = $p', { p: p.id });
  const runClient = mockClient();
  const pmRun = postmanFor(repo.get('projects', p.id), { client: runClient });
  const out = await pmRun.runApproved(tcs, { runId: 'EX-ATT' });
  assert.equal(out.collectionId, 'col-existing-1');
  assert.ok(!runClient.calls.some((c) => c.name === 'createCollection'));
  assert.ok(runClient.calls.some((c) => c.name === 'runCollection' && c.args.collectionId === 'col-existing-1'));
});

test('attachExisting from a collection file imports tests and marks reuseExisting', async () => {
  const p = projectRow('PRJ-PM-FILE');
  repo.insert('projects', p);
  const col = {
    info: { name: 'Imported BFF', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Health', request: { method: 'GET', url: 'https://bff.example/health', header: [] } }],
  };
  const pm = postmanFor(p, { client: { available: false, tools: [], ensure: async () => {}, findTool: () => null, callTool: async () => { throw new Error('no'); } } });
  const attached = await pm.attachExisting({ collection: col, importTests: true });
  assert.equal(attached.ok, true);
  assert.equal(attached.imported, 1);
  assert.match(attached.collectionId, /^imported:PRJ-PM-FILE:/);
  assert.equal(repo.get('projects', p.id).integrationConfig.postman.reuseExisting, true);
});

test('syncApproved without MCP still stores a local collection', async () => {
  const p = projectRow('PRJ-PM-LOCAL');
  repo.insert('projects', p);
  const client = { available: false, tools: [], ensure: async () => {}, findTool: () => null, callTool: async () => { throw new Error('no'); } };
  const pm = postmanFor(p, { client });
  const r = await pm.syncApproved(tests);
  assert.equal(r.ok, true);
  assert.equal(r.mcp, false);
  assert.match(r.notice, /Connect Postman MCP/);
  const stored = repo.find('collections', 'projectId = $p', { p: p.id });
  assert.ok(stored.length >= 1);
});

test('exportEnvironment includes Commerce organization_id', () => {
  const env = exportEnvironment({
    ...projectRow('PRJ-PM-CC'),
    mode: 'live',
    orgKind: 'sfcc-b2c',
    instanceUrl: null,
    integrationConfig: { commerce: { enabled: true, orgId: 'f_ecom_zzte_001' } },
  });
  assert.equal(env.values.find((v) => v.key === 'organization_id').value, 'f_ecom_zzte_001');
  assert.equal(env.values.find((v) => v.key === 'ccOrgId').value, 'f_ecom_zzte_001');
});

test('McpClient reports stderr when the process exits', async () => {
  const { McpClient } = require('../connectors/mcp');
  const client = new McpClient({
    command: 'sh -c "echo missing POSTMAN_API_KEY >&2; exit 1"',
    timeoutMs: 5000,
  });
  await assert.rejects(() => client.ensure(), (e) => {
    assert.match(e.message, /MCP process exited/);
    assert.match(e.message, /POSTMAN_API_KEY/);
    assert.match(String((e.explanation && e.explanation.action) || ''), /optional|POSTMAN_API_KEY/i);
    return true;
  });
});
