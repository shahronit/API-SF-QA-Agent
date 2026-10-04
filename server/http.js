'use strict';
/**
 * Minimal, dependency-free HTTP layer: routing, JSON bodies, static files,
 * security headers and consistent, explanatory error responses.
 */
const fs = require('node:fs');
const path = require('node:path');
const { maskDeep } = require('./lib/mask');
const { config } = require('./config');

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message  Human explanation of what happened.
   * @param {object} [info]   { cause, evidence, action, code }
   */
  constructor(status, message, info = {}) {
    super(message);
    this.status = status;
    this.info = info;
  }
}

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(
    '^' + pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$'
  );
  routes.push({ method, rx, keys, handler });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body exceeds ${Math.round(limit / 1024 / 1024)} MB.`, {
          action: 'Split the import into smaller files or reduce the payload size.',
        }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function currentUser(req) {
  // Behind an SSO proxy, trust its identity header; otherwise the configured local user.
  const h = req.headers['x-forwarded-user'] || req.headers['x-auth-request-user'];
  return (typeof h === 'string' && h.slice(0, 120)) || config.appUser;
}

function serveStatic(req, res, pathname) {
  const publicDir = path.join(config.root, 'public');
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep)) return send(res, 403, { error: 'Path outside public directory.' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: `Static file not found: ${rel}` });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, pathname);
  }
  const started = Date.now();
  try {
    const match = routes.find((r) => r.method === req.method && r.rx.test(pathname));
    if (!match) {
      const exists = routes.some((r) => r.rx.test(pathname));
      throw new HttpError(exists ? 405 : 404, exists
        ? `${req.method} is not supported on ${pathname}.`
        : `No API route matches ${req.method} ${pathname}.`, { action: 'Check docs/API.md for the supported endpoints.' });
    }
    const m = pathname.match(match.rx);
    const params = {};
    match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

    let body = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const raw = await readBody(req);
      if (raw) {
        // Requiring JSON blocks cross-site HTML form posts (CSRF) against this local server.
        const ct = String(req.headers['content-type'] || '');
        if (!ct.includes('application/json')) {
          throw new HttpError(415, 'Request bodies must be sent as application/json.', {
            action: 'Set the Content-Type header to application/json.',
          });
        }
        try { body = JSON.parse(raw); } catch (e) {
          throw new HttpError(400, `Request body is not valid JSON: ${e.message}`, { action: 'Fix the JSON syntax and retry.' });
        }
      }
    }
    const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body, user: currentUser(req), url };
    const result = await match.handler(ctx);
    if (res.writableEnded || res.headersSent) return;
    if (result && result.__raw) {
      return send(res, result.status || 200, result.body, result.headers);
    }
    send(res, result === undefined ? 204 : 200, result === undefined ? '' : maskDeep(result));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error(`[api] ${req.method} ${pathname} failed:`, err);
    if (!res.headersSent) {
      send(res, status, maskDeep({
        error: err.message || 'Unexpected server error',
        status,
        ...(err.info || {}),
        ...(status >= 500 && !(err instanceof HttpError)
          ? { cause: 'Unhandled exception in the QA platform server.', action: 'Check the server console for the stack trace.' }
          : {}),
      }));
    }
  } finally {
    const ms = Date.now() - started;
    if (process.env.LOG_REQUESTS === 'true') console.log(`${req.method} ${pathname} ${res.statusCode} ${ms}ms`);
  }
}

/** Server-sent events helper. Returns a `push(event, data)` function. */
function sse(res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => clearInterval(ping));
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(maskDeep(data))}\n\n`);
  };
}

const raw = (body, headers = {}, status = 200) => ({ __raw: true, body, headers, status });

function required(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length) {
    throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}.`, {
      action: `Provide ${missing.join(', ')} in the request body.`,
    });
  }
}

module.exports = { route, handle, HttpError, sse, raw, required, send };
