'use strict';
/**
 * Minimal DOM for headless UI smoke tests (no dependencies). Supports what the
 * SPA uses: innerHTML parsing/serialisation, querySelector(All) with compound,
 * descendant and grouped selectors, closest/matches, classList, dataset,
 * bubbling events, forms and basic element properties. Not a browser.
 */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const decode = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|#39|apos|nbsp);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()];
});
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  appendChild(n) { if (n.nodeType === 11) { [...n.childNodes].forEach((c) => this.appendChild(c)); return n; } if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) { if (!ref) return this.appendChild(n); if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
}
class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class ClassList {
  constructor(el) { this.el = el; }
  _get() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _set(a) { this.el.setAttribute('class', a.join(' ')); }
  contains(c) { return this._get().includes(c); }
  add(...c) { const a = this._get(); c.forEach((x) => { if (!a.includes(x)) a.push(x); }); this._set(a); }
  remove(...c) { this._set(this._get().filter((x) => !c.includes(x))); }
  toggle(c, force) { const has = this.contains(c); const want = force === undefined ? !has : Boolean(force); if (want && !has) this.add(c); if (!want && has) this.remove(c); return want; }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.localName = tag.toLowerCase(); this.attrs = new Map();
    this.listeners = {}; this.style = {}; this.classList = new ClassList(this); this._value = null; this._checked = null;
    this.scrollTop = 0; this.scrollHeight = 0; this.selectionStart = 0; this.indeterminate = false;
  }
  get nodeName() { return this.tagName; }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get dataset() {
    const el = this;
    return new Proxy({}, {
      get(_, k) { return typeof k === 'string' ? el.getAttribute(`data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`) ?? undefined : undefined; },
      set(_, k, v) { el.setAttribute(`data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, v); return true; },
    });
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get checked() { return this._checked === null ? this.hasAttribute('checked') : this._checked; }
  set checked(v) { this._checked = Boolean(v); }
  get value() {
    if (this._value !== null) return this._value;
    if (this.localName === 'textarea') return this.textContent;
    if (this.localName === 'select') { const opts = this.querySelectorAll('option'); const sel = opts.find((o) => o.hasAttribute('selected')) || opts[0]; return sel ? sel.value : ''; }
    if (this.localName === 'option') return this.hasAttribute('value') ? this.getAttribute('value') : this.textContent;
    return this.getAttribute('value') || (this.getAttribute('type') === 'checkbox' ? 'on' : '');
  }
  set value(v) { this._value = String(v); if (this.localName === 'select') this.querySelectorAll('option').forEach((o) => { if (o.value === String(v)) o.setAttribute('selected', ''); else o.removeAttribute('selected'); }); }
  get name() { return this.getAttribute('name'); }
  get type() { return this.getAttribute('type') || 'text'; }
  get href() { return this.getAttribute('href'); }
  get files() { return []; }
  get elements() { const out = {}; this.querySelectorAll('[name]').forEach((e) => { out[e.getAttribute('name')] = e; }); return out; }
  get offsetParent() { return this.parentNode; }
  get clientWidth() { return 900; }
  get offsetWidth() { return 200; }
  get offsetHeight() { return 40; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  click() { this.dispatchEvent(new Event('click', { bubbles: true })); }
  scrollIntoView() {}
  setSelectionRange() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 200, height: 40, right: 200, bottom: 40 }; }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; parseInto(this, String(html)); }
  get outerHTML() { return serialize(this); }
  insertAdjacentHTML(pos, html) {
    const tmp = this.ownerDocument.createElement('div'); tmp.innerHTML = html;
    const nodes = [...tmp.childNodes];
    if (pos === 'beforeend') nodes.forEach((n) => this.appendChild(n));
    else if (pos === 'afterbegin') nodes.reverse().forEach((n) => this.insertBefore(n, this.childNodes[0]));
    else if (pos === 'beforebegin') nodes.forEach((n) => this.parentNode.insertBefore(n, this));
    else if (pos === 'afterend') { const next = this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1]; nodes.forEach((n) => this.parentNode.insertBefore(n, next)); }
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatchEvent(e) {
    e.target = e.target || this;
    const path = []; for (let x = this; x; x = x.parentNode) path.push(x);
    if (this.ownerDocument && path[path.length - 1] === this.ownerDocument && this.ownerDocument.defaultView) path.push(this.ownerDocument.defaultView);
    for (const n of path) {
      e.currentTarget = n;
      for (const fn of [...((n.listeners || {})[e.type] || [])]) fn.call(n, e);
      if (e._stop || !e.bubbles) break;
    }
    return !e.defaultPrevented;
  }
  querySelectorAll(sel) { const out = []; const groups = parseSelector(sel); walk(this, (el) => { if (groups.some((g) => matchesComplex(el, g, this))) out.push(el); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return parseSelector(sel).some((g) => matchesComplex(this, g, null)); }
  closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.matches(sel)) return x; return null; }
}

class Event {
  constructor(type, opts = {}) { this.type = type; this.bubbles = Boolean(opts.bubbles); this.defaultPrevented = false; this._stop = false; Object.assign(this, opts.init || {}); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; }
}

function walk(root, fn) { for (const c of root.childNodes) if (c.nodeType === 1) { fn(c); walk(c, fn); } }

// ── Selectors ──
function parseSelector(sel) {
  return splitTop(sel, ',').map((g) => {
    const parts = []; let cur = ''; let depth = 0; let q = null;
    for (const ch of g.trim()) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '[' || ch === '(') depth++;
      if (ch === ']' || ch === ')') depth--;
      if (depth === 0 && (ch === ' ' || ch === '>')) { if (cur) parts.push(cur); cur = ''; if (ch === '>') parts.push('>'); continue; }
      cur += ch;
    }
    if (cur) parts.push(cur);
    return parts.map((p) => (p === '>' ? p : parseCompound(p)));
  });
}
function splitTop(s, sep) { const out = []; let cur = ''; let depth = 0; let q = null; for (const ch of s) { if (q) { cur += ch; if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; } if (ch === '[' || ch === '(') depth++; if (ch === ']' || ch === ')') depth--; if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.filter((x) => x.trim()); }
function parseCompound(p) {
  const c = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([^\]=~^$*|]+)(?:([~^$*|]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:not\(([^)]*)\)|:([\w-]+)/g;
  let m;
  while ((m = re.exec(p))) {
    if (m[1]) c.tag = m[1] === '*' ? null : m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4].trim(), op: m[5], value: m[6] ?? m[7] ?? (m[8] !== undefined ? m[8].trim() : undefined) });
    else if (m[9]) c.nots.push(parseCompound(m[9]));
  }
  return c;
}
function matchesCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
  }
  for (const n of c.nots) if (matchesCompound(el, n)) return false;
  return true;
}
function matchesComplex(el, parts, scope) {
  let i = parts.length - 1;
  if (!matchesCompound(el, parts[i])) return false;
  let cur = el;
  i--;
  while (i >= 0) {
    if (parts[i] === '>') { i--; cur = cur.parentNode; if (!cur || cur.nodeType !== 1 || !matchesCompound(cur, parts[i])) return false; i--; continue; }
    let found = false;
    for (cur = cur.parentNode; cur && cur.nodeType === 1; cur = cur.parentNode) { if (matchesCompound(cur, parts[i])) { found = true; break; } }
    if (!found) return false;
    i--;
  }
  return true;
}

// ── HTML parsing / serialisation ──
function parseInto(root, html) {
  const doc = root.ownerDocument;
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i); i = e < 0 ? html.length : e + 3; continue; }
    if (html[i] === '<' && html[i + 1] === '/') {
      const e = html.indexOf('>', i); const tag = html.slice(i + 2, e).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].localName === tag) { stack.length = k; break; }
      i = e + 1; continue;
    }
    if (html[i] === '<' && /[a-zA-Z!]/.test(html[i + 1] || '')) {
      if (html[i + 1] === '!') { const e = html.indexOf('>', i); i = e + 1; continue; }
      let j = i + 1; while (j < html.length && /[\w-]/.test(html[j])) j++;
      const tag = html.slice(i + 1, j).toLowerCase();
      const el = doc.createElement(tag);
      // attributes
      while (j < html.length && html[j] !== '>' && !(html[j] === '/' && html[j + 1] === '>')) {
        if (/\s/.test(html[j])) { j++; continue; }
        let k = j; while (k < html.length && !/[\s=>]/.test(html[k]) && !(html[k] === '/' && html[k + 1] === '>')) k++;
        const name = html.slice(j, k); j = k;
        while (/\s/.test(html[j])) j++;
        let val = '';
        if (html[j] === '=') {
          j++; while (/\s/.test(html[j])) j++;
          if (html[j] === '"' || html[j] === "'") { const q = html[j]; const e = html.indexOf(q, j + 1); val = html.slice(j + 1, e); j = e + 1; } else { let e = j; while (e < html.length && !/[\s>]/.test(html[e])) e++; val = html.slice(j, e); j = e; }
        }
        if (name) el.setAttribute(name, decode(val));
      }
      const selfClose = html[j] === '/';
      i = html.indexOf('>', j) + 1;
      // implicit closes for <option>, <li>, <tr>, <td>, <p>
      if (['option', 'li', 'tr', 'td', 'th'].includes(tag) && top().localName === tag) stack.pop();
      top().appendChild(el);
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, i);
        const text = html.slice(i, end < 0 ? html.length : end);
        if (text) el.appendChild(doc.createTextNode(tag === 'textarea' || tag === 'title' ? decode(text) : text));
        i = end < 0 ? html.length : html.indexOf('>', end) + 1;
        continue;
      }
      if (!VOID.has(tag) && !selfClose) stack.push(el);
      continue;
    }
    const next = html.indexOf('<', i + 1);
    const text = html.slice(i, next < 0 ? html.length : next);
    top().appendChild(doc.createTextNode(decode(text)));
    i = next < 0 ? html.length : next;
  }
}
function serialize(n) {
  if (n.nodeType === 3) return n.parentNode && RAW.has(n.parentNode.localName) && n.parentNode.localName !== 'textarea' ? n.data : escText(n.data);
  const attrs = [...n.attrs].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join('');
  if (VOID.has(n.localName)) return `<${n.localName}${attrs}>`;
  return `<${n.localName}${attrs}>${n.childNodes.map(serialize).join('')}</${n.localName}>`;
}

class Document extends Element {
  constructor() {
    super(null, '#document'); this.ownerDocument = this; this.nodeType = 9; this.readyState = 'complete'; this.activeElement = null; this.title = '';
    this.documentElement = this.createElement('html'); this.appendChild(this.documentElement);
    this.head = this.createElement('head'); this.body = this.createElement('body');
    this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body);
  }
  createElement(t) { return new Element(this, t); }
  createTextNode(t) { return new Text(this, t); }
  createDocumentFragment() { const f = new Element(this, '#fragment'); f.nodeType = 11; return f; }
  getElementById(id) { return this.querySelector(`#${id}`); }
}

module.exports = { Document, Element, Event, Text };
