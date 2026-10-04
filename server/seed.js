'use strict';
/**
 * Demo dataset: projects, Jira stories, generated + approved suites, real
 * executions against the demo org simulator, 2 weeks of execution history,
 * defects, test data, an OpenAPI contract and saved requests.
 * Run directly with `npm run seed` (resets the database).
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { repo, all, run: sqlRun, now, nextId, DB_FILE, db } = require('./db');
const { salesforceFor, jiraFor } = require('./connectors');
const { generateSuite } = require('./engine/generator');
const runner = require('./engine/runner');
const { buildDraft } = require('./engine/defects');
const { checkOperation } = require('./engine/safety');
const contracts = require('./engine/contracts');

const DAY = 864e5;
const iso = (t) => new Date(t).toISOString();

const LOWPRIV = { noAccessObjects: ['Invoice__c'], readOnlyObjects: ['Account', 'Opportunity'], hiddenFields: { Contact: ['Birthdate'], Account: ['AnnualRevenue'] } };

const ENDPOINTS = {
  contactSync: {
    name: 'Contact sync API', path: '/services/apexrest/v1/contacts/sync', method: 'POST', object: 'Contact', direction: 'MuleSoft → Salesforce',
    keywords: ['contact sync', 'mulesoft', 'middleware'],
    description: 'Middleware upserts customer contacts from the master data hub by external id.',
    samplePayload: { externalId: 'MW-QA-{{runId}}', firstName: 'Mia', lastName: 'Chen {{runId}}', email: '{{$randomEmail}}', accountNumber: 'ACC-1001' },
    requestMapping: { firstName: 'FirstName', lastName: 'LastName', email: 'Email' },
    idempotencyHeader: 'Idempotency-Key', duplicateExpect: [200], invalidPayload: { firstName: 'Missing last name', externalId: 'MW-QA-BAD' }, successStatus: [200], idPath: '$.salesforceId',
  },
  invoices: {
    name: 'ERP invoice sync', path: '/services/apexrest/v1/invoices', method: 'POST', object: 'Invoice__c', direction: 'SAP → MuleSoft → Salesforce',
    keywords: ['invoice', 'sap', 'erp'],
    description: 'SAP S/4HANA publishes issued invoices; MuleSoft transforms and posts them to Salesforce.',
    samplePayload: { invoiceNumber: 'INV-QA-{{runId}}', erpInvoiceId: 'SAP-QA-{{runId}}', accountExternalId: 'ERP-ACC-1001', amount: 2500.5, currency: 'EUR', status: 'Issued', dueDate: '2026-12-31' },
    secondPayload: { invoiceNumber: 'INV-QB-{{runId}}', erpInvoiceId: 'SAP-QB-{{runId}}', accountExternalId: 'ERP-ACC-1001', amount: 99, currency: 'USD', status: 'Issued' },
    requestMapping: { invoiceNumber: 'Name', amount: 'Amount__c', currency: 'Currency__c', status: 'Status__c' },
    transformChecks: [{ field: 'Sync_Status__c', expected: 'Synced' }],
    responseSchema: { type: 'object', required: ['status', 'salesforceId', 'invoiceNumber', 'syncStatus'], properties: { status: { type: 'string', enum: ['SUCCESS'] }, salesforceId: { type: 'string', pattern: '^[a-zA-Z0-9]{18}$' }, invoiceNumber: { type: 'string' }, syncStatus: { type: 'string', enum: ['Pending', 'Synced', 'Failed'] } } },
    duplicateExpect: [200, 409], invalidPayload: { invoiceNumber: 'INV-QA-BAD', accountExternalId: 'ERP-ACC-1001', amount: 'abc' }, healthPath: '/services/apexrest/v1/erp/health', timeoutMs: 2000, successStatus: [201],
  },
  leads: {
    name: 'Web lead intake API', path: '/services/apexrest/v1/leads', method: 'POST', object: 'Lead', direction: 'Website → Salesforce',
    keywords: ['lead intake', 'web lead', 'website'],
    description: 'Marketing website posts captured leads to Salesforce.',
    samplePayload: { firstName: 'Arun', lastName: 'Mehta {{runId}}', company: 'Northwind QA', email: '{{$randomEmail}}', leadSource: 'Web', rating: 'Hot' },
    requestMapping: { lastName: 'LastName', company: 'Company', leadSource: 'LeadSource', rating: 'Rating' },
    invalidPayload: { firstName: 'No company' }, successStatus: [201],
  },
};

const STORIES = [
  { key: 'DEMO-101', projectKey: 'DEMO', summary: 'Create Contact through Salesforce API', priority: 'High', sprint: 'Sprint 24', status: 'In QA', components: ['Customer Data'], assignee: 'Priya S.',
    description: 'As an integration consumer, I want to create Contact records through the Salesforce REST API so that customer contacts captured in partner systems are available to sales.\n\nThe request includes FirstName, LastName, Email, Phone, Title and an optional AccountId. LeadSource should be stored as sent.',
    acceptanceCriteria: '- Given a valid payload with LastName, the API returns 201 with the new Contact Id\n- Email must be a valid address; invalid emails are rejected with a clear error\n- LastName is required; requests without it are rejected\n- The created Contact is retrievable and all submitted fields are persisted\n- Only integration users with Contact create permission may create Contacts' },
  { key: 'DEMO-102', projectKey: 'DEMO', summary: 'Update Account rating via API', priority: 'Medium', sprint: 'Sprint 24', status: 'In QA', components: ['Accounts'], assignee: 'Daniel O.',
    description: 'The scoring engine updates the Account Rating (Hot, Warm, Cold) and Type through the REST API after each scoring cycle. The value sent must be persisted exactly.',
    acceptanceCriteria: '- PATCH with Rating = Hot returns 204\n- The persisted Account Rating equals the submitted value\n- Invalid field names return INVALID_FIELD\n- Read-only users cannot change Accounts' },
  { key: 'DEMO-103', projectKey: 'DEMO', summary: 'Sync invoices from SAP via MuleSoft into Salesforce', priority: 'Highest', sprint: 'Sprint 24', status: 'In QA', components: ['Billing', 'Integration'], assignee: 'Meera K.',
    description: 'SAP S/4HANA publishes issued invoices. MuleSoft transforms each invoice and calls the Salesforce invoice endpoint to create an Invoice record linked to the Account (by ERP account id). Retries from MuleSoft must not create duplicate invoices.',
    acceptanceCriteria: '- Valid invoice creates Invoice__c with Amount, Currency and Status mapped\n- Duplicate invoice numbers are handled without errors (idempotent or 409)\n- Invalid amounts return 400 with a structured error\n- Sync status is set to Synced\n- ERP health endpoint responds within 2 seconds' },
  { key: 'DEMO-104', projectKey: 'DEMO', summary: 'Support portal: query open Cases', priority: 'High', sprint: 'Sprint 25', status: 'Ready for QA', components: ['Service'], assignee: 'Priya S.',
    description: 'The customer support portal lists open Cases for an account by querying Case via SOQL through the REST API. Portal page load budget requires the API to respond within 1.5 seconds.',
    acceptanceCriteria: '- Query returns open portal cases with CaseNumber, Subject, Status and Priority\n- Response time below 1500 ms\n- Unauthenticated requests are rejected' },
  { key: 'DEMO-105', projectKey: 'DEMO', summary: 'Web lead intake API stores lead source and rating', priority: 'High', sprint: 'Sprint 25', status: 'In QA', components: ['Marketing'], assignee: 'Daniel O.',
    description: 'The marketing website posts captured web leads (web lead intake) to the custom lead endpoint. Lead Source and Rating must be mapped onto the Lead for routing.',
    acceptanceCriteria: '- Valid lead returns 201 and the Salesforce Id\n- LeadSource and Rating are persisted as sent\n- Missing company returns 400' },
  { key: 'DEMO-106', projectKey: 'DEMO', summary: 'Opportunity stage progression rules', priority: 'Medium', sprint: 'Sprint 25', status: 'To Do', components: ['Sales'], assignee: null,
    description: 'Sales operations wants stage changes on Opportunity validated so Amount is positive before Proposal.', acceptanceCriteria: '- Amount must be greater than zero\n- StageName must be a valid stage' },
  { key: 'SVC-201', projectKey: 'SVC', summary: 'Create Case from customer portal', priority: 'High', sprint: 'Sprint 12', status: 'In QA', components: ['Portal'], assignee: 'Lina M.',
    description: 'Portal users submit support Cases through the REST API with Subject, Description, Priority and Origin = Portal.', acceptanceCriteria: '- Create returns 201\n- Priority must be a valid value\n- Case is linked to the portal Account' },
  { key: 'SVC-202', projectKey: 'SVC', summary: 'Contact sync from MuleSoft middleware', priority: 'Highest', sprint: 'Sprint 12', status: 'In QA', components: ['Integration'], assignee: 'Lina M.',
    description: 'MuleSoft calls the contact sync endpoint to upsert Contacts by external id. Retries carry the same Idempotency-Key.', acceptanceCriteria: '- Upsert by externalId\n- Retries with the same Idempotency-Key return the same record\n- Missing lastName returns 400' },
  { key: 'PRD-301', projectKey: 'PRD', summary: 'Production smoke: Account read APIs', priority: 'Highest', sprint: 'Release 26.10', status: 'Done', components: ['Release'], assignee: 'Release team',
    description: 'Post-deployment smoke checks query Account records and org limits in Production. No data may be modified.', acceptanceCriteria: '- Account query returns 200\n- API limits endpoint reachable' },
];

const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: Acme Integration APIs (Apex REST)
  version: 1.4.0
paths:
  /services/apexrest/v1/invoices:
    post:
      operationId: createInvoice
      summary: Create an invoice from ERP
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/InvoiceRequest'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/InvoiceResponse'
        '400':
          description: Validation error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '401':
          description: Unauthenticated
        '409':
          description: Duplicate invoice
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '422':
          description: Account not found
  /services/apexrest/v1/contacts/sync:
    post:
      operationId: syncContact
      responses:
        '200':
          description: Upserted
          content:
            application/json:
              schema:
                type: object
                required: [status, salesforceId, action]
                properties:
                  status: { type: string, enum: [SUCCESS] }
                  salesforceId: { type: string, pattern: '^[a-zA-Z0-9]{18}$' }
                  action: { type: string, enum: [created, updated, duplicate-ignored] }
        '400':
          description: Validation error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '401':
          description: Unauthenticated
        '422':
          description: Account not found
  /services/apexrest/v1/leads:
    post:
      operationId: createLead
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                type: object
                required: [status, salesforceId]
                properties:
                  status: { type: string }
                  salesforceId: { type: string }
        '400':
          description: Validation error
        '401':
          description: Unauthenticated
  /services/apexrest/v1/erp/health:
    get:
      operationId: erpHealth
      responses:
        '200':
          description: Healthy
components:
  schemas:
    InvoiceRequest:
      type: object
      required: [invoiceNumber, accountExternalId, amount]
      properties:
        invoiceNumber: { type: string, maxLength: 80 }
        erpInvoiceId: { type: string, maxLength: 40 }
        accountExternalId: { type: string }
        amount: { type: number, minimum: 0 }
        currency: { type: string, enum: [USD, EUR, GBP, INR] }
        status: { type: string, enum: [Draft, Issued, Paid, Cancelled] }
        dueDate: { type: string, format: date }
    InvoiceResponse:
      type: object
      required: [status, salesforceId, invoiceNumber, syncStatus]
      properties:
        status: { type: string, enum: [SUCCESS] }
        salesforceId: { type: string, pattern: '^[a-zA-Z0-9]{18}$' }
        invoiceNumber: { type: string }
        syncStatus: { type: string, enum: [Pending, Synced, Failed] }
    Error:
      type: object
      required: [status, errorCode, message]
      properties:
        status: { type: string, enum: [ERROR] }
        errorCode: { type: string }
        message: { type: string }
`;

function resetDb() {
  db.exec(`DELETE FROM audit_log; DELETE FROM run_results; DELETE FROM runs; DELETE FROM defects; DELETE FROM test_cases; DELETE FROM scenarios;
    DELETE FROM proposals; DELETE FROM stories; DELETE FROM test_data; DELETE FROM saved_requests; DELETE FROM contracts; DELETE FROM demo_jira; DELETE FROM projects; DELETE FROM counters;`);
}

function insertProjects() {
  const base = { createdAt: iso(Date.now() - 40 * DAY), updatedAt: now(), status: 'active', apiVersion: '62.0' };
  const projects = [
    { ...base, id: 'PRJ-001', name: 'Acme Sales Cloud', description: 'Core Sales Cloud APIs and SAP/MuleSoft integrations.', sfOrg: 'acme--qa', environment: 'QA', instanceUrl: 'https://acme--qa.sandbox.my.salesforce.com', mode: 'demo', credentialRef: 'ACME_QA', jiraProjectKey: 'DEMO', jiraUrl: 'https://demo-jira.local', automationRepo: 'github.com/acme/sf-api-tests', postmanCollection: 'api-tests/collections/PRJ-001.postman_collection.json',
      testDataConfig: { autoCleanup: true, variables: { defaultAccountNumber: 'ACC-1001' } },
      integrationConfig: { middleware: 'MuleSoft (simulated)', externalSystems: ['SAP S/4HANA', 'Marketing website'], endpoints: [ENDPOINTS.invoices, ENDPOINTS.leads] },
      notificationConfig: { onRunComplete: 'email', recipients: ['qa-team@acme.example.com'], slackChannel: '#sf-qa-alerts', onlyOnFailure: true },
      businessConfig: { slaMs: 1500, criticalObjects: ['Contact', 'Account', 'Invoice__c'], highTrafficObjects: ['Contact', 'Case'], lowPrivilegeExpectations: LOWPRIV,
        queryTemplates: { Case: { label: 'open portal cases', soql: "SELECT Id, CaseNumber, Subject, Status, Priority FROM Case WHERE Status = 'New' ORDER BY CreatedDate DESC LIMIT 50" } } } },
    { ...base, id: 'PRJ-002', name: 'Acme Service Cloud', description: 'Customer portal case APIs and contact master-data sync.', sfOrg: 'acme--uat', environment: 'UAT', instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com', mode: 'demo', credentialRef: 'ACME_UAT', jiraProjectKey: 'SVC', jiraUrl: 'https://demo-jira.local', automationRepo: 'github.com/acme/sf-api-tests',
      testDataConfig: { autoCleanup: true, variables: {} },
      integrationConfig: { middleware: 'MuleSoft (simulated)', externalSystems: ['MDM hub'], endpoints: [ENDPOINTS.contactSync] },
      notificationConfig: { onRunComplete: 'none' },
      businessConfig: { slaMs: 2000, criticalObjects: ['Case'], highTrafficObjects: ['Case'], lowPrivilegeExpectations: LOWPRIV } },
    { ...base, id: 'PRJ-003', name: 'Acme Production Smoke', description: 'Read-only post-release smoke checks.', sfOrg: 'acme', environment: 'Production', instanceUrl: 'https://acme.my.salesforce.com', mode: 'demo', credentialRef: 'ACME_PROD', jiraProjectKey: 'PRD', jiraUrl: 'https://demo-jira.local',
      testDataConfig: { autoCleanup: false, variables: {} }, integrationConfig: { endpoints: [] }, notificationConfig: { onRunComplete: 'email', recipients: ['release@acme.example.com'] },
      businessConfig: { slaMs: 2000, criticalObjects: ['Account'] } },
    { ...base, id: 'PRJ-004', name: 'Globex Commerce', description: 'B2B Commerce order APIs — awaiting connected-app credentials.', sfOrg: 'globex--sit', environment: 'SIT', instanceUrl: 'https://globex--sit.sandbox.my.salesforce.com', mode: 'live', credentialRef: 'GLOBEX_SIT', jiraProjectKey: 'GLX', jiraUrl: 'https://globex.atlassian.net', jiraCredentialRef: 'GLOBEX',
      testDataConfig: { autoCleanup: true, variables: {} }, integrationConfig: { endpoints: [] }, notificationConfig: {}, businessConfig: { slaMs: 2000 } },
  ];
  for (const p of projects) repo.insert('projects', p);
  sqlRun("INSERT OR REPLACE INTO counters (name, value) VALUES ('PRJ', 4)");
  return projects;
}

function insertJira() {
  for (const s of STORIES) {
    repo.insert('demo_jira', { key: s.key, projectKey: s.projectKey, issueType: 'Story', summary: s.summary, description: s.description, acceptanceCriteria: s.acceptanceCriteria, status: s.status, priority: s.priority, labels: ['api'], components: s.components, assignee: s.assignee, sprint: s.sprint, comments: [], links: [], createdAt: iso(Date.now() - 20 * DAY), updatedAt: now() });
  }
}

async function syncStories(project) {
  const { upsertStory } = require('./routes/stories');
  const issues = await jiraFor(project).searchStories({});
  for (const i of issues) upsertStory(project.id, i, 'demo-jira');
}

async function generateAndApprove(project, storyKey, seqBase) {
  const story = repo.one('stories', 'projectId = $p AND key = $k', { p: project.id, k: storyKey });
  const { analysis, scenarios } = await generateSuite({ project, story, sf: salesforceFor(project) });
  const pid = nextId('GEN', 4);
  repo.insert('proposals', { id: pid, projectId: project.id, storyKey, status: 'approved', analysis, scenarios, createdBy: 'qa.engineer', createdAt: iso(Date.now() - 15 * DAY), decidedAt: iso(Date.now() - 15 * DAY), decision: { by: 'qa.lead', selected: 'all', postToJira: true } });
  let n = 0;
  scenarios.forEach((s, si) => {
    const scId = nextId('TS', 4);
    repo.insert('scenarios', { id: scId, projectId: project.id, storyKey, title: s.title, description: s.description, apiType: s.apiType, object: s.object, type: s.type, priority: s.priority, label: s.label, status: 'active', createdAt: iso(Date.now() - 15 * DAY), updatedAt: now() });
    s.testCases.forEach((t, ti) => {
      repo.insert('test_cases', {
        id: nextId('TC', 5), projectId: project.id, scenarioId: scId, storyKey, seq: seqBase + si * 1000 + (t.seqHint || ti), title: t.title, description: t.description || null,
        apiType: t.apiType || 'REST', method: t.method, endpoint: t.endpoint, auth: t.auth || 'default', headers: t.headers || {}, query: t.query || {}, body: t.body === undefined ? null : t.body, bodyRaw: t.bodyRaw || null,
        assertions: t.assertions, extract: t.extract || [], sfValidation: t.sfValidation || null, cleanup: t.cleanup || null, timeoutMs: t.timeoutMs || null, object: t.object || s.object || null,
        testType: t.testType, priority: t.priority, priorityReason: t.priorityReason, status: t.status || 'ready', label: t.label, tags: t.tags || [], automated: 1, createdAt: iso(Date.now() - 15 * DAY), updatedAt: now(),
      });
      n++;
    });
  });
  return n;
}

async function execute(project, filterFn, opts = {}) {
  let tests = repo.find('test_cases', "projectId = $p AND status != 'draft'", { p: project.id }, 'ORDER BY seq');
  if (filterFn) tests = tests.filter(filterFn);
  const r = runner.startRun({ project, testCases: tests, user: opts.user || 'ci-pipeline', options: { label: opts.label || 'Nightly regression', trigger: opts.trigger || 'scheduled' } });
  return runner.waitForRun(r.id);
}

/** Clone a real run into backdated history with realistic variation. */
function cloneHistory(runRow, days, variation) {
  const results = repo.find('run_results', 'runId = $r', { r: runRow.id }, 'ORDER BY seq');
  for (const k of days) {
    const start = new Date(runRow.startedAt).getTime() - k * DAY - (k % 3) * 3600e3;
    const id = `EX-${iso(start).slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0, apiErrors: 0, sfErrors: 0 };
    const times = [];
    const rows = results.map((r) => {
      const v = variation(r, k) || {};
      const ms = r.responseMs ? Math.max(20, Math.round(r.responseMs * (v.msFactor || (0.85 + ((r.seq * 7 + k * 13) % 30) / 100)))) : null;
      const status = v.status || r.status;
      if (ms) times.push(ms);
      counts[status] = (counts[status] || 0) + 1;
      if (v.apiError) counts.apiErrors++;
      const flippedToPass = status === 'passed' && r.status !== 'passed';
      return {
        ...r, id: `${id}-${String(r.seq).padStart(4, '0')}`, runId: id, status, responseMs: ms, defectKey: null,
        startedAt: iso(start + r.seq * 400), endedAt: iso(start + r.seq * 400 + (ms || 50)),
        statusCode: v.statusCode || (flippedToPass ? (r.assertions || []).filter((a) => a.type === 'status').map((a) => [].concat(a.expected)[0])[0] || 200 : r.statusCode),
        assertions: flippedToPass ? (r.assertions || []).map((a) => ({ ...a, result: 'PASS', actual: a.type === 'responseTime' ? ms : a.expected, message: '' })) : v.assertions || r.assertions,
        sfValidation: flippedToPass && r.sfValidation ? { ...r.sfValidation, status: 'PASS', comparisons: (r.sfValidation.comparisons || []).map((c) => ({ ...c, actual: c.expected, match: true })), message: 'All fields persisted as sent.' } : r.sfValidation,
        response: flippedToPass ? { status: 200, headers: {}, body: { note: 'Historical demo result — full payload retained for the latest execution only.' }, timeMs: ms } : v.response || r.response,
        analysis: flippedToPass ? null : v.analysis || r.analysis, error: flippedToPass ? null : v.error || r.error,
      };
    });
    repo.insert('runs', {
      id, projectId: runRow.projectId, environment: runRow.environment, user: 'ci-pipeline', label: 'Nightly regression', trigger: 'scheduled', status: 'completed',
      startedAt: iso(start), endedAt: iso(start + results.length * 400 + 5000), total: rows.length, ...counts,
      avgResponseMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      options: runRow.options, jiraActivity: [], summary: { historical: true }, createdRecords: [],
    });
    for (const row of rows) repo.insert('run_results', row);
  }
}

async function createDefectFor(project, resultMatch, extra = {}) {
  const r = repo.find('run_results', "projectId = $p AND status = 'failed' AND defectKey IS NULL", { p: project.id }, 'ORDER BY startedAt DESC').find(resultMatch);
  if (!r) return null;
  const tc = repo.get('test_cases', r.testCaseId);
  const story = repo.one('stories', 'projectId = $p AND key = $k', { p: project.id, k: tc.storyKey });
  const draft = buildDraft({ result: r, testCase: tc, story, project, run: repo.get('runs', r.runId) });
  const jira = jiraFor(project);
  const created = await jira.createDefect(draft);
  if (story) await jira.linkIssues(created.key, story.key);
  const d = { id: crypto.randomUUID(), projectId: project.id, key: created.key, url: created.url, summary: draft.summary, description: draft.description, severity: draft.severity, priority: draft.priority, status: extra.status || 'Open', labels: draft.labels, components: draft.components, testCaseId: tc.id, resultId: r.id, runId: r.runId, storyKey: tc.storyKey, endpoint: r.endpoint, createdBy: 'qa.engineer', createdAt: extra.createdAt || now(), updatedAt: now(), resolvedAt: extra.resolvedAt || null };
  repo.insert('defects', d);
  repo.update('run_results', r.id, { defectKey: created.key });
  if (extra.status) await jira.updateIssue(created.key, { status: extra.status });
  return d;
}

async function seed({ log = console.log, reset = false } = {}) {
  if (reset) resetDb();
  const t0 = Date.now();
  const projects = insertProjects();
  insertJira();
  const [p1, p2, p3] = projects;
  for (const p of [p1, p2, p3]) await syncStories(p);
  log('Projects and Jira stories created.');

  let n = 0;
  n += await generateAndApprove(p1, 'DEMO-101', 1000);
  n += await generateAndApprove(p1, 'DEMO-102', 10000);
  n += await generateAndApprove(p1, 'DEMO-103', 20000);
  n += await generateAndApprove(p1, 'DEMO-104', 30000);
  n += await generateAndApprove(p1, 'DEMO-105', 40000);
  n += await generateAndApprove(p2, 'SVC-201', 1000);
  n += await generateAndApprove(p2, 'SVC-202', 10000);
  n += await generateAndApprove(p3, 'PRD-301', 1000);
  log(`Generated and approved ${n} test cases from 8 stories.`);

  // Contract linked to Apex REST tests
  const parsed = contracts.parse(OPENAPI_YAML);
  const ct = { id: nextId('CT', 3), projectId: p1.id, name: 'Acme Integration APIs (OpenAPI 1.4.0)', kind: parsed.kind, spec: parsed.spec, createdAt: iso(Date.now() - 10 * DAY) };
  repo.insert('contracts', ct);
  for (const t of repo.find('test_cases', "projectId = $p AND endpoint LIKE '/services/apexrest/%'", { p: p1.id })) repo.update('test_cases', t.id, { contractRef: { contractId: ct.id } });

  log('Executing the Acme Sales Cloud suite against the demo org (≈30 s)…');
  const r1 = await execute(p1, null, { label: 'Nightly regression', trigger: 'scheduled' });
  log(`  ${r1.id}: ${r1.passed} passed, ${r1.failed} failed, ${r1.blocked} blocked.`);
  const isDup = (r) => /duplicate business key/i.test(r.title);
  const isLeadMap = (r) => /Web lead intake API: valid payload/i.test(r.title);
  const isCase = (r) => /\bCase\b/.test(r.title) && /query|Query|read/.test(r.title) && r.status === 'failed';
  cloneHistory(r1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], (r, k) => {
    if (isDup(r) && k > 5) return { status: 'passed' };
    if (isLeadMap(r) && k > 3) return { status: 'passed' };
    if (isCase(r) && k > 8) return { status: 'passed', msFactor: 0.42 };
    if (k === 11 && r.status === 'passed' && r.seq % 17 === 0) {
      return { status: 'failed', statusCode: 503, apiError: true, response: { status: 503, headers: {}, body: [{ errorCode: 'SERVER_UNAVAILABLE', message: 'Sandbox maintenance in progress' }] }, error: { code: 'HTTP_503', title: 'Service unavailable (HTTP 503)', cause: 'The service is down or in maintenance.', action: 'Check trust.salesforce.com and retry later.', category: 'environment', evidence: ['HTTP 503'] }, analysis: { category: 'Environment / connectivity', rootCause: 'Sandbox maintenance window — HTTP 503 SERVER_UNAVAILABLE.', evidence: ['HTTP 503 SERVER_UNAVAILABLE'], action: 'Re-run after the maintenance window.', confidence: 'high', label: 'VERIFIED', defectCandidate: false } };
    }
    return null;
  });

  log('Executing Acme Service Cloud and Production smoke suites…');
  const r2 = await execute(p2, null, { label: 'UAT regression' });
  cloneHistory(r2, [1, 3, 5, 8, 10], () => null);
  const r3 = await execute(p3, (t) => !checkOperation(p3, t, {}), { label: 'Post-release smoke (read-only)', trigger: 'manual', user: 'release.manager' });
  log(`  ${r2.id}: ${r2.passed}/${r2.total} passed · ${r3.id}: ${r3.passed}/${r3.total} passed (read-only).`);

  // Defects via the same reviewed-draft path a user would take.
  await createDefectFor(p1, (r) => isDup(r));
  await createDefectFor(p1, (r) => isLeadMap(r));
  log('Jira defects created for two confirmed failures; two more failures are left for you to triage.');

  // Test data
  const td = [
    ['Valid contact — partner portal', 'Positive', 'Contact', 'DEMO-101', { FirstName: 'Ana', LastName: 'Silva', Email: 'ana.silva@partner.example.com', Phone: '+1 415 555 0199', LeadSource: 'Web' }],
    ['Contact missing LastName', 'Negative', 'Contact', 'DEMO-101', { FirstName: 'NoLast', Email: 'nolast@example.com' }],
    ['LastName at max length (80)', 'Boundary', 'Contact', 'DEMO-101', { LastName: '{{$randomString:80}}' }],
    ['Duplicate SAP invoice', 'Integration', 'Invoice__c', 'DEMO-103', { invoiceNumber: 'INV-2026-0001', erpInvoiceId: 'SAP-90001', accountExternalId: 'ERP-ACC-1001', amount: 12500, currency: 'USD' }],
    ['Account rating Hot', 'Regression', 'Account', 'DEMO-102', { Rating: 'Hot' }],
    ['200-record contact batch', 'Performance', 'Contact', 'DEMO-101', { records: 200, template: { LastName: 'Perf {{$timestamp}}' } }],
  ];
  for (const [name, category, object, storyKey, payload] of td) repo.insert('test_data', { id: nextId('TD', 4), projectId: p1.id, name, category, object, storyKey, payload, notes: 'Demo test data', createdAt: iso(Date.now() - 9 * DAY), updatedAt: now() });

  const reqs = [
    ['Org limits', 'Health', 'GET', '/services/data/v{{apiVersion}}/limits', null],
    ['Describe Contact', 'Discovery', 'GET', '/services/data/v{{apiVersion}}/sobjects/Contact/describe', null],
    ['Invoice — duplicate check', 'Integration', 'POST', '/services/apexrest/v1/invoices', { invoiceNumber: 'INV-2026-0001', erpInvoiceId: 'SAP-90001', accountExternalId: 'ERP-ACC-1001', amount: 12500, currency: 'USD' }],
  ];
  for (const [name, collection, method, p, body] of reqs) repo.insert('saved_requests', { id: crypto.randomUUID(), projectId: p1.id, name, collection, apiType: p.includes('apexrest') ? 'Apex REST' : 'REST', method, path: p, headers: {}, query: {}, body, auth: 'default', createdAt: now() });

  log(`Demo data ready in ${Math.round((Date.now() - t0) / 1000)} s.`);
}

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  seed({ reset }).then(() => { console.log(`Seeded ${DB_FILE}`); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { seed, resetDb, ENDPOINTS, OPENAPI_YAML };
