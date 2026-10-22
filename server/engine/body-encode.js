'use strict';
/**
 * Encode explorer / runner bodies for none, raw, urlencoded, form-data, binary, GraphQL.
 */
const crypto = require('node:crypto');

function enabledRows(rows) {
  return (rows || []).filter((r) => r && r.key && r.enabled !== false && r.disabled !== true);
}

function encodeUrlencoded(rows) {
  const p = new URLSearchParams();
  for (const r of enabledRows(rows)) p.append(String(r.key), r.value === undefined || r.value === null ? '' : String(r.value));
  return { body: p.toString(), contentType: 'application/x-www-form-urlencoded' };
}

function encodeMultipart(rows) {
  const boundary = '----QAForm' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const r of enabledRows(rows)) {
    const name = String(r.key);
    if (r.type === 'file' || r.filename) {
      const filename = r.filename || 'file';
      const ct = r.contentType || 'application/octet-stream';
      const data = r.encoding === 'latin1'
        ? Buffer.from(String(r.value || ''), 'latin1')
        : Buffer.from(String(r.value || ''), 'base64');
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${ct}\r\n\r\n`
      ));
      chunks.push(data);
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${r.value === undefined || r.value === null ? '' : String(r.value)}\r\n`
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function encodeGraphql(gql = {}) {
  const payload = {
    query: String(gql.query || ''),
    variables: gql.variables && typeof gql.variables === 'object' ? gql.variables : (gql.variables ? JSON.parse(String(gql.variables)) : {}),
  };
  if (gql.operationName) payload.operationName = gql.operationName;
  return { body: JSON.stringify(payload), contentType: 'application/json' };
}

function encodeBinary(bin = {}) {
  const buf = Buffer.from(String(bin.value || ''), bin.encoding === 'latin1' ? 'latin1' : 'base64');
  return { body: buf, contentType: bin.contentType || 'application/octet-stream' };
}

/**
 * @returns {{ body: string|Buffer|null, contentType: string|null, jsonBody?: object }}
 */
function encode(mode, payload = {}) {
  const m = String(mode || payload.bodyMode || 'json').toLowerCase();
  if (m === 'none' || m === '') return { body: null, contentType: null };
  if (m === 'urlencoded' || m === 'x-www-form-urlencoded') return encodeUrlencoded(payload.form || payload.urlencoded || payload.bodyRows);
  if (m === 'formdata' || m === 'form-data' || m === 'multipart') return encodeMultipart(payload.form || payload.formData || payload.bodyRows);
  if (m === 'graphql') {
    try { return encodeGraphql(payload.graphql || payload); } catch (e) {
      throw Object.assign(new Error(`GraphQL variables must be JSON: ${e.message}`), { status: 400 });
    }
  }
  if (m === 'binary' || m === 'file') return encodeBinary(payload.binary || payload);
  if (m === 'xml' || m === 'raw-xml') {
    return { body: String(payload.bodyRaw ?? payload.body ?? ''), contentType: 'application/xml' };
  }
  if (m === 'text' || m === 'raw' || m === 'raw-text') {
    return { body: String(payload.bodyRaw ?? payload.body ?? ''), contentType: 'text/plain' };
  }
  // json (default)
  if (payload.body !== undefined && payload.body !== null && typeof payload.body === 'object') {
    return { body: JSON.stringify(payload.body), contentType: 'application/json', jsonBody: payload.body };
  }
  const text = payload.bodyRaw !== undefined ? String(payload.bodyRaw) : (payload.body === undefined || payload.body === null ? '' : String(payload.body));
  if (!text) return { body: null, contentType: null };
  try {
    const jsonBody = JSON.parse(text);
    return { body: JSON.stringify(jsonBody), contentType: 'application/json', jsonBody };
  } catch {
    return { body: text, contentType: 'application/json' };
  }
}

function contentTypeOf(headers = {}) {
  const k = Object.keys(headers).find((h) => h.toLowerCase() === 'content-type');
  return k ? headers[k] : '';
}

function applyContentType(headers, contentType) {
  if (!contentType) return headers;
  if (Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) return headers;
  headers['Content-Type'] = contentType;
  return headers;
}

module.exports = { encode, encodeUrlencoded, encodeMultipart, encodeGraphql, encodeBinary, enabledRows, applyContentType, contentTypeOf };
