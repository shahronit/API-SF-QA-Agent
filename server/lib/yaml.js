'use strict';
/**
 * YAML subset parser sufficient for typical OpenAPI/Swagger documents:
 * block mappings and sequences, plain/quoted scalars, comments, block scalars
 * (| and >), and simple flow collections ([a, b], {a: 1}). Anchors/aliases and
 * multi-document streams are not supported (an explicit error is raised).
 */

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') || s.startsWith('{')) return parseFlow(s);
  if (s.startsWith('&') || s.startsWith('*')) throw new Error('YAML anchors/aliases are not supported; convert the spec to JSON.');
  return s;
}

function splitFlow(inner) {
  const parts = [];
  let depth = 0; let cur = ''; let q = null;
  for (const ch of inner) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseFlow(s) {
  s = s.trim();
  if (s.startsWith('[')) return splitFlow(s.slice(1, -1)).map((p) => parseScalar(p));
  if (s.startsWith('{')) {
    const o = {};
    for (const p of splitFlow(s.slice(1, -1))) {
      const i = p.indexOf(':');
      o[String(parseScalar(p.slice(0, i)))] = parseScalar(p.slice(i + 1));
    }
    return o;
  }
  return parseScalar(s);
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function findColon(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function parseYaml(text) {
  const srcLines = text.replace(/\t/g, '  ').split(/\r?\n/);
  if (srcLines.filter((l) => l.trim() === '---').length > 1) throw new Error('Multi-document YAML is not supported.');
  const lines = [];
  for (let i = 0; i < srcLines.length; i++) {
    const raw = srcLines[i];
    if (raw.trim() === '---' || raw.trim() === '...') continue;
    lines.push({ raw, n: i + 1 });
  }
  let idx = 0;
  const indentOf = (s) => s.length - s.trimStart().length;
  const isBlank = (s) => stripComment(s).trim() === '';

  function skipBlank() { while (idx < lines.length && isBlank(lines[idx].raw)) idx++; }

  function blockScalar(style, parentIndent) {
    const out = [];
    let ind = null;
    while (idx < lines.length) {
      const l = lines[idx].raw;
      if (l.trim() === '') { out.push(''); idx++; continue; }
      const li = indentOf(l);
      if (li <= parentIndent) break;
      if (ind === null) ind = li;
      out.push(l.slice(ind));
      idx++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return style.startsWith('|') ? out.join('\n') + '\n' : out.join(' ').replace(/\s+/g, ' ').trim() + '\n';
  }

  function parseBlock(indent) {
    skipBlank();
    if (idx >= lines.length) return null;
    const first = stripComment(lines[idx].raw);
    const isSeq = first.trimStart().startsWith('- ') || first.trim() === '-';
    return isSeq ? parseSeq(indentOf(first)) : parseMap(indentOf(first));
  }

  function valueAfter(rest, ownIndent) {
    const v = rest.trim();
    if (v === '') {
      skipBlank();
      if (idx < lines.length && indentOf(lines[idx].raw) > ownIndent) return parseBlock(indentOf(lines[idx].raw));
      // sequence at same indent as key is allowed in YAML
      if (idx < lines.length && indentOf(lines[idx].raw) === ownIndent && stripComment(lines[idx].raw).trimStart().startsWith('-')) return parseSeq(ownIndent);
      return null;
    }
    if (v === '|' || v === '>' || /^[|>][+-]?$/.test(v)) return blockScalar(v, ownIndent);
    return parseScalar(v);
  }

  function parseMap(indent) {
    const obj = {};
    while (idx < lines.length) {
      skipBlank();
      if (idx >= lines.length) break;
      const line = stripComment(lines[idx].raw);
      const li = indentOf(line);
      if (li < indent) break;
      if (li > indent) throw new Error(`Unexpected indentation at line ${lines[idx].n}`);
      const text = line.trim();
      if (text.startsWith('- ')) break;
      const c = findColon(text);
      if (c === -1) throw new Error(`Expected "key: value" at line ${lines[idx].n}`);
      const key = String(parseScalar(text.slice(0, c)));
      idx++;
      obj[key] = valueAfter(text.slice(c + 1), indent);
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (idx < lines.length) {
      skipBlank();
      if (idx >= lines.length) break;
      const line = stripComment(lines[idx].raw);
      const li = indentOf(line);
      if (li < indent || !line.trimStart().startsWith('-')) break;
      if (li > indent) throw new Error(`Unexpected indentation at line ${lines[idx].n}`);
      const after = line.trimStart().slice(1);
      const content = after.trim();
      if (content === '') { idx++; arr.push(valueAfter('', indent)); continue; }
      const c = findColon(content);
      if (c !== -1 && !content.startsWith('"') && !content.startsWith("'") && !content.startsWith('{') && !content.startsWith('[')) {
        // inline mapping start: "- key: value" — rewrite the line as a map at deeper indent
        const childIndent = li + 1 + (after.length - after.trimStart().length);
        lines[idx] = { raw: ' '.repeat(childIndent) + content, n: lines[idx].n };
        arr.push(parseMap(childIndent));
      } else {
        idx++;
        arr.push(parseScalar(content));
      }
    }
    return arr;
  }

  skipBlank();
  if (idx >= lines.length) return null;
  const firstText = stripComment(lines[idx].raw).trim();
  if (firstText.startsWith('{') || firstText.startsWith('[')) return JSON.parse(text);
  return parseBlock(0);
}

/** Parse JSON or YAML text into an object. */
function parseSpecText(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Specification is empty.');
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  return parseYaml(t);
}

module.exports = { parseYaml, parseSpecText };
