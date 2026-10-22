#!/usr/bin/env node
'use strict';
/**
 * CI runner: executes a test selection through the QA platform API, waits for
 * completion, writes JUnit XML + JSON summary, and exits non-zero on failures.
 * Zero dependencies (Node.js 22+). Credentials never pass through this script —
 * the platform reads them from its own environment / secret store.
 *
 * Usage:
 *   node api-tests/scripts/run-suite.js --project PRJ-001 [--priority P0,P1] [--type Functional,Negative]
 *        [--story DEMO-101] [--tests TC-00001,TC-00002] [--label "Nightly"] [--junit api-tests/reports/junit.xml]
 *        [--allow-failures] [--timeout 1800]
 *        [--min-pass-rate 95] [--require-p0] [--max-new-failures 0] [--max-blocked 5]
 *
 * Quality gate: when any of --min-pass-rate / --require-p0 / --max-new-failures / --max-blocked is
 * given, the exit code follows GET /api/runs/:id/gate instead of "any failure fails the build".
 * --max-new-failures compares against the previous run that shares tests with this one.
 *
 * Env: QA_PLATFORM_URL (default http://127.0.0.1:4317), QA_PLATFORM_USER (audit identity, default ci-pipeline)
 *
 * Production projects: the platform refuses runs that modify data unless confirmed. This
 * script never confirms production writes; pass --read-only to run only read-only tests there.
 */
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const BASE = (process.env.QA_PLATFORM_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');
const USER = process.env.QA_PLATFORM_USER || 'ci-pipeline';
const list = (v) => (v && v !== true ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : undefined);

async function call(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Forwarded-User': USER }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`${method} ${url} → HTTP ${res.status}: ${data.error || 'request failed'}`);
    e.info = data;
    throw e;
  }
  return data;
}

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function junit(run, results) {
  const byType = {};
  for (const r of results) (byType[r.testType || 'Tests'] = byType[r.testType || 'Tests'] || []).push(r);
  const suites = Object.entries(byType).map(([type, rs]) => {
    const failures = rs.filter((r) => r.status === 'failed').length;
    const skipped = rs.filter((r) => r.status === 'blocked' || r.status === 'skipped').length;
    const time = rs.reduce((n, r) => n + (r.responseMs || 0), 0) / 1000;
    return `  <testsuite name="${xml(`${run.id} · ${type}`)}" tests="${rs.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">
${rs.map((r) => `    <testcase classname="${xml(`${r.storyKey || 'unlinked'}.${type}`)}" name="${xml(`${r.testCaseId} ${r.title}`)}" time="${((r.responseMs || 0) / 1000).toFixed(3)}">${
    r.status === 'failed' ? `\n      <failure message="${xml(r.reason || `HTTP ${r.statusCode}`)}">${xml(`${r.method} ${r.endpoint}\nHTTP ${r.statusCode}\nCorrelation: ${r.correlationId || '-'}\n${r.reason || ''}`)}</failure>\n    ` : r.status === 'blocked' || r.status === 'skipped' ? `\n      <skipped message="${xml(r.reason || r.status)}"/>\n    ` : ''}</testcase>`).join('\n')}
  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Salesforce API QA ${xml(run.id)}" tests="${results.length}" failures="${run.failed}">\n${suites.join('\n')}\n</testsuites>\n`;
}

async function main() {
  if (!args.project) { console.error('Missing --project (e.g. --project PRJ-001)'); process.exit(2); }
  const body = {
    testCaseIds: list(args.tests),
    filter: { priority: list(args.priority), testType: list(args.type), storyKey: list(args.story), apiType: list(args.api) },
    label: args.label && args.label !== true ? args.label : `CI ${new Date().toISOString().slice(0, 16)}`,
    trigger: 'ci',
    skipWrites: Boolean(args['read-only']),
  };
  console.log(`▶ Starting run on ${BASE} for ${args.project}`);
  let run;
  try { run = await call('POST', `/api/runs?projectId=${encodeURIComponent(args.project)}`, body); } catch (e) {
    console.error(`✖ ${e.message}`);
    if (e.info && e.info.cause) console.error(`  Possible cause: ${e.info.cause}`);
    if (e.info && e.info.action) console.error(`  Recommended action: ${e.info.action}`);
    process.exit(3);
  }
  console.log(`  ${run.id}: ${run.total} tests queued in ${run.environment}`);
  const deadline = Date.now() + Number(args.timeout || 1800) * 1000;
  let last = '';
  for (;;) {
    run = await call('GET', `/api/runs/${run.id}`);
    const line = `  ${run.status} · ${run.passed} passed · ${run.failed} failed · ${run.blocked} blocked · ${run.skipped} skipped`;
    if (line !== last) { console.log(line); last = line; }
    if (!['running', 'queued'].includes(run.status)) break;
    if (Date.now() > deadline) { console.error('✖ Timed out waiting for the run; requesting stop.'); await call('POST', `/api/runs/${run.id}/stop`).catch(() => {}); process.exit(4); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const results = [];
  for (let page = 1; ; page++) {
    const r = await call('GET', `/api/runs/${run.id}/results?pageSize=200&page=${page}&sort=seq&dir=ASC`);
    results.push(...r.items);
    if (page >= r.pages) break;
  }
  const outFile = args.junit && args.junit !== true ? args.junit : path.join(__dirname, '..', 'reports', `junit-${run.id}.xml`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, junit(run, results));
  const summaryFile = path.join(path.dirname(outFile), `summary-${run.id}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify({ run: { id: run.id, status: run.status, environment: run.environment, total: run.total, passed: run.passed, failed: run.failed, blocked: run.blocked, skipped: run.skipped, avgResponseMs: run.avgResponseMs }, failures: results.filter((r) => r.status === 'failed').map((r) => ({ testCaseId: r.testCaseId, title: r.title, endpoint: `${r.method} ${r.endpoint}`, statusCode: r.statusCode, reason: r.reason, correlationId: r.correlationId })) }, null, 2));
  console.log(`  JUnit: ${outFile}\n  Summary: ${summaryFile}\n  Report: ${BASE}/api/reports/${run.id}?format=html`);
  for (const r of results.filter((x) => x.status === 'failed')) console.log(`  ✖ ${r.testCaseId} ${r.title} — ${r.reason || `HTTP ${r.statusCode}`}`);
  const gateArgs = { minPassRate: args['min-pass-rate'], requireP0: args['require-p0'] ? 'true' : 'false', maxNewFailures: args['max-new-failures'], maxBlocked: args['max-blocked'] };
  if (gateArgs.minPassRate !== undefined || args['require-p0'] || gateArgs.maxNewFailures !== undefined || gateArgs.maxBlocked !== undefined) {
    const qs = new URLSearchParams(Object.entries(gateArgs).filter(([, v]) => v !== undefined && v !== true).map(([k, v]) => [k, String(v)]));
    const gate = await call('GET', `/api/runs/${run.id}/gate?${qs}`);
    for (const c of gate.checks) console.log(`  ${c.ok ? '✔' : '✖'} gate ${c.name}: ${c.detail}`);
    if (!gate.passed && !args['allow-failures']) { console.error('✖ Quality gate failed.'); process.exit(1); }
    console.log(gate.passed ? '✔ Quality gate passed.' : '⚠ Quality gate failed, but failures are allowed (--allow-failures).');
    return;
  }
  if ((run.failed || run.status === 'error') && !args['allow-failures']) process.exit(1);
  console.log(run.failed ? '⚠ Failures allowed (--allow-failures).' : '✔ All executed tests passed.');
}

main().catch((e) => { console.error(`✖ ${e.message}`); process.exit(3); });
