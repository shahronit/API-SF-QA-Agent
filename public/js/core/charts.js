/* Dependency-free SVG charts: line/area, stacked bars, donut, horizontal bars, run ribbon.
   Charts are measured from their container and re-render on resize. */
(() => {
  const QA = window.QA;
  const { esc } = QA.ui;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const COLORS = { passed: '--success', failed: '--error', blocked: '--warning', skipped: '--skipped', primary: '--primary', muted: '--text-3' };
  const color = (c) => (c && c.startsWith('--') ? css(c) : COLORS[c] ? css(COLORS[c]) : c || css('--primary'));

  let tip;
  function showTip(e, html) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; document.body.appendChild(tip); }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14);
    const y = Math.min(window.innerHeight - tip.offsetHeight - 12, e.clientY + 14);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t) showTip(e, t.getAttribute('data-tip')); else hideTip();
  });
  document.addEventListener('scroll', hideTip, true);

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  function axes({ w, h, pad, max, labels, yFmt, ticks = 4 }) {
    let s = '';
    for (let i = 0; i <= ticks; i++) {
      const y = pad.t + (h - pad.t - pad.b) * (1 - i / ticks);
      s += `<line class="grid-line" x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" ${i ? 'stroke-dasharray="2 4"' : ''}/>`;
      s += `<text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" class="axis-label">${esc(yFmt(max * i / ticks))}</text>`;
    }
    const n = labels.length;
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((w - pad.l - pad.r) / 64))));
    labels.forEach((l, i) => {
      if (i % step && i !== n - 1) return;
      const x = pad.l + (n === 1 ? (w - pad.l - pad.r) / 2 : ((w - pad.l - pad.r) * i) / (n - 1));
      s += `<text x="${x}" y="${h - 6}" text-anchor="middle" class="axis-label">${esc(l)}</text>`;
    });
    return s;
  }

  /** Line / area chart. spec: { labels, series:[{name,color,values,area,dash}], height, yFmt, max } */
  function line(spec, w) {
    const h = spec.height || 220;
    const pad = { t: 12, r: 12, b: 26, l: 44 };
    const all = spec.series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
    const max = spec.max || niceMax(Math.max(1, ...all));
    const yFmt = spec.yFmt || ((v) => Math.round(v));
    const n = spec.labels.length;
    const X = (i) => pad.l + (n === 1 ? (w - pad.l - pad.r) / 2 : ((w - pad.l - pad.r) * i) / (n - 1));
    const Y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
    let s = axes({ w, h, pad, max, labels: spec.labels, yFmt });
    for (const ser of spec.series) {
      const c = color(ser.color);
      const pts = ser.values.map((v, i) => (v === null || v === undefined ? null : [X(i), Y(v)])).filter(Boolean);
      if (!pts.length) continue;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      if (ser.area) s += `<path d="${d}L${pts[pts.length - 1][0]},${Y(0)}L${pts[0][0]},${Y(0)}Z" fill="${c}" opacity=".10"/>`;
      s += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" ${ser.dash ? 'stroke-dasharray="4 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
      if (pts.length <= 40) pts.forEach((p) => { s += `<circle cx="${p[0]}" cy="${p[1]}" r="2.6" fill="${css('--surface')}" stroke="${c}" stroke-width="1.6"/>`; });
    }
    // hover columns
    const colW = n > 1 ? (w - pad.l - pad.r) / (n - 1) : w - pad.l - pad.r;
    spec.labels.forEach((l, i) => {
      const tipHtml = `<b>${esc(l)}</b><br>${spec.series.map((ser) => `<span style="color:${color(ser.color)}">●</span> ${esc(ser.name)}: ${esc(ser.values[i] === null || ser.values[i] === undefined ? '–' : yFmt(ser.values[i]))}`).join('<br>')}`;
      s += `<rect x="${X(i) - colW / 2}" y="${pad.t}" width="${colW}" height="${h - pad.t - pad.b}" fill="transparent" data-tip="${esc(tipHtml)}"/>`;
    });
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(spec.aria || 'Line chart')}">${s}</svg>`;
  }

  /** Stacked bar chart. spec: { labels, series:[{name,color,values}], height } */
  function bars(spec, w) {
    const h = spec.height || 220;
    const pad = { t: 12, r: 8, b: 26, l: 40 };
    const n = spec.labels.length;
    const totals = spec.labels.map((_, i) => spec.series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const max = niceMax(Math.max(1, ...totals));
    const yFmt = spec.yFmt || ((v) => Math.round(v));
    const slot = (w - pad.l - pad.r) / Math.max(1, n);
    const bw = Math.max(4, Math.min(28, slot * 0.62));
    const Y = (v) => (h - pad.t - pad.b) * (v / max);
    let s = '';
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (h - pad.t - pad.b) * (1 - i / 4);
      s += `<line class="grid-line" x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" ${i ? 'stroke-dasharray="2 4"' : ''}/><text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" class="axis-label">${esc(yFmt(max * i / 4))}</text>`;
    }
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((w - pad.l - pad.r) / 56))));
    spec.labels.forEach((l, i) => {
      const x = pad.l + slot * i + (slot - bw) / 2;
      let y = h - pad.b;
      const tipHtml = `<b>${esc(l)}</b><br>${spec.series.map((ser) => `<span style="color:${color(ser.color)}">●</span> ${esc(ser.name)}: ${ser.values[i] || 0}`).join('<br>')}`;
      spec.series.forEach((ser, si) => {
        const v = ser.values[i] || 0;
        if (!v) return;
        const bh = Y(v);
        y -= bh;
        const top = si === spec.series.length - 1 || spec.series.slice(si + 1).every((x) => !x.values[i]);
        s += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(0.5, bh - (top ? 0 : 1))}" rx="${top ? 2 : 0}" fill="${color(ser.color)}"/>`;
      });
      s += `<rect x="${pad.l + slot * i}" y="${pad.t}" width="${slot}" height="${h - pad.t - pad.b}" fill="transparent" data-tip="${esc(tipHtml)}"/>`;
      if (!(i % step) || i === n - 1) s += `<text x="${pad.l + slot * i + slot / 2}" y="${h - 6}" text-anchor="middle" class="axis-label">${esc(l)}</text>`;
    });
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(spec.aria || 'Bar chart')}">${s}</svg>`;
  }

  /** Donut. spec: { segments:[{label,value,color}], size, center, sub } */
  function donut(spec) {
    const size = spec.size || 150;
    const r = size / 2 - 10;
    const cx = size / 2;
    const total = spec.segments.reduce((a, s) => a + s.value, 0);
    let s = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${css('--surface-2')}" stroke-width="14"/>`;
    let a0 = -Math.PI / 2;
    if (total) {
      for (const seg of spec.segments) {
        if (!seg.value) continue;
        const a1 = a0 + (seg.value / total) * Math.PI * 2 - (spec.segments.filter((x) => x.value).length > 1 ? 0.03 : 0);
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p0 = [cx + r * Math.cos(a0), cx + r * Math.sin(a0)];
        const p1 = [cx + r * Math.cos(a1), cx + r * Math.sin(a1)];
        const d = seg.value === total ? `M${cx},${cx - r}A${r},${r} 0 1 1 ${cx - 0.01},${cx - r}` : `M${p0[0]},${p0[1]}A${r},${r} 0 ${large} 1 ${p1[0]},${p1[1]}`;
        s += `<path d="${d}" fill="none" stroke="${color(seg.color)}" stroke-width="14" data-tip="${esc(`<b>${esc(seg.label)}</b>: ${seg.value} (${Math.round((seg.value / total) * 100)}%)`)}"/>`;
        a0 = a0 + (seg.value / total) * Math.PI * 2;
      }
    }
    s += `<text x="${cx}" y="${cx + 2}" text-anchor="middle" style="font-size:22px;font-weight:650;fill:${css('--text')}">${esc(spec.center ?? total)}</text>`;
    if (spec.sub) s += `<text x="${cx}" y="${cx + 20}" text-anchor="middle" style="font-size:11px">${esc(spec.sub)}</text>`;
    return `<svg class="chart" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="width:${size}px" role="img" aria-label="${esc(spec.aria || 'Donut chart')}">${s}</svg>`;
  }

  /** Horizontal bars. spec: { items:[{label, value, total?, color, suffix}] } — plain HTML for crisp text. */
  function hbars(spec) {
    const max = Math.max(1, ...spec.items.map((i) => i.max || i.value));
    return `<div class="stack" style="gap:10px">${spec.items.map((i) => `<div>
      <div class="row" style="font-size:12.5px;margin-bottom:4px"><span class="truncate" title="${esc(i.label)}">${esc(i.label)}</span><span class="spacer"></span><span class="num muted">${esc(i.display ?? i.value)}</span></div>
      <div class="progress" data-tip="${esc(`<b>${esc(i.label)}</b>: ${esc(i.display ?? i.value)}`)}">${(i.parts || [{ value: i.value, color: i.color }]).map((p) => `<span style="width:${(p.value / max) * 100}%;background:${color(p.color)}"></span>`).join('')}</div></div>`).join('')}</div>`;
  }

  /** Run ribbon — one cell per test in execution order. */
  function ribbon(cells, { large = false, linkBase } = {}) {
    return `<div class="ribbon ${large ? 'lg' : ''}" role="list" aria-label="Test results in execution order">${cells.map((c, i) => `<div role="listitem" class="cell ${esc(c.status || 'pending')}" data-index="${i}" ${c.id ? `data-result="${esc(c.id)}"` : ''} ${linkBase && c.id ? `data-href="${esc(linkBase + c.id)}"` : ''} data-tip="${esc(`<b>#${c.seq || i + 1} ${esc(c.status || 'pending')}</b><br>${esc(c.title || '')}`)}" aria-label="${esc(`#${c.seq || i + 1} ${c.status || 'pending'}: ${c.title || ''}`)}"></div>`).join('')}</div>`;
  }

  /** Mount a measured chart into an element; re-renders on resize & theme change. */
  function mount(el, kind, spec) {
    if (!el) return;
    const render = () => {
      const w = Math.max(240, Math.floor(el.clientWidth));
      el.innerHTML = kind === 'line' ? line(spec, w) : kind === 'bars' ? bars(spec, w) : kind === 'donut' ? donut(spec) : kind === 'hbars' ? hbars(spec) : '';
    };
    render();
    if (el.__ro) el.__ro.disconnect();
    if (typeof ResizeObserver !== 'undefined' && (kind === 'line' || kind === 'bars')) {
      let last = el.clientWidth;
      el.__ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - last) > 4) { last = el.clientWidth; render(); } });
      el.__ro.observe(el);
    }
    const off = QA.state.on('theme', () => { if (document.body.contains(el)) render(); else off(); });
  }

  // Public helpers return Safe HTML so they can be interpolated in h`` templates without double-escaping.
  const safe = (fn) => (...a) => QA.ui.raw(fn(...a));
  QA.charts = { line: safe(line), bars: safe(bars), donut: safe(donut), hbars: safe(hbars), ribbon: safe(ribbon), mount, color };
})();
