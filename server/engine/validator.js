'use strict';
/**
 * Salesforce data validation: capture the record id from the API response,
 * query Salesforce, compare the persisted values with what the API was asked
 * to store, and report exact field differences.
 */
const { deepEqual } = require('./assertions');

const ID_RX = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const SAFE_NAME = /^[A-Za-z0-9_.]+$/;

function normalise(v) {
  if (v === undefined) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.replace(/\.\d{3}/, '').replace(/(\+0000|Z)$/, 'Z');
  return v;
}

/**
 * @param {object} sf connector
 * @param {object} spec { object, id, expected: {Field: value}, related?: [{object, where, expectCount}] }
 */
async function validateRecord(sf, spec) {
  const out = { object: spec.object, recordId: spec.id || null, soql: null, actual: null, comparisons: [], related: [], status: 'FAIL', message: '' };
  if (!spec.object || !SAFE_NAME.test(spec.object)) { out.status = 'BLOCKED'; out.message = 'Validation spec has an invalid object name.'; return out; }
  if (!spec.id || !ID_RX.test(String(spec.id))) {
    out.status = 'BLOCKED';
    out.message = 'No Salesforce record id was captured from the API response, so the record could not be queried.';
    return out;
  }
  const fields = Object.keys(spec.expected || {}).filter((f) => SAFE_NAME.test(f));
  const select = ['Id', ...fields.filter((f) => f !== 'Id')];
  out.soql = `SELECT ${select.join(', ')} FROM ${spec.object} WHERE Id = '${spec.id}'`;
  try {
    const res = await sf.query(out.soql);
    const rec = res.records && res.records[0];
    if (!rec) {
      out.message = `No ${spec.object} record with Id ${spec.id} is visible to the integration user.`;
      return out;
    }
    const { attributes, ...actual } = rec;
    out.actual = actual;
    for (const f of fields) {
      const exp = normalise(spec.expected[f]);
      const act = normalise(f.includes('.') ? f.split('.').reduce((o, k) => (o ? o[k] : undefined), actual) : actual[f]);
      const match = deepEqual(exp, act) || (exp === '' && act === null);
      out.comparisons.push({ field: f, expected: exp, actual: act, match });
    }
    for (const r of spec.related || []) {
      if (!SAFE_NAME.test(r.object)) continue;
      const q = `SELECT COUNT() FROM ${r.object} WHERE ${r.where.replace(/\{\{id\}\}/g, spec.id)}`;
      const rr = await sf.query(q);
      out.related.push({ object: r.object, soql: q, expected: r.expectCount, actual: rr.totalSize, match: rr.totalSize === r.expectCount });
    }
    const mismatches = out.comparisons.filter((c) => !c.match).length + out.related.filter((r) => !r.match).length;
    out.status = mismatches ? 'FAIL' : 'PASS';
    out.message = mismatches
      ? `${mismatches} field difference(s) between the API request and the persisted Salesforce record.`
      : `All ${out.comparisons.length} field(s) persisted as sent.`;
  } catch (e) {
    out.status = 'ERROR';
    out.message = e.explanation ? `${e.explanation.title}. ${e.explanation.action}` : e.message;
    out.error = e.explanation || { title: e.message };
  }
  return out;
}

module.exports = { validateRecord };
