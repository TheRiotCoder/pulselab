// Node unit tests for the analysis core (no browser needed): node tests/unit.mjs
import assert from 'assert';
import { S, mergeDaily, upsertActivity } from '../js/state.js';
import { model, readiness, estimateMaxHr, bandOf, ACWR_HIGH } from '../js/analysis.js';
import { computeInsights } from '../js/insights.js';
import { parseFit, fitToActivity } from '../js/fit.js';
import { parseCsv } from '../js/import.js';
import { pearsonP, correlate, addDays } from '../js/util.js';
import { buildFit } from './fixtures.mjs';

let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log('  PASS ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; }
const reset = () => { S.daily = new Map(); S.acts = new Map(); S.version++; S.range = 0; };

console.log('stats');
t('pearsonP matches known value (r=0.5, n=30 → p≈0.0049)', () => assert(Math.abs(pearsonP(0.5, 30) - 0.0049) < 0.0006, pearsonP(0.5, 30)));
t('correlate recovers a perfect line', () => { const c = correlate([[1, 3], [2, 5], [3, 7], [4, 9]]); assert(Math.abs(c.r - 1) < 1e-9 && Math.abs(c.slope - 2) < 1e-9); });
t('CSV parser handles quotes, commas, CRLF', () => { const r = parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n'); assert.deepStrictEqual(r, [['a', 'b'], ['x,1', 'he said "hi"']]); });

console.log('FIT parser');
t('parses records + session from a synthetic FIT', () => {
  const u8 = buildFit({ startEpochMs: Date.parse('2026-09-01T10:00:00Z'), seconds: 900, baseHr: 140 });
  const p = parseFit(u8); assert.strictEqual(p.records.length, 900); assert(p.session);
  const { act, series } = fitToActivity(p, 55, 190);
  assert.strictEqual(act.start, Date.parse('2026-09-01T10:00:00Z')); assert.strictEqual(act.type, 'running');
  assert(Math.abs(act.durationSec - 900) < 1 && act.avgHr === 140 && act.maxHr === 155, JSON.stringify(act));
  assert(act.distanceM > 2500 && act.distanceM < 2900, 'dist ' + act.distanceM);
  assert(series.t.length <= 500 && series.hr.length === series.t.length && series.lat && series.pwr === undefined);
  assert(Math.abs(series.lat[0] - 41.0) < 0.001 && Math.abs(series.lon[0] + 87.0) < 0.001, 'gps');
  assert(Object.keys(act.hrHist).length > 10);
});
t('rejects non-FIT data', () => assert.throws(() => parseFit(new Uint8Array(40))));

console.log('analysis');
function synth(n, f) { reset(); const r = rng(7); const g = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }; for (let i = 0; i < n; i++) mergeDaily(addDays('2026-01-01', i), f(i, g, r), 'test'); }
t('sleep→HRV link is found, with n and confidence, when it exists', () => {
  synth(120, (i, g) => { const sl = 7 + 0.9 * g(); return { sleepMin: sl * 60, hrv: 60 + 8 * (sl - 7) + 3 * g(), rhr: 55 + g(), stress: 30 + 5 * g(), steps: 8000 + 1000 * g() }; });
  const I = computeInsights(model(), 0); const c = I.cards.find(x => x.id === 'sleep-hrv');
  assert(c, 'card missing'); assert(c.r > 0.5 && c.n > 100 && c.conf === 'higher', JSON.stringify({ r: c.r, n: c.n, conf: c.conf }));
});
t('no link is claimed for independent noise', () => {
  synth(120, (i, g) => ({ sleepMin: (7 + 0.9 * g()) * 60, hrv: 60 + 5 * g(), rhr: 55 + g(), stress: 30 + 5 * g() }));
  const c = computeInsights(model(), 0).cards.find(x => x.id === 'sleep-hrv');
  assert(c && c.conf === 'low' && /No reliable link/.test(c.text), c && c.text);
});
t('insight withheld when too little data (n<14)', () => {
  synth(10, (i, g) => ({ sleepMin: (7 + g()) * 60, hrv: 60 + g() }));
  const I = computeInsights(model(), 0); assert(!I.cards.find(x => x.id === 'sleep-hrv')); const x = I.insufficient.find(q => q.id === 'sleep-hrv'); assert(x && x.n < 14);
});
t('readiness: HRV factor scores the 7-night average on the ln scale; stress is scored vs own baseline', () => {
  synth(80, (i, g) => ({ sleepMin: 450, deepMin: 90, remMin: 90, lightMin: 270, hrv: 60 * Math.exp(i % 2 ? 0.1 : -0.1), rhr: 55 + (i % 2 ? 1 : -1), stress: 25 + (i % 2 ? 3 : -3) }));
  const m = model(); const d = m.days[m.days.length - 1]; const R = d.readiness; assert(R, 'no readiness');
  const hrv = R.factors.find(f => f.key === 'hrv'), rhr = R.factors.find(f => f.key === 'rhr'), sl = R.factors.find(f => f.key === 'sleep'), st = R.factors.find(f => f.key === 'stress');
  assert(Math.abs(hrv.score - (70 + 22 * d.z7_hrv)) < 1e-6, 'hrv uses z7');
  assert(Math.abs(rhr.score - (70 - 22 * d.z_rhr)) < 1e-6);
  const p = m.days[m.days.length - 2]; assert(Math.abs(st.score - (70 - 22 * p.z_stress)) < 1e-6, 'stress vs own baseline');
  assert(Math.abs(sl.score - 100) < 1e-6, 'sleep 450 vs need 450 with 40% restorative → 100, got ' + sl.score);
  assert(/wrist-device deep\/REM stages are only roughly accurate/.test(sl.why), 'sleep explanation caveat');
  assert(Math.abs(R.factors.reduce((s, f) => s + f.share, 0) - 1) < 1e-9);
});
t('HRV baseline, SD and z are on the natural-log scale', () => {
  synth(80, (i) => ({ hrv: 60 * Math.exp(i % 2 ? 0.2 : -0.2), rhr: 55 }));
  const m = model(); const d = m.days[70]; const b = d.b_hrv;
  assert(Math.abs(b.mean - Math.log(60)) < 0.02, 'ln mean ' + b.mean + ' vs ' + Math.log(60));
  assert(Math.abs(b.sd - 0.2) < 0.02, 'ln sd ' + b.sd);
  assert(Math.abs(d.z_hrv - (Math.log(d.hrv) - b.mean) / Math.max(b.sd, 0.04)) < 1e-9);
  assert(Math.abs(bandOf(b, 'hrv').mid - 60) < 1.5, 'geometric mean ~60 ms');
});
t('single-night outlier moves the readiness HRV factor far less than its flag z', () => {
  synth(80, (i, g) => ({ sleepMin: 450, hrv: 60 * Math.exp(0.05 * g()), rhr: 55 + 0.5 * g() }));
  const base = model().days[79]; const baseScore = base.readiness.factors.find(f => f.key === 'hrv').score;
  mergeDaily(addDays('2026-01-01', 79), { hrv: 35 }, 'test'); S.version++;
  const d = model().days[79]; const sc = d.readiness.factors.find(f => f.key === 'hrv').score;
  assert(d.z_hrv < -3, 'flag z should be very negative: ' + d.z_hrv); assert(Math.abs(d.z7_hrv) < Math.abs(d.z_hrv) / 4, `scored z7 ${d.z7_hrv.toFixed(2)} should be <1/4 of the single-night flag z ${d.z_hrv.toFixed(2)}`); assert(sc > baseScore - 45 && sc > 0, 'score still sensible');
});
t('readiness needs ≥2 factors, otherwise null', () => { synth(5, () => ({ sleepMin: 400 })); const m = model(); assert.strictEqual(m.days[4].readiness, null); });
t('constant daily load gives acute:chronic ratio ≈ 1 after warm-up', () => {
  reset(); for (let i = 0; i < 90; i++) { const day = addDays('2026-01-01', i); const start = Date.parse(day + 'T12:00:00'); upsertActivity({ id: 'a' + i, source: 'test', start, type: 'running', name: 'r', durationSec: 3000, distanceM: 9000, avgHr: 150, maxHr: 170 }); }
  const m = model(); const last = m.days[m.days.length - 1]; assert(Math.abs(last.acwr - 1) < 0.05, 'acwr ' + last.acwr); assert(m.days[10].acwr === null);
});
t('load spike raises ACWR above 1.3', () => {
  reset(); for (let i = 0; i < 60; i++) { const day = addDays('2026-01-01', i); const start = Date.parse(day + 'T12:00:00'); const spike = i >= 53; upsertActivity({ id: 'a' + i, source: 'test', start, type: 'running', name: 'r', durationSec: spike ? 7200 : 2400, distanceM: 9000, avgHr: spike ? 165 : 140, maxHr: 180 }); }
  const m = model(); assert(m.days[m.days.length - 1].acwr > 1.3, 'acwr ' + m.days[m.days.length - 1].acwr);
});
t('anomaly detection flags a z>2 reading in the last 14 days only', () => {
  synth(100, (i, g) => ({ hrv: i === 97 ? 20 : 60 + 3 * g(), rhr: 55 + g() }));
  const I = computeInsights(model(), 0); const a = I.anomalies.find(x => x.metric === 'HRV'); assert(a && a.z < -2 && a.n >= 14, JSON.stringify(I.anomalies));
});

// ---- illness-like pattern: 1 night = worth watching; 2+ consecutive days = stronger warning ----
function strainData(badIdx) { synth(100, (i, g) => { const bad = badIdx.includes(i); return { hrv: bad ? 36 : 60 * Math.exp(0.04 * g()), rhr: bad ? 64 : 55 + 0.8 * g(), sleepMin: 450 }; }); }
t('single bad night → "worth watching" only (no strong warning)', () => {
  strainData([95]); const I = computeInsights(model(), 0);
  assert(I.strainRuns.length === 0 && I.strain.length === 0, 'no strong'); assert(I.watch.length === 1);
  const sg = I.suggestions.find(x => /worth watching/.test(x.text)); assert(sg, 'watch suggestion'); assert(/fever, chest pain, shortness of breath or fainting/.test(sg.text) && /not a diagnosis/i.test(sg.text));
});
t('2+ consecutive bad days → stronger warning with care advice', () => {
  strainData([94, 95]); const I = computeInsights(model(), 0);
  assert(I.strainRuns.length === 1 && I.strainRuns[0].length === 2 && I.watch.length === 0);
  const sg = I.suggestions.find(x => /consecutive days/.test(x.text)); assert(sg && /fever, chest pain, shortness of breath or fainting/.test(sg.text) && /not a diagnosis/i.test(sg.text));
});
t('two separated single nights are not a consecutive run', () => {
  strainData([92, 95]); const I = computeInsights(model(), 0); assert(I.strainRuns.length === 0 && I.watch.length === 2);
});

// ---- recovery timing: HRV is dated by wake date, so the effect of a session starts at +1 day ----
function recoveryData(dipLag) {
  reset(); const r = rng(11);
  for (let i = 0; i < 100; i++) {
    const day = addDays('2026-01-01', i); const hard = i % 7 === 3, easy = i % 7 === 5 || i % 7 === 1;
    if (hard || easy) upsertActivity({ id: 'a' + i, source: 'test', start: Date.parse(day + 'T12:00:00'), type: 'running', name: 'r', durationSec: hard ? 7200 : 2400, distanceM: 9000, avgHr: hard ? 168 : 140, maxHr: 180 });
    const dip = (i - dipLag) % 7 === 3 && i - dipLag >= 0; // dip lands `dipLag` days after a hard day
    mergeDaily(day, { hrv: 60 * Math.exp(0.02 * (r() - 0.5)) * (dip ? 0.8 : 1), rhr: 55, sleepMin: 450 }, 'test');
  }
}
t('recovery: dip the night AFTER the session shows at +1 day, "Morning of" is just a baseline check', () => {
  recoveryData(1); const c = computeInsights(model(), 0).cards.find(x => x.id === 'recovery'); assert(c, 'card');
  const pre = c.bars.find(b => /Morning of \(before the session\)/.test(b.label)), p1 = c.bars.find(b => b.label === '+1 day');
  assert(pre && Math.abs(pre.v) < 8 && p1 && p1.v < -10, JSON.stringify(c.bars)); assert(/first morning after the session/.test(c.text), c.text);
  assert(!c.bars.some(b => /Same AM/.test(b.label)));
});
t('recovery: a dip on the pre-session night is NOT attributed to the session', () => {
  recoveryData(0); const c = computeInsights(model(), 0).cards.find(x => x.id === 'recovery'); assert(c);
  assert(!/first morning after the session/.test(c.text) && /already/.test(c.text), c.text);
});

// ---- load thresholds agree between readiness penalty and advice ----
function loadData(spikeLen) { reset(); for (let i = 0; i < 60; i++) { const spike = i >= 60 - spikeLen; upsertActivity({ id: 'a' + i, source: 'test', start: Date.parse(addDays('2026-01-01', i) + 'T12:00:00'), type: 'running', name: 'r', durationSec: spike ? 4200 : 2400, distanceM: 9000, avgHr: spike ? 160 : 140, maxHr: 180 }); mergeDaily(addDays('2026-01-01', i), { sleepMin: 450, rhr: 55, hrv: 60 }, 't'); } }
t('same threshold (1.3) drives the readiness penalty and the advice; no injury wording', () => {
  for (const spike of [0, 5]) {
    loadData(spike); const m = model(); const last = m.days[m.days.length - 1], prev = m.days[m.days.length - 2];
    const I = computeInsights(m, 0); const adv = I.suggestions.some(x => /Load that jumped quickly is associated with more fatigue/.test(x.text));
    const f = last.readiness && last.readiness.factors.find(x => x.key === 'load'); const penalised = f && f.score < 100;
    assert((last.acwr > ACWR_HIGH) === adv, `advice at acwr ${last.acwr}`); assert((prev.acwr > ACWR_HIGH) === !!penalised, `penalty at prev acwr ${prev.acwr}`);
    assert(!/injur/i.test(JSON.stringify(I.suggestions) + (f ? f.why : '')), 'no injury wording');
  }
  assert(ACWR_HIGH === 1.3);
});

// ---- max HR estimate ----
t('max HR is estimated from the 99th percentile of activity HR; manual override wins', () => {
  reset(); S.settings.maxHr = null;
  const hist = {}; for (let h = 100; h <= 180; h++) hist[h] = 100; // 8100 s, uniform 100..180
  upsertActivity({ id: 'h1', source: 'test', start: Date.parse('2026-01-01T10:00:00'), type: 'running', name: 'r', durationSec: 8100, distanceM: 20000, avgHr: 140, maxHr: 200, hrHist: hist });
  mergeDaily('2026-01-01', { rhr: 55 }, 't');
  const e = estimateMaxHr(); assert(e && e.value >= 178 && e.value <= 180 && /seconds/.test(e.unit), JSON.stringify(e));
  let m = model(); assert(m.maxHr === e.value && m.maxHrSource === 'estimated');
  S.settings.maxHr = 195; S.version++; m = model(); assert(m.maxHr === 195 && m.maxHrSource === 'manual'); S.settings.maxHr = null;
  reset(); mergeDaily('2026-01-01', { rhr: 55 }, 't'); S.version++; m = model(); assert(m.maxHr === 190 && m.maxHrSource === 'default' && estimateMaxHr() === null);
});
t('wording: soften 48 h advice', () => {
  recoveryData(1); const I = computeInsights(model(), 0); const s2 = I.suggestions.find(x => /48 h/.test(x.text)); assert(!s2 || /may suit your pattern/.test(s2.text));
});
console.log(`\n${pass} unit tests passed`);
