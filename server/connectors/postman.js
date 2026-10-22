'use strict';
/**
 * Postman MCP adapter + local/demo workspace fallback.
 * Salesforce MCP/CLI never replaces this layer for API execution.
 */
const fs = require('node:fs');
const path = require('node:path');
const { McpClient, McpError, toolJson } = require('./mcp');
const { config, postmanSettings } = require('../config');
const { repo, nextId, now } = require('../db');
const { indexCollection } = require('../engine/collection-diff');
const { maskDeep } = require('../lib/mask');
const enginePostman = require('../engine/postman');
const mcpHelp = require('../engine/postman-mcp');

const DEFAULT_MCP_COMMAND = 'npx -y @postman/postman-mcp-server';

function isRemoteCollectionId(id) {
  const s = String(id || '');
  return Boolean(s) && !/^(local|generated|imported|file):/i.test(s);
}

function settingsFor(project) {
  const env = postmanSettings(project.credentialRef) || {};
  const cfg = (project.integrationConfig && project.integrationConfig.postman) || {};
  const url = env.url || cfg.mcpUrl || '';
  let command = env.command || cfg.mcpCommand || '';
  const apiKey = env.apiKey || '';
  if (!url && !command && apiKey && !process.env.NODE_TEST_CONTEXT && !process.env.QA_DB_FILE) {
    command = DEFAULT_MCP_COMMAND;
  }
  return {
    url,
    command,
    apiKey,
    timeoutMs: Number(env.timeoutMs || cfg.timeoutMs || 20000),
    runTimeoutMs: Number(env.runTimeoutMs || cfg.runTimeoutMs || 180000),
    workspace: env.workspace || cfg.workspace || '',
    environment: cfg.environment || project.environment || '',
    apiKeyPresent: Boolean(apiKey),
    collectionId: cfg.collectionId || '',
    environmentId: cfg.environmentId || '',
    runCollectionId: cfg.runCollectionId || '',
    reuseExisting: cfg.reuseExisting === true,
  };
}

function localFiles() {
  const dir = path.join(config.root, 'api-tests', 'collections');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const full = path.join(dir, f);
    let col;
    try { col = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return null; }
    if (!col || !col.info) return null;
    return { uid: `local:${f}`, name: col.info.name || f, source: 'local', file: path.relative(config.root, full), collection: col, updatedAt: fs.statSync(full).mtime.toISOString() };
  }).filter(Boolean);
}

function scoreMatch(entry, q) {
  const hay = [
    entry.name,
    entry.source,
    entry.workspace,
    entry.environment,
    entry.file,
    JSON.stringify((entry.tags || [])),
    ...(entry.requests || []).map((r) => `${r.method} ${r.url} ${r.name}`),
  ].join(' ').toLowerCase();
  let score = 0;
  for (const [key, val] of Object.entries(q)) {
    if (!val) continue;
    const v = String(val).toLowerCase();
    if (hay.includes(v)) score += key === 'endpoint' || key === 'api' ? 5 : 3;
  }
  return score;
}

class PostmanConnector {
  constructor(project, opts = {}) {
    this.project = project;
    this.kind = project.mode === 'demo' ? 'demo' : 'postman';
    this.settings = settingsFor(project);
    this.client = opts.client || new McpClient({
      url: this.settings.url,
      command: this.settings.command,
      timeoutMs: this.settings.timeoutMs,
      env: this.settings.apiKey ? { POSTMAN_API_KEY: this.settings.apiKey } : null,
    });
  }

  tool(key) {
    return mcpHelp.findNamedTool(this.client, key);
  }

  async mcpJson(key, args, opts = {}) {
    const tool = this.tool(key);
    if (!tool) {
      throw new McpError(`The Postman MCP server has no ${key} tool.`, {
        action: 'Use the official Postman MCP (@postman/postman-mcp-server) which exposes createCollection, putCollection, runCollection, and environment tools.',
        evidence: (this.client.tools || []).map((t) => t.name),
      });
    }
    return toolJson(await this.client.callTool(tool.name, args, opts));
  }

  persistMcpIds(ids = {}) {
    const ic = { ...(this.project.integrationConfig || {}) };
    ic.postman = { ...(ic.postman || {}) };
    if (ids.collectionId) ic.postman.collectionId = ids.collectionId;
    if (ids.environmentId) ic.postman.environmentId = ids.environmentId;
    if (ids.runCollectionId) ic.postman.runCollectionId = ids.runCollectionId;
    if (ids.reuseExisting !== undefined) ic.postman.reuseExisting = Boolean(ids.reuseExisting);
    const patch = { integrationConfig: ic, updatedAt: now() };
    if (ids.collectionId) patch.postmanCollection = ids.collectionId;
    repo.update('projects', this.project.id, patch);
    this.project.integrationConfig = ic;
    if (ids.collectionId) this.project.postmanCollection = ids.collectionId;
    this.settings.collectionId = ic.postman.collectionId || this.settings.collectionId;
    this.settings.environmentId = ic.postman.environmentId || this.settings.environmentId;
    this.settings.runCollectionId = ic.postman.runCollectionId || this.settings.runCollectionId;
    this.settings.reuseExisting = ic.postman.reuseExisting === true;
  }

  persistCollectionVars(variables = {}, hints = {}) {
    const ic = { ...(this.project.integrationConfig || {}) };
    ic.postman = { ...(ic.postman || {}), variables: { ...((ic.postman || {}).variables || {}), ...variables } };
    const { inferHttpOrigin } = require('../engine/collection-import');
    const origin = hints.httpBaseUrl || inferHttpOrigin({ variables });
    if (origin && !(ic.http && ic.http.baseUrl)) ic.http = { ...(ic.http || {}), baseUrl: origin, credentialRef: (ic.http && ic.http.credentialRef) || this.project.credentialRef };
    if (hints.needsBearer) ic.http = { ...(ic.http || {}), needsBearer: true, credentialRef: (ic.http && ic.http.credentialRef) || this.project.credentialRef };
    const tdc = { ...(this.project.testDataConfig || {}), autoCleanup: true, variables: { ...((this.project.testDataConfig && this.project.testDataConfig.variables) || {}) } };
    for (const [k, v] of Object.entries(variables || {})) {
      if (tdc.variables[k] === undefined || tdc.variables[k] === '') tdc.variables[k] = v;
    }
    if (hints.orgId) {
      tdc.variables.organization_id = tdc.variables.organization_id || hints.orgId;
      tdc.variables.organizationId = tdc.variables.organizationId || hints.orgId;
    }
    const patch = { integrationConfig: ic, testDataConfig: tdc, updatedAt: now() };
    const { salesforceLoginOrigin } = require('../connectors/salesforce-org');
    const sfOrigin = salesforceLoginOrigin(hints.instanceUrl);
    if (sfOrigin && !this.project.instanceUrl) patch.instanceUrl = sfOrigin;
    if (hints.sfOrg && !this.project.sfOrg) patch.sfOrg = hints.sfOrg;
    if (hints.apiVersion && this.project.apiVersion === '62.0' && hints.apiVersion !== '62.0') patch.apiVersion = hints.apiVersion;
    repo.update('projects', this.project.id, patch);
    this.project.integrationConfig = ic;
    this.project.testDataConfig = tdc;
    Object.assign(this.project, patch);
  }

  async resolveWorkspace() {
    const w = this.settings.workspace;
    if (!w) return undefined;
    if (/^[0-9a-f-]{8,}$/i.test(w) && !/\s/.test(w)) return w;
    try {
      const data = await this.mcpJson('getWorkspaces', {});
      const hit = mcpHelp.matchByName(mcpHelp.listFrom(data, ['workspaces', 'items']), w);
      return mcpHelp.pickId(hit) || w;
    } catch {
      return w;
    }
  }

  async upsertCollection(collection, { idHint, name } = {}) {
    const workspace = await this.resolveWorkspace();
    const wantName = name || (collection.info && collection.info.name);
    let id = idHint || this.settings.collectionId || '';
    if (!id && !this.settings.reuseExisting && this.tool('getCollections')) {
      try {
        const data = await this.mcpJson('getCollections', workspace ? { workspace } : {});
        const hit = mcpHelp.matchByName(mcpHelp.listFrom(data, ['collections', 'items']), wantName);
        id = mcpHelp.pickId(hit) || '';
      } catch { /* create instead */ }
    }
    if (id && this.tool('putCollection')) {
      const data = await this.mcpJson('putCollection', { collectionId: id, collection });
      return mcpHelp.pickId(data) || id;
    }
    if (this.settings.reuseExisting) return id || null;
    const data = await this.mcpJson('createCollection', { workspace, collection });
    return mcpHelp.pickId(data) || id;
  }

  async upsertEnvironment(exported, { secrets } = {}) {
    const workspace = await this.resolveWorkspace();
    const payload = secrets ? mcpHelp.withRuntimeSecrets(exported, secrets) : mcpHelp.environmentPayload(exported);
    let id = this.settings.environmentId || '';
    if (!id && this.tool('getEnvironments')) {
      try {
        const data = await this.mcpJson('getEnvironments', workspace ? { workspace } : {});
        const hit = mcpHelp.matchByName(mcpHelp.listFrom(data, ['environments', 'items']), payload.name);
        id = mcpHelp.pickId(hit, ['id', 'uid', 'environmentId']) || '';
      } catch { /* create instead */ }
    }
    if (id && this.tool('putEnvironment')) {
      const data = await this.mcpJson('putEnvironment', { environmentId: id, environment: payload });
      return mcpHelp.pickId(data, ['id', 'uid', 'environmentId']) || id;
    }
    if (this.tool('createEnvironment')) {
      const data = await this.mcpJson('createEnvironment', { workspace, environment: payload });
      return mcpHelp.pickId(data, ['id', 'uid', 'environmentId']) || id;
    }
    return id || null;
  }

  /**
   * Upsert the approved suite into a Postman collection (MCP when connected,
   * local store otherwise). Collection JSON never includes secret values.
   */
  async collectionBodyForSync(tests) {
    const generated = enginePostman.exportCollection(this.project, tests);
    if (!this.settings.reuseExisting || !this.settings.collectionId) return generated;
    try {
      const raw = await this.fetchCollection(this.settings.collectionId);
      const existing = raw.collection || raw;
      if (existing && existing.info && Array.isArray(existing.item)) {
        const { mergeApproved } = require('../engine/collection-diff');
        const merged = mergeApproved(existing, tests, { mode: 'replace-missing-only' });
        return { ...merged, info: { ...(existing.info || {}), ...(merged.info || {}), name: existing.info.name || generated.info.name } };
      }
    } catch { /* generated export if the existing body cannot be loaded */ }
    return generated;
  }

  async syncApproved(testCases) {
    const tests = testCases || repo.find('test_cases', "projectId = $p AND status != 'disabled'", { p: this.project.id }, 'ORDER BY seq');
    if (!tests.length) {
      return { ok: false, mcp: false, source: 'none', title: 'No approved tests to sync to Postman.', action: 'Approve a generated proposal first, or import an existing collection.' };
    }
    const collection = await this.collectionBodyForSync(tests);
    const environment = enginePostman.exportEnvironment(this.project);
    const raw = {
      uid: this.settings.collectionId || `generated:${this.project.id}`,
      name: collection.info.name,
      source: this.client.available ? 'mcp' : 'generated',
      collection,
      environment: this.project.environment,
      workspace: this.settings.workspace,
      updatedAt: now(),
    };
    const stored = this.remember(raw, 'approved-sync');
    repo.update('projects', this.project.id, { postmanCollection: stored.uid, updatedAt: now() });
    if (!this.client.available || (this.settings.reuseExisting && this.settings.collectionId && !isRemoteCollectionId(this.settings.collectionId))) {
      return {
        ok: true,
        mcp: false,
        source: 'local',
        collectionId: stored.uid,
        name: stored.name,
        notice: this.settings.reuseExisting
          ? `Using existing collection “${stored.name}” on this project (not creating a new Postman collection).`
          : 'Approved tests were saved locally. Connect Postman MCP on Connections to push the collection and run it in Postman.',
      };
    }
    try {
      await this.client.ensure();
      const collectionId = await this.upsertCollection(collection, { idHint: this.settings.collectionId, name: collection.info.name });
      const environmentId = await this.upsertEnvironment(environment);
      this.persistMcpIds({ collectionId, environmentId });
      this.remember({ ...raw, uid: collectionId || raw.uid, source: 'mcp' }, 'approved-sync');
      return {
        ok: true,
        mcp: true,
        source: 'mcp',
        collectionId,
        environmentId,
        name: collection.info.name,
        notice: this.settings.reuseExisting
          ? `Updated existing Postman collection “${collection.info.name}” with ${tests.length} tests (original requests kept).`
          : `Synced ${tests.length} approved tests to Postman collection “${collection.info.name}”.`,
      };
    } catch (e) {
      return {
        ok: false,
        mcp: false,
        source: 'local',
        collectionId: stored.uid,
        name: stored.name,
        title: (e.explanation && e.explanation.title) || e.message,
        action: (e.explanation && e.explanation.action) || 'Verify Postman MCP URL/command and POSTMAN_<PREFIX>_API_KEY, then Test Postman.',
        notice: `Approved tests were saved locally. Postman MCP sync failed: ${(e.explanation && e.explanation.title) || e.message}`,
      };
    }
  }

  /**
   * Run selected tests through Postman MCP runCollection. Injects accessToken
   * into the Postman environment for the duration of the run, then wipes it.
   */
  async runApproved(testCases, { accessToken, runId } = {}) {
    if (!this.client.available) {
      throw new McpError('Postman MCP is not connected, so the platform runner will execute this request.', {
        action: 'Connect Postman MCP to run collections in Postman. Until then, tests execute in-app.',
      });
    }
    await this.client.ensure();
    if (!this.tool('runCollection')) {
      throw new McpError('The Postman MCP server has no runCollection tool.', {
        action: 'Use @postman/postman-mcp-server, or run tests in the platform.',
        evidence: (this.client.tools || []).map((t) => t.name),
      });
    }
    const collection = enginePostman.exportCollection(this.project, testCases);
    const environment = enginePostman.exportEnvironment(this.project);
    const workspace = await this.resolveWorkspace();
    const allApproved = repo.find('test_cases', "projectId = $p AND status != 'disabled' AND status != 'draft'", { p: this.project.id }, 'ORDER BY seq');
    const fullSuite = allApproved.length === testCases.length && testCases.every((t, i) => t.id === allApproved[i].id);
    let collectionId;
    if (this.settings.reuseExisting && isRemoteCollectionId(this.settings.collectionId) && fullSuite) {
      collectionId = this.settings.collectionId;
    } else if (this.settings.reuseExisting && this.settings.collectionId && !isRemoteCollectionId(this.settings.collectionId)) {
      throw new McpError('This project is using a local or imported collection, so the platform runner will execute it.', {
        action: 'Attach a Postman workspace collection on HTTP / Postman to run it in Postman without creating a new one.',
      });
    } else if (fullSuite) {
      collectionId = await this.upsertCollection(collection, { idHint: this.settings.collectionId, name: collection.info.name });
      this.persistMcpIds({ collectionId });
    } else {
      const runName = `${this.project.name} — QA platform run`;
      const runCol = { ...collection, info: { ...collection.info, name: runName } };
      collectionId = await this.upsertCollection(runCol, { idHint: this.settings.runCollectionId, name: runName });
      this.persistMcpIds({ runCollectionId: collectionId });
    }
    const environmentId = await this.upsertEnvironment(environment, { secrets: accessToken ? { accessToken } : undefined });
    if (environmentId) this.persistMcpIds({ environmentId });
    try {
      const raw = await this.mcpJson('runCollection', {
        collectionId,
        ...(environmentId ? { environmentId } : {}),
      }, { timeoutMs: this.settings.runTimeoutMs });
      const results = mcpHelp.mapMcpRunToResults(raw, testCases).map((r) => maskDeep(r));
      return { ok: true, collectionId, environmentId, workspace, runId, results, rawSummary: summariseMcp(raw) };
    } finally {
      try {
        if (environmentId && accessToken) await this.upsertEnvironment(environment);
      } catch { /* wipe is best-effort; collection itself never held the token */ }
    }
  }

  get available() {
    return this.client.available || this.project.mode === 'demo' || localFiles().length > 0 || Boolean(this.project.postmanCollection);
  }

  get canExecute() {
    return this.client.available;
  }

  unavailableExplanation() {
    return {
      code: 'POSTMAN_MCP_UNAVAILABLE',
      title: 'Postman MCP could not access the selected workspace.',
      cause: 'No Postman MCP URL/command is configured, and no local collections were found.',
      action: 'On Connections, set a Postman MCP URL or stdio command, or place Collection v2.1 JSON under api-tests/collections/. Verify workspace permissions.',
      category: 'configuration',
      evidence: [],
    };
  }

  async testConnection() {
    let names = [];
    try {
      names = [...new Set((await this.listCollections()).map((c) => c.name).filter(Boolean))];
    } catch {
      names = localFiles().map((c) => c.name).filter(Boolean);
    }
    const summary = { collections: names.length, collectionNames: names.slice(0, 20) };
    if (this.client.available) {
      try {
        const t0 = Date.now();
        const init = await this.client.ensure();
        return {
          ok: true,
          kind: 'mcp',
          status: 'CONNECTED',
          transport: this.settings.url ? 'http' : 'stdio',
          server: init && init.serverInfo,
          tools: this.client.tools.map((t) => t.name),
          workspace: this.settings.workspace || null,
          ms: Date.now() - t0,
          ...summary,
        };
      } catch (e) {
        if (names.length) {
          return {
            ok: true,
            kind: 'local',
            status: 'CONNECTED',
            note: 'Postman MCP did not respond; using local collections.',
            ...summary,
            mcpError: (e.explanation && e.explanation.title) || e.message,
          };
        }
        return { ok: false, status: 'ERROR', ...(e.explanation || { title: e.message, action: 'Verify the Postman MCP URL/command and workspace permissions.' }) };
      }
    }
    const files = localFiles();
    if (this.project.mode === 'demo' || files.length || names.length) {
      return {
        ok: true,
        kind: this.project.mode === 'demo' ? 'demo' : 'local',
        status: 'CONNECTED',
        note: this.project.mode === 'demo'
          ? 'Demo / local Postman collections are available for frontend HTTP API tests.'
          : 'Using local Postman collections. Connect a workspace to search Postman Cloud.',
        ...summary,
      };
    }
    return { ok: false, status: 'DISCONNECTED', ...this.unavailableExplanation() };
  }

  catalogEntry(raw) {
    const idx = indexCollection(raw.collection || raw);
    return {
      uid: raw.uid,
      name: raw.name || idx.name,
      source: raw.source,
      file: raw.file || null,
      workspace: raw.workspace || this.settings.workspace || (this.project.mode === 'demo' ? 'Demo workspace' : null),
      environment: raw.environment || this.settings.environment || this.project.environment,
      requestCount: idx.requests.length,
      folders: [...new Set(idx.requests.map((r) => r.folder).filter(Boolean))],
      variables: idx.variables,
      auth: idx.auth,
      requests: idx.requests.map((r) => ({ name: r.name, method: r.method, url: r.url, key: r.key, folder: r.folder })),
      updatedAt: raw.updatedAt || null,
      linked: Boolean(this.settings.collectionId && raw.uid === this.settings.collectionId),
    };
  }

  fromTests() {
    const tests = repo.find('test_cases', 'projectId = $p', { p: this.project.id }, 'ORDER BY seq');
    if (!tests.length) return null;
    const collection = enginePostman.exportCollection(this.project, tests);
    return {
      uid: `generated:${this.project.id}`,
      name: collection.info.name,
      source: 'generated',
      collection,
      environment: this.project.environment,
      updatedAt: now(),
    };
  }

  async listCollections() {
    const out = localFiles();
    const generated = this.fromTests();
    if (generated) out.push(generated);
    const stored = repo.find('collections', 'projectId = $p', { p: this.project.id });
    for (const row of stored) {
      if (out.some((x) => x.uid === row.uid)) continue;
      out.push({ uid: row.uid, name: row.name, source: row.source, collection: row.content, workspace: row.workspace, environment: row.environment, updatedAt: row.updatedAt });
    }
    if (this.client.available) {
      try {
        await this.client.ensure();
        const tool = this.client.findTool(/list.?collection|get.?collections|search.?collection/i);
        if (tool) {
          const data = toolJson(await this.client.callTool(tool.name, { workspace: this.settings.workspace || undefined }));
          const list = Array.isArray(data) ? data : data.collections || data.items || [];
          for (const c of list) {
            out.push({
              uid: c.uid || c.id || c.name,
              name: c.name,
              source: 'mcp',
              collection: c.collection || c,
              workspace: this.settings.workspace,
              updatedAt: c.updatedAt || c.updated || null,
            });
          }
        }
      } catch (e) {
        if (!out.length) throw e;
      }
    }
    return out.map((raw) => ({ ...this.catalogEntry(raw), _raw: raw }));
  }

  async search(query = {}) {
    const q = {
      project: query.project || this.project.name,
      org: query.org || this.project.sfOrg,
      environment: query.environment || this.project.environment,
      jiraProject: query.jiraProject || this.project.jiraProjectKey,
      story: query.story,
      api: query.api,
      endpoint: query.endpoint,
      tags: query.tags,
    };
    const list = await this.listCollections();
    return list
      .map((c) => ({ ...c, score: scoreMatch(c, q) }))
      .sort((a, b) => b.score - a.score);
  }

  async getCollection(uid) {
    return this.fetchCollection(uid);
  }

  collectionHasItems(raw) {
    const body = raw && (raw.collection || raw);
    return Boolean(body && Array.isArray(body.item));
  }

  async fetchCollection(uid) {
    const want = decodeURIComponent(String(uid || ''));
    if (this.client.available && this.tool('getCollection')) {
      try {
        await this.client.ensure();
        const data = await this.mcpJson('getCollection', { collectionId: want, uid: want });
        const body = (data && data.collection && data.collection.info) ? data.collection
          : (data && data.info) ? data
            : (data && data.collection) || data;
        if (body && body.info) {
          return {
            uid: mcpHelp.pickId(data) || want,
            name: body.info.name || want,
            source: 'mcp',
            collection: body,
            workspace: this.settings.workspace,
            updatedAt: now(),
          };
        }
      } catch { /* fall through to catalog */ }
    }
    const list = await this.listCollections();
    const hit = list.find((c) => c.uid === want || c.uid === uid || String(c.name) === want);
    if (!hit) {
      throw new McpError('Collection not found in the connected Postman workspace.', {
        action: 'Pick a collection from Discover, or import a Collection v2.1 file on HTTP / Postman.',
        evidence: [String(uid)],
      });
    }
    return hit._raw;
  }

  importDrafts(collection, { storyKey, skipExisting = true } = {}) {
    const { prioritise } = require('../engine/priority');
    const drafts = enginePostman.importCollection(collection);
    const existing = repo.find('test_cases', 'projectId = $p', { p: this.project.id });
    const keys = new Set(existing.map((t) => `${String(t.method).toUpperCase()} ${t.endpoint} ${t.title}`.toLowerCase()));
    let seq = existing.reduce((m, t) => Math.max(m, t.seq || 0), 0) + 100;
    const ids = [];
    for (const d of drafts) {
      const key = `${String(d.method).toUpperCase()} ${d.endpoint} ${d.title}`.toLowerCase();
      if (skipExisting && keys.has(key)) continue;
      keys.add(key);
      let id = nextId('TC', 5);
      while (repo.get('test_cases', id)) id = nextId('TC', 5);
      const pr = prioritise(d, { project: this.project });
      repo.insert('test_cases', {
        id, projectId: this.project.id, seq: seq += 10, ...d,
        storyKey: storyKey || null, priority: pr.priority, priorityReason: pr,
        status: 'ready', tags: [...new Set([...(d.tags || []), 'imported'])],
        extract: d.extract || [], automated: 1, createdAt: now(), updatedAt: now(),
      });
      ids.push(id);
    }
    return { imported: ids.length, skipped: drafts.length - ids.length, ids, total: drafts.length };
  }

  /**
   * Link an existing Postman (or local) collection to this project instead of creating one.
   */
  async attachExisting({ uid, collection, importTests = true, storyKey, variables, hints } = {}) {
    let raw;
    if (collection && typeof collection === 'object' && collection.info) {
      const id = uid || collection.info._postman_id || collection.info.uid || `imported:${this.project.id}:${collection.info.name || 'collection'}`;
      raw = { uid: id, name: collection.info.name, source: 'imported', collection, updatedAt: now() };
    } else if (uid) {
      raw = await this.fetchCollection(uid);
    } else {
      throw new McpError('Choose an existing Postman collection.', { action: 'Select a collection from the workspace list or import a v2.1 JSON file.' });
    }
    const body = raw.collection || raw;
    if (!body || !body.info) {
      throw new McpError('That collection could not be loaded as Collection v2.1 JSON.', {
        action: 'Export it from Postman as Collection v2.1, or grant getCollection on Postman MCP.',
      });
    }
    const stored = this.remember({ ...raw, collection: body }, 'attached-existing');
    const collectionId = raw.uid || stored.uid;
    this.persistMcpIds({ collectionId, reuseExisting: true });
    const { detectHints, persistHttpOrigin } = require('../engine/collection-import');
    const auto = detectHints(body, [], variables);
    const merged = {
      ...auto,
      ...(hints || {}),
      variables: { ...(auto.variables || {}), ...(variables || {}), ...((hints && hints.variables) || {}) },
      httpBaseUrl: (hints && hints.httpBaseUrl) || auto.httpBaseUrl,
      needsBearer: Boolean((hints && hints.needsBearer) || auto.needsBearer),
    };
    this.persistCollectionVars(merged.variables, merged);
    if (merged.httpBaseUrl) persistHttpOrigin(this.project, merged.httpBaseUrl);
    const leaked = auto.leakedToken || (hints && hints.leakedToken) || '';
    if (leaked && (config.host === '127.0.0.1' || config.host === 'localhost')) {
      const { upsertEnv } = require('../lib/dotenv-write');
      const { httpSecretPairs } = require('../engine/collection-import');
      upsertEnv(httpSecretPairs(this.project, { token: leaked, baseUrl: merged.httpBaseUrl }));
    }
    repo.update('projects', this.project.id, { postmanCollection: collectionId, updatedAt: now() });
    let imported = { imported: 0, skipped: 0, ids: [], total: 0 };
    if (importTests && Array.isArray(body.item)) {
      imported = this.importDrafts(body, { storyKey });
    }
    return {
      ok: true,
      mcp: this.client.available,
      reuseExisting: true,
      collectionId,
      name: body.info.name || stored.name,
      source: raw.source || stored.source,
      imported: imported.imported,
      skipped: imported.skipped,
      testIds: imported.ids,
      notice: imported.imported
        ? `Using existing collection “${body.info.name}”. Imported ${imported.imported} request(s) as tests for this project.`
        : `Using existing collection “${body.info.name}” for this project. Run will execute it in Postman when MCP is connected.`,
      httpBaseUrl: merged.httpBaseUrl || ((this.project.integrationConfig || {}).http || {}).baseUrl || null,
      needsBearer: merged.needsBearer,
      missingHttp: Boolean(
        enginePostman.importCollection(body).some((d) => d.apiType === 'HTTP')
        && !((this.project.integrationConfig || {}).http || {}).baseUrl
        && !merged.httpBaseUrl
      ),
    };
  }

  remember(raw, fingerprint) {
    const existing = repo.one('collections', 'projectId = $p AND uid = $u', { p: this.project.id, u: raw.uid });
    const row = {
      name: raw.name,
      workspace: raw.workspace || this.settings.workspace || null,
      environment: raw.environment || this.project.environment,
      source: raw.source,
      fingerprint: fingerprint || null,
      content: raw.collection,
      lastSyncedAt: now(),
      updatedAt: now(),
    };
    if (existing) {
      repo.update('collections', existing.id, row);
      return repo.get('collections', existing.id);
    }
    const rec = { id: nextId('COL', 4), projectId: this.project.id, uid: raw.uid, createdAt: now(), ...row };
    repo.insert('collections', rec);
    return rec;
  }

  async sendRequest(req) {
    if (!this.client.available) {
      throw new McpError('Postman MCP is not connected, so the platform runner will execute this request.', {
        action: 'Connect Postman MCP to run collections in Postman. Until then, tests execute in-app against Salesforce MCP/CLI or the demo simulator.',
      });
    }
    await this.client.ensure();
    const tool = this.client.findTool(/send.?request|run.?request|http.?request/i);
    if (!tool) {
      throw new McpError('The Postman MCP server has no request-execution tool.', {
        action: 'Use runCollection on the synced collection, or run tests in the platform (org OAuth).',
        evidence: this.client.tools.map((t) => t.name),
      });
    }
    return toolJson(await this.client.callTool(tool.name, {
      method: req.method,
      url: req.url || req.path,
      header: req.headers,
      body: req.body,
    }));
  }
}

function summariseMcp(raw) {
  const d = (raw && (raw.run || raw.result || raw)) || {};
  const s = d.stats || d.statistics || {};
  return { stats: s, failures: (d.failures || []).length };
}

function postmanFor(project, opts) {
  return new PostmanConnector(project, opts);
}

module.exports = { PostmanConnector, postmanFor, settingsFor, localFiles, DEFAULT_MCP_COMMAND, isRemoteCollectionId };
