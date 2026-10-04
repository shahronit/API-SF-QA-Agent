'use strict';
/** Jira stories, story → test generation proposals, approval, traceability and regression impact. */
const crypto = require('node:crypto');
const { route, HttpError, required } = require('../http');
const { repo, all, get, now, audit, nextId, transaction } = require('../db');
const { salesforceFor, jiraFor } = require('../connectors');
const { generateSuite } = require('../engine/generator');
const { projectFrom, getProject, paginate, likeFilter, inFilter } = require('./util');

function upsertStory(projectId, s, source) {
  const existing = repo.one('stories', 'projectId = $p AND key = $k', { p: projectId, k: s.key });
  const row = {
    projectId, key: s.key, summary: s.summary || '(no summary)', description: s.description || '', acceptanceCriteria: s.acceptanceCriteria || '',
    issueType: s.issueType || 'Story', status: s.status || null, priority: s.priority || null, sprint: s.sprint || null,
    components: s.components || [], labels: s.labels || [], assignee: s.assignee || null, url: s.url || null, source, syncedAt: now(),
  };
  if (existing) { repo.update('stories', existing.id, row); return { ...existing, ...row }; }
  const r = { id: crypto.randomUUID(), ...row };
  repo.insert('stories', r);
  return r;
}

function storyCoverage(projectId) {
  const rows = all(`SELECT storyKey, COUNT(*) AS tests, SUM(CASE WHEN lastResult = 'passed' THEN 1 ELSE 0 END) AS passed,
    SUM(CASE WHEN lastResult = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN lastResult = 'blocked' THEN 1 ELSE 0 END) AS blocked,
    SUM(CASE WHEN lastResult IS NOT NULL THEN 1 ELSE 0 END) AS executed FROM test_cases WHERE projectId = $p GROUP BY storyKey`, { p: projectId });
  return Object.fromEntries(rows.map((r) => [r.storyKey, r]));
}

route('GET', '/api/stories', (ctx) => {
  const p = projectFrom(ctx);
  const where = ['projectId = $p']; const params = { p: p.id };
  likeFilter(where, params, ['key', 'summary', 'description'], ctx.query.q);
  inFilter(where, params, 'sprint', ctx.query.sprint, 'sp');
  inFilter(where, params, 'status', ctx.query.status, 'st');
  const page = paginate('stories', ctx, { where, params, sortable: ['key', 'summary', 'status', 'priority', 'sprint', 'syncedAt'], defaultSort: 'key', defaultDir: 'ASC' });
  const cov = storyCoverage(p.id);
  const defects = Object.fromEntries(all('SELECT storyKey, COUNT(*) AS n FROM defects WHERE projectId = $p GROUP BY storyKey', { p: p.id }).map((r) => [r.storyKey, r.n]));
  page.items = page.items.map((s) => ({ ...s, coverage: cov[s.key] || { tests: 0, passed: 0, failed: 0, blocked: 0, executed: 0 }, defects: defects[s.key] || 0 }));
  page.sprints = all('SELECT DISTINCT sprint FROM stories WHERE projectId = $p AND sprint IS NOT NULL ORDER BY sprint', { p: p.id }).map((r) => r.sprint);
  return page;
});

route('POST', '/api/stories/sync', async (ctx) => {
  const p = projectFrom(ctx);
  const jira = jiraFor(p);
  if (!jira.available) throw new HttpError(503, jira.unavailableExplanation().title, jira.unavailableExplanation());
  try {
    const issues = await jira.searchStories({ jql: ctx.body.jql });
    const saved = transaction(() => issues.map((i) => upsertStory(p.id, i, p.mode === 'demo' ? 'demo-jira' : 'jira')));
    audit('jira', 'stories.synced', { user: ctx.user, projectId: p.id, detail: { count: saved.length, jql: ctx.body.jql || null } });
    return { synced: saved.length };
  } catch (e) { throw new HttpError(502, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
});

route('POST', '/api/stories', (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['key', 'summary']);
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(ctx.body.key)) throw new HttpError(400, 'Story key must look like PROJ-123.');
  const s = upsertStory(p.id, ctx.body, 'manual');
  audit('jira', 'story.added-manually', { user: ctx.user, projectId: p.id, detail: { key: s.key } });
  return s;
});

route('GET', '/api/stories/:key', async (ctx) => {
  const p = projectFrom(ctx);
  let s = repo.one('stories', 'projectId = $p AND key = $k', { p: p.id, k: ctx.params.key });
  if (!s || ctx.query.refresh === 'true') {
    const jira = jiraFor(p);
    if (!jira.available && !s) throw new HttpError(404, `Story ${ctx.params.key} is not cached and Jira is unavailable.`, jira.unavailableExplanation());
    if (jira.available) {
      try { s = upsertStory(p.id, await jira.getIssue(ctx.params.key), p.mode === 'demo' ? 'demo-jira' : 'jira'); } catch (e) {
        if (!s) throw new HttpError(404, e.explanation ? e.explanation.title : e.message, e.explanation || {});
      }
    }
  }
  const scenarios = repo.find('scenarios', 'projectId = $p AND storyKey = $k', { p: p.id, k: s.key }, 'ORDER BY createdAt');
  const tests = all('SELECT id, scenarioId, title, method, endpoint, testType, priority, status, label, lastResult, lastRunAt FROM test_cases WHERE projectId = $p AND storyKey = $k ORDER BY seq', { p: p.id, k: s.key });
  const defects = repo.find('defects', 'projectId = $p AND storyKey = $k', { p: p.id, k: s.key });
  const proposals = all('SELECT id, status, createdAt, decidedAt FROM proposals WHERE projectId = $p AND storyKey = $k ORDER BY createdAt DESC LIMIT 5', { p: p.id, k: s.key });
  return { ...s, scenarios, tests, defects, proposals, coverage: storyCoverage(p.id)[s.key] || null };
});

// ── Generation ──
route('POST', '/api/generate', async (ctx) => {
  const p = projectFrom(ctx);
  required(ctx.body, ['storyKey']);
  let story = repo.one('stories', 'projectId = $p AND key = $k', { p: p.id, k: ctx.body.storyKey });
  if (!story) {
    const jira = jiraFor(p);
    if (!jira.available) throw new HttpError(404, `Story ${ctx.body.storyKey} not found locally and Jira is unavailable.`, jira.unavailableExplanation());
    story = upsertStory(p.id, await jira.getIssue(ctx.body.storyKey), 'jira');
  }
  const sf = salesforceFor(p);
  const t0 = Date.now();
  const { analysis, scenarios } = await generateSuite({ project: p, story, sf });
  const proposal = { id: nextId('GEN', 4), projectId: p.id, storyKey: story.key, status: 'proposed', analysis: { ...analysis, generationMs: Date.now() - t0 }, scenarios, createdBy: ctx.user, createdAt: now() };
  repo.insert('proposals', proposal);
  audit('generation', 'suite.proposed', { user: ctx.user, projectId: p.id, detail: { proposalId: proposal.id, storyKey: story.key, scenarios: scenarios.length, tests: scenarios.reduce((n, s) => n + s.testCases.length, 0) } });
  return proposal;
});

route('GET', '/api/proposals/:id', (ctx) => {
  const pr = repo.get('proposals', ctx.params.id);
  if (!pr) throw new HttpError(404, `Proposal ${ctx.params.id} not found.`);
  return pr;
});

route('GET', '/api/proposals', (ctx) => {
  const p = projectFrom(ctx);
  return all('SELECT id, storyKey, status, createdBy, createdAt, decidedAt FROM proposals WHERE projectId = $p ORDER BY createdAt DESC LIMIT 50', { p: p.id });
});

/**
 * Approve a proposal (optionally a subset). Creates scenarios/test cases.
 * Jira is only updated when postToJira === true (explicit user choice).
 */
route('POST', '/api/proposals/:id/approve', async (ctx) => {
  const pr = repo.get('proposals', ctx.params.id);
  if (!pr) throw new HttpError(404, `Proposal ${ctx.params.id} not found.`);
  if (pr.status !== 'proposed') throw new HttpError(409, `Proposal ${pr.id} was already ${pr.status}.`, { action: 'Generate a new proposal for this story.' });
  const p = getProject(pr.projectId);
  const selected = ctx.body.selected; // { [scenarioIndex]: [testIndex,...] } or undefined = all
  const startSeq = (get('SELECT MAX(seq) AS m FROM test_cases WHERE projectId = $p', { p: p.id }).m || 0) + 100;
  const created = { scenarios: 0, tests: 0, ids: [] };
  transaction(() => {
    pr.scenarios.forEach((s, si) => {
      const picks = selected ? (selected[si] || []) : s.testCases.map((_, i) => i);
      if (!picks.length) return;
      const scId = nextId('TS', 4);
      repo.insert('scenarios', { id: scId, projectId: p.id, storyKey: pr.storyKey, title: s.title, description: s.description, apiType: s.apiType, object: s.object, type: s.type, priority: s.priority, label: s.label, status: 'active', createdAt: now(), updatedAt: now() });
      created.scenarios++;
      picks.forEach((ti) => {
        const t = s.testCases[ti];
        if (!t) return;
        const id = nextId('TC', 5);
        repo.insert('test_cases', {
          id, projectId: p.id, scenarioId: scId, storyKey: pr.storyKey, seq: startSeq + si * 1000 + (t.seqHint || ti),
          title: t.title, description: t.description || null, apiType: t.apiType || 'REST', method: t.method, endpoint: t.endpoint, auth: t.auth || 'default',
          headers: t.headers || {}, query: t.query || {}, body: t.body === undefined ? null : t.body, bodyRaw: t.bodyRaw || null, assertions: t.assertions || [], extract: t.extract || [],
          sfValidation: t.sfValidation || null, cleanup: t.cleanup || null, timeoutMs: t.timeoutMs || null, object: t.object || s.object || null,
          testType: t.testType, priority: t.priority, priorityReason: t.priorityReason || null, status: t.status || 'ready', label: t.label || s.label, tags: t.tags || [], automated: 1,
          createdAt: now(), updatedAt: now(),
        });
        created.tests++;
        created.ids.push(id);
      });
    });
    repo.update('proposals', pr.id, { status: 'approved', decidedAt: now(), decision: { by: ctx.user, selected: selected || 'all', postToJira: Boolean(ctx.body.postToJira) } });
  });
  audit('generation', 'suite.approved', { user: ctx.user, projectId: p.id, detail: { proposalId: pr.id, storyKey: pr.storyKey, ...created, ids: undefined } });
  let jira = null;
  if (ctx.body.postToJira) {
    const conn = jiraFor(p);
    if (!conn.available) jira = { ok: false, ...conn.unavailableExplanation() };
    else {
      try {
        const byType = {};
        pr.scenarios.forEach((s) => { byType[s.type] = (byType[s.type] || 0) + s.testCases.length; });
        await conn.addComment(pr.storyKey, `API test coverage generated and approved by ${ctx.user}.\n\n- Scenarios: ${created.scenarios}\n- Test cases: ${created.tests}\n${Object.entries(byType).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\nMetadata provenance: ${pr.analysis.metadataLabel}. Generated by Salesforce API QA Platform.`);
        await conn.addLabels(pr.storyKey, ['api-tests-generated']);
        jira = { ok: true, comment: true, label: 'api-tests-generated' };
        audit('jira', 'story.commented', { user: ctx.user, projectId: p.id, detail: { key: pr.storyKey } });
      } catch (e) { jira = { ok: false, ...(e.explanation || { title: e.message }) }; }
    }
  }
  return { ...created, jira };
});

route('POST', '/api/proposals/:id/reject', (ctx) => {
  const pr = repo.get('proposals', ctx.params.id);
  if (!pr) throw new HttpError(404, `Proposal ${ctx.params.id} not found.`);
  repo.update('proposals', pr.id, { status: 'rejected', decidedAt: now(), decision: { by: ctx.user, reason: ctx.body.reason || null } });
  audit('generation', 'suite.rejected', { user: ctx.user, projectId: pr.projectId, detail: { proposalId: pr.id } });
  return { rejected: true };
});

// ── Traceability ──
route('GET', '/api/traceability', (ctx) => {
  const p = projectFrom(ctx);
  const stories = repo.find('stories', 'projectId = $p', { p: p.id }, 'ORDER BY key');
  const scenarios = all('SELECT id, storyKey, title, type, priority, label FROM scenarios WHERE projectId = $p', { p: p.id });
  const tests = all('SELECT id, scenarioId, storyKey, title, method, endpoint, testType, priority, lastResult, lastRunAt FROM test_cases WHERE projectId = $p ORDER BY seq', { p: p.id });
  const lastResults = Object.fromEntries(all(`SELECT r.testCaseId, r.id, r.runId, r.status, r.statusCode, r.responseMs, r.defectKey FROM run_results r
    JOIN (SELECT testCaseId, MAX(startedAt) AS m FROM run_results WHERE projectId = $p GROUP BY testCaseId) x ON x.testCaseId = r.testCaseId AND x.m = r.startedAt WHERE r.projectId = $p`, { p: p.id }).map((r) => [r.testCaseId, r]));
  const defects = all('SELECT id, key, summary, status, severity, testCaseId, storyKey FROM defects WHERE projectId = $p', { p: p.id });
  const defByTc = {};
  for (const d of defects) (defByTc[d.testCaseId] = defByTc[d.testCaseId] || []).push(d);
  const tree = stories.map((s) => ({
    key: s.key, summary: s.summary, status: s.status, sprint: s.sprint, url: s.url,
    scenarios: scenarios.filter((sc) => sc.storyKey === s.key).map((sc) => ({
      ...sc,
      tests: tests.filter((t) => t.scenarioId === sc.id).map((t) => ({ ...t, execution: lastResults[t.id] || null, defects: defByTc[t.id] || [] })),
    })),
  }));
  const executed = tests.filter((t) => t.lastResult).length;
  const metrics = {
    storiesTotal: stories.length,
    storiesCovered: stories.filter((s) => tests.some((t) => t.storyKey === s.key)).length,
    testsGenerated: tests.length,
    testsExecuted: executed,
    passed: tests.filter((t) => t.lastResult === 'passed').length,
    failed: tests.filter((t) => t.lastResult === 'failed').length,
    blocked: tests.filter((t) => t.lastResult === 'blocked').length,
    defectsCreated: defects.length,
    defectsResolved: defects.filter((d) => /resolved|closed|done/i.test(d.status)).length,
  };
  metrics.coveragePct = metrics.storiesTotal ? Math.round((metrics.storiesCovered / metrics.storiesTotal) * 1000) / 10 : 0;
  metrics.executionPct = tests.length ? Math.round((executed / tests.length) * 1000) / 10 : 0;
  return { metrics, tree };
});

// ── Regression impact ──
route('POST', '/api/regression/impact', (ctx) => {
  const p = projectFrom(ctx);
  const objects = new Set((ctx.body.objects || []).map(String));
  const endpoints = (ctx.body.endpoints || []).map(String);
  if (ctx.body.storyKey) {
    const s = repo.one('stories', 'projectId = $p AND key = $k', { p: p.id, k: ctx.body.storyKey });
    if (s) {
      const text = `${s.summary} ${s.description} ${s.acceptanceCriteria}`;
      for (const o of all('SELECT DISTINCT object FROM test_cases WHERE projectId = $p AND object IS NOT NULL', { p: p.id })) if (new RegExp(`\\b${o.object}\\b`, 'i').test(text)) objects.add(o.object);
    }
  }
  const tests = repo.find('test_cases', "projectId = $p AND status != 'draft'", { p: p.id }, 'ORDER BY seq');
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const impacted = tests.filter((t) => objects.has(t.object) || endpoints.some((e) => t.endpoint.includes(e)) || (t.tags || []).includes('regression') && objects.has(t.object))
    .map((t) => ({ id: t.id, title: t.title, object: t.object, priority: t.priority, testType: t.testType, lastResult: t.lastResult, reason: objects.has(t.object) ? `Touches ${t.object}` : 'Matches changed endpoint' }))
    .sort((a, b) => order[a.priority] - order[b.priority]);
  // Always include the P0 regression pack so critical paths are re-verified.
  const p0 = tests.filter((t) => t.priority === 'P0' && (t.tags || []).includes('regression') && !impacted.some((x) => x.id === t.id)).map((t) => ({ id: t.id, title: t.title, object: t.object, priority: t.priority, testType: t.testType, lastResult: t.lastResult, reason: 'P0 regression pack' }));
  return { objects: [...objects], impacted: [...impacted, ...p0], label: 'RECOMMENDED' };
});

module.exports = { upsertStory, storyCoverage };
