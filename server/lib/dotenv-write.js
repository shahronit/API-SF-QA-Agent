'use strict';
/**
 * Upsert keys in the project `.env` file without echoing values.
 * Used only for loopback "Save credentials" from the Connections wizard.
 */
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../config');

function quote(v) {
  const s = String(v);
  if (!/[\s#"'$\\]/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function upsertEnv(pairs) {
  const file = path.join(config.root, '.env');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text && !text.endsWith('\n')) text += '\n';
  const written = [];
  for (const [key, value] of Object.entries(pairs)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    const line = `${key}=${quote(value)}`;
    const rx = new RegExp(`^${key}=.*$`, 'm');
    if (rx.test(text)) text = text.replace(rx, line);
    else text += (text.endsWith('\n') ? '' : '\n') + line + '\n';
    process.env[key] = String(value);
    written.push(key);
  }
  if (written.length) fs.writeFileSync(file, text, { mode: 0o600 });
  return written;
}

module.exports = { upsertEnv };
