'use strict';
/**
 * Postman collection v2.1 import/export, environment export and Newman runs.
 * Exports never contain secrets: credentials are environment variables
 * ({{clientId}}, {{clientSecret}}, {{accessToken}}) with empty values.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { config } = require('../config');
const { maskDeep } = require('../lib/mask');

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function toPostmanVars(s) {
  return String(s)
    .replace(/\{\{\$uuid\}\}/g, '{{$guid}}')
    .replace(/\{\{\$randomString:(\d+)\}\}/g, (_, n) => `{{qaRandomString_${n}}}`)
    .replace(/\{\{\$isoTimestamp\}\}/g, '{{$isoTimestamp}}')
    .replace(/\{\{\$randomName\}\}/g, '{{$randomFullName}}');
}

function rawBody(tc) {
  if (tc.bodyRaw) return toPostmanVars(tc.bodyRaw);
  if (tc.body === undefined || tc.body === null) return null;
  return toPostmanVars(JSON.stringify(tc.body, null, 2));
}

function urlObject(tc) {
  const ep = String(tc.endpoint || '');
  const raw = toPostmanVars(/^https?:\/\//i.test(ep) ? ep : `{{baseUrl}}${ep}`);
  const q = Object.entries(tc.query || {}).map(([key, value]) => ({ key, value: toPostmanVars(value) }));
  const pathPart = raw.replace('{{baseUrl}}', '').split('?')[0];
  return {
    raw: raw + (q.length ? '?' + q.map((x) => `${x.key}=${encodeURIComponent(x.value).replace(/%7B%7B/g, '{{').replace(/%7D%7D/g, '}}')}`).join('&') : ''),
    host: ['{{baseUrl}}'],
    path: pathPart.split('/').filter(Boolean),
    query: q,
  };
}

const JS_GET = "function qaGet(o,p){if(!p||p==='$')return o;var t=p.replace(/^\\$/,'').match(/\\.[A-Za-z0-9_$\\-]+|\\[\\d+\\]/g)||[];return t.reduce(function(c,k){if(c===undefined||c===null)return undefined;if(k[0]==='[')return c[Number(k.slice(1,-1))];k=k.slice(1);if(k==='length'&&(Array.isArray(c)||typeof c==='string'))return c.length;return c[k];},o);}";

function pmExpected(v) {
  if (typeof v === 'string') {
    const m = v.match(/^\{\{(\w+)\}\}$/);
    if (m) return `pm.collectionVariables.get(${JSON.stringify(m[1])})`;
  }
  return JSON.stringify(v);
}

/** Chai expression for `actual <op> expected`, mirroring the engine's compare() so exported scripts agree with in-app results. */
function chaiCheck(g, op, expected) {
  const lit = pmExpected(expected);
  const num = `Number(${JSON.stringify(expected)})`;
  switch (op) {
    case 'eq': return `pm.expect(${g}).to.eql(${lit});`;
    case 'neq': return `pm.expect(${g}).to.not.eql(${lit});`;
    case 'in': return `pm.expect(${g}).to.be.oneOf(${JSON.stringify(expected)});`;
    case 'exists': return `pm.expect(${g}).to.not.be.oneOf([undefined, null]);`;
    case 'notExists': return `pm.expect(${g}).to.be.oneOf([undefined, null]);`;
    case 'contains': return `pm.expect(typeof (${g}) === 'string' ? (${g}) : JSON.stringify(${g})).to.include(${JSON.stringify(String(expected))});`;
    case 'notContains': return `pm.expect((typeof (${g}) === 'string' ? (${g}) : JSON.stringify(${g})) || '').to.not.include(${JSON.stringify(String(expected))});`;
    case 'matches': return `pm.expect(String(${g})).to.match(new RegExp(${JSON.stringify(expected)}));`;
    case 'type': return `pm.expect(Array.isArray(${g}) ? 'array' : (${g} === null ? 'null' : typeof ${g})).to.eql(${JSON.stringify(expected)});`;
    case 'lt': return `pm.expect(Number(${g})).to.be.below(${num});`;
    case 'lte': return `pm.expect(Number(${g})).to.be.at.most(${num});`;
    case 'gt': return `pm.expect(Number(${g})).to.be.above(${num});`;
    case 'gte': return `pm.expect(Number(${g})).to.be.at.least(${num});`;
    default: return `throw new Error(${JSON.stringify(`Unsupported operator "${op}"`)});`;
  }
}

const JS_CSV = "function qaCsv(t){var rows=[],r=[],c='',q=false,i,ch;t=String(t||'');for(i=0;i<t.length;i++){ch=t[i];if(q){if(ch==='\"'&&t[i+1]==='\"'){c+='\"';i++;}else if(ch==='\"')q=false;else c+=ch;}else if(ch==='\"')q=true;else if(ch===','){r.push(c);c='';}else if(ch==='\\n'||ch==='\\r'){if(ch==='\\r'&&t[i+1]==='\\n')i++;r.push(c);rows.push(r);r=[];c='';}else c+=ch;}if(c!==''||r.length){r.push(c);rows.push(r);}rows=rows.filter(function(x){return x.some(function(y){return y.trim()!=='';});});var h=(rows.shift()||[]).map(function(x){return x.trim();});return {header:h,records:rows.map(function(x){var o={};h.forEach(function(k,j){o[k]=x[j]===undefined?'':x[j];});return o;})};}";

function testScript(tc) {
  const lines = [JS_GET, 'var body; try { body = pm.response.json(); } catch (e) { body = pm.response.text(); }'];
  if ((tc.assertions || []).some((a) => a.type === 'csv')) lines.splice(1, 0, JS_CSV);
  for (const a of tc.assertions || []) {
    const name = JSON.stringify(a.label || `${a.type} ${a.path || a.name || ''} ${a.op || ''} ${typeof a.expected === 'object' ? '' : a.expected}`.replace(/\s+/g, ' ').trim());
    let check;
    switch (a.type) {
      case 'status': check = chaiCheck('pm.response.code', a.op || 'eq', a.expected); break;
      case 'responseTime': check = chaiCheck('pm.response.responseTime', a.op || 'lt', a.expected); break;
      case 'header': {
        const hv = `pm.response.headers.get(${JSON.stringify(a.name)})`;
        check = !a.op || a.op === 'exists' ? `pm.expect(pm.response.headers.has(${JSON.stringify(a.name)})).to.be.true;` : a.op === 'notExists' ? `pm.expect(pm.response.headers.has(${JSON.stringify(a.name)})).to.be.false;` : chaiCheck(hv, a.op, a.expected);
        break;
      }
      case 'sfError': check = chaiCheck("(Array.isArray(body) && body[0] ? (body[0].errorCode || body[0].statusCode || null) : null)", a.op || 'eq', a.expected); break;
      case 'schema': check = `pm.response.to.have.jsonSchema(${JSON.stringify(a.expected)});`; break;
      case 'bodyContains': check = `pm.expect(pm.response.text()).to.include(${JSON.stringify(a.expected)});`; break;
      case 'csv': {
        const p = String(a.path || 'rows');
        const g = p === 'rows' ? 'qaCsv(pm.response.text()).records.length' : p === 'header' ? 'qaCsv(pm.response.text()).header' : `qaCsv(pm.response.text()).records.map(function(r){ return r[${JSON.stringify(p.replace(/^column:/, ''))}]; })`;
        check = chaiCheck(g, a.op || 'eq', a.expected);
        break;
      }
      case 'jsonpath': check = chaiCheck(`qaGet(body, ${JSON.stringify(a.path)})`, a.op || 'eq', a.expected); break;
      default: check = '/* unsupported assertion type */';
    }
    lines.push(`pm.test(${name}, function () { ${check} });`);
  }
  for (const e of tc.extract || []) {
    lines.push(`(function(){ var v = qaGet(body, ${JSON.stringify(e.path)}); if (v !== undefined && v !== null) pm.collectionVariables.set(${JSON.stringify(e.var)}, v); })();`);
  }
  if (tc.sfValidation) lines.push(`pm.collectionVariables.set(${JSON.stringify('qaReq_' + tc.id)}, pm.request.body && pm.request.body.raw ? pm.request.body.raw : '{}');`);
  return lines;
}

function preRequest(tc) {
  const lines = [];
  const all = JSON.stringify(tc.body || '') + (tc.bodyRaw || '') + tc.endpoint;
  for (const m of all.matchAll(/\{\{\$randomString:(\d+)\}\}/g)) {
    lines.push(`pm.variables.set('qaRandomString_${m[1]}', Array.from({length: ${m[1]}}, function(_, i){ return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[i % 52]; }).join(''));`);
  }
  return lines;
}

function authFor(tc) {
  if (tc.auth === 'none') return { type: 'noauth' };
  if (tc.auth === 'invalid') return { type: 'bearer', bearer: [{ key: 'token', value: 'INVALID_TOKEN_NEGATIVE_TEST', type: 'string' }] };
  if (tc.auth === 'lowpriv') return { type: 'bearer', bearer: [{ key: 'token', value: '{{lowPrivAccessToken}}', type: 'string' }] };
  return undefined; // inherit collection auth
}

function itemFor(tc) {
  const body = rawBody(tc);
  const item = {
    name: `${tc.id} ${tc.title}`,
    request: {
      method: tc.method,
      header: Object.entries(tc.headers || {}).map(([key, value]) => ({ key, value: toPostmanVars(value) })),
      url: urlObject(tc),
      description: `${tc.testType} · ${tc.priority} · ${tc.storyKey || 'no story'} · label ${tc.label}`,
      ...(body !== null && !['GET', 'HEAD'].includes(tc.method) ? { body: { mode: 'raw', raw: body, options: { raw: { language: tc.apiType === 'SOAP' ? 'xml' : 'json' } } } } : {}),
      ...(authFor(tc) ? { auth: authFor(tc) } : {}),
    },
    event: [
      { listen: 'prerequest', script: { type: 'text/javascript', exec: preRequest(tc) } },
      { listen: 'test', script: { type: 'text/javascript', exec: testScript(tc) } },
    ],
  };
  const items = [item];
  if (tc.sfValidation && tc.sfValidation.idVar) {
    const fields = Object.keys(tc.sfValidation.expected || {});
    const soql = `SELECT Id, ${fields.join(', ')} FROM ${tc.sfValidation.object} WHERE Id = '{{${tc.sfValidation.idVar}}}'`;
    items.push({
      name: `${tc.id} ↳ Validate ${tc.sfValidation.object} in Salesforce`,
      request: { method: 'GET', header: [], url: { raw: `{{baseUrl}}/services/data/v{{apiVersion}}/query?q=${soql}`, host: ['{{baseUrl}}'], path: ['services', 'data', 'v{{apiVersion}}', 'query'], query: [{ key: 'q', value: soql }] } },
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: [
        `var sent = JSON.parse(pm.collectionVariables.get(${JSON.stringify('qaReq_' + tc.id)}) || '{}');`,
        'var rec = (pm.response.json().records || [])[0] || {};',
        `pm.test('Record exists', function () { pm.expect(rec.Id).to.be.a('string'); });`,
        ...fields.map((f) => {
          const exp = String(tc.sfValidation.expected[f]);
          const m = exp.match(/^\{\{req\.(\w+)\}\}$/);
          return `pm.test(${JSON.stringify(`${tc.sfValidation.object}.${f} persisted`)}, function () { pm.expect(rec[${JSON.stringify(f)}]).to.eql(${m ? `sent[${JSON.stringify(m[1])}]` : JSON.stringify(tc.sfValidation.expected[f])}); });`;
        }),
      ] } }],
    });
  }
  return items;
}

const COLLECTION_PREREQ = [
  "// Obtains an OAuth access token (client credentials) once per run. Values come from the environment — never hard-coded.",
  "if (!pm.collectionVariables.get('runId')) pm.collectionVariables.set('runId', String(Date.now()).slice(-6));",
  "if (pm.environment.get('accessToken') || pm.collectionVariables.get('accessToken')) return;",
  "if (!pm.environment.get('clientId')) { console.warn('clientId not set — requests will use {{accessToken}} as provided.'); return; }",
  "pm.sendRequest({",
  "  url: pm.environment.get('loginUrl') + '/services/oauth2/token', method: 'POST',",
  "  header: { 'Content-Type': 'application/x-www-form-urlencoded' },",
  "  body: { mode: 'urlencoded', urlencoded: [",
  "    { key: 'grant_type', value: 'client_credentials' },",
  "    { key: 'client_id', value: pm.environment.get('clientId') },",
  "    { key: 'client_secret', value: pm.environment.get('clientSecret') } ] }",
  "}, function (err, res) {",
  "  if (err || res.code !== 200) { console.error('OAuth token request failed', err || res.code); return; }",
  "  pm.collectionVariables.set('accessToken', res.json().access_token);",
  "});",
];

function exportCollection(project, testCases) {
  const groups = {};
  for (const tc of testCases) (groups[tc.testType] = groups[tc.testType] || []).push(tc);
  return maskDeep({
    info: {
      name: `${project.name} — Salesforce API tests (${project.environment})`,
      description: `Generated by Salesforce API QA Platform on ${new Date().toISOString()}.\nProject ${project.name}, org ${project.sfOrg || 'n/a'}, API v${project.apiVersion}.\nCredentials are environment variables; no secrets are stored in this file.`,
      schema: SCHEMA,
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: COLLECTION_PREREQ } }],
    variable: [{ key: 'apiVersion', value: project.apiVersion }, { key: 'runId', value: '' }],
    item: Object.entries(groups).map(([name, tcs]) => ({ name, item: tcs.sort((a, b) => a.seq - b.seq).flatMap(itemFor) })),
  });
}

function exportEnvironment(project) {
  const { restApiOrigin, loginOauthOrigin } = require('../connectors/salesforce-org');
  const envs = require('./environments');
  const { seedFromProject } = require('./run-vars');
  const apiHost = restApiOrigin(project.instanceUrl) || 'https://your-domain.my.salesforce.com';
  const active = project.id ? envs.active(project.id) : null;
  const base = [
    { key: 'baseUrl', value: apiHost, type: 'default', enabled: true },
    { key: 'loginUrl', value: loginOauthOrigin(project.instanceUrl) || 'https://login.salesforce.com', type: 'default', enabled: true },
    { key: 'apiVersion', value: project.apiVersion, type: 'default', enabled: true },
    { key: 'clientId', value: '', type: 'secret', enabled: true },
    { key: 'clientSecret', value: '', type: 'secret', enabled: true },
    { key: 'accessToken', value: '', type: 'secret', enabled: true },
    { key: 'lowPrivAccessToken', value: '', type: 'secret', enabled: true },
    { key: 'recordId', value: '', type: 'default', enabled: true },
  ];
  const extra = active ? envs.normalizeValues(active.values || active.envValues).map((v) => ({
    key: v.key, value: v.secret ? '' : v.value, type: v.secret ? 'secret' : 'default', enabled: v.enabled,
  })) : [];
  const seen = new Set(extra.map((v) => v.key));
  const seeded = seedFromProject(project, {
    environmentVars: envs.valuesToMap(active && (active.values || active.envValues)),
  });
  const orgRows = ['organization_id', 'organizationId', 'ccOrgId', 'ccSiteId', 'ccShortCode']
    .filter((k) => seeded[k] && !seen.has(k))
    .map((k) => {
      seen.add(k);
      return { key: k, value: String(seeded[k]), type: 'default', enabled: true };
    });
  return {
    id: active && active.id,
    name: (active && active.name) || `${project.name} — ${project.environment}`,
    values: [...extra, ...orgRows, ...base.filter((v) => !seen.has(v.key))],
    _postman_variable_scope: 'environment',
  };
}

function flattenItems(items, folder = '') {
  const out = [];
  for (const it of items || []) {
    if (it.item) out.push(...flattenItems(it.item, folder ? `${folder} / ${it.name}` : it.name));
    else out.push({ ...it, folder });
  }
  return out;
}

function scriptText(events, listen) {
  const ev = (events || []).find((e) => e.listen === listen);
  if (!ev || !ev.script) return '';
  return [].concat(ev.script.exec || ev.script).join('\n');
}

function authExtra(auth) {
  if (!auth || typeof auth !== 'object') return null;
  const type = String(auth.type || '').toLowerCase();
  const rows = (key) => (Array.isArray(auth[key]) ? auth[key] : []).reduce((m, r) => {
    if (r && r.key) m[r.key] = r.value;
    return m;
  }, {});
  if (type === 'bearer') return { type, token: rows('bearer').token || (auth.bearer && auth.bearer[0] && auth.bearer[0].value) };
  if (type === 'basic') return { type, ...rows('basic') };
  if (type === 'apikey') return { type, ...rows('apikey') };
  if (type === 'oauth2') return { type, ...rows('oauth2') };
  if (type === 'noauth') return { type };
  return type ? { type, raw: auth } : null;
}

function importCollection(collection) {
  const { normalizeCollection, extractsFromScript, requestUrl } = require('./collection-import');
  const col = normalizeCollection(collection);
  const TYPES = ['Functional', 'Negative', 'Boundary', 'Security', 'Integration', 'Regression', 'Contract', 'Performance'];
  return flattenItems(col.item).filter((i) => i.request).map((it) => {
    const r = typeof it.request === 'string' ? { method: 'GET', url: it.request } : it.request;
    const rawUrl = requestUrl(r);
    const afterHost = rawUrl.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/i, '') || rawUrl;
    const sfPath = /\/services\/|\/sobjects\/|\/connect\/|\/commerce\/webstores/i.test(afterHost);
    const keepAbs = /^https?:\/\//i.test(rawUrl) && !/salesforce\.com|force\.com|demandware|commercecloud/i.test(rawUrl);
    let endpoint = keepAbs ? rawUrl : (sfPath ? afterHost : rawUrl.replace(/^https?:\/\/[^/]+/i, ''));
    const query = {};
    if (endpoint.includes('?')) {
      const [p, qs] = endpoint.split('?');
      endpoint = p;
      try { for (const [k, v] of new URLSearchParams(qs)) query[k] = v; } catch { /* keep raw */ }
    }
    const u = r.url && typeof r.url === 'object' ? r.url : null;
    if (u && Array.isArray(u.query)) {
      for (const q of u.query) if (q && q.key && !q.disabled) query[q.key] = q.value;
    }
    const headerList = Array.isArray(r.header) ? r.header : [];
    const headers = Object.fromEntries(headerList.filter((h) => h && !h.disabled && h.key && !/^authorization$/i.test(h.key)).map((h) => [h.key, h.value]));
    let body; let bodyRaw;
    const mode = r.body && r.body.mode;
    if (mode === 'raw' && r.body.raw) {
      try { body = JSON.parse(r.body.raw); } catch { bodyRaw = r.body.raw; }
    } else if (mode === 'urlencoded' && Array.isArray(r.body.urlencoded)) {
      body = Object.fromEntries(r.body.urlencoded.filter((x) => x && x.key && !x.disabled).map((x) => [x.key, x.value]));
    } else if (mode === 'formdata' && Array.isArray(r.body.formdata)) {
      body = Object.fromEntries(r.body.formdata.filter((x) => x && x.key && !x.disabled && x.type !== 'file').map((x) => [x.key, x.value]));
    } else if (mode === 'graphql' && r.body.graphql) {
      const g = r.body.graphql;
      body = typeof g === 'string' ? undefined : { query: g.query, variables: g.variables, operationName: g.operationName };
      bodyRaw = typeof g === 'string' ? g : JSON.stringify(g);
    } else if (mode === 'file' && r.body.file) {
      bodyRaw = typeof r.body.file === 'string' ? r.body.file : (r.body.file.src || '');
    }
    const testCode = scriptText(it.event, 'test');
    const preCode = scriptText(it.event, 'prerequest');
    const assertions = [];
    for (const m of testCode.matchAll(/to\.have\.status\((\d{3})\)/g)) assertions.push({ type: 'status', op: 'eq', expected: Number(m[1]) });
    for (const m of testCode.matchAll(/pm\.expect\(pm\.response\.code\)\.to\.(?:eql|equal)\((\d{3})\)/g)) assertions.push({ type: 'status', op: 'eq', expected: Number(m[1]) });
    for (const m of testCode.matchAll(/response(?:Time)?\)?\.to\.be\.below\((\d+)\)/g)) assertions.push({ type: 'responseTime', op: 'lt', expected: Number(m[1]) });
    if (!assertions.some((a) => a.type === 'status')) assertions.unshift({ type: 'status', op: 'lt', expected: 400, label: 'HTTP status < 400 (imported default)' });
    const inherited = (r.auth && r.auth.type && r.auth.type !== 'inherit') ? r.auth : (col.auth || {});
    const inheritedAuth = String(inherited.type || '');
    const auth = /noauth/i.test(inheritedAuth) ? 'none' : 'default';
    const apiType = /\/dw\/(shop|data)\//.test(endpoint) || /\/dw\/oauth2\//.test(endpoint) ? 'OCAPI'
      : /shopper-(products|search|baskets|auth)|\/shopper\/auth\//.test(endpoint) ? 'SCAPI'
      : /apexrest/i.test(endpoint) ? 'Apex REST'
      : /composite/i.test(endpoint) ? 'Composite'
      : /Soap/i.test(endpoint) ? 'SOAP'
      : /\/services\//i.test(endpoint) ? 'REST'
      : 'HTTP';
    const needsHttpToken = apiType === 'HTTP' && /bearer|oauth2|apikey|jwt/i.test(inheritedAuth);
    const examples = Array.isArray(it.response) ? it.response.map((ex) => ({
      name: ex.name, status: ex.status, code: ex.code,
      body: typeof ex.body === 'string' ? ex.body.slice(0, 8000) : ex.body,
    })).slice(0, 8) : [];
    const extra = {
      bodyMode: mode || (bodyRaw || body ? 'raw' : 'none'),
      formData: mode === 'formdata' ? r.body.formdata : undefined,
      urlencoded: mode === 'urlencoded' ? r.body.urlencoded : undefined,
      graphql: mode === 'graphql' ? r.body.graphql : undefined,
      file: mode === 'file' ? r.body.file : undefined,
      preRequest: preCode || undefined,
      tests: testCode || undefined,
      auth: authExtra(inherited) || undefined,
      originalUrl: rawUrl,
      folder: it.folder || '',
      examples: examples.length ? examples : undefined,
      collectionName: col.info && col.info.name,
      protocolProfileBehavior: it.protocolProfileBehavior || r.protocolProfileBehavior,
      description: typeof r.description === 'string' ? r.description : (r.description && r.description.content) || undefined,
    };
    const descBits = [
      `Imported from Postman collection "${col.info.name}"${it.folder ? ` / ${it.folder}` : ''}.`,
      extra.description,
    ].filter(Boolean);
    return {
      title: it.name, method: String(r.method || 'GET').toUpperCase(), endpoint: endpoint.replace(/\{\{(\w+)\}\}/g, '{{$1}}'), query, headers, body, bodyRaw, auth,
      apiType,
      testType: TYPES.find((t) => String(it.folder || '').toLowerCase().includes(t.toLowerCase())) || 'Functional',
      assertions, extract: extractsFromScript(testCode + '\n' + preCode), label: 'ASSUMED',
      tags: [...new Set([...(apiType === 'HTTP' ? ['frontend', 'imported'] : ['imported']), ...(needsHttpToken ? ['needs-http-token'] : []), ...(it.folder ? [`folder:${it.folder}`] : [])])],
      description: descBits.join(' '),
      extra,
    };
  });
}

function runNewman(collectionFile, environmentFile) {
  return new Promise((resolve) => {
    const cwd = path.join(config.root, 'api-tests');
    const out = path.join(cwd, 'reports', `newman-${Date.now()}.json`);
    const args = ['--no-install', 'newman', 'run', collectionFile, '-e', environmentFile, '--reporters', 'cli,json', '--reporter-json-export', out];
    let stdout = '';
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { cwd, env: process.env });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stdout += d; });
    child.on('error', (e) => resolve({ ok: false, title: 'Newman could not be started', cause: e.message, action: 'Install Node.js/npm and run `npm install` in the api-tests folder.' }));
    child.on('close', (code) => {
      if (!fs.existsSync(out)) {
        return resolve({ ok: false, title: 'Newman is not installed or failed before producing a report', cause: stdout.split('\n').slice(-6).join('\n'), action: 'Run `npm install` inside api-tests/ (installs newman), then retry.' });
      }
      const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
      const s = rep.run && rep.run.stats;
      resolve({ ok: code === 0, exitCode: code, report: path.relative(config.root, out), stats: s, failures: (rep.run.failures || []).slice(0, 50).map((f) => ({ test: f.error && f.error.test, message: f.error && f.error.message, item: f.source && f.source.name })) });
    });
  });
}

module.exports = { exportCollection, exportEnvironment, importCollection, runNewman, toPostmanVars, flattenItems };
