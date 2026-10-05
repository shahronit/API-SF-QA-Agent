'use strict';
/**
 * Demo Salesforce org simulator. Mimics Salesforce REST/Composite/Apex REST/
 * GraphQL/Tooling/Bulk 2.0/OAuth behaviour closely enough to exercise the QA
 * platform end-to-end without credentials. Includes four deliberate defects so
 * failure analysis, defect creation and reporting can be demonstrated:
 *   D1  Account.Rating "Hot" is overwritten to "Warm" by a simulated flow.
 *   D2  Apex REST /v1/invoices returns HTTP 500 on duplicate invoiceNumber.
 *   D3  Case SOQL queries respond slower than the 1500 ms SLA.
 *   D4  Apex REST /v1/leads drops the leadSource mapping.
 * All output is labelled demo data and never treated as VERIFIED org facts.
 */
const crypto = require('node:crypto');
const { OBJECTS, LOW_PRIV, describe } = require('./demo-metadata');

const SUPPORTED_VERSIONS = ['58.0', '59.0', '60.0', '61.0', '62.0', '63.0', '64.0'];
const stores = new Map(); // projectId -> { objects: {Obj: Map}, counters, idempotency, bulkJobs }

function checksumId(id15) {
  const map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    let flags = 0;
    for (let j = 0; j < 5; j++) {
      const c = id15.charAt(i * 5 + j);
      if (c >= 'A' && c <= 'Z') flags += 1 << j;
    }
    suffix += map.charAt(flags);
  }
  return id15 + suffix;
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function b62(n, len) {
  let s = '';
  while (n > 0) { s = B62[n % 62] + s; n = Math.floor(n / 62); }
  return s.padStart(len, '0');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isIdLike = (v) => typeof v === 'string' && /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(v);
const nowIso = () => new Date().toISOString().replace('Z', '+0000');

function sfError(status, errorCode, message, fields) {
  return { status, body: [{ message, errorCode, ...(fields ? { fields } : {}) }] };
}

class DemoSalesforce {
  constructor(project) {
    this.project = project;
    this.kind = 'demo';
    this.available = true;
    this.hasLowPrivilegeUser = true;
    if (!stores.has(project.id)) stores.set(project.id, this.seedStore());
    this.store = stores.get(project.id);
  }

  seedStore() {
    const s = { objects: {}, counters: {}, idempotency: new Map(), bulkJobs: new Map() };
    for (const name of Object.keys(OBJECTS)) s.objects[name] = new Map();
    this.store = s;
    const acme = this.insert('Account', { Name: 'Acme Corporation', AccountNumber: 'ACC-1001', Type: 'Customer - Direct', Industry: 'Manufacturing', Rating: 'Warm', External_Id__c: 'ERP-ACC-1001', Customer_Status__c: 'Active', BillingCity: 'Chicago', BillingCountry: 'USA', AnnualRevenue: 25000000 });
    const globex = this.insert('Account', { Name: 'Globex Retail', AccountNumber: 'ACC-1002', Type: 'Prospect', Industry: 'Retail', Rating: 'Cold', External_Id__c: 'ERP-ACC-1002', Customer_Status__c: 'Active', BillingCity: 'Austin', BillingCountry: 'USA' });
    this.insert('Account', { Name: 'Initech Systems', AccountNumber: 'ACC-1003', Type: 'Customer - Channel', Industry: 'Technology', Rating: 'Hot', External_Id__c: 'ERP-ACC-1003', Customer_Status__c: 'On Hold' });
    this.insert('Contact', { FirstName: 'Priya', LastName: 'Raman', Email: 'priya.raman@acme.example.com', Phone: '+1 312 555 0101', AccountId: acme, LeadSource: 'Web', External_Id__c: 'MW-CON-0001', Title: 'Procurement Lead' });
    this.insert('Contact', { FirstName: 'Daniel', LastName: 'Ortiz', Email: 'daniel.ortiz@globex.example.com', AccountId: globex, LeadSource: 'Partner Referral', External_Id__c: 'MW-CON-0002' });
    this.insert('Opportunity', { Name: 'Acme — Line 4 Automation', AccountId: acme, StageName: 'Proposal/Price Quote', CloseDate: '2026-12-15', Amount: 480000 });
    for (let i = 1; i <= 6; i++) {
      this.insert('Case', { Subject: `Portal login issue #${i}`, Status: i % 3 === 0 ? 'Closed' : 'New', Priority: i % 2 ? 'High' : 'Medium', Origin: 'Portal', AccountId: i % 2 ? acme : globex });
    }
    this.insert('Invoice__c', { Name: 'INV-2026-0001', Account__c: acme, Amount__c: 12500, Currency__c: 'USD', Status__c: 'Issued', ERP_Invoice_Id__c: 'SAP-90001', Sync_Status__c: 'Synced' });
    return s;
  }

  newId(obj) {
    const meta = OBJECTS[obj];
    const n = (this.store.counters[obj] = (this.store.counters[obj] || 0) + 1);
    return checksumId(`${meta.keyPrefix}5g000${b62(n + 1000, 7)}`);
  }

  insert(obj, fields) {
    const id = this.newId(obj);
    const ts = nowIso();
    const rec = { Id: id, OwnerId: '0055g00000QaUsrAAA', CreatedDate: ts, LastModifiedDate: ts, IsDeleted: false, ...fields };
    if (obj === 'Contact') rec.Name = [rec.FirstName, rec.LastName].filter(Boolean).join(' ');
    if (obj === 'Case') rec.CaseNumber = String(1000 + this.store.counters.Case).padStart(8, '0');
    if (obj === 'Case' && !rec.Status) rec.Status = 'New';
    if (obj === 'Lead' && !rec.Status) rec.Status = 'Open - Not Contacted';
    this.store.objects[obj].set(id, rec);
    return id;
  }

  findById(id) {
    if (!isIdLike(id)) return null;
    const id18 = id.length === 15 ? checksumId(id) : id;
    for (const [obj, map] of Object.entries(this.store.objects)) {
      for (const [rid, rec] of map) if (rid === id18 || rid.slice(0, 15) === id.slice(0, 15)) return { obj, rec };
    }
    return null;
  }

  // ── validation shared by create/update ────────────────────────────────────
  validateFields(obj, body, { isCreate, lowpriv }) {
    const meta = OBJECTS[obj];
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return sfError(400, 'JSON_PARSER_ERROR', 'Cannot deserialize instance of ' + obj + ' from ' + (Array.isArray(body) ? 'START_ARRAY' : 'VALUE_STRING') + ' value');
    }
    const hidden = lowpriv ? LOW_PRIV.hiddenFields[obj] || [] : [];
    for (const key of Object.keys(body)) {
      if (key === 'attributes' || key === '__selfId') continue;
      const fm = meta.fields.find((x) => x.name.toLowerCase() === key.toLowerCase());
      if (!fm || hidden.includes(fm.name)) return sfError(400, 'INVALID_FIELD', `No such column '${key}' on sobject of type ${obj}`);
      if ((isCreate && !fm.createable) || (!isCreate && !fm.updateable)) {
        return sfError(400, 'INVALID_FIELD_FOR_INSERT_UPDATE', `Unable to create/update fields: ${fm.name}. Please check the security settings of this field and verify that it is read/write for your profile or permission set.`, [fm.name]);
      }
      const v = body[key];
      if (v === null) {
        if (fm.required) return sfError(400, 'REQUIRED_FIELD_MISSING', `Required fields are missing: [${fm.name}]`, [fm.name]);
        continue;
      }
      if (['string', 'email', 'phone', 'url', 'textarea', 'picklist'].includes(fm.type) && typeof v !== 'string') {
        if (typeof v === 'object') return sfError(400, 'JSON_PARSER_ERROR', `Cannot deserialize instance of string from ${Array.isArray(v) ? 'START_ARRAY' : 'START_OBJECT'} value for field ${fm.name}`);
      }
      if (['currency', 'double', 'int', 'percent', 'number'].includes(fm.type) && typeof v !== 'number') {
        if (typeof v !== 'string' || Number.isNaN(Number(v))) return sfError(400, 'JSON_PARSER_ERROR', `Cannot deserialize instance of double from VALUE_STRING value ${String(v).slice(0, 40)} or request may be missing a required field`);
      }
      if (fm.type === 'boolean' && typeof v !== 'boolean') return sfError(400, 'JSON_PARSER_ERROR', `Cannot deserialize instance of boolean from VALUE_STRING value ${v}`);
      if (fm.type === 'date' && (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))) return sfError(400, 'JSON_PARSER_ERROR', `Cannot deserialize value like Date from string ${v}: Date must be in the format YYYY-MM-DD`);
      const sv = String(v);
      if (fm.length && ['string', 'email', 'phone', 'url', 'textarea'].includes(fm.type) && sv.length > fm.length) {
        return sfError(400, 'STRING_TOO_LONG', `${fm.label}: data value too large: ${sv.slice(0, 30)}... (max length=${fm.length})`, [fm.name]);
      }
      if (fm.type === 'email' && sv && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(sv)) return sfError(400, 'INVALID_EMAIL_ADDRESS', `${fm.label}: invalid email address: ${sv.slice(0, 80)}`, [fm.name]);
      if (fm.type === 'picklist' && fm.restrictedPicklist && sv && !fm.picklistValues.includes(sv)) {
        return sfError(400, 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', `${fm.label}: bad value for restricted picklist field: ${sv}`, [fm.name]);
      }
      if (fm.type === 'reference') {
        if (!isIdLike(sv)) return sfError(400, 'MALFORMED_ID', `${fm.label}: id value of incorrect type: ${sv}`, [fm.name]);
        const target = this.findById(sv);
        if (!target || target.obj !== fm.referenceTo[0]) {
          return sfError(400, 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY', `insufficient access rights on cross-reference id: ${sv}`, [fm.name]);
        }
      }
      if (fm.unique && sv) {
        for (const rec of this.store.objects[obj].values()) {
          if (rec[fm.name] === sv && rec.Id !== body.__selfId) {
            return sfError(400, 'DUPLICATE_VALUE', `duplicate value found: ${fm.name} duplicates value on record with id: ${rec.Id}`, [fm.name]);
          }
        }
      }
    }
    if (isCreate) {
      const missing = meta.fields.filter((x) => x.required && (body[x.name] === undefined || body[x.name] === null || body[x.name] === '')).map((x) => x.name);
      if (missing.length) return sfError(400, 'REQUIRED_FIELD_MISSING', `Required fields are missing: [${missing.join(', ')}]`, missing);
    }
    // Validation rules / duplicate rules (simulated org configuration)
    if (obj === 'Opportunity' && body.Amount !== undefined && body.Amount !== null && Number(body.Amount) <= 0) {
      return sfError(400, 'FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Amount must be greater than zero.', ['Amount']);
    }
    if (obj === 'Contact' && isCreate && body.Email) {
      for (const rec of this.store.objects.Contact.values()) {
        if (rec.Email && rec.Email.toLowerCase() === String(body.Email).toLowerCase()) {
          return { status: 400, body: [{ message: 'Use one of these records?', errorCode: 'DUPLICATES_DETECTED', fields: [], duplicateResult: { duplicateRule: 'Standard_Contact_Duplicate_Rule', matchResults: [{ entityType: 'Contact', matchRecords: [{ record: { Id: rec.Id } }] }] } }] };
        }
      }
    }
    if (obj === 'Invoice__c' && body.Amount__c !== undefined && Number(body.Amount__c) < 0) {
      return sfError(400, 'FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Invoice amount cannot be negative.', ['Amount__c']);
    }
    return null;
  }

  applyAutomation(obj, rec, patch) {
    // D1: a simulated record-triggered flow downgrades Hot ratings on update.
    if (obj === 'Account' && patch && patch.Rating === 'Hot' && !patch.__create) rec.Rating = 'Warm';
    if (obj === 'Contact') rec.Name = [rec.FirstName, rec.LastName].filter(Boolean).join(' ');
    if (obj === 'Invoice__c' && !rec.Sync_Status__c) rec.Sync_Status__c = 'Synced';
    rec.LastModifiedDate = nowIso();
  }

  // ── SOQL subset ───────────────────────────────────────────────────────────
  soql(q, lowpriv) {
    const m = String(q).trim().match(/^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+(\w+(?:\.\w+)?)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?\s*$/i);
    if (!m) return sfError(400, 'MALFORMED_QUERY', `unexpected token in query: ${String(q).slice(0, 60)}`);
    const [, fieldList, objRaw, where, orderBy, dir, limit] = m;
    const obj = Object.keys(OBJECTS).find((o) => o.toLowerCase() === objRaw.toLowerCase());
    if (!obj || OBJECTS[obj].isEvent || (lowpriv && LOW_PRIV.noAccessObjects.includes(obj))) {
      return sfError(400, 'INVALID_TYPE', `sObject type '${objRaw}' is not supported. If you are attempting to use a custom object, be sure to append the '__c' after the entity name.`);
    }
    const meta = OBJECTS[obj];
    const hidden = lowpriv ? LOW_PRIV.hiddenFields[obj] || [] : [];
    const isCount = /^COUNT\(\s*\)$/i.test(fieldList.trim());
    const fields = isCount ? [] : fieldList.split(',').map((x) => x.trim()).filter(Boolean);
    for (const fld of fields) {
      const base = fld.split('.')[0];
      const ok = fld.includes('.')
        ? meta.fields.some((x) => x.relationshipName && x.relationshipName.toLowerCase() === base.toLowerCase())
        : meta.fields.some((x) => x.name.toLowerCase() === fld.toLowerCase() && !hidden.includes(x.name));
      if (!ok) return sfError(400, 'INVALID_FIELD', `\n${fieldList.slice(0, 60)}\n^\nERROR at Row:1:Column:8\nNo such column '${fld}' on entity '${obj}'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name.`);
    }
    let rows = [...this.store.objects[obj].values()].filter((r) => !r.IsDeleted);
    if (where) {
      const conds = where.split(/\s+AND\s+/i);
      for (const c of conds) {
        const cm = c.trim().match(/^(\w+)\s*(=|!=|<|>|LIKE|IN)\s*(.+)$/i);
        if (!cm) return sfError(400, 'MALFORMED_QUERY', `unexpected token: ${c.slice(0, 40)}`);
        const [, fld, opRaw, valRaw] = cm;
        const fm = meta.fields.find((x) => x.name.toLowerCase() === fld.toLowerCase());
        if (!fm || hidden.includes(fm.name)) return sfError(400, 'INVALID_FIELD', `No such column '${fld}' on entity '${obj}'.`);
        const op = opRaw.toUpperCase();
        const parseVal = (s) => { s = s.trim(); if (/^null$/i.test(s)) return null; if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true'; if (s.startsWith("'")) return s.slice(1, -1).replace(/\\'/g, "'"); return Number(s); };
        if (op === 'IN') {
          const vals = valRaw.trim().replace(/^\(|\)$/g, '').split(',').map(parseVal);
          rows = rows.filter((r) => vals.includes(r[fm.name]) || (fm.type === 'id' || fm.type === 'reference' ? vals.some((v) => String(v).slice(0, 15) === String(r[fm.name] || '').slice(0, 15)) : false));
        } else {
          const v = parseVal(valRaw);
          rows = rows.filter((r) => {
            let rv = r[fm.name] === undefined ? null : r[fm.name];
            if ((fm.type === 'id' || fm.type === 'reference') && typeof v === 'string' && rv) return op === '!=' ? rv.slice(0, 15) !== v.slice(0, 15) : rv.slice(0, 15) === v.slice(0, 15);
            if (op === '=') return rv === v;
            if (op === '!=') return rv !== v;
            if (op === '<') return rv !== null && rv < v;
            if (op === '>') return rv !== null && rv > v;
            if (op === 'LIKE') { const rx = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i'); return rv !== null && rx.test(String(rv)); }
            return false;
          });
        }
      }
    }
    if (orderBy) rows.sort((a, b) => (a[orderBy] > b[orderBy] ? 1 : -1) * (dir && dir.toUpperCase() === 'DESC' ? -1 : 1));
    const totalSize = rows.length;
    if (limit) rows = rows.slice(0, Number(limit));
    if (isCount) return { status: 200, body: { totalSize, done: true, records: [] } };
    const v = this.project.apiVersion;
    const records = rows.map((r) => {
      const out = { attributes: { type: obj, url: `/services/data/v${v}/sobjects/${obj}/${r.Id}` } };
      for (const fld of fields) {
        if (fld.includes('.')) {
          const [rel, sub] = fld.split('.');
          const fm = meta.fields.find((x) => x.relationshipName && x.relationshipName.toLowerCase() === rel.toLowerCase());
          if (fm.name === 'OwnerId') { out.Owner = { attributes: { type: 'User' }, [sub]: sub === 'Name' ? 'QA Integration User' : 'qa.integration@example.com' }; continue; }
          const parent = r[fm.name] ? this.findById(r[fm.name]) : null;
          out[fm.relationshipName] = parent ? { attributes: { type: parent.obj }, [sub]: parent.rec[sub] ?? null } : null;
        } else {
          const fm = meta.fields.find((x) => x.name.toLowerCase() === fld.toLowerCase());
          out[fm.name] = r[fm.name] === undefined ? null : r[fm.name];
        }
      }
      return out;
    });
    return { status: 200, body: { totalSize, done: true, records } };
  }

  // ── request dispatcher ────────────────────────────────────────────────────
  async request(r) {
    const started = performance.now();
    const auth = r.auth || 'default';
    const lowpriv = auth === 'lowpriv';
    const url = new URL(/^https?:/.test(r.path) ? r.path : `https://demo-org.my.salesforce.com${r.path.startsWith('/') ? '' : '/'}${r.path}`);
    for (const [k, v] of Object.entries(r.query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    let body = r.body;
    let parseError = null;
    if (r.bodyRaw !== undefined && r.bodyRaw !== null && r.bodyRaw !== '' && r.apiType !== 'SOAP' && !String(r.headers && (r.headers['Content-Type'] || r.headers['content-type']) || '').includes('csv')) {
      try { body = JSON.parse(r.bodyRaw); } catch (e) { parseError = e.message; }
    }
    let result;
    let latency = 40 + Math.random() * 180;
    try {
      if (url.pathname.startsWith('/services/oauth2/')) result = this.oauth(url, r, body);
      else if (auth === 'none' || auth === 'invalid') result = sfError(401, 'INVALID_SESSION_ID', 'Session expired or invalid');
      else if (parseError) result = sfError(400, 'JSON_PARSER_ERROR', `Unexpected character: was expecting comma to separate Object entries at [line:1, column:${Math.max(1, (r.bodyRaw || '').length - 1)}]`);
      else {
        const out = await this.route(url, r.method.toUpperCase(), body, { lowpriv, raw: r.bodyRaw, headers: r.headers || {} });
        result = out;
        if (out.latency) latency = out.latency;
      }
    } catch (e) {
      result = { status: 500, body: [{ errorCode: 'UNKNOWN_EXCEPTION', message: `Simulator error: ${e.message}` }] };
    }
    await sleep(latency);
    const isText = typeof result.body === 'string';
    const text = result.body === undefined ? '' : isText ? result.body : JSON.stringify(result.body);
    const headers = {
      'content-type': result.contentType || (text ? 'application/json;charset=UTF-8' : 'text/plain'),
      'sforce-limit-info': `api-usage=${1200 + Math.floor(Math.random() * 50)}/15000`,
      'x-demo-request-id': 'demo-' + crypto.randomBytes(6).toString('hex'),
      date: new Date().toUTCString(),
      ...(result.headers || {}),
    };
    return {
      status: result.status, statusText: '', headers, body: result.body === undefined ? '' : result.body, text,
      timeMs: Math.round(performance.now() - started), sizeBytes: Buffer.byteLength(text), url: url.toString(),
      correlationId: headers['x-demo-request-id'],
      requestHeaders: { ...(r.headers || {}), ...(auth === 'default' || auth === 'lowpriv' ? { Authorization: 'Bearer {{accessToken}}' } : auth === 'invalid' ? { Authorization: 'Bearer INVALID' } : {}) },
      requestBody: r.bodyRaw || (body !== undefined ? JSON.stringify(body) : undefined),
    };
  }

  oauth(url, r, body) {
    if (url.pathname === '/services/oauth2/userinfo') {
      if (r.auth === 'none' || r.auth === 'invalid') return { status: 403, body: 'Bad_OAuth_Token', contentType: 'text/plain' };
      return { status: 200, body: { sub: 'https://login.salesforce.com/id/00D5g000000DEMO/0055g00000QaUsr', preferred_username: 'qa.integration@demo.example.com', organization_id: '00D5g000000DEMOEAA', user_type: 'STANDARD' } };
    }
    if (url.pathname === '/services/oauth2/token') {
      const params = new URLSearchParams(typeof r.bodyRaw === 'string' ? r.bodyRaw : '');
      const grant = params.get('grant_type') || (body && body.grant_type);
      const cid = params.get('client_id') || (body && body.client_id);
      if (!grant) return { status: 400, body: { error: 'unsupported_grant_type', error_description: 'grant type not supported' } };
      if (!cid || cid === 'invalid') return { status: 400, body: { error: 'invalid_client_id', error_description: 'client identifier invalid' } };
      const secret = params.get('client_secret') || (body && body.client_secret);
      if (grant === 'client_credentials' && (!secret || secret === 'invalid')) return { status: 400, body: { error: 'invalid_client', error_description: 'invalid client credentials' } };
      return { status: 200, body: { access_token: '00D5g000000DEMO!AQ0AQDemoTokenValueForSimulatorOnly0000000000', instance_url: 'https://demo-org.my.salesforce.com', token_type: 'Bearer', issued_at: String(Date.now()), scope: 'api' } };
    }
    if (url.pathname === '/services/oauth2/revoke') return { status: 200, body: '' };
    return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
  }

  async route(url, method, body, ctx) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p === '/services/data') return { status: 200, body: SUPPORTED_VERSIONS.map((v) => ({ label: `API v${v}`, url: `/services/data/v${v}`, version: v })) };
    if (p.startsWith('/services/apexrest/')) return this.apexRest(p.slice('/services/apexrest'.length), method, body, ctx);
    if (p.startsWith('/services/Soap/')) return this.soap(p, ctx);
    const vm = p.match(/^\/services\/data\/v(\d+\.\d)(\/.*)?$/);
    if (!vm) return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
    if (!SUPPORTED_VERSIONS.includes(vm[1])) return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
    const rest = vm[2] || '/';
    if (rest === '/') return { status: 200, body: { sobjects: `/services/data/v${vm[1]}/sobjects`, query: `/services/data/v${vm[1]}/query`, composite: `/services/data/v${vm[1]}/composite`, limits: `/services/data/v${vm[1]}/limits`, graphql: `/services/data/v${vm[1]}/graphql`, tooling: `/services/data/v${vm[1]}/tooling`, jobs: `/services/data/v${vm[1]}/jobs` } };
    if (rest === '/limits') return { status: 200, body: { DailyApiRequests: { Max: 15000, Remaining: 13780 }, DailyBulkV2QueryJobs: { Max: 10000, Remaining: 9998 }, DataStorageMB: { Max: 1024, Remaining: 911 }, ConcurrentAsyncGetReportInstances: { Max: 200, Remaining: 200 } } };
    if (rest === '/query' || rest === '/queryAll') {
      const q = url.searchParams.get('q') || '';
      const res = this.soql(q, ctx.lowpriv);
      // D3: Case queries exceed the 1500 ms SLA.
      if (/\bFROM\s+Case\b/i.test(q)) res.latency = 1580 + Math.random() * 320;
      return res;
    }
    if (rest === '/sobjects') {
      if (method !== 'GET') return sfError(405, 'METHOD_NOT_ALLOWED', `HTTP Method '${method}' not allowed. Allowed are GET,HEAD`);
      return { status: 200, body: { encoding: 'UTF-8', maxBatchSize: 200, sobjects: Object.entries(OBJECTS).filter(([n]) => !(ctx.lowpriv && LOW_PRIV.noAccessObjects.includes(n))).map(([n, o]) => ({ name: n, label: o.label, custom: o.custom, keyPrefix: o.keyPrefix, queryable: !o.isEvent, createable: true, updateable: !o.isEvent, deletable: !o.isEvent })) } };
    }
    if (rest === '/graphql') return this.graphql(body, ctx);
    if (rest.startsWith('/tooling/')) return this.tooling(rest, url);
    if (rest.startsWith('/composite')) return this.composite(rest, method, body, ctx, vm[1], url);
    if (rest.startsWith('/jobs/ingest')) return this.bulk(rest, method, body, ctx);
    if (rest.startsWith('/connect/') || rest.startsWith('/chatter/')) {
      if (/users\/me$/.test(rest)) return { status: 200, body: { id: '0055g00000QaUsrAAA', name: 'QA Integration User', username: 'qa.integration@demo.example.com', type: 'User' } };
      return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
    }
    const sm = rest.match(/^\/sobjects\/(\w+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (sm) return this.sobject(sm[1], sm[2], sm[3] ? decodeURIComponent(sm[3]) : undefined, method, body, url, ctx, vm[1]);
    return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
  }

  sobject(objRaw, idOrAction, extValue, method, body, url, ctx, v) {
    const obj = Object.keys(OBJECTS).find((o) => o.toLowerCase() === objRaw.toLowerCase());
    if (!obj || (ctx.lowpriv && LOW_PRIV.noAccessObjects.includes(obj))) return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
    const meta = OBJECTS[obj];
    const map = this.store.objects[obj];
    if (idOrAction === 'describe') {
      const d = describe(obj);
      if (ctx.lowpriv) d.fields = d.fields.filter((x) => !(LOW_PRIV.hiddenFields[obj] || []).includes(x.name));
      return { status: 200, body: d };
    }
    if (!idOrAction) {
      if (method === 'GET') return { status: 200, body: { objectDescribe: { name: obj, label: meta.label, keyPrefix: meta.keyPrefix }, recentItems: [...map.values()].slice(-3).map((x) => ({ attributes: { type: obj }, Id: x.Id, Name: x.Name || x.Subject || x.Id })) } };
      if (method !== 'POST') return sfError(405, 'METHOD_NOT_ALLOWED', `HTTP Method '${method}' not allowed. Allowed are GET,HEAD,POST`);
      if (body === undefined || body === null || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0 && meta.fields.some((x) => x.required))) {
        const missing = meta.fields.filter((x) => x.required).map((x) => x.name);
        return sfError(400, 'REQUIRED_FIELD_MISSING', `Required fields are missing: [${missing.join(', ')}]`, missing);
      }
      if (ctx.lowpriv && LOW_PRIV.readOnlyObjects.includes(obj)) return sfError(400, 'INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access rights on object id');
      const err = this.validateFields(obj, body, { isCreate: true, lowpriv: ctx.lowpriv });
      if (err) return err;
      if (meta.isEvent) return { status: 201, body: { id: this.newId(obj), success: true, errors: [] } };
      const clean = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'attributes').map(([k, val]) => [meta.fields.find((x) => x.name.toLowerCase() === k.toLowerCase()).name, val]));
      const id = this.insert(obj, clean);
      this.applyAutomation(obj, map.get(id), { ...clean, __create: true });
      return { status: 201, body: { id, success: true, errors: [] } };
    }
    if (extValue !== undefined) {
      // Upsert by external id: PATCH /sobjects/Obj/ExtField/value
      const fm = meta.fields.find((x) => x.name.toLowerCase() === idOrAction.toLowerCase());
      if (!fm || (!fm.externalId && fm.name !== 'Id')) return sfError(404, 'NOT_FOUND', `Provided external ID field does not exist or is not accessible: ${idOrAction}`);
      if (method === 'GET') {
        const found = [...map.values()].find((x) => x[fm.name] === extValue && !x.IsDeleted);
        return found ? { status: 200, body: { attributes: { type: obj, url: `/services/data/v${v}/sobjects/${obj}/${found.Id}` }, ...found } } : sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
      }
      if (method !== 'PATCH') return sfError(405, 'METHOD_NOT_ALLOWED', `HTTP Method '${method}' not allowed. Allowed are GET,HEAD,PATCH,DELETE`);
      const existing = [...map.values()].find((x) => x[fm.name] === extValue && !x.IsDeleted);
      const err = this.validateFields(obj, { ...body, __selfId: existing && existing.Id }, { isCreate: !existing, lowpriv: ctx.lowpriv });
      if (err) return err;
      if (existing) {
        Object.assign(existing, body);
        this.applyAutomation(obj, existing, body);
        return { status: 200, body: { id: existing.Id, success: true, errors: [], created: false } };
      }
      const id = this.insert(obj, { ...body, [fm.name]: extValue });
      this.applyAutomation(obj, map.get(id), { ...body, __create: true });
      return { status: 201, body: { id, success: true, errors: [], created: true } };
    }
    const id = idOrAction;
    if (!isIdLike(id)) return sfError(404, 'NOT_FOUND', `Provided external ID field does not exist or is not accessible: ${id}`);
    const id18 = id.length === 15 ? checksumId(id) : id;
    const rec = map.get(id18) || [...map.values()].find((x) => x.Id.slice(0, 15) === id.slice(0, 15));
    if (!rec) return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
    if (rec.IsDeleted) return method === 'DELETE' ? sfError(404, 'ENTITY_IS_DELETED', 'entity is deleted') : sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
    if (method === 'GET') {
      const hidden = ctx.lowpriv ? LOW_PRIV.hiddenFields[obj] || [] : [];
      const want = url.searchParams.get('fields');
      const out = { attributes: { type: obj, url: `/services/data/v${v}/sobjects/${obj}/${rec.Id}` } };
      const list = want ? want.split(',').map((x) => x.trim()) : meta.fields.map((x) => x.name);
      for (const fld of list) {
        const fm = meta.fields.find((x) => x.name.toLowerCase() === fld.toLowerCase());
        if (!fm || hidden.includes(fm.name)) {
          if (want) return sfError(400, 'INVALID_FIELD', `No such column '${fld}' on sobject of type ${obj}`);
          continue;
        }
        out[fm.name] = rec[fm.name] === undefined ? null : rec[fm.name];
      }
      return { status: 200, body: out };
    }
    if (method === 'PATCH') {
      if (ctx.lowpriv && LOW_PRIV.readOnlyObjects.includes(obj)) return sfError(400, 'INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access rights on object id');
      const err = this.validateFields(obj, { ...body, __selfId: rec.Id }, { isCreate: false, lowpriv: ctx.lowpriv });
      if (err) return err;
      const clean = Object.fromEntries(Object.entries(body || {}).filter(([k]) => k !== 'attributes').map(([k, val]) => [meta.fields.find((x) => x.name.toLowerCase() === k.toLowerCase()).name, val]));
      Object.assign(rec, clean);
      this.applyAutomation(obj, rec, clean);
      return { status: 204, body: undefined };
    }
    if (method === 'DELETE') {
      if (ctx.lowpriv && LOW_PRIV.readOnlyObjects.includes(obj)) return sfError(400, 'INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access rights on object id');
      rec.IsDeleted = true;
      return { status: 204, body: undefined };
    }
    return sfError(405, 'METHOD_NOT_ALLOWED', `HTTP Method '${method}' not allowed. Allowed are GET,HEAD,PATCH,DELETE`);
  }

  async composite(rest, method, body, ctx, v, url) {
    if (rest === '/composite/sobjects' && method === 'DELETE') {
      const ids = String((url && url.searchParams.get('ids')) || '').split(',').filter(Boolean);
      if (!ids.length) return sfError(400, 'INVALID_FIELD', 'ids: field is required');
      if (ids.length > 200) return sfError(400, 'EXCEEDED_ID_LIMIT', 'record limit reached. cannot submit more than 200 records into this call');
      return { status: 200, body: ids.map((id) => {
        const f = this.findById(id);
        if (!f || f.rec.IsDeleted) return { id, success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] }] };
        if (ctx.lowpriv && LOW_PRIV.readOnlyObjects.includes(f.obj)) return { id, success: false, errors: [{ statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'insufficient access rights on object id', fields: [] }] };
        this.store.objects[f.obj].delete(f.rec.Id);
        return { id, success: true, errors: [] };
      }) };
    }
    if (method !== 'POST') return sfError(405, 'METHOD_NOT_ALLOWED', `HTTP Method '${method}' not allowed. Allowed are POST`);
    if (rest === '/composite/sobjects') {
      const records = (body && body.records) || [];
      if (!Array.isArray(records) || !records.length) return sfError(400, 'INVALID_FIELD', 'records: field is required');
      if (records.length > 200) return sfError(400, 'EXCEEDED_ID_LIMIT', 'record limit reached. cannot submit more than 200 records into this call');
      const allOrNone = Boolean(body.allOrNone);
      const results = [];
      const created = [];
      for (const rec of records) {
        const type = rec.attributes && rec.attributes.type;
        const { attributes, ...fields } = rec;
        const res = this.sobject(type || 'Unknown', undefined, undefined, 'POST', fields, new URL('https://x'), ctx, v);
        if (res.status === 201) { results.push({ id: res.body.id, success: true, errors: [] }); created.push([type, res.body.id]); }
        else results.push({ success: false, errors: res.body.map((e) => ({ statusCode: e.errorCode, message: e.message, fields: e.fields || [] })) });
      }
      if (allOrNone && results.some((x) => !x.success)) {
        for (const [type, id] of created) { const map = this.store.objects[type]; map.delete(id); }
        return { status: 200, body: results.map((x) => (x.success ? { success: false, errors: [{ statusCode: 'ALL_OR_NONE_OPERATION_ROLLED_BACK', message: 'Record rolled back because not all records were valid and the request was using AllOrNone header', fields: [] }] } : x)) };
      }
      return { status: 200, body: results };
    }
    if (rest === '/composite') {
      const subs = (body && body.compositeRequest) || [];
      if (subs.length > 25) return sfError(400, 'INVALID_COMPOSITE_REQUEST', 'The number of subrequests exceeds the limit of 25');
      const refs = {};
      const out = [];
      let failed = false;
      for (const s of subs) {
        if (failed && body.allOrNone) { out.push({ body: [{ errorCode: 'PROCESSING_HALTED', message: 'The transaction was rolled back since another operation in the same transaction failed.' }], httpHeaders: {}, httpStatusCode: 400, referenceId: s.referenceId }); continue; }
        const resolve = (x) => JSON.parse(JSON.stringify(x).replace(/@\{(\w+)\.([\w.\[\]]+)\}/g, (_, r, path) => (refs[r] ? String(path.split('.').reduce((o, k) => (o ? o[k] : ''), refs[r])) : '')));
        const subUrl = new URL('https://demo-org.my.salesforce.com' + resolve(s.url));
        const res = await this.route(subUrl, String(s.method).toUpperCase(), s.body ? resolve(s.body) : undefined, ctx);
        refs[s.referenceId] = res.body;
        if (res.status >= 400) failed = true;
        out.push({ body: res.body === undefined ? null : res.body, httpHeaders: {}, httpStatusCode: res.status, referenceId: s.referenceId });
      }
      return { status: 200, body: { compositeResponse: out } };
    }
    if (rest === '/composite/graph') {
      const graphs = (body && body.graphs) || [];
      const results = [];
      for (const g of graphs) {
        const r = await this.composite('/composite', 'POST', { allOrNone: true, compositeRequest: g.compositeRequest }, ctx, v);
        const ok = r.body.compositeResponse.every((x) => x.httpStatusCode < 400);
        results.push({ graphId: g.graphId, isSuccessful: ok, graphResponse: { compositeResponse: r.body.compositeResponse } });
      }
      return { status: 200, body: { graphs: results } };
    }
    return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
  }

  graphql(body, ctx) {
    const q = (body && body.query) || '';
    const m = q.match(/query\s*\{\s*(\w+)\s*(?:\(\s*first\s*:\s*(\d+)\s*\))?\s*\{\s*edges\s*\{\s*node\s*\{([\s\S]*?)\}\s*\}\s*\}/);
    if (!m) return { status: 200, body: { data: null, errors: [{ message: 'Validation error: unsupported or invalid query for the demo simulator', locations: [], extensions: { ErrorType: 'ValidationError' } }] } };
    const obj = m[1];
    if (!OBJECTS[obj] || (ctx.lowpriv && LOW_PRIV.noAccessObjects.includes(obj))) return { status: 200, body: { data: null, errors: [{ message: `Validation error: Field '${obj}' in type 'RecordQuery' is undefined`, extensions: { ErrorType: 'ValidationError' } }] } };
    const fieldNames = m[3].match(/\b(\w+)\b(?=\s*(\{|$|\s))/g).filter((x) => x !== 'value');
    const rows = [...this.store.objects[obj].values()].filter((x) => !x.IsDeleted).slice(0, Number(m[2] || 10));
    return { status: 200, body: { data: { uiapi: { query: { [obj]: { edges: rows.map((r) => ({ node: Object.fromEntries(fieldNames.map((fn) => [fn, fn === 'Id' ? r.Id : { value: r[fn] ?? null }])) })) } } } }, errors: [] } };
  }

  tooling(rest, url) {
    if (rest.startsWith('/tooling/query')) {
      const q = url.searchParams.get('q') || '';
      if (/FROM\s+ApexClass/i.test(q)) return { status: 200, body: { size: 3, totalSize: 3, done: true, entityTypeName: 'ApexClass', records: [{ attributes: { type: 'ApexClass' }, Id: '01p5g00000Cls01AAA', Name: 'ContactSyncService', ApiVersion: 62.0, Status: 'Active' }, { attributes: { type: 'ApexClass' }, Id: '01p5g00000Cls02AAA', Name: 'InvoiceRestResource', ApiVersion: 62.0, Status: 'Active' }, { attributes: { type: 'ApexClass' }, Id: '01p5g00000Cls03AAA', Name: 'LeadIntakeResource', ApiVersion: 61.0, Status: 'Active' }] } };
      if (/FROM\s+ValidationRule/i.test(q)) return { status: 200, body: { size: 2, totalSize: 2, done: true, entityTypeName: 'ValidationRule', records: [{ attributes: { type: 'ValidationRule' }, Id: '03d5g00000VR001AAA', ValidationName: 'Amount_Positive', Active: true, EntityDefinitionId: 'Opportunity' }, { attributes: { type: 'ValidationRule' }, Id: '03d5g00000VR002AAA', ValidationName: 'Invoice_Amount_Not_Negative', Active: true, EntityDefinitionId: 'Invoice__c' }] } };
      if (/FROM\s+Flow/i.test(q)) return { status: 200, body: { size: 1, totalSize: 1, done: true, records: [{ attributes: { type: 'Flow' }, Id: '3015g00000Flw01AAA', MasterLabel: 'Account Rating Normalizer', Status: 'Active', ProcessType: 'AutoLaunchedFlow' }] } };
      return { status: 200, body: { size: 0, totalSize: 0, done: true, records: [] } };
    }
    return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
  }

  bulk(rest, method, body, ctx) {
    const jobs = this.store.bulkJobs;
    if (rest === '/jobs/ingest' && method === 'POST') {
      if (!body || !body.object || !body.operation) return sfError(400, 'INVALIDJOB', 'InvalidJob : object and operation are required');
      if (!OBJECTS[body.object]) return sfError(400, 'INVALIDJOB', `InvalidJob : Unable to find object: ${body.object}`);
      const id = checksumId('7505g' + b62(jobs.size + 1, 10));
      jobs.set(id, { id, object: body.object, operation: body.operation, state: 'Open', contentType: 'CSV', lineEnding: body.lineEnding || 'LF', rows: 0, createdDate: nowIso() });
      return { status: 200, body: { ...jobs.get(id), apiVersion: Number(this.project.apiVersion) } };
    }
    const m = rest.match(/^\/jobs\/ingest\/(\w+)(\/batches|\/successfulResults|\/failedResults)?$/);
    if (!m || !jobs.has(m[1])) return sfError(404, 'NOT_FOUND', 'The requested resource does not exist');
    const job = jobs.get(m[1]);
    if (m[2] === '/batches' && method === 'PUT') {
      const lines = String(ctx.raw || '').trim().split(/\r?\n/);
      job.rows = Math.max(0, lines.length - 1);
      return { status: 201, body: undefined };
    }
    if (m[2] === '/successfulResults') return { status: 200, body: 'sf__Id,sf__Created\n', contentType: 'text/csv' };
    if (m[2] === '/failedResults') return { status: 200, body: 'sf__Id,sf__Error\n', contentType: 'text/csv' };
    if (method === 'PATCH') { job.state = body && body.state === 'Aborted' ? 'Aborted' : 'UploadComplete'; return { status: 200, body: job }; }
    if (method === 'GET') {
      if (job.state === 'UploadComplete') job.state = 'JobComplete';
      return { status: 200, body: { ...job, numberRecordsProcessed: job.rows, numberRecordsFailed: 0 } };
    }
    if (method === 'DELETE') { jobs.delete(job.id); return { status: 204, body: undefined }; }
    return sfError(405, 'METHOD_NOT_ALLOWED', `HTTP Method '${method}' not allowed.`);
  }

  soap(p, ctx) {
    const raw = String(ctx.raw || '');
    if (!/<(\w+:)?sessionId>[^<]+</.test(raw)) {
      return { status: 500, contentType: 'text/xml', body: '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>sf:INVALID_SESSION_ID</faultcode><faultstring>INVALID_SESSION_ID: Invalid Session ID found in SessionHeader: Illegal Session</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>' };
    }
    if (/getServerTimestamp/.test(raw)) {
      return { status: 200, contentType: 'text/xml', body: `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="urn:partner.soap.sforce.com"><soapenv:Body><getServerTimestampResponse><result><timestamp>${new Date().toISOString()}</timestamp></result></getServerTimestampResponse></soapenv:Body></soapenv:Envelope>` };
    }
    return { status: 500, contentType: 'text/xml', body: '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>soapenv:Client</faultcode><faultstring>Demo simulator supports getServerTimestamp only</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>' };
  }

  // Apex REST — custom integration endpoints (middleware ⇄ Salesforce)
  apexRest(p, method, body, ctx) {
    if (p === '/v1/contacts/sync' && method === 'POST') {
      const idem = ctx.headers['Idempotency-Key'] || ctx.headers['idempotency-key'];
      if (idem && this.store.idempotency.has(idem)) return { status: 200, body: { ...this.store.idempotency.get(idem), action: 'duplicate-ignored' } };
      if (!body || typeof body !== 'object') return { status: 400, body: { status: 'ERROR', errorCode: 'INVALID_PAYLOAD', message: 'Request body must be a JSON object' } };
      if (!body.lastName) return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: 'lastName is required', field: 'lastName' } };
      if (!body.externalId) return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: 'externalId is required', field: 'externalId' } };
      if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: 'email is not a valid email address', field: 'email' } };
      const map = this.store.objects.Contact;
      const existing = [...map.values()].find((x) => x.External_Id__c === body.externalId && !x.IsDeleted);
      let accountId = null;
      if (body.accountNumber) {
        const acc = [...this.store.objects.Account.values()].find((x) => x.AccountNumber === body.accountNumber);
        if (!acc) return { status: 422, body: { status: 'ERROR', errorCode: 'ACCOUNT_NOT_FOUND', message: `No Account with AccountNumber ${body.accountNumber}` } };
        accountId = acc.Id;
      }
      const fields = { FirstName: body.firstName || null, LastName: body.lastName, Email: body.email || null, Phone: body.phone || null, ...(accountId ? { AccountId: accountId } : {}) };
      let result;
      if (existing) { Object.assign(existing, fields); this.applyAutomation('Contact', existing, fields); result = { status: 'SUCCESS', salesforceId: existing.Id, action: 'updated' }; }
      else { const id = this.insert('Contact', { ...fields, External_Id__c: body.externalId }); result = { status: 'SUCCESS', salesforceId: id, action: 'created' }; }
      if (idem) this.store.idempotency.set(idem, result);
      return { status: 200, body: result };
    }
    if (p === '/v1/invoices' && method === 'POST') {
      if (!body || !body.invoiceNumber) return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: 'invoiceNumber is required' } };
      if (body.amount === undefined || typeof body.amount !== 'number') return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: 'amount must be a number' } };
      if (body.amount < 0) return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: 'amount cannot be negative' } };
      if (body.currency && !['USD', 'EUR', 'GBP', 'INR'].includes(body.currency)) return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: `Unsupported currency ${body.currency}` } };
      const acc = [...this.store.objects.Account.values()].find((x) => x.External_Id__c === body.accountExternalId);
      if (!acc) return { status: 422, body: { status: 'ERROR', errorCode: 'ACCOUNT_NOT_FOUND', message: `No Account with External_Id__c ${body.accountExternalId}` } };
      const map = this.store.objects.Invoice__c;
      const dup = [...map.values()].find((x) => x.ERP_Invoice_Id__c === body.erpInvoiceId || x.Name === body.invoiceNumber);
      if (dup) {
        // D2: duplicate invoices surface as an unhandled Apex exception instead of a 409.
        return { status: 500, body: [{ errorCode: 'APEX_ERROR', message: `System.DmlException: Insert failed. First exception on row 0; first error: DUPLICATE_VALUE, duplicate value found: ERP_Invoice_Id__c duplicates value on record with id: ${dup.Id}: []\n\nClass.InvoiceRestResource.createInvoice: line 48, column 1` }] };
      }
      const id = this.insert('Invoice__c', { Name: body.invoiceNumber, Account__c: acc.Id, Amount__c: body.amount, Currency__c: body.currency || 'USD', Status__c: body.status || 'Issued', ERP_Invoice_Id__c: body.erpInvoiceId || null, Due_Date__c: body.dueDate || null, Sync_Status__c: 'Synced' });
      return { status: 201, body: { status: 'SUCCESS', salesforceId: id, invoiceNumber: body.invoiceNumber, syncStatus: 'Synced' } };
    }
    if (p === '/v1/leads' && method === 'POST') {
      if (!body || !body.lastName || !body.company) return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: 'lastName and company are required' } };
      // D4: leadSource is not mapped to Lead.LeadSource.
      const id = this.insert('Lead', { FirstName: body.firstName || null, LastName: body.lastName, Company: body.company, Email: body.email || null, Phone: body.phone || null, Rating: body.rating || null });
      return { status: 201, body: { status: 'SUCCESS', salesforceId: id } };
    }
    if (p === '/v1/erp/health' && method === 'GET') return { status: 200, body: { status: 'UP', erp: 'SAP S/4HANA (simulated)', middleware: 'MuleSoft (simulated)', latencyMs: 120 }, latency: 300 + Math.random() * 200 };
    if (p === '/v1/payments/webhook' && method === 'POST') {
      const idem = ctx.headers['Stripe-Event-Id'] || ctx.headers['stripe-event-id'];
      if (idem && this.store.idempotency.has(idem)) return { status: 200, body: { ...this.store.idempotency.get(idem), action: 'duplicate-ignored' } };
      if (!body || typeof body !== 'object') return { status: 400, body: { status: 'ERROR', errorCode: 'INVALID_PAYLOAD', message: 'Request body must be a JSON object' } };
      if (!body.paymentIntentId) return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: 'paymentIntentId is required', field: 'paymentIntentId' } };
      if (body.amount === undefined || typeof body.amount !== 'number') return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: 'amount must be a number', field: 'amount' } };
      if (body.currency && !['USD', 'EUR', 'GBP', 'INR'].includes(body.currency)) return { status: 400, body: { status: 'ERROR', errorCode: 'VALIDATION_ERROR', message: `Unsupported currency ${body.currency}` } };
      const map = this.store.objects.Payment__c;
      const dup = [...map.values()].find((x) => x.Stripe_Payment_Intent_Id__c === body.paymentIntentId);
      if (dup) { const result = { status: 'SUCCESS', salesforceId: dup.Id, action: 'duplicate-ignored' }; if (idem) this.store.idempotency.set(idem, result); return { status: 200, body: result }; }
      let opportunityId = null;
      if (body.opportunityExternalId) {
        const opp = [...this.store.objects.Opportunity.values()].find((x) => x.Name === body.opportunityExternalId);
        if (opp) opportunityId = opp.Id;
      }
      const id = this.insert('Payment__c', {
        Name: `Payment ${body.paymentIntentId}`, Amount__c: body.amount, Currency__c: body.currency || 'USD',
        Payment_Method__c: body.paymentMethod || 'Card', Status__c: 'Succeeded', Stripe_Payment_Intent_Id__c: body.paymentIntentId,
        Processed_Date__c: nowIso(), ...(opportunityId ? { Opportunity__c: opportunityId } : {}),
      });
      const result = { status: 'SUCCESS', salesforceId: id, action: 'created' };
      if (idem) this.store.idempotency.set(idem, result);
      return { status: 200, body: result };
    }
    return { status: 404, body: [{ errorCode: 'NOT_FOUND', message: `Could not find a match for URL ${p}` }] };
  }

  // ── connector interface ──────────────────────────────────────────────────
  async describeGlobal() {
    return Object.entries(OBJECTS).map(([n, o]) => ({ name: n, label: o.label, custom: o.custom, keyPrefix: o.keyPrefix, queryable: !o.isEvent, createable: true, updateable: !o.isEvent, deletable: !o.isEvent }));
  }

  async describe(name) {
    const d = describe(Object.keys(OBJECTS).find((o) => o.toLowerCase() === String(name).toLowerCase()));
    if (!d) {
      const { ConnectorError } = require('./salesforce');
      throw new ConnectorError({ code: 'NOT_FOUND', title: `Object ${name} not found in demo org`, cause: 'The demo org only simulates a limited set of objects.', action: `Use one of: ${Object.keys(OBJECTS).join(', ')}.`, category: 'data', evidence: [] });
    }
    return d;
  }

  async query(soql) {
    const res = this.soql(soql, false);
    if (res.status !== 200) {
      const { ConnectorError } = require('./salesforce');
      const { explainResponse } = require('../lib/errors');
      throw new ConnectorError(explainResponse({ status: res.status, body: res.body, method: 'GET', url: 'query' }));
    }
    await sleep(30 + Math.random() * 60);
    return res.body;
  }

  async limits() { return (await this.route(new URL(`https://x/services/data/v${this.project.apiVersion}/limits`), 'GET', null, {})).body; }

  async testConnection() {
    await sleep(80);
    return { ok: true, ms: 80, latestApiVersion: SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1], configuredApiVersion: this.project.apiVersion, supported: SUPPORTED_VERSIONS.includes(this.project.apiVersion), demo: true };
  }

  /** Remove records created during a run (demo cleanup). */
  reset() { stores.delete(this.project.id); }
}

module.exports = { DemoSalesforce, checksumId, SUPPORTED_VERSIONS };
