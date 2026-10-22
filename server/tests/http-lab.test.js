'use strict';
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-http-lab-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, snippets } = require('../engine/curl');
const cookies = require('../engine/cookie-jar');
const body = require('../engine/body-encode');
const sandbox = require('../engine/script-sandbox');
const grpc = require('../engine/grpc-unary');
const envs = require('../engine/environments');

test('cURL parser extracts method, URL, headers and JSON body', () => {
  const r = parse(`curl -X POST 'https://api.example.com/v1/items?q=a' -H 'Authorization: Bearer tok' -H 'Content-Type: application/json' --data-raw '{"n":1}'`);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.example.com/v1/items');
  assert.equal(r.query[0].key, 'q');
  assert.equal(r.headerRows[0].key, 'Authorization');
  assert.equal(r.auth, 'bearer');
  assert.equal(r.bodyMode, 'json');
  assert.equal(JSON.parse(r.body).n, 1);
});

test('cURL snippets include curl, fetch, python and node', () => {
  const s = snippets({ method: 'GET', url: 'https://ex.test/x', headers: [{ key: 'Accept', value: 'application/json', enabled: true }] });
  assert.match(s.curl, /curl -X GET/);
  assert.match(s.fetch, /fetch\(/);
  assert.match(s.python, /requests/);
  assert.match(s.node, /require\('node:https'\)/);
});

test('cookie domain and path matching', () => {
  assert.equal(cookies.hostMatches('example.com', 'api.example.com'), true);
  assert.equal(cookies.hostMatches('example.com', 'evil.com'), false);
  assert.equal(cookies.pathMatches('/api', '/api/v1'), true);
  assert.equal(cookies.pathMatches('/api', '/other'), false);
  const c = cookies.parseSetCookie('sid=abc; Domain=.example.com; Path=/; HttpOnly; Secure');
  assert.equal(c.name, 'sid');
  assert.equal(c.httpOnly, 1);
  assert.equal(c.secure, 1);
});

test('body encode urlencoded, graphql and json', () => {
  const u = body.encode('urlencoded', { form: [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: 'x', enabled: false }] });
  assert.equal(u.body, 'a=1');
  const g = body.encode('graphql', { graphql: { query: '{ ping }', variables: { n: 1 } } });
  assert.equal(JSON.parse(g.body).query, '{ ping }');
  const j = body.encode('json', { body: { ok: true } });
  assert.equal(JSON.parse(j.body).ok, true);
});

test('script sandbox pm.test and pm.expect', async () => {
  const r = await sandbox.runScript(`
    pm.environment.set('id', '42');
    pm.test('math', () => { pm.expect(1 + 1).to.eql(2); });
    pm.test('fail', () => { pm.expect(true).to.eql(false); });
    console.log('hi');
  `, { eventName: 'test', environment: {}, variables: {}, request: { method: 'GET', url: 'https://x' }, response: { status: 200, statusText: 'OK', headers: {}, body: { ok: true }, text: '{"ok":true}', timeMs: 3 } });
  assert.equal(r.environment.id, '42');
  assert.equal(r.tests[0].passed, true);
  assert.equal(r.tests[1].passed, false);
  assert.equal(r.logs.some((l) => l.message === 'hi'), true);
});

test('grpc proto parser lists unary methods', () => {
  const p = grpc.parseProto(`
    syntax = "proto3";
    package hello;
    service Greeter {
      rpc SayHello (HelloRequest) returns (HelloReply);
      rpc StreamHi (stream HelloRequest) returns (HelloReply);
    }
    message HelloRequest { string name = 1; }
    message HelloReply { string message = 1; }
  `);
  assert.equal(p.package, 'hello');
  assert.equal(p.services[0].methods[0].name, 'SayHello');
  assert.equal(p.services[0].methods[1].requestStream, true);
  const buf = grpc.encodeMessage(p.messages.HelloRequest, { name: 'QA' });
  const decoded = grpc.decodeMessage(p.messages.HelloRequest, buf);
  assert.equal(decoded.name, 'QA');
});

test('environment value normalisation skips empty keys and respects enabled', () => {
  const rows = envs.normalizeValues([{ key: 'a', value: '1' }, { key: '', value: 'x' }, { key: 'b', value: '2', enabled: false }]);
  const map = envs.valuesToMap(rows);
  assert.equal(map.a, '1');
  assert.equal(map.b, undefined);
});
