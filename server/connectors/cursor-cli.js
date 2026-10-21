'use strict';
/**
 * Cursor CLI (`cursor` or `agent`) for script generation.
 * Login: `agent login` (verified via `agent --help`; opens a browser).
 * Status/Test: `agent whoami --format json` (same help: status|whoami).
 * Generate: `--print --output-format json --mode ask`. No API keys collected.
 */
const path = require('node:path');
const { findBin, runCli, spawnDetached } = require('../lib/cli-spawn');
const { config } = require('../config');

const loginCache = new Map();

function envFlag(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

function cursorSettings(project) {
  const fromCfg = (project && project.integrationConfig && project.integrationConfig.cursor) || {};
  return {
    enabled: fromCfg.enabled === true || envFlag(process.env.CURSOR_CLI_ENABLED),
    bin: String(fromCfg.bin || process.env.CURSOR_CLI_BIN || '').trim(),
    timeoutMs: Number(fromCfg.timeoutMs || process.env.CURSOR_CLI_TIMEOUT_MS || 90000),
  };
}

function detectCursorBin(configured) {
  if (configured && path.isAbsolute(configured)) return findBin([configured]);
  if (configured) return findBin([configured, 'cursor', 'agent']);
  return findBin(['cursor', 'agent']);
}

function parseWhoami(stdout) {
  try {
    const j = JSON.parse(String(stdout || '').trim());
    const loggedIn = j.isAuthenticated === true || j.status === 'authenticated';
    const account = j.email || j.username || j.user || (loggedIn ? 'logged in' : null);
    return { loggedIn, account, rawStatus: j.status || null };
  } catch {
    const t = String(stdout || '');
    const loggedIn = /logged in|authenticated/i.test(t) && !/not logged|unauthenticated/i.test(t);
    return { loggedIn, account: null, rawStatus: null };
  }
}

class CursorCliAdapter {
  constructor(project) {
    this.project = project;
    this.kind = 'cursor-cli';
    this.settings = cursorSettings(project);
    this.bin = detectCursorBin(this.settings.bin);
  }

  get wanted() { return this.settings.enabled; }

  get available() { return Boolean(this.settings.enabled && this.bin); }

  get cachedLogin() {
    const hit = this.bin && loginCache.get(this.bin);
    if (!hit || Date.now() - hit.at > 5 * 60 * 1000) return null;
    return hit;
  }

  unavailableExplanation() {
    if (!this.bin) {
      return {
        code: 'CURSOR_CLI_MISSING',
        title: 'Cursor CLI is not installed.',
        cause: 'Neither `cursor` nor `agent` was found on PATH (including ~/.local/bin).',
        action: 'Install the Cursor CLI (`agent` or `cursor`), then Connect Cursor to log in. Generate still uses the built-in engine until you are logged in.',
        category: 'configuration',
        evidence: [],
      };
    }
    return {
      code: 'CURSOR_CLI_NOT_LOGGED_IN',
      title: 'Cursor is not logged in.',
      cause: 'The Cursor CLI is installed but this account has not completed `agent login`.',
      action: 'Click Connect Cursor. A browser window should open. Finish signing in, then Test.',
      category: 'configuration',
      evidence: [],
    };
  }

  async whoami() {
    if (!this.bin) return { loggedIn: false, ...this.unavailableExplanation() };
    const cached = this.cachedLogin;
    if (cached) return { loggedIn: cached.loggedIn, account: cached.account };
    try {
      const r = await runCli(this.bin, ['whoami', '--format', 'json'], { timeoutMs: 30000 });
      const parsed = parseWhoami(r.stdout || r.stderr);
      loginCache.set(this.bin, { at: Date.now(), loggedIn: parsed.loggedIn, account: parsed.account });
      return parsed;
    } catch (e) {
      loginCache.set(this.bin, { at: Date.now(), loggedIn: false, account: null });
      return { loggedIn: false, title: e.title || e.message, cause: e.cause || e.message, action: e.action };
    }
  }

  startLogin() {
    if (!this.bin) return { ok: false, ...this.unavailableExplanation() };
    spawnDetached(this.bin, ['login'], { cwd: config.root });
    return {
      ok: true,
      started: true,
      kind: 'cursor-cli',
      command: `${path.basename(this.bin)} login`,
      title: 'Cursor login started.',
      text: 'A browser window should open for Cursor. Finish signing in, then click Test. Nothing is stored in this app.',
    };
  }

  async testConnection() {
    if (!this.bin) return { ok: false, ...this.unavailableExplanation() };
    const t0 = Date.now();
    loginCache.delete(this.bin);
    const status = await this.whoami();
    if (!status.loggedIn) {
      return {
        ok: false,
        title: 'Cursor is not logged in.',
        cause: status.cause || 'whoami did not report an authenticated session.',
        action: 'Click Connect Cursor, complete browser login, then Test again.',
        loggedIn: false,
        bin: path.basename(this.bin),
        ms: Date.now() - t0,
      };
    }
    return {
      ok: true,
      kind: 'cursor-cli',
      loggedIn: true,
      bin: path.basename(this.bin),
      account: status.account,
      ms: Date.now() - t0,
    };
  }

  async generate(prompt) {
    if (!this.available) {
      const err = this.unavailableExplanation();
      throw Object.assign(new Error(err.title), err);
    }
    const status = await this.whoami();
    if (!status.loggedIn) {
      const err = this.unavailableExplanation();
      throw Object.assign(new Error(err.title), err);
    }
    const args = ['--print', '--output-format', 'json', '--mode', 'ask', '--trust', '--workspace', config.root, prompt];
    const r = await runCli(this.bin, args, { timeoutMs: this.settings.timeoutMs, cwd: config.root });
    if (r.code !== 0 && !r.stdout.trim()) {
      throw Object.assign(new Error('Cursor CLI failed.'), {
        code: 'CURSOR_CLI_FAILED',
        title: 'Cursor CLI failed to generate a proposal.',
        cause: (r.stderr || `exit ${r.code}`).slice(0, 300),
        action: 'Confirm you are logged in (Test connection), then retry. Generate will use the built-in engine.',
      });
    }
    return r.stdout;
  }
}

function cursorFor(project) {
  return new CursorCliAdapter(project);
}

module.exports = { CursorCliAdapter, cursorFor, cursorSettings, detectCursorBin, parseWhoami };
