'use strict';
const crypto = require('node:crypto');
const { repo, now } = require('../db');

function shape(row) {
  if (!row) return row;
  return { ...row, values: row.envValues || row.values || [] };
}

function normalizeValues(values) {
  const rows = Array.isArray(values) ? values : Object.entries(values || {}).map(([key, value]) => ({ key, value, enabled: true, secret: false }));
  return rows.map((v) => ({
    key: String((v && v.key) || '').trim(),
    value: v && v.value !== undefined && v.value !== null ? String(v.value) : '',
    enabled: v && v.enabled === false ? false : true,
    secret: Boolean(v && (v.secret || v.type === 'secret')),
  })).filter((v) => v.key);
}

function valuesToMap(values) {
  const out = {};
  for (const v of normalizeValues(values)) if (v.enabled) out[v.key] = v.value;
  return out;
}

function list(projectId) {
  return repo.find('http_environments', 'projectId = $p', { p: projectId }, 'ORDER BY name').map(shape);
}

function active(projectId) {
  if (!projectId) return null;
  return shape(repo.one('http_environments', 'projectId = $p AND isActive = 1', { p: projectId }))
    || list(projectId)[0]
    || null;
}

function setActive(projectId, id) {
  for (const e of list(projectId)) repo.update('http_environments', e.id, { isActive: e.id === id ? 1 : 0, updatedAt: now() });
  return shape(repo.get('http_environments', id));
}

function create(projectId, body) {
  if (body.isActive) {
    for (const e of list(projectId)) repo.update('http_environments', e.id, { isActive: 0 });
  }
  const row = {
    id: crypto.randomUUID(),
    projectId,
    name: body.name || 'Environment',
    envValues: normalizeValues(body.values || body.envValues || []),
    isActive: body.isActive ? 1 : (list(projectId).length ? 0 : 1),
    createdAt: now(),
    updatedAt: now(),
  };
  repo.insert('http_environments', row);
  return shape(row);
}

function update(id, patch) {
  const row = repo.get('http_environments', id);
  if (!row) return null;
  const next = {
    name: patch.name !== undefined ? patch.name : row.name,
    envValues: patch.values !== undefined || patch.envValues !== undefined ? normalizeValues(patch.values || patch.envValues) : row.envValues,
    updatedAt: now(),
  };
  repo.update('http_environments', id, next);
  if (patch.isActive) setActive(row.projectId, id);
  return shape(repo.get('http_environments', id));
}

function duplicate(id) {
  const row = repo.get('http_environments', id);
  if (!row) return null;
  return create(row.projectId, { name: `${row.name} copy`, values: shape(row).values, isActive: false });
}

function remove(id) {
  const row = repo.get('http_environments', id);
  if (!row) return null;
  repo.remove('http_environments', id);
  if (row.isActive) {
    const rest = list(row.projectId);
    if (rest[0]) setActive(row.projectId, rest[0].id);
  }
  return { deleted: true };
}

function fromPostman(projectId, env) {
  let doc = env;
  if (typeof doc === 'string') doc = JSON.parse(doc);
  if (doc && doc.environment) doc = doc.environment;
  const values = (doc.values || doc.variable || []).map((v) => {
    const key = v.key || v.name;
    const secret = v.type === 'secret' || /token|secret|password|key|authorization|refresh|clientid|client_id|apikey|api[_-]?key/i.test(String(key || ''));
    return {
      key,
      value: v.value === undefined || v.value === null ? '' : String(v.value),
      enabled: v.enabled !== false && v.disabled !== true,
      secret,
    };
  });
  const name = doc.name || 'Imported';
  const existing = list(projectId).find((e) => String(e.name).toLowerCase() === String(name).toLowerCase());
  if (existing) return update(existing.id, { name, values, isActive: true });
  return create(projectId, { name, values, isActive: true });
}

function toPostman(env, project) {
  return {
    id: env.id,
    name: env.name || (project ? `${project.name} — ${project.environment}` : 'Environment'),
    values: normalizeValues(shape(env).values).map((v) => ({ key: v.key, value: v.secret ? '' : v.value, type: v.secret ? 'secret' : 'default', enabled: v.enabled })),
    _postman_variable_scope: 'environment',
  };
}

function collectionVars(collection) {
  const body = (collection && collection.content) || collection || {};
  const vars = body.variable || [];
  return valuesToMap(vars.map((v) => ({ key: v.key, value: v.value, enabled: v.disabled !== true && v.enabled !== false })));
}

function mergeVars({ project, environment, collection, local }) {
  const td = (project && project.testDataConfig && project.testDataConfig.variables) || {};
  return {
    ...td,
    ...collectionVars(collection),
    ...valuesToMap(environment && environment.values),
    ...(local || {}),
  };
}

module.exports = {
  normalizeValues, valuesToMap, list, active, setActive, create, update, duplicate, remove,
  fromPostman, toPostman, collectionVars, mergeVars,
};
