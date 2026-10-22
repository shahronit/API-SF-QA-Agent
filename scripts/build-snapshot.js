#!/usr/bin/env node
'use strict';
/**
 * Build read-only, single-file HTML snapshots of the UI (for documentation,
 * design review and offline demos). Starts the server against a temporary
 * demo database, captures GET responses, and inlines CSS + JS + data.
 *
 *   node scripts/build-snapshot.js [route ...]   (default: a standard set)
 *
 * Output: docs/snapshots/<route-name>.html
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'snapshots');
const PORT = 4400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP_DB = Boolean(process.env.SNAPSHOT_DB);
const DB = process.env.SNAPSHOT_DB || path.join(os.tmpdir(), `qa-snapshot-${process.pid}.db`);

const DEFAULT_ROUTES = ['/', '/projects', '/stories', '/stories/DEMO-102', '/scenarios', '/testcases', '/execution', '/execution/{latestRun}', '/defects', '/traceability', '/explorer', '/testdata', '/contracts', '/reports', '/automation', '/insights', '/agent', '/logs'];

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not start within 120 s');
}
function seedTempDb() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'seed.js'), '--reset'], {
      env: { ...process.env, QA_DB_FILE: DB },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('seed failed with code ' + code))));
  });
}

const get = async (u) => { const r = await fetch(BASE + u); if (!r.ok) return undefined; return r.json(); };

async function capture(projectId) {
  const snap = {};
  const put = async (u, key = u.split('?')[0]) => { const d = await get(u); if (d !== undefined) { snap[key] = d; snap[u] = d; } return d; };
  const q = `projectId=${projectId}`;
  await put('/api/meta'); await put('/api/projects');
  await put(`/api/dashboard?${q}`);
  const runs = await put(`/api/runs?${q}&pageSize=25`);
  await put(`/api/stories?${q}`); await put(`/api/scenarios?${q}`); await put(`/api/testcases?${q}`);
  await put(`/api/defects?${q}`); await put(`/api/traceability?${q}`); await put(`/api/testdata?${q}`);
  await put(`/api/contracts?${q}`); await put(`/api/requests?${q}`); await put('/api/explorer/templates');
  await put(`/api/insights?${q}`); await put(`/api/audit?${q}`); await put(`/api/proposals?${q}`);
  await put(`/api/projects/${projectId}/sobjects`); await put(`/api/projects/${projectId}/connection`);
  const pj = await get('/api/projects');
  for (const p of pj) { await put(`/api/projects/${p.id}`); }
  for (const s of ['DEMO-101', 'DEMO-102', 'DEMO-105']) await put(`/api/stories/${s}?${q}`);
  for (const o of ['Account', 'Contact', 'Invoice__c']) await put(`/api/projects/${projectId}/sobjects/${o}`);
  const latest = runs && runs.items[0];
  if (latest) {
    await put(`/api/runs/${latest.id}`);
    await put(`/api/runs/${latest.id}/results?pageSize=500`, `/api/runs/${latest.id}/results`);
    await put(`/api/runs/${latest.id}/analysis`);
    const res = snap[`/api/runs/${latest.id}/results`];
    for (const r of (res ? res.items : []).filter((x) => x.status !== 'passed').slice(0, 12)) await put(`/api/results/${r.id}`);
  }
  return { snap, latestRun: latest ? latest.id : null };
}

function inline(snap, route) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');
  const safeJs = (s) => s.replace(/<\/script/gi, '<\\/script');
  const data = JSON.stringify(snap).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  let out = html.replace('<link rel="stylesheet" href="/css/app.css">', `<style>${css}</style>`);
  out = out.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => `<script>${safeJs(fs.readFileSync(path.join(ROOT, 'public', src), 'utf8'))}</script>`);
  const boot = `<script>window.__QA_SNAPSHOT__=${data};window.__QA_SNAPSHOT_ROUTE__=${JSON.stringify(route)};</script>`;
  return out.replace('<script>', `${boot}\n<script>`);
}

async function main() {
  const routes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROUTES;
  if (!KEEP_DB) await seedTempDb();
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', QA_DB_FILE: DB, SEED_DEMO: 'false' };
  for (const k of Object.keys(env)) if (/^(SF_|JIRA_|ANTHROPIC_)/.test(k)) delete env[k]; // snapshots always use fixture data
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await waitForServer();
    const { snap, latestRun } = await capture('PRJ-001');
    fs.mkdirSync(OUT, { recursive: true });
    for (const r of routes) {
      const route = r.replace('{latestRun}', latestRun || '');
      const name = route === '/' ? 'dashboard' : route.replace(/^\//, '').replace(/[^A-Za-z0-9-]+/g, '-');
      const file = path.join(OUT, `${name}.html`);
      fs.writeFileSync(file, inline(snap, route));
      console.log(`snapshot ${route} → ${path.relative(ROOT, file)}`);
    }
  } finally {
    srv.kill();
    if (!KEEP_DB) for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
