'use strict';
/**
 * Persisted QA lifecycle for a project. Status is derived from existing
 * records (stories, proposals, runs, …) and merged with the last visited step
 * so returning users restore where they left off.
 */
const { repo, get, now } = require('../db');

const STATUSES = ['not_started', 'in_progress', 'completed', 'failed', 'blocked', 'requires_approval'];

const STEPS = [
  { id: 'project', group: 'Start', label: 'Set up project', help: 'Name the workspace, pick QA / UAT / Production, and choose Demo or a live org.', primary: 'Save, then pull Jira tickets', next: 'jira' },
  { id: 'jira', group: 'Requirements', label: 'Pull Jira tickets', help: 'Bring in the stories you want to cover so we can turn them into API tests.', primary: 'Pick a ticket, then connect Salesforce', next: 'salesforce' },
  { id: 'salesforce', group: 'Connect', label: 'Connect Salesforce (backend)', help: 'Backend APIs: org REST, Apex REST, Bulk, Composite. Stay in Demo or point at a live org. Passwords stay in .env — this screen only stores a prefix.', primary: 'Test Salesforce, then find backend APIs', next: 'discovery' },
  { id: 'discovery', group: 'Discover', label: 'Find Salesforce APIs', help: 'See which Salesforce objects and backend endpoints this org exposes.', primary: 'Review objects, then look for frontend HTTP collections', next: 'postman' },
  { id: 'postman', group: 'Discover', label: 'Find HTTP collections (frontend)', help: 'Frontend / HTTP APIs: custom REST, storefront, middleware, BFF. Reuse a Postman collection when it already matches.', primary: 'Reuse or create a collection, then create tests', next: 'generate' },
  { id: 'generate', group: 'Tests', label: 'Create tests', help: 'Generate API test cases from the Jira ticket you selected.', primary: 'Generate tests from the ticket', next: 'review' },
  { id: 'review', group: 'Tests', label: 'Review tests', help: 'Check coverage and drop anything that should not run.', primary: 'Review coverage, then approve selected tests', next: 'approve' },
  { id: 'approve', group: 'Tests', label: 'Approve tests', help: 'Only approved tests are allowed to run. Approving upserts them into a Postman collection (Postman MCP when connected).', primary: 'Approve selected tests, then run them', next: 'execute' },
  { id: 'execute', group: 'Tests', label: 'Run tests', help: 'Execute the approved suite via Postman MCP when connected, otherwise in the platform runner.', primary: 'Run approved tests', next: 'validate' },
  { id: 'validate', group: 'Results', label: 'Check Salesforce data', help: 'Compare API payloads with the records actually stored in Salesforce.', primary: 'Compare API payloads with Salesforce records', next: 'analysis' },
  { id: 'analysis', group: 'Results', label: 'Understand results', help: 'Separate product bugs from test issues before you raise tickets.', primary: 'Classify failures, then raise defects', next: 'defect' },
  { id: 'defect', group: 'Results', label: 'Raise defects', help: 'Preview a Jira bug from a confirmed failure. Nothing is created until you confirm.', primary: 'Preview and create Jira defects for confirmed failures', next: 'report' },
  { id: 'report', group: 'Results', label: 'Download report', help: 'Export a stakeholder report. Tokens and credentials are masked.', primary: 'Export the run report and traceability', next: null },
];

function stepMeta(id) {
  return STEPS.find((s) => s.id === id) || STEPS[0];
}

function compute(project) {
  const pid = project.id;
  const stories = get('SELECT COUNT(*) AS n FROM stories WHERE projectId = $p', { p: pid }).n;
  const pending = get("SELECT COUNT(*) AS n FROM proposals WHERE projectId = $p AND status = 'proposed'", { p: pid }).n;
  const proposals = get('SELECT COUNT(*) AS n FROM proposals WHERE projectId = $p', { p: pid }).n;
  const approved = get("SELECT COUNT(*) AS n FROM proposals WHERE projectId = $p AND status = 'approved'", { p: pid }).n;
  const tests = get('SELECT COUNT(*) AS n FROM test_cases WHERE projectId = $p', { p: pid }).n;
  const runs = get('SELECT COUNT(*) AS n FROM runs WHERE projectId = $p', { p: pid }).n;
  const running = get("SELECT COUNT(*) AS n FROM runs WHERE projectId = $p AND status IN ('running','queued')", { p: pid }).n;
  const lastRun = get('SELECT id, status, failed, passed, total FROM runs WHERE projectId = $p ORDER BY startedAt DESC LIMIT 1', { p: pid });
  const validated = get("SELECT COUNT(*) AS n FROM run_results WHERE projectId = $p AND sfValidation IS NOT NULL AND sfValidation != '' AND sfValidation != 'null'", { p: pid }).n;
  const sfFail = get("SELECT COUNT(*) AS n FROM run_results WHERE projectId = $p AND json_extract(sfValidation, '$.status') = 'FAIL'", { p: pid }).n;
  const analysed = get("SELECT COUNT(*) AS n FROM run_results WHERE projectId = $p AND analysis IS NOT NULL AND analysis != '' AND analysis != 'null'", { p: pid }).n;
  const failedResults = get("SELECT COUNT(*) AS n FROM run_results WHERE projectId = $p AND status = 'failed'", { p: pid }).n;
  const defects = get('SELECT COUNT(*) AS n FROM defects WHERE projectId = $p', { p: pid }).n;
  const collections = get('SELECT COUNT(*) AS n FROM collections WHERE projectId = $p', { p: pid }).n;
  const colPending = get("SELECT COUNT(*) AS n FROM collection_proposals WHERE projectId = $p AND status = 'pending'", { p: pid }).n;
  const ic = project.integrationConfig || {};
  const mcp = Boolean((ic.salesforceMcp && (ic.salesforceMcp.url || ic.salesforceMcp.command)) || project.credentialRef);
  const postmanHint = Boolean(project.postmanCollection || (ic.postman && (ic.postman.workspace || ic.postman.mcpUrl || ic.postman.mcpCommand)) || collections);

  const sfLive = project.mode === 'live';
  const sfOk = !sfLive || project.mode === 'demo' || Boolean(project.instanceUrl || project.credentialRef);

  const steps = {
    project: {
      status: project.name && project.environment && project.apiVersion ? 'completed' : 'in_progress',
      detail: { name: project.name, environment: project.environment, sfOrg: project.sfOrg, jira: project.jiraProjectKey },
    },
    jira: {
      status: stories ? 'completed' : (project.jiraUrl || project.jiraProjectKey || project.mode === 'demo' ? 'in_progress' : 'not_started'),
      detail: { stories, projectKey: project.jiraProjectKey },
    },
    salesforce: {
      status: project.mode === 'demo' ? 'completed' : (sfOk ? 'in_progress' : 'blocked'),
      detail: { mode: project.mode, source: ic.salesforceSource || (mcp ? 'mcp' : 'oauth') },
    },
    discovery: {
      status: tests || stories ? 'completed' : (sfOk || project.mode === 'demo' ? 'in_progress' : 'blocked'),
      detail: { tests },
    },
    postman: {
      status: colPending ? 'requires_approval' : (collections || postmanHint || tests ? 'completed' : 'not_started'),
      detail: { collections, pendingChanges: colPending, linked: project.postmanCollection || null },
    },
    generate: {
      status: proposals ? 'completed' : (stories ? 'in_progress' : 'not_started'),
      detail: { proposals, stories },
    },
    review: {
      status: pending ? 'requires_approval' : (proposals ? 'completed' : 'not_started'),
      detail: { pending },
    },
    approve: {
      status: tests ? 'completed' : (pending ? 'requires_approval' : 'not_started'),
      detail: { tests, approved },
    },
    execute: {
      status: running ? 'in_progress' : (lastRun && lastRun.status === 'failed' && lastRun.passed === 0 ? 'failed' : (runs ? 'completed' : (tests ? 'in_progress' : 'not_started'))),
      detail: { runs, running, lastRun: lastRun || null },
    },
    validate: {
      status: sfFail ? 'failed' : (validated ? 'completed' : (runs ? 'in_progress' : 'not_started')),
      detail: { validated, sfFail },
    },
    analysis: {
      status: analysed || (lastRun && lastRun.status && lastRun.status !== 'running') ? 'completed' : (runs ? 'in_progress' : 'not_started'),
      detail: { analysed, failedResults },
    },
    defect: {
      status: defects ? 'completed' : (failedResults ? 'in_progress' : (runs ? 'completed' : 'not_started')),
      detail: { defects, failedResults },
    },
    report: {
      status: lastRun && lastRun.status !== 'running' ? 'completed' : (runs ? 'in_progress' : 'not_started'),
      detail: { lastRunId: lastRun && lastRun.id },
    },
  };

  if (sfLive && !project.credentialRef && project.mode === 'live' && !ic.salesforceMcp) {
    steps.salesforce.status = 'blocked';
    steps.salesforce.detail.reason = 'Salesforce MCP is unavailable. API test design and automation generation are available, but live Salesforce validation is disabled.';
  }

  return steps;
}

function rowFor(projectId) {
  return repo.get('workflow_state', projectId, 'projectId');
}

function getState(project) {
  const computed = compute(project);
  const row = rowFor(project.id);
  const overrides = (row && row.steps) || {};
  const steps = {};
  for (const s of STEPS) {
    const base = computed[s.id] || { status: 'not_started', detail: {} };
    const over = overrides[s.id] || {};
    steps[s.id] = {
      ...s,
      status: STATUSES.includes(over.status) ? over.status : base.status,
      detail: { ...(base.detail || {}), ...(over.detail || {}) },
      updatedAt: over.updatedAt || (row && row.updatedAt) || null,
    };
  }
  const firstOpen = STEPS.find((s) => !['completed'].includes(steps[s.id].status));
  const currentStep = (row && row.currentStep && steps[row.currentStep]) ? row.currentStep : (firstOpen ? firstOpen.id : 'report');
  return {
    projectId: project.id,
    currentStep,
    current: steps[currentStep],
    next: stepMeta(steps[currentStep].next || currentStep),
    steps: STEPS.map((s) => steps[s.id]),
    groups: group(STEPS.map((s) => steps[s.id])),
    updatedAt: (row && row.updatedAt) || now(),
  };
}

function group(steps) {
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (!last || last.group !== s.group) out.push({ group: s.group, items: [s] });
    else last.items.push(s);
  }
  return out;
}

function persist(projectId, patch) {
  const existing = rowFor(projectId) || { projectId, currentStep: 'project', steps: {}, updatedAt: now() };
  const next = {
    projectId,
    currentStep: patch.currentStep || existing.currentStep,
    steps: { ...(existing.steps || {}), ...(patch.steps || {}) },
    updatedAt: now(),
  };
  if (rowFor(projectId)) repo.update('workflow_state', projectId, next, 'projectId');
  else repo.insert('workflow_state', next);
  return next;
}

function visit(project, stepId) {
  const id = STEPS.some((s) => s.id === stepId) ? stepId : 'project';
  persist(project.id, { currentStep: id });
  const { audit } = require('../db');
  audit('workflow', 'workflow.visit', { projectId: project.id, detail: { step: id } });
  return getState(repo.get('projects', project.id) || project);
}

function touch(projectId, stepId, status, detail) {
  if (!STEPS.some((s) => s.id === stepId)) return;
  const existing = rowFor(projectId);
  const steps = { ...((existing && existing.steps) || {}) };
  steps[stepId] = { status: status || (steps[stepId] && steps[stepId].status), detail: detail || (steps[stepId] && steps[stepId].detail) || {}, updatedAt: now() };
  persist(projectId, { currentStep: stepId, steps });
}

module.exports = { STEPS, STATUSES, getState, visit, touch, compute, stepMeta };
