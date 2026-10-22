'use strict';
/**
 * Gemini CLI (`gemini`) for script generation.
 * Official login (docs): run `gemini`, then choose Sign in with Google.
 * There is no `gemini login` / `gemini auth login` subcommand in --help/docs.
 * Status: cached Google sign-in files under ~/.gemini (presence only, never read).
 * Generate: `--prompt` / `-p` with `--output-format json`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findBin, runCli, spawnDetached } = require('../lib/cli-spawn');
const { config } = require('../config');

function envFlag(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

function geminiSettings(project) {
  const fromCfg = (project && project.integrationConfig && project.integrationConfig.gemini) || {};
  return {
    enabled: fromCfg.enabled === true || envFlag(process.env.GEMINI_CLI_ENABLED),
    bin: String(fromCfg.bin || process.env.GEMINI_CLI_BIN || '').trim(),
    timeoutMs: Number(fromCfg.timeoutMs || process.env.GEMINI_CLI_TIMEOUT_MS || 90000),
  };
}

function detectGeminiBin(configured) {
  if (configured && path.isAbsolute(configured)) return findBin([configured]);
  if (configured) return findBin([configured, 'gemini']);
  return findBin(['gemini']);
}

/** Presence-only: Gemini caches Google login under ~/.gemini. Never read file contents. */
function geminiLoginFiles() {
  const dir = path.join(os.homedir(), '.gemini');
  return [
    path.join(dir, 'google_accounts.json'),
    path.join(dir, 'oauth_creds.json'),
    path.join(dir, 'oauth.json'),
  ];
}

function geminiSessionPresent() {
  return geminiLoginFiles().some((f) => {
    try { return fs.statSync(f).isFile() && fs.statSync(f).size > 0; } catch { return false; }
  });
}

class GeminiCliAdapter {
  constructor(project) {
    this.project = project;
    this.kind = 'gemini-cli';
    this.settings = geminiSettings(project);
    this.bin = detectGeminiBin(this.settings.bin);
  }

  get wanted() { return this.settings.enabled; }

  get available() { return Boolean(this.settings.enabled && this.bin); }

  get cachedLogin() {
    if (!this.bin) return null;
    const loggedIn = geminiSessionPresent();
    return { at: Date.now(), loggedIn, account: loggedIn ? 'Google account' : null };
  }

  unavailableExplanation() {
    if (!this.bin) {
      return {
        code: 'GEMINI_CLI_MISSING',
        title: 'Gemini CLI is not installed.',
        cause: '`gemini` was not found on PATH (including ~/.local/bin).',
        action: 'Install Gemini CLI (`gemini`), then Connect Gemini and choose Sign in with Google. Generate still uses the built-in engine until you are logged in.',
        category: 'configuration',
        evidence: [],
      };
    }
    return {
      code: 'GEMINI_CLI_NOT_LOGGED_IN',
      title: 'Gemini is not logged in.',
      cause: 'Gemini CLI is installed but no Google sign-in session was found.',
      action: 'Click Connect Gemini. In the CLI choose Sign in with Google, finish the browser flow, then Test.',
      category: 'configuration',
      evidence: [],
    };
  }

  async whoami() {
    if (!this.bin) return { loggedIn: false, ...this.unavailableExplanation() };
    const loggedIn = geminiSessionPresent();
    return { loggedIn, account: loggedIn ? 'Google account' : null };
  }

  startLogin() {
    if (!this.bin) return { ok: false, ...this.unavailableExplanation() };
    // Verified: Gemini has no login subcommand. Official flow is to start `gemini`
    // and select Sign in with Google. On macOS a Terminal window gives that TTY.
    if (process.platform === 'darwin') {
      spawnDetached('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(this.bin)}`]);
    } else {
      spawnDetached(this.bin, [], { cwd: config.root });
    }
    return {
      ok: true,
      started: true,
      kind: 'gemini-cli',
      command: path.basename(this.bin),
      title: 'Gemini login started.',
      text: 'Gemini CLI has no login subcommand. Connect opens `gemini` so you can choose Sign in with Google in the browser. Finish that, then click Test. Nothing is stored in this app.',
    };
  }

  async testConnection() {
    if (!this.bin) return { ok: false, ...this.unavailableExplanation() };
    const t0 = Date.now();
    const status = await this.whoami();
    if (!status.loggedIn) {
      return {
        ok: false,
        title: 'Gemini is not logged in.',
        cause: 'No Google sign-in session is cached for Gemini CLI.',
        action: 'Click Connect Gemini, choose Sign in with Google, then Test again.',
        loggedIn: false,
        bin: path.basename(this.bin),
        ms: Date.now() - t0,
      };
    }
    return {
      ok: true,
      kind: 'gemini-cli',
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
    const args = ['--output-format', 'json', '--prompt', prompt];
    const r = await runCli(this.bin, args, { timeoutMs: this.settings.timeoutMs, cwd: config.root });
    if (r.code !== 0 && !r.stdout.trim()) {
      throw Object.assign(new Error('Gemini CLI failed.'), {
        code: 'GEMINI_CLI_FAILED',
        title: 'Gemini CLI failed to generate a proposal.',
        cause: (r.stderr || `exit ${r.code}`).slice(0, 300),
        action: 'Confirm you are logged in (Test connection), then retry. Generate will use the built-in engine.',
      });
    }
    return r.stdout;
  }
}

function geminiFor(project) {
  return new GeminiCliAdapter(project);
}

module.exports = { GeminiCliAdapter, geminiFor, geminiSettings, detectGeminiBin, geminiSessionPresent };
