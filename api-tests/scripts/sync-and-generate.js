#!/usr/bin/env node
'use strict';
/**
 * Unattended generate-only: sync Jira stories and create proposals.
 * Never approves, never starts a run, never writes to production Salesforce,
 * never files Jira defects.
 *
 * Usage:
 *   node api-tests/scripts/sync-and-generate.js --project PRJ-001 [--jql '...'] [--all]
 *
 * Env: QA_PLATFORM_URL (default http://127.0.0.1:4317), QA_PLATFORM_USER (default github-actions)
 */
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const BASE = (process.env.QA_PLATFORM_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');
const USER = process.env.QA_PLATFORM_USER || 'github-actions';

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Forwarded-User': USER },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`${method} ${url} → HTTP ${res.status}: ${data.error || data.title || 'request failed'}`);
    e.info = data;
    throw e;
  }
  return data;
}

async function main() {
  if (!args.project) {
    console.error('Missing --project (e.g. --project PRJ-001)');
    process.exit(2);
  }
  const health = await call('GET', '/api/health');
  console.log(`Platform ${health.version} at ${BASE}`);
  const body = {
    jql: args.jql && args.jql !== true ? String(args.jql) : undefined,
    onlyNeedingApi: args.all === true ? false : true,
  };
  const r = await call('POST', `/api/stories/sync-and-generate?projectId=${encodeURIComponent(args.project)}`, body);
  if (r.approveIgnored) console.log(r.approveNote);
  console.log(`Synced ${r.synced} · selected ${r.selected} · skipped ${r.skipped} · proposals ${r.proposals.length} · approved ${r.approved}`);
  for (const p of r.proposals || []) {
    console.log(`  ${p.id} ${p.storyKey}  ${p.tests} tests  generator=${p.generator || 'engine'}  approved=${p.approved}`);
  }
  if (r.errors && r.errors.length) {
    for (const e of r.errors) console.error(`  ${e.storyKey}: ${e.title}`);
    process.exit(1);
  }
  if (!r.proposals.length) {
    console.log('No proposals. Humans still approve in the UI when new stories appear.');
  }
}

main().catch((e) => {
  console.error(e.message);
  if (e.info) console.error(JSON.stringify(e.info, null, 2));
  process.exit(1);
});
