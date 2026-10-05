'use strict';
// Regression tests for Salesforce API-family behaviour: Bulk 2.0, Composite, GraphQL,
// SOAP, Tooling, OAuth, pagination, CSV assertions, Postman script fidelity,
// generated coverage and failure classification.
process.env.QA_DB_FILE = process.env.QA_DB_FILE || require('node:path').join(require('node:os').tmpdir(), `qa-sfapi-${process.pid}.db`);
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DemoSalesforce } = require('../connectors/demo-salesforce');
const csv = require('../lib/csv');
const { evaluate, compare } = require('../engine/assertions');
const { isModifying } = require('../engine/safety');
const { analyse, classify, CLASSIFICATIONS } = require('../engine/analyzer');
const { exportCollection, importCollection } = require('../engine/postman');
const { generateSuite } = require('../engine/generator');

const V = '/services/data/v62.0';
let n = 0;
const project = (extra = {}) => ({ id: `UT-${process.pid}-${++n}`, apiVersion: '62.0', mode: 'demo', environment: 'QA', businessConfig: { slaMs: 2000 }, integrationConfig: { endpoints: [] }, ...extra });
const json = { 'Content-Type': 'application/json' };
const org = () => {
  const sf = new DemoSalesforce(project());
  return {
    sf,
    call: (method, path, body, extra = {}) => sf.request({ method, path, body, headers: json, ...extra }),
    raw: (method, path, text, ct, extra = {}) => sf.request({ method, path, bodyRaw: text, headers: { 'Content-Type': ct }, ...extra }),
  };
};
const q = (soql) => `${V}/query?q=${encodeURIComponent(soql)}`;

test('csv: quoted cells, embedded commas/newlines and round trip', () => {
  const rows = [['a', 'b'], ['x,y', 'line1\nline2'], ['say "hi"', '']];
  const text = csv.stringify(rows);
  assert.deepEqual(csv.parseRows(text), rows);
  const parsed = csv.parse('Id,Name\r\n1,"A, Inc"\r\n\r\n2,B\r\n');
  assert.deepEqual(parsed.header, ['Id', 'Name']);
  assert.equal(parsed.records[0].Name, 'A, Inc');
  assert.equal(parsed.records.length, 2);
});

test('assertions: csv type reads rows, header and columns', () => {
  const res = { status: 200, headers: {}, body: 'sf__Id,sf__Created,Name\nA,true,x\nB,true,y\n', text: 'sf__Id,sf__Created,Name\nA,true,x\nB,true,y\n', timeMs: 5 };
  const out = evaluate([
    { type: 'csv', path: 'rows', op: 'eq', expected: 2 },
    { type: 'csv', path: 'header', op: 'contains', expected: 'sf__Id' },
    { type: 'csv', path: 'column:sf__Created', op: 'notContains', expected: 'false' },
    { type: 'csv', path: 'column:Missing', op: 'exists' },
  ], res);
  assert.deepEqual(out.map((a) => a.result), ['PASS', 'PASS', 'PASS', 'FAIL']);
  assert.match(out[3].message, /no column "Missing"/);
  assert.ok(compare('lte', 5, 5) && compare('gte', 5, 5) && !compare('gt', 5, 5));
});

test('postman: exported scripts compile and honour every operator (lte/gte/neq/lt on status)', () => {
  const tc = {
    id: 'TC-1', title: 't', method: 'GET', endpoint: `${V}/limits`, apiType: 'REST', testType: 'Functional', priority: 'P1', label: 'ASSUMED', headers: {}, extract: [],
    assertions: [
      { type: 'status', op: 'lt', expected: 400 }, { type: 'status', op: 'neq', expected: 500 }, { type: 'status', op: 'gte', expected: 200 },
      { type: 'jsonpath', path: '$.n', op: 'lte', expected: 3 }, { type: 'jsonpath', path: '$.n', op: 'gte', expected: 3 }, { type: 'jsonpath', path: '$.s', op: 'notContains', expected: 'bad' },
      { type: 'responseTime', op: 'lt', expected: 500 }, { type: 'header', name: 'x-a', op: 'notExists' }, { type: 'sfError', op: 'neq', expected: 'X' },
      { type: 'csv', path: 'column:a', op: 'contains', expected: '1' },
    ],
  };
  const col = exportCollection(project({ name: 'P', sfOrg: 'o', environment: 'QA' }), [tc]);
  const script = col.item[0].item ? col.item[0].item[0].event.find((e) => e.listen === 'test').script.exec.join('\n') : col.item[0].event.find((e) => e.listen === 'test').script.exec.join('\n');
  new Function('pm', script); // must at least parse
  assert.match(script, /to\.be\.below\(Number\(400\)\)/, 'status lt must not be exported as eql');
  assert.match(script, /to\.be\.at\.most\(Number\(3\)\)/);
  assert.match(script, /to\.be\.at\.least\(Number\(3\)\)/);
  assert.match(script, /to\.not\.eql\(500\)/);
  assert.doesNotMatch(script, /unsupported/i);
  // Run the generated script against a fake pm to prove the semantics, not only the syntax.
  const results = [];
  const body = { n: 3, s: 'good' };
  const expect = require('node:assert');
  const mk = (v) => {
    const api = {
      eql: (e) => expect.deepEqual(v, e), oneOf: (list) => expect.ok(list.includes(v)), include: (e) => expect.ok(String(v).includes(e)), match: (rx) => expect.match(v, rx),
      below: (e) => expect.ok(v < e), above: (e) => expect.ok(v > e), most: (e) => expect.ok(v <= e), least: (e) => expect.ok(v >= e), true: undefined, false: undefined,
    };
    const chain = { to: { be: { ...api, at: { most: api.most, least: api.least }, oneOf: api.oneOf }, eql: api.eql, include: api.include, match: api.match, not: { eql: (e) => expect.notDeepEqual(v, e), include: (e) => expect.ok(!String(v).includes(e)), be: { oneOf: (l) => expect.ok(!l.includes(v)) } } } };
    Object.defineProperty(chain.to.be, 'true', { get: () => expect.strictEqual(v, true) });
    Object.defineProperty(chain.to.be, 'false', { get: () => expect.strictEqual(v, false) });
    return chain;
  };
  const pm = {
    response: { code: 200, responseTime: 100, json: () => body, text: () => 'a\n1\n', headers: { get: () => undefined, has: () => false } },
    test: (name, fn) => { try { fn(); results.push([name, true]); } catch (e) { results.push([name, false, e.message]); } },
    expect: mk, collectionVariables: { get: () => undefined, set: () => {} }, request: {},
  };
  // pm.expect must build a fresh chain per call
  pm.expect = (v) => mk(v);
  new Function('pm', script)(pm);
  const failed = results.filter((r) => !r[1]);
  assert.deepEqual(failed, [], `exported assertions should all pass for a conforming response: ${JSON.stringify(failed)}`);
});

test('postman: imported default status assertion round-trips as "< 400", not "== 400"', () => {
  const drafts = importCollection({ info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'a', request: { method: 'GET', url: { raw: '{{baseUrl}}/services/data/v62.0/limits' } } }] });
  const a = drafts[0].assertions.find((x) => x.type === 'status');
  assert.equal(a.op, 'lt');
  const col = exportCollection(project({ name: 'P', sfOrg: 'o', environment: 'QA' }), [{ ...drafts[0], id: 'TC-9', priority: 'P2', testType: 'Functional', label: 'ASSUMED', extract: [] }]);
  const script = JSON.stringify(col);
  assert.match(script, /below\(Number\(400\)\)/);
});

test('simulator bulk 2.0: partial success, per-record results, lifecycle errors', async () => {
  const { call, raw } = org();
  const bad = await call('POST', `${V}/jobs/ingest`, { object: 'Nope__c', operation: 'insert' });
  assert.equal(bad.status, 400); assert.equal(bad.body[0].errorCode, 'INVALIDJOB');
  const noExt = await call('POST', `${V}/jobs/ingest`, { object: 'Contact', operation: 'upsert' });
  assert.equal(noExt.status, 400);

  const job = (await call('POST', `${V}/jobs/ingest`, { object: 'Contact', operation: 'insert' })).body;
  assert.equal(job.state, 'Open');
  const closeEmpty = await call('PATCH', `${V}/jobs/ingest/${job.id}`, { state: 'UploadComplete' });
  assert.equal(closeEmpty.status, 400, 'cannot close a job with no data');
  const wrongType = await raw('PUT', `${V}/jobs/ingest/${job.id}/batches`, 'LastName\nx\n', 'text/plain');
  assert.equal(wrongType.status, 415);
  const up = await raw('PUT', `${V}/jobs/ingest/${job.id}/batches`, 'FirstName,LastName,Email\nA,Good,good@example.com\nB,,missing@example.com\nC,Mail,not-an-email\n', 'text/csv');
  assert.equal(up.status, 201);
  const again = await raw('PUT', `${V}/jobs/ingest/${job.id}/batches`, 'LastName\nx\n', 'text/csv');
  assert.equal(again.status, 400, 'a second upload is rejected');
  assert.equal((await call('PATCH', `${V}/jobs/ingest/${job.id}`, { state: 'UploadComplete' })).body.state, 'UploadComplete');
  const done = (await call('GET', `${V}/jobs/ingest/${job.id}`)).body;
  assert.equal(done.state, 'JobComplete');
  assert.equal(done.numberRecordsProcessed, 3);
  assert.equal(done.numberRecordsFailed, 2);
  const ok = csv.parse((await call('GET', `${V}/jobs/ingest/${job.id}/successfulResults`)).body);
  assert.equal(ok.records.length, 1);
  assert.match(ok.records[0].sf__Id, /^[a-zA-Z0-9]{18}$/);
  assert.equal(ok.records[0].sf__Created, 'true');
  const fail = csv.parse((await call('GET', `${V}/jobs/ingest/${job.id}/failedResults`)).body);
  assert.deepEqual(fail.records.map((r) => r.sf__Error.split(':')[0]), ['REQUIRED_FIELD_MISSING', 'INVALID_EMAIL_ADDRESS']);
  assert.equal((await call('DELETE', `${V}/jobs/ingest/${job.id}`)).status, 204);
});

test('simulator bulk 2.0: upsert is idempotent; abort returns unprocessed rows', async () => {
  const { call, raw } = org();
  const runUpsert = async () => {
    const j = (await call('POST', `${V}/jobs/ingest`, { object: 'Account', operation: 'upsert', externalIdFieldName: 'External_Id__c' })).body;
    await raw('PUT', `${V}/jobs/ingest/${j.id}/batches`, 'External_Id__c,Name\nQA-UP-1,One\nQA-UP-2,Two\n', 'text/csv');
    await call('PATCH', `${V}/jobs/ingest/${j.id}`, { state: 'UploadComplete' });
    return csv.parse((await call('GET', `${V}/jobs/ingest/${j.id}/successfulResults`)).body).records;
  };
  assert.deepEqual((await runUpsert()).map((r) => r.sf__Created), ['true', 'true']);
  assert.deepEqual((await runUpsert()).map((r) => r.sf__Created), ['false', 'false']);
  assert.equal((await call('GET', q("SELECT Id FROM Account WHERE External_Id__c = 'QA-UP-1'"))).body.totalSize, 1, 'no duplicate created');

  const j = (await call('POST', `${V}/jobs/ingest`, { object: 'Contact', operation: 'insert' })).body;
  await raw('PUT', `${V}/jobs/ingest/${j.id}/batches`, 'LastName\nNever\n', 'text/csv');
  await call('PATCH', `${V}/jobs/ingest/${j.id}`, { state: 'UploadComplete' });
  assert.equal((await call('PATCH', `${V}/jobs/ingest/${j.id}`, { state: 'Aborted' })).body.state, 'Aborted');
  assert.match((await call('GET', `${V}/jobs/ingest/${j.id}/unprocessedrecords`)).body, /Never/);
  assert.equal((await call('GET', q("SELECT Id FROM Contact WHERE LastName = 'Never'"))).body.totalSize, 0);
});

test('simulator composite: allOrNone rolls back everything; references resolve array paths', async () => {
  const { call } = org();
  const count = async () => (await call('GET', q('SELECT COUNT() FROM Account'))).body.totalSize;
  const before = await count();
  const r = await call('POST', `${V}/composite`, { allOrNone: true, compositeRequest: [
    { method: 'POST', url: `${V}/sobjects/Account`, referenceId: 'a', body: { Name: 'Rolled back' } },
    { method: 'POST', url: `${V}/sobjects/Contact`, referenceId: 'c', body: { FirstName: 'no last name' } },
  ] });
  const [a, c] = r.body.compositeResponse;
  assert.equal(a.httpStatusCode, 400); assert.equal(a.body[0].errorCode, 'PROCESSING_HALTED');
  assert.equal(c.body[0].errorCode, 'REQUIRED_FIELD_MISSING');
  assert.equal(await count(), before, 'the earlier insert was rolled back');

  const ok = await call('POST', `${V}/composite`, { allOrNone: false, compositeRequest: [
    { method: 'GET', url: q('SELECT Id FROM Account LIMIT 1'), referenceId: 'q' },
    { method: 'GET', url: `${V}/sobjects/Account/@{q.records[0].Id}`, referenceId: 'g' },
  ] });
  assert.equal(ok.body.compositeResponse[1].httpStatusCode, 200);

  const graph = await call('POST', `${V}/composite/graph`, { graphs: [{ graphId: 'g', compositeRequest: [
    { method: 'POST', url: `${V}/sobjects/Account`, referenceId: 'a', body: { Name: 'Graph rolled back' } },
    { method: 'POST', url: `${V}/sobjects/Contact`, referenceId: 'c', body: {} },
  ] }] });
  assert.equal(graph.body.graphs[0].isSuccessful, false);
  assert.equal(await count(), before);

  const tooMany = await call('POST', `${V}/composite`, { compositeRequest: Array.from({ length: 26 }, (_, i) => ({ method: 'GET', url: `${V}/limits`, referenceId: `r${i}` })) });
  assert.equal(tooMany.status, 400);
  const dup = await call('POST', `${V}/composite`, { compositeRequest: [{ method: 'GET', url: `${V}/limits`, referenceId: 'x' }, { method: 'GET', url: `${V}/limits`, referenceId: 'x' }] });
  assert.equal(dup.status, 400);
});

test('simulator graphql: parser, validation errors, variables, pagination', async () => {
  const { call } = org();
  const gq = (query, variables) => call('POST', `${V}/graphql`, { query, variables });
  const good = await gq('query { uiapi { query { Account(first: 2, where: { Name: { like: "A%" } }) { totalCount pageInfo { hasNextPage endCursor } edges { node { Id Name { value } Owner { Name { value } } } } } } } }');
  assert.deepEqual(good.body.errors, []);
  const acc = good.body.data.uiapi.query.Account;
  assert.equal(acc.edges.length, 1); assert.equal(acc.totalCount, 1);
  assert.equal(acc.edges[0].node.Name.value, 'Acme Corporation');
  assert.equal(acc.edges[0].node.Owner.Name.value, 'QA Integration User');

  const page1 = (await gq('query { uiapi { query { Case(first: 4) { totalCount pageInfo { hasNextPage endCursor } edges { node { Id } } } } } }')).body.data.uiapi.query.Case;
  assert.equal(page1.edges.length, 4); assert.equal(page1.pageInfo.hasNextPage, true);
  const page2 = (await gq(`query { uiapi { query { Case(first: 4, after: "${page1.pageInfo.endCursor}") { pageInfo { hasNextPage } edges { node { Id } } } } } }`)).body.data.uiapi.query.Case;
  assert.equal(page2.edges.length, 2); assert.equal(page2.pageInfo.hasNextPage, false);

  const withVar = await gq('query Q($n: Int = 1) { uiapi { query { Account(first: $n) { edges { node { Id } } } } } }', { n: 2 });
  assert.equal(withVar.body.data.uiapi.query.Account.edges.length, 2);

  const expectError = async (query, re, type) => { const r = await gq(query); assert.equal(r.body.data, null); assert.match(r.body.errors[0].message, re); if (type) assert.equal(r.body.errors[0].extensions.ErrorType, type); };
  await expectError('query { uiapi { query { Account { edges { node { Bogus__c { value } } } } } } }', /Bogus__c/);
  await expectError('query { uiapi { query { Ghost__c { edges { node { Id } } } } } }', /Ghost__c/);
  await expectError('query { uiapi { query { Account { edges { node { Name } } } } } }', /Subselection required/);
  await expectError('query { uiapi { query { Account(first: 0) { edges { node { Id } } } } } }', /first/);
  await expectError('query { uiapi { query { Account(first: 5000) { edges { node { Id } } } } } }', /first/);
  await expectError('query { uiapi { query { Account( { } }', /Invalid Syntax/, 'InvalidSyntax');
  await expectError('mutation { uiapi { x } }', /not supported/);
  await expectError('query { Account { edges { node { Id } } } }', /uiapi/);
  assert.equal((await call('POST', `${V}/graphql`, {})).status, 400);

  const low = await call('POST', `${V}/graphql`, { query: 'query { uiapi { query { Invoice__c { edges { node { Id } } } } } }' }, { auth: 'lowpriv' });
  assert.match(low.body.errors[0].message, /Invoice__c/, 'objects the low-privilege user cannot see are undefined');
  const hidden = await call('POST', `${V}/graphql`, { query: 'query { uiapi { query { Account { edges { node { AnnualRevenue { value } } } } } } }' }, { auth: 'lowpriv' });
  assert.match(hidden.body.errors[0].message, /AnnualRevenue/, 'field-level security hides fields');
});

test('simulator query pagination, SOQL operators and totalSize after LIMIT', async () => {
  const { sf, call } = org();
  const page = await sf.request({ method: 'GET', path: `${V}/query`, query: { q: 'SELECT Id FROM Case' }, headers: { 'Sforce-Query-Options': 'batchSize=4' } });
  assert.equal(page.body.totalSize, 6); assert.equal(page.body.done, false); assert.equal(page.body.records.length, 4);
  const next = await call('GET', page.body.nextRecordsUrl);
  assert.equal(next.body.records.length, 2); assert.equal(next.body.done, true);
  const gone = await call('GET', page.body.nextRecordsUrl);
  assert.equal(gone.body[0].errorCode, 'INVALID_QUERY_LOCATOR', 'a locator is consumed after the last page');
  const limited = await call('GET', q('SELECT Id FROM Account LIMIT 1'));
  assert.equal(limited.body.totalSize, 1);
  assert.equal((await call('GET', q('SELECT Id FROM Account WHERE AnnualRevenue >= 25000000'))).body.totalSize, 1);
  assert.equal((await call('GET', q('SELECT Id FROM Account WHERE AnnualRevenue <= 25000000'))).body.totalSize, 1);
  assert.equal((await call('POST', `${V}/query`, {})).status, 405);
});

test('simulator soap, tooling and oauth contracts', async () => {
  const { call, raw } = org();
  const env = (body, session = 'abc') => `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">${session ? `<soapenv:Header><urn:SessionHeader><urn:sessionId>${session}</urn:sessionId></urn:SessionHeader></soapenv:Header>` : ''}<soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
  const soap = (body, session) => raw('POST', '/services/Soap/u/62.0', env(body, session), 'text/xml', { apiType: 'SOAP' });
  const login = await soap('<urn:login><urn:username>qa@example.com</urn:username><urn:password>pw</urn:password></urn:login>', null);
  assert.equal(login.status, 200); assert.match(login.text, /<sessionId>/);
  const badLogin = await soap('<urn:login><urn:username>invalid</urn:username><urn:password>x</urn:password></urn:login>', null);
  assert.equal(badLogin.status, 500); assert.match(badLogin.text, /INVALID_LOGIN/);
  const qr = await soap('<urn:query><urn:queryString>SELECT Id, Name FROM Account LIMIT 2</urn:queryString></urn:query>');
  assert.equal(qr.status, 200); assert.match(qr.text, /<size>2<\/size>/);
  const qf = await soap('<urn:query><urn:queryString>SELECT Bogus FROM Account</urn:queryString></urn:query>');
  assert.equal(qf.status, 500); assert.match(qf.text, /INVALID_FIELD/);
  assert.match((await soap('<urn:getServerTimestamp/>', 'INVALID_SESSION')).text, /INVALID_SESSION_ID/);
  assert.match((await raw('POST', '/services/Soap/u/62.0', 'not xml', 'text/xml', { apiType: 'SOAP' })).text, /Fault/);

  const tool = (query) => call('GET', `${V}/tooling/query?q=${encodeURIComponent(query)}`);
  assert.equal((await tool('SELECT Id, Name FROM ApexClass LIMIT 2')).body.records.length, 2);
  assert.equal((await tool('SELECT Id FROM Nope')).body[0].errorCode, 'INVALID_TYPE');
  assert.equal((await tool('SELECT FROM')).body[0].errorCode, 'MALFORMED_QUERY');

  const token = (text) => raw('POST', '/services/oauth2/token', text, 'application/x-www-form-urlencoded', { auth: 'none' });
  assert.equal((await token('grant_type=qa_not_a_grant&client_id=x')).body.error, 'unsupported_grant_type');
  assert.equal((await token('client_id=x')).body.error, 'unsupported_grant_type');
  assert.equal((await token('grant_type=client_credentials&client_id=invalid&client_secret=invalid')).body.error, 'invalid_client_id');
  assert.equal((await token('grant_type=client_credentials&client_id=abc&client_secret=def')).status, 200);
});

test('safety: SOAP reads, GET-only composite and GraphQL queries are not production writes', () => {
  const soapBody = (inner) => `<soapenv:Envelope><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
  assert.equal(isModifying({ method: 'POST', endpoint: '/services/Soap/u/{{apiVersion}}', bodyRaw: soapBody('<urn:query><urn:queryString>SELECT Id FROM Account</urn:queryString></urn:query>') }), false);
  assert.equal(isModifying({ method: 'POST', endpoint: '/services/Soap/u/62.0', bodyRaw: soapBody('<urn:getServerTimestamp/>') }), false);
  assert.equal(isModifying({ method: 'POST', endpoint: '/services/Soap/u/62.0', bodyRaw: soapBody('<urn:delete><urn:ids>001</urn:ids></urn:delete>') }), true);
  assert.equal(isModifying({ method: 'POST', endpoint: '/services/Soap/u/62.0', bodyRaw: soapBody('<urn:create/>') }), true, 'unknown/unrecognised calls stay protected');
  assert.equal(isModifying({ method: 'POST', endpoint: `${V}/composite`, body: { compositeRequest: [{ method: 'GET', url: 'x', referenceId: 'a' }] } }), false);
  assert.equal(isModifying({ method: 'POST', endpoint: `${V}/composite`, body: { compositeRequest: [{ method: 'GET', url: 'x', referenceId: 'a' }, { method: 'DELETE', url: 'x', referenceId: 'b' }] } }), true);
  assert.equal(isModifying({ method: 'POST', endpoint: `${V}/jobs/ingest`, body: { object: 'Account', operation: 'delete' } }), true);
});

test('analyzer: failures map onto the eleven plan classifications with impact and retest', () => {
  assert.equal(CLASSIFICATIONS.length, 11);
  const base = { status: 'failed', title: 'Create Contact', method: 'POST', endpoint: '/x', priority: 'P1', response: { status: 400, body: [] }, assertions: [] };
  const tc = { id: 'TC-7', object: 'Contact', priority: 'P1', tags: [] };
  const mk = (r, t = tc) => analyse({ ...base, ...r }, t);
  const cases = [
    [{ response: { status: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'm' }] }, assertions: [{ type: 'status', result: 'FAIL', expected: 201, actual: 400, check: 's', message: 'x' }] }, 'Test Data Issue'],
    [{ response: { status: 401, body: [{ errorCode: 'INVALID_SESSION_ID', message: 'm' }] }, assertions: [{ type: 'status', result: 'FAIL', expected: 200, actual: 401, check: 's', message: 'x' }] }, 'Authentication Issue'],
    [{ response: { status: 403, body: [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'm' }] }, assertions: [{ type: 'status', result: 'FAIL', expected: 200, actual: 403, check: 's', message: 'x' }] }, 'Authorization Issue'],
    [{ response: { status: 500, body: [{ errorCode: 'APEX_ERROR', message: 'System.NullPointerException: x' }] }, assertions: [{ type: 'status', result: 'FAIL', expected: 201, actual: 500, check: 's', message: 'x' }] }, 'Application Defect'],
    [{ response: { status: 503, body: [{ errorCode: 'SERVER_UNAVAILABLE', message: 'maintenance' }] }, assertions: [{ type: 'status', result: 'FAIL', expected: 200, actual: 503, check: 's', message: 'x' }] }, 'Environment Issue'],
    [{ response: { status: 504, body: [{ errorCode: 'GATEWAY', message: 'CalloutException: Read timed out' }] }, assertions: [{ type: 'status', result: 'FAIL', expected: 200, actual: 504, check: 's', message: 'x' }] }, 'External Dependency Issue'],
    [{ response: { status: 200, body: {} }, assertions: [{ type: 'responseTime', result: 'FAIL', expected: 2000, actual: 3000, check: 'rt', message: 'slow' }] }, 'Performance Issue'],
    [{ response: { status: 200, body: {} }, assertions: [{ type: 'schema', result: 'FAIL', check: 'schema', message: 'bad' }] }, 'API Contract Issue'],
    [{ response: { status: 200, body: [{ errorCode: 'X', message: 'm' }] }, assertions: [{ type: 'sfError', result: 'FAIL', expected: 'A', actual: 'B', check: 'e', message: 'x' }] }, 'API Contract Issue'],
    [{ response: { status: 204, body: undefined }, sfValidation: { status: 'FAIL', object: 'Account', comparisons: [{ field: 'Rating', expected: 'Hot', actual: 'Warm', match: false }] } }, 'Salesforce Automation Issue'],
    [{ response: { status: 200, body: {} }, sfValidation: { status: 'FAIL', object: 'Contact', comparisons: [{ field: 'Email', expected: 'a', actual: null, match: false }] } }, 'Integration Issue', { id: 'TC-8', tags: [], sfValidation: { mappingCheck: true } }],
    [{ response: { status: 200, body: {} }, assertions: [{ type: 'status', result: 'FAIL', expected: 401, actual: 200, check: 's', message: 'x' }] }, 'Authentication Issue', { id: 'TC-9', tags: ['authentication'] }],
    [{ response: { status: 400, body: [{ errorCode: 'API_DISABLED_FOR_ORG', message: 'm' }] }, assertions: [{ type: 'status', result: 'FAIL', expected: 200, actual: 400, check: 's', message: 'x' }] }, 'Salesforce Configuration Issue'],
  ];
  for (const [r, expected, t] of cases) {
    const a = mk(r, t);
    assert.equal(a.classification, expected, `${JSON.stringify(r.response)} → ${a.classification}`);
    assert.ok(CLASSIFICATIONS.includes(a.classification));
    for (const k of ['failure', 'impact', 'recommendation', 'retest', 'rootCause']) assert.ok(a[k] && a[k].length > 5, `${expected} has ${k}`);
    assert.ok(Array.isArray(a.evidence));
    assert.match(a.retest, /Re-run/);
  }
  assert.equal(analyse({ status: 'passed' }, tc), null);
  const blocked = analyse({ status: 'blocked', title: 'x', error: { title: 'Prod', category: 'safety', evidence: [], action: 'confirm' } }, tc);
  assert.equal(blocked.classification, null, 'policy blocks are not failures');
  assert.equal(classify({ category: 'Assertion failure' }, base, tc), 'API Contract Issue', 'unexplained assertion mismatch is not blindly an application defect');
});

test('generator: story text selects Bulk, Composite, GraphQL, SOAP, Tooling, Platform Event, OAuth and pagination coverage', async () => {
  const p = project();
  const sf = new DemoSalesforce(p);
  const gen = async (summary, description, proj = p) => generateSuite({ project: proj, story: { key: 'UT-1', summary, description, acceptanceCriteria: '' }, sf });
  const flat = (r) => r.scenarios.flatMap((s) => s.testCases);
  const hasTest = (r, rx) => flat(r).some((t) => rx.test(t.title));

  const bulk = await gen('Bulk load Contacts', 'Load Contact records with a Bulk API 2.0 CSV job. Invalid rows are reported.');
  assert.ok(bulk.analysis.apiTypes.includes('Bulk API 2.0'));
  assert.ok(hasTest(bulk, /Create a Bulk API 2\.0 insert job/) && hasTest(bulk, /failedResults reports the invalid row/) && hasTest(bulk, /Uploading data with a non-CSV Content-Type/));
  const upload = flat(bulk).find((t) => t.method === 'PUT');
  assert.equal(upload.headers['Content-Type'], 'text/csv');
  assert.ok(upload.bodyRaw.split('\n')[0].includes('LastName'));
  assert.ok(flat(bulk).some((t) => t.cleanup && t.cleanup.fromBulkResults), 'bulk-inserted records are cleaned up');
  assert.ok(flat(bulk).find((t) => /Job completes/.test(t.title)).tags.includes('poll'), 'async job status is polled on live orgs');

  const comp = await gen('Create an Account in a single request with the composite API', 'Use composite with all or none transaction semantics and composite graph.');
  assert.ok(hasTest(comp, /allOrNone=true rolls everything back/) && hasTest(comp, /Rolled-back record was not persisted/) && hasTest(comp, /Composite Graph/) && hasTest(comp, /more than 25 subrequests/));

  const gql = await gen('Query Accounts using the GraphQL API', 'Query Account through GraphQL with pagination.');
  assert.ok(hasTest(gql, /Unknown field returns a GraphQL validation error/) && hasTest(gql, /first: 1/));

  const soap = await gen('Query Accounts via the SOAP API', 'The middleware uses SOAP to query Account data. The Tooling API lists Apex classes.');
  assert.ok(hasTest(soap, /getServerTimestamp/) && hasTest(soap, /INVALID_SESSION_ID fault/) && hasTest(soap, /Query ApexClass metadata/));

  const pe = await gen('Publish Order_Event__e platform event', 'Publish the Order_Event__e platform event for order status.');
  assert.ok(hasTest(pe, /Publish a valid Order_Event__e event/) && hasTest(pe, /without required/));
  assert.ok(pe.analysis.gaps.some((g) => /subscribers/.test(g.text)), 'subscriber-side delivery is flagged as not verifiable over REST');

  const auth = await gen('OAuth connected app and Case pagination', 'The connected app uses OAuth client credentials. Support pagination (nextRecordsUrl) on Case queries. Chatter current user loads.');
  assert.ok(hasTest(auth, /Unsupported grant_type is rejected/) && hasTest(auth, /invalid query locator/i) && hasTest(auth, /Get the current user/));
  for (const r of [bulk, comp, gql, soap, pe, auth]) for (const t of flat(r)) {
    assert.ok(t.assertions.some((a) => a.type === 'status') || t.status === 'draft', `${t.title} asserts a status`);
    assert.ok(!/Bearer\s+[A-Za-z0-9]{20,}|client_secret=(?!invalid|\{\{|&|$|")[^&"]+/.test(JSON.stringify(t)), `${t.title} contains no secrets`);
  }

  // Production gets read-only coverage only.
  const prodProject = project({ environment: 'Production' });
  const prodBulk = await gen('Bulk load Contacts', 'Load Contact records with a Bulk API 2.0 CSV job. Also composite and GraphQL.', prodProject);
  assert.ok(!flat(prodBulk).some((t) => /jobs\/ingest/.test(t.endpoint)), 'no Bulk write tests in Production');
  assert.ok(prodBulk.analysis.gaps.some((g) => /Production project: Bulk API 2\.0/.test(g.text)));
  for (const t of flat(prodBulk)) {
    if (/composite|graphql/.test(t.endpoint)) assert.ok(!isModifying({ method: t.method, endpoint: t.endpoint, body: t.body }) || /sobjects/.test(JSON.stringify(t.body || {})) === false, `production composite test ${t.title} must be read-only`);
  }
});
