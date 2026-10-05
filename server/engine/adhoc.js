'use strict';
/**
 * Ad hoc scenario builder: turns one line of natural-language testing intent
 * (typed in the Agent chat) into a single executable test definition against
 * a Salesforce object. This powers "Test creating a Contact without a
 * LastName", "Check an invalid email on Lead", "Verify Account rejects a
 * value over the maximum field length", and similar one-off requests.
 *
 * Design rules:
 *  - Every test is exactly one HTTP call (the chat runs it immediately).
 *  - Nothing is invented: when a field/condition cannot be matched in the
 *    object's real (or demo) metadata, the builder falls back to a safe,
 *    generic check and explains the fallback in `notes` rather than guessing
 *    a field name that may not exist.
 *  - Everything produced here is heuristic, never a verified Salesforce
 *    fact — callers should keep the resulting test case labelled ASSUMED.
 */
const { buildPayload, detectFields, OPS } = require('./generator');

const SF_ID_RX = '^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$';
const camel = (s) => String(s || '').replace(/__c$/, '').replace(/_/g, '').replace(/^./, (c) => c.toLowerCase());

/** Pick the single best-matching object name for free text against a describeGlobal catalog. */
function pickObject(text, catalog) {
  if (!text || !Array.isArray(catalog) || !catalog.length) return null;
  const { detectObjects } = require('./generator');
  const hits = detectObjects(text, catalog);
  if (hits.length) return hits[0];
  // Fall back to the common standard objects named directly, even if the
  // catalog lookup above missed them (e.g. plural/possessive forms).
  const common = ['Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'Order', 'Contract', 'Asset', 'Quote', 'Campaign'];
  const t = text.toLowerCase();
  return common.find((o) => t.includes(o.toLowerCase())) || null;
}

function findFieldAmong(describe, names, predicate) {
  for (const n of names) {
    const f = describe.fields.find((x) => x.name === n);
    if (f && (!predicate || predicate(f))) return f;
  }
  return null;
}

/**
 * @param {object} args { describe, objectName, text }
 * @returns {{title, object, testType, method, endpoint, auth, query, body,
 *            assertions, extract, sfValidation, cleanup, notes: string[]}}
 */
function buildAdHocTest({ describe, objectName, text }) {
  const obj = objectName || describe.name;
  const v = '/services/data/v{{apiVersion}}';
  const t = String(text || '');
  const notes = [];
  const mentioned = detectFields(t, describe);
  const basePayload = buildPayload(describe, mentioned);
  const varId = `${camel(obj)}Id`;

  const wants = {
    noToken: /\b(without\s+(an?\s+)?(access\s+)?token|no\s+(access\s+)?token|unauthenticated|not\s+authenticated|no\s+auth)\b/i.test(t),
    badToken: /\b(invalid|expired|bad|wrong)\s+(access\s+)?token\b/i.test(t),
    missing: /\b(without|missing|omit(ting)?|no)\b/i.test(t),
    invalidEmail: /\b(invalid|malformed|bad)\s+email\b/i.test(t) || (/\bemail\b/i.test(t) && /\b(invalid|malformed|bad|wrong)\b/i.test(t)),
    overMax: /\b(over|exceed(s|ing)?|more\s+than|beyond|too\s+long|longer\s+than|above)\b.{0,30}\b(max(imum)?|length|limit)\b/i.test(t) || /\bmax(imum)?\b.{0,20}\b(length|chars?|characters)\b/i.test(t) && /\b(over|exceed|too\s+long|above|beyond)\b/i.test(t),
    atMax: /\bat\s+(the\s+)?max(imum)?\b/i.test(t) && !/\b(over|exceed|too\s+long|above|beyond)\b/i.test(t),
    invalidPicklist: (/\binvalid\b/i.test(t) && /\b(picklist|status|stage|value)\b/i.test(t)) || (/\b(picklist|status|stage)\b/i.test(t) && /\binvalid\b/i.test(t)),
    nonNumeric: (/\b(text|letters|string|non[- ]?numeric)\b/i.test(t) && /\b(number|numeric|currency|amount)\b/i.test(t)),
    notFound: /\b(non-?existent|does\s*not\s*exist|doesn'?t\s*exist|not\s+found|invalid\s+id|fake\s+id|unknown\s+id|bogus\s+id)\b/i.test(t),
    // Verb detection here is intentionally more permissive than the shared
    // OPS regexes in ./generator (which only match the bare verb) because
    // chat scenarios are commonly phrased with -ing/-ed/-s inflections
    // ("Test deleting a non-existent Case", "Verify updating an Account…").
    delete: /\b(delet(e|es|ed|ing)|remov(e|es|ed|ing)|purg(e|es|ed|ing)|archiv(e|es|ed|ing)|deactivat(e|es|ed|ing))\b/i.test(t),
    update: /\b(updat(e|es|ed|ing)|modif(y|ies|ied|ying)|chang(e|es|ed|ing)|edit(s|ed|ing)?|patch(es|ed|ing)?|amend(s|ed|ing)?)\b/i.test(t) && !/\b(delet(e|es|ed|ing)|remov(e|es|ed|ing))\b/i.test(t) && !OPS.create.test(t),
    query: /\b(quer(y|ies|ied|ying)|search(es|ed|ing)?|list(s|ed|ing)?|filter(s|ed|ing)?|soql|report(s|ed|ing)?|find(s|ing)?|retriev(e|es|ed|ing)|fetch(es|ed|ing)?|get(s|ting)?|view(s|ed|ing)?|read(s|ing)?|show(s|ing|n)?|look\s*up(s|ed|ing)?)\b/i.test(t)
      && !/\b(delet(e|es|ed|ing)|remov(e|es|ed|ing))\b/i.test(t)
      && !/\b(updat(e|es|ed|ing)|modif(y|ies|ied|ying)|chang(e|es|ed|ing)|edit(s|ed|ing)?|patch(es|ed|ing)?|amend(s|ed|ing)?)\b/i.test(t)
      && !OPS.create.test(t),
  };

  const base = (partial) => ({
    object: obj,
    testType: partial.testType || 'Functional',
    auth: partial.auth || 'default',
    method: partial.method,
    endpoint: partial.endpoint,
    query: partial.query || {},
    body: partial.body,
    assertions: partial.assertions || [],
    extract: partial.extract || [],
    sfValidation: partial.sfValidation || null,
    cleanup: partial.cleanup || null,
    title: partial.title,
    notes,
  });

  // 1) Authentication-negative scenarios take priority — a neutral read keeps them safe in any environment.
  if (wants.noToken || wants.badToken) {
    const auth = wants.noToken ? 'none' : 'invalid';
    notes.push(`Interpreted as an authentication check (${auth === 'none' ? 'no access token' : 'invalid access token'}); ${obj} is used as a neutral read-only target.`);
    return base({
      title: `${auth === 'none' ? 'No' : 'Invalid'} access token on ${obj}`,
      method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT Id FROM ${obj} LIMIT 1` }, auth, testType: 'Security',
      assertions: [{ type: 'status', op: 'eq', expected: 401 }, { type: 'sfError', op: 'eq', expected: 'INVALID_SESSION_ID' }],
    });
  }

  // 2) Missing / omitted field.
  if (wants.missing && mentioned.length) {
    const f = findFieldAmong(describe, mentioned) || describe.fields.find((x) => mentioned.includes(x.name));
    if (f) {
      const body = { ...basePayload };
      delete body[f.name];
      const required = Boolean(f.required);
      notes.push(required
        ? `${f.name} is required on ${obj}; expecting Salesforce to reject the request.`
        : `${f.name} is optional on ${obj}; Salesforce is expected to accept the request without it.`);
      return base({
        title: `Create ${obj} without ${f.name}`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body, testType: required ? 'Negative' : 'Functional',
        assertions: required
          ? [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'REQUIRED_FIELD_MISSING' }]
          : [{ type: 'status', op: 'eq', expected: 201 }, { type: 'jsonpath', path: '$.success', op: 'eq', expected: true }],
      });
    }
  }
  if (wants.missing && !mentioned.length) {
    notes.push(`Could not identify which ${obj} field the scenario refers to; name it explicitly, e.g. "without a LastName".`);
  }

  // 3) Invalid email.
  if (wants.invalidEmail) {
    const f = findFieldAmong(describe, mentioned, (x) => x.type === 'email') || describe.fields.find((x) => x.type === 'email' && x.createable);
    if (f) {
      return base({
        title: `Create ${obj} with malformed ${f.name}`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...basePayload, [f.name]: 'not-an-email' }, testType: 'Negative',
        assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_EMAIL_ADDRESS' }],
      });
    }
    notes.push(`${obj} has no email field to test an invalid address against.`);
  }

  // 4) Field length boundary (over or at the maximum).
  if (wants.overMax || wants.atMax) {
    const f = findFieldAmong(describe, mentioned, (x) => x.type === 'string' && x.length)
      || describe.fields.find((x) => x.createable && x.type === 'string' && x.length && !x.unique);
    if (f) {
      if (wants.overMax) {
        return base({
          title: `Create ${obj} with ${f.name} over the maximum length (${f.length})`, method: 'POST', endpoint: `${v}/sobjects/${obj}`,
          body: { ...basePayload, [f.name]: `{{$randomString:${f.length + 1}}}` }, testType: 'Boundary',
          assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'STRING_TOO_LONG' }],
        });
      }
      return base({
        title: `Create ${obj} with ${f.name} at the maximum length (${f.length})`, method: 'POST', endpoint: `${v}/sobjects/${obj}`,
        body: { ...basePayload, [f.name]: `{{$randomString:${f.length}}}` }, testType: 'Boundary',
        assertions: [{ type: 'status', op: 'eq', expected: 201 }, { type: 'jsonpath', path: '$.success', op: 'eq', expected: true }],
        extract: [{ var: `${camel(obj)}MaxLenId`, path: '$.id' }], cleanup: { object: obj, idVar: `${camel(obj)}MaxLenId` },
      });
    }
    notes.push(`Could not find a text field with a length limit on ${obj} to test.`);
  }

  // 5) Invalid picklist value.
  if (wants.invalidPicklist) {
    const f = findFieldAmong(describe, mentioned, (x) => x.type === 'picklist') || describe.fields.find((x) => x.type === 'picklist' && x.restrictedPicklist && x.createable);
    if (f) {
      return base({
        title: `Create ${obj} with an invalid ${f.name} value`, method: 'POST', endpoint: `${v}/sobjects/${obj}`,
        body: { ...basePayload, [f.name]: 'QA_INVALID_VALUE' }, testType: 'Negative',
        assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST' }],
      });
    }
    notes.push(`${obj} has no restricted picklist field to test an invalid value against.`);
  }

  // 6) Non-numeric text in a numeric field.
  if (wants.nonNumeric) {
    const f = findFieldAmong(describe, mentioned, (x) => ['currency', 'double', 'int', 'percent'].includes(x.type))
      || describe.fields.find((x) => ['currency', 'double', 'int', 'percent'].includes(x.type) && x.createable);
    if (f) {
      return base({
        title: `Create ${obj} with text in numeric field ${f.name}`, method: 'POST', endpoint: `${v}/sobjects/${obj}`,
        body: { ...basePayload, [f.name]: 'abc' }, testType: 'Negative',
        assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'JSON_PARSER_ERROR' }],
      });
    }
  }

  // 7) Not-found style checks — also the safe single-call default for ad hoc
  //    update/delete requests, since no real record id is available here.
  if (wants.notFound || wants.delete || wants.update) {
    const fakeId = `${describe.keyPrefix || '001'}000000000000AAA`;
    if (wants.delete) {
      notes.push('No existing record id was supplied, so this checks delete behaviour against a non-existent record — a safe, single-call negative test. Use "Generate" mode for a full lifecycle test against a real record.');
      return base({ title: `Delete a non-existent ${obj} returns NOT_FOUND`, method: 'DELETE', endpoint: `${v}/sobjects/${obj}/${fakeId}`, testType: 'Negative', assertions: [{ type: 'status', op: 'eq', expected: 404 }] });
    }
    if (wants.update) {
      notes.push('No existing record id was supplied, so this checks update behaviour against a non-existent record — a safe, single-call negative test. Use "Generate" mode for a full lifecycle test against a real record.');
      return base({ title: `Update a non-existent ${obj} returns NOT_FOUND`, method: 'PATCH', endpoint: `${v}/sobjects/${obj}/${fakeId}`, body: { ...basePayload }, testType: 'Negative', assertions: [{ type: 'status', op: 'eq', expected: 404 }] });
    }
    return base({ title: `Retrieve a non-existent ${obj} returns NOT_FOUND`, method: 'GET', endpoint: `${v}/sobjects/${obj}/${fakeId}`, testType: 'Negative', assertions: [{ type: 'status', op: 'eq', expected: 404 }] });
  }

  // 8) Plain query/read.
  if (wants.query) {
    const qf = ['Id', ...Object.keys(basePayload).filter((k) => !/\{\{/.test(String(basePayload[k]))).slice(0, 3)].join(', ');
    return base({
      title: `Query recent ${obj} records`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT ${qf} FROM ${obj} ORDER BY LastModifiedDate DESC LIMIT 5` },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.done', op: 'eq', expected: true }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }],
    });
  }

  // 9) Default: happy-path create.
  notes.push('No specific negative/boundary condition was recognised in the scenario text; running a happy-path create instead.');
  const sfExpected = Object.fromEntries(Object.keys(basePayload).filter((k) => !/\{\{\$/.test(String(basePayload[k]))).map((k) => [k, `{{req.${k}}}`]));
  return base({
    title: `Create ${obj} with valid required fields`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: basePayload,
    assertions: [{ type: 'status', op: 'eq', expected: 201 }, { type: 'jsonpath', path: '$.success', op: 'eq', expected: true }, { type: 'jsonpath', path: '$.id', op: 'matches', expected: SF_ID_RX }],
    extract: [{ var: varId, path: '$.id' }], cleanup: { object: obj, idVar: varId },
    sfValidation: Object.keys(sfExpected).length ? { object: obj, idVar: varId, expected: sfExpected } : null,
  });
}

module.exports = { pickObject, buildAdHocTest };
