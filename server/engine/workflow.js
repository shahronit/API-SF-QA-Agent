'use strict';
/**
 * Persisted QA lifecycle for a project. Four user-facing stages
 * (Connect → Create tests → Run → Report). Inner work (Jira, describe,
 * review, Salesforce validation, defects) stays on those stage pages.
 * Legacy 13-step ids still resolve so old bookmarks and touch() calls work.
 */
const { repo, get, now } = require('../db');

const STATUSES = ['not_started', 'in_progress', 'completed', 'failed', 'blocked', 'requires_approval'];

const STEPS = [
  {
    id: 'connect', label: 'Connect',
    help: 'Name the workspace, pull Jira tickets, and connect Salesforce plus HTTP/Postman. Passwords stay in .env.',
    primary: 'Finish connections, then create tests', next: 'create',
    parts: [
      { id: 'project', label: 'Project' },
      { id: 'jira', label: 'Jira tickets' },
      { id: 'salesforce', label: 'Salesforce' },
      { id: 'discovery', label: 'Salesforce APIs' },
      { id: 'postman', label: 'HTTP / Postman' },
    ],
  },
  {
    id: 'create', label: 'Create tests',
    help: 'Imported collections become runnable tests immediately. Generate from a Jira ticket only when the project has no tests yet — those suites still need review and approve.',
    primary: 'Run imported tests, or generate from Jira if none exist', next: 'run',
    parts: [
      { id: 'generate', label: 'Generate' },
      { id: 'review', label: 'Review' },
      { id: 'approve', label: 'Approve' },
    ],
  },
  {
    id: 'run', label: 'Run',
    help: 'Execute the approved suite. Pick Playwright MCP, Postman MCP, or the platform runner. Writes are re-read from Salesforce.',
    primary: 'Run tests and check Salesforce data', next: 'report',
    parts: [
      { id: 'execute', label: 'Execute' },
      { id: 'validate', label: 'Salesforce data' },
      { id: 'analysis', label: 'Failures' },
    ],
  },
  {
    id: 'report', label: 'Report',
    help: 'Raise Jira defects from confirmed failures and export a masked report.',
    primary: 'Raise defects and download the report', next: null,
    parts: [
      { id: 'defect', label: 'Defects' },
      { id: 'report', label: 'Download' },
    ],
  },
];

const LEGACY_TO_STAGE = {
  project: 'connect', jira: 'connect', salesforce: 'connect', discovery: 'connect', postman: 'connect',
  generate: 'create', review: 'create', approve: 'create',
  execute: 'run', validate: 'run', analysis: 'run',
  defect: 'report', report: 'report',
  connect: 'connect', create: 'create', run: 'run',
};

function resolveStep(id) {
  if (STEPS.some((s) => s.id === id)) return id;
  return LEGACY_TO_STAGE[id] || 'connect';
}

function stepMeta(id) {
  const resolved = resolveStep(id);
  return STEPS.find((s) => s.id === resolved) || STEPS[0];
}

function rollup(statuses) {
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('requires_approval')) return 'requires_approval';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.length && statuses.every((s) => s === 'completed')) return 'completed';
  if (statuses.some((s) => s === 'in_progress' || s === 'completed')) return 'in_progress';
  return 'not_started';
}

function computeInner(project) {
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

  const inner = {
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
      status: tests ? 'completed' : (proposals ? 'completed' : (stories ? 'in_progress' : 'not_started')),
      detail: { proposals, stories, tests },
    },
    review: {
      status: pending ? 'requires_approval' : (tests || proposals ? 'completed' : 'not_started'),
      detail: { pending, tests },
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
    inner.salesforce.status = 'blocked';
    inner.salesforce.detail.reason = 'Salesforce MCP is unavailable. API test design and automation generation are available, but live Salesforce validation is disabled.';
  }

  return inner;
}

function compute(project) {
  const inner = computeInner(project);
  const steps = {};
  for (const s of STEPS) {
    const partStatus = s.parts.map((p) => (inner[p.id] && inner[p.id].status) || 'not_started');
    const detail = {};
    for (const p of s.parts) Object.assign(detail, (inner[p.id] && inner[p.id].detail) || {});
    steps[s.id] = { status: rollup(partStatus), detail, parts: s.parts.map((p) => ({ ...p, ...(inner[p.id] || {}) })) };
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
    const over = overrides[s.id] || overrides[LEGACY_TO_STAGE[s.id]] || {};
    steps[s.id] = {
      ...s,
      status: STATUSES.includes(over.status) ? over.status : base.status,
      detail: { ...(base.detail || {}), ...(over.detail || {}) },
      parts: base.parts || s.parts,
      updatedAt: over.updatedAt || (row && row.updatedAt) || null,
    };
  }
  const firstOpen = STEPS.find((s) => !['completed'].includes(steps[s.id].status));
  const stored = row && row.currentStep ? resolveStep(row.currentStep) : null;
  const currentStep = (stored && steps[stored]) ? stored : (firstOpen ? firstOpen.id : 'report');
  return {
    projectId: project.id,
    currentStep,
    current: steps[currentStep],
    next: stepMeta(steps[currentStep].next || currentStep),
    steps: STEPS.map((s) => steps[s.id]),
    updatedAt: (row && row.updatedAt) || now(),
  };
}

function persist(projectId, patch) {
  const existing = rowFor(projectId) || { projectId, currentStep: 'connect', steps: {}, updatedAt: now() };
  const next = {
    projectId,
    currentStep: resolveStep(patch.currentStep || existing.currentStep),
    steps: { ...(existing.steps || {}), ...(patch.steps || {}) },
    updatedAt: now(),
  };
  if (rowFor(projectId)) repo.update('workflow_state', projectId, next, 'projectId');
  else repo.insert('workflow_state', next);
  return next;
}

function visit(project, stepId) {
  const id = resolveStep(stepId);
  persist(project.id, { currentStep: id });
  const { audit } = require('../db');
  audit('workflow', 'workflow.visit', { projectId: project.id, detail: { step: id, requested: stepId } });
  return getState(repo.get('projects', project.id) || project);
}

function touch(projectId, stepId, status, detail) {
  const id = resolveStep(stepId);
  const existing = rowFor(projectId);
  const steps = { ...((existing && existing.steps) || {}) };
  steps[id] = { status: status || (steps[id] && steps[id].status), detail: detail || (steps[id] && steps[id].detail) || {}, updatedAt: now() };
  persist(projectId, { currentStep: id, steps });
}

module.exports = { STEPS, STATUSES, LEGACY_TO_STAGE, resolveStep, getState, visit, touch, compute, stepMeta };
