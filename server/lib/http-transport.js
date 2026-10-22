'use strict';
/**
 * Dependency-free HTTP(S) client used by the generic explorer and HTTP connector.
 * Supports proxy, custom CA / client certs, SSL verification toggle, redirects
 * that keep cookies, and binary / multipart bodies.
 */
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { URL } = require('node:url');

const REDIRECT = new Set([301, 302, 303, 307, 308]);

function agentOptions(settings = {}) {
  const opts = {
    keepAlive: true,
    rejectUnauthorized: settings.sslVerify !== false,
  };
  if (settings.ca) opts.ca = settings.ca;
  if (settings.cert) opts.cert = settings.cert;
  if (settings.key) opts.key = settings.key;
  if (settings.passphrase) opts.passphrase = settings.passphrase;
  return opts;
}

function connectProxy(proxyUrl, hostname, port, timeoutMs, settings) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const isTls = proxy.protocol === 'https:';
    const connectReq = (isTls ? https : http).request({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port || (isTls ? 443 : 80),
      method: 'CONNECT',
      path: `${hostname}:${port}`,
      headers: {
        Host: `${hostname}:${port}`,
        ...(proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64')}` } : {}),
      },
      rejectUnauthorized: settings.sslVerify !== false,
      timeout: timeoutMs || 30000,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed (${res.statusCode})`));
        return;
      }
      resolve(socket);
    });
    connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('Proxy CONNECT timed out')); });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

function onceRequest(urlObj, { method, headers, body, timeoutMs, settings, socket }) {
  return new Promise((resolve, reject) => {
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
      timeout: timeoutMs || 30000,
      ...agentOptions(settings),
    };
    if (socket) {
      opts.createConnection = () => {
        if (!isHttps) return socket;
        return tls.connect({
          socket,
          servername: urlObj.hostname,
          ...agentOptions(settings),
        });
      };
    }
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          buffer: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })); });
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

function headerMap(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function setCookieList(rawHeaders) {
  if (!rawHeaders) return [];
  if (typeof rawHeaders.getSetCookie === 'function') return rawHeaders.getSetCookie();
  const sc = rawHeaders['set-cookie'];
  if (!sc) return [];
  return Array.isArray(sc) ? sc : [sc];
}

/**
 * @param {object} args
 * @param {string} args.method
 * @param {string} args.url
 * @param {object} [args.headers]
 * @param {string|Buffer} [args.body]
 * @param {number} [args.timeoutMs]
 * @param {object} [args.settings] { proxyUrl, sslVerify, ca, cert, key, passphrase }
 * @param {object} [args.cookieJar] { cookieHeader(url), storeSetCookie(url, list) }
 * @param {boolean} [args.followRedirects]
 * @param {number} [args.maxRedirects]
 */
async function request(args) {
  const method0 = String(args.method || 'GET').toUpperCase();
  let url = args.url;
  let method = method0;
  let body = args.body === undefined || args.body === null ? null : Buffer.isBuffer(args.body) ? args.body : Buffer.from(String(args.body));
  const settings = args.settings || {};
  const jar = args.cookieJar;
  const follow = args.followRedirects !== false;
  const maxRedirects = args.maxRedirects || 10;
  const timeoutMs = args.timeoutMs || 30000;
  let hops = 0;
  const started = performance.now();

  while (hops <= maxRedirects) {
    const urlObj = new URL(url);
    const headers = { ...(args.headers || {}) };
    if (jar && typeof jar.cookieHeader === 'function') {
      const cookie = jar.cookieHeader(url);
      if (cookie) {
        const existing = Object.keys(headers).find((h) => h.toLowerCase() === 'cookie');
        headers[existing || 'Cookie'] = existing ? `${headers[existing]}; ${cookie}` : cookie;
      }
    }
    if (body && body.length && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(body.length);
    }
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'host')) headers.Host = urlObj.host;
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) headers['User-Agent'] = 'Salesforce-API-QA-Platform/1.0';
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers.Accept = '*/*';
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'connection')) headers.Connection = 'close';

    let socket;
    if (settings.proxyUrl) {
      const port = Number(urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80));
      socket = await connectProxy(settings.proxyUrl, urlObj.hostname, port, timeoutMs, settings);
    }

    let res;
    try {
      res = await onceRequest(urlObj, { method, headers, body, timeoutMs, settings, socket });
    } catch (e) {
      if (socket && !socket.destroyed) socket.destroy();
      const err = e;
      err.timeMs = Math.round(performance.now() - started);
      err.url = url;
      throw err;
    }

    if (jar && typeof jar.storeSetCookie === 'function') {
      jar.storeSetCookie(url, setCookieList(res.headers));
    }

    if (follow && REDIRECT.has(res.status) && res.headers.location && hops < maxRedirects) {
      const next = new URL(res.headers.location, url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && !['GET', 'HEAD'].includes(method))) {
        method = 'GET';
        body = null;
        for (const k of Object.keys(headers)) {
          if (/^content-(type|length)$/i.test(k)) delete headers[k];
        }
      }
      url = next;
      hops += 1;
      continue;
    }

    const text = res.buffer.toString('utf8');
    const resHeaders = headerMap(res.headers);
    let parsed = text;
    const ct = resHeaders['content-type'] || resHeaders['Content-Type'] || '';
    if (ct.includes('json') && text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    return {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
      body: parsed,
      text,
      buffer: res.buffer,
      timeMs: Math.round(performance.now() - started),
      sizeBytes: res.buffer.length,
      url,
      requestHeaders: headers,
      requestBody: body ? body.toString('utf8') : null,
      redirected: hops > 0,
    };
  }
  const err = new Error(`Too many redirects (${maxRedirects})`);
  err.timeMs = Math.round(performance.now() - started);
  err.url = url;
  throw err;
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}

/** Refuse binding mock servers on non-loopback unless explicitly allowed. */
function assertLoopbackListen(host) {
  if (!isLoopback(host || '127.0.0.1')) {
    throw new Error('Mock servers bind to 127.0.0.1 only.');
  }
}

function httpSettings(project) {
  const h = (((project || {}).integrationConfig || {}).http || {});
  return {
    proxyUrl: h.proxyEnabled && h.proxyUrl ? h.proxyUrl : '',
    sslVerify: h.sslVerify !== false,
    ca: h.caCert || '',
    cert: h.clientCert || '',
    key: h.clientKey || '',
    passphrase: h.clientKeyPass || '',
  };
}

module.exports = { request, agentOptions, setCookieList, isLoopback, assertLoopbackListen, connectProxy, httpSettings };
