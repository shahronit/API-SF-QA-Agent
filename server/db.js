'use strict';
/**
 * SQLite persistence (node:sqlite, built into Node 22+).
 * JSON columns are declared per table and transparently (de)serialised.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const DB_FILE = process.env.QA_DB_FILE || path.join(config.dataDir, 'qa-platform.db');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, sfOrg TEXT, environment TEXT NOT NULL,
  instanceUrl TEXT, apiVersion TEXT NOT NULL DEFAULT '62.0', mode TEXT NOT NULL DEFAULT 'demo',
  credentialRef TEXT, jiraProjectKey TEXT, jiraUrl TEXT, jiraCredentialRef TEXT,
  testDataConfig TEXT, integrationConfig TEXT, notificationConfig TEXT, businessConfig TEXT,
  postmanCollection TEXT, automationRepo TEXT, status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, summary TEXT NOT NULL, description TEXT, acceptanceCriteria TEXT,
  issueType TEXT, status TEXT, priority TEXT, sprint TEXT, components TEXT, labels TEXT,
  assignee TEXT, url TEXT, source TEXT NOT NULL DEFAULT 'jira', syncedAt TEXT,
  UNIQUE(projectId, key)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL, storyKey TEXT NOT NULL, status TEXT NOT NULL,
  analysis TEXT, scenarios TEXT, createdBy TEXT, createdAt TEXT NOT NULL, decidedAt TEXT, decision TEXT
);

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  storyKey TEXT, title TEXT NOT NULL, description TEXT, apiType TEXT, object TEXT,
  type TEXT NOT NULL, priority TEXT NOT NULL, priorityReason TEXT, status TEXT NOT NULL DEFAULT 'active',
  label TEXT NOT NULL DEFAULT 'ASSUMED', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_cases (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scenarioId TEXT, storyKey TEXT, seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL, description TEXT, apiType TEXT NOT NULL DEFAULT 'REST',
  method TEXT NOT NULL, endpoint TEXT NOT NULL, auth TEXT NOT NULL DEFAULT 'default',
  headers TEXT, query TEXT, body TEXT, bodyRaw TEXT, assertions TEXT, extract TEXT,
  sfValidation TEXT, contractRef TEXT, cleanup TEXT, timeoutMs INTEGER, object TEXT, testType TEXT NOT NULL, priority TEXT NOT NULL,
  priorityReason TEXT, status TEXT NOT NULL DEFAULT 'ready', label TEXT NOT NULL DEFAULT 'ASSUMED',
  tags TEXT, automated INTEGER NOT NULL DEFAULT 1, lastRunAt TEXT, lastResult TEXT, lastResponseMs INTEGER,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tc_project ON test_cases(projectId, seq);
CREATE INDEX IF NOT EXISTS ix_tc_story ON test_cases(projectId, storyKey);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment TEXT NOT NULL, user TEXT NOT NULL, label TEXT, trigger TEXT,
  status TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT,
  total INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
  apiErrors INTEGER NOT NULL DEFAULT 0, sfErrors INTEGER NOT NULL DEFAULT 0,
  avgResponseMs INTEGER, options TEXT, jiraActivity TEXT, summary TEXT, createdRecords TEXT
);
CREATE INDEX IF NOT EXISTS ix_runs_project ON runs(projectId, startedAt);

CREATE TABLE IF NOT EXISTS run_results (
  id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  projectId TEXT NOT NULL, testCaseId TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
  title TEXT, method TEXT, endpoint TEXT, apiType TEXT, testType TEXT, priority TEXT, storyKey TEXT,
  status TEXT NOT NULL, statusCode INTEGER, responseMs INTEGER, sizeBytes INTEGER,
  request TEXT, response TEXT, assertions TEXT, sfValidation TEXT, contract TEXT, error TEXT,
  analysis TEXT, correlationId TEXT, defectKey TEXT, startedAt TEXT, endedAt TEXT
);
CREATE INDEX IF NOT EXISTS ix_rr_run ON run_results(runId, seq);
CREATE INDEX IF NOT EXISTS ix_rr_tc ON run_results(testCaseId);

CREATE TABLE IF NOT EXISTS defects (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT, url TEXT, summary TEXT NOT NULL, description TEXT, severity TEXT, priority TEXT,
  status TEXT NOT NULL, labels TEXT, components TEXT, assignee TEXT,
  testCaseId TEXT, resultId TEXT, runId TEXT, storyKey TEXT, endpoint TEXT,
  createdBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, resolvedAt TEXT
);

CREATE TABLE IF NOT EXISTS test_data (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, category TEXT NOT NULL, object TEXT, storyKey TEXT, payload TEXT,
  notes TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_requests (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, collection TEXT, apiType TEXT, method TEXT, path TEXT,
  headers TEXT, query TEXT, body TEXT, auth TEXT, createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, spec TEXT NOT NULL, createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_jira (
  key TEXT PRIMARY KEY, projectKey TEXT NOT NULL, issueType TEXT, summary TEXT, description TEXT,
  status TEXT, priority TEXT, labels TEXT, components TEXT, assignee TEXT, sprint TEXT,
  acceptanceCriteria TEXT, comments TEXT, links TEXT, createdAt TEXT, updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, user TEXT, projectId TEXT,
  category TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit ON audit_log(projectId, ts);

CREATE TABLE IF NOT EXISTS workflow_state (
  projectId TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  currentStep TEXT NOT NULL, steps TEXT NOT NULL, updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uid TEXT NOT NULL, name TEXT NOT NULL, workspace TEXT, environment TEXT,
  source TEXT NOT NULL, fingerprint TEXT, content TEXT, lastSyncedAt TEXT,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  UNIQUE(projectId, uid)
);

CREATE TABLE IF NOT EXISTS collection_proposals (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collectionId TEXT, uid TEXT, status TEXT NOT NULL, diff TEXT, collection TEXT,
  createdBy TEXT, createdAt TEXT NOT NULL, decidedAt TEXT, decision TEXT
);

CREATE TABLE IF NOT EXISTS context_docs (
  id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, body TEXT, filePath TEXT,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
`;
db.exec(SCHEMA);

const JSON_FIELDS = {
  projects: ['testDataConfig', 'integrationConfig', 'notificationConfig', 'businessConfig'],
  stories: ['components', 'labels'],
  proposals: ['analysis', 'scenarios', 'decision'],
  scenarios: ['priorityReason'],
  test_cases: ['headers', 'query', 'body', 'assertions', 'extract', 'sfValidation', 'contractRef', 'cleanup', 'tags', 'priorityReason'],
  runs: ['options', 'jiraActivity', 'summary', 'createdRecords'],
  run_results: ['request', 'response', 'assertions', 'sfValidation', 'contract', 'error', 'analysis'],
  defects: ['labels', 'components'],
  test_data: ['payload'],
  saved_requests: ['headers', 'query', 'body'],
  contracts: ['spec'],
  demo_jira: ['labels', 'components', 'comments', 'links'],
  audit_log: ['detail'],
  workflow_state: ['steps'],
  collections: ['content'],
  collection_proposals: ['diff', 'collection', 'decision'],
};

function decode(table, row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of JSON_FIELDS[table] || []) {
    if (typeof out[f] === 'string') {
      try { out[f] = JSON.parse(out[f]); } catch { /* keep raw */ }
    }
  }
  return out;
}

function encodeValue(table, key, value) {
  if (value === undefined) return null;
  if ((JSON_FIELDS[table] || []).includes(key)) return value === null ? null : JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

const now = () => new Date().toISOString();

function all(sql, params = {}) {
  return db.prepare(sql).all(params);
}
function get(sql, params = {}) {
  return db.prepare(sql).get(params);
}
function run(sql, params = {}) {
  return db.prepare(sql).run(params);
}

/** Table-aware helpers. */
const repo = {
  insert(table, obj) {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '$' + k).join(',')})`;
    const params = {};
    for (const k of keys) params[k] = encodeValue(table, k, obj[k]);
    run(sql, params);
    return obj;
  },
  update(table, id, patch, idCol = 'id') {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && k !== idCol);
    if (!keys.length) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE ${idCol} = $__id`;
    const params = { __id: id };
    for (const k of keys) params[k] = encodeValue(table, k, patch[k]);
    run(sql, params);
  },
  get(table, id, idCol = 'id') {
    return decode(table, get(`SELECT * FROM ${table} WHERE ${idCol} = $id`, { id }));
  },
  find(table, where = '', params = {}, tail = '') {
    return all(`SELECT * FROM ${table} ${where ? 'WHERE ' + where : ''} ${tail}`, params).map((r) => decode(table, r));
  },
  one(table, where, params = {}) {
    return decode(table, get(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`, params));
  },
  remove(table, id, idCol = 'id') {
    run(`DELETE FROM ${table} WHERE ${idCol} = $id`, { id });
  },
  count(table, where = '', params = {}) {
    return get(`SELECT COUNT(*) AS n FROM ${table} ${where ? 'WHERE ' + where : ''}`, params).n;
  },
};

/** Sequential human-readable ids, e.g. TC-00042. */
function nextId(prefix, pad = 5) {
  const row = get('SELECT value FROM counters WHERE name = $n', { n: prefix });
  const value = (row ? row.value : 0) + 1;
  run('INSERT INTO counters (name, value) VALUES ($n, $v) ON CONFLICT(name) DO UPDATE SET value = $v', { n: prefix, v: value });
  return `${prefix}-${String(value).padStart(pad, '0')}`;
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function audit(category, action, { user, projectId, detail } = {}) {
  run('INSERT INTO audit_log (ts, user, projectId, category, action, detail) VALUES ($ts, $u, $p, $c, $a, $d)', {
    ts: now(), u: user || null, p: projectId || null, c: category, a: action, d: detail ? JSON.stringify(detail) : null,
  });
}

module.exports = { db, DB_FILE, all, get, run, repo, decode, nextId, now, transaction, audit, JSON_FIELDS };
