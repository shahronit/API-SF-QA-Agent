'use strict';
/**
 * Run-to-run comparison, flaky-test detection and CI quality gates.
 * Everything here is derived from stored run_results — no re-execution.
 */
const { all, get } = require('../db');

const FINAL = "status IN ('completed','stopped')";

function resultsByTest(runId) {
  const map = new Map();
  for (const r of all('SELECT testCaseId, title, method, endpoint, priority, testType, status, statusCode, responseMs FROM run_results WHERE runId = $r ORDER BY seq', { r: runId })) {
    // A test can appear twice when a dependency was pulled in; the last result is the one that counts.
    map.set(r.testCaseId, r);
  }
  return map;
}

/** Previous finished run of the same project that shares at least one test with `run`. */
function previousRun(run) {
  const candidates = all(`SELECT id FROM runs WHERE projectId = $p AND ${FINAL} AND startedAt < $t ORDER BY startedAt DESC LIMIT 20`, { p: run.projectId, t: run.startedAt });
  for (const c of candidates) {
    const shared = get('SELECT COUNT(*) AS n FROM run_results a JOIN run_results b ON a.testCaseId = b.testCaseId WHERE a.runId = $a AND b.runId = $b', { a: run.id, b: c.id });
    if (shared && shared.n > 0) return c.id;
  }
  return null;
}

const brief = (r) => ({ testCaseId: r.testCaseId, title: r.title, endpoint: `${r.method} ${r.endpoint}`, priority: r.priority, status: r.status, statusCode: r.statusCode, responseMs: r.responseMs });

/**
 * Compare `runId` against `baselineId` (or the previous comparable run).
 * Latency regression: ≥50% slower and ≥200 ms slower than the baseline.
 */
function compareRuns(runId, baselineId) {
  const run = get('SELECT * FROM runs WHERE id = $r', { r: runId });
  if (!run) return null;
  const baseId = baselineId && baselineId !== 'previous' ? baselineId : previousRun(run);
  const base = baseId ? get('SELECT * FROM runs WHERE id = $r', { r: baseId }) : null;
  const out = {
    run: { id: run.id, startedAt: run.startedAt, total: run.total, passed: run.passed, failed: run.failed, blocked: run.blocked },
    baseline: base ? { id: base.id, startedAt: base.startedAt, total: base.total, passed: base.passed, failed: base.failed, blocked: base.blocked } : null,
    newlyFailing: [], fixed: [], stillFailing: [], newTests: [], notRerun: [], slower: [],
  };
  if (!base) {
    out.message = 'No earlier finished run of this project shares tests with this run — nothing to compare against.';
    return out;
  }
  const cur = resultsByTest(run.id);
  const prev = resultsByTest(base.id);
  const bad = (s) => s === 'failed' || s === 'blocked';
  for (const [id, r] of cur) {
    const p = prev.get(id);
    if (!p) { out.newTests.push(brief(r)); continue; }
    if (bad(r.status) && !bad(p.status)) out.newlyFailing.push({ ...brief(r), was: p.status });
    else if (!bad(r.status) && bad(p.status)) out.fixed.push({ ...brief(r), was: p.status });
    else if (bad(r.status) && bad(p.status)) out.stillFailing.push(brief(r));
    if (r.responseMs != null && p.responseMs != null && r.responseMs - p.responseMs >= 200 && r.responseMs >= p.responseMs * 1.5) {
      out.slower.push({ ...brief(r), baselineMs: p.responseMs, deltaMs: r.responseMs - p.responseMs });
    }
  }
  for (const [id, p] of prev) if (!cur.has(id)) out.notRerun.push(brief(p));
  out.slower.sort((a, b) => b.deltaMs - a.deltaMs);
  out.verdict = out.newlyFailing.length ? 'regressed' : out.fixed.length ? 'improved' : 'unchanged';
  out.message = `${run.id} vs ${base.id}: ${out.newlyFailing.length} newly failing, ${out.fixed.length} fixed, ${out.stillFailing.length} still failing, ${out.newTests.length} new, ${out.slower.length} slower.`;
  return out;
}

/** Tests whose outcome flipped between pass and fail across the project's last `window` finished runs. */
function flakyTests(projectId, { window = 5, testCaseIds = null } = {}) {
  const runs = all(`SELECT id FROM runs WHERE projectId = $p AND ${FINAL} ORDER BY startedAt DESC LIMIT ${Math.max(2, Math.min(20, Number(window) || 5))}`, { p: projectId }).map((r) => r.id);
  if (runs.length < 2) return [];
  const hist = new Map();
  runs.forEach((rid, idx) => {
    for (const [id, r] of resultsByTest(rid)) {
      if (testCaseIds && !testCaseIds.has(id)) continue;
      if (!hist.has(id)) hist.set(id, { r, outcomes: [] });
      hist.get(id).outcomes[idx] = r.status;
    }
  });
  const out = [];
  for (const [id, { r, outcomes }] of hist) {
    const seen = outcomes.filter((s) => s === 'passed' || s === 'failed');
    if (seen.length < 2) continue;
    let flips = 0;
    for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) flips++;
    // One flip is a regression or a fix; flaky means it went back and forth.
    if (flips >= 2) {
      out.push({ testCaseId: id, title: r.title, endpoint: `${r.method} ${r.endpoint}`, priority: r.priority, flips, history: seen.slice().reverse() });
    }
  }
  return out.sort((a, b) => b.flips - a.flips);
}

/**
 * Evaluate CI exit criteria for a run.
 * @param {object} opts { minPassRate (0-100), requireP0 (bool), maxNewFailures (int), maxBlocked (int) }
 */
function qualityGate(runId, opts = {}) {
  const run = get('SELECT * FROM runs WHERE id = $r', { r: runId });
  if (!run) return null;
  const executed = run.passed + run.failed;
  const passRate = executed ? Math.round((run.passed / executed) * 1000) / 10 : 0;
  const checks = [];
  const minPassRate = opts.minPassRate != null && opts.minPassRate !== '' ? Number(opts.minPassRate) : 100;
  checks.push({ name: 'pass-rate', ok: executed > 0 && passRate >= minPassRate, detail: `${passRate}% of ${executed} executed tests passed (threshold ${minPassRate}%).` });
  if (opts.requireP0 !== false && opts.requireP0 !== 'false') {
    const p0 = all("SELECT testCaseId, title, status FROM run_results WHERE runId = $r AND priority = 'P0' AND status IN ('failed','blocked')", { r: runId });
    checks.push({ name: 'p0-all-pass', ok: p0.length === 0, detail: p0.length ? `${p0.length} P0 test(s) failed or blocked: ${p0.slice(0, 5).map((x) => x.testCaseId).join(', ')}.` : 'Every P0 test passed.' });
  }
  if (opts.maxBlocked != null && opts.maxBlocked !== '') {
    checks.push({ name: 'blocked', ok: run.blocked <= Number(opts.maxBlocked), detail: `${run.blocked} blocked (max ${Number(opts.maxBlocked)}).` });
  }
  if (opts.maxNewFailures != null && opts.maxNewFailures !== '') {
    const cmp = compareRuns(runId, opts.baseline);
    const n = cmp && cmp.baseline ? cmp.newlyFailing.length : 0;
    checks.push({ name: 'new-failures', ok: n <= Number(opts.maxNewFailures), detail: cmp && cmp.baseline ? `${n} newly failing vs ${cmp.baseline.id} (max ${Number(opts.maxNewFailures)}).` : 'No baseline run to compare against — check skipped.' });
  }
  const finished = !['running', 'queued'].includes(run.status);
  if (!finished) checks.push({ name: 'finished', ok: false, detail: `Run is still ${run.status}.` });
  return { runId, passed: checks.every((c) => c.ok), passRate, checks };
}

module.exports = { compareRuns, flakyTests, qualityGate, previousRun };
