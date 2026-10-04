'use strict';
/**
 * Optional AI assistance via the Anthropic Messages API. Disabled unless both
 * ANTHROPIC_API_KEY and AI_MODEL are set. Inputs are masked before sending,
 * and outputs are always labelled RECOMMENDED — never treated as verified facts.
 */
const { config } = require('../config');
const { maskDeep } = require('../lib/mask');

function enabled() { return config.ai.enabled; }

async function complete(system, user, maxTokens = 900) {
  if (!enabled()) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.ai.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`AI request failed with HTTP ${res.status}`);
  const data = await res.json();
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function parseJsonArray(text) {
  if (!text) return null;
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function suggestCoverage(story, analysis, scenarios) {
  const payload = maskDeep({
    story: { key: story.key, summary: story.summary, description: String(story.description || '').slice(0, 4000), acceptanceCriteria: String(story.acceptanceCriteria || '').slice(0, 3000) },
    detected: { objects: analysis.objects, operations: analysis.operations, integration: analysis.integration },
    existing: scenarios.map((s) => ({ title: s.title, tests: s.testCases.map((t) => t.title) })),
  });
  const text = await complete(
    'You are a senior Salesforce API QA engineer. Identify missing API test coverage only. Do not invent Salesforce object or field names that are not in the input. Reply with a JSON array of at most 6 short strings.',
    JSON.stringify(payload),
  );
  const arr = parseJsonArray(text);
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, 6) : null;
}

async function summariseRun(run, failures) {
  const payload = maskDeep({
    run: { id: run.id, total: run.total, passed: run.passed, failed: run.failed, blocked: run.blocked, environment: run.environment },
    failures: failures.slice(0, 15).map((f) => ({ title: f.title, endpoint: f.endpoint, status: f.statusCode, analysis: f.analysis && f.analysis.rootCause })),
  });
  return complete(
    'You are a Salesforce QA lead. Write a 4-sentence execution summary for stakeholders: overall health, the most important failures, likely root causes (state uncertainty explicitly), and the recommended next action. No markdown.',
    JSON.stringify(payload), 400,
  );
}

module.exports = { enabled, suggestCoverage, summariseRun };
