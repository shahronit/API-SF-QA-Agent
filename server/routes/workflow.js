'use strict';
/** QA lifecycle, Postman collection discovery/diff/approval, and Jira requirement pickers. */
const { route, HttpError, required } = require('../http');
const { repo, now, nextId, audit } = require('../db');
const { getProject } = require('./util');
const workflow = require('../engine/workflow');
const diffEngine = require('../engine/collection-diff');
const { postmanFor, salesforceFor } = require('../connectors');
const { generateSuite } = require('../engine/generator');

route('GET', '/api/workflow/steps', () => ({ steps: workflow.STEPS }));

route('GET', '/api/projects/:id/workflow', (ctx) => {
  const p = getProject(ctx.params.id);
  return workflow.getState(p);
});

route('PUT', '/api/projects/:id/workflow', (ctx) => {
  const p = getProject(ctx.params.id);
  const step = ctx.body && ctx.body.currentStep;
  if (!step) throw new HttpError(400, 'currentStep is required.');
  const state = workflow.visit(p, step);
  return state;
});

route('GET', '/api/projects/:id/jira/options', async (ctx) => {
  const p = getProject(ctx.params.id);
  const stories = repo.find('stories', 'projectId = $p', { p: p.id }, 'ORDER BY key');
  const epics = [...new Set(stories.filter((s) => /epic/i.test(s.issueType || '')).map((s) => s.key))];
  const types = [...new Set(stories.map((s) => s.issueType).filter(Boolean))];
  const sprints = [...new Set(stories.map((s) => s.sprint).filter(Boolean))];
  return {
    projectKey: p.jiraProjectKey,
    jiraUrl: p.jiraUrl,
    epics,
    issueTypes: types.length ? types : ['Story', 'Task', 'Bug', 'Epic'],
    sprints,
    stories: stories.map((s) => ({ key: s.key, summary: s.summary, issueType: s.issueType, status: s.status, sprint: s.sprint, priority: s.priority })),
  };
});

route('GET', '/api/projects/:id/postman/collections', async (ctx) => {
  const p = getProject(ctx.params.id);
  const pm = postmanFor(p);
  if (!pm.available) throw new HttpError(503, pm.unavailableExplanation().title, pm.unavailableExplanation());
  const query = {
    project: ctx.query.project, org: ctx.query.org, environment: ctx.query.environment,
    jiraProject: ctx.query.jiraProject, story: ctx.query.story, api: ctx.query.api, endpoint: ctx.query.endpoint,
  };
  const items = await pm.search(query);
  workflow.touch(p.id, 'postman', items.length ? 'in_progress' : 'not_started', { found: items.length });
  return {
    workspace: pm.settings.workspace || (p.mode === 'demo' ? 'Demo workspace' : null),
    environment: p.environment,
    source: pm.client.available ? 'mcp' : (p.mode === 'demo' ? 'demo' : 'local'),
    linkedCollectionId: pm.settings.collectionId || p.postmanCollection || null,
    reuseExisting: pm.settings.reuseExisting === true,
    items: items.map(({ _raw, ...rest }) => rest),
  };
});

route('GET', '/api/projects/:id/postman/collections/:uid', async (ctx) => {
  const p = getProject(ctx.params.id);
  const pm = postmanFor(p);
  const raw = await pm.getCollection(decodeURIComponent(ctx.params.uid));
  const tests = repo.find('test_cases', 'projectId = $p', { p: p.id }, 'ORDER BY seq');
  const comparison = diffEngine.diff(raw.collection, tests);
  const stored = pm.remember(raw, JSON.stringify(comparison.summary));
  return {
    collection: {
      id: stored.id,
      uid: raw.uid,
      name: raw.name,
      workspace: stored.workspace,
      environment: stored.environment,
      source: raw.source,
      lastUpdated: raw.updatedAt || stored.updatedAt,
      requestCount: comparison.summary.existing + comparison.summary.missing,
    },
    indexed: diffEngine.indexCollection(raw.collection),
    diff: comparison,
  };
});

route('POST', '/api/projects/:id/postman/analyze', async (ctx) => {
  const p = getProject(ctx.params.id);
  const b = ctx.body || {};
  const pm = postmanFor(p);
  const story = b.storyKey ? repo.one('stories', 'projectId = $p AND key = $k', { p: p.id, k: b.storyKey }) : null;
  let tests = repo.find('test_cases', b.storyKey ? 'projectId = $p AND storyKey = $k' : 'projectId = $p', b.storyKey ? { p: p.id, k: b.storyKey } : { p: p.id }, 'ORDER BY seq');
  if (!tests.length && story) {
    const generated = await generateSuite({ project: p, story, sf: salesforceFor(p) });
    tests = generated.scenarios.flatMap((s) => s.tests || []);
  }
  const discovered = await pm.search({
    project: p.name, org: p.sfOrg, environment: p.environment,
    jiraProject: p.jiraProjectKey, story: b.storyKey, api: b.api, endpoint: b.endpoint,
  });
  const linkedId = pm.settings.collectionId || p.postmanCollection;
  const best = (linkedId && discovered.find((c) => c.uid === linkedId))
    || discovered.find((c) => c.score > 0)
    || discovered[0];
  if (!best) {
    return {
      action: 'create',
      reason: 'No suitable Postman collection was found in the workspace. Use an existing collection from a file, or create a new one after approval.',
      folders: diffEngine.suggestedFolders(tests),
      tests: tests.length,
      discovered: [],
      linkedCollectionId: linkedId || null,
      reuseExisting: pm.settings.reuseExisting === true,
    };
  }
  const raw = best._raw;
  const comparison = diffEngine.diff(raw.collection, tests);
  const stored = pm.remember(raw, JSON.stringify(comparison.summary));
  const needsApproval = comparison.missing.length + comparison.changed.length > 0;
  return {
    action: needsApproval ? 'update' : 'reuse',
    collection: { id: stored.id, uid: raw.uid, name: raw.name, source: raw.source, workspace: stored.workspace, linked: Boolean(linkedId && raw.uid === linkedId) },
    diff: comparison,
    tests: tests.length,
    linkedCollectionId: linkedId || null,
    reuseExisting: pm.settings.reuseExisting === true,
    discovered: discovered.slice(0, 12).map(({ _raw, ...rest }) => rest),
  };
});

route('POST', '/api/projects/:id/postman/proposals', (ctx) => {
  const p = getProject(ctx.params.id);
  const b = ctx.body || {};
  required(b, ['diff']);
  const rec = {
    id: nextId('CP', 4),
    projectId: p.id,
    collectionId: b.collectionId || null,
    uid: b.uid || null,
    status: 'pending',
    diff: b.diff,
    collection: b.collection || null,
    createdBy: ctx.user,
    createdAt: now(),
  };
  repo.insert('collection_proposals', rec);
  workflow.touch(p.id, 'postman', 'requires_approval', { proposalId: rec.id });
  audit('postman', 'collection.proposed', { user: ctx.user, projectId: p.id, detail: { id: rec.id, uid: rec.uid } });
  return rec;
});

route('POST', '/api/projects/:id/postman/proposals/:pid/approve', async (ctx) => {
  const p = getProject(ctx.params.id);
  const rec = repo.get('collection_proposals', ctx.params.pid);
  if (!rec || rec.projectId !== p.id) throw new HttpError(404, `Collection proposal ${ctx.params.pid} not found.`);
  if (rec.status !== 'pending') throw new HttpError(409, `Proposal is already ${rec.status}.`);
  const stored = rec.collectionId ? repo.get('collections', rec.collectionId) : repo.one('collections', 'projectId = $p AND uid = $u', { p: p.id, u: rec.uid });
  const tests = repo.find('test_cases', 'projectId = $p', { p: p.id }, 'ORDER BY seq');
  let merged = stored && stored.content;
  if (merged && tests.length) merged = diffEngine.mergeApproved(merged, tests, ctx.body || {});
  if (stored && merged) repo.update('collections', stored.id, { content: merged, updatedAt: now(), lastSyncedAt: now() });
  repo.update('collection_proposals', rec.id, { status: 'approved', decidedAt: now(), decision: { approvedBy: ctx.user, at: now() } });
  if (stored) repo.update('projects', p.id, { postmanCollection: stored.uid || stored.id, updatedAt: now() });
  const pm = postmanFor(p);
  const sync = tests.length ? await pm.syncApproved(tests) : { ok: Boolean(stored), mcp: false };
  workflow.touch(p.id, 'postman', 'completed', { proposalId: rec.id, collectionId: stored && stored.id, mcp: sync.mcp });
  audit('postman', 'collection.approved', { user: ctx.user, projectId: p.id, detail: { id: rec.id, mcp: sync.mcp } });
  return { approved: true, collectionId: stored && stored.id, postman: sync };
});

route('POST', '/api/projects/:id/postman/proposals/:pid/reject', (ctx) => {
  const p = getProject(ctx.params.id);
  const rec = repo.get('collection_proposals', ctx.params.pid);
  if (!rec || rec.projectId !== p.id) throw new HttpError(404, `Collection proposal ${ctx.params.pid} not found.`);
  repo.update('collection_proposals', rec.id, { status: 'rejected', decidedAt: now(), decision: { rejectedBy: ctx.user, reason: (ctx.body && ctx.body.reason) || null } });
  workflow.touch(p.id, 'postman', 'in_progress', { proposalId: rec.id });
  return { rejected: true };
});

route('POST', '/api/projects/:id/postman/attach', async (ctx) => {
  const p = getProject(ctx.params.id);
  const b = ctx.body || {};
  const pm = postmanFor(p);
  try {
    const result = await pm.attachExisting({
      uid: b.uid || b.collectionId,
      collection: b.collection,
      importTests: b.importTests !== false,
      storyKey: b.storyKey,
    });
    workflow.touch(p.id, 'postman', 'completed', { collectionId: result.collectionId, reused: true, imported: result.imported });
    audit('postman', 'collection.attached', { user: ctx.user, projectId: p.id, detail: { uid: result.collectionId, imported: result.imported } });
    return result;
  } catch (e) {
    throw new HttpError(400, (e.explanation && e.explanation.title) || e.message, e.explanation || { action: 'Select a collection from Discover or import a Collection v2.1 file.' });
  }
});

route('POST', '/api/projects/:id/postman/create', async (ctx) => {
  const p = getProject(ctx.params.id);
  const tests = repo.find('test_cases', 'projectId = $p', { p: p.id }, 'ORDER BY seq');
  if (!tests.length) throw new HttpError(400, 'Generate and approve tests before creating a Postman collection.', { action: 'Open Test Generation, approve a proposal, then return here.' });
  const pm = postmanFor(p);
  const sync = await pm.syncApproved(tests);
  workflow.touch(p.id, 'postman', 'completed', { collectionId: sync.collectionId, created: true, mcp: sync.mcp });
  audit('postman', 'collection.created', { user: ctx.user, projectId: p.id, detail: { id: sync.collectionId, mcp: sync.mcp } });
  return {
    created: true,
    postman: sync,
    collection: { id: sync.collectionId, uid: sync.collectionId, name: sync.name, folders: diffEngine.suggestedFolders(tests), mcp: sync.mcp },
  };
});

module.exports = { workflow };
