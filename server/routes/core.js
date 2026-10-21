'use strict';
/** Health, metadata, projects, connections, discovery, global search and logs. */
const crypto = require('node:crypto');
const path = require('node:path');
const { route, HttpError, required } = require('../http');
const { repo, all, get, now, audit, nextId } = require('../db');
const { config, credentialStatus, salesforceCredentials, salesforceMcpSettings, commerceCredentials, normRef, secretValues } = require('../config');
const { salesforceFor, jiraFor, commerceFor, commerceEnabled, metadataLabel, postmanFor, httpFor, cursorFor, geminiFor } = require('../connectors');
const { detectCursorBin } = require('../connectors/cursor-cli');
const { detectGeminiBin } = require('../connectors/gemini-cli');
const { SalesforceCliAdapter, orgAlias } = require('../connectors/salesforce-cli');
const { classifyLoginUrl, normalizeLoginUrl, publicDetection } = require('../connectors/salesforce-org');
const { detectFromConnector, autoConnectPatch } = require('../engine/salesforce-detect');
const { scriptGeneratorPref, safeLocalPath, readLocalDocFile, looksLikeSecretText } = require('../engine/cli-generator');
const workflow = require('../engine/workflow');
const { upsertEnv } = require('../lib/dotenv-write');
const { registerSecrets } = require('../lib/mask');
const { getProject, paginate, likeFilter } = require('./util');
const ai = require('../engine/ai');

const ENVIRONMENTS = config.environments;
const PROJECT_FIELDS = ['name', 'description', 'sfOrg', 'environment', 'instanceUrl', 'apiVersion', 'mode', 'credentialRef', 'jiraProjectKey', 'jiraUrl', 'jiraCredentialRef', 'testDataConfig', 'integrationConfig', 'notificationConfig', 'businessConfig', 'postmanCollection', 'automationRepo', 'status'];

function validateProject(p, partial = false) {
  if (!partial) required(p, ['name', 'environment', 'apiVersion']);
  if (p.environment !== undefined && !ENVIRONMENTS.includes(p.environment)) throw new HttpError(400, `Environment must be one of: ${ENVIRONMENTS.join(', ')}.`);
  if (p.apiVersion !== undefined && !/^\d{2}\.0$/.test(String(p.apiVersion))) throw new HttpError(400, 'API version must look like 62.0.', { action: 'Use the version number shown in Setup → Apex Classes → Version, e.g. 62.0.' });
  if (p.instanceUrl) {
    const origin = normalizeLoginUrl(p.instanceUrl);
    if (!origin || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
      throw new HttpError(400, 'Instance URL must be an https:// Salesforce or Commerce Cloud host, e.g. https://acme--qa.sandbox.my.salesforce.com', { action: 'Use the org login URL, My Domain, sandbox, or an SFCC Business Manager host.' });
    }
    p.instanceUrl = origin;
  }
  if (p.jiraUrl && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(p.jiraUrl)) throw new HttpError(400, 'Jira URL must be an https:// origin, e.g. https://acme.atlassian.net');
  if (p.mode !== undefined && !['demo', 'live'].includes(p.mode)) throw new HttpError(400, 'Mode must be "demo" or "live".');
  if (p.credentialRef && !/^[A-Za-z0-9_]{1,40}$/.test(p.credentialRef)) throw new HttpError(400, 'Credential prefix may contain letters, digits and underscores only.');
  for (const k of Object.keys(p)) {
    if (/secret|password|token/i.test(k) || (typeof p[k] === 'string' && /^(00D[A-Za-z0-9]{12,15}!|ATATT)/.test(p[k]))) {
      throw new HttpError(400, 'Credentials must not be stored in project configuration.', { cause: `Field "${k}" looks like a secret.`, action: 'Put secrets in .env or your secret manager and reference them with a credential prefix.' });
    }
  }
}

function commerceRef(p) {
  const c = (p.integrationConfig && p.integrationConfig.commerce) || {};
  return c.credentialRef || p.credentialRef;
}

function cliLoginSafe(adapter) {
  const cached = adapter.cachedLogin;
  if (!cached) return { loggedIn: false, account: null };
  return { loggedIn: Boolean(cached.loggedIn), account: cached.account || null };
}

function cliConnectionView(tool, p) {
  const adapter = tool === 'cursor' ? cursorFor(p) : geminiFor(p);
  const detected = tool === 'cursor' ? detectCursorBin(((p.integrationConfig || {}).cursor || {}).bin) : detectGeminiBin(((p.integrationConfig || {}).gemini || {}).bin);
  const name = tool === 'cursor' ? 'Cursor' : 'Gemini';
  const binNames = tool === 'cursor' ? '`cursor` / `agent`' : '`gemini`';
  const login = cliLoginSafe(adapter);
  if (!detected) {
    return { status: 'unavailable', loggedIn: false, label: `${name} CLI is not installed (${binNames} not on PATH). Generate still uses the built-in engine.` };
  }
  const bin = path.basename(detected);
  if (login.loggedIn && adapter.wanted) {
    return { status: 'configured', loggedIn: true, label: `${name} logged in (${bin})` };
  }
  if (login.loggedIn) {
    return { status: 'unavailable', loggedIn: true, label: `${name} logged in (${bin}) — enable on this project to generate.` };
  }
  if (adapter.wanted) {
    return { status: 'unavailable', loggedIn: false, label: `${name} CLI found (${bin}) — not logged in. Click Connect, then Test.` };
  }
  return { status: 'unavailable', loggedIn: false, label: `${name} CLI found (${bin}) — click Connect to log in.` };
}

function contextDocsFor(projectId) {
  return repo.find('context_docs', 'projectId = $p', { p: projectId }, 'ORDER BY updatedAt DESC');
}

function projectView(p) {
  const stats = get(`SELECT COUNT(*) AS tests FROM test_cases WHERE projectId = $p`, { p: p.id });
  const last = get(`SELECT id, startedAt, passed, failed, total, status FROM runs WHERE projectId = $p ORDER BY startedAt DESC LIMIT 1`, { p: p.id });
  const cs = credentialStatus(p.credentialRef, p.jiraCredentialRef, commerceRef(p));
  const mcpOn = Boolean(salesforceMcpSettings(p.credentialRef) || ((p.integrationConfig || {}).salesforceMcp || {}).url || ((p.integrationConfig || {}).salesforceMcp || {}).command);
  const orgOn = Boolean(salesforceCredentials(p.credentialRef));
  const det = publicDetection(((p.integrationConfig || {}).salesforceDetection) || {}) || {};
  const types = det.types || [];
  const typeLabel = types.length ? types.join(', ') : '';
  let sf;
  if (p.mode === 'demo') sf = { status: 'demo', label: 'Demo org simulator', types: ['Salesforce Core'] };
  else if (det.connected && det.loginKind === 'core') {
    sf = { status: 'connected', label: typeLabel ? `Connected · ${typeLabel}` : 'Connected — Salesforce CLI browser login', types, orgId: det.orgId, edition: det.edition, explanation: det.explanation };
  } else if (det.connected && det.loginKind === 'sfcc') {
    sf = { status: 'connected', label: 'Connected · B2C Commerce / SFCC (not Core CRM)', types, explanation: det.explanation };
  }   else if (orgOn && mcpOn) sf = { status: 'configured', label: 'Org OAuth + MCP configured', types };
  else if (orgOn) sf = { status: 'configured', label: 'Org OAuth configured', types };
  else if (mcpOn) sf = { status: 'configured', label: 'Salesforce MCP configured (metadata)', types };
  else if (((p.integrationConfig || {}).salesforceCli || {}).enabled && ((p.integrationConfig || {}).salesforceCli || {}).targetOrg) {
    sf = { status: 'configured', label: 'Waiting for browser login — finish signing in, then Test.', types };
  } else sf = { status: 'unavailable', label: require('../config').SF_UNAVAILABLE_MESSAGE };
  const ccOn = commerceEnabled(p);
  let commerce;
  if (det.connected && (det.loginKind === 'sfcc' || types.includes('SFCC') || types.includes('B2C Commerce'))) {
    commerce = { status: 'connected', label: det.host ? `Connected · B2C Commerce / SFCC (${det.host})` : 'Connected · B2C Commerce / SFCC', types: types.filter((t) => /B2C|SFCC/i.test(t)) };
  } else if (!ccOn) commerce = { status: 'off', label: 'Commerce Cloud not enabled' };
  else if (p.mode === 'demo') commerce = { status: 'demo', label: 'Demo Commerce Cloud storefront' };
  else if (cs.commerce.configured) commerce = { status: 'configured', label: 'Commerce Cloud credentials configured' };
  else commerce = { status: 'unavailable', label: 'Commerce Cloud is enabled but SFCC credentials are missing.' };
  return {
    ...p,
    stats: { tests: stats.tests, lastRun: last || null, passRate: last && last.passed + last.failed ? Math.round((last.passed / (last.passed + last.failed)) * 1000) / 10 : null },
    connection: {
      salesforce: sf,
      jira: p.mode === 'demo' ? { status: 'demo', label: 'Demo Jira' } : cs.jira.configured && p.jiraUrl ? { status: 'configured', label: 'Credentials configured' } : { status: 'unavailable', label: 'Jira is not configured — defects can be drafted but not created.' },
      commerce,
      postman: p.mode === 'demo'
        ? { status: 'demo', label: 'Demo / local Postman collections' }
        : (cs.postman && cs.postman.configured) || (p.integrationConfig && p.integrationConfig.postman && (p.integrationConfig.postman.mcpUrl || p.integrationConfig.postman.workspace))
          ? { status: 'configured', label: 'Postman workspace configured' }
          : postmanFor(p).available
            ? { status: 'configured', label: 'Local Postman collections' }
            : { status: 'unavailable', label: 'Postman MCP is not configured — local collections can still be reused.' },
      http: (() => {
        const base = ((p.integrationConfig || {}).http || {}).baseUrl || (cs.http && cs.http.baseUrl);
        if (base) return { status: 'configured', label: `Frontend HTTP ${String(base).replace(/^https?:\/\//, '')}`, baseUrl: base };
        if (httpFor(p).available) return { status: 'configured', label: 'Frontend HTTP base URL set' };
        return { status: 'off', label: 'No frontend HTTP base URL — collection requests with absolute URLs still run' };
      })(),
      cursor: cliConnectionView('cursor', p),
      gemini: cliConnectionView('gemini', p),
      metadataLabel: metadataLabel(p),
    },
    workflow: workflow.getState(p),
  };
}

route('GET', '/api/health', () => ({ ok: true, version: config.version, time: now() }));

route('GET', '/api/meta', (ctx) => ({
  version: config.version, user: ctx.user, environments: ENVIRONMENTS, aiEnabled: ai.enabled(),
  apiTypes: ['REST', 'SOAP', 'Bulk API', 'Bulk API 2.0', 'Composite', 'Composite Graph', 'GraphQL', 'Tooling', 'Metadata', 'Connect REST', 'Apex REST', 'Apex SOAP', 'Platform Events', 'Change Data Capture', 'OAuth', 'OCAPI', 'SCAPI'],
  testTypes: ['Functional', 'Negative', 'Boundary', 'Security', 'Integration', 'Regression', 'Contract', 'Performance'],
  priorities: ['P0', 'P1', 'P2', 'P3'],
  modes: ['Discover', 'Generate', 'Execute', 'Validate', 'Analyze', 'Defect', 'Regression', 'Report'],
  workflowSteps: workflow.STEPS,
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
  return {
    mode: p.mode,
    credentials: credentialStatus(p.credentialRef, p.jiraCredentialRef, commerceRef(p)),
    view: projectView(p).connection,
    salesforceMcp: (p.integrationConfig && p.integrationConfig.salesforceMcp) || {},
    salesforceCli: (p.integrationConfig && p.integrationConfig.salesforceCli) || {},
    salesforceSource: (p.integrationConfig && p.integrationConfig.salesforceSource) || 'mcp',
    postman: (p.integrationConfig && p.integrationConfig.postman) || {},
    http: (p.integrationConfig && p.integrationConfig.http) || {},
    commerce: (p.integrationConfig && p.integrationConfig.commerce) || {},
    cursor: (p.integrationConfig && p.integrationConfig.cursor) || {},
    gemini: (p.integrationConfig && p.integrationConfig.gemini) || {},
    cursorLogin: cliLoginSafe(cursorFor(p)),
    geminiLogin: cliLoginSafe(geminiFor(p)),
    salesforceDetection: publicDetection(((p.integrationConfig || {}).salesforceDetection) || {}) || {},
    experience: (p.integrationConfig && p.integrationConfig.experience) || {},
    scriptGenerator: scriptGeneratorPref(p),
    contextDocs: contextDocsFor(p.id),
    loopback: isLoopback(ctx),
  };
});

function isLoopback(ctx) {
  const ip = String((ctx.req.socket && ctx.req.socket.remoteAddress) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

route('POST', '/api/projects/:id/connection/test', async (ctx) => {
  const p = getProject(ctx.params.id);
  const target = String((ctx.body && ctx.body.target) || ctx.query.target || 'all').toLowerCase();
  const want = (k) => target === 'all' || target === k;
  const out = { salesforce: null, jira: null, commerce: null, postman: null, http: null, cursor: null, gemini: null };
  if (want('salesforce')) {
    const classified = classifyLoginUrl(p.instanceUrl);
    if (p.mode !== 'demo' && classified.kind === 'sfcc') {
      try {
        const det = await detectFromConnector(null, { url: p.instanceUrl });
        const applied = persistSalesforceAutoConnect(p, det);
        out.salesforce = { ok: true, kind: 'sfcc', detection: applied.detection, autoConnected: applied.cards, types: (applied.detection && applied.detection.types) || classified.types };
      } catch (e) { out.salesforce = { ok: false, ...(e.explanation || { title: e.message }) }; }
    } else {
      const sf = salesforceFor(p);
      try {
        out.salesforce = sf.available ? await sf.testConnection() : { ok: false, ...sf.unavailableExplanation() };
      } catch (e) { out.salesforce = { ok: false, ...(e.explanation || { title: e.message }) }; }
      if (p.mode !== 'demo' && out.salesforce && out.salesforce.ok) {
        try {
          const det = await detectFromConnector(sf, { url: out.salesforce.instanceUrl || p.instanceUrl });
          const applied = persistSalesforceAutoConnect(p, det);
          out.salesforce.detection = applied.detection;
          out.salesforce.autoConnected = applied.cards;
          out.salesforce.types = (applied.detection && applied.detection.types) || [];
        } catch { /* detection is best-effort */ }
      }
    }
  }
  if (want('jira')) {
    const jira = jiraFor(p);
    try {
      out.jira = jira.available ? await jira.testConnection() : { ok: false, ...jira.unavailableExplanation() };
    } catch (e) { out.jira = { ok: false, ...(e.explanation || { title: e.message }) }; }
  }
  if (want('commerce')) {
    const commerce = commerceFor(p);
    try {
      out.commerce = commerce.available ? await commerce.testConnection() : { ok: false, ...commerce.unavailableExplanation() };
    } catch (e) { out.commerce = { ok: false, ...(e.explanation || { title: e.message }) }; }
    if (out.commerce && out.commerce.ok && out.commerce.catalog && out.commerce.catalog.productId) {
      const ic = { ...(p.integrationConfig || {}) };
      ic.commerce = { ...(ic.commerce || {}), sampleProductId: out.commerce.catalog.productId };
      repo.update('projects', p.id, { integrationConfig: ic, updatedAt: now() });
    }
  }
  if (want('http')) {
    const http = httpFor(p);
    try { out.http = await http.testConnection(); } catch (e) { out.http = { ok: false, ...(e.explanation || { title: e.message }) }; }
  }
  if (want('postman')) {
    const pm = postmanFor(p);
    try {
      out.postman = await pm.testConnection();
    } catch (e) { out.postman = { ok: false, ...(e.explanation || { title: e.message }) }; }
  }
  if (want('cursor')) {
    try { out.cursor = await cursorFor(p).testConnection(); } catch (e) { out.cursor = { ok: false, title: e.message }; }
  }
  if (want('gemini')) {
    try { out.gemini = await geminiFor(p).testConnection(); } catch (e) { out.gemini = { ok: false, title: e.message }; }
  }
  if (out.salesforce) workflow.touch(p.id, 'salesforce', out.salesforce.ok ? 'completed' : 'failed', { salesforce: out.salesforce.ok });
  audit('project', 'connection.tested', { user: ctx.user, projectId: p.id, detail: { target, salesforce: out.salesforce && out.salesforce.ok, jira: out.jira && out.jira.ok, commerce: out.commerce && out.commerce.ok, postman: out.postman && out.postman.ok, cursor: out.cursor && out.cursor.ok, gemini: out.gemini && out.gemini.ok } });
  return out;
});

function persistSalesforceAutoConnect(p, det) {
  const applied = autoConnectPatch(p, det);
  applied.patch.updatedAt = now();
  repo.update('projects', p.id, applied.patch);
  return applied;
}

route('POST', '/api/projects/:id/connection/login', (ctx) => {
  if (!isLoopback(ctx) || (config.host !== '127.0.0.1' && config.host !== 'localhost')) {
    throw new HttpError(403, 'CLI login must run on this machine.', {
      action: 'Open this app at 127.0.0.1 and click Connect so the CLI can open a browser here.',
    });
  }
  const target = String((ctx.body && ctx.body.target) || ctx.query.target || '').toLowerCase();
  if (target !== 'cursor' && target !== 'gemini' && target !== 'salesforce') {
    throw new HttpError(400, 'Choose Salesforce, Cursor or Gemini to log in.');
  }
  const p = getProject(ctx.params.id);
  if (target === 'salesforce') {
    const instanceUrl = String((ctx.body && ctx.body.instanceUrl) || p.instanceUrl || '').trim();
    const classified = classifyLoginUrl(instanceUrl || 'https://login.salesforce.com');
    if (classified.kind === 'invalid') throw new HttpError(400, classified.error || 'Enter a Salesforce or Commerce Cloud https URL.');
    const origin = classified.origin || 'https://login.salesforce.com';
    const adapter = new SalesforceCliAdapter(p);
    if (classified.kind !== 'sfcc' && !adapter.bin) throw new HttpError(400, adapter.unavailableExplanation().title, adapter.unavailableExplanation());
    const alias = orgAlias(p, (ctx.body && ctx.body.sfOrg) || p.sfOrg);
    const result = adapter.startLogin({ instanceUrl: origin, alias });
    if (!result.ok) throw new HttpError(400, result.title, result);
    const ic = { ...(p.integrationConfig || {}) };
    if (classified.kind === 'sfcc') {
      const prev = ic.commerce || {};
      ic.commerce = { ...prev, enabled: true, host: classified.host || prev.host };
    } else {
      ic.salesforceCli = { enabled: true, bin: String((ic.salesforceCli && ic.salesforceCli.bin) || '').trim(), targetOrg: alias };
      ic.salesforceSource = ic.salesforceSource && ic.salesforceSource !== 'mcp' ? ic.salesforceSource : 'cli';
    }
    repo.update('projects', p.id, {
      instanceUrl: origin, sfOrg: classified.kind === 'sfcc' ? p.sfOrg : alias, mode: 'live',
      integrationConfig: ic, updatedAt: now(),
    });
    audit('project', 'connection.login-started', { user: ctx.user, projectId: p.id, detail: { target, command: result.command, loginKind: result.loginKind } });
    return { ...result, view: projectView(repo.get('projects', p.id)).connection };
  }
  const adapter = target === 'cursor' ? cursorFor(p) : geminiFor(p);
  const result = adapter.startLogin();
  if (!result.ok) throw new HttpError(400, result.title, result);
  const ic = { ...(p.integrationConfig || {}) };
  const prev = ic[target] || {};
  ic[target] = { enabled: true, bin: String(prev.bin || '').trim() };
  repo.update('projects', p.id, { integrationConfig: ic, updatedAt: now() });
  audit('project', 'connection.login-started', { user: ctx.user, projectId: p.id, detail: { target, command: result.command } });
  return { ...result, view: projectView(repo.get('projects', p.id)).connection };
});

route('PUT', '/api/projects/:id/connection', (ctx) => {
  const p = getProject(ctx.params.id);
  const b = ctx.body || {};
  const patch = { updatedAt: now() };
  for (const f of ['instanceUrl', 'apiVersion', 'mode', 'credentialRef', 'sfOrg', 'jiraProjectKey', 'jiraUrl', 'jiraCredentialRef']) {
    if (b[f] !== undefined) patch[f] = b[f] === '' ? null : b[f];
  }
  validateProject(patch, true);
  const ic = { ...(p.integrationConfig || {}) };
  if (b.salesforceMcp && typeof b.salesforceMcp === 'object') {
    ic.salesforceMcp = {
      url: String(b.salesforceMcp.url || '').trim(),
      command: String(b.salesforceMcp.command || '').trim(),
    };
  }
  if (b.salesforceSource && ['mcp', 'cli', 'oauth'].includes(b.salesforceSource)) ic.salesforceSource = b.salesforceSource;
  if (b.salesforceCli && typeof b.salesforceCli === 'object') {
    ic.salesforceCli = {
      enabled: b.salesforceCli.enabled !== false,
      bin: String(b.salesforceCli.bin || 'sf').trim(),
      targetOrg: String(b.salesforceCli.targetOrg || '').trim(),
    };
  }
  if (b.postman && typeof b.postman === 'object') {
    ic.postman = {
      workspace: String(b.postman.workspace || '').trim(),
      environment: String(b.postman.environment || '').trim(),
      mcpUrl: String(b.postman.mcpUrl || '').trim(),
      mcpCommand: String(b.postman.mcpCommand || '').trim(),
    };
  }
  if (b.http && typeof b.http === 'object') {
    ic.http = {
      ...((ic.http) || {}),
      baseUrl: String(b.http.baseUrl || '').replace(/\/$/, '').trim(),
      credentialRef: String(b.http.credentialRef || ic.http && ic.http.credentialRef || p.credentialRef || '').trim() || null,
    };
  }
  if (b.cursor && typeof b.cursor === 'object') {
    ic.cursor = {
      enabled: b.cursor.enabled !== false,
      bin: String(b.cursor.bin || '').trim(),
    };
  }
  if (b.gemini && typeof b.gemini === 'object') {
    ic.gemini = {
      enabled: b.gemini.enabled !== false,
      bin: String(b.gemini.bin || '').trim(),
    };
  }
  if (b.scriptGenerator && ['auto', 'cursor', 'gemini', 'engine'].includes(b.scriptGenerator)) {
    ic.scriptGenerator = b.scriptGenerator;
  }
  if (b.commerce && typeof b.commerce === 'object') {
    const prev = ic.commerce || {};
    ic.commerce = {
      ...prev,
      enabled: Boolean(b.commerce.enabled),
      host: String(b.commerce.host || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      siteId: String(b.commerce.siteId || '').trim(),
      orgId: String(b.commerce.orgId || '').trim(),
      shortCode: String(b.commerce.shortCode || '').trim(),
      ocapiVersion: String(b.commerce.ocapiVersion || prev.ocapiVersion || 'v24_5'),
      credentialRef: String(b.commerce.credentialRef || prev.credentialRef || b.credentialRef || p.credentialRef || '').trim() || null,
      sampleProductId: String(b.commerce.sampleProductId || prev.sampleProductId || ''),
    };
  }
  patch.integrationConfig = ic;
  repo.update('projects', p.id, patch);
  audit('project', 'connection.updated', { user: ctx.user, projectId: p.id, detail: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt') } });
  return projectView(repo.get('projects', p.id));
});

route('POST', '/api/projects/:id/connection/secrets', (ctx) => {
  if (!isLoopback(ctx) || (config.host !== '127.0.0.1' && config.host !== 'localhost')) {
    throw new HttpError(403, 'Saving credentials to .env is only allowed when this server is bound to loopback and the request comes from this machine.', {
      action: 'Set the SF_*/JIRA_*/SFCC_* variables in .env or your secret manager, then restart.',
    });
  }
  const p = getProject(ctx.params.id);
  const b = ctx.body || {};
  const sfRef = normRef(b.credentialRef || p.credentialRef);
  const jiraRef = b.jiraCredentialRef !== undefined ? normRef(b.jiraCredentialRef) : normRef(p.jiraCredentialRef);
  const ccRef = normRef((b.commerce && b.commerce.credentialRef) || commerceRef(p) || sfRef);
  const pairs = {};
  const sf = b.salesforce || {};
  if (sfRef) {
    if (sf.authFlow) pairs[`SF_${sfRef}_AUTH_FLOW`] = sf.authFlow;
    if (sf.loginUrl) pairs[`SF_${sfRef}_LOGIN_URL`] = sf.loginUrl;
    if (sf.clientId) pairs[`SF_${sfRef}_CLIENT_ID`] = sf.clientId;
    if (sf.clientSecret) pairs[`SF_${sfRef}_CLIENT_SECRET`] = sf.clientSecret;
    if (sf.username) pairs[`SF_${sfRef}_USERNAME`] = sf.username;
    if (sf.privateKeyPath) pairs[`SF_${sfRef}_PRIVATE_KEY_PATH`] = sf.privateKeyPath;
    if (sf.refreshToken) pairs[`SF_${sfRef}_REFRESH_TOKEN`] = sf.refreshToken;
    if (sf.mcpUrl) pairs[`SF_${sfRef}_MCP_URL`] = sf.mcpUrl;
    if (sf.mcpCommand) pairs[`SF_${sfRef}_MCP_COMMAND`] = sf.mcpCommand;
  }
  const jira = b.jira || {};
  const jp = jiraRef ? `JIRA_${jiraRef}_` : 'JIRA_';
  if (jira.email) pairs[`${jp}EMAIL`] = jira.email;
  if (jira.apiToken) pairs[`${jp}API_TOKEN`] = jira.apiToken;
  const cc = b.commerce || {};
  if (ccRef) {
    if (cc.clientId) pairs[`SFCC_${ccRef}_CLIENT_ID`] = cc.clientId;
    if (cc.clientSecret) pairs[`SFCC_${ccRef}_CLIENT_SECRET`] = cc.clientSecret;
  }
  const postman = b.postman || {};
  const pmRef = sfRef ? `POSTMAN_${sfRef}_` : 'POSTMAN_';
  if (postman.mcpUrl) pairs[`${pmRef}MCP_URL`] = postman.mcpUrl;
  if (postman.mcpCommand) pairs[`${pmRef}MCP_COMMAND`] = postman.mcpCommand;
  if (postman.apiKey) pairs[`${pmRef}API_KEY`] = postman.apiKey;
  if (postman.workspace) pairs[`${pmRef}WORKSPACE`] = postman.workspace;
  const http = b.http || {};
  const httpRef = sfRef ? `HTTP_${sfRef}_` : 'HTTP_';
  if (http.token) pairs[`${httpRef}TOKEN`] = http.token;
  if (http.baseUrl) pairs[`${httpRef}BASE_URL`] = http.baseUrl;
  if (b.cursor && b.cursor.apiKey) {
    throw new HttpError(400, 'Cursor does not use an API key here. Click Connect to log in with the Cursor CLI.');
  }
  if (b.gemini && b.gemini.apiKey) {
    throw new HttpError(400, 'Gemini does not use an API key here. Click Connect to sign in with Google in the Gemini CLI.');
  }
  const keys = upsertEnv(pairs);
  registerSecrets(secretValues());
  audit('project', 'connection.secrets-saved', { user: ctx.user, projectId: p.id, detail: { keys } });
  return { saved: keys.length, keys };
});

function sanitizeDocInput(b) {
  const name = String((b && b.name) || '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'Give the document a name.');
  let filePath = String((b && b.filePath) || '').trim() || null;
  if (filePath && /^https?:\/\//i.test(filePath)) throw new HttpError(400, 'Remote URLs are not fetched. Paste the text or a local file path.', { action: 'Paste the document body, or a path on this machine under the project or your home folder.' });
  if (filePath && !safeLocalPath(filePath)) throw new HttpError(400, 'That file path is not allowed.', { action: 'Use a local path under this project or your home folder. .env and key files are blocked.' });
  let body = String((b && b.body) || '');
  if (filePath && !body) {
    const fromDisk = readLocalDocFile(filePath);
    if (fromDisk == null) throw new HttpError(400, 'Could not read that local file (missing, too large, or looks like secrets).');
    body = fromDisk;
  }
  body = body.slice(0, 20000);
  if (looksLikeSecretText(body)) throw new HttpError(400, 'The document looks like it contains secrets and was not stored.', { action: 'Remove API keys, tokens and passwords, then paste again.' });
  return { name, body, filePath: filePath ? safeLocalPath(filePath) : null };
}

route('GET', '/api/projects/:id/context-docs', (ctx) => {
  const p = getProject(ctx.params.id);
  return { items: contextDocsFor(p.id) };
});

route('POST', '/api/projects/:id/context-docs', (ctx) => {
  const p = getProject(ctx.params.id);
  const doc = sanitizeDocInput(ctx.body || {});
  const row = { id: crypto.randomUUID(), projectId: p.id, ...doc, createdAt: now(), updatedAt: now() };
  repo.insert('context_docs', row);
  audit('project', 'context-doc.added', { user: ctx.user, projectId: p.id, detail: { id: row.id, name: row.name } });
  return row;
});

route('PUT', '/api/projects/:id/context-docs/:docId', (ctx) => {
  const p = getProject(ctx.params.id);
  const existing = repo.one('context_docs', 'id = $id AND projectId = $p', { id: ctx.params.docId, p: p.id });
  if (!existing) throw new HttpError(404, 'Context document not found.');
  const doc = sanitizeDocInput({ name: ctx.body.name ?? existing.name, body: ctx.body.body ?? existing.body, filePath: ctx.body.filePath !== undefined ? ctx.body.filePath : existing.filePath });
  repo.update('context_docs', existing.id, { ...doc, updatedAt: now() });
  return repo.get('context_docs', existing.id);
});

route('DELETE', '/api/projects/:id/context-docs/:docId', (ctx) => {
  const p = getProject(ctx.params.id);
  const existing = repo.one('context_docs', 'id = $id AND projectId = $p', { id: ctx.params.docId, p: p.id });
  if (!existing) throw new HttpError(404, 'Context document not found.');
  repo.remove('context_docs', existing.id);
  audit('project', 'context-doc.removed', { user: ctx.user, projectId: p.id, detail: { id: existing.id, name: existing.name } });
  return { deleted: true };
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
  // node:sqlite rejects named parameters the statement does not reference, so only bind $p when it is used.
  const params = pid ? { q: like, p: pid } : { q: like };
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
