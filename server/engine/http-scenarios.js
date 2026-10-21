'use strict';
/**
 * Frontend HTTP / Postman scenarios: smoke the configured base URL and
 * promote matching collection requests into the same executable suite.
 */
const { importCollection } = require('./postman');
const { repo } = require('../db');
const { localFiles } = require('../connectors/postman');

function httpCfg(project) {
  return ((project && project.integrationConfig) || {}).http || {};
}

function storyBlob(story) {
  return `${story.summary || ''} ${story.description || ''} ${story.acceptanceCriteria || ''}`.toLowerCase();
}

function collectionsFor(project) {
  const out = [];
  try {
    for (const row of repo.find('collections', 'projectId = $p', { p: project.id })) {
      if (row.content) out.push({ name: row.name, collection: row.content, source: row.source });
    }
  } catch { /* db not ready in unit tests */ }
  try {
    for (const f of localFiles()) out.push({ name: f.name, collection: f.collection, source: 'local' });
  } catch { /* no files */ }
  return out;
}

function draftsFromCollections(project, story) {
  const blob = storyBlob(story);
  const drafts = [];
  for (const col of collectionsFor(project)) {
    let items;
    try { items = importCollection(col.collection); } catch { continue; }
    for (const d of items) {
      const hay = `${d.title} ${d.endpoint} ${d.apiType}`.toLowerCase();
      const hit = !blob.trim() || blob.split(/\s+/).filter((w) => w.length > 4).some((w) => hay.includes(w));
      if (!hit && d.apiType !== 'HTTP') continue;
      if (d.apiType === 'HTTP' || d.apiType === 'OCAPI' || d.apiType === 'SCAPI' || hit) {
        drafts.push({ ...d, collectionName: col.name });
      }
    }
  }
  return drafts.slice(0, 25);
}

function httpScenarios(b, analysis) {
  const project = b.project;
  const cfg = httpCfg(project);
  const base = String(cfg.baseUrl || '').replace(/\/$/, '');
  const drafts = draftsFromCollections(project, b.story);
  const httpDrafts = drafts.filter((d) => d.apiType === 'HTTP' || (!/\/services\//.test(d.endpoint) && !/\/dw\//.test(d.endpoint)));

  if (base) {
    const s = b.scenario('Frontend HTTP — base URL smoke', 'Functional', 'HTTP', null, `Live GET against the configured frontend origin ${base}.`);
    b.add(s, {
      apiType: 'HTTP', title: `GET ${base}/ (frontend origin)`, method: 'GET', endpoint: `${base}/`,
      assertions: [{ type: 'status', op: 'lt', expected: 500 }, { type: 'responseTime', op: 'lt', expected: b.sla }],
      tags: ['frontend', 'http-smoke'],
    });
    b.add(s, {
      apiType: 'HTTP', testType: 'Security', title: 'Frontend origin without a bearer token', method: 'GET', endpoint: `${base}/`,
      auth: 'none', assertions: [{ type: 'status', op: 'in', expected: [200, 401, 403] }],
      tags: ['frontend', 'authentication'],
    });
  } else if (httpDrafts.length === 0 && analysis.apiTypes.some((t) => /HTTP|Postman/i.test(t))) {
    analysis.gaps.push({ label: 'RECOMMENDED', text: 'Story mentions a frontend/HTTP API but no base URL or collection request was found. Set Connections → Postman / HTTP base URL or import a collection.' });
  }

  if (httpDrafts.length) {
    const s = b.scenario('Frontend HTTP / Postman — collection requests', 'Integration', 'HTTP', null, 'Executable requests taken from imported or local Postman collections (same runner as Salesforce tests).');
    for (const d of httpDrafts.slice(0, 15)) {
      b.add(s, {
        apiType: d.apiType === 'REST' ? 'HTTP' : d.apiType,
        title: d.title,
        method: d.method,
        endpoint: d.endpoint,
        query: d.query || {},
        headers: d.headers || {},
        body: d.body,
        bodyRaw: d.bodyRaw,
        auth: d.auth || 'default',
        assertions: d.assertions && d.assertions.length ? d.assertions : [{ type: 'status', op: 'lt', expected: 400 }],
        tags: ['frontend', 'imported'],
        description: d.description,
      });
    }
  }
}

module.exports = { httpScenarios, draftsFromCollections, httpCfg };
