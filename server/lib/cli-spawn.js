'use strict';
/**
 * Spawn local CLIs (Cursor `agent`/`cursor`, Gemini `gemini`) without logging secrets.
 * Extra PATH dirs cover common user-local installs (e.g. ~/.local/bin).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { maskText } = require('./mask');

const STRIP_KEYS = ['CURSOR_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

function extraBinDirs() {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, 'bin'),
  ];
}

function findBin(names) {
  const list = Array.isArray(names) ? names : [names];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...extraBinDirs()];
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const name of list) {
      if (!name) continue;
      const candidate = path.isAbsolute(name) ? name : path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        const st = fs.statSync(candidate);
        if (st.isFile() || st.isSymbolicLink()) return candidate;
      } catch { /* next */ }
      if (path.isAbsolute(name)) break;
    }
  }
  return null;
}

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const extras = extraBinDirs().filter((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });
  env.PATH = [...extras, env.PATH || ''].join(path.delimiter);
  for (const k of STRIP_KEYS) delete env[k];
  return env;
}

function runCli(bin, args, { timeoutMs = 25000, env, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: childEnv(env), cwd: cwd || process.cwd(), stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(Object.assign(new Error(`${path.basename(bin)} timed out after ${timeoutMs} ms.`), {
        code: 'CLI_TIMEOUT',
        title: `${path.basename(bin)} timed out.`,
        cause: `\`${path.basename(bin)}\` exceeded ${timeoutMs} ms.`,
        action: 'Retry, or Generate will use the built-in engine.',
      }));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(e.message), {
        code: e.code === 'ENOENT' ? 'CLI_MISSING' : 'CLI_SPAWN',
        title: e.code === 'ENOENT' ? `${path.basename(bin)} is not installed.` : `${path.basename(bin)} could not be started.`,
        cause: e.message,
        action: `Install ${path.basename(bin)} and ensure it is on PATH.`,
      }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: maskText(stderr || '') });
    });
    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/** Fire-and-forget spawn so a CLI can open a browser / Terminal for login. */
function spawnDetached(bin, args, { cwd } = {}) {
  const child = spawn(bin, args, {
    env: childEnv(),
    cwd: cwd || process.cwd(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid || null;
}

/** Open a URL in the default browser (Core/SFCC login pages). No-op in tests. */
function openUrl(url) {
  const href = String(url || '').trim();
  if (!href || process.env.NODE_TEST_CONTEXT) return null;
  if (process.platform === 'darwin') return spawnDetached('open', [href]);
  if (process.platform === 'win32') return spawnDetached('cmd', ['/c', 'start', '', href]);
  return spawnDetached('xdg-open', [href]);
}

module.exports = { extraBinDirs, findBin, childEnv, runCli, spawnDetached, openUrl };
