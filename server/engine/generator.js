'use strict';
/**
 * Test generation engine: Jira story → requirement analysis → metadata
 * discovery → API identification → scenarios → executable test cases.
 *
 * Provenance labels:
 *   VERIFIED     derived from live Salesforce describe metadata
 *   ASSUMED      derived from demo metadata, naming conventions or inference
 *   RECOMMENDED  suggested coverage needing configuration or confirmation
 */
const { prioritise } = require('./priority');
const { metadataLabel } = require('../connectors');
const ai = require('./ai');
const { apiTypeScenarios } = require('./apitypes');
const { commerceScenarios, enabled: commerceEnabled } = require('./commerce');
const { experienceScenarios, experienceEnabled } = require('./experience');
const { parseAcceptance, parseDocRules, applyAcceptance } = require('./acceptance');
const { loadFixtures, fixtureTests } = require('./org-fixtures');
const { httpScenarios } = require('./http-scenarios');
const contracts = require('./contracts');
const { matchEndpoints, listEndpoints, usesLegacyContract } = require('./endpoints');

const OPS = {
  create: /\b(create|creat(es|ing)|add|insert|new|register|submit|onboard)\b/i,
  read: /\b(get|retrieve|view|fetch|read|display|lookup|look up|show)\b/i,
  update: /\b(update|modif(y|ies)|change|edit|patch|set|amend|rating)\b/i,
  delete: /\b(delete|remove|purge|archive|deactivate)\b/i,
  upsert: /\b(upsert|sync|synchroni[sz]e|import|external id|idempoten)/i,
  query: /\b(query|search|list|filter|soql|report|portal|find)\b/i,
};
const INTEGRATION = /\b(middleware|mulesoft|boomi|informatica|erp|sap|external system|webhook|integration|inbound|outbound|callout|sync|platform event|change data capture|cdc)\b/i;
const API_HINTS = [
  ['Bulk API 2.0', /\b(bulk|batch load|large volume|million|csv load|data load)\b/i],
  ['Composite API', /\b(composite|in one call|single request|parent and child|transaction|all or none)\b/i],
  ['GraphQL API', /\bgraphql\b/i],
  ['Platform Events', /\b(platform event|__e\b|event bus)\b/i],
  ['Apex REST', /\b(apex rest|apexrest|custom endpoint|custom api)\b/i],
  ['SOAP API', /\bsoap\b/i],
  ['Tooling API', /\b(tooling|apex class|validation rule metadata)\b/i],
  ['Connect REST API', /\b(connect rest|connect api|chatter)\b/i],
  ['OAuth 2.0', /\b(oauth|connected app|jwt bearer|client credentials|refresh token|token endpoint)\b/i],
  ['Pagination', /\b(paginat\w*|nextRecordsUrl|query ?more|batch ?size)\b/i],
  ['Change Data Capture', /\b(change data capture|cdc|\w+ChangeEvent)\b/i],
  ['Commerce Cloud OCAPI', /\b(ocapi|open commerce api|demandware shop api)\b/i],
  ['Commerce Cloud SCAPI', /\b(scapi|shopper api|shopper-products|shopper-baskets|shopper-search|\bslas\b)\b/i],
  ['Commerce Cloud', /\b(commerce cloud|sfcc|b2c commerce|b2c storefront|storefront api|shopper basket|product search)\b/i],
  ['Experience Cloud', /\b(experience cloud|digital experience|community cloud|lwr site)\b/i],
  ['B2B Commerce', /\b(b2b commerce|b2b lightning|cloudcraze|webstore)\b/i],
];

const SF_ID_RX = '^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$';
const RESERVED_VARS = new Set(['siteId', 'orgId', 'shortCode', 'apiVersion', 'runId', 'instanceUrl', 'environment', 'httpBaseUrl', 'accessToken', 'sessionId', 'ccSiteId', 'ccOrgId', 'ccShortCode']);
/** Common English words that are also Salesforce API names — do not match lowercase “site”/“image” in storefront stories. */
const AMBIGUOUS_OBJECTS = new Set(['Site', 'Image', 'Document', 'Folder', 'Attachment', 'Note', 'Dashboard', 'Report', 'ListView', 'Topic', 'FeedItem', 'Photo', 'ContentDocument', 'ContentVersion', 'ContentBody']);

function words(text) { return String(text || '').toLowerCase(); }

function detectObjects(text, catalog) {
  const raw = String(text || '');
  const t = ' ' + words(text).replace(/[^a-z0-9_ ]/g, ' ') + ' ';
  const hits = [];
  for (const o of catalog) {
    if (AMBIGUOUS_OBJECTS.has(o.name)) {
      const api = o.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?:FROM|sobjects[/ ]|object(?:\\s+API)?(?:\\s+name)?)\\s+${api}\\b|\\b${api}__c\\b|\\b${api}\\b`).test(raw)) continue;
      if (!new RegExp(`\\b${api}\\b`).test(raw)) continue; // case-sensitive: “site” ≠ Site
    }
    const names = [o.name.toLowerCase(), (o.label || '').toLowerCase()].filter(Boolean);
    const forms = names.flatMap((n) => [n, n + 's', n.replace(/y$/, 'ies')]);
    if (forms.some((n) => n.length > 2 && t.includes(' ' + n + ' '))) hits.push(o.name);
  }
  // Prefer specific objects; drop generic ones if a custom object with the same label root exists.
  return [...new Set(hits)].filter((n) => !['User', 'Group', 'Name', 'Task', 'Event'].includes(n));
}

function detectFields(text, describe) {
  if (!describe) return [];
  const t = words(text);
  return describe.fields.filter((f) => {
    if (['Id', 'OwnerId', 'CreatedDate', 'LastModifiedDate', 'IsDeleted', 'Name'].includes(f.name) && !t.includes(f.name.toLowerCase())) return false;
    const label = (f.label || '').toLowerCase();
    return t.includes(f.name.toLowerCase()) || (label.length > 3 && new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
  }).map((f) => f.name);
}

function acceptanceList(story) {
  const src = story.acceptanceCriteria || '';
  return src.split(/\n|(?=\bGiven\b)/).map((s) => s.replace(/^[\s\-*\d.)]+/, '').trim()).filter((s) => s.length > 3);
}

const iso = (d) => d.toISOString().slice(0, 10);

function pickValues(f) {
  return (f.picklistValues || []).map((p) => (typeof p === 'string' ? p : p && (p.value || p.label))).filter((v) => typeof v === 'string' && v);
}

/** Generate a realistic value for a field. */
function sampleValue(f, { variant = 'valid', obj } = {}) {
  const max = f.length || 80;
  switch (f.type) {
    case 'email': return '{{$randomEmail}}';
    case 'phone': return '+1 415 555 0142';
    case 'url': return 'https://qa.example.com';
    case 'picklist': return pickValues(f)[0] || 'Other';
    case 'multipicklist': return pickValues(f)[0] || '';
    case 'date': return iso(new Date(Date.now() + 30 * 864e5));
    case 'datetime': return new Date(Date.now() + 864e5).toISOString();
    case 'boolean': return true;
    case 'currency': case 'double': case 'number': return 1500;
    case 'percent': return 50;
    case 'int': return 25;
    case 'textarea': return 'Created by Salesforce API QA automation.';
    default: {
      if (/name/i.test(f.name)) return `QA ${obj || ''} {{$timestamp}}`.slice(0, Math.max(8, max)).replace(/\s+/g, ' ').trim();
      if (f.externalId || f.unique) return `QA-{{$uuid}}`.slice(0, Math.max(8, max));
      return `QA value`.slice(0, max);
    }
  }
}

function buildPayload(describe, fieldsMentioned, overrides = {}) {
  const body = {};
  const mustInclude = new Set(fieldsMentioned);
  for (const f of describe.fields) {
    if (!f.createable || f.calculated) continue;
    if (f.type === 'reference') continue; // parents are wired explicitly
    if (f.required || mustInclude.has(f.name)) body[f.name] = sampleValue(f, { obj: describe.name });
  }
  // A couple of commonly-populated optional fields to make the record realistic.
  const extras = describe.fields.filter((f) => f.createable && !f.calculated && f.type !== 'reference' && !(f.name in body) && ['email', 'phone', 'picklist'].includes(f.type) && !f.restrictedPicklist).slice(0, 2);
  for (const f of extras) body[f.name] = sampleValue(f, { obj: describe.name });
  return { ...body, ...overrides };
}

function requiredParents(describe) {
  return describe.fields.filter((f) => f.type === 'reference' && f.required && f.createable && f.referenceTo && f.referenceTo.length);
}

function camel(s) { return s.replace(/__c$/, '').replace(/_/g, '').replace(/^./, (c) => c.toLowerCase()); }

function recordIdVar(obj) {
  const v = `${camel(obj)}Id`;
  return RESERVED_VARS.has(v) ? `${camel(obj)}RecordId` : v;
}

class SuiteBuilder {
  constructor({ project, story, label }) {
    this.project = project;
    this.story = story;
    this.label = label;
    this.scenarios = [];
    this.v = '/services/data/v{{apiVersion}}';
    this.sla = (project.businessConfig && project.businessConfig.slaMs) || 2000;
  }

  scenario(title, type, apiType, object, description) {
    const s = { title, type, apiType, object, description, label: this.label, testCases: [] };
    this.scenarios.push(s);
    return s;
  }

  add(s, tc) {
    const full = {
      apiType: tc.apiType || (s.apiType === 'Apex REST' || /^(OCAPI|SCAPI|Bulk API|Composite|GraphQL|SOAP|Tooling)/.test(s.apiType || '') ? s.apiType : 'REST'), auth: 'default', headers: {}, query: {}, extract: [], tags: [], label: s.label,
      testType: s.type, object: s.object, status: 'ready', ...tc,
    };
    if (!full.assertions.some((a) => a.type === 'responseTime') && full.auth === 'default') {
      full.assertions.push({ type: 'responseTime', op: 'lt', expected: this.sla });
    }
    const p = prioritise({ ...full }, { project: this.project, story: this.story });
    if ((full.tags || []).includes('authentication')) p.priority = 'P0';
    full.priority = tc.priority || p.priority;
    full.priorityReason = p;
    if (['P0', 'P1'].includes(full.priority) && ['Functional', 'Integration', 'Security'].includes(full.testType)) full.tags = [...new Set([...(full.tags || []), 'regression'])];
    s.testCases.push(full);
    return full;
  }

  finish() {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    for (const s of this.scenarios) {
      s.priority = s.testCases.reduce((best, t) => (order[t.priority] < order[best] ? t.priority : best), 'P3');
      if (s.testCases.some((t) => t.label === 'RECOMMENDED')) s.label = s.testCases.every((t) => t.label === 'RECOMMENDED') ? 'RECOMMENDED' : s.label;
    }
    return this.scenarios.filter((s) => s.testCases.length);
  }
}

function crudScenarios(b, d, analysis, objectFields) {
  const obj = d.name;
  const v = b.v;
  const varId = recordIdVar(obj);
  const ops = analysis.operations;
  const mentioned = objectFields[obj] || [];
  if (!d.createable && String(b.project.environment).toLowerCase() !== 'production') {
    analysis.gaps.push({ label: 'ASSUMED', text: `${obj} is not createable via the REST API in this org. Generated read/describe coverage only — storefront/Experience flows use Connect REST, not POST /sobjects/${obj}.` });
  }
  if (String(b.project.environment).toLowerCase() === 'production' || d.createable === false) {
    // Production is READ ONLY: generate non-mutating smoke coverage only.
    const ro = b.scenario(`${d.label} — read-only production smoke`, 'Functional', 'REST API', obj, 'Non-mutating checks safe for Production.');
    const qf = ['Id', ...d.fields.filter((f) => ['string', 'picklist'].includes(f.type) && !f.pii).slice(0, 3).map((f) => f.name)].join(', ');
    b.add(ro, { title: `Query most recent ${obj} records`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT ${qf} FROM ${obj} ORDER BY LastModifiedDate DESC LIMIT 5` }, assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.done', op: 'eq', expected: true }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }], extract: [{ var: varId, path: '$.records[0].Id' }] });
    b.add(ro, { title: `Retrieve an existing ${obj} by Id`, method: 'GET', endpoint: `${v}/sobjects/${obj}/{{${varId}}}`, assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.Id', op: 'eq', expected: `{{${varId}}}` }] });
    b.add(ro, { title: `Describe ${obj} metadata is reachable`, method: 'GET', endpoint: `${v}/sobjects/${obj}/describe`, assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.name', op: 'eq', expected: obj }] });
    b.add(ro, { title: 'Org API limits have headroom', method: 'GET', endpoint: `${v}/limits`, assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.DailyApiRequests.Remaining', op: 'gt', expected: 0 }] });
    const rn = b.scenario(`${d.label} — read-only negative checks`, 'Negative', 'REST API', obj, 'Invalid ids are rejected without side effects.');
    b.add(rn, { title: `Retrieve ${obj} with a non-existent Id`, method: 'GET', endpoint: `${v}/sobjects/${obj}/${d.keyPrefix || '001'}000000000000AAA`, assertions: [{ type: 'status', op: 'eq', expected: 404 }] });
    const rs = b.scenario(`${d.label} — authentication (read-only)`, 'Security', 'REST API', obj, 'Token handling on read endpoints.');
    b.add(rs, { title: `Query ${obj} without an access token`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT Id FROM ${obj} LIMIT 1` }, auth: 'none', assertions: [{ type: 'status', op: 'in', expected: [401, 403] }], tags: ['authentication'] });
    b.add(rs, { title: `Query ${obj} with an invalid access token`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT Id FROM ${obj} LIMIT 1` }, auth: 'invalid', assertions: [{ type: 'status', op: 'in', expected: [401, 403] }], tags: ['authentication'] });
    if (String(b.project.environment).toLowerCase() === 'production') {
      analysis.gaps.push({ label: 'RECOMMENDED', text: `Production project: create/update/delete tests for ${obj} were not generated (read-only by default). Cover writes in a sandbox.` });
    }
    return;
  }
  const parents = requiredParents(d);
  const optionalParents = d.fields.filter((f) => f.type === 'reference' && !f.required && f.createable && mentioned.includes(f.name));
  const fn = b.scenario(`${d.label} — create, read, update and query via REST`, 'Functional', 'REST API', obj, `Happy-path CRUD coverage for ${obj} with Salesforce data validation.`);

  const parentOverrides = {};
  for (const pf of [...parents, ...optionalParents]) {
    const parentObj = pf.referenceTo[0];
    const pVar = `${camel(parentObj)}ParentId`;
    if (analysis.describes[parentObj]) {
      const pd = analysis.describes[parentObj];
      b.add(fn, {
        title: `Setup: create parent ${parentObj} for ${obj}.${pf.name}`, method: 'POST', endpoint: `${v}/sobjects/${parentObj}`,
        body: buildPayload(pd, []), assertions: [{ type: 'status', op: 'eq', expected: 201 }, { type: 'jsonpath', path: '$.id', op: 'matches', expected: SF_ID_RX }],
        extract: [{ var: pVar, path: '$.id' }], tags: ['setup'], priority: 'P1', cleanup: { object: parentObj, idVar: pVar },
      });
      parentOverrides[pf.name] = `{{${pVar}}}`;
    }
  }

  const payload = buildPayload(d, mentioned, parentOverrides);
  analysis.parentOverrides = analysis.parentOverrides || {};
  analysis.parentOverrides[obj] = parentOverrides;
  const sfExpected = Object.fromEntries(Object.keys(payload).map((k) => [k, `{{req.${k}}}`]));
  const createsRecord = ops.includes('create') || ops.includes('upsert') || ops.length === 0 || ops.includes('update') || ops.includes('read') || ops.includes('delete');
  if (!createsRecord) {
    // Query-only stories: work from existing records rather than creating one.
    const qf = ['Id', ...Object.keys(payload).filter((k) => !/\{\{/.test(String(payload[k]))).slice(0, 3)].join(', ');
    b.add(fn, {
      title: `Query recent ${obj} records and capture an Id`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT ${qf} FROM ${obj} ORDER BY LastModifiedDate DESC LIMIT 5` },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.done', op: 'eq', expected: true }, { type: 'jsonpath', path: '$.totalSize', op: 'gt', expected: 0 }],
      extract: [{ var: varId, path: '$.records[0].Id' }],
    });
  }
  if (createsRecord) {
    b.add(fn, {
      title: `Create ${obj} with valid required and mapped fields`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: payload,
      assertions: [
        { type: 'status', op: 'eq', expected: 201 },
        { type: 'jsonpath', path: '$.success', op: 'eq', expected: true },
        { type: 'jsonpath', path: '$.id', op: 'matches', expected: SF_ID_RX },
        { type: 'jsonpath', path: '$.errors.length', op: 'eq', expected: 0 },
        { type: 'header', name: 'content-type', op: 'contains', expected: 'application/json' },
      ],
      extract: [{ var: varId, path: '$.id' }],
      sfValidation: { object: obj, idVar: varId, expected: sfExpected },
      cleanup: { object: obj, idVar: varId },
    });
    b.add(fn, {
      title: `Retrieve created ${obj} by Id and compare fields`, method: 'GET', endpoint: `${v}/sobjects/${obj}/{{${varId}}}`,
      assertions: [
        { type: 'status', op: 'eq', expected: 200 },
        { type: 'jsonpath', path: '$.Id', op: 'eq', expected: `{{${varId}}}` },
        ...Object.keys(payload).filter((k) => !/\{\{\$/.test(String(payload[k]))).slice(0, 4).map((k) => ({ type: 'jsonpath', path: `$.${k}`, op: 'eq', expected: payload[k] })),
      ],
    });
  }
  if (ops.includes('update') || ops.length === 0 || ops.includes('upsert')) {
    const upd = {};
    const summaryFields = detectFields(b.story.summary, d);
    const candidates = d.fields.filter((f) => f.updateable && !f.calculated && f.type !== 'reference' && (mentioned.includes(f.name) || f.type === 'picklist' || f.type === 'phone') && !f.externalId)
      .filter((f) => f.name !== 'Name' || summaryFields.includes('Name'))
      .sort((x, y) => (Number(summaryFields.includes(y.name)) * 2 + Number(mentioned.includes(y.name))) - (Number(summaryFields.includes(x.name)) * 2 + Number(mentioned.includes(x.name))));
    for (const f of candidates.slice(0, 2)) {
      const story = words(b.story.summary + ' ' + b.story.description + ' ' + b.story.acceptanceCriteria);
      const picks = pickValues(f);
      const pickFromStory = picks.find((pv) => story.includes(String(pv).toLowerCase()));
      upd[f.name] = f.type === 'picklist' && picks.length ? (pickFromStory || picks[Math.min(1, picks.length - 1)]) : sampleValue(f, { obj });
    }
    if (Object.keys(upd).length) {
      b.add(fn, {
        title: `Update ${obj} ${Object.keys(upd).join(', ')} and verify persisted values`, method: 'PATCH', endpoint: `${v}/sobjects/${obj}/{{${varId}}}`, body: upd,
        assertions: [{ type: 'status', op: 'eq', expected: 204 }],
        sfValidation: { object: obj, idVar: varId, expected: Object.fromEntries(Object.keys(upd).map((k) => [k, `{{req.${k}}}`])), automation: 'Detects flows/triggers that overwrite submitted values.' },
      });
    }
  }
  if (ops.includes('query') || ops.length === 0 || ops.includes('read')) {
    const qFields = ['Id', ...Object.keys(payload).slice(0, 4)].join(', ');
    b.add(fn, {
      title: `Query ${obj} via SOQL by Id`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT ${qFields} FROM ${obj} WHERE Id = '{{${varId}}}'` },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.totalSize', op: 'eq', expected: 1 }, { type: 'jsonpath', path: '$.records[0].Id', op: 'eq', expected: `{{${varId}}}` }],
    });
    if (analysis.queryFilters[obj]) {
      const qf = analysis.queryFilters[obj];
      b.add(fn, {
        title: `Query ${obj} list for ${qf.label} within SLA`, method: 'GET', endpoint: `${v}/query`, query: { q: qf.soql },
        assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.done', op: 'eq', expected: true }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }],
        tags: ['performance'],
      });
    }
  }
  const ext = d.fields.find((f) => f.externalId && f.createable);
  if (ext && (ops.includes('upsert') || analysis.integration)) {
    const upsertBody = buildPayload(d, mentioned, parentOverrides);
    delete upsertBody[ext.name];
    b.add(fn, {
      title: `Upsert ${obj} by ${ext.name} — insert path`, method: 'PATCH', endpoint: `${v}/sobjects/${obj}/${ext.name}/QA-UPSERT-{{runId}}`, body: upsertBody,
      assertions: [{ type: 'status', op: 'eq', expected: 201 }, { type: 'jsonpath', path: '$.created', op: 'eq', expected: true }],
      extract: [{ var: `${camel(obj)}UpsertId`, path: '$.id' }], cleanup: { object: obj, idVar: `${camel(obj)}UpsertId` },
    });
    b.add(fn, {
      title: `Upsert ${obj} by ${ext.name} — update path is idempotent`, method: 'PATCH', endpoint: `${v}/sobjects/${obj}/${ext.name}/QA-UPSERT-{{runId}}`, body: upsertBody,
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.created', op: 'eq', expected: false }, { type: 'jsonpath', path: '$.id', op: 'eq', expected: `{{${camel(obj)}UpsertId}}` }],
    });
  }
  if (ops.includes('delete')) {
    b.add(fn, {
      title: `Delete ${obj} and confirm it is no longer retrievable`, method: 'DELETE', endpoint: `${v}/sobjects/${obj}/{{${varId}}}`,
      assertions: [{ type: 'status', op: 'eq', expected: 204 }], seqHint: 900,
    });
    b.add(fn, {
      title: `Retrieve deleted ${obj} returns NOT_FOUND`, method: 'GET', endpoint: `${v}/sobjects/${obj}/{{${varId}}}`,
      assertions: [{ type: 'status', op: 'eq', expected: 404 }], seqHint: 901,
    });
  }

  // ── Negative ──
  const neg = b.scenario(`${d.label} — invalid input is rejected with clear errors`, 'Negative', 'REST API', obj, 'Validation of required fields, field names, values, ids and JSON syntax.');
  const req = d.fields.filter((f) => f.required && f.type !== 'reference');
  for (const f of req.slice(0, 2)) {
    const body = { ...payload };
    delete body[f.name];
    b.add(neg, {
      title: `Create ${obj} without required ${f.name}`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body,
      assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'REQUIRED_FIELD_MISSING' }, { type: 'jsonpath', path: '$[0].fields', op: 'contains', expected: f.name }],
    });
  }
  b.add(neg, {
    title: `Create ${obj} with a non-existent field`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, QA_Not_A_Field__c: 'x' },
    assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_FIELD' }],
  });
  const email = d.fields.find((f) => f.type === 'email' && f.createable);
  if (email) {
    b.add(neg, {
      title: `Create ${obj} with malformed ${email.name}`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, [email.name]: 'not-an-email' },
      assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_EMAIL_ADDRESS' }],
    });
  }
  const rp = d.fields.find((f) => f.type === 'picklist' && f.restrictedPicklist && f.createable);
  if (rp) {
    b.add(neg, {
      title: `Create ${obj} with value outside restricted picklist ${rp.name}`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, [rp.name]: 'QA_INVALID_VALUE' },
      assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST' }],
    });
  }
  const num = d.fields.find((f) => ['currency', 'double', 'int', 'percent'].includes(f.type) && f.createable);
  if (num) {
    b.add(neg, {
      title: `Create ${obj} with text in numeric field ${num.name}`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, [num.name]: 'abc' },
      assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'JSON_PARSER_ERROR' }],
    });
  }
  // Acceptance-criteria driven rules, e.g. "Amount must be greater than zero".
  for (const line of analysis.acceptanceCriteria || []) {
    if (!/(greater than zero|must be positive|> ?0\b|more than zero)/i.test(line)) continue;
    const nf = d.fields.find((f) => ['currency', 'double', 'int', 'percent'].includes(f.type) && f.createable && new RegExp(`\\b(${f.name}|${f.label})\\b`, 'i').test(line));
    if (!nf) continue;
    b.add(neg, {
      title: `${obj}.${nf.name} = 0 violates "${line.slice(0, 60)}"`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, [nf.name]: 0 },
      assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }], tags: ['acceptance-criteria'],
      description: `Derived from acceptance criterion: ${line}`,
    });
  }
  b.add(neg, {
    title: `Retrieve ${obj} with a well-formed but non-existent Id`, method: 'GET', endpoint: `${v}/sobjects/${obj}/${d.keyPrefix || '001'}000000000000AAA`,
    assertions: [{ type: 'status', op: 'eq', expected: 404 }, { type: 'sfError', op: 'eq', expected: 'NOT_FOUND' }],
  });
  b.add(neg, {
    title: `Retrieve ${obj} with a malformed Id`, method: 'GET', endpoint: `${v}/sobjects/${obj}/INVALID-ID-123`,
    assertions: [{ type: 'status', op: 'eq', expected: 404 }],
  });
  b.add(neg, {
    title: `Create ${obj} with invalid JSON body`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, bodyRaw: `{"${req[0] ? req[0].name : 'Name'}": "QA",`, headers: { 'Content-Type': 'application/json' },
    assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'JSON_PARSER_ERROR' }],
  });

  // ── Boundary ──
  const bnd = b.scenario(`${d.label} — field length and payload limits`, 'Boundary', 'REST API', obj, 'Maximum/minimum lengths, empty and null values, large payloads and record limits.');
  const strField = d.fields.find((f) => f.required && f.type === 'string' && f.length) || d.fields.find((f) => f.createable && f.type === 'string' && f.length && !f.unique);
  if (strField) {
    b.add(bnd, {
      title: `${obj}.${strField.name} at maximum length (${strField.length})`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, [strField.name]: `{{$randomString:${strField.length}}}` },
      assertions: [{ type: 'status', op: 'eq', expected: 201 }], extract: [{ var: `${camel(obj)}MaxLenId`, path: '$.id' }], cleanup: { object: obj, idVar: `${camel(obj)}MaxLenId` },
      sfValidation: { object: obj, idVar: `${camel(obj)}MaxLenId`, expected: { [strField.name]: `{{req.${strField.name}}}` } },
    });
    b.add(bnd, {
      title: `${obj}.${strField.name} one character over maximum (${strField.length + 1})`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, [strField.name]: `{{$randomString:${strField.length + 1}}}` },
      assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'STRING_TOO_LONG' }],
    });
    b.add(bnd, {
      title: `${obj}.${strField.name} at minimum length (1 character)`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, [strField.name]: 'Q' },
      assertions: [{ type: 'status', op: 'eq', expected: 201 }], extract: [{ var: `${camel(obj)}MinLenId`, path: '$.id' }], cleanup: { object: obj, idVar: `${camel(obj)}MinLenId` },
    });
  }
  if (req.length) {
    b.add(bnd, {
      title: `Create ${obj} with empty JSON object`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: {},
      assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'REQUIRED_FIELD_MISSING' }],
    });
    b.add(bnd, {
      title: `Create ${obj} with null required field ${req[0].name}`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, [req[0].name]: null },
      assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'REQUIRED_FIELD_MISSING' }],
    });
  }
  const ta = d.fields.find((f) => f.type === 'textarea' && f.createable && f.length >= 1000);
  if (ta) {
    b.add(bnd, {
      title: `Create ${obj} with large ${ta.name} payload (${ta.length} chars)`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: { ...payload, [ta.name]: `{{$randomString:${ta.length}}}` },
      assertions: [{ type: 'status', op: 'eq', expected: 201 }], extract: [{ var: `${camel(obj)}LargeId`, path: '$.id' }], cleanup: { object: obj, idVar: `${camel(obj)}LargeId` },
    });
  }
  if (!parents.length) {
    const rec = Object.fromEntries(Object.entries(payload).filter(([, val]) => !/\{\{\w+Id\}\}/.test(String(val))));
    const uniqueSafe = (i) => Object.fromEntries(Object.entries(rec).map(([k, val]) => {
      const f = d.fields.find((x) => x.name === k);
      if (f && (f.unique || f.externalId || f.type === 'email')) return [k, f.type === 'email' ? `qa.bulk${i}.{{runId}}@example.com` : `QA-${i}-{{runId}}`];
      return [k, val];
    }));
    b.add(bnd, {
      title: `Composite collection: create 200 ${obj} records (platform maximum)`, apiType: 'Composite', method: 'POST', endpoint: `${v}/composite/sobjects`,
      body: { allOrNone: false, records: Array.from({ length: 200 }, (_, i) => ({ attributes: { type: obj }, ...uniqueSafe(i) })) },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.length', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$[199].success', op: 'eq', expected: true }],
      cleanup: { object: obj, fromCompositeResponse: true }, tags: ['bulk'],
    });
    b.add(bnd, {
      title: `Composite collection: 201 ${obj} records exceeds limit`, apiType: 'Composite', method: 'POST', endpoint: `${v}/composite/sobjects`,
      body: { allOrNone: true, records: Array.from({ length: 201 }, (_, i) => ({ attributes: { type: obj }, ...uniqueSafe(i + 1000) })) },
      assertions: [{ type: 'status', op: 'eq', expected: 400 }],
    });
  }

  // ── Security ──
  const sec = b.scenario(`${d.label} — authentication and authorization`, 'Security', 'REST API', obj, 'Token handling, object/field/record access for restricted users.');
  b.add(sec, {
    title: `Create ${obj} without an access token`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: payload, auth: 'none',
    assertions: [{ type: 'status', op: 'in', expected: [401, 403] }], tags: ['authentication'],
  });
  b.add(sec, {
    title: `Query ${obj} with an invalid / expired access token`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT Id FROM ${obj} LIMIT 1` }, auth: 'invalid',
    assertions: [{ type: 'status', op: 'in', expected: [401, 403] }], tags: ['authentication'],
  });
  const lp = (b.project.businessConfig && b.project.businessConfig.lowPrivilegeExpectations) || null;
  if (lp) {
    if ((lp.noAccessObjects || []).includes(obj)) {
      b.add(sec, {
        title: `Restricted user cannot query ${obj} (object access)`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT Id FROM ${obj} LIMIT 1` }, auth: 'lowpriv',
        assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_TYPE' }], tags: ['authorization', 'object-access'],
      });
    }
    if ((lp.readOnlyObjects || []).includes(obj)) {
      b.add(sec, {
        title: `Read-only user cannot create ${obj} (CRUD)`, method: 'POST', endpoint: `${v}/sobjects/${obj}`, body: payload, auth: 'lowpriv',
        assertions: [{ type: 'status', op: 'in', expected: [400, 403] }, { type: 'sfError', op: 'eq', expected: 'INSUFFICIENT_ACCESS_OR_READONLY' }], tags: ['authorization', 'record-access'],
      });
      if ((analysis.operations || []).some((o) => o === 'update' || o === 'upsert')) {
        const [editField] = Object.keys(payload);
        b.add(sec, {
          title: `Read-only user cannot update ${obj} (CRUD)`, method: 'PATCH', endpoint: `${v}/sobjects/${obj}/{{${varId}}}`, body: { [editField]: payload[editField] }, auth: 'lowpriv',
          assertions: [{ type: 'status', op: 'in', expected: [400, 403] }, { type: 'sfError', op: 'eq', expected: 'INSUFFICIENT_ACCESS_OR_READONLY' }], tags: ['authorization', 'record-access'],
        });
      }
    }
    for (const hf of ((lp.hiddenFields || {})[obj] || []).slice(0, 1)) {
      b.add(sec, {
        title: `Restricted user cannot read ${obj}.${hf} (field-level security)`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT Id, ${hf} FROM ${obj} LIMIT 1` }, auth: 'lowpriv',
        assertions: [{ type: 'status', op: 'eq', expected: 400 }, { type: 'sfError', op: 'eq', expected: 'INVALID_FIELD' }], tags: ['authorization', 'fls'],
      });
    }
    if (!(lp.noAccessObjects || []).includes(obj) && !(lp.readOnlyObjects || []).includes(obj)) {
      b.add(sec, {
        title: `Restricted user can read ${obj} records it is entitled to`, method: 'GET', endpoint: `${v}/query`, query: { q: `SELECT Id FROM ${obj} LIMIT 5` }, auth: 'lowpriv',
        assertions: [{ type: 'status', op: 'eq', expected: 200 }], tags: ['authorization'],
      });
    }
  } else {
    b.add(sec, {
      title: `Restricted user cannot modify ${obj} (needs low-privilege user + expectations)`, method: 'PATCH', endpoint: `${v}/sobjects/${obj}/{{${varId}}}`, body: { [Object.keys(payload)[0]]: 'QA restricted edit' }, auth: 'lowpriv',
      assertions: [{ type: 'status', op: 'in', expected: [400, 403, 404] }], tags: ['authorization'], label: 'RECOMMENDED', status: 'draft',
      description: 'Configure a low-privilege user (SF_<PREFIX>_LOWPRIV_*) and record its expected object/field access in Project → Business rules to make this executable.',
    });
  }
}

function happyAssertions(e) {
  const success = e.successStatus && e.successStatus.length ? e.successStatus : [200, 201];
  const assertions = [{ type: 'status', op: 'in', expected: success }];
  const legacy = usesLegacyContract(e);
  const needsId = Boolean(e.object) && (legacy || (e.transformChecks && e.transformChecks.length) || (e.requestMapping && Object.keys(e.requestMapping).length));
  const idPath = e.idPath || (legacy || needsId ? '$.salesforceId' : '');
  if (idPath) {
    assertions.push({ type: 'jsonpath', path: idPath, op: legacy ? 'matches' : 'exists', expected: legacy ? SF_ID_RX : undefined });
  }
  if (e.successPath) assertions.push({ type: 'jsonpath', path: e.successPath, op: 'eq', expected: e.successValue === undefined ? 'SUCCESS' : e.successValue });
  else if (legacy) assertions.push({ type: 'jsonpath', path: '$.status', op: 'eq', expected: 'SUCCESS' });
  if (e.responseSchema) assertions.push({ type: 'schema', expected: e.responseSchema });
  return { assertions, idPath, success };
}

function integrationScenarios(b, analysis) {
  const endpoints = listEndpoints(b.project);
  const matched = matchEndpoints(endpoints, b.story);
  analysis.matchedEndpoints = matched.map((e) => ({ id: e.id, name: e.name, path: e.path, method: e.method }));
  for (const e of matched) {
    const apiType = e.kind === 'http' ? 'HTTP' : 'Apex REST';
    const s = b.scenario(`${e.name} — ${e.direction || 'External System → Middleware → Salesforce'}`, 'Integration', apiType, e.object, e.description || 'Integration contract, mapping, retry/idempotency, duplicate handling and timeout behaviour.');
    const idVar = `${camel(e.object || 'record')}IntegrationId`;
    const sample = e.samplePayload || {};
    const mapping = e.requestMapping || {};
    const sfExpected = Object.fromEntries(Object.entries(mapping).map(([apiField, sfField]) => [sfField, `{{req.${apiField}}}`]));
    const happy = happyAssertions(e);
    const extract = happy.idPath ? [{ var: idVar, path: happy.idPath }] : [];
    const cleanup = e.object && happy.idPath ? { object: e.object, idVar } : undefined;
    const sfValidation = e.object && Object.keys(mapping).length ? { object: e.object, idVar, expected: sfExpected, mappingCheck: true } : undefined;
    b.add(s, {
      title: `${e.name}: valid payload is accepted${e.object ? ` and mapped to ${e.object}` : ''}`, apiType, method: e.method || 'POST', endpoint: e.path, body: sample,
      assertions: happy.assertions,
      extract, cleanup, sfValidation, tags: ['request-mapping', e.id],
    });
    const contractAssertions = [{ type: 'status', op: 'in', expected: happy.success }];
    if (e.responseSchema) contractAssertions.push({ type: 'schema', expected: e.responseSchema });
    else if (usesLegacyContract(e)) {
      contractAssertions.push({ type: 'schema', expected: { type: 'object', required: ['status', 'salesforceId'], properties: { status: { type: 'string', enum: ['SUCCESS', 'ERROR'] }, salesforceId: { type: 'string', pattern: SF_ID_RX } } } });
    }
    if (contractAssertions.length > 1 || e.responseSchema) {
      b.add(s, {
        title: `${e.name}: response contract`, apiType, method: e.method || 'POST', endpoint: e.path, body: e.secondPayload || sample,
        assertions: contractAssertions, tags: ['response-mapping', 'contract', e.id],
      });
    }
    if (e.transformChecks && e.transformChecks.length) {
      b.add(s, {
        title: `${e.name}: data transformation persisted in Salesforce`, apiType: 'REST', method: 'GET', endpoint: `${b.v}/query`,
        query: { q: `SELECT Id, ${e.transformChecks.map((c) => c.field).join(', ')} FROM ${e.object} WHERE Id = '{{${idVar}}}'` },
        assertions: [{ type: 'status', op: 'eq', expected: 200 }, ...e.transformChecks.map((c) => ({ type: 'jsonpath', path: `$.records[0].${c.field}`, op: 'eq', expected: c.expected }))],
        tags: ['transformation'],
      });
    }
    if (e.idempotencyHeader) {
      const retryExtract = happy.idPath ? [{ var: `${idVar}Retry`, path: happy.idPath }] : [];
      b.add(s, {
        title: `${e.name}: retry with same ${e.idempotencyHeader} is idempotent (first call)`, apiType, method: e.method || 'POST', endpoint: e.path,
        headers: { [e.idempotencyHeader]: 'QA-IDEM-{{runId}}' }, body: e.retryPayload || sample,
        assertions: [{ type: 'status', op: 'in', expected: happy.success }], extract: retryExtract, tags: ['retry', e.id],
      });
      const retryAssert = [{ type: 'status', op: 'in', expected: happy.success }];
      if (happy.idPath) retryAssert.push({ type: 'jsonpath', path: happy.idPath, op: 'eq', expected: `{{${idVar}Retry}}` });
      b.add(s, {
        title: `${e.name}: retry with same ${e.idempotencyHeader} returns the same record`, apiType, method: e.method || 'POST', endpoint: e.path,
        headers: { [e.idempotencyHeader]: 'QA-IDEM-{{runId}}' }, body: e.retryPayload || sample,
        assertions: retryAssert, tags: ['retry', e.id],
      });
    }
    if (e.duplicateExpect && e.duplicateExpect.length) {
      b.add(s, {
        title: `${e.name}: duplicate business key is handled gracefully`, apiType, method: e.method || 'POST', endpoint: e.path, body: sample,
        assertions: [{ type: 'status', op: 'in', expected: e.duplicateExpect }, { type: 'jsonpath', path: '$', op: 'notContains', expected: 'System.' }], tags: ['duplicate-handling', e.id],
      });
    }
    if (e.invalidPayload) {
      const errStatus = e.errorStatus || 400;
      const errAssert = [{ type: 'status', op: 'eq', expected: errStatus }];
      if (e.errorPath) errAssert.push({ type: 'jsonpath', path: e.errorPath, op: e.errorValue === undefined ? 'exists' : 'eq', expected: e.errorValue });
      else if (usesLegacyContract(e)) {
        errAssert.push({ type: 'jsonpath', path: '$.status', op: 'eq', expected: 'ERROR' });
        errAssert.push({ type: 'jsonpath', path: '$.message', op: 'exists' });
      }
      b.add(s, {
        title: `${e.name}: invalid payload returns a structured error`, apiType, method: e.method || 'POST', endpoint: e.path, body: e.invalidPayload,
        assertions: errAssert, tags: ['error-contract', e.id],
      });
    }
    b.add(s, {
      title: `${e.name}: unauthenticated call is rejected`, apiType, method: e.method || 'POST', endpoint: e.path, body: sample, auth: 'none',
      assertions: [{ type: 'status', op: 'in', expected: [401, 403] }], tags: ['authentication', e.id],
    });
    if (e.healthPath) {
      b.add(s, {
        title: `${e.name}: downstream health responds within ${e.timeoutMs || 2000} ms (timeout guard)`, apiType: 'Apex REST', method: 'GET', endpoint: e.healthPath,
        assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'responseTime', op: 'lt', expected: e.timeoutMs || 2000 }], timeoutMs: (e.timeoutMs || 2000) + 1000, tags: ['timeout'],
      });
    }
  }
  if (matched.length === 0 && analysis.integration) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: 'No matching custom Apex REST / HTTP endpoint. Add it on Project → Other systems, or link endpoints on the story. Experience Cloud and Commerce Cloud paths are not stored here.' });
    const s = b.scenario('Integration coverage — endpoint not yet configured', 'Integration', 'REST API', analysis.objects[0], 'The story references an integration, but no matching endpoint exists in Project → Other systems.');
    b.add(s, {
      title: 'Partial failure: composite request with one invalid record (allOrNone=false)', apiType: 'Composite', method: 'POST', endpoint: `${b.v}/composite/sobjects`,
      body: { allOrNone: false, records: analysis.objects[0] && analysis.describes[analysis.objects[0]] ? [{ attributes: { type: analysis.objects[0] }, ...buildPayload(analysis.describes[analysis.objects[0]], []) }, { attributes: { type: analysis.objects[0] } }] : [] },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$[0].success', op: 'eq', expected: true }, { type: 'jsonpath', path: '$[1].success', op: 'eq', expected: false }],
      tags: ['partial-failure'],
    });
    b.add(s, {
      title: 'Middleware → Salesforce mapping, retry, timeout and duplicate handling (configure endpoint)', method: 'POST', endpoint: '/services/apexrest/<configure-endpoint>',
      body: {}, assertions: [{ type: 'status', op: 'in', expected: [200, 201] }], label: 'RECOMMENDED', status: 'draft',
      description: 'Add the integration endpoint, request mapping and expected duplicate/timeout behaviour in Project → Integration to generate executable tests.',
    });
  }
  // Composite partial failure for matched integrations on first object
  if (matched.length && analysis.objects[0] && analysis.describes[analysis.objects[0]]) {
    const o = analysis.objects[0];
    const s = b.scenarios.find((x) => x.type === 'Integration');
    b.add(s, {
      title: `Partial failure: ${o} batch with one invalid record (allOrNone=false)`, apiType: 'Composite', method: 'POST', endpoint: `${b.v}/composite/sobjects`,
      body: { allOrNone: false, records: [{ attributes: { type: o }, ...buildPayload(analysis.describes[o], [], (analysis.parentOverrides || {})[o] || {}) }, { attributes: { type: o } }] },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$[0].success', op: 'eq', expected: true }, { type: 'jsonpath', path: '$[1].success', op: 'eq', expected: false }],
      cleanup: { object: o, fromCompositeResponse: true }, tags: ['partial-failure'],
    });
  }
}

const INPUT_SOURCES = ['jira', 'docs', 'jira+docs'];

function normalizeInputSource(raw) {
  const s = String(raw || '').toLowerCase().replace(/[\s_]+/g, '');
  if (['jira', 'ticket', 'tickets', 'jiraticket', 'jiratickets'].includes(s)) return 'jira';
  if (['docs', 'doc', 'integrationdoc', 'integrationdocs', 'document', 'documents'].includes(s)) return 'docs';
  if (['jira+docs', 'jiraanddocs', 'both', 'combined', 'ticket+doc', 'ticket+docs', 'jiraticket+integrationdoc'].includes(s)) return 'jira+docs';
  return null;
}

function docsText(docs) {
  return (docs || []).map((d) => `## ${d.name || 'Document'}\n${d.body || ''}`).join('\n\n').trim();
}

/** Story-shaped view used as generator input for the selected source. story.key is preserved for linking. */
function storyViewForSource(story, docs, inputSource) {
  const src = normalizeInputSource(inputSource) || 'jira+docs';
  const body = docsText(docs);
  if (src === 'docs') {
    return {
      ...story,
      summary: (docs && docs[0] && docs[0].name) || 'Integration document',
      description: body,
      acceptanceCriteria: '',
    };
  }
  if (src === 'jira') return { ...story };
  return {
    ...story,
    description: [story.description || '', body].filter(Boolean).join('\n\n'),
  };
}

/**
 * Analyse a story and/or integration docs and build a proposed suite.
 * @returns {{analysis, scenarios}}
 */
async function generateSuite({ project, story, sf, docs = [], inputSource = 'jira+docs' }) {
  const src = normalizeInputSource(inputSource) || 'jira+docs';
  const view = storyViewForSource(story, docs, src);
  const text = `${view.summary}\n${view.description || ''}\n${view.acceptanceCriteria || ''}`;
  const label = metadataLabel(project);
  const notes = [];
  let catalog = [];
  let metadataSource = project.mode === 'demo' ? 'Demo org simulator (sample metadata)' : 'Live Salesforce describe';
  try {
    catalog = await sf.describeGlobal();
  } catch (e) {
    notes.push({ label: 'ASSUMED', text: `Salesforce metadata discovery unavailable: ${e.explanation ? e.explanation.title : e.message}. Objects inferred from ${src === 'docs' ? 'integration docs' : 'story text'} only.` });
    metadataSource = 'Unavailable — inferred from story text';
  }
  let objects = catalog.length ? detectObjects(text, catalog) : (text.match(/\b([A-Z][A-Za-z]+(__c)?)\b/g) || []).filter((w) => ['Account', 'Contact', 'Lead', 'Opportunity', 'Case'].includes(w) || w.endsWith('__c'));
  objects = [...new Set(objects)];
  // Objects named in the summary are the subject; others mentioned only in the
  // description (e.g. a parent Account) are wired as setup/parents, not suites.
  if (catalog.length && objects.length > 1 && src !== 'docs') {
    const inSummary = detectObjects(view.summary, catalog);
    if (inSummary.length) objects = objects.filter((o) => inSummary.includes(o));
  }

  // Integration endpoints can bring their own target object.
  const endpoints = (project.integrationConfig && project.integrationConfig.endpoints) || [];
  const lower = words(text);
  for (const e of endpoints) if ((e.keywords || []).some((k) => lower.includes(k.toLowerCase())) && e.object && !objects.includes(e.object)) objects.push(e.object);

  const describes = {};
  const objectFields = {};
  let effectiveLabel = label;
  for (const o of objects.slice(0, 4)) {
    try {
      describes[o] = await sf.describe(o);
      objectFields[o] = detectFields(text, describes[o]);
      for (const pf of requiredParents(describes[o])) {
        const po = pf.referenceTo[0];
        if (!describes[po]) { try { describes[po] = await sf.describe(po); } catch { /* optional */ } }
      }
      for (const f of describes[o].fields.filter((x) => x.type === 'reference' && objectFields[o].includes(x.name))) {
        const po = f.referenceTo[0];
        if (po && !describes[po]) { try { describes[po] = await sf.describe(po); } catch { /* optional */ } }
      }
    } catch (e) {
      notes.push({ label: 'ASSUMED', text: `Describe for ${o} failed: ${e.explanation ? e.explanation.title : e.message}` });
      effectiveLabel = 'ASSUMED';
    }
  }
  const operations = Object.entries(OPS).filter(([, rx]) => rx.test(text)).map(([k]) => k);
  const integration = INTEGRATION.test(text);
  const apiTypes = ['REST API', ...API_HINTS.filter(([, rx]) => rx.test(text)).map(([n]) => n)];
  const detectedTypes = ((project.integrationConfig && project.integrationConfig.salesforceDetection) || {}).types || [];
  if (detectedTypes.some((t) => /SFCC/i.test(t) || t === 'B2C Commerce' || t === 'B2C Commerce / SFCC') && !apiTypes.some((t) => /Commerce Cloud/i.test(t))) apiTypes.push('Commerce Cloud');
  if (detectedTypes.some((t) => /Experience Cloud/i.test(t) || t === 'Experience / B2B Commerce') && !apiTypes.includes('Experience Cloud')) apiTypes.push('Experience Cloud');
  if (detectedTypes.some((t) => t === 'Experience Cloud B2B' || t === 'Experience / B2B Commerce') && !apiTypes.includes('B2B Commerce')) apiTypes.push('B2B Commerce');
  if (commerceEnabled(project) && !apiTypes.some((t) => /Commerce Cloud/i.test(t))) apiTypes.push('Commerce Cloud');
  if (experienceEnabled(project) && !apiTypes.some((t) => /Experience|B2B Commerce/i.test(t))) apiTypes.push('Experience Cloud');
  if (endpoints.some((e) => (e.keywords || []).some((k) => lower.includes(k.toLowerCase())))) apiTypes.push('Apex REST');
  const queryFilters = {};
  for (const o of objects) {
    const qf = (project.businessConfig && project.businessConfig.queryTemplates || {})[o];
    if (qf && operations.includes('query')) queryFilters[o] = qf;
  }
  const ac = acceptanceList(view);
  const acceptance = parseAcceptance(view);
  // With Jira AC present, the AC wins in parseAcceptance — doc rules would otherwise be ignored.
  if (src === 'jira+docs' && view.acceptanceCriteria && docs.length) {
    const seen = new Set(acceptance.map((a) => a.text));
    for (const r of parseDocRules(docs)) if (!seen.has(r.text)) acceptance.push(r);
  }
  const gaps = [];
  if (!ac.length) {
    gaps.push({
      label: 'RECOMMENDED',
      text: src === 'docs'
        ? 'Integration doc has no explicit acceptance criteria — expected status codes and error behaviour are assumed from Salesforce defaults.'
        : 'Story has no acceptance criteria — expected status codes and error behaviour are assumed from Salesforce defaults.',
    });
  }
  if (!/error|invalid|fail|reject/i.test(text)) gaps.push({ label: 'RECOMMENDED', text: 'Error handling is not specified. Confirm expected error codes/messages for invalid input.' });
  if (!/permission|profile|access|role|security|authori/i.test(text)) gaps.push({ label: 'RECOMMENDED', text: 'Authorization requirements are not stated. Confirm which users/profiles may perform this operation.' });
  if (integration && !/retry|idempot|duplicate/i.test(text)) gaps.push({ label: 'RECOMMENDED', text: 'Integration story does not define retry/idempotency or duplicate handling. Tests assume no duplicates and safe retries.' });
  if (integration && !/timeout|sla|latency|response time/i.test(text)) gaps.push({ label: 'RECOMMENDED', text: 'No timeout/SLA defined. Using project SLA of ' + ((project.businessConfig && project.businessConfig.slaMs) || 2000) + ' ms.' });
  if (!objects.length && !apiTypes.some((t) => /Commerce Cloud/i.test(t))) {
    gaps.push({
      label: 'RECOMMENDED',
      text: src === 'docs'
        ? 'No Salesforce object could be identified in the integration doc. Name the object (e.g. Contact) in the document.'
        : 'No Salesforce object could be identified. Name the object (e.g. Contact) in the story or select it manually.',
    });
  }

  let fixtures = {};
  try { fixtures = await loadFixtures(sf, objects, describes); } catch { fixtures = {}; }

  let commerceCatalog = null;
  if (commerceEnabled(project) || apiTypes.some((t) => /Commerce Cloud/i.test(t))) {
    try {
      const commerce = require('../connectors').commerceFor(project);
      if (commerce && typeof commerce.fetchCatalogSample === 'function') commerceCatalog = await commerce.fetchCatalogSample();
    } catch { commerceCatalog = null; }
  }

  const analysis = {
    storyKey: story.key, summary: story.summary, inputSource: src, objects, operations, integration, apiTypes: [...new Set(apiTypes)],
    catalogNames: (catalog || []).map((o) => o.name).filter(Boolean),
    fields: objectFields, acceptanceCriteria: ac, acceptance, gaps, notes, metadataSource, metadataLabel: effectiveLabel,
    describes: Object.fromEntries(Object.entries(describes).map(([k, d]) => [k, { name: d.name, label: d.label, keyPrefix: d.keyPrefix, fields: d.fields }])),
    queryFilters, fixtures, commerceCatalog,
  };

  const b = new SuiteBuilder({ project, story: { ...story, summary: view.summary, description: view.description, acceptanceCriteria: view.acceptanceCriteria }, label: effectiveLabel });
  for (const o of objects.slice(0, 3)) {
    if (!describes[o] || o.endsWith('__e')) continue;
    crudScenarios(b, describes[o], analysis, objectFields);
    if (fixtures[o]) fixtureTests(b, o, fixtures[o]);
  }
  integrationScenarios(b, analysis);
  apiTypeScenarios(b, analysis, { buildPayload, SF_ID_RX, camel });
  experienceScenarios(b, analysis);
  if (analysis.apiTypes.some((t) => /Commerce Cloud/i.test(t)) || commerceEnabled(project)) commerceScenarios(b, analysis);
  httpScenarios(b, analysis);
  analysis.acceptanceMapped = applyAcceptance(b.scenarios, acceptance);
  try { contracts.attachToScenarios(project, b.scenarios); } catch { /* contracts table may be empty in unit tests */ }
  // Run-scoped unique values ({{runId}}) are only unique *per run*. Two stories on the same object
  // generate identical keys, so they collide when executed together (e.g. a full regression).
  // Add a per-generation suffix, applied consistently across every test of this suite, so each
  // suite owns its data. Cross-test references inside the suite keep working because they all
  // receive the same suffix.
  const suffix = require('node:crypto').randomBytes(2).toString('hex');
  const scenarios = JSON.parse(JSON.stringify(b.finish()).split('{{runId}}').join(`{{runId}}-${suffix}`));

  // Optional AI augmentation — only adds RECOMMENDED ideas, never executable "facts".
  if (ai.enabled()) {
    const ideas = await ai.suggestCoverage(view, analysis, scenarios).catch(() => null);
    if (ideas && ideas.length) analysis.aiSuggestions = ideas.map((i) => ({ label: 'RECOMMENDED', text: i }));
  }
  const slim = { ...analysis, describes: Object.fromEntries(Object.entries(analysis.describes).map(([k, d]) => [k, { name: d.name, label: d.label, fieldCount: d.fields.length, requiredFields: d.fields.filter((f) => f.required).map((f) => f.name) }])) };
  return { analysis: slim, scenarios };
}

module.exports = {
  generateSuite, buildPayload, sampleValue, detectObjects, detectFields, OPS, recordIdVar,
  INPUT_SOURCES, normalizeInputSource, storyViewForSource, docsText,
};
