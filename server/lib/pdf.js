'use strict';
/**
 * Minimal PDF 1.4 writer: A4 pages, Helvetica / Helvetica-Bold text with real
 * glyph widths (for wrapping and right-alignment), filled rectangles and lines.
 * Coordinates are top-left based (converted internally).
 */
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

const WINANSI = { '•': 0x95, '—': 0x97, '–': 0x96, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '…': 0x85, '€': 0x80, '✓': 0x76, '×': 0xd7, 'é': 0xe9, '°': 0xb0 };

function toWinAnsi(str) {
  const out = [];
  for (const ch of String(str)) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c <= 126) out.push(c);
    else if (WINANSI[ch] !== undefined) out.push(WINANSI[ch]);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (ch === '\t') out.push(32);
    else out.push(63); // ?
  }
  return out;
}

function charWidth(code, bold) {
  const w = code >= 32 && code <= 126 ? W[code - 32] : code === 0x95 ? 350 : code === 0x97 ? 1000 : 556;
  return bold ? w * 1.06 : w;
}

function textWidth(str, size, bold = false) {
  return toWinAnsi(str).reduce((s, c) => s + charWidth(c, bold), 0) * size / 1000;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => v.toFixed(3)).join(' ');
}

function pdfString(str) {
  const bytes = toWinAnsi(str);
  let s = '';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
    else if (b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return `(${s})`;
}

class PdfDoc {
  constructor({ width = 595.28, height = 841.89 } = {}) {
    this.width = width;
    this.height = height;
    this.pages = [];
    this.page();
  }

  page() {
    this.ops = [];
    this.pages.push(this.ops);
    return this;
  }

  text(x, y, str, { size = 10, bold = false, color = '#0F172A', align = 'left', maxWidth } = {}) {
    let s = String(str ?? '');
    if (maxWidth) s = this.truncate(s, maxWidth, size, bold);
    let tx = x;
    const w = textWidth(s, size, bold);
    if (align === 'right') tx = x - w;
    if (align === 'center') tx = x - w / 2;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${hexToRgb(color)} rg ${tx.toFixed(2)} ${(this.height - y - size).toFixed(2)} Td ${pdfString(s)} Tj ET`);
    return w;
  }

  rect(x, y, w, h, { fill, stroke, lineWidth = 0.5 } = {}) {
    const parts = [];
    if (fill) parts.push(`${hexToRgb(fill)} rg`);
    if (stroke) parts.push(`${hexToRgb(stroke)} RG ${lineWidth} w`);
    parts.push(`${x.toFixed(2)} ${(this.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    this.ops.push(parts.join(' '));
  }

  line(x1, y1, x2, y2, { color = '#E2E8F0', width = 0.75 } = {}) {
    this.ops.push(`${hexToRgb(color)} RG ${width} w ${x1.toFixed(2)} ${(this.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - y2).toFixed(2)} l S`);
  }

  truncate(s, maxWidth, size, bold) {
    if (textWidth(s, size, bold) <= maxWidth) return s;
    let out = s;
    while (out.length > 1 && textWidth(out + '…', size, bold) > maxWidth) out = out.slice(0, -1);
    return out + '…';
  }

  wrap(str, maxWidth, size = 10, bold = false) {
    const lines = [];
    for (const para of String(str ?? '').split(/\n/)) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        if (!word) continue;
        const test = line ? line + ' ' + word : word;
        if (textWidth(test, size, bold) <= maxWidth) line = test;
        else {
          if (line) lines.push(line);
          line = textWidth(word, size, bold) > maxWidth ? this.truncate(word, maxWidth, size, bold) : word;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  toBuffer() {
    const objects = [];
    const add = (s) => { objects.push(s); return objects.length; };
    const catalogId = add(null);
    const pagesId = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pageIds = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      const cId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cId} 0 R >>`));
    }
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [];
    objects.forEach((o, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

module.exports = { PdfDoc, textWidth };
