// Tiny dependency-free SVG chart kit. Charts are tappable/draggable: the readout above each chart shows the
// values at the touched point. Styling is class based (see styles.css) so it works with a strict CSP.
import { esc, fmtDay, fmtNum, valid, DAY } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 360, PL = 34, PR = 8, PT = 8, PB = 20;

function sv(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function niceTicks(lo, hi, n = 4) {
  if (!isFinite(lo) || !isFinite(hi)) return [0, 1];
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag, step = (err >= 5 ? 10 : err >= 2.5 ? 5 : err >= 1.2 ? 2 : 1) * mag;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}
function stepTicks(lo, hi, step) { const o = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) o.push(v); return o.length ? o : [lo, hi]; }
const tickFmt = v => Math.abs(v) >= 10000 ? (v / 1000).toFixed(0) + 'k' : Math.abs(v) >= 1000 ? (v / 1000).toFixed(1).replace('.0', '') + 'k' : (Math.round(v * 10) / 10).toString();

function frame(opts, kind) {
  const wrap = document.createElement('div'); wrap.className = 'chart';
  const ro = document.createElement('div'); ro.className = 'readout'; ro.textContent = opts.hint || 'Tap or drag on the chart for values';
  const H = opts.height || 190;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': opts.aria || 'Chart' });
  wrap.append(ro, svg);
  return { wrap, ro, svg, H };
}
function axes(g, svg, sx, sy, yt, xt, H, opts) {
  for (const v of yt) {
    const y = sy(v);
    sv('line', { x1: PL, x2: W - PR, y1: y, y2: y, class: 'grid' }, g);
    const t = sv('text', { x: PL - 4, y: y + 3, class: 'ax', 'text-anchor': 'end' }, g); t.textContent = (opts.yFmt || tickFmt)(v);
  }
  for (const x of xt) {
    const t = sv('text', { x: sx(x), y: H - 5, class: 'ax', 'text-anchor': x === xt[0] ? 'start' : x === xt[xt.length - 1] ? 'end' : 'middle' }, g);
    t.textContent = (opts.xFmt || (ms => fmtDayMs(ms)))(x);
  }
}
const fmtDayMs = ms => { const d = new Date(ms); return fmtDay(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); };
function xTicks(lo, hi, n = 4) { const o = []; for (let i = 0; i < n; i++) o.push(lo + (hi - lo) * i / (n - 1)); return o; }

function bindPointer(svg, ro, getIdx, show, hide) {
  const handler = ev => {
    const r = svg.getBoundingClientRect(); const x = (ev.clientX - r.left) / r.width * W;
    if (x < PL - 6 || x > W - PR + 6) return;
    show(getIdx(x));
  };
  svg.addEventListener('pointerdown', handler); svg.addEventListener('pointermove', ev => { if (ev.buttons || ev.pointerType === 'touch' || ev.pointerType === 'mouse') handler(ev); });
  svg.addEventListener('pointerleave', () => hide && hide());
}

// ------- line chart -------
// opts: series [{name, cls, pts:[[ms,v]], dashed, dots, fill}], band {lo:[[ms,v]], hi:[[ms,v]]}, flags [{x,y,cls}], refs [{y,label}]
export function lineChart(opts) {
  const { wrap, ro, svg, H } = frame(opts);
  const all = opts.series.flatMap(s => s.pts).filter(p => valid(p[1]));
  const bandPts = opts.band ? [...opts.band.lo, ...opts.band.hi].filter(p => valid(p[1])) : [];
  if (!all.length) { wrap.innerHTML = '<div class="empty-chart">No data in this range</div>'; return wrap; }
  const xs = [...all, ...bandPts].map(p => p[0]); let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x0 === x1) { x0 -= DAY; x1 += DAY; }
  const ys = [...all, ...bandPts].map(p => p[1]).concat((opts.refs || []).map(r => r.y));
  let y0 = opts.yMin ?? Math.min(...ys), y1 = opts.yMax ?? Math.max(...ys);
  if (opts.yMin == null) { const pad = (y1 - y0) * 0.1 || 1; y0 -= pad; if (opts.zero) y0 = Math.max(0, y0); }
  if (opts.yMax == null) { const pad = (y1 - y0) * 0.08 || 1; y1 += pad; }
  const yt = opts.yStep ? stepTicks(y0, y1, opts.yStep) : niceTicks(y0, y1, 4); if (opts.yMin == null) y0 = Math.min(y0, yt[0]); if (opts.yMax == null) y1 = Math.max(y1, yt[yt.length - 1]);
  const sx = x => PL + (x - x0) / (x1 - x0) * (W - PL - PR), sy = y => PT + (opts.invert ? (y - y0) / (y1 - y0) : 1 - (y - y0) / (y1 - y0)) * (H - PT - PB);
  const g = sv('g', {}, svg);
  axes(g, svg, sx, sy, yt, xTicks(x0, x1), H, opts);
  if (opts.band) { // shaded personal baseline band
    const lo = opts.band.lo.filter(p => valid(p[1])), hi = opts.band.hi.filter(p => valid(p[1]));
    if (lo.length > 1) { const d = 'M' + hi.map(p => sx(p[0]).toFixed(1) + ' ' + sy(p[1]).toFixed(1)).join('L') + 'L' + lo.slice().reverse().map(p => sx(p[0]).toFixed(1) + ' ' + sy(p[1]).toFixed(1)).join('L') + 'Z'; sv('path', { d, class: 'band' }, svg); }
  }
  for (const r of opts.refs || []) { sv('line', { x1: PL, x2: W - PR, y1: sy(r.y), y2: sy(r.y), class: 'ref' }, svg); if (r.label) { const t = sv('text', { x: W - PR - 2, y: sy(r.y) - 3, class: 'ax', 'text-anchor': 'end' }, svg); t.textContent = r.label; } }
  const gap = opts.gapMs || DAY * 3.5;
  for (const s of opts.series) {
    const pts = s.pts.filter(p => valid(p[1])); if (!pts.length) continue;
    let d = '', prev = null;
    for (const p of pts) { d += (prev == null || p[0] - prev > gap ? 'M' : 'L') + sx(p[0]).toFixed(1) + ' ' + sy(p[1]).toFixed(1); prev = p[0]; }
    if (s.fill) { const base = sy(Math.max(y0, 0)); sv('path', { d: d + `L${sx(pts[pts.length - 1][0]).toFixed(1)} ${base}L${sx(pts[0][0]).toFixed(1)} ${base}Z`, class: 'fillarea fl-' + s.cls }, svg); }
    if (!s.noLine) sv('path', { d, class: 'line st-' + s.cls + (s.dashed ? ' dashed' : '') + (s.thin ? ' thin' : '') }, svg);
    if (s.dots || pts.length < 40) for (const p of pts) sv('circle', { cx: sx(p[0]).toFixed(1), cy: sy(p[1]).toFixed(1), r: s.dots ? 2.4 : 2, class: 'dot fl-' + s.cls }, svg);
  }
  for (const f of opts.flags || []) sv('circle', { cx: sx(f.x).toFixed(1), cy: sy(f.y).toFixed(1), r: 4.5, class: 'flag ' + (f.cls || '') }, svg);
  // interaction
  const xsU = [...new Set(opts.series.filter(s => !s.noTip).flatMap(s => s.pts.filter(p => valid(p[1])).map(p => p[0])))].sort((a, b) => a - b);
  const cross = sv('line', { y1: PT, y2: H - PB, class: 'cross', visibility: 'hidden' }, svg);
  const marks = opts.series.map(s => sv('circle', { r: 4, class: 'mark fl-' + s.cls, visibility: 'hidden' }, svg));
  const lookup = opts.series.map(s => new Map(s.pts.filter(p => valid(p[1])).map(p => [p[0], p[1]])));
  bindPointer(svg, ro, x => { const t = x0 + (x - PL) / (W - PL - PR) * (x1 - x0); let lo = 0, hi = xsU.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (xsU[mid] < t) lo = mid + 1; else hi = mid; } return (lo > 0 && Math.abs(xsU[lo - 1] - t) < Math.abs(xsU[lo] - t)) ? lo - 1 : lo; },
    i => {
      const t = xsU[i]; if (t == null) return; cross.setAttribute('x1', sx(t)); cross.setAttribute('x2', sx(t)); cross.setAttribute('visibility', 'visible');
      let h = `<b>${esc((opts.tipDate || fmtDayMs)(t))}</b>`;
      opts.series.forEach((s, k) => { const v = lookup[k].get(t); if (v != null && !s.noTip) { marks[k].setAttribute('cx', sx(t)); marks[k].setAttribute('cy', sy(v)); marks[k].setAttribute('visibility', 'visible'); h += ` <span class="rk fl-${s.cls}"></span>${esc(s.name)} <b>${esc((s.fmt || opts.valFmt || (v2 => fmtNum(v2, 1)))(v))}</b>`; } else marks[k].setAttribute('visibility', 'hidden'); });
      if (opts.extraTip) h += ' ' + opts.extraTip(t);
      ro.innerHTML = h;
    });
  return wrap;
}

// ------- bar chart (optionally stacked) -------
// bars: [{ms, segs:[{v, cls, name}], label?}]; lines: [{name, cls, pts}] overlay on same axis
export function barChart(opts) {
  const { wrap, ro, svg, H } = frame(opts);
  const bars = opts.bars.filter(b => b.segs && b.segs.some(s => valid(s.v)));
  if (!bars.length) { wrap.innerHTML = '<div class="empty-chart">No data in this range</div>'; return wrap; }
  const tot = b => b.segs.reduce((s, q) => s + (valid(q.v) ? q.v : 0), 0);
  const lineVals = (opts.lines || []).flatMap(l => l.pts).filter(p => valid(p[1])).map(p => p[1]);
  let y1 = Math.max(...bars.map(tot), ...lineVals, opts.yMax || 0, 1e-9); const yt = niceTicks(0, y1, 4); y1 = Math.max(y1, yt[yt.length - 1]);
  const xsAll = opts.bars.map(b => b.ms); const step = opts.step || (xsAll.length > 1 ? (xsAll[xsAll.length - 1] - xsAll[0]) / (xsAll.length - 1) : DAY);
  const x0 = xsAll[0] - step / 2, x1 = xsAll[xsAll.length - 1] + step / 2;
  const sx = x => PL + (x - x0) / (x1 - x0) * (W - PL - PR), sy = y => PT + (1 - y / y1) * (H - PT - PB);
  axes(sv('g', {}, svg), svg, sx, sy, yt, xTicks(xsAll[0], xsAll[xsAll.length - 1]), H, opts);
  const bw = Math.max(1, (W - PL - PR) / opts.bars.length * 0.8);
  for (const r of opts.refs || []) { sv('line', { x1: PL, x2: W - PR, y1: sy(r.y), y2: sy(r.y), class: 'ref' }, svg); if (r.label) { const t = sv('text', { x: W - PR - 2, y: sy(r.y) - 3, class: 'ax', 'text-anchor': 'end' }, svg); t.textContent = r.label; } }
  const rects = [];
  for (const b of opts.bars) {
    let acc = 0; const bx = sx(b.ms) - bw / 2; const grp = [];
    for (const s of b.segs) { if (!valid(s.v) || s.v <= 0) continue; const top = sy(acc + s.v), bot = sy(acc); grp.push(sv('rect', { x: bx.toFixed(1), y: top.toFixed(1), width: bw.toFixed(1), height: Math.max(0.5, bot - top).toFixed(1), class: 'bar fl-' + s.cls }, svg)); acc += s.v; }
    rects.push(grp);
  }
  for (const l of opts.lines || []) {
    const pts = l.pts.filter(p => valid(p[1])); if (pts.length < 2) continue;
    sv('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + sx(p[0]).toFixed(1) + ' ' + sy(p[1]).toFixed(1)).join(''), class: 'line st-' + l.cls + (l.dashed ? ' dashed' : '') }, svg);
  }
  const hl = sv('rect', { class: 'hl', y: PT, height: H - PT - PB, visibility: 'hidden' }, svg);
  const lineLookup = (opts.lines || []).map(l => new Map(l.pts.filter(p => valid(p[1])).map(p => [p[0], p[1]])));
  bindPointer(svg, ro, x => Math.max(0, Math.min(opts.bars.length - 1, Math.floor((x - PL) / (W - PL - PR) * opts.bars.length))), i => {
    const b = opts.bars[i]; if (!b) return;
    hl.setAttribute('x', sx(b.ms) - bw / 2 - 1); hl.setAttribute('width', bw + 2); hl.setAttribute('visibility', 'visible');
    let h = `<b>${esc(b.label || (opts.tipDate || fmtDayMs)(b.ms))}</b>`;
    const vf = opts.valFmt || (v => fmtNum(v, 0));
    if (b.segs.length > 1) {
      for (const s of b.segs) { if (valid(s.v)) h += ` <span class="rk fl-${s.cls}"></span>${esc(s.name)} <b>${esc((opts.segFmt || vf)(s.v))}</b>`; }
      h += ` · total <b>${esc(vf(tot(b)))}</b>`;
    } else h += ` <b>${esc(vf(tot(b)))}</b>`;
    (opts.lines || []).forEach((l, k) => { const v = lineLookup[k].get(b.ms); if (v != null) h += ` <span class="rk fl-${l.cls}"></span>${esc(l.name)} <b>${esc((l.fmt || (q => fmtNum(q, 1)))(v))}</b>`; });
    if (b.note) h += ' ' + esc(b.note);
    ro.innerHTML = h;
  });
  return wrap;
}

// ------- scatter with fit line -------
export function scatter(opts) {
  const { wrap, ro, svg, H } = frame({ ...opts, height: opts.height || 200, hint: 'Tap a point for its values' });
  const pts = opts.pts; if (!pts.length) return wrap;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x0 === x1) { x0 -= 1; x1 += 1; } if (y0 === y1) { y0 -= 1; y1 += 1; }
  const xt = niceTicks(x0, x1, 4), yt = niceTicks(y0, y1, 4); x0 = Math.min(x0, xt[0]); x1 = Math.max(x1, xt[xt.length - 1]); y0 = Math.min(y0, yt[0]); y1 = Math.max(y1, yt[yt.length - 1]);
  const sx = x => PL + (x - x0) / (x1 - x0) * (W - PL - PR), sy = y => PT + (1 - (y - y0) / (y1 - y0)) * (H - PT - PB);
  const g = sv('g', {}, svg);
  for (const v of yt) { sv('line', { x1: PL, x2: W - PR, y1: sy(v), y2: sy(v), class: 'grid' }, g); const t = sv('text', { x: PL - 4, y: sy(v) + 3, class: 'ax', 'text-anchor': 'end' }, g); t.textContent = tickFmt(v); }
  for (const v of xt) { const t = sv('text', { x: sx(v), y: H - 5, class: 'ax', 'text-anchor': 'middle' }, g); t.textContent = tickFmt(v); }
  const lab = sv('text', { x: (PL + W - PR) / 2, y: H - 5 + 0, class: 'axlabel', 'text-anchor': 'middle', visibility: 'hidden' }, g);
  if (opts.fit && opts.fit.slope != null) sv('line', { x1: sx(x0), x2: sx(x1), y1: sy(opts.fit.intercept + opts.fit.slope * x0), y2: sy(opts.fit.intercept + opts.fit.slope * x1), class: 'fitline' }, svg);
  const dots = pts.map(p => sv('circle', { cx: sx(p[0]).toFixed(1), cy: sy(p[1]).toFixed(1), r: 3, class: 'sdot' }, svg));
  const mark = sv('circle', { r: 6, class: 'flag', visibility: 'hidden' }, svg);
  svg.addEventListener('pointerdown', ev => {
    const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) / r.width * W, py = (ev.clientY - r.top) / r.height * H;
    let best = -1, bd = 1e9; pts.forEach((p, i) => { const d = (sx(p[0]) - px) ** 2 + (sy(p[1]) - py) ** 2; if (d < bd) { bd = d; best = i; } });
    if (best >= 0) { mark.setAttribute('cx', sx(pts[best][0])); mark.setAttribute('cy', sy(pts[best][1])); mark.setAttribute('visibility', 'visible'); ro.innerHTML = `${esc(opts.xl)} <b>${pts[best][0].toFixed(1)}</b> · ${esc(opts.yl)} <b>${pts[best][1].toFixed(1)}</b>`; }
  });
  const cap = document.createElement('div'); cap.className = 'chart-cap'; cap.textContent = 'x: ' + opts.xl + '   y: ' + opts.yl; wrap.append(cap);
  return wrap;
}

// ------- simple labelled bars (for medians / lags) -------
export function miniBars(items, fmt = v => v.toFixed(1)) {
  const wrap = document.createElement('div'); wrap.className = 'minibars';
  const max = Math.max(...items.map(i => Math.abs(i.v)), 1e-9);
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'mbrow';
    const l = document.createElement('span'); l.className = 'mblabel'; l.textContent = it.label;
    const track = document.createElement('span'); track.className = 'mbtrack';
    const bar = document.createElement('span'); bar.className = 'mbbar ' + (it.v < 0 ? 'neg' : 'pos'); bar.style.width = Math.max(2, Math.abs(it.v) / max * 48) + '%';
    if (it.v < 0) bar.style.right = '50%'; else bar.style.left = '50%';
    track.append(bar);
    const v = document.createElement('span'); v.className = 'mbval'; v.textContent = fmt(it.v);
    row.append(l, track, v); wrap.append(row);
  }
  return wrap;
}

// ------- GPS route -------
export function routeMap(lat, lon) {
  const pts = []; for (let i = 0; i < lat.length; i++) if (valid(lat[i]) && valid(lon[i])) pts.push([lat[i], lon[i]]);
  if (pts.length < 5) return null;
  const la = pts.map(p => p[0]), lo = pts.map(p => p[1]);
  const la0 = Math.min(...la), la1 = Math.max(...la), lo0 = Math.min(...lo), lo1 = Math.max(...lo);
  const kx = Math.cos((la0 + la1) / 2 * Math.PI / 180); const wspan = (lo1 - lo0) * kx || 1e-5, hspan = (la1 - la0) || 1e-5;
  const Wd = 320, Hd = Math.min(260, Math.max(120, Wd * hspan / wspan)), sc = Math.min((Wd - 20) / wspan, (Hd - 20) / hspan);
  const ox = (Wd - wspan * sc) / 2, oy = (Hd - hspan * sc) / 2;
  const P = p => [(ox + (p[1] - lo0) * kx * sc).toFixed(1), (Hd - oy - (p[0] - la0) * sc).toFixed(1)];
  const svg = sv('svg', { viewBox: `0 0 ${Wd} ${Hd}`, class: 'chart-svg route', role: 'img', 'aria-label': 'GPS route (no map tiles, drawn offline)' });
  sv('path', { d: 'M' + pts.map(p => P(p).join(' ')).join('L'), class: 'line st-c1 route-line' }, svg);
  const s = P(pts[0]), e = P(pts[pts.length - 1]);
  sv('circle', { cx: s[0], cy: s[1], r: 5, class: 'fl-c2' }, svg); sv('circle', { cx: e[0], cy: e[1], r: 5, class: 'fl-c5' }, svg);
  return svg;
}
