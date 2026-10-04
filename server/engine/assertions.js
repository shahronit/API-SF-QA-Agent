'use strict';
/**
 * Assertion engine. Each assertion → { assertion, expected, actual, result: PASS|FAIL, message }.
 * Supported types: status, jsonpath, header, responseTime, sfError, schema, bodyContains.
 * Operators: eq, neq, in, exists, notExists, contains, notContains, matches, type, lt, lte, gt, gte.
 */
const { getPath, typeOf } = require('../lib/template');
const { validate } = require('../lib/jsonschema');
const { sfErrors } = require('../lib/errors');

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && Number(b) === a) return true;
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && Number(a) === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(op, actual, expected) {
  switch (op) {
    case 'eq': return deepEqual(actual, expected);
    case 'neq': return !deepEqual(actual, expected);
    case 'in': return Array.isArray(expected) && expected.some((e) => deepEqual(actual, e));
    case 'exists': return actual !== undefined && actual !== null;
    case 'notExists': return actual === undefined || actual === null;
    case 'contains':
      if (Array.isArray(actual)) return actual.some((x) => deepEqual(x, expected) || (typeof x === 'string' && x.includes(String(expected))));
      return actual !== undefined && actual !== null && (typeof actual === 'string' ? actual : JSON.stringify(actual)).includes(String(expected));
    case 'notContains':
      return actual === undefined || actual === null || !(typeof actual === 'string' ? actual : JSON.stringify(actual)).includes(String(expected));
    case 'matches': return actual !== undefined && actual !== null && new RegExp(expected).test(String(actual));
    case 'type': return typeOf(actual) === expected;
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    default: throw new Error(`Unknown operator "${op}"`);
  }
}

const OP_TEXT = { eq: 'equals', neq: 'does not equal', in: 'is one of', exists: 'exists', notExists: 'does not exist', contains: 'contains', notContains: 'does not contain', matches: 'matches', type: 'is of type', lt: '<', lte: '≤', gt: '>', gte: '≥' };

function describeAssertion(a) {
  switch (a.type) {
    case 'status': return `HTTP status ${OP_TEXT[a.op || 'eq']} ${JSON.stringify(a.expected)}`;
    case 'jsonpath': return `${a.path} ${OP_TEXT[a.op || 'eq']}${['exists', 'notExists'].includes(a.op) ? '' : ' ' + JSON.stringify(a.expected)}`;
    case 'header': return `Header ${a.name} ${OP_TEXT[a.op || 'exists']}${a.op && a.op !== 'exists' ? ' ' + JSON.stringify(a.expected) : ''}`;
    case 'responseTime': return `Response time ${OP_TEXT[a.op || 'lt']} ${a.expected} ms`;
    case 'sfError': return `Salesforce errorCode ${OP_TEXT[a.op || 'eq']} ${a.expected}`;
    case 'schema': return 'Response body matches JSON schema';
    case 'bodyContains': return `Body contains "${a.expected}"`;
    default: return a.type;
  }
}

/**
 * @param {object[]} assertions (already interpolated)
 * @param {object} res { status, headers, body, text, timeMs }
 */
function evaluate(assertions, res) {
  return (assertions || []).map((a) => {
    const out = { type: a.type, check: a.label || describeAssertion(a), expected: a.expected, actual: undefined, result: 'FAIL', message: '' };
    try {
      let actual;
      switch (a.type) {
        case 'status': actual = res.status; break;
        case 'jsonpath': actual = typeof res.body === 'object' ? getPath(res.body, a.path) : (a.path === '$' ? res.text : undefined); break;
        case 'header': {
          const key = Object.keys(res.headers || {}).find((h) => h.toLowerCase() === String(a.name).toLowerCase());
          actual = key ? res.headers[key] : undefined;
          break;
        }
        case 'responseTime': actual = res.timeMs; break;
        case 'sfError': {
          const errs = sfErrors(res.body);
          actual = errs.length ? (errs[0].errorCode || errs[0].statusCode || null) : null;
          break;
        }
        case 'bodyContains': actual = res.text; break;
        case 'schema': {
          const errors = validate(a.expected, res.body);
          out.actual = errors.length ? `${errors.length} violation(s)` : 'valid';
          out.violations = errors.slice(0, 20);
          out.expected = 'Schema';
          out.result = errors.length ? 'FAIL' : 'PASS';
          out.message = errors.length ? errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join('; ') : '';
          return out;
        }
        default: throw new Error(`Unknown assertion type "${a.type}"`);
      }
      const op = a.op || (a.type === 'header' ? 'exists' : a.type === 'responseTime' ? 'lt' : 'eq');
      out.actual = a.type === 'bodyContains' ? (String(actual || '').includes(a.expected) ? `found` : 'not found') : actual;
      const ok = a.type === 'bodyContains' ? String(actual || '').includes(String(a.expected)) : compare(op, actual, a.expected);
      out.result = ok ? 'PASS' : 'FAIL';
      if (!ok) out.message = `Expected ${describeAssertion({ ...a, op })}, got ${JSON.stringify(out.actual === undefined ? 'undefined' : out.actual).slice(0, 200)}`;
    } catch (e) {
      out.result = 'FAIL';
      out.message = `Assertion error: ${e.message}`;
    }
    if (typeof out.actual === 'string' && out.actual.length > 300) out.actual = out.actual.slice(0, 300) + '…';
    return out;
  });
}

module.exports = { evaluate, compare, describeAssertion, deepEqual };
