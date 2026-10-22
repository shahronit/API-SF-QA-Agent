'use strict';
/**
 * Minimal unary gRPC client: proto text → service/method list → protobuf encode → HTTP/2.
 * Streaming RPCs are detected and rejected with a clear message.
 */
const http2 = require('node:http2');
const fs = require('node:fs');

const WIRE = { VARINT: 0, FIXED64: 1, LEN: 2, FIXED32: 5 };

function encodeVarint(n) {
  const out = [];
  n = Number(n) >>> 0;
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

function encodeKey(field, wire) { return encodeVarint((field << 3) | wire); }

function encodeString(field, value) {
  const buf = Buffer.from(String(value ?? ''), 'utf8');
  return Buffer.concat([encodeKey(field, WIRE.LEN), encodeVarint(buf.length), buf]);
}
function encodeInt32(field, value) { return Buffer.concat([encodeKey(field, WIRE.VARINT), encodeVarint(Number(value) || 0)]); }
function encodeBool(field, value) { return encodeInt32(field, value ? 1 : 0); }
function encodeBytes(field, value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'base64');
  return Buffer.concat([encodeKey(field, WIRE.LEN), encodeVarint(buf.length), buf]);
}

function decodeVarint(buf, offset) {
  let n = 0, shift = 0, i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: n >>> 0, offset: i };
}

function parseProto(text) {
  const src = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const pkg = (src.match(/package\s+([\w.]+)\s*;/) || [])[1] || '';
  const messages = {};
  const msgRx = /message\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = msgRx.exec(src))) {
    const fields = [];
    const body = m[2];
    const fRx = /(repeated\s+)?(\w+)\s+(\w+)\s*=\s*(\d+)\s*;/g;
    let f;
    while ((f = fRx.exec(body))) {
      fields.push({ repeated: Boolean(f[1]), type: f[2], name: f[3], id: Number(f[4]) });
    }
    messages[m[1]] = { name: m[1], fields };
  }
  const services = [];
  const svcRx = /service\s+(\w+)\s*\{([^}]*)\}/g;
  while ((m = svcRx.exec(src))) {
    const methods = [];
    const body = m[2];
    const rRx = /rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/g;
    let r;
    while ((r = rRx.exec(body))) {
      methods.push({
        name: r[1],
        requestStream: Boolean(r[2]),
        requestType: r[3].split('.').pop(),
        responseStream: Boolean(r[4]),
        responseType: r[5].split('.').pop(),
      });
    }
    services.push({ name: m[1], package: pkg, methods });
  }
  return { package: pkg, messages, services };
}

function encodeMessage(msg, payload = {}) {
  if (!msg) return Buffer.alloc(0);
  const parts = [];
  for (const f of msg.fields) {
    const v = payload[f.name];
    if (v === undefined || v === null) continue;
    const values = f.repeated ? [].concat(v) : [v];
    for (const item of values) {
      if (f.type === 'string') parts.push(encodeString(f.id, item));
      else if (f.type === 'bool') parts.push(encodeBool(f.id, item));
      else if (f.type === 'bytes') parts.push(encodeBytes(f.id, item));
      else if (/int|uint|sint/.test(f.type)) parts.push(encodeInt32(f.id, item));
      else if (typeof item === 'object') {
        const inner = encodeMessage({ fields: [] }, item);
        parts.push(Buffer.concat([encodeKey(f.id, WIRE.LEN), encodeVarint(inner.length), inner]));
      } else parts.push(encodeString(f.id, item));
    }
  }
  return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
}

function decodeMessage(msg, buf) {
  const out = {};
  if (!msg) return { rawBase64: buf.toString('base64') };
  let i = 0;
  while (i < buf.length) {
    const key = decodeVarint(buf, i);
    i = key.offset;
    const field = key.value >>> 3;
    const wire = key.value & 7;
    const spec = (msg.fields || []).find((f) => f.id === field);
    let value;
    if (wire === WIRE.VARINT) {
      const v = decodeVarint(buf, i); i = v.offset; value = spec && spec.type === 'bool' ? Boolean(v.value) : v.value;
    } else if (wire === WIRE.LEN) {
      const len = decodeVarint(buf, i); i = len.offset;
      const slice = buf.subarray(i, i + len.value); i += len.value;
      value = spec && spec.type === 'bytes' ? slice.toString('base64') : slice.toString('utf8');
    } else if (wire === WIRE.FIXED32) { value = buf.readUInt32LE(i); i += 4; }
    else if (wire === WIRE.FIXED64) { value = buf.readBigUInt64LE(i).toString(); i += 8; }
    else break;
    const name = spec ? spec.name : `field_${field}`;
    if (spec && spec.repeated) { (out[name] = out[name] || []).push(value); } else out[name] = value;
  }
  return out;
}

function grpcFrame(payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(0, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function parseGrpcFrame(buf) {
  if (!buf || buf.length < 5) return Buffer.alloc(0);
  const len = buf.readUInt32BE(1);
  return buf.subarray(5, 5 + len);
}

function callUnary({ target, packageName, service, method, message, payload, proto, metadata = {}, settings = {}, timeoutMs = 15000 }) {
  const parsed = proto && typeof proto === 'object' && proto.messages ? proto : parseProto(proto || '');
  const svc = (parsed.services || []).find((s) => s.name === service) || parsed.services[0];
  if (!svc) return Promise.reject(Object.assign(new Error('No gRPC service found in the proto.'), { status: 400 }));
  const rpc = (svc.methods || []).find((m) => m.name === method);
  if (!rpc) return Promise.reject(Object.assign(new Error(`Method ${method} not found on ${svc.name}.`), { status: 400 }));
  if (rpc.requestStream || rpc.responseStream) {
    return Promise.reject(Object.assign(new Error('Streaming RPCs are not supported yet — use a unary method.'), { status: 400 }));
  }
  const reqMsg = parsed.messages[rpc.requestType];
  const resMsg = parsed.messages[rpc.responseType];
  const packed = encodeMessage(reqMsg, payload || message || {});
  const path = `/${[packageName || parsed.package, svc.name].filter(Boolean).join('.')}/${rpc.name}`;
  const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const u = new URL(url);
  const authority = u.host;
  const started = performance.now();

  return new Promise((resolve, reject) => {
    const isTls = u.protocol !== 'http:';
    const session = http2.connect(`${isTls ? 'https' : 'http'}://${authority}`, {
      rejectUnauthorized: settings.sslVerify !== false,
      ca: settings.ca || undefined,
      cert: settings.cert || undefined,
      key: settings.key || undefined,
    });
    const timer = setTimeout(() => { session.close(); reject(Object.assign(new Error('gRPC call timed out.'), { code: 'TIMEOUT' })); }, timeoutMs);
    session.on('error', (e) => { clearTimeout(timer); reject(e); });
    const headers = {
      ':method': 'POST',
      ':path': path,
      ':scheme': isTls ? 'https' : 'http',
      ':authority': authority,
      'content-type': 'application/grpc',
      te: 'trailers',
      'user-agent': 'qa-platform-grpc/1.0',
      ...Object.fromEntries(Object.entries(metadata || {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
    };
    const req = session.request(headers);
    const chunks = [];
    let resHeaders = {};
    let trailers = {};
    req.on('response', (h) => { resHeaders = h; });
    req.on('data', (c) => chunks.push(c));
    req.on('trailers', (h) => { trailers = h; });
    req.on('end', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      const payloadBuf = parseGrpcFrame(buf);
      const grpcStatus = Number(trailers['grpc-status'] || resHeaders['grpc-status'] || 0);
      const grpcMessage = decodeURIComponent(String(trailers['grpc-message'] || resHeaders['grpc-message'] || ''));
      let decoded;
      try { decoded = decodeMessage(resMsg, payloadBuf); } catch { decoded = { rawBase64: payloadBuf.toString('base64') }; }
      session.close();
      resolve({
        status: grpcStatus === 0 ? 200 : 500,
        grpcStatus,
        grpcMessage,
        headers: { ...resHeaders, ...trailers },
        body: decoded,
        text: JSON.stringify(decoded, null, 2),
        timeMs: Math.round(performance.now() - started),
        sizeBytes: buf.length,
        url: `${u.origin}${path}`,
        path,
      });
    });
    req.on('error', (e) => { clearTimeout(timer); session.close(); reject(e); });
    req.end(grpcFrame(packed));
  });
}

function loadProto(textOrPath) {
  if (!textOrPath) return parseProto('');
  if (/\.proto$/i.test(textOrPath) && fs.existsSync(textOrPath)) return parseProto(fs.readFileSync(textOrPath, 'utf8'));
  return parseProto(textOrPath);
}

module.exports = { parseProto, encodeMessage, decodeMessage, callUnary, loadProto, grpcFrame };
