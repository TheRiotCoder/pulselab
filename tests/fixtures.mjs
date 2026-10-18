// Builds a synthetic Garmin-style export zip (+ a FIT file) for tests. Layout mirrors the real export.
import { zipSync, strToU8 } from '../vendor/fflate.js';

const FIT_EPOCH = 631065600;
function crc16(bytes) {
  const t = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  let crc = 0;
  for (const b of bytes) {
    let tmp = t[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ tmp ^ t[b & 0xF];
    tmp = t[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ tmp ^ t[(b >> 4) & 0xF];
  }
  return crc;
}
// Minimal FIT encoder: record (20) + session (18) messages, little endian
export function buildFit({ startEpochMs, seconds = 600, sport = 1, baseHr = 140 }) {
  const body = [];
  const u16 = v => [v & 255, (v >> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const s32 = v => u32(v >>> 0);
  // definition: record, local 0
  const recFields = [[253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [5, 4, 0x86], [3, 1, 0x02], [4, 1, 0x02], [6, 2, 0x84], [7, 2, 0x84], [2, 2, 0x84]];
  body.push(0x40, 0, 0, ...u16(20), recFields.length); for (const f of recFields) body.push(...f);
  const t0 = Math.round(startEpochMs / 1000) - FIT_EPOCH; let dist = 0;
  const SC = 2147483648 / 180;
  for (let i = 0; i < seconds; i++) {
    const hr = Math.round(baseHr + 15 * Math.sin(i / 60)); const spd = 3.0 + 0.3 * Math.sin(i / 90); dist += spd;
    body.push(0x00, ...u32(t0 + i), ...s32(Math.round((41.0 + i * 1e-5) * SC)), ...s32(Math.round((-87.0 + i * 1e-5) * SC)), ...u32(Math.round(dist * 100)), hr, 80 + (i % 5), ...u16(Math.round(spd * 1000)), ...u16(0xFFFF), ...u16(Math.round((100 + 5 * Math.sin(i / 50) + 500) * 5)));
  }
  const sesFields = [[253, 4, 0x86], [2, 4, 0x86], [7, 4, 0x86], [8, 4, 0x86], [9, 4, 0x86], [5, 1, 0x00], [16, 1, 0x02], [17, 1, 0x02]];
  body.push(0x41, 0, 0, ...u16(18), sesFields.length); for (const f of sesFields) body.push(...f);
  body.push(0x01, ...u32(t0 + seconds), ...u32(t0), ...u32(seconds * 1000), ...u32(seconds * 1000), ...u32(Math.round(dist * 100)), sport, baseHr, baseHr + 15);
  const hdr = [14, 0x20, ...u16(2100), ...u32(body.length), 0x2E, 0x46, 0x49, 0x54, 0, 0];
  const all = [...hdr, ...body]; const c = crc16(body);
  return new Uint8Array([...all, ...u16(c)]);
}

// Deterministic data: 120 days ending 2026-10-10
export function buildExport(opts = {}) {
  const N = 120, endKey = '2026-10-10';
  const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return dt.toISOString().slice(0, 10); };
  const days = [...Array(N)].map((_, i) => addDays(endKey, -(N - 1 - i)));
  const sleep = [], uds = [], health = [], readiness = [], vo2 = [], load = [];
  days.forEach((d, i) => {
    const h = 7 + 0.8 * Math.sin(i / 5);
    const deep = h * 3600 * 0.17, rem = h * 3600 * 0.22, light = h * 3600 - deep - rem;
    const endMs = Date.parse(d + 'T07:00:00Z'), startMs = endMs - (h * 3600 + 1500) * 1000;
    sleep.push({ sleepStartTimestampGMT: new Date(startMs).toISOString().replace('Z', '').replace(/\.\d+$/, '.0'), sleepEndTimestampGMT: new Date(endMs).toISOString().replace('Z', '').replace(/\.\d+$/, '.0'), calendarDate: d, deepSleepSeconds: Math.round(deep), lightSleepSeconds: Math.round(light), remSleepSeconds: Math.round(rem), awakeSleepSeconds: 1500, unmeasurableSeconds: 0, averageRespiration: 14.2, avgSleepStress: 18, sleepScores: { overallScore: 78 }, retro: false });
    uds.push({ uuid: 'u' + i, calendarDate: d, totalSteps: 7000 + (i % 7) * 500, restingHeartRate: 55 + (i % 4), ...(i % 4 === 1 ? { allDayStress: { aggregatorList: [{ type: 'TOTAL', averageStressLevel: 30 + (i % 9), maxStressLevel: 80 }, { type: 'ASLEEP', averageStressLevel: 18 }] } } : { averageStressLevel: 30 + (i % 9) }), totalKilocalories: 2200, moderateIntensityMinutes: 20, vigorousIntensityMinutes: 5, bodyBattery: { bodyBatteryStatList: [{ bodyBatteryStatType: 'HIGHEST', statsValue: 80 - (i % 10) }, { bodyBatteryStatType: 'LOWEST', statsValue: 20 + (i % 8) }] }, bodyBatteryChargedValue: 55, bodyBatteryDrainedValue: 60 });
    health.push({ calendarDate: d, metrics: [{ type: 'HRV', value: 55 + 8 * Math.sin(i / 6) }, { type: 'HEART_RATE', value: 52 }, { type: 'RESPIRATION', value: 14 }, { type: 'SPO2', value: 96 }] });
    if (i % 3 === 0) readiness.push({ calendarDate: d, level: 'HIGH', score: 70 + (i % 20), recoveryTime: 600, acuteLoad: 300 });
    if (i % 10 === 0) vo2.push({ calendarDate: d, vo2MaxValue: 48 + i / 50, sport: 'RUNNING' });
    if (i % 2 === 0) load.push({ calendarDate: d, acuteTrainingLoad: 250 + i });
  });
  const activities = [];
  for (let i = 0; i < N; i += 3) {
    const d = days[i]; const start = Date.parse(d + 'T12:00:00Z'); const isRide = i % 2 === 1;
    activities.push({ activityId: 9000000 + i, name: i === 3 ? '<img src=x onerror=alert(1)> Run' : isRide ? 'Ride ' + d : 'Run ' + d, activityType: isRide ? 'cycling' : 'running', startTimeGmt: start, startTimeLocal: start, duration: (isRide ? 3600 : 2400) * 1000, distance: (isRide ? 25000 : 8000) * 100, avgHr: 145, maxHr: 172, calories: 600, avgPower: isRide ? 190 : null, elevationGain: 12000, aerobicTrainingEffect: 3.1, activityTrainingLoad: 120 });
  }
  const fitStart = Date.parse(days[N - 1] + 'T15:00:00Z');
  const fit = buildFit({ startEpochMs: fitStart, seconds: 900 });
  // a FIT for one that is ALSO in summaries (dedupe test): same start as activity index 0
  const fitDup = buildFit({ startEpochMs: Date.parse(days[0] + 'T12:00:00Z'), seconds: 600 });
  const nested = zipSync({ 'activity_1.fit': fit, 'activity_dup.fit': fitDup, 'junk.fit': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) });
  const J = o => strToU8(JSON.stringify(o));
  const files = {
    'DI_CONNECT/DI-Connect-Wellness/2026-06-13_2026-09-21_12345_sleepData.json': J(sleep),
    ...(opts.noHrv ? {} : { 'DI_CONNECT/DI-Connect-Wellness/2026-06-13_healthStatusData.json': J(health) }),
    'DI_CONNECT/DI-Connect-Aggregator/UDSFile_2026-06-13_2026-10-10_overlap.json': J(uds.filter((_, i) => i % 5 === 0).map(u => ({ ...u, totalSteps: 0, restingHeartRate: 0, averageStressLevel: 0, allDayStress: undefined }))),
    'DI_CONNECT/DI-Connect-Aggregator/UDSFile_2026-06-13_2026-10-10.json': J(uds),
    'DI_CONNECT/DI-Connect-Fitness/user_summarizedActivities.json': J([{ summarizedActivitiesExport: activities }]),
    'DI_CONNECT/DI-Connect-Metrics/TrainingReadinessDTO_2026-06-13_2026-10-10.json': J(readiness),
    'DI_CONNECT/DI-Connect-Metrics/MetricsMaxMetData_2026-06-13_2026-10-10.json': J(vo2),
    'DI_CONNECT/DI-Connect-Metrics/MetricsAcuteTrainingLoad_2026-06-13_2026-10-10.json': J(load),
    'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip': nested,
    'DI_CONNECT/DI-Connect-User/user_profile.json': J({ birthDate: '1980-01-01', secret: 'should never be read' }),
    'DI_CONNECT/DI-Connect-Customer-Service/tickets.json': J([{ calendarDate: '2026-01-01', totalSteps: 999999 }]),
    'DI_CONNECT/DI-Connect-Wellness/unknown_thing.json': J([{ foo: 1 }]),
    'DI_CONNECT/DI-Connect-Wellness/broken.json': strToU8('{not json'),
    'DI_CONNECT/README.txt': strToU8('hello')
  };
  const zip = zipSync(files);
  return { zip, fit, days, expect: { nDays: N, nActs: activities.length + 1, firstDay: days[0], lastDay: days[N - 1], sleepNights: N, nested: true } };
}
if (process.argv[1] && process.argv[1].endsWith('fixtures.mjs')) {
  const fs = await import('fs'); const { zip, fit, expect } = buildExport();
  fs.writeFileSync(process.argv[2] || '/tmp/garmin-export.zip', zip); fs.writeFileSync('/tmp/test.fit', fit); console.log(JSON.stringify(expect), zip.length);
}
