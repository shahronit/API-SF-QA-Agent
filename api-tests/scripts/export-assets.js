#!/usr/bin/env node
'use strict';
/**
 * Export automation assets from the QA platform into this folder:
 * Postman collection + environment, test data, and API contracts.
 * Environment files are exported with secret values empty.
 *
 *   node api-tests/scripts/export-assets.js --project PRJ-001 [--priority P0,P1]
 *   Env: QA_PLATFORM_URL (default http://127.0.0.1:4317)
 */
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const BASE = (process.env.QA_PLATFORM_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');
const root = path.join(__dirname, '..');
const get = async (u) => { const r = await fetch(BASE + u); if (!r.ok) throw new Error(`GET ${u} → HTTP ${r.status}`); return r.json(); };

async function main() {
  const id = args.project;
  if (!id) { console.error('Missing --project'); process.exit(2); }
  const p = await get(`/api/projects/${id}`);
  const q = `projectId=${id}${args.priority ? `&priority=${args.priority}` : ''}`;
  const write = (rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); console.log(`  wrote ${rel}`); };
  write(`collections/${id}.postman_collection.json`, await get(`/api/postman/collection?${q}`));
  write(`environments/${id}.${p.environment.toLowerCase()}.postman_environment.json`, await get(`/api/postman/environment?projectId=${id}`));
  const data = await get(`/api/testdata?projectId=${id}&pageSize=200`);
  write(`test-data/${id}.testdata.json`, data.items.map(({ id: tid, name, category, object, storyKey, payload, notes }) => ({ id: tid, name, category, object, storyKey, payload, notes })));
  for (const c of await get(`/api/contracts?projectId=${id}`)) {
    const full = await get(`/api/contracts/${c.id}`);
    write(`schemas/${c.id}.${full.kind}.json`, full.spec);
  }
  write(`config/${id}.json`, { projectId: id, name: p.name, environment: p.environment, apiVersion: p.apiVersion, instanceUrl: p.instanceUrl, credentialPrefix: p.credentialRef ? `SF_${p.credentialRef}_` : null, jiraProjectKey: p.jiraProjectKey, slaMs: (p.businessConfig || {}).slaMs || 2000, note: 'No secrets. Credentials are provided via environment variables or CI secrets.' });
}
main().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
