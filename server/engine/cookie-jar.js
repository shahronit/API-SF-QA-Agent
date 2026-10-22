'use strict';
/**
 * RFC 6265-lite cookie jar persisted per project. Domain/path matching,
 * expiry, Secure, httpOnly. Used by the HTTP transport so redirects keep cookies.
 */
const crypto = require('node:crypto');
const { repo, now } = require('../db');

function parseSetCookie(raw) {
  const parts = String(raw || '').split(';').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const eq = parts[0].indexOf('=');
  if (eq < 1) return null;
  const cookie = {
    name: parts[0].slice(0, eq).trim(),
    value: parts[0].slice(eq + 1).trim(),
    path: '/',
    domain: '',
    httpOnly: 0,
    secure: 0,
    sameSite: '',
    expires: null,
  };
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    const k = (i === -1 ? p : p.slice(0, i)).trim().toLowerCase();
    const v = i === -1 ? '' : p.slice(i + 1).trim();
    if (k === 'domain') cookie.domain = v.replace(/^\./, '').toLowerCase();
    else if (k === 'path') cookie.path = v || '/';
    else if (k === 'httponly') cookie.httpOnly = 1;
    else if (k === 'secure') cookie.secure = 1;
    else if (k === 'samesite') cookie.sameSite = v;
    else if (k === 'expires') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) cookie.expires = d.toISOString();
    } else if (k === 'max-age') {
      const n = Number(v);
      if (Number.isFinite(n)) cookie.expires = new Date(Date.now() + n * 1000).toISOString();
    }
  }
  return cookie.name ? cookie : null;
}

function hostMatches(cookieDomain, host) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  if (!d) return true;
  if (h === d) return true;
  return h.endsWith('.' + d);
}

function pathMatches(cookiePath, urlPath) {
  const p = cookiePath || '/';
  const u = urlPath || '/';
  if (p === '/') return true;
  if (u === p) return true;
  return u.startsWith(p.endsWith('/') ? p : p + '/') || u.startsWith(p);
}

function expired(row) {
  if (!row || !row.expires) return false;
  return new Date(row.expires).getTime() <= Date.now();
}

function list(projectId) {
  const rows = repo.find('http_cookies', 'projectId = $p', { p: projectId }, 'ORDER BY domain, path, name');
  return rows.filter((r) => {
    if (expired(r)) {
      repo.remove('http_cookies', r.id);
      return false;
    }
    return true;
  });
}

function upsert(projectId, cookie, fallbackHost) {
  const domain = (cookie.domain || fallbackHost || '').replace(/^\./, '').toLowerCase();
  const path = cookie.path || '/';
  const existing = repo.one('http_cookies', 'projectId = $p AND domain = $d AND path = $path AND name = $n', {
    p: projectId, d: domain, path, n: cookie.name,
  });
  const row = {
    projectId,
    domain,
    path,
    name: cookie.name,
    value: cookie.value,
    expires: cookie.expires || null,
    httpOnly: cookie.httpOnly ? 1 : 0,
    secure: cookie.secure ? 1 : 0,
    sameSite: cookie.sameSite || '',
    updatedAt: now(),
  };
  if (existing) {
    repo.update('http_cookies', existing.id, row);
    return { ...existing, ...row, id: existing.id };
  }
  const created = { id: crypto.randomUUID(), ...row, createdAt: now() };
  repo.insert('http_cookies', created);
  return created;
}

function storeFromResponse(projectId, url, setCookieHeaders) {
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  const out = [];
  for (const raw of setCookieHeaders || []) {
    const c = parseSetCookie(raw);
    if (!c) continue;
    if (c.domain && !hostMatches(c.domain, host)) continue;
    out.push(upsert(projectId, c, host));
  }
  return out;
}

function matching(projectId, url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const https = u.protocol === 'https:';
  return list(projectId).filter((c) => {
    if (c.secure && !https) return false;
    if (!hostMatches(c.domain, u.hostname)) return false;
    if (!pathMatches(c.path, u.pathname || '/')) return false;
    return true;
  });
}

function cookieHeader(projectId, url) {
  const rows = matching(projectId, url);
  if (!rows.length) return '';
  return rows.map((c) => `${c.name}=${c.value}`).join('; ');
}

function jarFor(projectId) {
  return {
    cookieHeader: (url) => cookieHeader(projectId, url),
    storeSetCookie: (url, headers) => storeFromResponse(projectId, url, headers),
  };
}

function clear(projectId, id) {
  if (id) {
    const row = repo.get('http_cookies', id);
    if (row && row.projectId === projectId) repo.remove('http_cookies', id);
    return { deleted: true };
  }
  const rows = repo.find('http_cookies', 'projectId = $p', { p: projectId });
  for (const r of rows) repo.remove('http_cookies', r.id);
  return { deleted: rows.length };
}

module.exports = {
  parseSetCookie, hostMatches, pathMatches, list, upsert, storeFromResponse,
  matching, cookieHeader, jarFor, clear, expired,
};
