// All derived metrics. Formulas are deliberately simple and documented in the UI.
import { S } from './state.js';
import { addDays, daysBetween, dayKey, dayMs, mean, sd, median, quantile, valid, clamp, rollingStats, movingAvg, fmtDur, fmtNum } from './util.js';

export const ZONES = [
  { name: 'Z1 Easy', lo: 0, hi: 0.6, cls: 'z1' }, { name: 'Z2 Aerobic', lo: 0.6, hi: 0.7, cls: 'z2' }, { name: 'Z3 Tempo', lo: 0.7, hi: 0.8, cls: 'z3' },
  { name: 'Z4 Threshold', lo: 0.8, hi: 0.9, cls: 'z4' }, { name: 'Z5 Max', lo: 0.9, hi: 9, cls: 'z5' }];
// Training-load ratio thresholds, shared by the readiness penalty and the advice text so they always agree.
export const ACWR_HIGH = 1.3, ACWR_LOW = 0.8;
export const HRV_SD_FLOOR = 0.04; // minimum SD on the ln(HRV) scale (~4%)
export const zoneOf = (hr, maxHr) => { const p = hr / maxHr; return p < 0.6 ? 0 : p < 0.7 ? 1 : p < 0.8 ? 2 : p < 0.9 ? 3 : 4; };

export const WEIGHTS = { sleep: 0.35, hrv: 0.25, rhr: 0.20, stress: 0.10, load: 0.10 };
const BASE_KEYS = ['hrv', 'rhr', 'sleepMin', 'stress', 'steps'];
let cache = { v: -1, key: '', m: null };

export function zonesOfActivity(a, maxHr = 190) {
  const secs = [0, 0, 0, 0, 0];
  if (a.hrHist) { for (const [bpm, s] of Object.entries(a.hrHist)) secs[zoneOf(+bpm, maxHr)] += s; return { secs, approx: false }; }
  if (a.avgHr && a.durationSec) { secs[zoneOf(a.avgHr, maxHr)] += a.durationSec; return { secs, approx: true }; }
  return null;
}

// Estimate max HR from the user's highest *sustained* HR: the 99th percentile of all recorded activity HR
// (second-by-second histograms when available, otherwise per-activity maxima). Usually a few bpm under true max.
export function estimateMaxHr() {
  const hist = {}; let tot = 0;
  for (const a of S.acts.values()) if (a.hrHist) for (const [bpm, secs] of Object.entries(a.hrHist)) { hist[bpm] = (hist[bpm] || 0) + secs; tot += secs; }
  if (tot >= 1800) {
    let acc = 0; const target = tot * 0.99;
    for (const bpm of Object.keys(hist).map(Number).sort((x, y) => x - y)) { acc += hist[bpm]; if (acc >= target) return { value: clamp(bpm, 140, 215), n: Math.round(tot), unit: 'seconds of activity HR' }; }
  }
  const mx = [...S.acts.values()].map(a => a.maxHr).filter(v => valid(v) && v > 100 && v < 230);
  if (mx.length >= 5) return { value: clamp(Math.round(quantile(mx, 0.99)), 140, 215), n: mx.length, unit: 'activity maximums' };
  return null;
}
export function trimpOf(a, rest, maxHr, sex) {
  if (!a.durationSec) return { v: 0, est: true };
  const dm = a.durationSec / 60;
  if (a.avgHr && maxHr > rest) {
    const hrr = clamp((a.avgHr - rest) / (maxHr - rest), 0, 1);
    const k = sex === 'f' ? 0.86 * Math.exp(1.67 * hrr) : 0.64 * Math.exp(1.92 * hrr); // Banister TRIMP
    return { v: dm * hrr * k, est: false };
  }
  return { v: dm * 0.35, est: true }; // no HR: assume a moderate effort (flagged as estimated)
}
export const speedOf = a => (a.distanceM && a.durationSec) ? a.distanceM / a.durationSec : null; // m/s
export const paceOf = a => { const s = speedOf(a); return s ? 1000 / s : null; }; // sec/km

function localMinutes(ms) { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); }
export const bedMinOf = ms => (localMinutes(ms) + 720) % 1440; // minutes since noon; continuous across midnight

export function model() {
  const key = S.version + '|' + S.settings.maxHr + '|' + S.settings.maxHrConfirmed + '|' + S.settings.restHrOverride + '|' + S.settings.sleepNeedH + '|' + S.settings.sex;
  if (cache.key === key) return cache.m;
  const m = build(); cache = { key, m }; return m;
}

function build() {
  const set = new Set([...S.daily.keys()]);
  for (const a of S.acts.values()) if (a.day) set.add(a.day);
  if (!set.size) return { empty: true, days: [], acts: [], byDate: new Map(), first: null, last: null };
  const keys = [...set].sort();
  const first = keys[0], last = keys[keys.length - 1];
  const n = daysBetween(first, last) + 1;
  const days = []; const byDate = new Map();
  for (let i = 0; i < n; i++) {
    const date = addDays(first, i); const d = { ...(S.daily.get(date) || {}), date, i, ms: dayMs(date) };
    d.has = S.daily.has(date); days.push(d); byDate.set(date, d);
  }
  // HRV source selection: nightly health-status/HRV values win; the sleep file's avgOvernightHrv fills gaps; a coarse weekly average
  // (Training Readiness) is used only when no nightly HRV exists at all, and is flagged so no single-night analysis is done on it.
  const nHrv = days.filter(d => d.hrv > 0).length, nSleepHrv = days.filter(d => !(d.hrv > 0) && d.hrvSleep > 0).length, nWeekly = days.filter(d => d.hrvWeekly > 0).length;
  let hrvKind = nHrv ? 'nightly' : nSleepHrv ? 'sleep' : nWeekly ? 'weekly' : 'none';
  for (const d of days) {
    if (!(d.hrv > 0) && d.hrvSleep > 0) { d.hrv = d.hrvSleep; d.hrvFrom = 'sleep'; }
    else if (hrvKind === 'weekly' && d.hrvWeekly > 0) { d.hrv = d.hrvWeekly; d.hrvCoarse = true; d.hrvFrom = 'weekly'; }
  }
  const rest = S.settings.restHrOverride || median(days.map(d => d.rhr)) || 60;
  const mhEst = estimateMaxHr();
  const maxHr = S.settings.maxHr || (mhEst && mhEst.value) || 190;
  const maxHrSource = S.settings.maxHr ? 'manual' : mhEst ? 'estimated' : 'default';
  const acts = [...S.acts.values()].sort((a, b) => a.start - b.start).map(a => {
    const t = trimpOf(a, rest, maxHr, S.settings.sex);
    return { ...a, trimp: t.v, trimpEst: t.est, speed: speedOf(a), pace: paceOf(a) };
  });
  const actsByDay = new Map();
  for (const a of acts) { if (!actsByDay.has(a.day)) actsByDay.set(a.day, []); actsByDay.get(a.day).push(a); }
  for (const d of days) {
    const list = actsByDay.get(d.date) || [];
    d.acts = list; d.trimp = list.reduce((s, a) => s + a.trimp, 0); d.actMin = list.reduce((s, a) => s + (a.durationSec || 0) / 60, 0);
    d.hasAct = list.length > 0; d.intMin = valid(d.intMod) || valid(d.intVig) ? (d.intMod || 0) + 2 * (d.intVig || 0) : null;
  }
  // training load: EWMA acute (7d) vs chronic (28d)
  const firstActIdx = days.findIndex(d => d.hasAct);
  let ac = 0, ch = 0; const la = 2 / 8, lc = 2 / 29;
  for (const d of days) {
    ac = la * d.trimp + (1 - la) * ac; ch = lc * d.trimp + (1 - lc) * ch;
    d.acute = ac; d.chronic = ch;
    d.acwr = firstActIdx >= 0 && d.i - firstActIdx >= 28 && ch > 1 ? ac / ch : null;
  }
  // baselines (HRV is analysed on the natural-log scale: it is right-skewed and changes are proportional)
  const base = {};
  for (const k of BASE_KEYS) {
    const vals = days.map(d => k === 'hrv' ? (valid(d.hrv) && d.hrv > 0 ? Math.log(d.hrv) : null) : (valid(d[k]) ? d[k] : null));
    base[k] = { b60: rollingStats(vals, 60, 14, true), ma7: movingAvg(vals, 7, 3) };
    days.forEach((d, i) => { d['ma7_' + k] = k === 'hrv' ? (base[k].ma7[i] == null ? null : Math.exp(base[k].ma7[i])) : base[k].ma7[i]; d['b_' + k] = base[k].b60[i]; });
    if (k === 'hrv') days.forEach((d, i) => { d.ma7_lnHrv = base[k].ma7[i]; });
  }
  const floorOf = (k, b) => Math.max(b.sd || 0, k === 'hrv' ? HRV_SD_FLOOR : k === 'rhr' ? 1 : k === 'stress' ? 2 : k === 'sleepMin' ? 0.04 * b.mean : 0.1 * b.mean, 1e-6);
  const zOf = (k, v, i) => {
    const b = base[k].b60[i]; if (!b || !valid(v)) return null;
    const x = k === 'hrv' ? (v > 0 ? Math.log(v) : null) : v; if (x == null) return null;
    return (x - b.mean) / floorOf(k, b);
  };
  const model = { hrvKind, hrvSleepFilled: nHrv ? nSleepHrv : 0, days, byDate, acts, first, last, rest, maxHr, maxHrSource, maxHrEst: mhEst, base, zOf, floorOf, actsByDay };
  days.forEach((d, i) => {
    for (const k of BASE_KEYS) d['z_' + k] = (k === 'hrv' && d.hrvCoarse) ? null : zOf(k, d[k], i); // no single-night z on a weekly average
    const b = base.hrv.b60[i]; d.z7_hrv = b && valid(d.ma7_lnHrv) ? (d.ma7_lnHrv - b.mean) / floorOf('hrv', b) : null; // 7-night average vs baseline (scored)
  });
  // sleep timing
  days.forEach((d, i) => {
    if (valid(d.sleepStart)) d.bedMin = bedMinOf(d.sleepStart);
    if (valid(d.sleepEnd)) d.wakeMin = localMinutes(d.sleepEnd);
  });
  days.forEach((d, i) => { d.readiness = readiness(model, i); });
  return model;
}

// Baseline in display units (HRV baselines are stored on the ln scale, so mid is the geometric mean in ms).
export function bandOf(b, k, K = 1.5) {
  if (!b) return null;
  const w = Math.max(b.sd || 0, k === 'hrv' ? HRV_SD_FLOOR : k === 'rhr' ? 1 : 0.04 * b.mean);
  if (k === 'hrv') return { mid: Math.exp(b.mean), lo: Math.exp(b.mean - K * w), hi: Math.exp(b.mean + K * w), n: b.n, w };
  return { mid: b.mean, lo: b.mean - K * w, hi: b.mean + K * w, n: b.n, w };
}

export function readiness(m, i) {
  const d = m.days[i]; const need = S.settings.sleepNeedH * 60; const f = [];
  if (valid(d.sleepMin)) {
    const dur = clamp(d.sleepMin / need, 0, 1) * 100;
    let q = null; if (valid(d.deepMin) && valid(d.remMin)) q = clamp(((d.deepMin + d.remMin) / d.sleepMin) / 0.40, 0, 1) * 100;
    const sc = q == null ? dur : 0.75 * dur + 0.25 * q;
    f.push({ key: 'sleep', name: 'Sleep', score: sc, value: fmtDur(d.sleepMin),
      why: `You slept ${fmtDur(d.sleepMin)} against a ${fmtDur(need)} need (${Math.round(d.sleepMin / need * 100)}%). ` + (q == null ? 'Stage data was missing, so duration alone is scored.' : `Score = 75% duration + 25% restorative share (deep+REM was ${Math.round((d.deepMin + d.remMin) / d.sleepMin * 100)}% of sleep; 40% or more scores full marks). Note: wrist-device deep/REM stages are only roughly accurate compared with a sleep lab, so the stage part is a rough guide.`) });
  }
  const bh = d.b_hrv, z7 = d.z7_hrv;
  if (bh && z7 != null && valid(d.ma7_hrv)) {
    const band = bandOf(bh, 'hrv'); const lastN = m.days.slice(Math.max(0, i - 6), i + 1).filter(x => valid(x.hrv)).length;
    f.push({ key: 'hrv', name: 'HRV (7-night avg) vs baseline', score: clamp(70 + 22 * z7, 0, 100), value: fmtNum(d.ma7_hrv) + ' ms',
      why: `Your 7-night average HRV is ${fmtNum(d.ma7_hrv)} ms (geometric mean of ${lastN} nights) vs your 60-day baseline ${fmtNum(band.mid)} ms (SD ${(bh.sd * 100).toFixed(0)}% on the log scale, n=${bh.n}); z = ${z7.toFixed(1)}. HRV is analysed on a log scale because it is skewed. Score = 70 + 22×z (capped 0–100): at baseline you score 70. Using the 7-night average keeps one noisy night from swinging the score; single nights are only used for flags.` });
  }
  const br = d.b_rhr, zr = d.z_rhr;
  if (valid(d.rhr) && br && zr != null) f.push({ key: 'rhr', name: 'Resting HR vs baseline', score: clamp(70 - 22 * zr, 0, 100), value: fmtNum(d.rhr) + ' bpm',
    why: `Resting HR ${fmtNum(d.rhr)} bpm vs your 60-day baseline ${fmtNum(br.mean, 0)} bpm (±${fmtNum(br.sd, 1)}); z = ${zr.toFixed(1)}. Lower than baseline is better: score = 70 − 22×z (capped 0–100).` });
  const p = m.days[i - 1];
  if (p && valid(p.stress) && p.b_stress && p.z_stress != null) f.push({ key: 'stress', name: 'Yesterday’s stress vs baseline', score: clamp(70 - 22 * p.z_stress, 0, 100), value: fmtNum(p.stress),
    why: `Yesterday’s average stress was ${fmtNum(p.stress)} vs your own 60-day baseline ${fmtNum(p.b_stress.mean)} (±${fmtNum(p.b_stress.sd, 1)}); z = ${p.z_stress.toFixed(1)}. Scored against your normal rather than a fixed scale: score = 70 − 22×z (capped 0–100).` });
  if (p && valid(p.acwr)) {
    const a = p.acwr; const sc = a < ACWR_LOW ? 75 + 25 * a / ACWR_LOW : a <= ACWR_HIGH ? 100 : Math.max(20, 100 - (a - ACWR_HIGH) / 0.7 * 80);
    f.push({ key: 'load', name: 'Training load balance', score: sc, value: a.toFixed(2), why: `The ratio of your recent (7-day) to usual (28-day) training load through yesterday is ${a.toFixed(2)}. ${ACWR_LOW}–${ACWR_HIGH} is treated as balanced (full score); below ${ACWR_LOW} loses a little (you are doing less than usual); above ${ACWR_HIGH} falls toward 20 at 2.0, because load that rose quickly is associated with more fatigue. Load is an approximate, heart-rate-based estimate.` });
  }
  if (f.length < 2) return null;
  const tw = f.reduce((s, x) => s + WEIGHTS[x.key], 0);
  for (const x of f) { x.weight = WEIGHTS[x.key]; x.share = x.weight / tw; x.contrib = x.share * x.score; }
  const score = f.reduce((s, x) => s + x.contrib, 0);
  const label = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 45 ? 'Moderate' : 'Low';
  return { score, label, factors: f, coverage: tw, missing: Object.keys(WEIGHTS).filter(k => !f.some(x => x.key === k)) };
}

// ----- range helpers -----
export function inRange(m, range = S.range) {
  if (m.empty) return [];
  if (!range) return m.days;
  return m.days.slice(Math.max(0, m.days.length - range));
}
export function latestWith(m, pred) { for (let i = m.days.length - 1; i >= 0; i--) if (pred(m.days[i])) return m.days[i]; return null; }

export function weekly(days, fn) { // group into 7-day buckets ending at last day; fn(list)->value
  const out = [];
  for (let end = days.length; end > 0; end -= 7) { const w = days.slice(Math.max(0, end - 7), end); out.unshift({ start: w[0].date, end: w[w.length - 1].date, ms: w[Math.floor(w.length / 2)].ms, days: w, v: fn(w) }); }
  return out;
}
export function sleepDebt(days, need) { // last 7 nights with data
  const w = days.slice(-7).filter(d => valid(d.sleepMin));
  return { nights: w.length, debt: w.reduce((s, d) => s + Math.max(0, need - d.sleepMin), 0), surplus: w.reduce((s, d) => s + Math.max(0, d.sleepMin - need), 0) };
}
export function sdMinutes(arr) { const s = sd(arr); return s == null ? null : s; }
