// In-memory app state, mirrored to IndexedDB.
import * as db from './db.js';
import { dayKey } from './util.js';

export const DEFAULTS = { settingsVer: 2, maxHr: null /* null = auto-estimate */, maxHrConfirmed: false, restHrOverride: null, sleepNeedH: 7.5, sex: 'm', units: 'km', theme: 'auto' };
export const S = {
  daily: new Map(),     // date -> day record
  acts: new Map(),      // id -> activity
  settings: { ...DEFAULTS },
  meta: { demo: false, imports: [] },
  range: 90,
  seriesCache: new Map(),
  dirtyDaily: new Set(), dirtyActs: new Set(), dirtySeries: new Map(), deletedActs: new Set(),
  version: 0 // bumps on any data change; analysis caches key off it
};

export async function loadAll() {
  const [daily, acts, settings, meta, range] = await Promise.all([
    db.getAll('daily'), db.getAll('activities'), db.getMeta('settings'), db.getMeta('info'), db.getMeta('range')]);
  S.daily = new Map(daily.map(d => [d.date, d]));
  S.acts = new Map(acts.map(a => [a.id, a]));
  S.settings = { ...DEFAULTS, ...(settings || {}) };
  if (!settings || settings.settingsVer !== 2) { // v1 stored the default 190 as if the user had chosen it
    if (S.settings.maxHr === 190) S.settings.maxHr = null;
    S.settings.settingsVer = 2;
  }
  S.meta = { demo: false, imports: [], ...(meta || {}) };
  if (range) S.range = range;
  S.version++;
}
export async function saveSettings() { await db.setMeta('settings', S.settings); S.version++; }
export async function saveMeta() { await db.setMeta('info', S.meta); }
export async function saveRange() { await db.setMeta('range', S.range); }

export async function flush() {
  const dd = [...S.dirtyDaily].map(k => S.daily.get(k)).filter(Boolean);
  const aa = [...S.dirtyActs].map(k => S.acts.get(k)).filter(Boolean);
  const ss = [...S.dirtySeries].map(([id, s]) => ({ id, ...s }));
  await db.putMany('daily', dd); await db.putMany('activities', aa); await db.putMany('series', ss);
  await db.deleteKeys('activities', [...S.deletedActs]); await db.deleteKeys('series', [...S.deletedActs]);
  await saveMeta();
  S.dirtyDaily.clear(); S.dirtyActs.clear(); S.dirtySeries.clear(); S.deletedActs.clear();
  S.version++;
}

// Cumulative daily counters: a later duplicate record (Garmin files overlap) must never lower them, in particular a later 0 must not erase an earlier real value.
const CUMULATIVE = new Set(['steps', 'calories', 'distM', 'floors', 'intMod', 'intVig']);
export function mergeDaily(date, patch, src, demo = false) {
  let d = S.daily.get(date);
  if (!d) { d = { date }; S.daily.set(date, d); }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) continue;
    if (CUMULATIVE.has(k) && typeof v === 'number' && typeof d[k] === 'number' && d[k] > 0 && v < d[k]) continue;
    d[k] = v;
  }
  if (src) { d.src = d.src || []; if (!d.src.includes(src)) d.src.push(src); }
  if (demo) d.demo = true; else if (d.demo) delete d.demo;
  S.dirtyDaily.add(date);
  return d;
}

// Activity day = local calendar day (startLocal is "local wall-clock as epoch ms", as Garmin exports it)
export function actDay(a) { return a.startLocal != null ? new Date(a.startLocal).toISOString().slice(0, 10) : dayKey(a.start); }

export function upsertActivity(act, series, demo = false) {
  // dedupe by start time (FIT file vs summarized export of the same workout); the first id is kept
  let existing = S.acts.get(act.id);
  if (!existing) for (const a of S.acts.values()) if (Math.abs(a.start - act.start) < 120000) { existing = a; break; }
  if (existing) {
    const merged = { ...existing };
    const fromFit = act.source === 'fit';
    for (const [k, v] of Object.entries(act)) {
      if (v == null || k === 'id') continue;
      if (merged[k] == null || !fromFit) merged[k] = v;
    }
    if (fromFit && existing.source !== 'fit') merged.name = existing.name;
    if (series || existing.hasSeries) merged.hasSeries = true;
    act = merged;
  }
  act.day = actDay(act);
  if (demo) act.demo = true; else delete act.demo;
  S.acts.set(act.id, act); S.dirtyActs.add(act.id);
  if (series) { S.dirtySeries.set(act.id, series); S.seriesCache.set(act.id, series); }
  S.version++;
  return act;
}

export async function getSeries(id) {
  if (S.seriesCache.has(id)) return S.seriesCache.get(id);
  const r = await db.get('series', id); if (r) S.seriesCache.set(id, r); return r || null;
}

export function hasData() { return S.daily.size > 0 || S.acts.size > 0; }

export async function wipe(onlyDemo = false) {
  if (onlyDemo) {
    const dd = [...S.daily.values()].filter(d => d.demo).map(d => d.date);
    const aa = [...S.acts.values()].filter(a => a.demo).map(a => a.id);
    for (const k of dd) S.daily.delete(k);
    for (const k of aa) S.acts.delete(k);
    await db.deleteKeys('daily', dd); await db.deleteKeys('activities', aa); await db.deleteKeys('series', aa);
    S.meta.demo = false; await saveMeta();
  } else {
    await db.clearStores(['daily', 'activities', 'series', 'meta']);
    S.daily = new Map(); S.acts = new Map(); S.settings = { ...DEFAULTS }; S.meta = { demo: false, imports: [] }; S.range = 90;
  }
  S.seriesCache.clear(); S.dirtyDaily.clear(); S.dirtyActs.clear(); S.dirtySeries.clear(); S.deletedActs.clear();
  S.version++;
}
