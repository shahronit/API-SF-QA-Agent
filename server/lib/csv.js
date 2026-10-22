'use strict';
/** Minimal RFC 4180 CSV reader/writer (quoted cells, embedded commas/newlines, CRLF or LF). */

/** Parse CSV text into an array of rows (arrays of strings). Blank lines are skipped. */
function parseRows(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Parse CSV text with a header row into `{ header, records: [{col: value}] }`. */
function parse(text) {
  const [header = [], ...body] = parseRows(text);
  const cols = header.map((h) => h.trim());
  return { header: cols, records: body.map((r) => Object.fromEntries(cols.map((h, i) => [h, r[i] === undefined ? '' : r[i]]))) };
}

function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise rows (arrays) to CSV text with LF line endings and a trailing newline. */
function stringify(rows) {
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

module.exports = { parseRows, parse, stringify };
