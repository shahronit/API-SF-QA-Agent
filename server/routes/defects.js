'use strict';
/**
 * Jira defect workflow: detect → analyse → draft → preview → user confirms →
 * create in Jira → link to story → store key on result and test case.
 */
const crypto = require('node:crypto');
const { route, HttpError, required } = require('../http');
const { repo, now, audit } = require('../db');
const { jiraFor } = require('../connectors');
const { buildDraft } = require('../engine/defects');
const { maskDeep, maskText } = require('../lib/mask');
const { projectFrom, getProject, paginate, inFilter, likeFilter } = require('./util');

route('POST', '/api/defects/preview', (ctx) => {
  required(ctx.body, ['resultId']);
  const result = repo.get('run_results', ctx.body.resultId);
  if (!result) throw new HttpError(404, `Result ${ctx.body.resultId} not found.`);
  if (result.status !== 'failed') throw new HttpError(409, `Result ${result.id} is ${result.status}; defects are only drafted for failed tests.`, { action: 'Blocked tests usually need configuration, not a defect. Fix the blocker and re-run.' });
  const testCase = repo.get('test_cases', result.testCaseId) || { id: result.testCaseId, title: result.title, testType: result.testType, priority: result.priority, storyKey: result.storyKey };
  const project = getProject(result.projectId);
  const story = testCase.storyKey ? repo.one('stories', 'projectId = $p AND key = $k', { p: project.id, k: testCase.storyKey }) : null;
  const run = repo.get('runs', result.runId);
  const existing = repo.one('defects', 'resultId = $r', { r: result.id }) || (testCase.id ? repo.one('defects', "testCaseId = $t AND status NOT IN ('Closed','Done','Resolved')", { t: testCase.id }) : null);
  const draft = buildDraft({ result, testCase, story, project, run });
  const jira = jiraFor(project);
  return { draft, existing: existing ? { key: existing.key, summary: existing.summary, status: existing.status, url: existing.url } : null, jira: { available: jira.available, kind: jira.kind, project: project.jiraProjectKey, explanation: jira.available ? null : jira.unavailableExplanation() } };
});

route('POST', '/api/defects', async (ctx) => {
  const b = ctx.body;
  required(b, ['resultId', 'summary', 'description']);
  if (b.confirmed !== true) {
    throw new HttpError(400, 'Defect creation requires explicit confirmation.', { action: 'Review the defect preview and click "Create Jira defect".' });
  }
  const result = repo.get('run_results', b.resultId);
  if (!result) throw new HttpError(404, `Result ${b.resultId} not found.`);
  const project = getProject(result.projectId);
  const jira = jiraFor(project);
  if (!jira.available) throw new HttpError(503, jira.unavailableExplanation().title, jira.unavailableExplanation());
  const dup = repo.one('defects', 'resultId = $r', { r: result.id });
  if (dup) throw new HttpError(409, `Defect ${dup.key} already exists for this result.`, { action: 'Open the existing defect instead.' });
  const clean = maskDeep({ summary: String(b.summary).slice(0, 240), description: String(b.description).slice(0, 30000), labels: b.labels || [], components: b.components || [], priority: b.priority, severity: b.severity });
  let created;
  try {
    created = await jira.createDefect(clean);
  } catch (e) { throw new HttpError(502, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
  const activity = [{ action: 'created', key: created.key }];
  const storyKey = b.storyKey || result.storyKey;
  if (storyKey && b.linkToStory !== false) {
    try { await jira.linkIssues(created.key, storyKey); activity.push({ action: 'linked', from: created.key, to: storyKey }); }
    catch (e) { activity.push({ action: 'link-failed', error: e.explanation ? e.explanation.title : e.message }); }
  }
  const d = {
    id: crypto.randomUUID(), projectId: project.id, key: created.key, url: created.url, summary: clean.summary, description: clean.description,
    severity: clean.severity || 'Medium', priority: clean.priority || null, status: 'Open', labels: clean.labels, components: clean.components,
    testCaseId: result.testCaseId, resultId: result.id, runId: result.runId, storyKey, endpoint: result.endpoint, createdBy: ctx.user, createdAt: now(), updatedAt: now(),
  };
  repo.insert('defects', d);
  repo.update('run_results', result.id, { defectKey: created.key });
  const run = repo.get('runs', result.runId);
  if (run) repo.update('runs', run.id, { jiraActivity: [...(run.jiraActivity || []), ...activity.map((a) => ({ ...a, at: now(), user: ctx.user }))] });
  audit('jira', 'defect.created', { user: ctx.user, projectId: project.id, detail: { key: created.key, runId: result.runId, resultId: result.id, storyKey, activity } });
  return { ...d, activity };
});

route('GET', '/api/defects', (ctx) => {
  const p = projectFrom(ctx);
  const where = ['projectId = $p']; const params = { p: p.id };
  inFilter(where, params, 'status', ctx.query.status, 'st');
  inFilter(where, params, 'severity', ctx.query.severity, 'sv');
  inFilter(where, params, 'storyKey', ctx.query.storyKey, 'sk');
  likeFilter(where, params, ['key', 'summary', 'endpoint'], ctx.query.q);
  return paginate('defects', ctx, { where, params, columns: 'id, projectId, key, url, summary, severity, priority, status, labels, testCaseId, resultId, runId, storyKey, endpoint, createdBy, createdAt, updatedAt, resolvedAt', sortable: ['createdAt', 'severity', 'status', 'key'], defaultSort: 'createdAt' });
});

route('GET', '/api/defects/:id', (ctx) => {
  const d = repo.get('defects', ctx.params.id);
  if (!d) throw new HttpError(404, `Defect ${ctx.params.id} not found.`);
  return d;
});

route('PUT', '/api/defects/:id', async (ctx) => {
  const d = repo.get('defects', ctx.params.id);
  if (!d) throw new HttpError(404, `Defect ${ctx.params.id} not found.`);
  const project = getProject(d.projectId);
  const patch = { updatedAt: now() };
  for (const k of ['summary', 'description', 'severity', 'priority', 'labels']) if (ctx.body[k] !== undefined) patch[k] = typeof ctx.body[k] === 'string' ? maskText(ctx.body[k]) : ctx.body[k];
  if (ctx.body.status) { patch.status = ctx.body.status; if (/resolved|closed|done/i.test(ctx.body.status)) patch.resolvedAt = now(); }
  if (ctx.body.pushToJira) {
    if (ctx.body.confirmed !== true) throw new HttpError(400, 'Updating the Jira issue requires explicit confirmation.');
    const jira = jiraFor(project);
    try {
      await jira.updateIssue(d.key, { summary: patch.summary, description: patch.description, labels: patch.labels, priority: patch.priority, status: project.mode === 'demo' ? patch.status : undefined });
      if (ctx.body.comment) await jira.addComment(d.key, ctx.body.comment);
    } catch (e) { throw new HttpError(502, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
    audit('jira', 'defect.updated', { user: ctx.user, projectId: project.id, detail: { key: d.key, fields: Object.keys(patch) } });
  }
  repo.update('defects', d.id, patch);
  return repo.get('defects', d.id);
});

route('POST', '/api/defects/:id/sync', async (ctx) => {
  const d = repo.get('defects', ctx.params.id);
  if (!d) throw new HttpError(404, `Defect ${ctx.params.id} not found.`);
  const jira = jiraFor(getProject(d.projectId));
  try {
    const s = await jira.getStatus(d.key);
    const patch = { status: s.status, updatedAt: now() };
    if (s.category === 'done' && !d.resolvedAt) patch.resolvedAt = s.resolvedAt || now();
    repo.update('defects', d.id, patch);
    return repo.get('defects', d.id);
  } catch (e) { throw new HttpError(502, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
});
