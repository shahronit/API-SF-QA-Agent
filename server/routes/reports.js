'use strict';
/** Dashboard, reports/exports, Postman/Newman and the agent command console. */
const fs = require('node:fs');
const path = require('node:path');
const { route, HttpError, raw } = require('../http');
const { repo, all, get, now, audit, nextId } = require('../db');
const { config } = require('../config');
const reports = require('../engine/reports');
const postman = require('../engine/postman');
const runner = require('../engine/runner');
const { salesforceFor, connectorFor, postmanFor } = require('../connectors');
const { generateSuite } = require('../engine/generator');
const { proposeSuite } = require('./stories');
const { summarise } = require('../engine/analyzer');
const { classifyStory } = require('../engine/classifier');
const { pickObject, buildAdHocTest } = require('../engine/adhoc');
const { prioritise } = require('../engine/priority');
const { compareRuns, flakyTests } = require('../engine/run-compare');
const { analyzeRunWithCli } = require('../engine/cli-generator');
const { projectFrom, getProject } = require('./util');
const { projectView, validateProject } = require('./core');
const { normalizeCollection, detectHints, matchProject, projectPayload } = require('../engine/collection-import');
const { parseEnvDoc, applyEnvironmentToProject } = require('../engine/env-apply');
const { selectTests, withDependencies } = require('./runs');
const { checkOperation, isProduction } = require('../engine/safety');

// ── Dashboard ──
function dashFilters(q) {
  const where = ['1=1']; const params = {};
  const add = (col, key, val) => {
    if (!val) return;
    const vals = String(val).split(',').filter(Boolean);
    where.push(`${col} IN (${vals.map((v, i) => { params[`${key}${i}`] = v; return `$${key}${i}`; }).join(',')})`);
  };
  add('rr.projectId', 'pid', q.projectId);
  add('r.environment', 'env', q.environment);
  add('rr.apiType', 'api', q.apiType);
  add('rr.testType', 'tt', q.testType);
  add('rr.priority', 'pr', q.priority);
  add('rr.status', 'st', q.status);
  add('p.sfOrg', 'org', q.sfOrg);
  add('p.jiraProjectKey', 'jp', q.jiraProjectKey);
  if (q.sprint) { params.sprint = q.sprint; where.push('rr.storyKey IN (SELECT key FROM stories WHERE sprint = $sprint)'); }
  if (q.from) { params.from = q.from; where.push('rr.startedAt >= $from'); }
  if (q.to) { params.to = q.to.length === 10 ? `${q.to}T23:59:59.999Z` : q.to; where.push('rr.startedAt <= $to'); }
  where.push("p.status != 'archived'");
  return { where: where.join(' AND '), params };
}

route('GET', '/api/dashboard', (ctx) => {
  const q = ctx.query;
  const { where, params } = dashFilters(q);
  const FROM = 'FROM run_results rr JOIN runs r ON r.id = rr.runId JOIN projects p ON p.id = rr.projectId';
  const totals = get(`SELECT COUNT(*) AS results, SUM(CASE WHEN rr.status='passed' THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN rr.status='failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN rr.status='blocked' THEN 1 ELSE 0 END) AS blocked, ROUND(AVG(rr.responseMs)) AS avgMs, COUNT(DISTINCT rr.runId) AS runs ${FROM} WHERE ${where}`, params);
  const projectWhere = q.projectId ? 'id = $pid0' : "status != 'archived'";
  const projectParams = q.projectId ? { pid0: String(q.projectId).split(',')[0] } : {};
  const projects = all(`SELECT id, name, status, environment FROM projects WHERE ${projectWhere}`, projectParams);
  const tcWhere = ['1=1']; const tcParams = {};
  if (q.projectId) { tcWhere.push('projectId = $p'); tcParams.p = String(q.projectId).split(',')[0]; } else tcWhere.push("projectId IN (SELECT id FROM projects WHERE status != 'archived')");
  for (const [col, key] of [['apiType', 'apiType'], ['testType', 'testType'], ['priority', 'priority']]) {
    if (q[key]) { const vals = String(q[key]).split(','); tcWhere.push(`${col} IN (${vals.map((v, i) => { tcParams[`${key}${i}`] = v; return `$${key}${i}`; }).join(',')})`); }
  }
  const apiTests = get(`SELECT COUNT(*) AS n FROM test_cases WHERE ${tcWhere.join(' AND ')}`, tcParams).n;
  const defWhere = q.projectId ? 'projectId = $p' : "projectId IN (SELECT id FROM projects WHERE status != 'archived')";
  const defP = q.projectId ? { p: String(q.projectId).split(',')[0] } : {};
  const openDefects = get(`SELECT COUNT(*) AS n FROM defects WHERE ${defWhere} AND status NOT IN ('Resolved','Closed','Done')`, defP).n;
  const criticalDefects = get(`SELECT COUNT(*) AS n FROM defects WHERE ${defWhere} AND status NOT IN ('Resolved','Closed','Done') AND severity = 'Critical'`, defP).n;
  const defectsBySeverity = all(`SELECT severity, COUNT(*) AS n FROM defects WHERE ${defWhere} AND status NOT IN ('Resolved','Closed','Done') GROUP BY severity`, defP);

  const trend = all(`SELECT substr(rr.startedAt, 1, 10) AS day, COUNT(*) AS executed, SUM(CASE WHEN rr.status='passed' THEN 1 ELSE 0 END) AS passed,
    SUM(CASE WHEN rr.status='failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN rr.status='blocked' THEN 1 ELSE 0 END) AS blocked,
    ROUND(AVG(rr.responseMs)) AS avgMs, MAX(rr.responseMs) AS maxMs, COUNT(DISTINCT rr.runId) AS runs ${FROM} WHERE ${where} GROUP BY day ORDER BY day DESC LIMIT 30`, params).reverse();
  const byProject = all(`SELECT p.id, p.name, COUNT(DISTINCT rr.testCaseId) AS tests, SUM(CASE WHEN rr.status='passed' THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN rr.status='failed' THEN 1 ELSE 0 END) AS failed ${FROM} WHERE ${where} GROUP BY p.id ORDER BY p.name`, params);
  const tcByProject = Object.fromEntries(all(`SELECT projectId, COUNT(*) AS n FROM test_cases GROUP BY projectId`).map((r) => [r.projectId, r.n]));
  const byType = all(`SELECT rr.testType AS type, COUNT(*) AS n, SUM(CASE WHEN rr.status='failed' THEN 1 ELSE 0 END) AS failed ${FROM} WHERE ${where} GROUP BY rr.testType ORDER BY n DESC`, params);

  const recentRuns = all(`SELECT r.id, r.projectId, p.name AS projectName, r.environment, r.status, r.startedAt, r.endedAt, r.total, r.passed, r.failed, r.blocked, r.skipped, r.avgResponseMs, r.user, r.trigger
    FROM runs r JOIN projects p ON p.id = r.projectId WHERE p.status != 'archived' ${q.projectId ? 'AND r.projectId = $p' : ''} ${q.environment ? 'AND r.environment = $env' : ''} ORDER BY r.startedAt DESC LIMIT 8`, { ...(q.projectId ? { p: String(q.projectId).split(',')[0] } : {}), ...(q.environment ? { env: String(q.environment).split(',')[0] } : {}) });

  // API health: endpoints whose latest result in the filtered window failed.
  const latestByEndpoint = all(`SELECT rr.method, rr.endpoint, rr.status FROM run_results rr JOIN runs r ON r.id = rr.runId JOIN projects p ON p.id = rr.projectId
    JOIN (SELECT testCaseId, MAX(rr.startedAt) AS m ${FROM} WHERE ${where} GROUP BY testCaseId) x ON x.testCaseId = rr.testCaseId AND x.m = rr.startedAt WHERE ${where}`, params);
  const eps = {};
  for (const r of latestByEndpoint) {
    const k = `${r.method} ${r.endpoint}`;
    eps[k] = eps[k] || { ok: true };
    if (r.status === 'failed') eps[k].ok = false;
  }
  const epCount = Object.keys(eps).length;
  const healthy = Object.values(eps).filter((e) => e.ok).length;
  const ribbonRun = recentRuns[0] ? all('SELECT seq, status, title, testCaseId FROM run_results WHERE runId = $r ORDER BY seq', { r: recentRuns[0].id }) : [];
  const executed = (totals.passed || 0) + (totals.failed || 0);
  return {
    filters: q,
    kpis: {
      totalProjects: projects.length, activeProjects: projects.filter((p) => p.status === 'active').length,
      apiTests, testRuns: totals.runs || 0, results: totals.results || 0,
      failed: totals.failed || 0,
      passRate: executed ? Math.round(((totals.passed || 0) / executed) * 1000) / 10 : null,
      failureRate: executed ? Math.round(((totals.failed || 0) / executed) * 1000) / 10 : null,
      blocked: totals.blocked || 0, openDefects, criticalDefects,
      apiHealth: epCount ? Math.round((healthy / epCount) * 1000) / 10 : null, endpoints: epCount, healthyEndpoints: healthy,
      avgResponseMs: totals.avgMs || null,
    },
    trend, defectsBySeverity, byType,
    testsByProject: byProject.map((x) => ({ ...x, totalTests: tcByProject[x.id] || 0 })),
    recentRuns, ribbon: { runId: recentRuns[0] ? recentRuns[0].id : null, cells: ribbonRun },
    filterOptions: {
      projects: all("SELECT id, name, environment, sfOrg, jiraProjectKey FROM projects WHERE status != 'archived' ORDER BY name"),
      sprints: all('SELECT DISTINCT sprint FROM stories WHERE sprint IS NOT NULL ORDER BY sprint').map((r) => r.sprint),
      orgs: all("SELECT DISTINCT sfOrg FROM projects WHERE sfOrg IS NOT NULL AND status != 'archived'").map((r) => r.sfOrg),
      jiraProjects: all("SELECT DISTINCT jiraProjectKey FROM projects WHERE jiraProjectKey IS NOT NULL AND status != 'archived'").map((r) => r.jiraProjectKey),
    },
  };
});

// ── Reports ──
const MIME = { csv: 'text/csv; charset=utf-8', html: 'text/html; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', json: 'application/json; charset=utf-8' };
route('GET', '/api/reports/:runId', (ctx) => {
  const d = reports.buildRunReport(ctx.params.runId);
  if (!d) throw new HttpError(404, `Execution ${ctx.params.runId} not found.`);
  const fmt = (ctx.query.format || 'json').toLowerCase();
  if (fmt === 'json') return d;
  if (!MIME[fmt]) throw new HttpError(400, 'format must be json, csv, html, xlsx or pdf.');
  const body = fmt === 'csv' ? reports.toCsv(d) : fmt === 'html' ? reports.toHtml(d) : fmt === 'xlsx' ? reports.toXlsx(d) : reports.toPdf(d);
  audit('report', 'report.exported', { user: ctx.user, detail: { runId: d.run.id, format: fmt } });
  const name = `qa-report-${d.run.id}.${fmt}`;
  const headers = { 'Content-Type': MIME[fmt], 'Content-Disposition': `${ctx.query.inline === 'true' && fmt === 'html' ? 'inline' : 'attachment'}; filename="${name}"` };
  if (fmt === 'html') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  return raw(body, headers);
});

// ── Postman / Newman ──
route('GET', '/api/postman/collection', (ctx) => {
  const p = projectFrom(ctx);
  const tests = selectTests(p, { testCaseIds: ctx.query.ids ? ctx.query.ids.split(',') : undefined, filter: { priority: ctx.query.priority ? ctx.query.priority.split(',') : undefined, testType: ctx.query.testType ? ctx.query.testType.split(',') : undefined } });
  const col = postman.exportCollection(p, tests);
  audit('automation', 'postman.exported', { user: ctx.user, projectId: p.id, detail: { tests: tests.length } });
  return raw(JSON.stringify(col, null, 2), { 'Content-Type': MIME.json, 'Content-Disposition': `attachment; filename="${p.id}.postman_collection.json"` });
});

route('GET', '/api/postman/environment', (ctx) => {
  const p = projectFrom(ctx);
  return raw(JSON.stringify(postman.exportEnvironment(p), null, 2), { 'Content-Type': MIME.json, 'Content-Disposition': `attachment; filename="${p.environment.toLowerCase()}.postman_environment.json"` });
});

function createProjectFromHints(hints, user) {
  const b = projectPayload(hints);
  validateProject(b);
  const p = { id: nextId('PRJ', 3), createdAt: now(), updatedAt: now(), status: 'active', mode: b.mode || 'live' };
  for (const f of ['name', 'description', 'sfOrg', 'environment', 'instanceUrl', 'apiVersion', 'mode', 'credentialRef', 'testDataConfig', 'integrationConfig', 'businessConfig']) {
    if (b[f] !== undefined) p[f] = b[f];
  }
  p.testDataConfig = p.testDataConfig || { autoCleanup: true, variables: {} };
  p.businessConfig = p.businessConfig || { slaMs: 2000 };
  repo.insert('projects', p);
  audit('project', 'project.created', { user, projectId: p.id, detail: { name: p.name, environment: p.environment, from: 'postman-import' } });
  return repo.get('projects', p.id);
}

route('POST', '/api/postman/import', async (ctx) => {
  let col = ctx.body && ctx.body.collection;
  let env = ctx.body && ctx.body.environment;
  if (typeof col === 'string') { try { col = JSON.parse(col); } catch (e) { throw new HttpError(400, `Collection is not valid JSON: ${e.message}`); } }
  if (typeof env === 'string') { try { env = JSON.parse(env); } catch (e) { throw new HttpError(400, `Environment is not valid JSON: ${e.message}`); } }
  let envDoc;
  if (env) {
    try { envDoc = parseEnvDoc(env); } catch (e) {
      throw new HttpError(400, e.message, { action: 'Export a Postman environment JSON ({ name, values }). Secrets are skipped.' });
    }
  }
  let normalized;
  let drafts;
  try {
    normalized = normalizeCollection(col);
    drafts = postman.importCollection(normalized);
  } catch (e) {
    throw new HttpError(400, e.message, { action: 'Export the collection from Postman (v1, v2, or v2.1 JSON). An environment file is optional.' });
  }
  const hints = detectHints(normalized, drafts, env);
  const projects = repo.find('projects', "status != 'archived'", {}, 'ORDER BY name');
  const matched = matchProject(hints, projects);
  const hinted = ctx.body && (ctx.body.projectId || ctx.query.projectId);
  const forceCurrent = Boolean(ctx.body && ctx.body.useCurrent);
  let p = null;
  let created = false;
  let reused = false;
  if (forceCurrent && hinted) {
    p = getProject(hinted);
    reused = true;
  } else if (matched.project) {
    p = matched.project;
    reused = true;
  } else if (hinted && !ctx.body.auto) {
    p = getProject(hinted);
    reused = true;
  }
  if (ctx.body.preview) {
    return {
      count: drafts.length,
      drafts: drafts.slice(0, 200),
      hints: {
        name: hints.name, environment: hints.environment, apiVersion: hints.apiVersion,
        instanceUrl: hints.instanceUrl, httpBaseUrl: hints.httpBaseUrl, sfOrg: hints.sfOrg,
        orgId: hints.orgId, kind: hints.kind, orgKind: hints.orgKind, needsBearer: hints.needsBearer,
      },
      match: p ? { id: p.id, name: p.name, environment: p.environment, score: matched.score } : null,
      action: p ? 'reuse' : 'create',
    };
  }
  if (!p) {
    p = createProjectFromHints(hints, ctx.user);
    created = true;
  }
  const pm = postmanFor(p);
  const attached = await pm.attachExisting({
    collection: normalized, importTests: ctx.body.importTests !== false, storyKey: ctx.body.storyKey,
    variables: hints.variables, hints,
  });
  let envApply = null;
  if (envDoc) {
    const ip = String((ctx.req.socket && ctx.req.socket.remoteAddress) || '');
    const loopback = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')
      && (config.host === '127.0.0.1' || config.host === 'localhost');
    envApply = applyEnvironmentToProject(repo.get('projects', p.id), envDoc, {
      user: ctx.user, fillEmptyOnly: ctx.body.overwrite !== true, loopback,
    });
  }
  audit('automation', 'postman.imported', { user: ctx.user, projectId: p.id, detail: { count: attached.imported, collection: normalized.info && normalized.info.name, collectionId: attached.collectionId, created, envApplied: Boolean(envApply) } });
  const workflow = require('../engine/workflow');
  workflow.touch(p.id, 'postman', 'completed', { imported: attached.imported, collectionId: attached.collectionId });
  if (attached.imported || attached.skipped) workflow.touch(p.id, 'execute', 'in_progress', { imported: attached.imported });
  const view = projectView(repo.get('projects', p.id));
  const { httpCredentials } = require('../config');
  const httpCreds = httpCredentials(((p.integrationConfig || {}).http || {}).credentialRef || p.credentialRef);
  const missingToken = Boolean(hints.needsBearer || attached.needsBearer) && !(httpCreds && httpCreds.token);
  const setupHref = (attached.missingHttp || missingToken) ? `/projects/${p.id}?tab=connection&focus=http` : null;
  const testsHref = '/testcases';
  return {
    imported: attached.imported,
    skipped: attached.skipped,
    ids: attached.testIds,
    executable: true,
    testsHref,
    setupHref,
    collectionId: attached.collectionId,
    reuseExisting: true,
    created,
    reused,
    project: view,
    httpBaseUrl: attached.httpBaseUrl || hints.httpBaseUrl || null,
    needsBearer: Boolean(attached.needsBearer || hints.needsBearer),
    missingHttp: Boolean(attached.missingHttp),
    missingToken,
    href: testsHref,
    hints: {
      name: hints.name, environment: hints.environment, apiVersion: hints.apiVersion,
      instanceUrl: hints.instanceUrl, httpBaseUrl: hints.httpBaseUrl, sfOrg: hints.sfOrg,
      orgId: hints.orgId, kind: hints.kind, needsBearer: hints.needsBearer,
    },
    environment: envApply ? {
      name: envApply.environment && envApply.environment.name,
      applied: envApply.applied,
      credentials: envApply.credentials,
      secretsSkipped: [],
      skippedKeys: [],
    } : null,
    notice: [
      created
        ? `Created project “${view.name}” from the collection and imported ${attached.imported} request(s) as runnable tests.`
        : `Using existing project “${view.name}”. ${attached.notice}`,
      attached.imported ? 'Open Tests to run them — imported cases do not need generate/approve.' : '',
      envApply && envApply.applied.length ? `Environment: ${envApply.applied.join('; ')}.` : '',
    ].filter(Boolean).join(' '),
  };
});

route('POST', '/api/postman/newman', async (ctx) => {
  const p = projectFrom(ctx);
  const dir = path.join(config.root, 'api-tests');
  const tests = selectTests(p, { filter: ctx.body.filter || {} });
  if (isProduction(p) && tests.some((t) => checkOperation(p, t, {})) && !ctx.body.confirmProductionWrites) {
    throw new HttpError(409, 'This operation will modify Salesforce production data.', { action: 'Filter to read-only tests or confirm production writes.' });
  }
  fs.mkdirSync(path.join(dir, 'collections'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'environments'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  const colFile = path.join(dir, 'collections', `${p.id}.postman_collection.json`);
  const envFile = path.join(dir, 'environments', `${p.id}.${p.environment.toLowerCase()}.postman_environment.json`);
  fs.writeFileSync(colFile, JSON.stringify(postman.exportCollection(p, tests), null, 2));
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, JSON.stringify(postman.exportEnvironment(p), null, 2));
  audit('automation', 'newman.started', { user: ctx.user, projectId: p.id, detail: { tests: tests.length } });
  const result = await postman.runNewman(colFile, envFile);
  return { ...result, collection: path.relative(config.root, colFile), environment: path.relative(config.root, envFile), note: 'Newman reads credentials from the environment file or CI secrets — fill clientId/clientSecret locally (never commit them).' };
});

// ── Agent command console ──
const MODE_HELP = {
  Discover: 'Discover Salesforce objects, fields, relationships, APIs and Jira requirements.',
  Generate: 'Generate API test scenarios from a Jira story (rule engine + optional Cursor/Gemini CLI). Review and approve before they become executable.',
  Execute: 'Execute approved Salesforce, Experience/B2B, SFCC, or frontend HTTP tests against the live connector.',
  Validate: 'Re-query Salesforce records after writes and compare persisted fields.',
  Analyze: 'Rule-based failure categories (ASSUMED until you confirm). Uses Cursor/Gemini CLI for extra notes if logged in.',
  Defect: 'Draft Jira defects for review (never auto-created).',
  Regression: 'Identify and execute impacted regression tests.',
  Report: 'Generate QA reports.',
};
const AGENT_NOT = 'This assistant is a command bar, not an LLM that freely designs tests. It matches phrases (analyze STORY-1, run P0, test creating a Contact, GET https://…). Generation is a Jira + describe rule engine; Cursor/Gemini only add proposals if you are logged in. Pass/fail comes from the HTTP runner after you approve tests.';

route('POST', '/api/agent/command', async (ctx) => {
  const text = String(ctx.body.text || '').trim();
  if (!text) throw new HttpError(400, 'Type a command, e.g. "Run only P0 and P1 tests".');
  let p = ctx.body.projectId ? getProject(ctx.body.projectId) : null;
  const envMatch = text.match(/\bin (Development|QA|SIT|UAT|Pre-Production|Production)\b/i);
  if (envMatch) {
    const alt = all("SELECT * FROM projects WHERE lower(environment) = lower($e) AND status != 'archived' ORDER BY (id = $cur) DESC", { e: envMatch[1], cur: p ? p.id : '' })[0];
    if (alt) p = repo.get('projects', alt.id);
  }
  if (!p) throw new HttpError(400, 'Select a project first (top bar), or include the environment, e.g. "in QA".');
  const lower = text.toLowerCase();
  const storyKey = (text.match(/\b([A-Z][A-Z0-9_]+-\d+)\b/) || [])[1];
  const objMatch = (text.match(/\b(Account|Contact|Lead|Opportunity|Case|[A-Z]\w+__c)\b/) || [])[1];
  const lastRun = get("SELECT * FROM runs WHERE projectId = $p AND status IN ('completed','stopped') ORDER BY startedAt DESC LIMIT 1", { p: p.id });
  const reply = (mode, message, extra = {}) => { audit('agent', `command.${mode.toLowerCase()}`, { user: ctx.user, projectId: p.id, detail: { text: text.slice(0, 200) } }); return { mode, modeDescription: MODE_HELP[mode], projectId: p.id, message, ...extra }; };

  if (/\b(help|what can you do|commands|what are you)\b/.test(lower)) {
    return reply('Discover', AGENT_NOT, { modes: MODE_HELP, examples: ['Analyze Jira story DEMO-101 and generate Salesforce API test cases.', 'Plan DEMO-101 from docs', 'GET https://httpbin.org/status/200', 'Run frontend HTTP tests.', 'Discover all APIs related to Contact.', 'Generate negative tests for the Account API.', 'Run the Account API regression suite in QA.', 'Validate the API response against Salesforce.', 'Analyze failed tests from the latest execution.', 'Create Jira defects for confirmed failures.', 'Show me APIs with failure rate above 10%.', 'Generate a Postman collection for this API.', 'Generate Newman automation.', 'Run only P0 and P1 tests.', 'Compare the latest run with the previous run.', 'Show flaky tests.', 'Generate the QA execution report.'] });
  }
  if (storyKey && /(analy[sz]e|generate|plan)/.test(lower)) {
    const story = repo.one('stories', 'projectId = $p AND key = $k', { p: p.id, k: storyKey });
    if (!story) throw new HttpError(404, `Story ${storyKey} is not in ${p.name}. Sync stories from Jira first.`, { action: 'Open Jira stories and click "Sync from Jira".' });
    const cls = classifyStory(story);
    if (!cls.needsApiTesting && cls.confidence === 'high' && !/\b(anyway|force|still)\b/.test(lower)) {
      return reply('Discover', `${storyKey} does not look like it needs API testing: ${cls.reasons.join(' ')} Say "Analyze ${storyKey} anyway" if you want scenarios proposed regardless.`, { data: { classification: cls }, examples: [`Analyze ${storyKey} anyway`] });
    }
    const fromDocs = /from (the )?docs|plan[- ]from[- ]docs/.test(lower);
    const fromJiraOnly = /from (the )?jira|jira tickets? only|ticket only/.test(lower);
    const inputSource = fromDocs && !fromJiraOnly && !/jira/.test(lower) ? 'docs' : fromJiraOnly ? 'jira' : fromDocs ? 'jira+docs' : 'jira';
    const docIds = inputSource === 'jira' ? [] : (fromDocs || inputSource === 'jira+docs' ? repo.find('context_docs', 'projectId = $p', { p: p.id }).map((d) => d.id) : ctx.body.docIds);
    const proposal = await proposeSuite(p, story, ctx.user, { docIds, inputSource });
    const analysis = proposal.analysis || {};
    const scenarios = proposal.scenarios || [];
    const n = scenarios.reduce((s, x) => s + x.testCases.length, 0);
    const tr = analysis.traceability || {};
    if (n === 0) {
      const why = (analysis.objects || []).length ? `Objects found (${analysis.objects.join(', ')}) but no testable operations or API types were detected.` : 'No Salesforce object or API type could be identified in the story.';
      return reply('Generate', `Analysed ${storyKey} but could not propose any test cases. ${why} ${(analysis.notes || []).map((x) => x.text).join(' ')} Name the object and the operation (for example "create a Contact via REST") in the story or ask: "Generate negative tests for the Account API".`.replace(/\s+/g, ' ').trim(), { data: { classification: cls, gaps: analysis.gaps } });
    }
    const clsNote = cls.needsApiTesting ? '' : ' Note: this ticket may not need API testing — review carefully before approving.';
    const via = tr.generator && tr.generator !== 'engine' ? ` via ${tr.generator}` : (tr.fallback ? ' via built-in engine (CLI fallback)' : '');
    const metrics = tr.acMappedPct != null ? ` AC mapped ${tr.acMappedPct}%.` : '';
    const usedDocs = (analysis.docsUsed || []).map((d) => d.name).filter(Boolean);
    const context = usedDocs.length
      ? `${inputSource === 'docs' ? 'Context: integration docs only' : 'Context: this Jira ticket plus'} ${usedDocs.length} doc(s) (${usedDocs.slice(0, 3).join(', ')}).`
      : `Context: this Jira ticket only${repo.find('context_docs', 'projectId = $p', { p: p.id }).length ? ` — say "Plan ${storyKey} from docs" to include the project's integration docs` : ''}.`;
    return reply('Generate', `Analysed ${storyKey}: ${(analysis.objects || []).join(', ') || 'no objects'} · operations ${(analysis.operations || []).join(', ') || 'none detected'}. Proposed ${scenarios.length} scenarios / ${n} test cases (metadata ${analysis.metadataLabel}${via}).${metrics}${clsNote} ${context} Review and approve before anything is saved or sent to Jira.`, { navigate: `/stories/${storyKey}?proposal=${proposal.id}`, proposalId: proposal.id, data: { classification: cls, traceability: tr } });
  }
  if (/\bflaky\b|\bunstable\b/.test(lower)) {
    const items = flakyTests(p.id, { window: 5 });
    return reply('Analyze', items.length
      ? `${items.length} test(s) flipped between pass and fail across the last 5 runs: ${items.slice(0, 5).map((x) => `${x.testCaseId} (${x.history.join('→')})`).join(', ')}. Treat their failures as unconfirmed until they fail consistently.`
      : 'No flaky tests: no test flipped between pass and fail more than once across the last 5 runs.', { data: { flaky: items } });
  }
  if (/\b(compare|diff|regressed|what changed|since last)\b/.test(lower)) {
    if (!lastRun) return reply('Analyze', 'No completed execution yet.');
    const runIds = text.match(/\bEX-\d{8}-[A-F0-9]{6}\b/g) || [];
    const cmp = compareRuns(runIds[0] || lastRun.id, runIds[1] || 'previous');
    if (!cmp) return reply('Analyze', `Execution ${runIds[0]} not found.`);
    return reply('Analyze', `${cmp.message}${cmp.newlyFailing.length ? ` Newly failing: ${cmp.newlyFailing.slice(0, 5).map((x) => x.testCaseId).join(', ')}.` : ''}${cmp.fixed.length ? ` Fixed: ${cmp.fixed.slice(0, 5).map((x) => x.testCaseId).join(', ')}.` : ''}`, { navigate: `/execution/${cmp.run.id}?tab=analysis`, data: cmp });
  }
  if (/\bdiscover\b/.test(lower)) {
    const sf = salesforceFor(p);
    if (!sf.available) return reply('Discover', sf.unavailableExplanation().evidence[0], { explanation: sf.unavailableExplanation() });
    if (objMatch) {
      const d = await sf.describe(objMatch).catch((e) => { throw new HttpError(404, e.explanation ? e.explanation.title : e.message, e.explanation || {}); });
      const endpoints = all('SELECT DISTINCT method, endpoint, apiType FROM test_cases WHERE projectId = $p AND (object = $o OR endpoint LIKE $l) ORDER BY endpoint LIMIT 40', { p: p.id, o: objMatch, l: `%${objMatch}%` });
      const v = `/services/data/v${p.apiVersion}`;
      const apis = [
        { method: 'GET', path: `${v}/sobjects/${d.name}/describe`, api: 'REST' }, { method: 'POST', path: `${v}/sobjects/${d.name}`, api: 'REST' },
        { method: 'GET|PATCH|DELETE', path: `${v}/sobjects/${d.name}/{id}`, api: 'REST' }, { method: 'GET', path: `${v}/query?q=SELECT … FROM ${d.name}`, api: 'REST' },
        { method: 'POST', path: `${v}/composite/sobjects`, api: 'Composite' }, { method: 'POST', path: `${v}/jobs/ingest (object=${d.name})`, api: 'Bulk API 2.0' },
        { method: 'POST', path: `${v}/graphql (uiapi.query.${d.name})`, api: 'GraphQL' },
        ...d.fields.filter((f) => f.externalId).map((f) => ({ method: 'PATCH', path: `${v}/sobjects/${d.name}/${f.name}/{value}`, api: 'REST (upsert)' })),
      ];
      return reply('Discover', `${d.label} (${d.name}): ${d.fields.length} fields, ${d.fields.filter((f) => f.required).length} required, ${(d.childRelationships || []).length} child relationships. Metadata label: ${p.mode === 'demo' ? 'ASSUMED (demo org)' : 'VERIFIED (live describe)'}.`, { navigate: `/explorer?object=${d.name}`, data: { apis, existingTests: endpoints, requiredFields: d.fields.filter((f) => f.required).map((f) => f.name), relationships: d.childRelationships } });
    }
    const list = await sf.describeGlobal();
    return reply('Discover', `${list.length} objects available. Name an object (e.g. "Discover all APIs related to Contact") for details.`, { data: { objects: list.slice(0, 50) } });
  }
  if (/generate/.test(lower) && /(negative|boundary|security|positive|functional|integration)/.test(lower) && objMatch) {
    const type = lower.includes('negative') ? 'Negative' : lower.includes('boundary') ? 'Boundary' : lower.includes('security') ? 'Security' : lower.includes('integration') ? 'Integration' : 'Functional';
    const story = { key: `${p.jiraProjectKey || 'ADHOC'}-0`, summary: `${objMatch} API ${type.toLowerCase()} coverage`, description: `Create, update and query ${objMatch} records through the Salesforce API. Invalid input must be rejected.`, acceptanceCriteria: '' };
    const { analysis, scenarios } = await generateSuite({ project: p, story, sf: salesforceFor(p) });
    const filtered = scenarios.filter((s) => s.type === type);
    if (!filtered.length) {
      return reply('Generate', `No ${type} tests could be generated for ${objMatch}${p.environment === 'Production' ? ' — Production projects only receive read-only coverage' : ''}. Available scenario types for this object: ${[...new Set(scenarios.map((s) => s.type))].join(', ') || 'none'}.`, { data: { gaps: analysis.gaps } });
    }
    const proposal = { id: nextId('GEN', 4), projectId: p.id, storyKey: 'AD-HOC', status: 'proposed', analysis: { ...analysis, storyKey: 'AD-HOC', summary: story.summary }, scenarios: filtered, createdBy: ctx.user, createdAt: now() };
    repo.insert('proposals', proposal);
    return reply('Generate', `Proposed ${filtered.reduce((n, s) => n + s.testCases.length, 0)} ${type} tests for ${objMatch} (metadata ${analysis.metadataLabel}). Review and approve to add them.`, { navigate: `/generate/${proposal.id}`, proposalId: proposal.id });
  }
  const httpUrl = text.match(/\bhttps?:\/\/[^\s]+/i);
  if (httpUrl && !/salesforce\.com|force\.com/i.test(httpUrl[0])) {
    const method = ((text.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD)\b/i) || [])[1] || 'GET').toUpperCase();
    const pathUrl = httpUrl[0].replace(/[.,;)]+$/, '');
    const draft = {
      title: `${method} ${pathUrl}`, method, endpoint: pathUrl, apiType: 'HTTP', auth: 'default',
      headers: {}, query: {}, body: null, assertions: [{ type: 'status', op: 'lt', expected: 500 }],
      extract: [], tags: ['frontend', 'chat-generated'], testType: 'Functional',
    };
    const safety = checkOperation(p, { method: draft.method, path: draft.endpoint, body: draft.body }, { confirmProductionWrites: ctx.body.confirmProductionWrites, confirmDelete: ctx.body.confirmDelete });
    if (safety) throw new HttpError(409, safety.title, safety);
    const conn = connectorFor(p, draft);
    if (!conn.available && !/^https?:\/\//i.test(draft.endpoint)) throw new HttpError(503, conn.unavailableExplanation().title, conn.unavailableExplanation());
    const pr = prioritise({ ...draft }, { project: p });
    const tcId = nextId('TC', 5);
    const seq = (get('SELECT MAX(seq) AS m FROM test_cases WHERE projectId = $p', { p: p.id }).m || 0) + 10;
    repo.insert('test_cases', {
      id: tcId, projectId: p.id, scenarioId: null, storyKey: null, seq,
      title: draft.title, description: 'Generated from an agent chat HTTP URL — executed against the live origin.',
      apiType: 'HTTP', method: draft.method, endpoint: draft.endpoint, auth: draft.auth,
      headers: {}, query: {}, body: null, bodyRaw: null, assertions: draft.assertions, extract: [],
      sfValidation: null, cleanup: null, timeoutMs: null, object: null, testType: 'Functional',
      priority: pr.priority, priorityReason: pr, status: 'ready', label: 'ASSUMED', tags: draft.tags, automated: 1, createdAt: now(), updatedAt: now(),
    });
    const run = runner.startRun({ project: p, testCases: [repo.get('test_cases', tcId)], user: ctx.user, options: { label: `Chat HTTP: ${pathUrl.slice(0, 60)}`, trigger: 'agent-chat' } });
    await runner.waitForRun(run.id);
    const resultRow = repo.find('run_results', 'runId = $r', { r: run.id })[0];
    return reply('Execute', `Ran ${method} ${pathUrl} in ${p.environment}: ${resultRow.status}${resultRow.statusCode ? ` (HTTP ${resultRow.statusCode})` : ''}. Saved as ${tcId}. This is a real HTTP call, not a Salesforce simulator.`, {
      navigate: `/testcases?id=${tcId}`, exchange: { ...resultRow, testCase: { id: tcId, title: draft.title, label: 'ASSUMED' } },
    });
  }
  if (/\b(test|try|check|verify|simulate)\b/i.test(lower) && !/\bgenerate\b/.test(lower)) {
    const sf = salesforceFor(p);
    if (!sf.available) return reply('Discover', sf.unavailableExplanation().evidence[0], { explanation: sf.unavailableExplanation() });
    let catalog;
    try { catalog = await sf.describeGlobal(); } catch (e) { throw new HttpError(502, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
    const objectName = (objMatch && catalog.some((o) => o.name === objMatch)) ? objMatch : pickObject(text, catalog);
    if (!objectName) {
      return reply('Discover', 'I could not tell which Salesforce object to test. Name one, e.g. "Test creating a Contact without a LastName".', { data: { objects: catalog.slice(0, 20) } });
    }
    let describe;
    try { describe = await sf.describe(objectName); } catch (e) { throw new HttpError(404, e.explanation ? e.explanation.title : e.message, e.explanation || {}); }
    const draft = buildAdHocTest({ describe, objectName, text });
    const safety = checkOperation(p, { method: draft.method, path: draft.endpoint, body: draft.body }, { confirmProductionWrites: ctx.body.confirmProductionWrites, confirmDelete: ctx.body.confirmDelete });
    if (safety) throw new HttpError(409, safety.title, safety);
    const pr = prioritise({ ...draft, apiType: draft.endpoint.includes('/composite/') ? 'Composite' : 'REST' }, { project: p });
    const tcId = nextId('TC', 5);
    const seq = (get('SELECT MAX(seq) AS m FROM test_cases WHERE projectId = $p', { p: p.id }).m || 0) + 10;
    repo.insert('test_cases', {
      id: tcId, projectId: p.id, scenarioId: null, storyKey: null, seq,
      title: draft.title, description: draft.notes.length ? draft.notes.join(' ') : 'Generated from an agent chat scenario.',
      apiType: draft.endpoint.includes('/composite/') ? 'Composite' : 'REST', method: draft.method, endpoint: draft.endpoint, auth: draft.auth || 'default',
      headers: {}, query: draft.query || {}, body: draft.body === undefined ? null : draft.body, bodyRaw: null,
      assertions: draft.assertions, extract: draft.extract || [], sfValidation: draft.sfValidation || null, cleanup: draft.cleanup || null,
      timeoutMs: null, object: draft.object, testType: draft.testType, priority: pr.priority, priorityReason: pr,
      status: 'ready', label: 'ASSUMED', tags: ['chat-generated'], automated: 1, createdAt: now(), updatedAt: now(),
    });
    audit('generation', 'adhoc.scenario-created', { user: ctx.user, projectId: p.id, detail: { testCaseId: tcId, text: text.slice(0, 200) } });
    const run = runner.startRun({ project: p, testCases: [repo.get('test_cases', tcId)], user: ctx.user, options: { confirmProductionWrites: ctx.body.confirmProductionWrites, confirmDelete: ctx.body.confirmDelete, label: `Chat scenario: ${text.slice(0, 60)}`, trigger: 'agent-chat' } });
    await runner.waitForRun(run.id);
    const resultRow = repo.find('run_results', 'runId = $r', { r: run.id })[0];
    const testCase = repo.get('test_cases', tcId);
    const exchange = { ...resultRow, testCase: { id: testCase.id, title: testCase.title, storyKey: null, scenarioId: null, label: testCase.label } };
    const noteText = draft.notes.length ? ` (${draft.notes.join(' ')})` : '';
    const statusWord = resultRow.status === 'passed' ? 'passed' : resultRow.status === 'failed' ? 'failed' : resultRow.status;
    const candidates = resultRow.status === 'failed' && resultRow.analysis && resultRow.analysis.defectCandidate && !resultRow.defectKey
      ? [{ resultId: resultRow.id, title: resultRow.title, rootCause: resultRow.analysis.rootCause }] : undefined;
    return reply('Execute', `Ran "${draft.title}" against ${objectName} in ${p.environment}: ${statusWord}${resultRow.statusCode ? ` (HTTP ${resultRow.statusCode})` : ''}.${noteText} Saved as test case ${tcId} (tag: chat-generated) for reuse.`, {
      navigate: `/testcases?id=${tcId}`, exchange, data: candidates ? { candidates } : undefined,
    });
  }
  if (/\b(run|execute)\b/.test(lower)) {
    const body = { filter: {} };
    const prios = (text.match(/\bP[0-3]\b/g) || []);
    if (prios.length) body.filter.priority = [...new Set(prios)];
    if (/regression/.test(lower)) body.filter.tag = 'regression';
    if (/failed/.test(lower)) { body.filter.lastResult = ['failed', 'blocked']; }
    if (/\bfrontend\b|\bhttp\b|\bpostman\b/.test(lower) && !/\bhelp\b/.test(lower)) body.filter.apiType = ['HTTP', 'OCAPI', 'SCAPI'];
    let tests = selectTests(p, body);
    if (objMatch) tests = tests.filter((t) => t.object === objMatch || t.endpoint.includes(objMatch));
    if (!tests.length) return reply('Execute', 'No executable tests match that request.', {});
    tests = withDependencies(p, tests);
    if (isProduction(p) && tests.some((t) => checkOperation(p, t, {}))) {
      return reply('Execute', 'This operation will modify Salesforce production data. Open Test execution to confirm production writes explicitly, or run read-only tests only.', { navigate: '/execution', requiresConfirmation: true });
    }
    const run = runner.startRun({ project: p, testCases: tests, user: ctx.user, options: { label: text.slice(0, 80), trigger: 'agent', filter: body.filter } });
    return reply(/regression/.test(lower) ? 'Regression' : 'Execute', `Started ${run.id} in ${p.environment} with ${tests.length} test(s)${objMatch ? ` for ${objMatch}` : ''}${prios.length ? ` (${prios.join(', ')})` : ''}. Upstream setup tests were included automatically.`, { navigate: `/execution/${run.id}`, runId: run.id });
  }
  if (/\bvalidat/.test(lower)) {
    if (!lastRun) return reply('Validate', 'No completed execution yet. Run tests first.');
    const rows = repo.find('run_results', 'runId = $r AND sfValidation IS NOT NULL', { r: lastRun.id });
    const fails = rows.filter((r) => r.sfValidation.status !== 'PASS');
    return reply('Validate', `${lastRun.id}: ${rows.length} Salesforce data validations, ${rows.length - fails.length} passed, ${fails.length} with differences. Provenance: ${p.mode === 'demo' ? 'ASSUMED (demo org)' : 'VERIFIED (live org)'}.`, { navigate: `/execution/${lastRun.id}?status=failed`, data: { mismatches: fails.map((r) => ({ resultId: r.id, title: r.title, object: r.sfValidation.object, recordId: r.sfValidation.recordId, diffs: (r.sfValidation.comparisons || []).filter((c) => !c.match) })) } });
  }
  if (/defect/.test(lower)) {
    if (!lastRun) return reply('Defect', 'No completed execution yet.');
    const rows = repo.find('run_results', "runId = $r AND status = 'failed'", { r: lastRun.id });
    const cands = rows.filter((r) => r.analysis && r.analysis.defectCandidate && !r.defectKey);
    return reply('Defect', `${cands.length} confirmed failure(s) in ${lastRun.id} look like product defects. Open each preview, review the masked content, then click "Create Jira defect" — nothing is created automatically.`, { navigate: `/execution/${lastRun.id}?status=failed`, data: { candidates: cands.map((r) => ({ resultId: r.id, title: r.title, rootCause: r.analysis.rootCause })) } });
  }
  if (/analy[sz]e|root cause|why.*fail/.test(lower)) {
    if (!lastRun) return reply('Analyze', 'No completed execution yet.');
    const rows = repo.find('run_results', 'runId = $r', { r: lastRun.id });
    const s = summarise(rows);
    const cli = await analyzeRunWithCli(p, lastRun, rows.filter((r) => r.status === 'failed')).catch(() => null);
    const extra = cli && cli.notes && cli.notes.length ? ` ${cli.source} notes: ${cli.notes.join(' ')}` : '';
    return reply('Analyze', `${lastRun.id}: ${lastRun.failed} failed, ${lastRun.blocked} blocked. ${s.categories.map((c) => `${c.category}: ${c.count}`).join(' · ') || 'No failures.'} Root causes are ASSUMED until confirmed.${extra} ${AGENT_NOT}`, { navigate: `/execution/${lastRun.id}?tab=analysis`, data: { ...s, cli } });
  }
  if (/failure rate|failing apis|apis with/.test(lower)) {
    const thr = Number((lower.match(/(\d+)\s*%/) || [])[1] || 10);
    const rows = all(`SELECT method, endpoint, COUNT(*) AS runs, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM run_results WHERE projectId = $p GROUP BY method, endpoint`, { p: p.id })
      .map((r) => ({ ...r, failureRate: Math.round((r.failed / r.runs) * 1000) / 10 })).filter((r) => r.failureRate > thr).sort((a, b) => b.failureRate - a.failureRate);
    return reply('Analyze', `${rows.length} endpoint(s) have a failure rate above ${thr}%.`, { data: { endpoints: rows }, navigate: `/insights?failureRate=${thr}` });
  }
  if (/postman/.test(lower)) return reply('Generate', 'Postman collection ready. It uses {{baseUrl}}, {{accessToken}}, {{clientId}} and {{clientSecret}} variables — no secrets are included.', { download: `/api/postman/collection?projectId=${p.id}`, navigate: '/automation' });
  if (/newman|automation|ci\b|pipeline/.test(lower)) return reply('Generate', 'Newman automation: export the collection + environment, then run `npm install && npm run test:qa` inside api-tests/. The GitHub Actions workflow in .github/workflows/api-tests.yml injects credentials from repository secrets.', { navigate: '/automation' });
  if (/report/.test(lower)) {
    if (!lastRun) return reply('Report', 'No completed execution yet.');
    return reply('Report', `Execution report for ${lastRun.id} is ready in PDF, Excel, CSV and HTML.`, { navigate: `/reports?run=${lastRun.id}`, downloads: ['pdf', 'xlsx', 'csv', 'html'].map((f) => ({ format: f, url: `/api/reports/${lastRun.id}?format=${f}` })) });
  }
  if (/regression|impact/.test(lower)) {
    return reply('Regression', 'Open Regression to pick the changed objects or story; impacted tests are ranked by priority.', { navigate: '/regression' });
  }
  return reply('Discover', `${AGENT_NOT} Type "help" for commands, paste an https URL to run it, or "Analyze PROJ-123" after syncing Jira.`, { examples: ['help', 'GET https://httpbin.org/get', 'Run only P0 and P1 tests', 'Run frontend HTTP tests'] });
});
