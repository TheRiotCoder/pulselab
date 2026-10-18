// DEMO DATASET: entirely synthetic, generated on the device with a fixed seed. Not a real person.
import { S, mergeDaily, upsertActivity, flush } from './state.js';
import { dayKey, addDays, clamp } from './util.js';
import { trimpOf } from './analysis.js';

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export async function loadDemo(days = 270) {
  const r = rng(20260817);
  const gauss = () => { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const end = addDays(dayKey(new Date()), -1);
  const maxHr = 188, rest = 54, need = 7.5;
  S.settings.maxHr = maxHr;
  let acuteF = 0, chronicF = 0, prevTrimp = 0, runCount = 0, vo2 = 46.5;
  const sleepHist = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(end, -i); const [Y, M, D] = date.split('-').map(Number);
    const dt = new Date(Y, M - 1, D, 12); const dow = dt.getDay(); const weekend = dow === 0 || dow === 6 || dow === 5 ? (dow === 5 ? 0.5 : 1) : 0;
    const dayIdx = days - 1 - i; const week = Math.floor(dayIdx / 7); const deload = week % 4 === 3;
    const fatigue = acuteF - chronicF; // positive after a heavier-than-usual stretch
    const illness = i === 5 || i === 4 || i === 3 ? (i === 4 ? 1 : i === 5 ? 0.6 : 0.5) : 0; // a few "off" days near the end so anomaly detection has something to find
    // ---- sleep (night ending this morning) ----
    let sleepH = clamp(7.0 + 0.45 * weekend + 0.85 * gauss() - (prevTrimp > 120 ? 0.0 : 0) - illness * 0.6, 4.6, 9.4);
    const awake = 18 + r() * 32 + illness * 15;
    const wakeMin = 6 * 60 + 25 + weekend * 55 + gauss() * 22; // minutes after midnight
    const asleepMin = sleepH * 60; const inBed = asleepMin + awake;
    const bedClock = wakeMin - inBed; // may be negative => previous evening
    const bed = new Date(Y, M - 1, D, 0, 0, 0).getTime() + bedClock * 60000, wake = bed + inBed * 60000;
    const deepF = clamp(0.165 + 0.01 * (sleepH - 7) + gauss() * 0.02 - fatigue * 0.0005, 0.08, 0.26), remF = clamp(0.215 + gauss() * 0.025, 0.12, 0.3);
    const deepMin = asleepMin * deepF, remMin = asleepMin * remF, lightMin = asleepMin - deepMin - remMin;
    // ---- physiology: effects are noisy and deliberately modest ----
    const trendUp = dayIdx * 0.018; // gentle fitness gain
    const hrv = clamp(60 + trendUp + 7 * (sleepH - 7.0) - 0.45 * fatigue + gauss() * 4.8 - illness * 24, 20, 110);
    const rhr = Math.round(clamp(rest + 1 - dayIdx * 0.004 - 1.1 * (sleepH - 7.0) + 0.13 * fatigue + gauss() * 1.3 + illness * 9, 40, 80));
    const stress = Math.round(clamp(31 + 0.06 * prevTrimp + 3.5 * (7.0 - sleepH) + gauss() * 5.5 + illness * 12 + (dow >= 1 && dow <= 4 ? 4 : 0), 8, 80));
    const bbHigh = Math.round(clamp(52 + 13 * (sleepH - 6) - stress * 0.25 + gauss() * 4 + (hrv - 60) * 0.3, 20, 100));
    const bbLow = Math.round(clamp(bbHigh - 52 - stress * 0.3 + gauss() * 6, 5, 60));
    const bbCharged = Math.round(clamp(sleepH * 7.5 + gauss() * 4, 20, 85)), bbDrained = Math.round(clamp(bbCharged + (bbLow - bbHigh) + bbHigh - bbLow + gauss() * 3 + 15, 25, 95));
    // ---- workouts ----
    const acts = [];
    const skip = r() < 0.14 || illness > 0.4;
    const plan = { 1: deload ? null : 'strength', 2: 'easyrun', 3: 'ride', 4: 'intervals', 5: null, 6: 'long', 0: 'walk' }[dow];
    if (plan && !skip) {
      const ramp = deload ? 0.65 : 1 + (week % 4) * 0.1;
      if (plan === 'easyrun') acts.push({ kind: 'running', name: 'Easy run (demo)', min: 38 * ramp + gauss() * 4, inten: 0.56 });
      if (plan === 'intervals') acts.push({ kind: 'running', name: 'Intervals (demo)', min: 46 * ramp + gauss() * 3, inten: 0.7, intervals: true });
      if (plan === 'ride') acts.push({ kind: 'cycling', name: 'Endurance ride (demo)', min: 65 * ramp + gauss() * 8, inten: 0.55 });
      if (plan === 'strength') acts.push({ kind: 'strength', name: 'Strength (demo)', min: 42 + gauss() * 4, inten: 0.5 });
      if (plan === 'long') acts.push(r() < 0.55 ? { kind: 'running', name: 'Long run (demo)', min: 78 * ramp + gauss() * 8, inten: 0.6 } : { kind: 'cycling', name: 'Long ride (demo)', min: 115 * ramp + gauss() * 12, inten: 0.58 });
      if (plan === 'walk') acts.push({ kind: r() < 0.5 ? 'hiking' : 'walking', name: 'Walk (demo)', min: 55 + gauss() * 10, inten: 0.4 });
    }
    let dayTrimp = 0, intMod = 0, intVig = 0, extraSteps = 0;
    for (const a of acts) {
      const startMs = new Date(Y, M - 1, D, a.kind === 'cycling' || a.min > 70 ? 7 : 17, Math.floor(r() * 45)).getTime();
      const durS = Math.round(clamp(a.min, 20, 200) * 60);
      const fatigueAdj = 1 + clamp(fatigue * 0.003, -0.04, 0.05);
      const sess = genSeries(a, durS, rest, maxHr, fatigueAdj, r, gauss, vo2);
      const distM = a.kind === 'strength' ? null : sess.dist;
      const act = { id: 'demo-' + date + '-' + a.kind, source: 'demo', start: startMs, type: a.kind, name: a.name, durationSec: durS, distanceM: distM, avgHr: sess.avgHr, maxHr: sess.maxHr,
        avgPower: sess.avgPower, calories: Math.round(durS / 60 * (a.kind === 'strength' ? 6 : 10.5)), ascentM: a.kind === 'strength' ? null : Math.round(sess.ascent), hrHist: sess.hrHist, hasSeries: true, te: +(1.8 + a.inten * 2.2).toFixed(1) };
      upsertActivity(act, sess.series, true);
      const t = trimpOf(act, rest, maxHr, 'm').v; dayTrimp += t;
      if (a.inten >= 0.65) intVig += Math.round(durS / 60 * 0.5), intMod += Math.round(durS / 60 * 0.5); else if (a.inten >= 0.5) intMod += Math.round(durS / 60 * 0.9);
      extraSteps += a.kind === 'running' ? durS / 60 * 160 : a.kind === 'walking' || a.kind === 'hiking' ? durS / 60 * 105 : 0;
      if (a.kind === 'running') { runCount++; vo2 += 0.03 * (a.inten > 0.65 ? 1.6 : 1) + gauss() * 0.03; }
    }
    acuteF += (dayTrimp - acuteF) * (1 - Math.exp(-1 / 7)); chronicF += (dayTrimp - chronicF) * (1 - Math.exp(-1 / 28)); prevTrimp = dayTrimp;
    const steps = Math.round(clamp(6800 + 1700 * gauss() + extraSteps + (weekend ? 600 : 0) - illness * 2500, 1200, 30000));
    mergeDaily(date, {
      steps, rhr, hrv: Math.round(hrv), stress, bbHigh, bbLow, bbCharged, bbDrained, bbWake: bbHigh,
      sleepMin: asleepMin, deepMin, remMin, lightMin, awakeMin: awake, sleepStart: bed, sleepEnd: wake,
      intMod: intMod + Math.round(steps / 400), intVig, calories: Math.round(2150 + dayTrimp * 3.2 + steps * 0.04),
      vo2max: acts.some(a => a.kind === 'running') ? +vo2.toFixed(1) : null
    }, 'demo', true);
    sleepHist.push(sleepH);
  }
  S.meta.demo = true;
  S.meta.imports = [{ at: Date.now(), files: ['Demo data'], found: { demo: days }, range: { from: addDays(end, -(days - 1)), to: end } }];
  await flush();
  return { days };
}

function genSeries(a, durS, rest, maxHr, fatigueAdj, r, gauss, vo2) {
  const n = Math.min(480, Math.floor(durS / 5)); const dt = durS / n;
  const series = { t: [], hr: [], spd: [], pwr: [], cad: [], alt: [], lat: [], lon: [] };
  const target = rest + (maxHr - rest) * a.inten * fatigueAdj * (a.kind === 'cycling' ? 0.93 : 1);
  const baseSpd = a.kind === 'running' ? 2.75 + (vo2 - 46) * 0.05 + (a.inten - 0.58) * 2.2 : a.kind === 'cycling' ? 6.6 + (a.inten - 0.56) * 4 : a.kind === 'hiking' ? 1.25 : a.kind === 'walking' ? 1.5 : 0;
  const hist = {}; let dist = 0, ascent = 0, prevAlt = null, hrSum = 0, hrMax = 0, pSum = 0, pN = 0;
  const lat0 = 40.0, lon0 = -100.0; let ang = r() * 6.28;
  let hr = rest + 10;
  for (let k = 0; k < n; k++) {
    const t = k * dt;
    let tgt = target;
    if (a.intervals) { const ph = (t / 60) % 8; tgt = t < 600 || t > durS - 420 ? rest + (target - rest) * 0.75 : ph < 3 ? rest + (target - rest) * 1.45 : rest + (target - rest) * 0.8; }
    const warm = 1 - Math.exp(-t / 150);
    const drift = 1 + 0.045 * (t / durS);
    const wave = 6 * Math.sin(t / 240 + a.min) + 3 * Math.sin(t / 70);
    const goal = wave + rest + (tgt * drift - rest) * (a.kind === 'strength' ? 0.8 + 0.2 * Math.sin(t / 90) : warm) * 1.0;
    hr += (goal - hr) * 0.25 + gauss() * 0.8;
    const h = Math.round(clamp(hr, rest, maxHr - 1)); series.hr.push(h);
    hist[h] = (hist[h] || 0) + dt; hrSum += h; if (h > hrMax) hrMax = h;
    let sp = null;
    if (baseSpd) {
      const effort = a.intervals ? (tgt / target) : 1; sp = Math.max(0.5, baseSpd * (0.5 + 0.5 * warm) * (0.9 + 0.1 * effort) * (1 + gauss() * 0.035) * (t > durS * 0.8 ? 0.98 : 1));
      series.spd.push(+sp.toFixed(2)); dist += sp * dt;
    }
    if (a.kind === 'cycling') { const p = Math.round(clamp(110 + (h - rest) * 1.6 + gauss() * 14, 0, 450)); series.pwr.push(p); pSum += p; pN++; }
    if (a.kind === 'running') series.cad.push(Math.round(168 + (sp || 0) * 2 + gauss() * 1.5)); else if (a.kind === 'cycling') series.cad.push(Math.round(84 + gauss() * 5));
    if (a.kind !== 'strength') {
      const alt = 220 + 22 * Math.sin(t / 420) + 9 * Math.sin(t / 130); series.alt.push(+alt.toFixed(1)); if (prevAlt != null && alt > prevAlt) ascent += alt - prevAlt; prevAlt = alt;
      ang += (sp || 1) * dt / 600 * (0.8 + 0.4 * Math.sin(t / 800)); const rr = 0.006 + 0.002 * Math.sin(ang * 2);
      series.lat.push(+(lat0 + Math.sin(ang) * rr).toFixed(5)); series.lon.push(+(lon0 + Math.cos(ang) * rr * 1.3 - 0.006 * 1.3).toFixed(5));
    }
    series.t.push(Math.round(t));
  }
  for (const k of Object.keys(series)) if (!series[k].length) delete series[k];
  return { series, hrHist: hist, dist, ascent, avgHr: Math.round(hrSum / n), maxHr: hrMax, avgPower: pN ? Math.round(pSum / pN) : null };
}
