'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskDeep, maskText, maskHeaders, registerSecrets, MASK } = require('../lib/mask');
const { interpolate, getPath, dynamicValue } = require('../lib/template');
const { validate } = require('../lib/jsonschema');
const { parseYaml } = require('../lib/yaml');
const { createZip, crc32 } = require('../lib/zip');
const { buildXlsx } = require('../lib/xlsx');
const { PdfDoc } = require('../lib/pdf');
const { explainResponse } = require('../lib/errors');

test('masking: sensitive keys, tokens, session ids, SOAP and literal secrets', () => {
  const out = maskDeep({ password: 'hunter22', client_secret: 'abc123xyz', nested: { access_token: 'tok_1234567890' }, Authorization: 'Bearer 00Dxx0000001gPL!AQ4AQFakeSessionTokenValue1234567890', safe: 'hello' });
  assert.equal(out.password, MASK);
  assert.equal(out.client_secret, MASK);
  assert.equal(out.nested.access_token, MASK);
  assert.equal(out.Authorization, MASK);
  assert.equal(out.safe, 'hello');
  assert.ok(!maskText('session 00Dxx0000001gPL!AQ4AQFakeSessionTokenValue1234567890 here').includes('AQ4AQ'));
  assert.ok(!maskText('Authorization: Bearer abcdefghijklmnop123').includes('abcdefghijklmnop123'));
  assert.ok(!maskText('<sessionId>SECRETSESSION</sessionId>').includes('SECRETSESSION'));
  assert.ok(!maskText('grant_type=password&client_secret=s3cr3tValue&x=1').includes('s3cr3tValue'));
  assert.ok(!maskText('ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz').includes('abcdefghijklmnop'));
  registerSecrets(['very-literal-secret-value']);
  assert.ok(!maskText('oops very-literal-secret-value leaked').includes('very-literal'));
  registerSecrets([]);
});

test('masking: template references are preserved and assertion descriptions are not masked', () => {
  assert.equal(maskDeep({ Authorization: 'Bearer {{accessToken}}' }).Authorization, 'Bearer {{accessToken}}');
  assert.equal(maskDeep({ check: 'HTTP status equals 201' }).check, 'HTTP status equals 201');
  const h = maskHeaders({ authorization: 'Bearer abcdefghijklmnopqrstu', 'content-type': 'application/json' });
  assert.equal(h['content-type'], 'application/json');
  assert.notEqual(h.authorization, 'Bearer abcdefghijklmnopqrstu');
});

test('template: interpolation, missing vars, JSONPath and dynamic values', () => {
  const missing = new Set();
  assert.deepEqual(interpolate({ a: '{{x}}', b: 'v{{apiVersion}}', c: '{{nope}}' }, { x: 5, apiVersion: '62.0' }, missing), { a: 5, b: 'v62.0', c: '{{nope}}' });
  assert.ok(missing.has('nope'));
  assert.equal(getPath({ records: [{ Id: '001' }, { Id: '002' }] }, '$.records[1].Id'), '002');
  assert.equal(getPath({ records: [1, 2, 3] }, '$.records.length'), 3);
  assert.deepEqual(getPath({ hits: [{ product_id: 'a' }, { product_id: 'b' }] }, '$.hits[*].product_id'), ['a', 'b']);
  assert.match(String(dynamicValue('$uuid')), /^[0-9a-f-]{36}$/);
  assert.match(String(dynamicValue('$randomEmail')), /@/);
});

test('jsonschema: required, type, enum, pattern', () => {
  const schema = { type: 'object', required: ['status', 'id'], properties: { status: { type: 'string', enum: ['SUCCESS'] }, id: { type: 'string', pattern: '^[a-zA-Z0-9]{18}$' } } };
  assert.equal(validate(schema, { status: 'SUCCESS', id: 'a0B5g00000000AAAAA' }).length, 0);
  const errs = validate(schema, { status: 'FAIL', id: 'short' });
  assert.ok(errs.some((e) => e.rule === 'enum'));
  assert.ok(errs.some((e) => e.rule === 'pattern'));
  assert.ok(validate(schema, {}).some((e) => e.rule === 'required'));
});

test('yaml: nested maps, lists and flow values', () => {
  const y = parseYaml('openapi: 3.0.3\ninfo:\n  title: Demo\n  version: "1.0"\npaths:\n  /x:\n    get:\n      responses:\n        "200":\n          description: ok\ntags: [a, b]\nlist:\n  - one\n  - two\n');
  assert.equal(y.openapi, '3.0.3');
  assert.equal(y.info.version, '1.0');
  assert.equal(y.paths['/x'].get.responses['200'].description, 'ok');
  assert.deepEqual(y.tags, ['a', 'b']);
  assert.deepEqual(y.list, ['one', 'two']);
});

test('zip / xlsx / pdf writers produce valid containers', () => {
  assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
  const zip = createZip([{ name: 'a.txt', data: Buffer.from('hi') }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const x = buildXlsx([{ name: 'Results', rows: [['A', 'B'], [1, '=cmd']] }]);
  assert.equal(x.readUInt32LE(0), 0x04034b50);
  const pdf = new PdfDoc(); pdf.page(); pdf.text(40, 40, 'Hello report'); const b = pdf.toBuffer();
  assert.equal(b.subarray(0, 5).toString(), '%PDF-');
  assert.ok(b.subarray(-6).toString().includes('%%EOF'));
});

test('errors: Salesforce error codes become actionable explanations', () => {
  const e = explainResponse({ status: 401, body: [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }], method: 'GET', url: '/x' });
  assert.equal(e.code, 'INVALID_SESSION_ID');
  assert.ok(e.cause && e.action);
  const r = explainResponse({ status: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]', fields: ['LastName'] }], method: 'POST', url: '/x' });
  assert.ok(/LastName/.test(JSON.stringify(r)));
});
