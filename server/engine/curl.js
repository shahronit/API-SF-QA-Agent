'use strict';
/**
 * Parse a cURL command into a request builder payload, and generate client snippets.
 */

function strip(s) {
  return String(s || '').trim();
}

function unquote(s) {
  s = strip(s);
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
  return s.replace(/\\ /g, ' ');
}

function tokenize(src) {
  const s = String(src || '').replace(/\\\r?\n/g, ' ').replace(/^curl\s+/i, 'curl ');
  const tokens = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q && s[i - 1] !== '\\') { q = null; continue; }
      if (c === '\\' && q === '"' && s[i + 1]) { cur += s[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; continue; }
    if (/\s/.test(c)) { if (cur) { tokens.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function splitHeader(h) {
  const i = h.indexOf(':');
  if (i < 1) return null;
  return { key: h.slice(0, i).trim(), value: h.slice(i + 1).trim(), enabled: true };
}

function parse(src) {
  const tokens = tokenize(src);
  if (!tokens.length || !/^curl$/i.test(tokens[0])) {
    throw new Error('Paste a cURL command starting with curl.');
  }
  const out = {
    method: 'GET',
    url: '',
    path: '',
    headers: [],
    query: [],
    body: '',
    bodyMode: 'none',
    auth: 'none',
    authConfig: {},
    form: [],
  };
  let data = [];
  let urlencoded = false;
  let form = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => tokens[++i];
    if (t === '-X' || t === '--request') out.method = String(next() || 'GET').toUpperCase();
    else if (t === '-H' || t === '--header') {
      const h = splitHeader(next() || '');
      if (h) out.headers.push(h);
    } else if (t === '-u' || t === '--user') {
      const [user, pass] = String(next() || '').split(':');
      out.auth = 'basic';
      out.authConfig = { username: user || '', password: pass || '' };
    } else if (t === '-b' || t === '--cookie') {
      out.headers.push({ key: 'Cookie', value: next() || '', enabled: true });
    } else if (t === '-A' || t === '--user-agent') {
      out.headers.push({ key: 'User-Agent', value: next() || '', enabled: true });
    } else if (t === '-e' || t === '--referer') {
      out.headers.push({ key: 'Referer', value: next() || '', enabled: true });
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
      data.push(next() || '');
      urlencoded = urlencoded || t === '--data' || t === '-d';
    } else if (t === '--data-urlencode') {
      data.push(next() || '');
      urlencoded = true;
    } else if (t === '-F' || t === '--form') {
      form = true;
      const raw = next() || '';
      const eq = raw.indexOf('=');
      out.form.push({ key: eq === -1 ? raw : raw.slice(0, eq), value: eq === -1 ? '' : raw.slice(eq + 1).replace(/^@/, ''), enabled: true, type: raw.includes('=@') ? 'file' : 'text' });
    } else if (t === '--url') out.url = next() || '';
    else if (t === '-G' || t === '--get') out.method = 'GET';
    else if (t === '-I' || t === '--head') out.method = 'HEAD';
    else if (t === '-k' || t === '--insecure') out.sslVerify = false;
    else if (t === '-x' || t === '--proxy') out.proxyUrl = next() || '';
    else if (!t.startsWith('-') && !out.url) out.url = t;
  }
  if (!out.url) throw new Error('cURL command has no URL.');
  if (!/^https?:\/\//i.test(out.url) && !/^\{\{/.test(out.url)) out.url = 'https://' + out.url;
  try {
    const u = new URL(out.url);
    for (const [k, v] of u.searchParams) out.query.push({ key: k, value: v, enabled: true });
    u.search = '';
    out.url = u.toString();
    out.path = u.toString();
  } catch {
    out.path = out.url;
  }
  const authH = out.headers.find((h) => /^authorization$/i.test(h.key));
  if (authH && /^Bearer\s+/i.test(authH.value) && out.auth === 'none') {
    out.auth = 'bearer';
    out.authConfig = { token: authH.value.replace(/^Bearer\s+/i, '') };
  }
  out.headerRows = out.headers;
  out.queryRows = out.query;
  if (form) {
    out.bodyMode = 'formdata';
    if (!['POST', 'PUT', 'PATCH'].includes(out.method)) out.method = 'POST';
  } else if (data.length) {
    const joined = data.join('&');
    const ct = (out.headers.find((h) => /^content-type$/i.test(h.key)) || {}).value || '';
    if (urlencoded && !/json/i.test(ct)) {
      out.bodyMode = 'urlencoded';
      out.form = joined.split('&').filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return { key: decodeURIComponent(i === -1 ? p : p.slice(0, i)), value: decodeURIComponent(i === -1 ? '' : p.slice(i + 1)), enabled: true };
      });
    } else if (/xml/i.test(ct) || /^\s*</.test(joined)) {
      out.bodyMode = 'xml';
      out.body = joined;
    } else {
      out.bodyMode = /json/i.test(ct) || /^\s*[\[{]/.test(joined) ? 'json' : 'text';
      out.body = joined;
    }
    if (out.method === 'GET') out.method = 'POST';
  }
  return out;
}

function headerLines(headers) {
  if (!headers) return [];
  const rows = Array.isArray(headers)
    ? headers
    : Object.values(headers).every((v) => v && typeof v === 'object' && 'key' in v)
      ? Object.values(headers)
      : Object.entries(headers).map(([key, value]) => (value && typeof value === 'object' && 'key' in value ? value : { key, value }));
  return rows.filter((h) => h && h.enabled !== false && h.key && (typeof h.value !== 'object' || h.value === null));
}

function snippetCurl(req) {
  const parts = ['curl', '-X', req.method || 'GET', `'${req.url || req.path || ''}'`];
  for (const h of headerLines(req.headers)) parts.push('-H', `'${h.key}: ${h.value}'`);
  if (req.body && !['GET', 'HEAD'].includes(req.method)) {
    parts.push('--data-raw', `'${String(req.body).replace(/'/g, `'\\''`)}'`);
  }
  return parts.join(' ');
}

function snippetFetch(req) {
  const headers = {};
  for (const h of headerLines(req.headers)) headers[h.key] = h.value;
  const init = { method: req.method || 'GET', headers };
  if (req.body && !['GET', 'HEAD'].includes(req.method)) init.body = req.body;
  return `fetch(${JSON.stringify(req.url || req.path || '')}, ${JSON.stringify(init, null, 2)})\n  .then((r) => r.text())\n  .then(console.log);`;
}

function snippetPython(req) {
  const headers = {};
  for (const h of headerLines(req.headers)) headers[h.key] = h.value;
  const lines = ['import requests', '', `url = ${JSON.stringify(req.url || req.path || '')}`, `headers = ${JSON.stringify(headers, null, 2)}`];
  if (req.body && !['GET', 'HEAD'].includes(req.method)) {
    lines.push(`body = ${JSON.stringify(String(req.body))}`);
    lines.push(`r = requests.request(${JSON.stringify(req.method || 'GET')}, url, headers=headers, data=body)`);
  } else {
    lines.push(`r = requests.request(${JSON.stringify(req.method || 'GET')}, url, headers=headers)`);
  }
  lines.push('print(r.status_code)', 'print(r.text)');
  return lines.join('\n');
}

function snippetNode(req) {
  let u;
  try { u = new URL(req.url || req.path || 'https://example.com'); } catch { u = new URL('https://example.com'); }
  const headers = {};
  for (const h of headerLines(req.headers)) headers[h.key] = h.value;
  const body = req.body && !['GET', 'HEAD'].includes(req.method) ? String(req.body) : '';
  const lib = u.protocol === 'https:' ? 'https' : 'http';
  return `const ${lib} = require('node:${lib}');
const body = ${JSON.stringify(body)};
const req = ${lib}.request({
  hostname: ${JSON.stringify(u.hostname)},
  port: ${JSON.stringify(u.port || (u.protocol === 'https:' ? 443 : 80))},
  path: ${JSON.stringify(u.pathname + u.search)},
  method: ${JSON.stringify(req.method || 'GET')},
  headers: ${JSON.stringify(headers, null, 2)},
}, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => console.log(res.statusCode, data));
});
if (body) req.write(body);
req.end();`;
}

function snippets(req) {
  return {
    curl: snippetCurl(req),
    fetch: snippetFetch(req),
    python: snippetPython(req),
    node: snippetNode(req),
  };
}

module.exports = { parse, snippets, tokenize };
