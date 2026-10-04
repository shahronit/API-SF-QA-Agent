'use strict';
/**
 * QA execution reports: data model + CSV, HTML, XLSX and PDF renderers.
 * Every renderer works from already-masked data.
 */
const { repo, all, get, decode } = require('../db');
const { maskDeep } = require('../lib/mask');
const { buildXlsx } = require('../lib/xlsx');
const { PdfDoc } = require('../lib/pdf');

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function recommendations(d) {
  const recs = [];
  const executed = d.run.passed + d.run.failed;
  if (d.run.failed) recs.push(`Triage the ${d.run.failed} failed test(s); ${d.defectCandidates} look like product defects and should be reviewed for Jira defect creation.`);
  if (d.run.blocked) recs.push(`${d.run.blocked} test(s) were blocked — resolve upstream failures or configuration (e.g. low-privilege user, production confirmation) and re-run.`);
  const slow = d.endpoints.filter((e) => e.p95 && e.p95 > d.slaMs);
  if (slow.length) recs.push(`P95 latency exceeds the ${d.slaMs} ms SLA on ${slow.map((e) => e.endpoint).slice(0, 3).join(', ')}. Review SOQL selectivity and synchronous automation.`);
  if (d.sfValidation.failed) recs.push(`${d.sfValidation.failed} Salesforce data validation mismatch(es): API responses succeeded but persisted values differ — check flows/triggers and integration mappings.`);
  if (d.coverage.storiesWithoutTests.length) recs.push(`${d.coverage.storiesWithoutTests.length} story(ies) have no API tests: ${d.coverage.storiesWithoutTests.slice(0, 5).join(', ')}.`);
  const types = new Set(d.results.map((r) => r.testType));
  for (const t of ['Negative', 'Security', 'Boundary']) if (!types.has(t)) recs.push(`No ${t} tests were executed in this run — add them to the regression suite.`);
  if (!recs.length && executed) recs.push('All executed tests passed. Keep this suite in the nightly regression pipeline.');
  return recs;
}

function buildRunReport(runId) {
  const run = repo.get('runs', runId);
  if (!run) return null;
  const project = repo.get('projects', run.projectId);
  const results = all('SELECT id, seq, testCaseId, title, method, endpoint, apiType, testType, priority, storyKey, status, statusCode, responseMs, sfValidation, analysis, defectKey, correlationId, error FROM run_results WHERE runId = $r ORDER BY seq', { r: runId }).map((x) => decode('run_results', x));
  const defects = repo.find('defects', 'runId = $r', { r: runId });
  const stories = repo.find('stories', 'projectId = $p', { p: project.id });
  const tcCountByStory = Object.fromEntries(all('SELECT storyKey, COUNT(*) AS n FROM test_cases WHERE projectId = $p GROUP BY storyKey', { p: project.id }).map((r) => [r.storyKey, r.n]));
  const endpoints = {};
  for (const r of results) {
    const key = `${r.method} ${String(r.endpoint).replace(/\{\{[^}]+\}\}/g, '{…}').split('?')[0].replace(/\/services\/data\/v\{…\}/, '')}`;
    const e = (endpoints[key] = endpoints[key] || { endpoint: key, total: 0, passed: 0, failed: 0, times: [] });
    e.total++;
    if (r.status === 'passed') e.passed++;
    if (r.status === 'failed') e.failed++;
    if (r.responseMs) e.times.push(r.responseMs);
  }
  const epList = Object.values(endpoints).map((e) => {
    const s = e.times.sort((a, b) => a - b);
    return { endpoint: e.endpoint, total: e.total, passed: e.passed, failed: e.failed, avg: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null, p95: s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null, health: e.failed === 0 ? 'Healthy' : e.failed / e.total > 0.25 ? 'Critical' : 'Degraded' };
  });
  const sfv = results.filter((r) => r.sfValidation);
  const storiesInRun = [...new Set(results.map((r) => r.storyKey).filter(Boolean))];
  const d = {
    generatedAt: new Date().toISOString(),
    project: { name: project.name, sfOrg: project.sfOrg, environment: run.environment, apiVersion: project.apiVersion, mode: project.mode, jiraProjectKey: project.jiraProjectKey },
    run: { id: run.id, status: run.status, user: run.user, trigger: run.trigger, startedAt: run.startedAt, endedAt: run.endedAt, total: run.total, passed: run.passed, failed: run.failed, blocked: run.blocked, skipped: run.skipped, passRate: pct(run.passed, run.passed + run.failed), avgResponseMs: run.avgResponseMs, p95Ms: run.summary && run.summary.p95Ms },
    coverage: {
      storiesTotal: stories.length, storiesCovered: stories.filter((s) => tcCountByStory[s.key]).length, storiesInRun,
      storiesWithoutTests: stories.filter((s) => !tcCountByStory[s.key]).map((s) => s.key),
      apiTypes: [...new Set(results.map((r) => r.apiType))], endpointsCovered: epList.length,
      testTypes: Object.entries(results.reduce((m, r) => ({ ...m, [r.testType]: (m[r.testType] || 0) + 1 }), {})).map(([type, n]) => ({ type, n })),
    },
    sfValidation: { total: sfv.length, passed: sfv.filter((r) => r.sfValidation.status === 'PASS').length, failed: sfv.filter((r) => r.sfValidation.status === 'FAIL').length, label: project.mode === 'demo' ? 'ASSUMED (demo org)' : 'VERIFIED (live org)' },
    endpoints: epList,
    failed: results.filter((r) => r.status === 'failed').map((r) => ({ id: r.testCaseId, title: r.title, endpoint: `${r.method} ${r.endpoint}`, statusCode: r.statusCode, category: r.analysis && r.analysis.category, rootCause: r.analysis && r.analysis.rootCause, defectKey: r.defectKey })),
    blocked: results.filter((r) => r.status === 'blocked').map((r) => ({ id: r.testCaseId, title: r.title, reason: r.error && r.error.title })),
    defects: defects.map((x) => ({ key: x.key, summary: x.summary, severity: x.severity, status: x.status })),
    defectCandidates: results.filter((r) => r.status === 'failed' && r.analysis && r.analysis.defectCandidate).length,
    results: results.map((r) => ({ seq: r.seq, id: r.testCaseId, title: r.title, method: r.method, endpoint: r.endpoint, testType: r.testType, priority: r.priority, storyKey: r.storyKey, status: r.status, statusCode: r.statusCode, responseMs: r.responseMs, sfValidation: r.sfValidation ? r.sfValidation.status : '', defectKey: r.defectKey || '' })),
    aiSummary: run.summary && run.summary.aiSummary,
    slaMs: (project.businessConfig && project.businessConfig.slaMs) || 2000,
  };
  const health = d.run.failed === 0 ? 'Healthy' : d.run.passRate >= 90 ? 'Stable with issues' : d.run.passRate >= 75 ? 'At risk' : 'Critical';
  d.executiveSummary = `${d.project.name} (${d.project.environment}) — execution ${d.run.id} ran ${d.run.total} API tests: ${d.run.passed} passed, ${d.run.failed} failed, ${d.run.blocked} blocked, ${d.run.skipped} skipped (pass rate ${d.run.passRate}%). API health: ${health}. ${d.sfValidation.total} Salesforce data validations were performed with ${d.sfValidation.failed} mismatch(es). ${d.defects.length} Jira defect(s) are linked to this run.`;
  d.health = health;
  d.recommendations = recommendations(d);
  return maskDeep(d);
}

// ── CSV ──
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // CSV/formula injection guard
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
function toCsv(d) {
  const head = ['#', 'Test case', 'Title', 'Story', 'Type', 'Priority', 'Method', 'Endpoint', 'Status', 'HTTP', 'Response ms', 'SF validation', 'Defect'];
  const rows = d.results.map((r) => [r.seq, r.id, r.title, r.storyKey, r.testType, r.priority, r.method, r.endpoint, r.status, r.statusCode, r.responseMs, r.sfValidation, r.defectKey]);
  return '﻿' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

// ── HTML ──
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function toHtml(d) {
  const badge = (s) => `<span class="b b-${esc(s)}">${esc(s)}</span>`;
  const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">None</td></tr>`}</tbody></table>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>QA report ${esc(d.run.id)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light}body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:#0F172A;background:#F8FAFC;margin:0}
.wrap{max-width:1100px;margin:0 auto;padding:40px 32px}h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:17px;margin:36px 0 12px}
.muted{color:#64748B}.kpis{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid #E2E8F0;border-radius:10px;background:#fff;margin-top:24px}
.kpi{padding:16px 18px;border-right:1px solid #E2E8F0}.kpi:last-child{border-right:0}.kpi b{display:block;font-size:24px;font-variant-numeric:tabular-nums}
.summary{background:#fff;border:1px solid #E2E8F0;border-left:4px solid #2563EB;border-radius:8px;padding:16px 20px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;font-size:13px}
th{background:#F1F5F9;text-align:left;font-weight:600;color:#334155;padding:9px 12px}td{padding:8px 12px;border-top:1px solid #E2E8F0;vertical-align:top}
.b{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#F1F5F9;color:#334155}
.b-passed,.b-PASS,.b-Healthy{background:#DCFCE7;color:#166534}.b-failed,.b-FAIL,.b-Critical{background:#FEE2E2;color:#991B1B}.b-blocked,.b-Degraded{background:#FEF3C7;color:#92400E}
ul{padding-left:20px}code{font:12px ui-monospace,Menlo,monospace;color:#334155}@media print{body{background:#fff}.wrap{padding:0}}
</style></head><body><div class="wrap">
<h1>API test execution report</h1>
<div class="muted">${esc(d.project.name)} · ${esc(d.project.environment)} · Salesforce org ${esc(d.project.sfOrg || 'n/a')} (${d.project.mode === 'demo' ? 'demo simulator' : 'live'}) · API v${esc(d.project.apiVersion)} · Execution ${esc(d.run.id)} · ${esc(new Date(d.run.startedAt).toLocaleString())}</div>
<div class="kpis"><div class="kpi"><span class="muted">Total</span><b>${d.run.total}</b></div><div class="kpi"><span class="muted">Passed</span><b style="color:#16A34A">${d.run.passed}</b></div><div class="kpi"><span class="muted">Failed</span><b style="color:#DC2626">${d.run.failed}</b></div><div class="kpi"><span class="muted">Blocked</span><b style="color:#B45309">${d.run.blocked}</b></div><div class="kpi"><span class="muted">Pass rate</span><b>${d.run.passRate}%</b></div><div class="kpi"><span class="muted">Avg response</span><b>${d.run.avgResponseMs ?? '–'} ms</b></div></div>
<h2>Executive summary</h2><div class="summary">${esc(d.executiveSummary)}${d.aiSummary ? `<p class="muted"><em>AI summary (RECOMMENDED, review before sharing):</em> ${esc(d.aiSummary)}</p>` : ''}</div>
<h2>Coverage</h2><p>Stories covered: <b>${d.coverage.storiesCovered}/${d.coverage.storiesTotal}</b> · Endpoints exercised: <b>${d.coverage.endpointsCovered}</b> · API types: ${esc(d.coverage.apiTypes.join(', '))} · Test types: ${esc(d.coverage.testTypes.map((t) => `${t.type} ${t.n}`).join(', '))}</p>
<h2>API health</h2>${table(['Endpoint', 'Tests', 'Failed', 'Avg ms', 'P95 ms', 'Health'], d.endpoints.map((e) => `<tr><td><code>${esc(e.endpoint)}</code></td><td>${e.total}</td><td>${e.failed}</td><td>${e.avg ?? '–'}</td><td>${e.p95 ?? '–'}</td><td>${badge(e.health)}</td></tr>`))}
<h2>Salesforce data validation</h2><p>${d.sfValidation.passed}/${d.sfValidation.total} validations passed · ${d.sfValidation.failed} mismatch(es) · provenance ${esc(d.sfValidation.label)}</p>
<h2>Failed tests</h2>${table(['Test', 'Endpoint', 'HTTP', 'Category', 'Root cause', 'Defect'], d.failed.map((f) => `<tr><td>${esc(f.id)}<br>${esc(f.title)}</td><td><code>${esc(f.endpoint)}</code></td><td>${esc(f.statusCode)}</td><td>${esc(f.category)}</td><td>${esc(f.rootCause)}</td><td>${esc(f.defectKey || '')}</td></tr>`))}
<h2>Blocked tests</h2>${table(['Test', 'Reason'], d.blocked.map((b) => `<tr><td>${esc(b.id)} ${esc(b.title)}</td><td>${esc(b.reason)}</td></tr>`))}
<h2>Defects</h2>${table(['Key', 'Summary', 'Severity', 'Status'], d.defects.map((x) => `<tr><td>${esc(x.key)}</td><td>${esc(x.summary)}</td><td>${esc(x.severity)}</td><td>${esc(x.status)}</td></tr>`))}
<h2>Recommendations</h2><ul>${d.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
<h2>All results</h2>${table(['#', 'Test', 'Type', 'Priority', 'Endpoint', 'Status', 'HTTP', 'ms', 'SF'], d.results.map((r) => `<tr><td>${r.seq}</td><td>${esc(r.id)} ${esc(r.title)}</td><td>${esc(r.testType)}</td><td>${esc(r.priority)}</td><td><code>${esc(r.method)} ${esc(r.endpoint)}</code></td><td>${badge(r.status)}</td><td>${esc(r.statusCode)}</td><td>${esc(r.responseMs)}</td><td>${esc(r.sfValidation)}</td></tr>`))}
<p class="muted" style="margin-top:32px">Generated ${esc(d.generatedAt)} by Salesforce API QA Platform. Sensitive values are masked.</p>
</div></body></html>`;
}

// ── XLSX ──
function toXlsx(d) {
  return buildXlsx([
    { name: 'Summary', widths: [28, 90], rows: [['Field', 'Value'], ['Project', d.project.name], ['Environment', d.project.environment], ['Salesforce org', d.project.sfOrg || ''], ['Execution', d.run.id], ['Started', d.run.startedAt], ['Ended', d.run.endedAt || ''], ['Executed by', d.run.user], ['Total', d.run.total], ['Passed', d.run.passed], ['Failed', d.run.failed], ['Blocked', d.run.blocked], ['Skipped', d.run.skipped], ['Pass rate %', d.run.passRate], ['Avg response ms', d.run.avgResponseMs || ''], ['API health', d.health], ['Executive summary', d.executiveSummary], ...d.recommendations.map((r, i) => [`Recommendation ${i + 1}`, r])] },
    { name: 'Results', widths: [5, 12, 60, 12, 12, 8, 8, 60, 10, 7, 10, 12, 12], rows: [['#', 'Test case', 'Title', 'Story', 'Type', 'Priority', 'Method', 'Endpoint', 'Status', 'HTTP', 'ms', 'SF validation', 'Defect'], ...d.results.map((r) => [r.seq, r.id, r.title, r.storyKey, r.testType, r.priority, r.method, r.endpoint, r.status, r.statusCode, r.responseMs, r.sfValidation, r.defectKey])] },
    { name: 'Failures', widths: [12, 50, 50, 8, 28, 80, 12], rows: [['Test case', 'Title', 'Endpoint', 'HTTP', 'Category', 'Root cause', 'Defect'], ...d.failed.map((f) => [f.id, f.title, f.endpoint, f.statusCode, f.category, f.rootCause, f.defectKey])] },
    { name: 'API health', widths: [60, 8, 8, 10, 10, 12], rows: [['Endpoint', 'Tests', 'Failed', 'Avg ms', 'P95 ms', 'Health'], ...d.endpoints.map((e) => [e.endpoint, e.total, e.failed, e.avg, e.p95, e.health])] },
    { name: 'Defects', widths: [14, 80, 12, 14], rows: [['Key', 'Summary', 'Severity', 'Status'], ...d.defects.map((x) => [x.key, x.summary, x.severity, x.status])] },
  ]);
}

// ── PDF ──
function toPdf(d) {
  const doc = new PdfDoc();
  const M = 42; const W = doc.width - M * 2;
  let y = M;
  const C = { text: '#0F172A', muted: '#64748B', line: '#E2E8F0', primary: '#2563EB', ok: '#16A34A', bad: '#DC2626', warn: '#B45309', head: '#F1F5F9' };
  const ensure = (h) => { if (y + h > doc.height - M) { doc.page(); y = M; } };
  doc.rect(0, 0, doc.width, 6, { fill: C.primary });
  doc.text(M, y, 'API test execution report', { size: 20, bold: true }); y += 28;
  doc.text(M, y, `${d.project.name} · ${d.project.environment} · org ${d.project.sfOrg || 'n/a'} (${d.project.mode === 'demo' ? 'demo simulator' : 'live'}) · API v${d.project.apiVersion}`, { size: 9, color: C.muted, maxWidth: W }); y += 13;
  doc.text(M, y, `Execution ${d.run.id} · ${new Date(d.run.startedAt).toUTCString()} · by ${d.run.user}`, { size: 9, color: C.muted, maxWidth: W }); y += 22;
  const kpis = [['Total', d.run.total, C.text], ['Passed', d.run.passed, C.ok], ['Failed', d.run.failed, C.bad], ['Blocked', d.run.blocked, C.warn], ['Pass rate', `${d.run.passRate}%`, C.text], ['Avg ms', d.run.avgResponseMs ?? '–', C.text]];
  const kw = W / kpis.length;
  doc.rect(M, y, W, 50, { stroke: C.line });
  kpis.forEach(([l, v, c], i) => {
    if (i) doc.line(M + kw * i, y, M + kw * i, y + 50);
    doc.text(M + kw * i + 10, y + 9, l, { size: 8, color: C.muted });
    doc.text(M + kw * i + 10, y + 22, String(v), { size: 16, bold: true, color: c });
  });
  y += 66;
  const section = (title) => { ensure(40); doc.text(M, y, title, { size: 12, bold: true }); y += 18; };
  const para = (t, opts = {}) => { for (const line of doc.wrap(t, W, opts.size || 9.5)) { ensure(14); doc.text(M + (opts.indent || 0), y, line, { size: opts.size || 9.5, color: opts.color || C.text }); y += 13; } y += 4; };
  const grid = (cols, rows) => {
    const total = cols.reduce((s, c) => s + c[1], 0);
    const widths = cols.map((c) => (c[1] / total) * W);
    ensure(20);
    doc.rect(M, y, W, 16, { fill: C.head });
    let x = M;
    cols.forEach((c, i) => { doc.text(x + 4, y + 4, c[0], { size: 8, bold: true, color: '#334155', maxWidth: widths[i] - 8 }); x += widths[i]; });
    y += 16;
    if (!rows.length) { doc.text(M + 4, y + 4, 'None', { size: 8.5, color: C.muted }); y += 18; return; }
    for (const row of rows) {
      ensure(15);
      x = M;
      row.forEach((cell, i) => {
        const s = String(cell ?? '');
        const color = /^(passed|PASS|Healthy)$/.test(s) ? C.ok : /^(failed|FAIL|Critical)$/.test(s) ? C.bad : /^(blocked|Degraded)$/.test(s) ? C.warn : C.text;
        doc.text(x + 4, y + 3.5, s, { size: 8, color, maxWidth: widths[i] - 8 });
        x += widths[i];
      });
      y += 14;
      doc.line(M, y, M + W, y);
    }
    y += 8;
  };
  section('Executive summary'); para(d.executiveSummary);
  if (d.aiSummary) para(`AI summary (RECOMMENDED — review before sharing): ${d.aiSummary}`, { color: C.muted });
  section('Coverage');
  para(`Stories covered ${d.coverage.storiesCovered}/${d.coverage.storiesTotal}. Endpoints exercised: ${d.coverage.endpointsCovered}. API types: ${d.coverage.apiTypes.join(', ')}. Test types: ${d.coverage.testTypes.map((t) => `${t.type} ${t.n}`).join(', ')}.`);
  section('Salesforce data validation');
  para(`${d.sfValidation.passed}/${d.sfValidation.total} validations passed, ${d.sfValidation.failed} mismatch(es). Provenance: ${d.sfValidation.label}.`);
  section('API health');
  grid([['Endpoint', 46], ['Tests', 8], ['Failed', 8], ['Avg ms', 10], ['P95 ms', 10], ['Health', 12]], d.endpoints.map((e) => [e.endpoint, e.total, e.failed, e.avg ?? '–', e.p95 ?? '–', e.health]));
  section('Failed tests');
  grid([['Test', 12], ['Title', 34], ['HTTP', 7], ['Category', 22], ['Defect', 12]], d.failed.map((f) => [f.id, f.title, f.statusCode ?? '', f.category || '', f.defectKey || '']));
  for (const f of d.failed) { ensure(30); doc.text(M, y, `${f.id} — root cause`, { size: 8.5, bold: true }); y += 12; para(f.rootCause || 'Not determined', { size: 8.5, color: C.muted }); }
  section('Blocked tests');
  grid([['Test', 14], ['Reason', 86]], d.blocked.map((b) => [`${b.id}`, b.reason || '']));
  section('Defects');
  grid([['Key', 14], ['Summary', 62], ['Severity', 12], ['Status', 12]], d.defects.map((x) => [x.key, x.summary, x.severity, x.status]));
  section('Recommendations');
  d.recommendations.forEach((r) => para(`•  ${r}`));
  section('All results');
  grid([['#', 4], ['Test', 11], ['Title', 39], ['Type', 11], ['Pri', 5], ['Status', 9], ['HTTP', 6], ['ms', 6], ['SF', 7]], d.results.map((r) => [r.seq, r.id, r.title, r.testType, r.priority, r.status, r.statusCode ?? '', r.responseMs ?? '', r.sfValidation]));
  const pages = doc.pages.length;
  doc.pages.forEach((ops, i) => { doc.ops = ops; doc.text(doc.width - M, doc.height - 26, `Page ${i + 1} of ${pages} · ${d.run.id} · sensitive values masked`, { size: 7.5, color: C.muted, align: 'right' }); });
  return doc.toBuffer();
}

module.exports = { buildRunReport, toCsv, toHtml, toXlsx, toPdf };
