#!/usr/bin/env node
'use strict';
/**
 * Run an exported Postman collection with Newman, injecting credentials from
 * environment variables at runtime. Secrets are written only to a temporary
 * environment file that is deleted afterwards — never to the committed one.
 *
 * Usage:
 *   npm install            (inside api-tests/, installs newman + htmlextra reporter)
 *   SF_CLIENT_ID=… SF_CLIENT_SECRET=… node scripts/run-newman.js \
 *     --collection collections/PRJ-001.postman_collection.json \
 *     --environment environments/PRJ-001.qa.postman_environment.json [--folder Functional] [--bail]
 *
 * Env (any missing values are left empty): SF_BASE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_ACCESS_TOKEN
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const root = path.join(__dirname, '..');
const collection = path.resolve(root, args.collection || fail('Missing --collection'));
const envFile = path.resolve(root, args.environment || fail('Missing --environment'));
function fail(m) { console.error(m); process.exit(2); }

const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
const inject = { baseUrl: process.env.SF_BASE_URL, clientId: process.env.SF_CLIENT_ID, clientSecret: process.env.SF_CLIENT_SECRET, accessToken: process.env.SF_ACCESS_TOKEN };
for (const v of env.values || []) if (inject[v.key]) v.value = inject[v.key];
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'newman-')), 'env.json');
fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reports = path.join(root, 'reports');
fs.mkdirSync(reports, { recursive: true });
const cli = ['newman', 'run', collection, '-e', tmp, '--reporters', 'cli,junit,json,htmlextra',
  '--reporter-junit-export', path.join(reports, `newman-${stamp}.xml`),
  '--reporter-json-export', path.join(reports, `newman-${stamp}.json`),
  '--reporter-htmlextra-export', path.join(reports, `newman-${stamp}.html`),
  '--reporter-htmlextra-skipSensitiveData', '--reporter-htmlextra-skipHeaders', 'Authorization',
  '--timeout-request', String(args.timeout || 30000)];
if (args.folder && args.folder !== true) cli.push('--folder', args.folder);
if (args.bail) cli.push('--bail');
console.log(`▶ npx ${cli.slice(0, 3).join(' ')} … (credentials injected from environment variables)`);
const r = spawnSync('npx', ['--no-install', ...cli], { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
if (r.error) { console.error(`✖ Could not start Newman: ${r.error.message}\n  Run \`npm install\` inside api-tests/ first.`); process.exit(3); }
process.exit(r.status === null ? 1 : r.status);
