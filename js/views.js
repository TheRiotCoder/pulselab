// View renderers. Each takes (root, ctx) and fills root. All imported strings are escaped.
import { S, getSeries, hasData } from './state.js';
import { model, inRange, latestWith, weekly, sleepDebt, ZONES, zonesOfActivity, zoneOf, bandOf, ACWR_HIGH, ACWR_LOW } from './analysis.js';
import { computeInsights } from './insights.js';
import { lineChart, barChart, scatter, miniBars, routeMap } from './charts.js';
import { esc, fmtDay, fmtDayLong, fmtDur, fmtDurSec, fmtNum, fmtPace, fmtClock, mean, sd, median, valid, DAY, daysBetween, dayKey, sum, clamp } from './util.js';

const NAV_TYPES = { running: 'Run', cycling: 'Ride', walking: 'Walk', hiking: 'Hike', swimming: 'Swim', strength: 'Gym', rowing: 'Row', other: 'Act' };
const TYPE_CLS = { running: 'c1', cycling: 'c2', walking: 'c3', hiking: 'c6', strength: 'c4', swimming: 'c5', rowing: 'c6', other: 'z1' };
const TYPE_NAME = { running: 'Running', cycling: 'Cycling', walking: 'Walking', hiking: 'Hiking', swimming: 'Swimming', strength: 'Strength', rowing: 'Rowing', other: 'Other' };

const BAND_K = 1.5; // normal band = 60-day mean ± 1.5 SD
const pts = (days, fn) => days.map(d => [d.ms, fn(d)]).filter(p => valid(p[1]));
const rangeLabel = () => S.range ? 'last ' + (S.range === 365 ? 'year' : S.range + ' days') : 'all data';
const distFmt = m => m == null ? '–' : S.settings.units === 'mi' ? (m / 1609.344).toFixed(2) + ' mi' : (m / 1000).toFixed(2) + ' km';
const unitsLong = () => S.settings.units === 'mi' ? 'mi' : 'km';
const tile = (k, v, d = '', unit = '') => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${v}${unit ? ' <small>' + esc(unit) + '</small>' : ''}</div><div class="d">${d}</div></div>`;
const legend = items => `<div class="legend">${items.map(([c, t]) => `<span class="l-${c}">${esc(t)}</span>`).join('')}</div>`;
const card = (title, body, extra = '') => `<section class="card"><h2>${title}${extra}</h2>${body}</section>`;
function deltaHtml(cur, prev, goodUp, fmt, unit = '') {
  if (!valid(cur) || !valid(prev)) return '';
  const d = cur - prev; if (Math.abs(d) < 1e-9) return 'same as before';
  const good = goodUp == null ? null : (d > 0) === goodUp;
  return `<span class="${good == null ? '' : good ? 'up-good' : 'up-bad'}">${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d))}${unit}</span> vs prior week`;
}
export function mount(el, child) { el.append(child); return el; }
function slot(root, id, node) { const s = root.querySelector('#' + id); if (s && node) s.append(node); }
function emptyState(root, ctx) {
  root.innerHTML = `<section class="card"><h2>Welcome to PulseLab</h2>
    <p>Analyse your Garmin data with deeper insight than Garmin Connect, privately: everything is processed and stored on this device and nothing is uploaded anywhere.</p>
    <div class="btns"><button class="btn" data-go="data">Import my Garmin export</button><button class="btn secondary" data-act="demo">Load demo data</button></div>
    <p class="sub">No Garmin export yet? In Garmin Connect (web) go to Account → Data Management → Export Your Data, then request your export. Garmin emails a download link (can take from minutes to a couple of days). Details are on the Data tab. Try the demo to explore the app meanwhile.</p></section>`;
}
function wk(days, f) { return weekly(days, f); }

// ============ OVERVIEW ============
export function overview(root, ctx) {
  const m = ctx.m; if (m.empty) return emptyState(root, ctx);
  const days = ctx.days; const last = m.days[m.days.length - 1];
  const rd = latestWith(m, d => d.readiness);
  const ageDays = daysBetween(last.date, dayKey(new Date()));
  let html = `<p class="sub">Latest data: <b>${esc(fmtDayLong(last.date))}</b>${ageDays > 1 ? ` (${ageDays} days ago)` : ''} · showing ${esc(rangeLabel())}</p>`;
  if (rd) {
    const R = rd.readiness, c = 2 * Math.PI * 45, cls = R.score >= 65 ? 'c2' : R.score >= 45 ? 'c3' : 'c5';
    html += `<section class="card"><h2>Readiness <span class="badge">own formula</span></h2><div class="hero">
      <svg class="ring" viewBox="0 0 104 104" role="img" aria-label="Readiness ${Math.round(R.score)} of 100, ${R.label}"><circle class="bg" cx="52" cy="52" r="45"/><circle class="fg st-${cls}" cx="52" cy="52" r="45" stroke-dasharray="${(c * R.score / 100).toFixed(1)} ${c.toFixed(1)}"/><text x="52" y="58">${Math.round(R.score)}</text></svg>
      <div><div class="big ${cls === 'c2' ? 'ok' : cls === 'c3' ? 'warnc' : 'bad'}">${esc(R.label)}</div>
      <div class="sub">for ${esc(fmtDayLong(rd.date))}<br>${R.factors.length} of 5 factors available${R.missing.length ? ' (missing: ' + R.missing.join(', ') + ')' : ''}</div></div></div>
      <p class="sub mt8">A transparent 0–100 score from your own data, not Garmin’s algorithm. Tap a factor to see exactly how it was calculated.</p>
      <div id="factors">${R.factors.map(f => `<details class="factor"><summary><div class="fh"><span>${esc(f.name)}</span><span>${esc(f.value)} · ${Math.round(f.score)}/100 · ${Math.round(f.share * 100)}% weight</span></div><div class="meter"><i data-w="${clamp(f.score, 0, 100)}"></i></div></summary><p>${esc(f.why)}</p></details>`).join('')}</div>
      ${valid(rd.garminReadiness) ? `<p class="sub">For comparison, Garmin’s own Training Readiness that day: <b>${Math.round(rd.garminReadiness)}</b> (from your export).</p>` : ''}</section>`;
    html += card('Readiness trend', '<div id="c-ready"></div>');
  } else html += card('Readiness', `<p class="muted">Not enough data yet. The score needs at least two of: sleep, overnight HRV and resting HR (each with ~2 weeks of history for a baseline), yesterday’s stress, and training load.</p>`);
  // tiles
  const lastV = k => { for (let i = m.days.length - 1; i >= Math.max(0, m.days.length - 8); i--) if (valid(m.days[i][k])) return m.days[i]; return null; };
  const w1 = m.days.slice(-7), w0 = m.days.slice(-14, -7);
  const avgOf = (w, k) => mean(w.map(d => d[k]));
  const t = [];
  const ds = lastV('sleepMin'); t.push(tile('Sleep', ds ? fmtDur(ds.sleepMin) : '–', deltaHtml(avgOf(w1, 'sleepMin'), avgOf(w0, 'sleepMin'), true, v => fmtDur(v))));
  const dh = lastV('hrv'); t.push(tile('HRV', dh ? fmtNum(dh.hrv) : '–', deltaHtml(avgOf(w1, 'hrv'), avgOf(w0, 'hrv'), true, v => fmtNum(v, 1)), 'ms'));
  const dr = lastV('rhr'); t.push(tile('Resting HR', dr ? fmtNum(dr.rhr) : '–', deltaHtml(avgOf(w1, 'rhr'), avgOf(w0, 'rhr'), false, v => fmtNum(v, 1)), 'bpm'));
  const dst = lastV('stress'); t.push(tile('Stress', dst ? fmtNum(dst.stress) : '–', deltaHtml(avgOf(w1, 'stress'), avgOf(w0, 'stress'), false, v => fmtNum(v, 0))));
  const dp = lastV('steps'); t.push(tile('Steps', dp ? fmtNum(dp.steps) : '–', deltaHtml(avgOf(w1, 'steps'), avgOf(w0, 'steps'), true, v => fmtNum(v, 0))));
  const la = latestWith(m, d => valid(d.acwr)); t.push(tile('Load ratio', la ? la.acwr.toFixed(2) : '–', la ? (la.acwr > ACWR_HIGH ? '<span class="warnc">rose quickly</span>' : la.acwr >= ACWR_LOW ? '<span class="ok">balanced</span>' : 'below usual') : 'needs 4 weeks of workouts'));
  html += `<div class="tiles">${t.join('')}</div>`;
  const latestAct = m.acts[m.acts.length - 1];
  if (latestAct) html += card('Latest activity', `<ul class="list">${actRow(latestAct)}</ul>`, '<a href="#/activity" class="small">All →</a>');
  const ins = computeInsights(m, S.range);
  html += card('Worth knowing', `<ul class="summary-list">${ins.suggestions.slice(0, 3).map(s => `<li>${esc(s.text)} <span class="muted small">(${esc(s.basis)})</span></li>`).join('')}</ul><p class="sub">Not medical advice. <a href="#/insights">See all insights →</a></p>`);
  root.innerHTML = html;
  if (rd) slot(root, 'c-ready', lineChart({ series: [{ name: 'Readiness', cls: 'c1', pts: pts(days, d => d.readiness && d.readiness.score), fmt: v => Math.round(v) }], yMin: 0, yMax: 100, refs: [{ y: 65, label: 'good' }, { y: 45, label: 'moderate' }], valFmt: v => Math.round(v), aria: 'Readiness score over time' }));
}
const actRow = a => `<li><a class="act" href="#/activity/${encodeURIComponent(a.id)}"><span class="ic">${NAV_TYPES[a.type] || 'Act'}</span><span class="m"><b>${esc(a.name)}</b><span class="muted small">${esc(fmtDay(a.day, true))} · ${esc(fmtDurSec(a.durationSec))}${a.distanceM ? ' · ' + esc(distFmt(a.distanceM)) : ''}</span></span><span class="r">${a.avgHr ? Math.round(a.avgHr) + ' bpm' : ''}<br>${Math.round(a.trimp)} load</span></a></li>`;

// ============ SLEEP ============
export function sleep(root, ctx) {
  const m = ctx.m; if (m.empty) return emptyState(root, ctx);
  const days = ctx.days, need = S.settings.sleepNeedH * 60;
  const withSleep = days.filter(d => valid(d.sleepMin));
  if (!withSleep.length) { root.innerHTML = card('Sleep', '<p class="muted">No sleep data in this range. Import sleepData*.json from your Garmin export.</p>'); return; }
  const avg = mean(withSleep.map(d => d.sleepMin)); const bed = withSleep.map(d => d.bedMin).filter(valid);
  const sdBed = bed.length >= 5 ? sd(bed) : null;
  const debt = sleepDebt(m.days, need);
  const stg = withSleep.filter(d => valid(d.deepMin) && valid(d.remMin));
  const deepPct = stg.length ? mean(stg.map(d => d.deepMin / d.sleepMin * 100)) : null, remPct = stg.length ? mean(stg.map(d => d.remMin / d.sleepMin * 100)) : null;
  const below = withSleep.filter(d => d.sleepMin < need - 30).length;
  const cons = sdBed == null ? ['–', 'no bedtime data'] : sdBed <= 30 ? [Math.round(sdBed) + ' min', '<span class="ok">very regular</span>'] : sdBed <= 60 ? [Math.round(sdBed) + ' min', 'fairly regular'] : [Math.round(sdBed) + ' min', '<span class="warnc">irregular</span>'];
  let html = `<div class="tiles">${tile('Average', fmtDur(avg), `need ${fmtDur(need)}`)}${tile('Sleep debt', debt.nights ? fmtDur(debt.debt) : '–', debt.nights ? `last ${debt.nights} nights` : '')}${tile('Bedtime ±', cons[0], cons[1])}
    ${tile('Deep', deepPct == null ? '–' : Math.round(deepPct) + '%', 'of sleep')}${tile('REM', remPct == null ? '–' : Math.round(remPct) + '%', 'of sleep')}${tile('Short nights', String(below), `of ${withSleep.length} (n)`)}</div>`;
  const agg = days.length > 120;
  html += card('Nightly sleep stages', `<div class="sub">${agg ? 'Weekly averages' : 'Hours asleep by stage'} · ${esc(rangeLabel())} · n=${withSleep.length} nights. Wrist-device deep/REM stages are only roughly accurate, so read them as trends, not exact numbers.</div>${legend([['deep', 'Deep'], ['rem', 'REM'], ['light', 'Light'], ['awake', 'Awake']])}<div id="c-stages"></div>`);
  html += card('Duration trend', `${legend([['c1', 'Nightly'], ['c3', '7-night average']])}<div id="c-dur"></div>`);
  html += card('Bedtime & wake time', `<div class="sub">Consistency matters as much as length. Times are shown in this device’s time zone.</div>${legend([['c4', 'Bedtime'], ['c3', 'Wake']])}<div id="c-bed"></div>`);
  html += card('Sleep debt, explained', `<p class="small">Sleep debt = sum over the last 7 recorded nights of how far each night fell short of your ${fmtDur(need)} need (change it in Data → Settings). Longer nights don’t cancel it out here, because recovery isn’t perfectly symmetrical. Currently <b>${debt.nights ? fmtDur(debt.debt) : 'unknown'}</b> over ${debt.nights} nights${debt.surplus ? `, with ${fmtDur(debt.surplus)} of surplus on other nights` : ''}.</p>`);
  root.innerHTML = html;
  let bars;
  if (agg) bars = wk(days, w => w).map(b => { const ws = b.days.filter(d => valid(d.sleepMin)); if (ws.length < 2) return null; const f = k => mean(ws.map(d => d[k] ?? 0)) / 60; return { ms: b.ms, label: 'Week of ' + fmtDay(b.start), segs: [{ v: f('deepMin'), cls: 'deep', name: 'Deep' }, { v: f('remMin'), cls: 'rem', name: 'REM' }, { v: f('lightMin') || (mean(ws.map(d => d.sleepMin)) / 60 - f('deepMin') - f('remMin')), cls: 'light', name: 'Light' }, { v: f('awakeMin'), cls: 'awake', name: 'Awake' }] }; }).filter(Boolean);
  else bars = days.filter(d => valid(d.sleepMin)).map(d => ({ ms: d.ms, segs: valid(d.deepMin) ? [{ v: d.deepMin / 60, cls: 'deep', name: 'Deep' }, { v: d.remMin / 60, cls: 'rem', name: 'REM' }, { v: d.lightMin / 60, cls: 'light', name: 'Light' }, { v: (d.awakeMin || 0) / 60, cls: 'awake', name: 'Awake' }] : [{ v: d.sleepMin / 60, cls: 'light', name: 'Asleep' }] }));
  slot(root, 'c-stages', barChart({ bars, step: agg ? 7 * DAY : DAY, valFmt: h => fmtDur(h * 60), segFmt: h => fmtDur(h * 60), yFmt: v => v + 'h', refs: [{ y: need / 60 }], aria: 'Sleep stages per night' }));
  slot(root, 'c-dur', lineChart({ series: [{ name: 'Sleep', cls: 'c1', pts: pts(days, d => d.sleepMin / 60), fmt: h => fmtDur(h * 60) }, { name: '7-night avg', cls: 'c3', pts: pts(days, d => d.ma7_sleepMin / 60), fmt: h => fmtDur(h * 60), thin: false }], refs: [{ y: need / 60, label: 'need' }], yFmt: v => v + 'h', aria: 'Sleep duration trend' }));
  slot(root, 'c-bed', lineChart({ series: [{ name: 'Bedtime', cls: 'c4', pts: pts(days, d => d.bedMin), fmt: v => clockOf(v) }, { name: 'Wake', cls: 'c3', pts: pts(days, d => valid(d.wakeMin) ? (d.wakeMin + 720) % 1440 + (d.wakeMin + 720 >= 1440 ? 0 : 0) : null), fmt: v => clockOf(v) }], yStep: 60, yFmt: v => clockOf(v), aria: 'Bedtime and wake time' }));
}
const clockOf = v => { const t = Math.round((v + 720) % 1440); let h = Math.floor(t / 60) % 24; const mm = t % 60; const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return h + (mm ? ':' + String(mm).padStart(2, '0') : '') + ap; };

// ============ HEART ============
export function heart(root, ctx) {
  const m = ctx.m; if (m.empty) return emptyState(root, ctx);
  const days = ctx.days;
  const has = k => days.some(d => valid(d[k]));
  if (!has('rhr') && !has('hrv')) { root.innerHTML = card('Heart', '<p class="muted">No resting HR or HRV in this range. Import the UDSFile_*.json and healthStatusData*.json files from your export.</p>'); return; }
  let html = '';
  const spec = [['rhr', 'Resting heart rate', 'bpm', 'c5', false], ['hrv', 'Heart-rate variability (overnight)', 'ms', 'c2', true]];
  const flagged = [];
  for (const [k, title, unit, cls, goodUp] of spec) {
    if (!has(k)) continue;
    const lastD = latestWith(m, d => valid(d['ma7_' + k]) && d['b_' + k]);
    const vals = days.filter(d => valid(d[k]));
    let status = 'Baseline needs ~2 weeks of data.';
    if (lastD) {
      const bd = bandOf(lastD['b_' + k], k, BAND_K), v = lastD['ma7_' + k];
      const pos = v < bd.lo ? 'below' : v > bd.hi ? 'above' : 'within';
      const bad = (pos === 'below' && goodUp) || (pos === 'above' && !goodUp);
      status = `Your 7-day average is <b>${fmtNum(v, 1)} ${unit}</b>, <b class="${pos === 'within' ? 'ok' : bad ? 'bad' : 'warnc'}">${pos} your normal range</b> (60-day baseline ${fmtNum(bd.mid, 1)} ${unit}, normal band ${fmtNum(bd.lo, 0)}–${fmtNum(bd.hi, 0)}, n=${bd.n}${k === 'hrv' ? '; log scale' : ''}).`;
    }
    const outside = vals.filter(d => { const bd = bandOf(d['b_' + k], k, BAND_K); return bd && (d[k] < bd.lo || d[k] > bd.hi); });
    outside.forEach(d => flagged.push({ d, k, unit }));
    html += card(title, `<p class="small mt0">${status}</p>${legend([[cls, 'Daily'], ['c3', '7-day average'], ['band', 'Normal band (60-day baseline ± 1.5 SD)']])}<div id="c-${k}"></div><p class="sub">${outside.length} of ${vals.filter(d => d['b_' + k]).length} days with a baseline fall outside the band (ringed in red). Even in a healthy pattern roughly 1 day in 8 lands outside a ±1.5 SD band; a shifted 7-day line matters more than a single day.${k === 'hrv' ? ' HRV baselines are computed on a log scale (a geometric mean), because HRV is skewed.' : ''}</p>`);
  }
  const fl = flagged.sort((a, b) => b.d.date.localeCompare(a.d.date)).slice(0, 8);
  if (fl.length) html += card('Recent readings outside your band', `<ul class="summary-list">${fl.map(({ d, k, unit }) => { const b = d['b_' + k]; const z = d['z_' + k]; return `<li><b>${esc(fmtDay(d.date))}</b> ${k === 'hrv' ? 'HRV' : 'Resting HR'} ${fmtNum(d[k])} ${unit} vs ${fmtNum(bandOf(b, k).mid, 0)} (z = ${z.toFixed(1)})</li>`; }).join('')}</ul><p class="sub">Common reasons: poor sleep, hard training, alcohol, illness, travel, stress. Not a diagnosis.</p>`);
  const ovn = days.filter(d => valid(d.ovnHr));
  if (ovn.length > 4) html += card('Overnight heart rate', `<div id="c-ovn"></div>`);
  root.innerHTML = html;
  for (const [k, , unit, cls] of spec) {
    if (!has(k)) continue;
    const band = { lo: [], hi: [] }; const fl2 = [];
    for (const d of days) { const bd = bandOf(d['b_' + k], k, BAND_K); if (!bd) continue; band.lo.push([d.ms, bd.lo]); band.hi.push([d.ms, bd.hi]); if (valid(d[k]) && (d[k] < bd.lo || d[k] > bd.hi)) fl2.push({ x: d.ms, y: d[k] }); }
    slot(root, 'c-' + k, lineChart({ series: [{ name: k === 'hrv' ? 'HRV' : 'RHR', cls, pts: pts(days, d => d[k]), dots: true, noLine: true, fmt: v => fmtNum(v, 0) + ' ' + unit }, { name: '7-day avg', cls: 'c3', pts: pts(days, d => d['ma7_' + k]), fmt: v => fmtNum(v, 1) + ' ' + unit }], band, flags: fl2, aria: title(k) }));
  }
  if (ovn.length > 4) slot(root, 'c-ovn', lineChart({ series: [{ name: 'Overnight HR', cls: 'c1', pts: pts(days, d => d.ovnHr), fmt: v => fmtNum(v, 0) + ' bpm' }], aria: 'Overnight heart rate' }));
  function title(k) { return k === 'hrv' ? 'HRV with baseline band' : 'Resting HR with baseline band'; }
}

// ============ STRESS & BODY BATTERY ============
export function stress(root, ctx) {
  const m = ctx.m; if (m.empty) return emptyState(root, ctx);
  const days = ctx.days; const has = k => days.some(d => valid(d[k]));
  if (!has('stress') && !has('bbHigh')) { root.innerHTML = card('Stress & Body Battery', '<p class="muted">No stress or Body Battery data in this range. They come from UDSFile_*.json (DI-Connect-Aggregator).</p>'); return; }
  const a = k => mean(days.map(d => d[k]));
  let html = `<div class="tiles">${tile('Avg stress', fmtNum(a('stress')), has('stress') ? `n=${days.filter(d => valid(d.stress)).length} days` : '')}${tile('BB high', fmtNum(a('bbHigh')), 'avg daily peak')}${tile('BB low', fmtNum(a('bbLow')), 'avg daily low')}
   ${tile('Charged', fmtNum(a('bbCharged')), 'avg / day')}${tile('Drained', fmtNum(a('bbDrained')), 'avg / day')}${tile('Net', valid(a('bbCharged')) && valid(a('bbDrained')) ? ((a('bbCharged') - a('bbDrained') >= 0 ? '+' : '−') + fmtNum(Math.abs(a('bbCharged') - a('bbDrained')))) : '–', 'charge − drain')}</div>`;
  if (has('stress')) html += card('Daily stress', `<div class="sub">Garmin’s 0–100 score from heart-rate variability: 0–25 rest, 26–50 low, 51–75 medium, 76+ high.</div>${legend([['c3', 'Daily'], ['c1', '7-day average']])}<div id="c-stress"></div>`);
  if (has('bbHigh')) html += card('Body Battery range', `<div class="sub">Highest and lowest level each day. A good recovery night pushes the high up; a big gap between high and low means a draining day.</div>${legend([['c2', 'Daily high'], ['c5', 'Daily low']])}<div id="c-bb"></div>`);
  if (has('bbCharged') && has('bbDrained')) html += card('Charge vs drain', `<div class="sub">Energy gained (mostly during sleep) vs spent each day.</div>${legend([['c2', 'Charged'], ['c5', 'Drained']])}<div id="c-cd"></div>`);
  root.innerHTML = html;
  slot(root, 'c-stress', lineChart({ series: [{ name: 'Stress', cls: 'c3', pts: pts(days, d => d.stress), thin: true, dots: true, fmt: v => fmtNum(v) }, { name: '7-day avg', cls: 'c1', pts: pts(days, d => d.ma7_stress), fmt: v => fmtNum(v, 1) }], refs: [{ y: 50, label: 'medium' }], aria: 'Daily stress' }));
  slot(root, 'c-bb', lineChart({ series: [{ name: 'High', cls: 'c2', pts: pts(days, d => d.bbHigh), fmt: v => fmtNum(v) }, { name: 'Low', cls: 'c5', pts: pts(days, d => d.bbLow), fmt: v => fmtNum(v) }], yMin: 0, yMax: 100, aria: 'Body Battery high and low' }));
  slot(root, 'c-cd', lineChart({ series: [{ name: 'Charged', cls: 'c2', pts: pts(days, d => d.bbCharged), fmt: v => fmtNum(v), thin: days.length > 60 }, { name: 'Drained', cls: 'c5', pts: pts(days, d => d.bbDrained), fmt: v => fmtNum(v), thin: days.length > 60 }], aria: 'Body Battery charged and drained' }));
}

// ============ ACTIVITY & TRAINING ============
let actFilter = 'all', actLimit = 25;
export function activity(root, ctx) {
  const m = ctx.m; if (m.empty) return emptyState(root, ctx);
  const days = ctx.days; const first = days[0].date;
  const acts = m.acts.filter(a => a.day >= first);
  if (!m.acts.length) { root.innerHTML = card('Activity & training', '<p class="muted">No activities found. Import summarizedActivities*.json or .fit files from your export.</p>'); return; }
  const types = [...new Set(acts.map(a => a.type))];
  const tot = { n: acts.length, sec: sum(acts.map(a => a.durationSec)), dist: sum(acts.map(a => a.distanceM)), load: sum(acts.map(a => a.trimp)) };
  let html = `<div class="tiles">${tile('Workouts', String(tot.n), esc(rangeLabel()))}${tile('Time', fmtDurSec(tot.sec).replace(/:\d\d$/, ''), 'h:mm')}${tile('Distance', S.settings.units === 'mi' ? fmtNum(tot.dist / 1609.344, 0) : fmtNum(tot.dist / 1000, 0), '', unitsLong())}</div>`;
  const hasLoad = days.some(d => d.trimp > 0);
  if (m.maxHrSource !== 'manual') html += `<p class="disclaimer">Max HR is ${m.maxHrSource === 'estimated' ? `<b>estimated at ${m.maxHr} bpm</b> from your highest sustained heart rate (99th percentile of ${fmtNum(m.maxHrEst.n)} ${esc(m.maxHrEst.unit)}). It usually sits a few beats under your true max.` : `<b>unknown</b>; ${m.maxHr} bpm is a placeholder.`} Zones and load depend on it: <a href="#/data">confirm or set it in Settings</a>.</p>`;
  html += card('Weekly volume', `<div class="sub">Hours of training by type</div><div id="legend-vol"></div><div id="c-vol"></div>`);
  if (hasLoad) {
    const lastD = latestWith(m, d => valid(d.acwr));
    html += card('Training load (approximate)', `<div class="sub">An approximate, heart-rate-based estimate (Banister TRIMP) that depends on your max and resting HR. Shown per day with 7-day (acute) and 28-day (chronic) exponentially-weighted averages. Workouts without HR are estimated at a moderate effort.</div>${legend([['c1', 'Daily load'], ['c3', 'Acute (7d)'], ['c4', 'Chronic (28d)']])}<div id="c-load"></div>
      <h3 class="mt12">Acute : chronic ratio ${lastD ? `<span class="badge ${lastD.acwr > ACWR_HIGH ? 'warn' : ''}">now ${lastD.acwr.toFixed(2)}</span>` : ''}</h3>
      <div class="sub">Compares recent load with what you’re used to. ${ACWR_LOW}–${ACWR_HIGH} is treated as balanced; above ${ACWR_HIGH} means load rose quickly, which is associated with more fatigue. Needs 4 weeks of workouts to be meaningful${lastD ? '' : ' (not enough yet)'}.</div><div id="c-acwr"></div>`);
  }
  const zs = [0, 0, 0, 0, 0]; let approxN = 0, zn = 0;
  for (const a of acts) { const z = zonesOfActivity(a, m.maxHr); if (z) { z.secs.forEach((s, i) => zs[i] += s); zn++; if (z.approx) approxN++; } }
  const zt = sum(zs);
  if (zt > 0) html += card('Time in heart-rate zones', `<div class="sub">% of max HR (${m.maxHr} bpm, ${m.maxHrSource}; change in Data → Settings). ${approxN ? `${approxN} of ${zn} workouts have no second-by-second data, so each was counted entirely in the zone of its average HR (approximate).` : `From second-by-second data of ${zn} workouts.`}</div><div class="zbar" id="zbar">${zs.map((s, i) => `<i class="fl-z${i + 1}" data-w="${s / zt * 100}"></i>`).join('')}</div>
    <table class="ztable">${ZONES.map((z, i) => `<tr><td><span class="rk fl-z${i + 1}"></span>${esc(z.name)}</td><td>${Math.round(z.lo * 100)}–${z.hi > 1 ? '100' : Math.round(z.hi * 100)}%</td><td>${fmtDurSec(zs[i]).replace(/:\d\d$/, '')} · ${Math.round(zs[i] / zt * 100)}%</td></tr>`).join('')}</table>`);
  const runs = acts.filter(a => ['running'].includes(a.type) && a.pace && a.durationSec >= 600 && a.distanceM >= 1500);
  if (runs.length >= 3) html += card('Running pace', `<div class="sub">Average pace per run (faster is higher on this chart) · n=${runs.length}</div><div id="c-pace"></div>`);
  const rides = acts.filter(a => a.type === 'cycling' && a.avgPower);
  if (rides.length >= 3) html += card('Cycling power', `<div class="sub">Average power per ride · n=${rides.length}</div><div id="c-pow"></div>`);
  html += `<section class="card"><h2>Activities</h2><div class="chips" id="chips"><button class="chip" aria-pressed="${actFilter === 'all'}" data-f="all">All (${acts.length})</button>${types.map(t => `<button class="chip" aria-pressed="${actFilter === t}" data-f="${t}">${esc(TYPE_NAME[t] || t)} (${acts.filter(a => a.type === t).length})</button>`).join('')}</div>
    <ul class="list" id="actlist"></ul><div id="more"></div></section>`;
  root.innerHTML = html;
  applyW(root);
  // weekly volume
  const buckets = days.length <= 14 ? days.map(d => ({ days: [d], ms: d.ms, start: d.date })) : weekly(days, w => w);
  const tset = [...new Set(acts.map(a => a.type))];
  const vb = buckets.map(b => ({ ms: b.ms, label: days.length <= 14 ? undefined : 'Week of ' + fmtDay(b.start), segs: tset.map(t => ({ v: sum(b.days.flatMap(d => d.acts.filter(a => a.type === t)).map(a => (a.durationSec || 0) / 3600)), cls: TYPE_CLS[t] || 'z1', name: TYPE_NAME[t] || t })) }));
  slot(root, 'c-vol', barChart({ bars: vb, step: days.length <= 14 ? DAY : 7 * DAY, valFmt: h => fmtDur(h * 60), segFmt: h => fmtDur(h * 60), yFmt: v => v + 'h', aria: 'Weekly training volume' }));
  const lg = root.querySelector('#legend-vol'); if (lg) lg.innerHTML = legend(tset.map(t => [TYPE_CLS[t], TYPE_NAME[t] || t]));
  if (hasLoad) {
    slot(root, 'c-load', barChart({ bars: days.map(d => ({ ms: d.ms, segs: [{ v: d.trimp, cls: 'c1', name: 'Load' }] })), lines: [{ name: 'Acute', cls: 'c3', pts: pts(days, d => d.acute) }, { name: 'Chronic', cls: 'c4', pts: pts(days, d => d.chronic) }], valFmt: v => fmtNum(v, 0), aria: 'Daily training load with acute and chronic averages' }));
    const ap = pts(days, d => d.acwr);
    slot(root, 'c-acwr', ap.length ? lineChart({ series: [{ name: 'ACWR', cls: 'c3', pts: ap, fmt: v => v.toFixed(2) }], band: { lo: ap.map(p => [p[0], ACWR_LOW]), hi: ap.map(p => [p[0], ACWR_HIGH]) }, yMin: 0, yMax: Math.max(2, ...ap.map(p => p[1])), refs: [{ y: ACWR_HIGH, label: String(ACWR_HIGH) }], aria: 'Acute to chronic load ratio' }) : (() => { const e = document.createElement('div'); e.className = 'empty-chart'; e.textContent = 'Needs at least 28 days after your first workout.'; return e; })());
  }
  if (runs.length >= 3) slot(root, 'c-pace', lineChart({ series: [{ name: 'Pace', cls: 'c1', pts: runs.map(a => [a.start, a.pace]), dots: true, fmt: v => fmtPace(v, S.settings.units), thin: false }], invert: true, yFmt: v => fmtPace(v, S.settings.units).replace('/' + S.settings.units, ''), gapMs: 60 * DAY, extraTip: t => '', tipDate: ms => fmtDay(dayKey(ms)), aria: 'Running pace per run' }));
  if (rides.length >= 3) slot(root, 'c-pow', lineChart({ series: [{ name: 'Avg power', cls: 'c3', pts: rides.map(a => [a.start, a.avgPower]), dots: true, fmt: v => Math.round(v) + ' W' }], gapMs: 60 * DAY, tipDate: ms => fmtDay(dayKey(ms)), aria: 'Cycling power per ride' }));
  const renderList = () => {
    const list = acts.filter(a => actFilter === 'all' || a.type === actFilter).slice().reverse();
    root.querySelector('#actlist').innerHTML = list.slice(0, actLimit).map(actRow).join('') || '<li class="muted pad10">No activities of this type in range.</li>';
    root.querySelector('#more').innerHTML = list.length > actLimit ? `<button class="btn secondary small" id="showmore">Show more (${list.length - actLimit})</button>` : '';
    const sm = root.querySelector('#showmore'); if (sm) sm.onclick = () => { actLimit += 25; renderList(); };
  };
  renderList();
  root.querySelector('#chips').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; actFilter = b.dataset.f; actLimit = 25; root.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.f === actFilter)); renderList(); });
}
export function applyW(root) { root.querySelectorAll('[data-w]').forEach(e => { e.style.width = e.dataset.w + '%'; }); }

export async function activityDetail(root, ctx, id) {
  const m = ctx.m; const a = m.acts.find(x => x.id === id);
  if (!a) { root.innerHTML = `<a class="back" href="#/activity">← Activities</a>` + card('Not found', '<p class="muted">That activity is not in your data.</p>'); return; }
  const series = a.hasSeries ? await getSeries(a.id) : null;
  const isRun = ['running', 'walking', 'hiking'].includes(a.type);
  let html = `<a class="back" href="#/activity">← Activities</a>
  <section class="card"><h2>${esc(a.name)}</h2><div class="sub">${esc(fmtDayLong(a.day))} · ${esc(TYPE_NAME[a.type] || a.type)}${a.demo ? ' · <b>demo data</b>' : ''}</div>
  <div class="tiles flush">${tile('Time', esc(fmtDurSec(a.durationSec)))}${tile('Distance', a.distanceM ? esc(distFmt(a.distanceM)) : '–')}${tile(isRun ? 'Pace' : 'Speed', isRun ? esc(fmtPace(a.pace, S.settings.units)) : a.speed ? fmtNum(a.speed * 3.6 / (S.settings.units === 'mi' ? 1.609344 : 1), 1) : '–', '', isRun ? '' : S.settings.units === 'mi' ? 'mph' : 'km/h')}
  ${tile('Avg HR', a.avgHr ? Math.round(a.avgHr) : '–', '', 'bpm')}${tile('Max HR', a.maxHr ? Math.round(a.maxHr) : '–', '', 'bpm')}${tile('Load (approx.)', Math.round(a.trimp), a.trimpEst ? 'estimated, no HR' : 'HR-based TRIMP')}
  ${a.avgPower ? tile('Avg power', Math.round(a.avgPower), '', 'W') : ''}${a.ascentM ? tile('Ascent', Math.round(a.ascentM), '', 'm') : ''}${a.calories ? tile('Calories', fmtNum(a.calories), '', 'kcal') : ''}</div></section>`;
  const z = zonesOfActivity(a, m.maxHr);
  if (z) { const t = sum(z.secs); html += card('Heart-rate zones', `<div class="zbar">${z.secs.map((s, i) => `<i class="fl-z${i + 1}" data-w="${s / t * 100}"></i>`).join('')}</div><table class="ztable">${ZONES.map((zz, i) => `<tr><td><span class="rk fl-z${i + 1}"></span>${esc(zz.name)}</td><td>${fmtDurSec(z.secs[i])}</td><td>${Math.round(z.secs[i] / t * 100)}%</td></tr>`).join('')}</table>${z.approx ? '<p class="sub">Approximate: only the average HR is known for this activity.</p>' : ''}`); }
  if (series) {
    html += card('Heart rate', '<div id="d-hr"></div>') + card(isRun ? 'Pace' : 'Speed', '<div id="d-spd"></div>');
    if (series.pwr) html += card('Power', '<div id="d-pwr"></div>');
    if (series.cad) html += card('Cadence', '<div id="d-cad"></div>');
    if (series.alt) html += card('Elevation', '<div id="d-alt"></div>');
    if (series.lat) html += card('Route', '<div id="d-route"></div><p class="sub">Drawn offline from the recorded GPS track; no map tiles are downloaded.</p>');
  } else html += card('Charts', `<p class="muted">This activity only has summary data (no second-by-second record), so there are no HR / pace charts. To get them, include the original <code>.fit</code> file: it is in the export under <code>DI_CONNECT/DI-Connect-Uploaded-Files</code> (a nested zip), or export a single activity as “Original” from Garmin Connect on the web.</p>`);
  root.innerHTML = html; applyW(root);
  if (!series) return;
  const T = series.t.map(t => t * 1000); const xf = ms => fmtDurSec(ms / 1000);
  const mk = (arr, f = v => v) => T.map((t, i) => [t, valid(arr[i]) ? f(arr[i]) : null]);
  const common = { xFmt: xf, tipDate: xf, gapMs: 1e9 };
  slot(root, 'd-hr', lineChart({ series: [{ name: 'HR', cls: 'c5', pts: mk(series.hr || []), fmt: v => Math.round(v) + ' bpm' }], refs: [0.6, 0.7, 0.8, 0.9].map(p => ({ y: Math.round(p * m.maxHr) })), ...common, aria: 'Heart rate during activity' }));
  if (series.spd) {
    if (isRun) slot(root, 'd-spd', lineChart({ series: [{ name: 'Pace', cls: 'c1', pts: mk(series.spd, v => v > 0.3 ? 1000 / v : null).map(p => [p[0], p[1] && p[1] < 1200 ? p[1] : null]), fmt: v => fmtPace(v, S.settings.units) }], invert: true, yFmt: v => fmtPace(v, S.settings.units).replace('/' + S.settings.units, ''), ...common, aria: 'Pace during activity' }));
    else slot(root, 'd-spd', lineChart({ series: [{ name: 'Speed', cls: 'c1', pts: mk(series.spd, v => v * 3.6 / (S.settings.units === 'mi' ? 1.609344 : 1)), fmt: v => v.toFixed(1) + (S.settings.units === 'mi' ? ' mph' : ' km/h') }], ...common, aria: 'Speed during activity' }));
  } else root.querySelector('#d-spd') && (root.querySelector('#d-spd').innerHTML = '<div class="empty-chart">No speed data</div>');
  if (series.pwr) slot(root, 'd-pwr', lineChart({ series: [{ name: 'Power', cls: 'c3', pts: mk(series.pwr), fmt: v => Math.round(v) + ' W' }], ...common, aria: 'Power during activity' }));
  if (series.cad) slot(root, 'd-cad', lineChart({ series: [{ name: 'Cadence', cls: 'c4', pts: mk(series.cad), fmt: v => Math.round(v) + ' rpm' }], ...common, aria: 'Cadence during activity' }));
  if (series.alt) slot(root, 'd-alt', lineChart({ series: [{ name: 'Elevation', cls: 'c6', pts: mk(series.alt), fmt: v => Math.round(v) + ' m', fill: true }], ...common, aria: 'Elevation during activity' }));
  if (series.lat) slot(root, 'd-route', routeMap(series.lat, series.lon));
}

// ============ INSIGHTS ============
export function insights(root, ctx) {
  const m = ctx.m; if (m.empty) return emptyState(root, ctx);
  const I = computeInsights(m, S.range);
  let html = `<p class="disclaimer"><b>Not medical advice.</b> These are statistical patterns in your own data. They show association, not cause, and can be wrong. Every insight shows how many days (n) it rests on, and is hidden when there isn’t enough data. With several comparisons, one may look significant by chance. If something worries you, talk to a clinician.</p>`;
  if (S.range && S.range < 30) html += `<p class="sub">Tip: you’re viewing ${S.range} days. Most insights need at least 14 matching days; try 90 days or more.</p>`;
  const W = I.weekly;
  if (W) html += card('Weekly summary', `<div class="sub">${esc(fmtDay(W.from))} – ${esc(fmtDay(W.to))} vs the 7 days before</div><table class="wk"><tr><th></th><th>This week</th><th>Last week</th></tr>${W.rows.map(r => { if (r.v == null) return `<tr><td>${esc(r.label)}</td><td colspan="2" class="muted">not enough data</td></tr>`; const good = r.goodUp == null || r.delta == null ? '' : ((r.delta > 0) === r.goodUp ? 'ok' : 'bad'); return `<tr><td>${esc(r.label)}</td><td><b>${esc(r.vtxt)}</b> ${r.delta != null && Math.abs(r.delta) > 1e-9 ? `<span class="${good}">${r.delta > 0 ? '▲' : '▼'}</span>` : ''}</td><td class="muted">${esc(r.ptxt || '–')}</td></tr>`; }).join('')}</table><p class="sub">Green/red arrows show whether the change is usually favourable. Averages need at least 3 days of data (n shown in tooltips of other views).</p>`);
  html += card('Suggestions', `<ul class="summary-list">${I.suggestions.map(s => `<li>${esc(s.text)} <span class="badge">${esc(s.basis)}</span></li>`).join('')}</ul>`);
  html += `<section class="card"><h2>Patterns in your data</h2><p class="sub">With several comparisons, one may look significant by chance; trust patterns that repeat across ranges more than a single result.</p>${I.cards.length ? '' : '<p class="muted">No pattern has enough data in this range yet.</p>'}<div id="cards">${I.cards.map((c, i) => `<div class="insight" data-i="${i}"><div class="ih"><h3>${esc(c.title)}</h3><span><span class="badge ${c.conf}">${c.conf === 'higher' ? 'higher' : c.conf} confidence</span> <span class="badge">n=${c.n}</span></span></div><p>${esc(c.text)}</p>
    ${c.bars ? `<div class="sub">${esc(c.barsLabel)}</div><div data-bars="${i}"></div>` : ''}${c.scatter ? `<details data-sc="${i}"><summary>Show chart</summary><div></div></details>` : ''}<details><summary>How this was computed</summary><p class="small muted">${esc(c.how)}</p></details></div>`).join('')}</div></section>`;
  html += card('Unusual readings (last 14 days)', I.anomalies.length ? `<ul class="summary-list">${I.anomalies.map(a => `<li><b>${esc(fmtDay(a.date))}</b>: ${esc(a.metric)} <b class="${a.dir === 'high' ? 'warnc' : 'warnc'}">${esc(a.value)}</b> (${a.dir}; baseline ${esc(a.base)}, z = ${a.z.toFixed(1)}, n=${a.n})</li>`).join('')}</ul><p class="sub">Flagged when a day sits 2 or more standard deviations from your trailing 60-day baseline (HRV on a log scale). About 1 in 20 normal days will trigger this by chance.</p>` : '<p class="muted">Nothing unusual against your 60-day baseline (needs 14+ prior days of a metric).</p>');
  if (I.strainRuns && I.strainRuns.length) html += card('Strain pattern', `<p class="small mt0">HRV well below and resting HR well above your norm together on 2+ consecutive days (${esc(I.strainRuns.map(r => r.map(d => fmtDay(d)).join(', ')).join('; '))}). This can accompany illness, poor sleep, alcohol, stress or heavy training. Not a diagnosis. Seek care for fever, chest pain, shortness of breath or fainting.</p>`);
  else if (I.watch && I.watch.length) html += card('Worth watching', `<p class="small mt0">On ${esc(I.watch.map(d => fmtDay(d)).join(', '))} HRV was well below and resting HR well above your norm on a single night. One night is not a signal on its own. Not a diagnosis. Seek care for fever, chest pain, shortness of breath or fainting.</p>`);
  html += card('Trends', `<table class="wk"><tr><th>Metric</th><th>Direction</th><th>n</th></tr>${I.trends.map(t => t.insufficient ? `<tr><td>${esc(t.label)}</td><td class="muted">not enough data</td><td>${t.n}</td></tr>` : `<tr><td>${esc(t.label)}</td><td>${t.sig ? `<b class="${t.good ? 'ok' : 'bad'}">${t.up ? '▲ rising' : '▼ falling'}</b> ${esc(Math.abs(t.slopeWeek).toFixed(t.dp === 0 ? 0 : 1))}${t.unit ? ' ' + esc(t.unit) : ''}/wk` : '<span class="muted">stable / no clear trend</span>'}</td><td>${t.n}</td></tr>`).join('')}</table><p class="sub">Linear trend over the selected range; “rising/falling” only when p &lt; 0.05 and |r| ≥ 0.2. Green = generally favourable.</p>`);
  if (I.insufficient.length) html += card('Not enough data yet', `<ul class="summary-list">${I.insufficient.map(c => `<li><b>${esc(c.title)}</b>: have n=${c.n}, need ${c.need}. <span class="muted">${esc(c.hint)}</span></li>`).join('')}</ul>`);
  root.innerHTML = html;
  root.querySelectorAll('[data-bars]').forEach(el => { const c = I.cards[+el.dataset.bars]; el.append(miniBars(c.bars, v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%')); });
  root.querySelectorAll('details[data-sc]').forEach(d => d.addEventListener('toggle', () => {
    if (!d.open || d.dataset.done) return; d.dataset.done = 1; const c = I.cards[+d.dataset.sc];
    d.querySelector('div').append(scatter({ pts: c.scatter.pts, xl: c.scatter.xl, yl: c.scatter.yl, fit: c.scatter.fit, aria: c.title + ' scatter plot' }));
  }));
}
