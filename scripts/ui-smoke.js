#!/usr/bin/env node
'use strict';
/**
 * Headless UI smoke test. Boots the server on a temporary demo database, loads
 * the real SPA scripts into a minimal DOM (scripts/lib/mini-dom.js), visits every
 * route and runs key interactions. Fails on uncaught errors or error states.
 *
 *   node scripts/ui-smoke.js            (SMOKE_DB=/path reuses a seeded DB)
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { Document, Event } = require('./lib/mini-dom');

const ROOT = path.join(__dirname, '..');
const PORT = 4800 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = Boolean(process.env.SMOKE_DB);
const DB = process.env.SMOKE_DB || path.join(os.tmpdir(), `qa-ui-smoke-${process.pid}.db`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const allowed = [];
let pending = 0;

function makeWindow() {
  const doc = new Document();
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  doc.body.innerHTML = body;
  let href = `${BASE}/`;
  const store = new Map();
  const win = {
    document: doc, console: { ...console, error: (...a) => { problems.push(`console.error: ${a.map((x) => (x && x.stack) || String(x)).join(' ')}`); } },
    get location() { const u = new URL(href); return { href, pathname: u.pathname, search: u.search, origin: u.origin, reload() {} }; },
    history: { pushState(_, __, u) { href = new URL(u, href).href; }, replaceState(_, __, u) { href = new URL(u, href).href; } },
    listeners: {}, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '#2563EB' }),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    navigator: { clipboard: null }, innerWidth: 1440, innerHeight: 900, scrollTo() {},
    URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Error, Map, Set, Proxy, Object, Array, String, Number, Boolean, RegExp, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
    fetch: async (u, opts = {}) => {
      pending++;
      try {
        const headers = { ...(opts.headers || {}) };
        const res = await fetch(new URL(u, BASE).href, { ...opts, headers });
        if (res.status >= 500) problems.push(`HTTP ${res.status} ${opts.method || 'GET'} ${u}`);
        return res;
      } finally { pending--; }
    },
    Blob: globalThis.Blob,
  };
  win.window = win; win.self = win; win.globalThis = win;
  doc.defaultView = win;
  return { win, doc, go: (p) => { href = new URL(p, BASE).href; } };
}

async function idle(win, ms = 120) {
  for (let i = 0; i < 400; i++) { await sleep(25); if (pending === 0) { await sleep(ms); if (pending === 0) return; } }
}

function viewErrors(doc, label) {
  const view = doc.getElementById('view');
  const errs = view.querySelectorAll('.callout.error').filter((c) => !/production|Production/.test(c.textContent));
  for (const e of errs) problems.push(`${label}: error state rendered — ${e.textContent.trim().slice(0, 200)}`);
  const overlayErrs = doc.getElementById('overlay-root').querySelectorAll('.callout.error').filter((c) => !/production|Production/.test(c.textContent));
  for (const e of overlayErrs) problems.push(`${label}: overlay error — ${e.textContent.trim().slice(0, 200)}`);
  for (const root of [view, doc.getElementById('overlay-root')]) {
    const m = root.textContent.match(/.{0,40}<(div|span|button|svg|a|td|tr|b|code|ul|li|p)[\s>].{0,40}/);
    if (m) problems.push(`${label}: escaped HTML visible — "${m[0]}"`);
  }
  if (/Page not found|failed while rendering/.test(view.textContent)) problems.push(`${label}: ${view.textContent.trim().slice(0, 160)}`);
  if (/undefined|\[object Object\]|NaN/.test(view.textContent.replace(/\bundefined\b(?= is not)/g, ''))) {
    const m = view.textContent.match(/.{0,60}(undefined|\[object Object\]|NaN).{0,40}/);
    problems.push(`${label}: suspicious text "${m ? m[0] : ''}"`);
  }
}
const click = (el) => { if (!el) throw new Error('element not found'); el.dispatchEvent(new Event('click', { bubbles: true })); };
const change = (el, value) => { if (value !== undefined) el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };

async function main() {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', QA_DB_FILE: DB, SEED_DEMO: 'true' };
  for (const k of Object.keys(env)) if (/^(SF_|JIRA_|ANTHROPIC_)/.test(k)) delete env[k];
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  process.on('unhandledRejection', (e) => problems.push(`unhandledRejection: ${(e && e.stack) || e}`));
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await sleep(500); }
    const { win, doc, go } = makeWindow();
    const ctx = vm.createContext(win);
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    for (const [, src] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
      try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', src), 'utf8'), ctx, { filename: src }); } catch (e) { problems.push(`${src}: ${e.stack}`); }
    }
    await idle(win, 300);
    const QA = win.QA;
    const runs = await (await fetch(`${BASE}/api/runs?projectId=PRJ-001&pageSize=1`)).json();
    const latest = runs.items[0].id;
    const routes = ['/', '/?scope=all', '/workflow', '/workflow/project', '/workflow/postman', '/projects', '/projects/new', '/projects/PRJ-001', '/projects/PRJ-001?tab=connection', '/projects/PRJ-001?tab=integration', '/stories', '/stories/DEMO-102', '/stories/DEMO-102?proposal=GEN-0002', '/scenarios', '/testcases', '/testcases?id=TC-00028', '/execution', `/execution/${latest}`, `/execution/${latest}?tab=analysis`, `/execution/${latest}?tab=data`, '/defects', '/traceability', '/regression?story=DEMO-102', '/explorer', '/explorer?object=Account', `/explorer?fromResult=${latest}-0027`, '/testdata', '/contracts', '/reports', '/automation', '/insights', '/agent', '/logs', '/nope'];
    for (const r of routes) {
      const before = problems.length;
      QA.router.go(r);
      await idle(win);
      if (r !== '/nope') viewErrors(doc, r);
      const h1 = doc.querySelector('#view h1');
      console.log(`${problems.length === before ? 'ok  ' : 'FAIL'} ${r.padEnd(48)} ${h1 ? h1.textContent.trim().slice(0, 50) : '(no heading)'} · ${doc.getElementById('view').textContent.length} chars`);
      if (process.env.SMOKE_DUMP && r.includes(process.env.SMOKE_DUMP)) console.log(doc.getElementById('view').textContent.replace(/\s+/g, ' ').slice(0, 1500));
      doc.getElementById('overlay-root').innerHTML = '';
    }

    // ── Interactions ──
    const step = async (name, fn) => { const before = problems.length; try { await fn(); await idle(win); } catch (e) { problems.push(`${name}: ${e.stack}`); } console.log(`${problems.length === before ? 'ok  ' : 'FAIL'} interaction: ${name}`); };
    const $ = (s) => doc.querySelector(s);
    await step('open failed result drawer from execution', async () => {
      QA.router.go(`/execution/${latest}`); await idle(win);
      click($('#view [data-chip="rstatus"][data-value="failed"]')); await idle(win);
      const row = $('#view tr[data-rid]'); click(row.querySelector('td')); await idle(win);
      const drawer = $('#overlay-root .drawer');
      if (!drawer) throw new Error('drawer did not open');
      if (!/Salesforce validation/.test(drawer.textContent)) throw new Error('validation tab missing');
      click(drawer.querySelector('[data-xtab="request"]')); click(drawer.querySelector('[data-xtab="response"]'));
      if (/Bearer\s+[A-Za-z0-9]/.test(drawer.textContent.replace('Bearer {{accessToken}}', ''))) throw new Error('raw bearer token visible');
    });
    await step('defect preview modal (no auto-create)', async () => {
      const btn = $('#overlay-root [data-preview-defect]');
      if (btn) { click(btn); await idle(win); }
      const modal = [...doc.querySelectorAll('#overlay-root .modal')].pop();
      if (!modal || !/Review Jira defect/.test(modal.textContent)) throw new Error('defect preview did not open');
      if (!modal.querySelector('[data-create]')) throw new Error('create button missing');
      const desc = modal.querySelector('[name=description]').value;
      if (/Bearer [A-Za-z0-9._-]{20,}|00D[A-Za-z0-9]{12,}!/.test(desc)) throw new Error('secret in defect description');
      doc.getElementById('overlay-root').innerHTML = '';
    });
    await step('projects list exposes New project', async () => {
      QA.router.go('/projects'); await idle(win);
      if (!$('#view [data-act=new]')) throw new Error('new project control missing on /projects');
    });
    await step('new project page is a real form', async () => {
      QA.router.go('/projects/new'); await idle(win);
      if (!$('#view h1') || !/New project/i.test($('#view h1').textContent)) throw new Error(`expected New project heading, got ${$('#view h1') && $('#view h1').textContent}`);
      if (!$('#view [name=name]') || !$('#view [data-go]')) throw new Error('create form missing name or submit');
      if (!$('nav a[href="/projects/new"]')) throw new Error('sidebar New project link missing');
    });
    await step('run dialog opens with chips', async () => {
      QA.router.go('/testcases'); await idle(win);
      click($('#view [data-act=run]')); await idle(win);
      if (!$('#overlay-root [data-go]')) throw new Error('run dialog missing');
      doc.getElementById('overlay-root').innerHTML = '';
    });
    await step('testcase list filter + sort + paging', async () => {
      click($('#view [data-chip="priority"][data-value="P0"]')); await idle(win);
      click($('#view th[data-sort="title"]')); await idle(win);
      const next = $('#view [data-page="2"]'); if (next && !next.disabled) { click(next); await idle(win); }
      change($('#view [data-page-size]'), '50'); await idle(win);
    });
    await step('generate proposal from story and review', async () => {
      QA.router.go('/stories/DEMO-106'); await idle(win);
      click($('#view [data-act=gen]')); await idle(win, 400);
      if (!/Review generated tests/.test($('#view').textContent)) throw new Error(`proposal review not shown: ${$('#view h1') && $('#view h1').textContent}`);
      click($('#view [data-all="0"]')); click($('#view [data-all="1"]'));
      const d = $('#view [data-detail]'); click(d); await idle(win);
      if (!$('#overlay-root .modal')) throw new Error('test detail modal missing');
      doc.getElementById('overlay-root').innerHTML = '';
    });
    await step('explorer send request', async () => {
      QA.router.go('/explorer'); await idle(win);
      click($('#view [data-act=send]')); await idle(win, 300);
      if (!/Response/.test($('#view [data-response]').textContent)) throw new Error('no response rendered');
      click($('#view [data-side="objects"]')); await idle(win);
      if (!$('#view [data-obj="Contact"]')) throw new Error(`objects list: ${$('#view [data-side-body]').innerHTML.slice(0, 600)}`);
      click($('#view [data-obj="Contact"]')); await idle(win);
      click($('#view [data-quick="create"]')); await idle(win);
    });
    await step('production safety prompt on run', async () => {
      QA.state.setProject('PRJ-003'); await idle(win);
      QA.router.go('/explorer'); await idle(win);
      doc.querySelector('#view [name=method]').value = 'DELETE';
      doc.querySelector('#view [name=path]').value = '/services/data/v{{apiVersion}}/sobjects/Account/001000000000001AAA';
      click($('#view [data-act=send]')); await idle(win);
      const m = $('#overlay-root .modal.danger');
      if (!m || !/modify Salesforce production data/.test(m.textContent)) throw new Error('production confirmation not shown');
      if (!$('#env-band').textContent.includes('Production')) throw new Error('production band missing');
      doc.getElementById('overlay-root').innerHTML = '';
      QA.state.setProject('PRJ-001'); await idle(win);
    });
    await step('unavailable connection message (live, unconfigured project)', async () => {
      QA.state.setProject('PRJ-004'); await idle(win);
      if (!/Salesforce MCP is unavailable\. API test design and automation generation are available, but live Salesforce validation is disabled\./.test($('#env-band').textContent)) throw new Error('unavailable band text missing');
      QA.router.go('/explorer'); await idle(win);
      if (!/Salesforce MCP is unavailable/.test($('#view').textContent)) throw new Error('explorer did not explain the unavailable connection');
      allowed.push(/^\/explorer: error state rendered|overlay error/); // the explanation is an expected error state here
      QA.state.setProject('PRJ-001'); await idle(win);
    });
    await step('agent command', async () => {
      QA.router.go('/agent'); await idle(win);
      doc.querySelector('#view [name=cmd]').value = 'Show me APIs with failure rate above 10%';
      doc.querySelector('#view [data-form]').dispatchEvent(new Event('submit', { bubbles: true })); await idle(win, 300);
      if (!/Analyze|Discover|Report/.test($('#view [data-log]').textContent)) throw new Error('no agent reply');
    });
    await step('command palette search', async () => {
      QA.router.go('/'); await idle(win);
      click($('#search-btn')); await idle(win);
      const input = $('#overlay-root .palette input'); input.value = 'Account'; input.dispatchEvent(new Event('input', { bubbles: true })); await idle(win, 400);
      if (!$('#overlay-root .palette-item')) throw new Error(`no palette results: ${$('#overlay-root').innerHTML.slice(0, 600)}`);
      doc.getElementById('overlay-root').innerHTML = '';
    });
    await step('theme toggle + notifications', async () => { click($('#theme-btn')); click($('#notif-btn')); click($('#theme-btn')); });
  } finally {
    srv.kill();
    if (!KEEP) for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  }
  if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems) console.log(` - ${p}`); process.exit(1); }
  console.log('\nUI smoke test passed.');
}
main().catch((e) => { console.error(e); process.exit(1); });
