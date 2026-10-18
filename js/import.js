// Garmin data-export importer. Runs entirely in the browser; files never leave the device.
import { unzipSync } from '../vendor/fflate.js';
import { S, mergeDaily, upsertActivity, flush, wipe } from './state.js';
import { parseFit, fitToActivity, isFit } from './fit.js';
import { dayKey, tick } from './util.js';

const EXCLUDE = /customer-?service|di-connect-user|di-connect-content|social|ecommerce|garmin-?pay|di-connect-device|golf|account|contacts|messages|gcm-|ugc|e-commerce|payment|connections/i;
const MAX_JSON = 400e6, MAX_FIT_FILES = 5000;
const td = new TextDecoder('utf-8');

const num = v => { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; };
export function calDate(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'number' && v > 1e11) return dayKey(v);
  if (v && typeof v === 'object' && v.calendarDate) return calDate(v.calendarDate);
  return null;
}
function tsMs(v) { // Garmin GMT timestamps come as "2023-05-01T03:12:00.0" (no zone => UTC) or epoch ms
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v.replace(' ', 'T') + 'Z'); return isFinite(t) ? t : null; }
  return null;
}

function unwrap(j) {
  if (Array.isArray(j)) {
    const f = j[0];
    if (f && typeof f === 'object' && !Array.isArray(f)) {
      const ks = Object.keys(f);
      if (ks.length <= 3 && ks.every(k => Array.isArray(f[k])) && ks.some(k => f[k].length && typeof f[k][0] === 'object')) return j.flatMap(o => Object.values(o).filter(Array.isArray).flat());
    }
    return j;
  }
  if (j && typeof j === 'object') {
    const arrs = Object.values(j).filter(v => Array.isArray(v) && v.length && typeof v[0] === 'object');
    if (arrs.length) return arrs.flat();
    return [j];
  }
  return [];
}
function sniff(items) {
  const o = items.find(x => x && typeof x === 'object');
  if (!o) return null;
  if ('activityId' in o && ('startTimeGmt' in o || 'startTimeLocal' in o || 'beginTimestamp' in o)) return 'activities';
  if ('sleepStartTimestampGMT' in o || 'deepSleepSeconds' in o) return 'sleep';
  if (Array.isArray(o.metrics) && o.calendarDate) return 'health';
  if (('recoveryTime' in o && 'score' in o) || ('hrvWeeklyAverage' in o && ('score' in o || 'level' in o || 'recoveryTime' in o))) return 'readiness';
  if ('vo2MaxValue' in o) return 'vo2';
  if ('acuteTrainingLoad' in o || 'dailyTrainingLoadAcute' in o) return 'load';
  if (('lastNightAvg' in o || 'hrvWeeklyAverage' in o || 'weeklyAvg' in o) && o.calendarDate) return 'hrv';
  if ('totalSteps' in o || 'restingHeartRate' in o || 'averageStressLevel' in o || 'allDayStress' in o || 'totalAverageStressLevel' in o || 'bodyBattery' in o || 'bodyBatteryHighestValue' in o) return 'uds';
  return null;
}

// ---- JSON record handlers: each returns the number of useful records ----
function bbStat(o, type) {
  const l = o.bodyBattery && o.bodyBattery.bodyBatteryStatList;
  if (!Array.isArray(l)) return null;
  const x = l.find(s => s.bodyBatteryStatType === type); return x ? num(x.statsValue) : null;
}
// Stress: top-level averageStressLevel, else the nested allDayStress.aggregatorList (TOTAL / ASLEEP entries), else totalAverageStressLevel.
// Garmin uses 0 / negative numbers for "no data", so only positive values count.
export function stressOf(o) {
  const pos = v => { v = num(v); return v != null && v > 0 ? v : null; };
  const list = o.allDayStress && Array.isArray(o.allDayStress.aggregatorList) ? o.allDayStress.aggregatorList : [];
  const by = t => list.find(a => a && String(a.type || '').toUpperCase() === t);
  const tot = by('TOTAL'), asl = by('ASLEEP');
  return {
    avg: pos(o.averageStressLevel) ?? (tot ? pos(tot.averageStressLevel) : null) ?? pos(o.totalAverageStressLevel),
    max: pos(o.maxStressLevel) ?? (tot ? pos(tot.maxStressLevel) : null),
    asleep: asl ? pos(asl.averageStressLevel) : null
  };
}
function doUds(items, rep) {
  let n = 0;
  for (const o of items) {
    const date = calDate(o.calendarDate); if (!date) continue;
    const rhr = num(o.restingHeartRate);
    const st = stressOf(o);
    const rs = o.respiration && typeof o.respiration === 'object' ? o.respiration : {};
    const posn = v => { v = num(v); return v > 0 ? v : null; };
    const patch = {
      steps: num(o.totalSteps), rhr: rhr > 0 ? rhr : null, stress: st.avg, stressMax: st.max, sleepStress: st.asleep,
      spo2Day: posn(o.averageSpo2Value), spo2DayLow: posn(o.lowestSpo2Value), respDay: posn(o.avgWakingRespirationValue ?? rs.avgWakingRespirationValue),
      bbHigh: num(o.bodyBatteryHighestValue) ?? bbStat(o, 'HIGHEST'), bbLow: num(o.bodyBatteryLowestValue) ?? bbStat(o, 'LOWEST'),
      bbCharged: num(o.bodyBatteryChargedValue) ?? bbStat(o, 'CHARGED'), bbDrained: num(o.bodyBatteryDrainedValue) ?? bbStat(o, 'DRAINED'),
      bbWake: bbStat(o, 'SLEEPEND') ?? num(o.bodyBatteryAtWakeTime),
      intMod: num(o.moderateIntensityMinutes), intVig: num(o.vigorousIntensityMinutes),
      calories: num(o.totalKilocalories), distM: num(o.totalDistanceMeters), floors: num(o.floorsAscended), maxHr: num(o.maxHeartRate), minHr: num(o.minHeartRate)
    };
    if (Object.values(patch).every(v => v == null)) continue;
    mergeDaily(date, patch, 'uds'); n++; rep.dates.push(date);
  }
  return n;
}
const pos0 = v => { v = num(v); return v != null && v > 0 ? v : null; };
function doSleep(items, rep) {
  let n = 0;
  for (const o of items) {
    const date = calDate(o.calendarDate) || (tsMs(o.sleepEndTimestampGMT) ? dayKey(tsMs(o.sleepEndTimestampGMT)) : null); if (!date) continue;
    const deep = num(o.deepSleepSeconds), light = num(o.lightSleepSeconds), rem = num(o.remSleepSeconds), awake = num(o.awakeSleepSeconds);
    const st = tsMs(o.sleepStartTimestampGMT), en = tsMs(o.sleepEndTimestampGMT);
    let dur = (deep != null || light != null || rem != null) ? ((deep || 0) + (light || 0) + (rem || 0)) / 60 : (st && en ? (en - st) / 60000 - (awake || 0) / 60 : null);
    if (dur == null || dur < 20) continue;
    const prev = S.daily.get(date);
    if (prev && prev.sleepMin && prev.sleepMin > dur && prev.src && prev.src.includes('sleep')) continue; // keep the main sleep, not a nap
    const sc = o.sleepScores || {};
    const sp = o.spo2SleepSummary || o.spo2Summary || {};
    const spo2 = { avg: pos0(sp.averageSPO2 ?? sp.averageSpO2 ?? sp.avg), low: pos0(sp.lowestSPO2 ?? sp.lowest) };
    mergeDaily(date, {
      sleepMin: dur, deepMin: deep != null ? deep / 60 : null, lightMin: light != null ? light / 60 : null, remMin: rem != null ? rem / 60 : null,
      awakeMin: awake != null ? awake / 60 : null, sleepStart: st, sleepEnd: en,
      sleepScoreG: num(sc.overallScore) ?? num(o.sleepScore) ?? null, resp: num(o.averageRespiration), sleepStress: num(o.avgSleepStress),
      hrvSleep: num(o.avgOvernightHrv) > 0 ? num(o.avgOvernightHrv) : null, // fallback only: the model prefers health-status HRV
      sleepSpo2: spo2.avg, sleepSpo2Low: spo2.low, respLow: pos0(o.lowestRespiration), respHigh: pos0(o.highestRespiration)
    }, 'sleep'); n++; rep.dates.push(date);
  }
  return n;
}
function doHealth(items, rep) {
  let n = 0;
  for (const o of items) {
    const date = calDate(o.calendarDate); if (!date || !Array.isArray(o.metrics)) continue;
    const p = {};
    for (const m of o.metrics) {
      const v = num(m.value); if (v == null) continue;
      if (m.type === 'HRV') p.hrv = v; else if (m.type === 'HEART_RATE') p.ovnHr = v; else if (m.type === 'RESPIRATION') p.resp = v;
      else if (m.type === 'SPO2') p.spo2 = v; else if (m.type === 'SKIN_TEMP_C') p.skinTemp = v;
    }
    if (Object.keys(p).length) { mergeDaily(date, p, 'health'); n++; rep.dates.push(date); }
  }
  return n;
}
function doReadiness(items, rep) {
  let n = 0;
  for (const o of items) {
    const date = calDate(o.calendarDate || o.timestamp); const sc = num(o.score), wk = pos0(o.hrvWeeklyAverage);
    if (!date || (sc == null && wk == null)) continue;
    mergeDaily(date, { garminReadiness: sc, hrvWeekly: wk }, 'readiness'); n++; rep.dates.push(date);
  }
  return n;
}
function doVo2(items, rep) {
  let n = 0;
  for (const o of items) { const date = calDate(o.calendarDate); const v = num(o.vo2MaxValue); if (!date || !v) continue; mergeDaily(date, { vo2max: v }, 'vo2'); n++; rep.dates.push(date); }
  return n;
}
function doLoad(items, rep) {
  let n = 0;
  for (const o of items) { const date = calDate(o.calendarDate); const v = num(o.acuteTrainingLoad ?? o.dailyTrainingLoadAcute); if (!date || v == null) continue; mergeDaily(date, { garminAcute: v }, 'load'); n++; rep.dates.push(date); }
  return n;
}
function doHrv(items, rep) {
  let n = 0;
  for (const o of items) { const date = calDate(o.calendarDate); const v = pos0(o.lastNightAvg ?? o.lastNight ?? o.hrvValue), wk = pos0(o.hrvWeeklyAverage ?? o.weeklyAvg); if (!date || (v == null && wk == null)) continue; mergeDaily(date, { hrv: v, hrvWeekly: wk }, 'hrv'); n++; rep.dates.push(date); }
  return n;
}

export function typeGroup(raw) {
  const t = String(raw || '').toLowerCase();
  if (/run|trail/.test(t)) return 'running';
  if (/cycl|bik|ride|spin/.test(t)) return 'cycling';
  if (/walk/.test(t)) return 'walking';
  if (/hik/.test(t)) return 'hiking';
  if (/swim/.test(t)) return 'swimming';
  if (/strength|weight|training|gym/.test(t)) return 'strength';
  if (/row/.test(t)) return 'rowing';
  return 'other';
}
function doActivities(items, rep) {
  let n = 0;
  for (const o of items) {
    if (o.activityId == null) continue;
    const start = tsMs(o.startTimeGmt ?? o.beginTimestamp); if (!start) continue;
    const raw = typeof o.activityType === 'string' ? o.activityType : (o.activityType && o.activityType.typeKey) || o.sportType || '';
    const type = typeGroup(raw);
    const dur = num(o.duration), dist = num(o.distance);
    // Unit sanity: current exports use milliseconds for duration and centimetres for distance. Pick the first
    // (duration, distance) interpretation that gives a physically plausible average speed (0.1-45 m/s).
    let durSec = dur != null ? dur / 1000 : null, distM = dist, scale = 0.01;
    if (dist != null && dist > 0 && dur) {
      let hit = false;
      for (const [ds, sc] of [[dur / 1000, 0.01], [dur / 1000, 1], [dur, 0.01], [dur, 1]]) {
        const sp = dist * sc / ds;
        if (sp >= 0.1 && sp <= 45) { durSec = ds; distM = dist * sc; scale = sc; hit = true; break; }
      }
      if (!hit) { distM = dist * 0.01; }
    } else if (dist != null) distM = dist * 0.01;
    const act = {
      id: 'g' + o.activityId, source: 'summary', start, startLocal: num(o.startTimeLocal), type, rawType: raw || null,
      name: String(o.name || raw || 'Activity').slice(0, 80), durationSec: durSec, distanceM: distM,
      avgHr: num(o.avgHr) > 0 ? num(o.avgHr) : null, maxHr: num(o.maxHr) > 0 ? num(o.maxHr) : null,
      calories: num(o.calories), avgPower: num(o.avgPower) || null, normPower: num(o.normPower) || null,
      ascentM: num(o.elevationGain) != null ? num(o.elevationGain) * scale : null,
      te: num(o.aerobicTrainingEffect), garminLoad: num(o.activityTrainingLoad), vo2: num(o.vO2MaxValue) || null,
      cadence: num(o.avgRunCadence ?? o.avgBikeCadence) || null
    };
    upsertActivity(act, null); n++;
    rep.dates.push(dayKey(start));
  }
  return n;
}

// ---------- CSV ----------
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}
const parseHms = s => { if (!s) return null; const p = String(s).split(':').map(Number); if (p.some(isNaN)) return null; return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : null; };
const numC = s => { if (s == null) return null; const t = String(s).replace(/,/g, '').trim(); return t && t !== '--' && isFinite(+t) ? +t : null; };
function doCsv(text, rep, fname) {
  const rows = parseCsv(text); if (rows.length < 2) return null;
  const head = rows[0].map(h => h.trim().toLowerCase()); const idx = k => head.indexOf(k);
  const get = (r, k) => { const i = idx(k); return i >= 0 ? r[i] : null; };
  let n = 0;
  if (head.includes('start_iso')) { // PulseLab's own activities.csv
    for (const r of rows.slice(1)) {
      const start = Date.parse(get(r, 'start_iso')); if (!start) continue;
      upsertActivity({ id: get(r, 'id') || 'c' + start, source: 'csv', start, type: typeGroup(get(r, 'type')), name: get(r, 'name') || 'Activity', durationSec: numC(get(r, 'duration_s')), distanceM: numC(get(r, 'distance_m')), avgHr: numC(get(r, 'avg_hr')), maxHr: numC(get(r, 'max_hr')), avgPower: numC(get(r, 'avg_power')), calories: numC(get(r, 'calories')), ascentM: numC(get(r, 'ascent_m')) }, null);
      rep.dates.push(dayKey(start)); n++;
    }
    return { kind: 'csvActs', n };
  }
  if (idx('activity type') >= 0 && idx('date') >= 0) { // Garmin Connect "Export CSV" on the activities page
    for (const r of rows.slice(1)) {
      const ds = get(r, 'date'); const t = Date.parse(String(ds).replace(' ', 'T')); if (!t) continue;
      const dur = parseHms(get(r, 'time') || get(r, 'elapsed time'));
      let d = numC(get(r, 'distance')); // km or mi depending on the account's settings; assumed km
      upsertActivity({ id: 'v' + t, source: 'csv', start: t, startLocal: t - new Date(t).getTimezoneOffset() * 60000, type: typeGroup(get(r, 'activity type')), rawType: get(r, 'activity type'), name: (get(r, 'title') || 'Activity').slice(0, 80), durationSec: dur, distanceM: d != null ? d * 1000 : null, avgHr: numC(get(r, 'avg hr')), maxHr: numC(get(r, 'max hr')), calories: numC(get(r, 'calories')), avgPower: numC(get(r, 'avg power')), ascentM: numC(get(r, 'total ascent')) }, null);
      rep.dates.push(dayKey(t)); n++;
    }
    if (n) rep.notes.push('Activities CSV: distances assumed to be kilometres (Garmin CSV does not state the unit).');
    return { kind: 'csvActs', n };
  }
  if (idx('date') >= 0) { // PulseLab daily.csv / generic daily table
    const map = { steps: 'steps', rhr: 'rhr', hrv: 'hrv', sleep_min: 'sleepMin', deep_min: 'deepMin', light_min: 'lightMin', rem_min: 'remMin', awake_min: 'awakeMin', stress: 'stress', bb_high: 'bbHigh', bb_low: 'bbLow', bb_charged: 'bbCharged', bb_drained: 'bbDrained', intensity_mod: 'intMod', intensity_vig: 'intVig', vo2max: 'vo2max', sleep_start: 'sleepStart', sleep_end: 'sleepEnd' };
    if (!Object.keys(map).some(k => idx(k) >= 0)) return null;
    for (const r of rows.slice(1)) {
      const date = calDate(get(r, 'date')); if (!date) continue; const p = {};
      for (const [k, f] of Object.entries(map)) if (idx(k) >= 0) { const v = get(r, k); p[f] = (f === 'sleepStart' || f === 'sleepEnd') ? (Date.parse(v) || null) : numC(v); }
      mergeDaily(date, p, 'csv'); rep.dates.push(date); n++;
    }
    return { kind: 'csvDaily', n };
  }
  return null;
}

// ---------- routing ----------
function handleJson(u8, name, rep) {
  if (u8.length > MAX_JSON) { rep.skipped.push(name + ' (too large)'); return; }
  let j; try { j = JSON.parse(td.decode(u8)); } catch (e) { rep.skipped.push(name + ' (not valid JSON)'); return; }
  const items = unwrap(j); const kind = sniff(items);
  if (!kind) { rep.ignored++; return; }
  const fn = { uds: doUds, sleep: doSleep, health: doHealth, readiness: doReadiness, vo2: doVo2, load: doLoad, hrv: doHrv, activities: doActivities }[kind];
  const n = fn(items, rep);
  rep.found[kind] = (rep.found[kind] || 0) + n; rep.fileCounts[kind] = (rep.fileCounts[kind] || 0) + 1;
}
function handleFit(u8, name, rep) {
  if (rep.fitSeen >= MAX_FIT_FILES) { rep.fitSkipped++; return; }
  rep.fitSeen++;
  try {
    const p = parseFit(u8);
    const r = fitToActivity(p, S.settings.restHrOverride || 60, S.settings.maxHr || 190);
    if (!r || !r.act.start || r.act.durationSec < 30) { rep.ignored++; return; } // non-activity FIT (monitoring, settings…)
    r.act.startLocal = null;
    upsertActivity(r.act, r.series);
    rep.found.fit = (rep.found.fit || 0) + 1; rep.dates.push(dayKey(r.act.start));
  } catch (e) { rep.skipped.push(name + ' (FIT: ' + e.message + ')'); }
}

async function handleZip(u8, name, rep, depth, onProgress) {
  const entries = [];
  try { unzipSync(u8, { filter: f => { entries.push({ name: f.name, size: f.originalSize }); return false; } }); }
  catch (e) { rep.skipped.push(name + ' (not a readable zip: ' + e.message + ')'); return; }
  rep.zips++;
  const want = entries.filter(e => !e.name.endsWith('/') && !EXCLUDE.test(e.name) && e.size <= MAX_JSON &&
    (/\.(json|fit|csv)$/i.test(e.name) || (depth === 0 && /\.zip$/i.test(e.name))));
  rep.zipEntries += entries.length; rep.excluded += entries.filter(e => !e.name.endsWith('/') && EXCLUDE.test(e.name)).length;
  for (let i = 0; i < want.length; i += 25) {
    const batch = new Set(want.slice(i, i + 25).map(e => e.name));
    let out; try { out = unzipSync(u8, { filter: f => batch.has(f.name) }); } catch (e) { rep.skipped.push(name + ' (read error: ' + e.message + ')'); continue; }
    for (const [fn, data] of Object.entries(out)) await routeFile(data, fn, rep, depth, onProgress);
    onProgress && onProgress(name + ': ' + Math.min(i + 25, want.length) + '/' + want.length + ' files', null);
    await tick();
  }
}
async function routeFile(u8, name, rep, depth, onProgress) {
  const low = name.toLowerCase(); rep.files++;
  if (low.endsWith('.zip')) return handleZip(u8, name, rep, depth + 1, onProgress);
  if (low.endsWith('.json')) return handleJson(u8, name, rep);
  if (low.endsWith('.fit') || isFit(u8)) return handleFit(u8, name, rep);
  if (low.endsWith('.csv')) { const r = doCsv(td.decode(u8), rep, name); if (r && r.n) { rep.found[r.kind] = (rep.found[r.kind] || 0) + r.n; } else rep.ignored++; return; }
  rep.ignored++;
}

export function ingestJson(u8, name, rep) { return handleJson(u8, name, rep); } // used by unit tests

// How much HRV the whole dataset holds, by source (nightly health-status/HRV records, sleep-file average, coarse weekly average).
export function hrvInventory() {
  const c = { nightly: 0, sleep: 0, weekly: 0 };
  for (const d of S.daily.values()) { if (d.hrv > 0) c.nightly++; else if (d.hrvSleep > 0) c.sleep++; if (d.hrvWeekly > 0) c.weekly++; }
  return c;
}

export async function importFiles(fileList, onProgress) {
  const rep = { excluded: 0, files: 0, zips: 0, zipEntries: 0, found: {}, fileCounts: {}, ignored: 0, skipped: [], notes: [], dates: [], fitSeen: 0, fitSkipped: 0 };
  const wasDemo = S.meta.demo;
  if (wasDemo) { await wipe(true); rep.notes.push('Demo data was removed before importing your real data.'); }
  const files = [...fileList];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress && onProgress('Reading ' + f.name + ' (' + (i + 1) + '/' + files.length + ')…', i / files.length);
    await tick();
    try {
      const u8 = new Uint8Array(await f.arrayBuffer());
      const name = f.name || 'file';
      if (/\.zip$/i.test(name) || (u8[0] === 0x50 && u8[1] === 0x4B)) await handleZip(u8, name, rep, 0, onProgress);
      else await routeFile(u8, name, rep, 0, onProgress);
    } catch (e) { rep.skipped.push(f.name + ' (' + (e && e.message || e) + ')'); }
  }
  if (rep.fitSkipped) rep.notes.push(rep.fitSkipped + ' FIT files beyond the ' + MAX_FIT_FILES + ' file limit were skipped.');
  const total = Object.values(rep.found).reduce((a, b) => a + b, 0);
  const ds = rep.dates.sort();
  rep.range = ds.length ? { from: ds[0], to: ds[ds.length - 1] } : null;
  rep.total = total; rep.at = Date.now(); rep.dates = undefined; rep.hrv = hrvInventory();
  S.meta.demo = false;
  S.meta.imports = [...(S.meta.imports || []).slice(-9), { at: rep.at, files: files.map(f => f.name).slice(0, 5), found: rep.found, range: rep.range }];
  onProgress && onProgress('Saving…', 0.97);
  await flush();
  return rep;
}
