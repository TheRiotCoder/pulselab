// Minimal FIT (Garmin Flexible & Interoperable Data Transfer) parser.
// Extracts the activity "record" messages (time, HR, speed, power, cadence, altitude, GPS)
// and the "session" summary. Everything else is skipped safely.
const FIT_EPOCH = 631065600000; // 1989-12-31T00:00:00Z in ms
const TYPES = { // base type -> [size, reader]
  0x00: [1, 'u8'], 0x01: [1, 's8'], 0x02: [1, 'u8'], 0x83: [2, 's16'], 0x84: [2, 'u16'], 0x85: [4, 's32'], 0x86: [4, 'u32'],
  0x07: [1, 'str'], 0x88: [4, 'f32'], 0x89: [8, 'f64'], 0x0A: [1, 'u8'], 0x8B: [2, 'u16'], 0x8C: [4, 'u32'], 0x0D: [1, 'bytes'],
  0x8E: [8, 'bytes'], 0x8F: [8, 'bytes'], 0x90: [8, 'bytes']
};
const INVALID = { u8: 0xFF, s8: 0x7F, s16: 0x7FFF, u16: 0xFFFF, s32: 0x7FFFFFFF, u32: 0xFFFFFFFF };
const SPORTS = { 0: 'other', 1: 'running', 2: 'cycling', 5: 'swimming', 10: 'strength_training', 11: 'walking', 17: 'hiking', 4: 'fitness_equipment', 13: 'snowboarding', 12: 'cross_country_skiing', 15: 'rowing' };

export function isFit(u8) {
  return u8.length >= 14 && u8[8] === 0x2E && u8[9] === 0x46 && u8[10] === 0x49 && u8[11] === 0x54; // ".FIT"
}

function readVal(dv, off, kind, size, little) {
  switch (kind) {
    case 'u8': return dv.getUint8(off);
    case 's8': return dv.getInt8(off);
    case 'u16': return dv.getUint16(off, little);
    case 's16': return dv.getInt16(off, little);
    case 'u32': return dv.getUint32(off, little);
    case 's32': return dv.getInt32(off, little);
    case 'f32': return dv.getFloat32(off, little);
    case 'f64': return dv.getFloat64(off, little);
    default: return null;
  }
}

export function parseFit(u8) {
  if (!isFit(u8)) throw new Error('not a FIT file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hdr = u8[0];
  const dataSize = dv.getUint32(4, true);
  let pos = hdr; const end = Math.min(u8.length, hdr + dataSize);
  const defs = {}; // local type -> def
  const records = []; let session = null; let lastTs = 0; const sessions = [];
  let guard = 0;
  while (pos < end && guard++ < 5e7) {
    const h = u8[pos++];
    let local, isDef = false, hasDev = false, compressed = false, tsOffset = 0;
    if (h & 0x80) { compressed = true; local = (h >> 5) & 3; tsOffset = h & 0x1F; }
    else { local = h & 0x0F; isDef = !!(h & 0x40); hasDev = !!(h & 0x20); }
    if (isDef) {
      pos++; // reserved
      const little = u8[pos++] === 0; const gnum = dv.getUint16(pos, little); pos += 2;
      const nf = u8[pos++]; const fields = [];
      for (let i = 0; i < nf; i++) { fields.push({ num: u8[pos], size: u8[pos + 1], base: u8[pos + 2] }); pos += 3; }
      let devSize = 0;
      if (hasDev) { const nd = u8[pos++]; for (let i = 0; i < nd; i++) { devSize += u8[pos + 1]; pos += 3; } }
      defs[local] = { little, gnum, fields, devSize };
      continue;
    }
    const def = defs[local]; if (!def) throw new Error('FIT data before definition');
    const msg = {};
    for (const f of def.fields) {
      const t = TYPES[f.base] || TYPES[f.base & 0x1F | 0x80] || [1, 'bytes'];
      const kind = t[1];
      if (kind === 'bytes' || kind === 'str' || f.size !== t[0]) { pos += f.size; continue; } // skip arrays/strings
      let v = readVal(dv, pos, kind, f.size, def.little); pos += f.size;
      if (INVALID[kind] !== undefined && v === INVALID[kind]) continue;
      msg[f.num] = v;
    }
    pos += def.devSize;
    if (compressed) {
      let ts = (lastTs & ~0x1F) + tsOffset; if (tsOffset < (lastTs & 0x1F)) ts += 0x20; lastTs = ts; msg[253] = ts;
    } else if (msg[253] !== undefined) lastTs = msg[253];
    if (def.gnum === 20) records.push(msg);
    else if (def.gnum === 18) sessions.push(msg);
  }
  session = sessions[0] || null;
  return { records, session, sessions };
}

// Convert raw parse into app activity + downsampled series. Returns null if no usable records.
export function fitToActivity(parsed, rest = 60, maxHr = 190) {
  const recs = parsed.records.filter(r => r[253] !== undefined);
  if (recs.length < 5 && !parsed.session) return null;
  const s = parsed.session || {};
  const t0 = recs.length ? recs[0][253] : s[2];
  if (t0 == null) return null;
  const start = FIT_EPOCH + t0 * 1000;
  const n = recs.length;
  const arr = { t: [], hr: [], spd: [], pwr: [], cad: [], alt: [], lat: [], lon: [] };
  const hrHist = {};
  let hrSum = 0, hrN = 0, hrMax = 0, pSum = 0, pN = 0, dist = 0, ascent = 0, prevAlt = null, spdSum = 0, spdN = 0;
  const SC = 180 / 2147483648;
  for (let i = 0; i < n; i++) {
    const r = recs[i];
    const dt = i < n - 1 ? Math.min(30, Math.max(0, recs[i + 1][253] - r[253])) : 1;
    const hr = r[3], spd = r[73] != null ? r[73] / 1000 : r[6] != null ? r[6] / 1000 : null,
      pw = r[7], cad = r[4], alt = r[78] != null ? r[78] / 5 - 500 : r[2] != null ? r[2] / 5 - 500 : null;
    if (hr) { hrSum += hr; hrN++; if (hr > hrMax) hrMax = hr; hrHist[hr] = (hrHist[hr] || 0) + dt; }
    if (pw != null) { pSum += pw; pN++; }
    if (spd != null) { spdSum += spd; spdN++; }
    if (r[5] != null) dist = r[5] / 100;
    if (alt != null) { if (prevAlt != null && alt - prevAlt > 0.5) ascent += alt - prevAlt; prevAlt = alt; }
  }
  const stride = Math.max(1, Math.ceil(n / 500));
  for (let i = 0; i < n; i += stride) {
    // average within each stride window for smooth downsample of noisy signals
    const w = recs.slice(i, i + stride);
    const avg = (key, f = x => x) => { const v = w.map(q => q[key]).filter(x => x != null); return v.length ? f(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    arr.t.push(recs[i][253] - t0);
    arr.hr.push(avg(3) != null ? Math.round(avg(3)) : null);
    const sp = avg(73) ?? avg(6); arr.spd.push(sp != null ? Math.round(sp) / 1000 : null);
    arr.pwr.push(avg(7) != null ? Math.round(avg(7)) : null);
    arr.cad.push(avg(4) != null ? Math.round(avg(4)) : null);
    const al = avg(78) ?? avg(2); arr.alt.push(al != null ? Math.round((al / 5 - 500) * 10) / 10 : null);
    const la = avg(0), lo = avg(1);
    arr.lat.push(la != null ? Math.round(la * SC * 1e5) / 1e5 : null); arr.lon.push(lo != null ? Math.round(lo * SC * 1e5) / 1e5 : null);
  }
  for (const k of Object.keys(arr)) if (k !== 't' && arr[k].every(v => v == null)) delete arr[k];
  const dur = s[8] != null ? s[8] / 1000 : n ? recs[n - 1][253] - t0 : null;
  const totalDist = s[9] != null ? s[9] / 100 : dist || null;
  const act = {
    id: 'fit-' + start, source: 'fit', start, type: SPORTS[s[5]] || (totalDist && dur && totalDist / dur > 6 ? 'cycling' : totalDist ? 'running' : 'other'),
    name: 'Activity ' + new Date(start).toISOString().slice(0, 10),
    durationSec: dur, distanceM: totalDist,
    avgHr: s[16] ?? (hrN ? hrSum / hrN : null), maxHr: s[17] ?? (hrMax || null),
    avgPower: s[20] ?? (pN ? pSum / pN : null), calories: s[11] ?? null, ascentM: s[22] ?? (ascent || null),
    hrHist: hrN ? hrHist : null, hasSeries: true
  };
  return { act, series: arr };
}
export const FIT_EPOCH_MS = FIT_EPOCH;
