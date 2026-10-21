'use strict';
/**
 * Optional Cursor/Gemini CLI generation on top of the deterministic engine.
 * Always keeps generateSuite as the executable baseline. CLI extras that name
 * Salesforce objects/fields not in describe are dropped or labelled ASSUMED/RECOMMENDED.
 */
const fs = require('node:fs');
const path = require('node:path');
const { generateSuite } = require('./generator');
const { normalizeSalesforcePath } = require('../connectors/salesforce-org');
const { maskDeep } = require('../lib/mask');
const { cursorFor } = require('../connectors/cursor-cli');
const { geminiFor } = require('../connectors/gemini-cli');
const { config } = require('../config');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const DOC_BODY_MAX = 8000;
const PACK_DOC_MAX = 4000;
const PACK_STORY_DESC = 4000;
const PACK_STORY_AC = 3000;

function scriptGeneratorPref(project) {
  const v = ((project && project.integrationConfig) || {}).scriptGenerator || 'auto';
  return ['auto', 'cursor', 'gemini', 'engine'].includes(v) ? v : 'auto';
}

function pickCliOrder(project) {
  const pref = scriptGeneratorPref(project);
  if (pref === 'engine') return [];
  if (pref === 'cursor') return ['cursor'];
  if (pref === 'gemini') return ['gemini'];
  const order = [];
  if (cursorFor(project).wanted) order.push('cursor');
  if (geminiFor(project).wanted) order.push('gemini');
  return order;
}

function looksLikeSecretText(s) {
  const t = String(s || '');
  if (!t) return false;
  if (/\b(CURSOR_API_KEY|GEMINI_API_KEY|CLIENT_SECRET|API_TOKEN)\s*=/i.test(t)) return true;
  if (/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-]{20,}/.test(t)) return true;
  if (/\bATATT[A-Za-z0-9_\-=]{20,}/.test(t)) return true;
  return false;
}

function looksLikeSecretPath(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  return base === '.env' || base.endsWith('.pem') || base.endsWith('.key') || /credential|id_rsa|secret/.test(base);
}

function safeLocalPath(filePath) {
  if (!filePath) return null;
  const raw = String(filePath).trim();
  if (!raw || /^https?:\/\//i.test(raw) || raw.includes('\0')) return null;
  const resolved = path.resolve(raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw) ? raw : path.join(config.root, raw));
  const home = require('node:os').homedir();
  const allowed = [config.root, home].some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!allowed) return null;
  if (looksLikeSecretPath(resolved)) return null;
  return resolved;
}

function readLocalDocFile(filePath) {
  const resolved = safeLocalPath(filePath);
  if (!resolved) return null;
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile() || st.size > 200 * 1024) return null;
    const body = fs.readFileSync(resolved, 'utf8').slice(0, DOC_BODY_MAX);
    if (looksLikeSecretText(body)) return null;
    return body;
  } catch { return null; }
}

function extractJsonValue(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const attempts = [candidate];
  const firstObj = candidate.match(/\{[\s\S]*\}/);
  if (firstObj) attempts.push(firstObj[0]);
  for (const chunk of attempts) {
    try {
      const parsed = JSON.parse(chunk);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* next */ }
  }
  return null;
}

function unwrapCliJson(raw) {
  const parsed = extractJsonValue(String(raw || ''));
  if (!parsed) return null;
  if (Array.isArray(parsed.scenarios) || Array.isArray(parsed.testCases)) return parsed;
  const nestedKeys = ['result', 'response', 'text', 'output', 'content', 'message'];
  for (const k of nestedKeys) {
    const v = parsed[k];
    if (typeof v === 'string') {
      const inner = extractJsonValue(v);
      if (inner && (Array.isArray(inner.scenarios) || Array.isArray(inner.testCases))) return inner;
    }
    if (v && typeof v === 'object' && (Array.isArray(v.scenarios) || Array.isArray(v.testCases))) return v;
  }
  if (Array.isArray(parsed) && parsed.length) {
    const last = parsed[parsed.length - 1];
    if (last && typeof last === 'object') return unwrapCliJson(JSON.stringify(last.result || last));
  }
  return parsed;
}

function knownCatalog(engine) {
  const objects = new Set(engine.analysis.objects || []);
  const fields = {};
  const describes = engine.analysis.describes || {};
  for (const [name, d] of Object.entries(describes)) {
    objects.add(name);
    const names = new Set();
    if (Array.isArray(d.requiredFields)) d.requiredFields.forEach((f) => names.add(f));
    if (Array.isArray(d.fields)) d.fields.forEach((f) => names.add(typeof f === 'string' ? f : f.name));
    fields[name] = names;
  }
  for (const [obj, list] of Object.entries(engine.analysis.fields || {})) {
    fields[obj] = fields[obj] || new Set();
    (list || []).forEach((f) => fields[obj].add(f));
  }
  return { objects, fields };
}

function isLikelySObject(name) {
  return typeof name === 'string' && /^[A-Z][A-Za-z0-9]+(__[cme])?$/.test(name);
}

function normalizeAssertion(a) {
  if (!a || typeof a !== 'object') return null;
  const type = String(a.type || a.kind || '').trim();
  if (!type) return null;
  return {
    type,
    op: a.op || a.operator || 'eq',
    expected: a.expected !== undefined ? a.expected : a.value,
    path: a.path,
    name: a.name,
  };
}

function normalizeTestCase(tc, scenario, invented) {
  if (!tc || typeof tc !== 'object') return null;
  const method = String(tc.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) return null;
  let endpoint = String(tc.endpoint || tc.path || '').trim();
  if (/^https?:\/\//i.test(endpoint) || endpoint.startsWith('/')) endpoint = normalizeSalesforcePath(endpoint);
  if (!endpoint.startsWith('/')) return null;
  const assertions = (Array.isArray(tc.assertions) ? tc.assertions : []).map(normalizeAssertion).filter(Boolean);
  if (!assertions.length) assertions.push({ type: 'status', op: 'eq', expected: method === 'POST' ? 201 : 200 });
  let label = tc.label || scenario.label || 'ASSUMED';
  const object = tc.object || scenario.object || null;
  if (invented.objects.has(object)) label = label === 'VERIFIED' ? 'ASSUMED' : (label || 'ASSUMED');
  if (invented.fields.length) label = 'RECOMMENDED';
  return {
    title: String(tc.title || `${method} ${endpoint}`).slice(0, 200),
    description: tc.description || null,
    apiType: tc.apiType || scenario.apiType || 'REST',
    method,
    endpoint,
    auth: tc.auth || 'default',
    headers: tc.headers && typeof tc.headers === 'object' ? tc.headers : {},
    query: tc.query && typeof tc.query === 'object' ? tc.query : {},
    body: tc.body === undefined ? null : tc.body,
    bodyRaw: tc.bodyRaw || null,
    assertions,
    extract: Array.isArray(tc.extract) ? tc.extract : [],
    sfValidation: tc.sfValidation || null,
    cleanup: tc.cleanup || null,
    timeoutMs: tc.timeoutMs || null,
    object,
    testType: tc.testType || scenario.type || 'Functional',
    priority: tc.priority || scenario.priority || 'P2',
    status: 'ready',
    label,
    tags: Array.isArray(tc.tags) ? tc.tags : [],
  };
}

function inventedFieldNames(body, object, catalog) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !object) return [];
  const known = catalog.fields[object];
  if (!known || !known.size) return [];
  return Object.keys(body).filter((k) => k !== 'attributes' && !known.has(k) && /__[c]$/.test(k));
}

function sanitizeCliProposal(parsed, engine) {
  const catalog = knownCatalog(engine);
  const notes = [];
  const dropped = [];
  const rawScenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios
    : Array.isArray(parsed.testCases) ? [{ title: 'CLI scenarios', type: 'Functional', apiType: 'REST', object: null, testCases: parsed.testCases }]
      : [];
  const scenarios = [];
  for (const s of rawScenarios) {
    if (!s || typeof s !== 'object') continue;
    const object = s.object || null;
    const inventedObj = object && isLikelySObject(object) && !catalog.objects.has(object);
    if (inventedObj) {
      dropped.push(object);
      notes.push({ label: 'RECOMMENDED', text: `Dropped CLI scenario “${s.title || object}”: object ${object} is not in Salesforce describe. Named ASSUMED/RECOMMENDED only — executable cases stay on describe or the built-in engine.` });
      continue;
    }
    const tests = [];
    for (const tc of s.testCases || []) {
      const invented = { objects: new Set(inventedObj ? [object] : []), fields: inventedFieldNames(tc && tc.body, tc && (tc.object || object), catalog) };
      if (invented.fields.length) {
        notes.push({ label: 'ASSUMED', text: `CLI test “${tc.title || ''}” named field(s) ${invented.fields.join(', ')} not in describe — labelled RECOMMENDED.` });
      }
      const norm = normalizeTestCase(tc, s, invented);
      if (norm) tests.push(norm);
    }
    if (!tests.length) continue;
    scenarios.push({
      title: String(s.title || 'CLI scenario').slice(0, 200),
      description: s.description || '',
      apiType: s.apiType || 'REST API',
      object,
      type: s.type || 'Functional',
      priority: s.priority || tests[0].priority || 'P2',
      label: inventedObj ? 'RECOMMENDED' : (s.label || engine.analysis.metadataLabel || 'ASSUMED'),
      testCases: tests,
    });
  }
  return { scenarios, notes, dropped };
}

function testKey(t) {
  return `${String(t.method || '').toUpperCase()} ${t.endpoint} ${t.title}`.toLowerCase();
}

function mergeWithEngine(cliScenarios, engine) {
  const seen = new Set();
  const out = [];
  for (const s of engine.scenarios || []) {
    out.push(s);
    for (const t of s.testCases || []) seen.add(testKey(t));
  }
  for (const s of cliScenarios) {
    const fresh = (s.testCases || []).filter((t) => !seen.has(testKey(t)));
    if (!fresh.length) continue;
    fresh.forEach((t) => seen.add(testKey(t)));
    const existing = out.find((x) => x.title === s.title && x.object === s.object && x.type === s.type);
    if (existing) existing.testCases.push(...fresh);
    else out.push({ ...s, testCases: fresh });
  }
  return out;
}

function describeSnippets(engine) {
  const describes = engine.analysis.describes || {};
  const out = {};
  for (const [name, d] of Object.entries(describes)) {
    out[name] = {
      name: d.name || name,
      label: d.label || name,
      requiredFields: d.requiredFields || (Array.isArray(d.fields) ? d.fields.filter((f) => f.required).map((f) => f.name) : []),
      fieldCount: d.fieldCount || (Array.isArray(d.fields) ? d.fields.length : 0),
    };
  }
  return out;
}

function buildContextPack({ project, story, engine, docs }) {
  const pack = {
    instruction: [
      'Propose Salesforce/HTTP API test scenarios as JSON only.',
      'Shape: {"scenarios":[{"title","type","apiType","object","description","label","testCases":[{"title","method","endpoint","apiType","testType","object","assertions":[{"type","op","expected"}],"body","query"}]}]}',
      'Use only Salesforce object and field names listed under describe. Do not invent object or field names.',
      'If you need a name that is not listed, omit that case (the built-in engine already covers executable defaults).',
      'Jira story is the primary context. Integration docs are additional.',
      'Do not include secrets, tokens, or credentials.',
    ].join(' '),
    story: {
      key: story.key,
      summary: story.summary,
      description: String(story.description || '').slice(0, PACK_STORY_DESC),
      acceptanceCriteria: String(story.acceptanceCriteria || '').slice(0, PACK_STORY_AC),
    },
    project: { id: project.id, name: project.name, environment: project.environment, apiVersion: project.apiVersion },
    describe: describeSnippets(engine),
    detected: { objects: engine.analysis.objects, operations: engine.analysis.operations, apiTypes: engine.analysis.apiTypes },
    docs: (docs || []).map((d) => ({ name: d.name, body: String(d.body || '').slice(0, PACK_DOC_MAX) })),
  };
  return maskDeep(pack);
}

function buildPrompt(pack) {
  return `You are a Salesforce API QA engineer. Reply with a single JSON object only (no markdown).\n${JSON.stringify(pack)}`;
}

async function generateProposedSuite({ project, story, sf, docs = [] }) {
  const engine = await generateSuite({ project, story, sf });
  const notes = [];
  const order = pickCliOrder(project);
  for (const tool of order) {
    const adapter = tool === 'cursor' ? cursorFor(project) : geminiFor(project);
    const source = tool === 'cursor' ? 'cursor-cli' : 'gemini-cli';
    if (!adapter.available) {
      const ex = adapter.unavailableExplanation();
      notes.push({ label: 'ASSUMED', text: `${ex.title} ${ex.action} Falling back to the built-in engine.` });
      continue;
    }
    const login = await adapter.whoami();
    if (!login.loggedIn) {
      const ex = adapter.unavailableExplanation();
      notes.push({ label: 'ASSUMED', text: `${ex.title} ${ex.action} Falling back to the built-in engine.` });
      continue;
    }
    try {
      const pack = buildContextPack({ project, story, engine, docs });
      const raw = await adapter.generate(buildPrompt(pack));
      const parsed = unwrapCliJson(raw);
      if (!parsed) {
        notes.push({ label: 'ASSUMED', text: `${source} did not return valid JSON. Using the built-in engine.` });
        continue;
      }
      const sanitized = sanitizeCliProposal(parsed, engine);
      const scenarios = mergeWithEngine(sanitized.scenarios, engine);
      return {
        analysis: {
          ...engine.analysis,
          generator: source,
          notes: [...(engine.analysis.notes || []), ...notes, ...sanitized.notes],
        },
        scenarios,
        source,
      };
    } catch (e) {
      notes.push({ label: 'ASSUMED', text: `${e.title || e.message} Falling back to the built-in engine.` });
    }
  }
  return {
    analysis: {
      ...engine.analysis,
      generator: 'engine',
      notes: [...(engine.analysis.notes || []), ...notes],
    },
    scenarios: engine.scenarios,
    source: 'engine',
  };
}

async function analyzeRunWithCli(project, run, failures) {
  const order = pickCliOrder(project);
  const payload = maskDeep({
    instruction: 'You are a Salesforce/HTTP API QA engineer. Propose root causes for these masked failures. Do not invent Salesforce object or field names. Reply JSON: {"notes":["..."]}',
    run: { id: run.id, environment: run.environment, failed: run.failed, blocked: run.blocked, total: run.total },
    failures: (failures || []).slice(0, 12).map((f) => ({
      title: f.title, method: f.method, endpoint: f.endpoint, status: f.statusCode,
      rootCause: f.analysis && f.analysis.rootCause, category: f.analysis && f.analysis.category,
    })),
  });
  const prompt = `Reply with a single JSON object only.\n${JSON.stringify(payload)}`;
  for (const tool of order) {
    const adapter = tool === 'cursor' ? cursorFor(project) : geminiFor(project);
    if (!adapter.available) continue;
    const login = await adapter.whoami().catch(() => ({ loggedIn: false }));
    if (!login.loggedIn) continue;
    try {
      const raw = await adapter.generate(prompt);
      const parsed = unwrapCliJson(raw) || extractJsonValue(String(raw || ''));
      const notes = parsed && Array.isArray(parsed.notes) ? parsed.notes.filter((x) => typeof x === 'string').slice(0, 8)
        : parsed && Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(0, 8) : null;
      if (notes && notes.length) return { source: tool === 'cursor' ? 'cursor-cli' : 'gemini-cli', notes };
    } catch { /* next tool */ }
  }
  return null;
}

module.exports = {
  generateProposedSuite, pickCliOrder, scriptGeneratorPref, unwrapCliJson, sanitizeCliProposal,
  mergeWithEngine, buildContextPack, safeLocalPath, readLocalDocFile, looksLikeSecretText, looksLikeSecretPath,
  analyzeRunWithCli,
};
