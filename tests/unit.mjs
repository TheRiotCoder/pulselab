// Node unit tests for the analysis core (no browser needed): node tests/unit.mjs
import assert from 'assert';
import { S, mergeDaily, upsertActivity } from '../js/state.js';
import { model, readiness } from '../js/analysis.js';
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
t('readiness: values at baseline score 70 for HRV/RHR factors; formula pieces are exposed', () => {
  synth(80, (i, g) => ({ sleepMin: 450, deepMin: 90, remMin: 90, lightMin: 270, hrv: 60 + (i % 2 ? 4 : -4), rhr: 55 + (i % 2 ? 1 : -1), stress: 25 }));
  const m = model(); const d = m.days[m.days.length - 1]; const R = d.readiness; assert(R, 'no readiness');
  const hrv = R.factors.find(f => f.key === 'hrv'), rhr = R.factors.find(f => f.key === 'rhr'), sl = R.factors.find(f => f.key === 'sleep');
  assert(Math.abs(hrv.score - (70 + 22 * d.z_hrv)) < 1e-6 && Math.abs(rhr.score - (70 - 22 * d.z_rhr)) < 1e-6);
  assert(Math.abs(sl.score - 100) < 1e-6, 'sleep 450 min vs need 450, 40% restorative → 100, got ' + sl.score);
  assert(R.factors.find(f => f.key === 'stress').score === 100);
  assert(Math.abs(R.factors.reduce((s, f) => s + f.share, 0) - 1) < 1e-9);
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
console.log(`\n${pass} unit tests passed`);
