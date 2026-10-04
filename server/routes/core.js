'use strict';
/** Health, metadata, projects, connections, discovery, global search and logs. */
const crypto = require('node:crypto');
const { route, HttpError, required } = require('../http');
const { repo, all, get, now, audit, nextId } = require('../db');
const { config, credentialStatus } = require('../config');
const { salesforceFor, jiraFor, metadataLabel } = require('../connectors');
const { getProject, paginate, likeFilter } = require('./util');
const ai = require('../engine/ai');

const ENVIRONMENTS = config.environments;
const PROJECT_FIELDS = ['name', 'description', 'sfOrg', 'environment', 'instanceUrl', 'apiVersion', 'mode', 'credentialRef', 'jiraProjectKey', 'jiraUrl', 'jiraCredentialRef', 'testDataConfig', 'integrationConfig', 'notificationConfig', 'businessConfig', 'postmanCollection', 'automationRepo', 'status'];

function validateProject(p, partial = false) {
  if (!partial) required(p, ['name', 'environment', 'apiVersion']);
  if (p.environment !== undefined && !ENVIRONMENTS.includes(p.environment)) throw new HttpError(400, `Environment must be one of: ${ENVIRONMENTS.join(', ')}.`);
  if (p.apiVersion !== undefined && !/^\d{2}\.0$/.test(String(p.apiVersion))) throw new HttpError(400, 'API version must look like 62.0.', { action: 'Use the version number shown in Setup → Apex Classes → Version, e.g. 62.0.' });
  if (p.instanceUrl && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(p.instanceUrl)) throw new HttpError(400, 'Instance URL must be an https:// origin, e.g. https://acme--qa.sandbox.my.salesforce.com', { action: 'Remove any path after the domain.' });
  if (p.jiraUrl && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(p.jiraUrl)) throw new HttpError(400, 'Jira URL must be an https:// origin, e.g. https://acme.atlassian.net');
  if (p.mode !== undefined && !['demo', 'live'].includes(p.mode)) throw new HttpError(400, 'Mode must be "demo" or "live".');
  if (p.credentialRef && !/^[A-Za-z0-9_]{1,40}$/.test(p.credentialRef)) throw new HttpError(400, 'Credential prefix may contain letters, digits and underscores only.');
  for (const k of Object.keys(p)) {
    if (/secret|password|token/i.test(k) || (typeof p[k] === 'string' && /^(00D[A-Za-z0-9]{12,15}!|ATATT)/.test(p[k]))) {
      throw new HttpError(400, 'Credentials must not be stored in project configuration.', { cause: `Field "${k}" looks like a secret.`, action: 'Put secrets in .env or your secret manager and reference them with a credential prefix.' });
    }
  }
}

function projectView(p) {
  const stats = get(`SELECT COUNT(*) AS tests FROM test_cases WHERE projectId = $p`, { p: p.id });
  const last = get(`SELECT id, startedAt, passed, failed, total, status FROM runs WHERE projectId = $p ORDER BY startedAt DESC LIMIT 1`, { p: p.id });
  const cs = credentialStatus(p.credentialRef, p.jiraCredentialRef);
  return {
    ...p,
    stats: { tests: stats.tests, lastRun: last || null, passRate: last && last.passed + last.failed ? Math.round((last.passed / (last.passed + last.failed)) * 1000) / 10 : null },
    connection: {
      salesforce: p.mode === 'demo' ? { status: 'demo', label: 'Demo org simulator' } : cs.salesforce.configured ? { status: 'configured', label: 'Credentials configured' } : { status: 'unavailable', label: require('../config').SF_UNAVAILABLE_MESSAGE },
      jira: p.mode === 'demo' ? { status: 'demo', label: 'Demo Jira' } : cs.jira.configured && p.jiraUrl ? { status: 'configured', label: 'Credentials configured' } : { status: 'unavailable', label: 'Jira is not configured — defects can be drafted but not created.' },
      metadataLabel: metadataLabel(p),
    },
  };
}

route('GET', '/api/health', () => ({ ok: true, version: config.version, time: now() }));

route('GET', '/api/meta', (ctx) => ({
  version: config.version, user: ctx.user, environments: ENVIRONMENTS, aiEnabled: ai.enabled(),
  apiTypes: ['REST', 'SOAP', 'Bulk API', 'Bulk API 2.0', 'Composite', 'Composite Graph', 'GraphQL', 'Tooling', 'Metadata', 'Connect REST', 'Apex REST', 'Apex SOAP', 'Platform Events', 'Change Data Capture', 'OAuth'],
  testTypes: ['Functional', 'Negative', 'Boundary', 'Security', 'Integration', 'Regression', 'Contract', 'Performance'],
  priorities: ['P0', 'P1', 'P2', 'P3'],
  modes: ['Discover', 'Generate', 'Execute', 'Validate', 'Analyze', 'Defect', 'Regression', 'Report'],
}));

// ── Projects ──
route('GET', '/api/projects', (ctx) => {
  const where = ctx.query.includeArchived === 'true' ? '' : "status != 'archived'";
  return repo.find('projects', where, {}, 'ORDER BY name').map(projectView);
});

route('POST', '/api/projects', (ctx) => {
  const b = ctx.body;
  validateProject(b);
  const p = { id: nextId('PRJ', 3), createdAt: now(), updatedAt: now(), status: 'active', mode: b.mode || 'live' };
  for (const f of PROJECT_FIELDS) if (b[f] !== undefined) p[f] = b[f];
  p.testDataConfig = p.testDataConfig || { autoCleanup: true, variables: {} };
  p.businessConfig = p.businessConfig || { slaMs: 2000 };
  repo.insert('projects', p);
  audit('project', 'project.created', { user: ctx.user, projectId: p.id, detail: { name: p.name, environment: p.environment } });
  return projectView(repo.get('projects', p.id));
});

route('GET', '/api/projects/:id', (ctx) => projectView(getProject(ctx.params.id)));

route('PUT', '/api/projects/:id', (ctx) => {
  const p = getProject(ctx.params.id);
  validateProject(ctx.body, true);
  const patch = { updatedAt: now() };
  for (const f of PROJECT_FIELDS) if (ctx.body[f] !== undefined) patch[f] = ctx.body[f];
  repo.update('projects', p.id, patch);
  audit('project', 'project.updated', { user: ctx.user, projectId: p.id, detail: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt') } });
  return projectView(repo.get('projects', p.id));
});

route('DELETE', '/api/projects/:id', (ctx) => {
  const p = getProject(ctx.params.id);
  repo.update('projects', p.id, { status: 'archived', updatedAt: now() });
  audit('project', 'project.archived', { user: ctx.user, projectId: p.id });
  return { archived: true };
});

route('GET', '/api/projects/:id/connection', (ctx) => {
  const p = getProject(ctx.params.id);
  return { mode: p.mode, credentials: credentialStatus(p.credentialRef, p.jiraCredentialRef), view: projectView(p).connection };
});

route('POST', '/api/projects/:id/connection/test', async (ctx) => {
  const p = getProject(ctx.params.id);
  const out = { salesforce: null, jira: null };
  const sf = salesforceFor(p);
  try {
    out.salesforce = sf.available ? await sf.testConnection() : { ok: false, ...sf.unavailableExplanation() };
  } catch (e) { out.salesforce = { ok: false, ...(e.explanation || { title: e.message }) }; }
  const jira = jiraFor(p);
  try {
    out.jira = jira.available ? await jira.testConnection() : { ok: false, ...jira.unavailableExplanation() };
  } catch (e) { out.jira = { ok: false, ...(e.explanation || { title: e.message }) }; }
  audit('project', 'connection.tested', { user: ctx.user, projectId: p.id, detail: { salesforce: out.salesforce.ok, jira: out.jira.ok } });
  return out;
});

// ── Discovery (Salesforce metadata) ──
const describeCache = new Map();
route('GET', '/api/projects/:id/sobjects', async (ctx) => {
  const p = getProject(ctx.params.id);
  const sf = salesforceFor(p);
  if (!sf.available) throw new HttpError(503, sf.unavailableExplanation().title, sf.unavailableExplanation());
  const key = `${p.id}:global`;
  const cached = describeCache.get(key);
  if (cached && cached.at > Date.now() - 10 * 60 * 1000 && ctx.query.refresh !== 'true') return cached.data;
  try {
    const list = await sf.describeGlobal();
    const data = { label: metadataLabel(p), source: p.mode === 'demo' ? 'Demo org simulator' : 'Live describeGlobal', objects: list };
    describeCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) { throw new HttpError(502, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
});

route('GET', '/api/projects/:id/sobjects/:name', async (ctx) => {
  const p = getProject(ctx.params.id);
  const sf = salesforceFor(p);
  if (!sf.available) throw new HttpError(503, sf.unavailableExplanation().title, sf.unavailableExplanation());
  const key = `${p.id}:${ctx.params.name}`;
  const cached = describeCache.get(key);
  if (cached && cached.at > Date.now() - 10 * 60 * 1000 && ctx.query.refresh !== 'true') return cached.data;
  try {
    const d = await sf.describe(ctx.params.name);
    const data = { label: metadataLabel(p), ...d };
    describeCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) { throw new HttpError(e.explanation && e.explanation.code === 'NOT_FOUND' ? 404 : 502, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
});

route('POST', '/api/projects/:id/soql', async (ctx) => {
  const p = getProject(ctx.params.id);
  const q = String(ctx.body.q || '').trim();
  if (!/^SELECT\s/i.test(q) || /;\s*\S/.test(q)) throw new HttpError(400, 'Only a single read-only SELECT statement is allowed.', { action: 'Write a SOQL SELECT query.' });
  const sf = salesforceFor(p);
  if (!sf.available) throw new HttpError(503, sf.unavailableExplanation().title, sf.unavailableExplanation());
  const t0 = Date.now();
  try {
    const res = await sf.query(q);
    audit('discovery', 'soql.executed', { user: ctx.user, projectId: p.id, detail: { q: q.slice(0, 300), rows: res.totalSize } });
    return { label: metadataLabel(p), ms: Date.now() - t0, ...res };
  } catch (e) { throw new HttpError(400, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
});

// ── Global search ──
route('GET', '/api/search', async (ctx) => {
  const q = String(ctx.query.q || '').trim();
  if (q.length < 2) return { query: q, groups: [] };
  const like = `%${q.slice(0, 80)}%`;
  const pid = ctx.query.projectId || null;
  const pf = pid ? 'AND projectId = $p' : '';
  const params = { q: like, p: pid };
  const groups = [
    { type: 'story', label: 'Jira stories', items: all(`SELECT key AS id, summary AS title, projectId, status AS meta FROM stories WHERE (key LIKE $q OR summary LIKE $q) ${pf} LIMIT 6`, params) },
    { type: 'testcase', label: 'Test cases', items: all(`SELECT id, title, projectId, priority || ' · ' || testType AS meta FROM test_cases WHERE (id LIKE $q OR title LIKE $q OR endpoint LIKE $q) ${pf} LIMIT 8`, params) },
    { type: 'run', label: 'Test runs', items: all(`SELECT id, COALESCE(label, 'Execution ' || id) AS title, projectId, status || ' · ' || startedAt AS meta FROM runs WHERE (id LIKE $q OR label LIKE $q) ${pf} LIMIT 5`, params) },
    { type: 'endpoint', label: 'APIs & endpoints', items: all(`SELECT MIN(id) AS id, method || ' ' || endpoint AS title, projectId, apiType AS meta FROM test_cases WHERE (endpoint LIKE $q OR apiType LIKE $q) ${pf} GROUP BY method, endpoint LIMIT 6`, params) },
    { type: 'defect', label: 'Defects', items: all(`SELECT id, COALESCE(key, id) || ' — ' || summary AS title, projectId, status || ' · ' || COALESCE(severity,'') AS meta, key FROM defects WHERE (key LIKE $q OR summary LIKE $q) ${pf} LIMIT 6`, params) },
    { type: 'request', label: 'Saved requests', items: all(`SELECT id, name AS title, projectId, method || ' ' || path AS meta FROM saved_requests WHERE (name LIKE $q OR path LIKE $q) ${pf} LIMIT 5`, params) },
  ];
  // Salesforce objects from cached describes (no live call on keystrokes)
  const objs = [];
  for (const [k, v] of describeCache) {
    if (!k.endsWith(':global') || (pid && !k.startsWith(pid + ':'))) continue;
    for (const o of v.data.objects) if (o.name.toLowerCase().includes(q.toLowerCase()) || (o.label || '').toLowerCase().includes(q.toLowerCase())) objs.push({ id: o.name, title: `${o.label} (${o.name})`, projectId: k.split(':')[0], meta: o.custom ? 'Custom object' : 'Standard object' });
  }
  if (!objs.length && pid) {
    try {
      const p = repo.get('projects', pid);
      if (p && p.mode === 'demo') {
        const list = await salesforceFor(p).describeGlobal();
        for (const o of list) if (o.name.toLowerCase().includes(q.toLowerCase()) || o.label.toLowerCase().includes(q.toLowerCase())) objs.push({ id: o.name, title: `${o.label} (${o.name})`, projectId: pid, meta: 'Demo org object' });
      }
    } catch { /* ignore */ }
  }
  groups.push({ type: 'sobject', label: 'Salesforce objects', items: objs.slice(0, 6) });
  return { query: q, groups: groups.filter((g) => g.items.length) };
});

// ── Observability ──
route('GET', '/api/audit', (ctx) => {
  const where = []; const params = {};
  if (ctx.query.projectId) { where.push('projectId = $p'); params.p = ctx.query.projectId; }
  if (ctx.query.category) { where.push('category = $c'); params.c = ctx.query.category; }
  likeFilter(where, params, ['action', 'detail', 'user'], ctx.query.q);
  return paginate('audit_log', ctx, { where, params, sortable: ['ts', 'category', 'user'], defaultSort: 'ts' });
});

module.exports = { projectView, describeCache };
