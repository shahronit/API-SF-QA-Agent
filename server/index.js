'use strict';
/**
 * Salesforce API QA Platform — server entry point (Node.js 22+, zero dependencies).
 */
const http = require('node:http');
const { config, secretValues } = require('./config');
const { registerSecrets } = require('./lib/mask');
const { handle } = require('./http');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`Node.js ${process.versions.node} detected. This platform needs Node.js 22.5 or newer (built-in SQLite). Install the current LTS from https://nodejs.org and retry.`);
  process.exit(1);
}

registerSecrets(secretValues());

require('./routes/core');
require('./routes/stories');
require('./routes/tests');
require('./routes/runs');
require('./routes/defects');
require('./routes/data');
require('./routes/reports');
require('./routes/workflow');

async function main() {
  const { repo } = require('./db');
  if (config.seedDemo && repo.count('projects') === 0) {
    console.log('[seed] First start — creating demo projects, stories and execution history (about 20–40 s)…');
    await require('./seed').seed({ log: (m) => console.log(`[seed] ${m}`) });
  }
  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 120000;
  server.listen(config.port, config.host, () => {
    console.log(`\n  Salesforce API QA Platform v${config.version}`);
    console.log(`  ➜  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}\n`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      console.warn('  ⚠  HOST is not loopback. Put the app behind an authenticated reverse proxy (SSO) before exposing it.');
    }
  });
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => { console.error('Failed to start:', e); process.exit(1); });
}

module.exports = { main };
