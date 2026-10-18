// All derived metrics. Formulas are deliberately simple and documented in the UI.
import { S } from './state.js';
import { addDays, daysBetween, dayKey, dayMs, mean, sd, median, valid, clamp, rollingStats, movingAvg, fmtDur, fmtNum } from './util.js';

export const ZONES = [
  { name: 'Z1 Easy', lo: 0, hi: 0.6, cls: 'z1' }, { name: 'Z2 Aerobic', lo: 0.6, hi: 0.7, cls: 'z2' }, { name: 'Z3 Tempo', lo: 0.7, hi: 0.8, cls: 'z3' },
  { name: 'Z4 Threshold', lo: 0.8, hi: 0.9, cls: 'z4' }, { name: 'Z5 Max', lo: 0.9, hi: 9, cls: 'z5' }];
export const zoneOf = (hr, maxHr) => { const p = hr / maxHr; return p < 0.6 ? 0 : p < 0.7 ? 1 : p < 0.8 ? 2 : p < 0.9 ? 3 : 4; };

export const WEIGHTS = { sleep: 0.35, hrv: 0.25, rhr: 0.20, stress: 0.10, load: 0.10 };
const BASE_KEYS = ['hrv', 'rhr', 'sleepMin', 'stress', 'steps'];
let cache = { v: -1, key: '', m: null };

export function zonesOfActivity(a, maxHr = S.settings.maxHr) {
  const secs = [0, 0, 0, 0, 0];
  if (a.hrHist) { for (const [bpm, s] of Object.entries(a.hrHist)) secs[zoneOf(+bpm, maxHr)] += s; return { secs, approx: false }; }
  if (a.avgHr && a.durationSec) { secs[zoneOf(a.avgHr, maxHr)] += a.durationSec; return { secs, approx: true }; }
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
  const key = S.version + '|' + S.settings.maxHr + '|' + S.settings.restHrOverride + '|' + S.settings.sleepNeedH + '|' + S.settings.sex;
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
  const rest = S.settings.restHrOverride || median(days.map(d => d.rhr)) || 60;
  const maxHr = S.settings.maxHr;
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
  // baselines
  const base = {};
  for (const k of BASE_KEYS) {
    const vals = days.map(d => valid(d[k]) ? d[k] : null);
    base[k] = { b60: rollingStats(vals, 60, 14, true), ma7: movingAvg(vals, 7, 3) };
    days.forEach((d, i) => { d['ma7_' + k] = base[k].ma7[i]; const b = base[k].b60[i]; d['b_' + k] = b; });
  }
  const sdFloor = { hrv: 0.04, rhr: 0, sleepMin: 0.04, stress: 0, steps: 0.1 };
  const zOf = (k, v, i) => {
    const b = base[k].b60[i]; if (!b || !valid(v)) return null;
    const s = Math.max(b.sd || 0, (sdFloor[k] || 0) * b.mean, k === 'rhr' ? 1 : k === 'stress' ? 2 : 0.0001);
    return (v - b.mean) / s;
  };
  const model = { days, byDate, acts, first, last, rest, maxHr, base, zOf, actsByDay };
  days.forEach((d, i) => { for (const k of BASE_KEYS) d['z_' + k] = zOf(k, d[k], i); });
  // sleep timing
  days.forEach((d, i) => {
    if (valid(d.sleepStart)) d.bedMin = bedMinOf(d.sleepStart);
    if (valid(d.sleepEnd)) d.wakeMin = localMinutes(d.sleepEnd);
  });
  days.forEach((d, i) => { d.readiness = readiness(model, i); });
  return model;
}

export function readiness(m, i) {
  const d = m.days[i]; const need = S.settings.sleepNeedH * 60; const f = [];
  if (valid(d.sleepMin)) {
    const dur = clamp(d.sleepMin / need, 0, 1) * 100;
    let q = null; if (valid(d.deepMin) && valid(d.remMin)) q = clamp(((d.deepMin + d.remMin) / d.sleepMin) / 0.40, 0, 1) * 100;
    const sc = q == null ? dur : 0.75 * dur + 0.25 * q;
    f.push({ key: 'sleep', name: 'Sleep', score: sc, value: fmtDur(d.sleepMin),
      why: `You slept ${fmtDur(d.sleepMin)} against a ${fmtDur(need)} need (${Math.round(d.sleepMin / need * 100)}%). ` + (q == null ? 'Stage data was missing, so duration alone is scored.' : `Score = 75% duration + 25% restorative share (deep+REM was ${Math.round((d.deepMin + d.remMin) / d.sleepMin * 100)}% of sleep; 40% or more scores full marks).`) });
  }
  const bh = d.b_hrv, zh = d.z_hrv;
  if (valid(d.hrv) && bh && zh != null) f.push({ key: 'hrv', name: 'HRV vs baseline', score: clamp(70 + 22 * zh, 0, 100), value: fmtNum(d.hrv) + ' ms',
    why: `Overnight HRV ${fmtNum(d.hrv)} ms vs your 60-day baseline ${fmtNum(bh.mean, 0)} ms (±${fmtNum(bh.sd, 0)}); z = ${zh.toFixed(1)}. Score = 70 + 22×z (capped 0–100): at baseline you score 70, one SD above ≈92, one SD below ≈48.` });
  const br = d.b_rhr, zr = d.z_rhr;
  if (valid(d.rhr) && br && zr != null) f.push({ key: 'rhr', name: 'Resting HR vs baseline', score: clamp(70 - 22 * zr, 0, 100), value: fmtNum(d.rhr) + ' bpm',
    why: `Resting HR ${fmtNum(d.rhr)} bpm vs your 60-day baseline ${fmtNum(br.mean, 0)} bpm (±${fmtNum(br.sd, 1)}); z = ${zr.toFixed(1)}. Lower than baseline is better: score = 70 − 22×z (capped 0–100).` });
  const p = m.days[i - 1];
  if (p && valid(p.stress)) f.push({ key: 'stress', name: 'Yesterday’s stress', score: clamp((75 - p.stress) / 50 * 100, 0, 100), value: fmtNum(p.stress),
    why: `Yesterday’s average stress was ${fmtNum(p.stress)} (Garmin 0–100 scale). Score maps 25 → 100 and 75 → 0 linearly.` });
  if (p && valid(p.acwr)) {
    const a = p.acwr; const sc = a < 0.8 ? 75 + 25 * a / 0.8 : a <= 1.3 ? 100 : Math.max(20, 100 - (a - 1.3) / 0.7 * 80);
    f.push({ key: 'load', name: 'Training load balance', score: sc, value: a.toFixed(2), why: `Acute:chronic load ratio through yesterday is ${a.toFixed(2)}. 0.8–1.3 is treated as a balanced “sweet spot” (full score); below 0.8 loses a little (you’re detraining, not fatigued); above 1.3 falls toward 20 at 2.0, since fast load jumps are associated with higher fatigue/injury risk.` });
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
