// Small shared helpers: dates, stats, formatting, HTML escaping.
export const DAY = 86400000;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const pad2 = n => String(n).padStart(2, '0');
// Local-calendar day key for a Date / epoch ms
export function dayKey(d) {
  d = d instanceof Date ? d : new Date(d);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
// Day key -> epoch ms at local noon (DST safe arithmetic base)
export function dayMs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n, 12));
}
export function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / DAY); }
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtDay(key, withYear) {
  const [y, m, d] = key.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + d + (withYear ? ', ' + y : '');
}
export function fmtDayLong(key) {
  const dt = new Date(dayMs(key));
  return DOW[dt.getDay()] + ' ' + fmtDay(key, true);
}
export function fmtClock(ms) {
  const d = new Date(ms);
  let h = d.getHours(); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
  return h + ':' + pad2(d.getMinutes()) + ap;
}
export function fmtDur(min) {
  if (min == null || isNaN(min)) return '–';
  const m = Math.round(min);
  return Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm';
}
export function fmtDurSec(s) {
  if (s == null || isNaN(s)) return '–';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? h + ':' + pad2(m) + ':' + pad2(ss) : m + ':' + pad2(ss);
}
export function fmtNum(v, dp = 0) {
  if (v == null || isNaN(v)) return '–';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtPace(secPerKm, units = 'km') {
  if (!secPerKm || !isFinite(secPerKm)) return '–';
  const s = units === 'mi' ? secPerKm * 1.609344 : secPerKm;
  let m = Math.floor(s / 60), r = Math.round(s % 60);
  if (r === 60) { m++; r = 0; }
  return m + ':' + pad2(r) + '/' + units;
}

// ---------- statistics ----------
export const valid = v => v != null && typeof v === 'number' && isFinite(v);
export function mean(a) { const x = a.filter(valid); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; }
export function sum(a) { return a.filter(valid).reduce((s, v) => s + v, 0); }
export function sd(a) {
  const x = a.filter(valid); if (x.length < 2) return null;
  const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
}
export function quantile(a, q) {
  const x = a.filter(valid).sort((p, r) => p - r); if (!x.length) return null;
  const pos = (x.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return x[lo] + (x[hi] - x[lo]) * (pos - lo);
}
export const median = a => quantile(a, 0.5);
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015; for (let j = 0; j < 6; j++) s += c[j] / ++y;
  return -t + Math.log(2.5066282746310005 * s / x);
}
function betacf(a, b, x) {
  const FP = 1e-30; let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FP) d = FP; d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-7) break;
  }
  return h;
}
function ibeta(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
// two-sided p-value for Pearson r with n pairs
export function pearsonP(r, n) {
  if (n < 3 || !valid(r)) return 1;
  if (Math.abs(r) >= 1) return 0;
  const df = n - 2, t = r * Math.sqrt(df / (1 - r * r));
  return ibeta(df / 2, 0.5, df / (df + t * t));
}
// pairs: [[x,y],...]; returns {r, n, p, slope, intercept}
export function correlate(pairs) {
  const p = pairs.filter(q => valid(q[0]) && valid(q[1]));
  const n = p.length; if (n < 3) return { n, r: null, p: 1 };
  const mx = mean(p.map(q => q[0])), my = mean(p.map(q => q[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx || !syy) return { n, r: 0, p: 1, slope: 0, intercept: my };
  const r = sxy / Math.sqrt(sxx * syy), slope = sxy / sxx;
  return { n, r, p: pearsonP(r, n), slope, intercept: my - slope * mx };
}
// linear trend of y over x (x in days). returns slope per day, r, p, n
export function trend(points) {
  const c = correlate(points); return c;
}
// Rolling stats over trailing window (exclusive of current index when excludeSelf)
export function rollingStats(values, win, minN, excludeSelf = true) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const end = excludeSelf ? i : i + 1, start = Math.max(0, end - win);
    const w = []; for (let j = start; j < end; j++) if (valid(values[j])) w.push(values[j]);
    out[i] = w.length >= minN ? { mean: mean(w), sd: sd(w), n: w.length } : null;
  }
  return out;
}
export function movingAvg(values, win, minN = 1) {
  return rollingStats(values, win, minN, false).map(s => s ? s.mean : null);
}
export function uid() { return Math.random().toString(36).slice(2, 10); }
export function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const tick = () => new Promise(r => setTimeout(r, 0));
