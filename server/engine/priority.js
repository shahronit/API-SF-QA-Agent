'use strict';
/**
 * Risk-based test prioritisation. Seven factors scored 0–3, weighted, mapped
 * to P0–P3. The explanation is stored with each test so priority is auditable.
 */
const { get } = require('../db');

const WEIGHTS = {
  businessCriticality: 3,
  apiCriticality: 2,
  productionUsage: 2,
  defectHistory: 2,
  integrationDependency: 2,
  dataSensitivity: 1.5,
  changeImpact: 1.5,
};
const MAX = Object.values(WEIGHTS).reduce((a, b) => a + b * 3, 0);

const PII = /(email|phone|mobile|birth|ssn|social|tax|passport|salary|address|iban|card)/i;

/**
 * @param {object} t   test case-like { method, endpoint, testType, body, apiType, object }
 * @param {object} ctx { project, story, objectsInScope }
 */
function prioritise(t, ctx = {}) {
  const { project = {}, story = {} } = ctx;
  const business = (project.businessConfig || {});
  const f = {};

  // Business criticality: story priority + business-critical objects configured on the project.
  const sp = String(story.priority || '').toLowerCase();
  f.businessCriticality = /highest|blocker|critical/.test(sp) ? 3 : /high/.test(sp) ? 2 : /low|lowest/.test(sp) ? 0 : 1;
  if ((business.criticalObjects || []).includes(t.object)) f.businessCriticality = Math.max(f.businessCriticality, 3);

  // API criticality: writes and auth paths are more critical than reads.
  const m = String(t.method || 'GET').toUpperCase();
  f.apiCriticality = t.testType === 'Authentication' ? 3 : ['POST', 'PATCH', 'PUT'].includes(m) ? 2 : m === 'DELETE' ? 2 : 1;
  if (t.testType === 'Functional' && ['POST', 'PATCH'].includes(m)) f.apiCriticality = 3;

  // Production usage: configured high-traffic endpoints/objects.
  f.productionUsage = (business.highTrafficObjects || []).includes(t.object) ? 3 : (business.highTrafficObjects || []).length ? 1 : 2;

  // Defect history: defects previously raised against this endpoint.
  let defects = 0;
  try {
    const key = String(t.endpoint || '').replace(/\{\{[^}]+\}\}/g, '%').split('?')[0];
    defects = get('SELECT COUNT(*) AS n FROM defects WHERE projectId = $p AND endpoint LIKE $e', { p: project.id || '', e: key }).n;
  } catch { defects = 0; }
  f.defectHistory = defects >= 3 ? 3 : defects === 2 ? 2 : defects === 1 ? 1 : 0;

  // Integration dependency
  f.integrationDependency = t.testType === 'Integration' || /apexrest|composite|jobs\/ingest/i.test(t.endpoint || '') ? 3 : 1;

  // Data sensitivity: PII in payload or endpoint
  const payload = JSON.stringify(t.body || '') + (t.endpoint || '');
  f.dataSensitivity = PII.test(payload) ? 3 : t.testType === 'Security' ? 3 : 1;

  // Change impact: stories in the active sprint / changed objects
  f.changeImpact = story.sprint && /active|current/i.test(String(story.sprintState || 'active')) ? 2 : 1;
  if (ctx.changedObjects && ctx.changedObjects.includes(t.object)) f.changeImpact = 3;

  const score = Object.entries(f).reduce((s, [k, v]) => s + v * WEIGHTS[k], 0);
  const pct = Math.round((score / MAX) * 100);
  let priority = pct >= 72 ? 'P0' : pct >= 58 ? 'P1' : pct >= 42 ? 'P2' : 'P3';
  // Guard-rails: negative/boundary tests rarely outrank the happy path they protect.
  if (['Boundary'].includes(t.testType) && priority === 'P0') priority = 'P1';
  if (t.testType === 'Functional' && ['POST', 'PATCH'].includes(m) && (priority === 'P2' || priority === 'P3')) priority = 'P1';
  if (t.testType === 'Authentication' && priority !== 'P0') priority = 'P0';
  return { priority, score: pct, factors: f, weights: WEIGHTS };
}

module.exports = { prioritise, WEIGHTS };
