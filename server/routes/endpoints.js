'use strict';
/** Custom Apex REST / HTTP endpoint catalog for a project. */
const { route, HttpError } = require('../http');
const { repo, now, audit } = require('../db');
const { getProject } = require('./util');
const { salesforceFor } = require('../connectors');
const {
  listEndpoints, mergeEndpoints, normalizeEndpoint, discoverApexRest,
  fromOpenApi, fromPostmanDrafts, fromExplorer,
} = require('../engine/endpoints');
const { importCollection } = require('../engine/postman');
const { parse: parseContract } = require('../engine/contracts');

function persist(p, endpoints, user, action, extra = {}) {
  const ic = { ...(p.integrationConfig || {}), endpoints };
  repo.update('projects', p.id, { integrationConfig: ic, updatedAt: now() });
  audit('project', action, { user, projectId: p.id, detail: { count: endpoints.length, ...extra } });
  return listEndpoints({ ...p, integrationConfig: ic });
}

route('GET', '/api/projects/:id/endpoints', (ctx) => {
  const p = getProject(ctx.params.id);
  return { items: listEndpoints(p) };
});

route('PUT', '/api/projects/:id/endpoints', (ctx) => {
  const p = getProject(ctx.params.id);
  const raw = Array.isArray(ctx.body && ctx.body.endpoints) ? ctx.body.endpoints : (Array.isArray(ctx.body) ? ctx.body : null);
  if (!raw) throw new HttpError(400, 'Send { endpoints: [...] }.');
  const endpoints = raw.map((e) => normalizeEndpoint(e, { keepId: true })).filter(Boolean);
  return { items: persist(p, endpoints, ctx.user, 'endpoints.replaced', { saved: endpoints.length }) };
});

route('POST', '/api/projects/:id/endpoints', (ctx) => {
  const p = getProject(ctx.params.id);
  const incoming = [];
  if (ctx.body && ctx.body.path && !Array.isArray(ctx.body.endpoints)) {
    const one = fromExplorer(ctx.body);
    if (one) incoming.push(one);
  } else if (Array.isArray(ctx.body && ctx.body.endpoints)) incoming.push(...ctx.body.endpoints);
  else if (ctx.body && (ctx.body.path || ctx.body.name)) incoming.push(ctx.body);
  if (!incoming.length) return { items: listEndpoints(p), added: 0 };
  const { endpoints, added } = mergeEndpoints(listEndpoints(p), incoming);
  return { items: persist(p, endpoints, ctx.user, 'endpoints.upserted', { added }), added };
});

route('DELETE', '/api/projects/:id/endpoints/:eid', (ctx) => {
  const p = getProject(ctx.params.id);
  const endpoints = listEndpoints(p).filter((e) => e.id !== ctx.params.eid);
  return { items: persist(p, endpoints, ctx.user, 'endpoints.deleted', { id: ctx.params.eid }) };
});

route('POST', '/api/projects/:id/endpoints/discover', async (ctx) => {
  const p = getProject(ctx.params.id);
  const sf = salesforceFor(p);
  let found = [];
  try {
    found = await discoverApexRest(sf, p);
  } catch (e) {
    throw new HttpError(502, e.explanation ? e.explanation.title : e.message, e.explanation || {});
  }
  if (ctx.body && ctx.body.apply) {
    const { endpoints, added } = mergeEndpoints(listEndpoints(p), found);
    return { items: persist(p, endpoints, ctx.user, 'endpoints.discovered', { found: found.length, added }), found: found.length, added };
  }
  return { items: found, found: found.length, added: 0 };
});

route('POST', '/api/projects/:id/endpoints/from-openapi', (ctx) => {
  const p = getProject(ctx.params.id);
  let spec = ctx.body && (ctx.body.spec || ctx.body.content);
  if (!spec && ctx.body && ctx.body.contractId) {
    const c = repo.get('contracts', ctx.body.contractId);
    if (!c || c.projectId !== p.id) throw new HttpError(404, 'Contract not found on this project.');
    spec = c.spec;
  }
  if (!spec) throw new HttpError(400, 'Paste an OpenAPI/Swagger document or pass contractId.');
  let found;
  try {
    found = fromOpenApi(typeof spec === 'string' ? spec : spec);
  } catch (e) {
    try {
      const parsed = parseContract(typeof spec === 'string' ? spec : JSON.stringify(spec));
      found = fromOpenApi(parsed.spec);
    } catch (err) {
      throw new HttpError(400, `Could not read the specification: ${e.message}`, { action: 'Upload OpenAPI 3 or Swagger 2 (JSON or YAML).' });
    }
  }
  if (ctx.body && ctx.body.apply === false) return { items: found, found: found.length, added: 0 };
  const { endpoints, added } = mergeEndpoints(listEndpoints(p), found);
  return { items: persist(p, endpoints, ctx.user, 'endpoints.from-openapi', { found: found.length, added }), found: found.length, added };
});

route('POST', '/api/projects/:id/endpoints/from-postman', async (ctx) => {
  const p = getProject(ctx.params.id);
  let drafts = [];
  if (ctx.body && ctx.body.collection) {
    try { drafts = importCollection(ctx.body.collection); } catch (e) {
      throw new HttpError(400, e.message);
    }
  } else {
    const stored = repo.find('collections', 'projectId = $p', { p: p.id });
    for (const row of stored) {
      if (!row.content) continue;
      try { drafts.push(...importCollection(row.content)); } catch { /* skip bad rows */ }
    }
  }
  const found = fromPostmanDrafts(drafts);
  if (ctx.body && ctx.body.apply === false) return { items: found, found: found.length, added: 0 };
  const { endpoints, added } = mergeEndpoints(listEndpoints(p), found);
  return { items: persist(p, endpoints, ctx.user, 'endpoints.from-postman', { found: found.length, added }), found: found.length, added };
});

module.exports = { persist };
