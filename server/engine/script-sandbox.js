'use strict';
/**
 * Isolated pre-request / test scripts. User code runs in node:vm with
 * codeGeneration disabled and a Postman-like `pm` subset.
 */
const vm = require('node:vm');
const { interpolate } = require('../lib/template');

function fmt(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function deepEql(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function makeExpect(actual, tests, currentName) {
  const fail = (msg) => {
    throw new Error(msg);
  };
  const assert = (ok, msg) => { if (!ok) fail(msg); };
  const not = {
    eql: (exp) => assert(!deepEql(actual, exp), `expected ${fmt(actual)} not to eql ${fmt(exp)}`),
    equal: (exp) => assert(actual !== exp, `expected ${fmt(actual)} not to equal ${fmt(exp)}`),
    include: (exp) => {
      const s = typeof actual === 'string' ? actual : JSON.stringify(actual);
      assert(!s.includes(String(exp)), `expected ${fmt(actual)} not to include ${fmt(exp)}`);
    },
  };
  const chain = {
    eql: (exp) => assert(deepEql(actual, exp), `expected ${fmt(actual)} to eql ${fmt(exp)}`),
    equal: (exp) => assert(actual === exp, `expected ${fmt(actual)} to equal ${fmt(exp)}`),
    eq: (exp) => assert(actual === exp || deepEql(actual, exp), `expected ${fmt(actual)} to equal ${fmt(exp)}`),
    include: (exp) => {
      const s = typeof actual === 'string' ? actual : JSON.stringify(actual);
      assert(s.includes(String(exp)), `expected ${fmt(actual)} to include ${fmt(exp)}`);
    },
    ok: () => assert(Boolean(actual), `expected ${fmt(actual)} to be truthy`),
    a: (t) => assert(t === 'array' ? Array.isArray(actual) : typeof actual === t, `expected ${fmt(actual)} to be a ${t}`),
    an: (t) => chain.a(t),
    above: (n) => assert(Number(actual) > Number(n), `expected ${fmt(actual)} to be above ${n}`),
    below: (n) => assert(Number(actual) < Number(n), `expected ${fmt(actual)} to be below ${n}`),
    property: (k) => assert(actual && Object.prototype.hasOwnProperty.call(actual, k), `expected ${fmt(actual)} to have property ${k}`),
    status: (code) => assert(Number(actual && actual.code !== undefined ? actual.code : actual) === Number(code), `expected status ${code}`),
    not,
  };
  chain.be = {
    true: { get value() { return assert(actual === true, 'expected true'); } },
    false: { get value() { return assert(actual === false, 'expected false'); } },
    ok: chain.ok,
    above: chain.above,
    below: chain.below,
    a: chain.a,
    an: chain.an,
  };
  // Allow `to.be.true` without `.value` by using a thenable-like getter via Proxy.
  chain.be = new Proxy(chain.be, {
    get(t, p) {
      if (p === 'true') { assert(actual === true, 'expected true'); return true; }
      if (p === 'false') { assert(actual === false, 'expected false'); return false; }
      return t[p];
    },
  });
  chain.have = {
    status: chain.status,
    property: chain.property,
    header: (name) => {
      const h = actual && (actual.headers || actual);
      const key = h && Object.keys(h).find((k) => k.toLowerCase() === String(name).toLowerCase());
      assert(Boolean(key), `expected header ${name}`);
    },
  };
  return { to: chain, not: { to: { ...chain, eql: not.eql, equal: not.equal, include: not.include } } };
}

function varStore(map) {
  return {
    get: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined),
    set: (k, v) => { map[String(k)] = v; return v; },
    unset: (k) => { delete map[k]; },
    has: (k) => Object.prototype.hasOwnProperty.call(map, k),
    toObject: () => ({ ...map }),
  };
}

function wrapResponse(res) {
  return {
    code: res.status,
    status: res.statusText || String(res.status),
    responseTime: res.timeMs,
    headers: {
      get: (n) => {
        const k = Object.keys(res.headers || {}).find((h) => h.toLowerCase() === String(n).toLowerCase());
        return k ? res.headers[k] : undefined;
      },
      has: (n) => Object.keys(res.headers || {}).some((h) => h.toLowerCase() === String(n).toLowerCase()),
      toObject: () => ({ ...(res.headers || {}) }),
    },
    json: () => (typeof res.body === 'string' ? JSON.parse(res.body) : res.body),
    text: () => res.text !== undefined ? res.text : (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)),
    stream: { toString: () => res.text },
  };
}

function wrapRequest(req) {
  return {
    method: req.method,
    url: req.url || req.path,
    headers: req.headers || {},
    body: req.body,
  };
}

async function runScript(code, ctx = {}) {
  const logs = ctx.logs || [];
  const tests = [];
  const env = ctx.environment || {};
  const vars = ctx.variables || {};
  const collection = ctx.collection || {};
  const pending = [];
  const timeoutMs = ctx.timeoutMs || 2500;
  const send = ctx.sendRequest;

  const pm = {
    environment: varStore(env),
    variables: varStore(vars),
    collectionVariables: varStore(collection),
    request: wrapRequest(ctx.request || {}),
    response: ctx.response ? wrapResponse(ctx.response) : undefined,
    info: { eventName: ctx.eventName || 'script' },
    test(name, fn) {
      const title = String(name || 'test');
      try {
        if (typeof fn === 'function') fn();
        tests.push({ name: title, passed: true });
      } catch (e) {
        tests.push({ name: title, passed: false, error: e.message });
      }
    },
    expect(actual) { return makeExpect(actual, tests); },
    sendRequest(req, cb) {
      if (typeof send !== 'function') {
        const err = new Error('pm.sendRequest is not available in this context.');
        if (cb) cb(err);
        return Promise.reject(err);
      }
      const spec = typeof req === 'string' ? { url: req, method: 'GET' } : req;
      const p = Promise.resolve().then(() => send(spec)).then(
        (res) => { const wrapped = wrapResponse(res); if (cb) cb(null, wrapped); return wrapped; },
        (err) => { if (cb) cb(err); throw err; }
      );
      pending.push(p.catch(() => {}));
      return p;
    },
  };

  const sandbox = {
    pm,
    console: {
      log: (...a) => logs.push({ level: 'log', source: ctx.eventName || 'script', message: a.map(fmt).join(' ') }),
      warn: (...a) => logs.push({ level: 'warn', source: ctx.eventName || 'script', message: a.map(fmt).join(' ') }),
      error: (...a) => logs.push({ level: 'error', source: ctx.eventName || 'script', message: a.map(fmt).join(' ') }),
      info: (...a) => logs.push({ level: 'info', source: ctx.eventName || 'script', message: a.map(fmt).join(' ') }),
    },
  };

  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const wrapped = `"use strict";\n(async () => {\n${String(code || '')}\n})()`;
  let error = null;
  try {
    const result = vm.runInContext(wrapped, context, { timeout: timeoutMs, filename: `${ctx.eventName || 'script'}.js`, displayErrors: true });
    if (result && typeof result.then === 'function') {
      await Promise.race([
        result,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Script exceeded time limit.')), timeoutMs + 200)),
      ]);
    }
    if (pending.length) await Promise.all(pending);
  } catch (e) {
    error = e.message;
    logs.push({ level: 'error', source: ctx.eventName || 'script', message: e.message });
  }

  return {
    ok: !error,
    error,
    tests,
    logs,
    environment: { ...env },
    variables: { ...vars },
    collection: { ...collection },
  };
}

function testsAsAssertions(tests) {
  return (tests || []).map((t) => ({
    type: 'script',
    check: t.name,
    expected: 'pass',
    actual: t.passed ? 'pass' : t.error,
    result: t.passed ? 'PASS' : 'FAIL',
    message: t.error || '',
  }));
}

module.exports = { runScript, testsAsAssertions, wrapResponse, interpolate };
