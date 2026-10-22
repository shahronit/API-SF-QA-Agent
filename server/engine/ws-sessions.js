'use strict';
/**
 * Server-side WebSocket sessions. The browser talks to the QA platform over
 * REST + SSE; the platform holds the real WebSocket to the target.
 */
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const sessions = new Map(); // id -> { ws, emitter, url, projectId, messages, openedAt }

function connect({ url, headers = {}, protocols, projectId }) {
  if (typeof WebSocket !== 'function') {
    throw Object.assign(new Error('This Node.js build has no WebSocket (needs Node 22+).'), { status: 500 });
  }
  const id = crypto.randomUUID();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const ws = new WebSocket(url, protocols || undefined, { headers });
  const rec = { id, ws, emitter, url, projectId, messages: [], openedAt: Date.now(), status: 'connecting' };
  sessions.set(id, rec);

  const push = (entry) => {
    rec.messages.push(entry);
    if (rec.messages.length > 500) rec.messages.shift();
    emitter.emit('event', entry);
  };

  ws.addEventListener('open', () => {
    rec.status = 'open';
    push({ type: 'open', ts: Date.now(), url });
  });
  ws.addEventListener('message', (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : (Buffer.isBuffer(ev.data) ? ev.data.toString('utf8') : String(ev.data));
    push({ type: 'message', ts: Date.now(), data, from: 'server' });
  });
  ws.addEventListener('error', (ev) => {
    rec.status = 'error';
    push({ type: 'error', ts: Date.now(), message: (ev && ev.message) || 'WebSocket error' });
  });
  ws.addEventListener('close', (ev) => {
    rec.status = 'closed';
    push({ type: 'close', ts: Date.now(), code: ev.code, reason: ev.reason || '' });
  });
  return { id, url, status: rec.status };
}

function get(id) {
  return sessions.get(id) || null;
}

function send(id, { data, json }) {
  const rec = sessions.get(id);
  if (!rec) throw Object.assign(new Error('WebSocket session not found.'), { status: 404 });
  if (rec.ws.readyState !== WebSocket.OPEN) throw Object.assign(new Error('WebSocket is not open.'), { status: 409 });
  const payload = json !== undefined ? JSON.stringify(json) : String(data ?? '');
  rec.ws.send(payload);
  const entry = { type: 'message', ts: Date.now(), data: payload, from: 'client' };
  rec.messages.push(entry);
  rec.emitter.emit('event', entry);
  return { ok: true };
}

function close(id, code, reason) {
  const rec = sessions.get(id);
  if (!rec) return { closed: false };
  try { rec.ws.close(code || 1000, reason || 'client close'); } catch { /* ignore */ }
  rec.status = 'closed';
  return { closed: true };
}

function snapshot(id) {
  const rec = sessions.get(id);
  if (!rec) return null;
  return { id: rec.id, url: rec.url, status: rec.status, messages: rec.messages.slice(-200), openedAt: rec.openedAt };
}

module.exports = { connect, get, send, close, snapshot, sessions };
