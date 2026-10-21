'use strict';
/**
 * Variable interpolation ({{var}}), dynamic values ({{$uuid}}, {{$randomEmail}} …)
 * and a small JSONPath subset ($.a.b[0].c, $[0].errorCode, $.records.length).
 */
const crypto = require('node:crypto');

const DYNAMIC = {
  $uuid: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $today: () => new Date().toISOString().slice(0, 10),
  $randomInt: () => String(Math.floor(Math.random() * 100000)),
  $randomEmail: () => `qa.${crypto.randomBytes(4).toString('hex')}@example.com`,
  $randomPhone: () => `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
  $randomName: () => `QA ${crypto.randomBytes(3).toString('hex')}`,
};

function dynamicValue(name) {
  if (DYNAMIC[name]) return DYNAMIC[name]();
  let m = name.match(/^\$randomString:(\d{1,6})$/);
  if (m) {
    const n = Number(m[1]);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[i % alphabet.length];
    return s;
  }
  m = name.match(/^\$repeat:(.):(\d{1,6})$/);
  if (m) return m[1].repeat(Number(m[2]));
  return undefined;
}

/** Tokenise a JSONPath subset (`$.a.b[0].c`, `$[*].id`). */
function parsePath(p) {
  if (!p || p === '$') return [];
  const s = p.startsWith('$') ? p.slice(1) : '.' + p;
  const tokens = [];
  const rx = /\.([A-Za-z0-9_$\-]+)|\[(\d+)\]|\[\*\]|\[['"]([^'"]+)['"]\]/g;
  let m;
  let last = 0;
  while ((m = rx.exec(s))) {
    if (m.index !== last) throw new Error(`Unsupported JSONPath segment in "${p}"`);
    if (m[0] === '[*]') tokens.push('*');
    else tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? Number(m[2]) : m[3]);
    last = rx.lastIndex;
  }
  if (last !== s.length) throw new Error(`Unsupported JSONPath "${p}"`);
  return tokens;
}

function walkPath(cur, tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (cur === null || cur === undefined) return undefined;
    if (t === '*') {
      if (!Array.isArray(cur)) return undefined;
      const rest = tokens.slice(i + 1);
      if (!rest.length) return cur;
      return cur.map((item) => walkPath(item, rest));
    }
    if (t === 'length' && (Array.isArray(cur) || typeof cur === 'string')) { cur = cur.length; continue; }
    cur = cur[t];
  }
  return cur;
}

function getPath(obj, p) {
  return walkPath(obj, parsePath(p));
}

function lookup(name, vars) {
  if (name.startsWith('$')) return dynamicValue(name);
  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  // dotted access, e.g. req.LastName or response.body.id
  if (name.includes('.') || name.includes('[')) {
    const [head, ...rest] = name.split('.');
    if (Object.prototype.hasOwnProperty.call(vars, head)) {
      try { return getPath(vars[head], '$.' + rest.join('.')); } catch { return undefined; }
    }
  }
  return undefined;
}

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Interpolate strings / objects. A string that is exactly "{{x}}" returns the
 * raw value (preserving numbers/booleans/objects). Unresolved names are kept
 * verbatim and reported via `missing`.
 */
function interpolate(value, vars, missing = new Set()) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (whole) {
      const v = lookup(whole[1], vars);
      if (v === undefined) { missing.add(whole[1]); return value; }
      return v;
    }
    return value.replace(TOKEN, (all, name) => {
      const v = lookup(name, vars);
      if (v === undefined) { missing.add(name); return all; }
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, missing));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[interpolate(k, vars, missing)] = interpolate(v, vars, missing);
    return out;
  }
  return value;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

module.exports = { interpolate, getPath, parsePath, typeOf, dynamicValue };
