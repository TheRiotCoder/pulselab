// Data & Settings view: import, demo, backup/restore, CSV export, preferences, delete.
import { S, wipe, flush, saveSettings, hasData, DEFAULTS, loadAll } from './state.js';
import * as db from './db.js';
import { model } from './analysis.js';
import { importFiles } from './import.js';
import { loadDemo } from './demo.js';
import { esc, fmtDay, fmtNum, download, dayKey } from './util.js';
import { VERSION } from './version.js';

const KIND = {
  sleep: 'Sleep nights', uds: 'Daily summaries (steps, resting HR, stress, Body Battery, intensity)', health: 'Health status days (HRV, overnight HR, respiration, SpO₂)', hrv: 'HRV records',
  readiness: 'Training readiness (Garmin’s own score)', load: 'Acute training load records', vo2: 'VO₂ max records', activities: 'Activities from summaries', fit: 'FIT activity files (with HR / speed / power series)',
  csvActs: 'Activity CSV rows', csvDaily: 'Daily CSV rows', demo: 'Demo days'
};

export function reportHtml(rep) {
  const kinds = Object.entries(rep.found).filter(([, n]) => n > 0);
  const ok = kinds.length > 0;
  let h = `<div class="card" id="report"><h2>${ok ? '<span class="ok">✓</span> What was found' : '<span class="bad">✗</span> Nothing recognised'}</h2>`;
  if (ok) {
    h += `<ul class="summary-list">${kinds.map(([k, n]) => `<li><b>${fmtNum(n)}</b> ${esc(KIND[k] || k)}</li>`).join('')}</ul>`;
    if (rep.range) h += `<p class="small">Data spans <b>${esc(fmtDay(rep.range.from, true))}</b> to <b>${esc(fmtDay(rep.range.to, true))}</b>.</p>`;
  } else h += `<p>I read ${rep.files} file(s) but none looked like Garmin health or activity data. Make sure you chose the .zip from Garmin’s “Export Your Data” (or its .json / .fit / .csv files).</p>`;
  h += `<p class="sub">${rep.files} file(s) read${rep.zips ? ` inside ${rep.zips} zip(s) (${fmtNum(rep.zipEntries)} entries)` : ''}; ${rep.ignored} not relevant (ignored)${rep.excluded ? `; ${rep.excluded} in account/profile/support folders deliberately not read` : ''}.</p>`;
  if (!rep.found.sleep && !rep.found.uds && ok) h += `<p class="small warnc">No sleep or daily-summary files were found, so the Sleep, Heart and Stress views will be empty. Garmin’s export request can include “Health & Wellness” data. Request it again with everything ticked.</p>`;
  if (rep.notes.length) h += `<ul class="summary-list">${rep.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
  if (rep.skipped.length) h += `<details><summary class="small">${rep.skipped.length} file(s) skipped</summary><ul class="summary-list small">${rep.skipped.slice(0, 30).map(s => `<li>${esc(s)}</li>`).join('')}</ul></details>`;
  return h + `</div>`;
}

function csvCell(v, text) {
  if (v == null || v === '') return '';
  let s = String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportDaily() {
  const cols = [['date', 'date'], ['steps', 'steps'], ['rhr', 'rhr'], ['hrv', 'hrv'], ['sleepMin', 'sleep_min'], ['deepMin', 'deep_min'], ['lightMin', 'light_min'], ['remMin', 'rem_min'], ['awakeMin', 'awake_min'], ['sleepStart', 'sleep_start'], ['sleepEnd', 'sleep_end'],
    ['stress', 'stress'], ['bbHigh', 'bb_high'], ['bbLow', 'bb_low'], ['bbCharged', 'bb_charged'], ['bbDrained', 'bb_drained'], ['intMod', 'intensity_mod'], ['intVig', 'intensity_vig'], ['vo2max', 'vo2max']];
  const rows = [...S.daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const m = model();
  const lines = [cols.map(c => c[1]).join(',') + ',readiness_own'];
  for (const d of rows) {
    const md = m.byDate && m.byDate.get(d.date);
    lines.push(cols.map(([k]) => (k === 'sleepStart' || k === 'sleepEnd') ? csvCell(d[k] ? new Date(d[k]).toISOString() : '') : csvCell(typeof d[k] === 'number' ? Math.round(d[k] * 100) / 100 : d[k])).join(',') + ',' + (md && md.readiness ? Math.round(md.readiness.score) : ''));
  }
  download('pulselab-daily.csv', lines.join('\n') + '\n', 'text/csv');
}
function exportActs() {
  const m = model();
  const lines = ['id,start_iso,type,name,duration_s,distance_m,avg_hr,max_hr,avg_power,calories,ascent_m,load_trimp_approx'];
  for (const a of m.acts) lines.push([csvCell(a.id, true), new Date(a.start).toISOString(), csvCell(a.type, true), csvCell(a.name, true), csvCell(Math.round(a.durationSec || 0)), csvCell(a.distanceM ? Math.round(a.distanceM) : ''), csvCell(a.avgHr ? Math.round(a.avgHr) : ''), csvCell(a.maxHr ? Math.round(a.maxHr) : ''), csvCell(a.avgPower ? Math.round(a.avgPower) : ''), csvCell(a.calories ? Math.round(a.calories) : ''), csvCell(a.ascentM ? Math.round(a.ascentM) : ''), Math.round(a.trimp)].join(','));
  download('pulselab-activities.csv', lines.join('\n') + '\n', 'text/csv');
}
async function backup() {
  const series = await db.getAll('series');
  const data = { format: 'pulselab-backup', version: 1, created: new Date().toISOString(), app: VERSION, settings: S.settings, demo: !!S.meta.demo, daily: [...S.daily.values()], activities: [...S.acts.values()], series };
  download('pulselab-backup-' + dayKey(new Date()) + '.json', JSON.stringify(data), 'application/json');
}
const isNum = v => typeof v === 'number' && isFinite(v);
export async function restoreBackup(text) {
  let j; try { j = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  if (!j || j.format !== 'pulselab-backup' || !Array.isArray(j.daily) || !Array.isArray(j.activities)) throw new Error('This is not a PulseLab backup file.');
  const daily = j.daily.filter(d => d && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  const acts = j.activities.filter(a => a && typeof a.id === 'string' && isNum(a.start));
  const ids = new Set(acts.map(a => a.id));
  const series = (j.series || []).filter(s => s && ids.has(s.id) && Array.isArray(s.t));
  await wipe(false);
  await db.putMany('daily', daily); await db.putMany('activities', acts); await db.putMany('series', series);
  S.settings = { ...DEFAULTS, ...(j.settings && typeof j.settings === 'object' ? j.settings : {}) }; await saveSettings();
  S.meta = { demo: !!j.demo, imports: [{ at: Date.now(), files: ['Backup restore'], found: { restored: daily.length } }] }; await db.setMeta('info', S.meta);
  await loadAll();
  return { days: daily.length, acts: acts.length };
}

export function dataView(root, ctx) {
  const m = ctx.m; const st = S.settings; const n = { d: S.daily.size, a: S.acts.size, s: [...S.acts.values()].filter(a => a.hasSeries).length };
  const srcs = new Set([...S.daily.values()].flatMap(d => d.src || []));
  const iosHint = /iPhone|iPad|iPod/.test(navigator.userAgent);
  root.innerHTML = `
  <section class="card"><h2>Import Garmin data</h2>
    <p class="small mt0">Pick the <b>.zip</b> from Garmin’s “Export Your Data”, and/or loose <code>.json</code>, <code>.fit</code> or <code>.csv</code> files. Files are read on this device and never uploaded.</p>
    <div class="btns"><label class="btn" id="pick">Choose files…<input type="file" id="file" multiple accept=".zip,.json,.fit,.csv,application/zip,application/json,text/csv,application/octet-stream"></label>
    <button class="btn secondary" id="demo">${S.meta.demo ? 'Reload demo data' : 'Load demo data'}</button></div>
    <div id="prog" hidden><div class="progress"><i id="pbar" data-w="0"></i></div><div class="small muted" id="ptxt"></div></div>
  </section>
  <div id="reportslot"></div>
  <section class="card"><h2>What’s stored on this device</h2>
    ${hasData() ? `<div class="kv"><span>Days with data</span><span>${fmtNum(n.d)}</span><span>Activities</span><span>${fmtNum(n.a)} (${n.s} with HR/speed series)</span><span>Date range</span><span>${m.first ? esc(fmtDay(m.first, true)) + ' – ' + esc(fmtDay(m.last, true)) : '–'}</span><span>Sources</span><span>${esc([...srcs].join(', ') || 'activities only')}</span><span>Type</span><span>${S.meta.demo ? '<b class="warnc">DEMO (synthetic)</b>' : 'Your data'}</span></div>` : '<p class="muted">Nothing yet.</p>'}
    <p class="sub" id="persist"></p></section>
  <section class="card"><h2>Export, backup &amp; restore</h2>
    <div class="btns"><button class="btn secondary" id="csvd">Daily CSV</button><button class="btn secondary" id="csva">Activities CSV</button><button class="btn secondary" id="bk">Backup (JSON)</button>
    <label class="btn secondary">Restore backup…<input type="file" id="rest" accept=".json,application/json"></label></div>
    <p class="sub">Backups contain all your health data unencrypted. Keep the file somewhere private. Restoring replaces everything currently stored. Backups also let you move to a new phone or a new address of this app.</p><div id="restmsg" class="small"></div></section>
  <section class="card"><h2>Settings</h2>
    <div class="field"><label for="s-theme">Theme</label><select id="s-theme"><option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option></select></div>
    <div class="field"><label for="s-units">Distance units</label><select id="s-units"><option value="km">Kilometres</option><option value="mi">Miles</option></select></div>
    <div class="field"><label for="s-max">Max heart rate (bpm)</label><input id="s-max" type="number" inputmode="numeric" min="120" max="230" placeholder="auto" value="${st.maxHr ?? ''}"><div class="hint" id="maxhint"></div></div>
    <div class="field"><label for="s-rest">Resting HR override (bpm)</label><input id="s-rest" type="number" inputmode="numeric" min="30" max="100" placeholder="auto" value="${st.restHrOverride ?? ''}"><div class="hint">Leave blank to use the median of your recorded resting HR (currently ${m.rest ? Math.round(m.rest) : '–'}).</div></div>
    <div class="field"><label for="s-need">Sleep need (hours)</label><input id="s-need" type="number" inputmode="decimal" step="0.25" min="5" max="11" value="${st.sleepNeedH}"></div>
    <div class="field"><label for="s-sex">Training-load formula</label><select id="s-sex"><option value="m">Banister (male coefficients)</option><option value="f">Banister (female coefficients)</option></select></div>
  </section>
  <section class="card"><h2>How to get your Garmin export</h2>
    <ol class="steps small"><li>On a computer or phone browser, sign in at <b>garmin.com/account</b> (Garmin Account, not the app).</li><li>Open <b>Account → Data Management → Export Your Data</b> → <b>Request Data Export</b>.</li><li>Confirm via the email Garmin sends. Garmin then emails a download link (minutes to a couple of days).</li><li>Download the .zip to your phone (don’t unzip it) and choose it above.</li></ol>
    <p class="sub">The zip can be hundreds of MB. Importing may take a minute on a phone; keep this screen open.</p></section>
  <section class="card"><h2>App</h2>
    <div class="kv"><span>Version</span><span>${esc(VERSION)}</span><span>Network use</span><span>none for your data</span></div>
    <div class="btns mt8"><button class="btn secondary small" id="upd">Check for update</button><button class="btn secondary small" id="priv">Privacy &amp; limits</button></div><div id="updmsg" class="small muted"></div></section>
  <section class="card"><h2>Delete</h2><p class="small mt0">Removes every day, activity, setting and import record stored by PulseLab on this device. The app itself stays installed.</p><button class="btn danger" id="wipe">Delete all my data</button></section>`;
  root.querySelector('#s-theme').value = st.theme; root.querySelector('#s-units').value = st.units; root.querySelector('#s-sex').value = st.sex;
  const mh = root.querySelector('#maxhint'); const est = m.maxHrEst;
  mh.innerHTML = st.maxHr ? `Using your value (${st.maxHrConfirmed ? 'confirmed' : 'set'}). Clear the box to go back to the automatic estimate${est ? ' (' + est.value + ' bpm)' : ''}.`
    : est ? `Currently <b>estimated at ${est.value} bpm</b> from your highest sustained HR (99th percentile of ${fmtNum(est.n)} ${esc(est.unit)}). This usually sits a few bpm under your true max, so please confirm or enter your own. Zones and training load depend on it. <button class="btn secondary small" id="useest" type="button">Use ${est.value} bpm</button>`
      : 'No heart-rate data yet; 190 bpm is a placeholder. Enter your own max HR (220 − age is a rough guide; a hard-effort test is better).';
  const ue = root.querySelector('#useest'); if (ue) ue.onclick = async () => { S.settings.maxHr = est.value; S.settings.maxHrConfirmed = true; await saveSettings(); ctx.refreshChrome(); ctx.go('data'); };
  const prog = root.querySelector('#prog'), pbar = root.querySelector('#pbar'), ptxt = root.querySelector('#ptxt');
  const onProgress = (txt, frac) => { prog.hidden = false; ptxt.textContent = txt; if (frac != null) pbar.style.width = Math.round(frac * 100) + '%'; };
  root.querySelector('#file').addEventListener('change', async e => {
    const files = [...e.target.files]; if (!files.length) return;
    try { const rep = await importFiles(files, onProgress); prog.hidden = true; root.querySelector('#reportslot').innerHTML = reportHtml(rep); ctx.refreshChrome(); ctx.afterImport(rep); }
    catch (err) { prog.hidden = true; root.querySelector('#reportslot').innerHTML = `<div class="card"><h2 class="bad">Import failed</h2><p>${esc(err && err.message || err)}</p></div>`; }
    e.target.value = '';
  });
  root.querySelector('#demo').onclick = async () => { onProgress('Generating demo data…', 0.3); await new Promise(r => setTimeout(r, 30)); if (hasData() && !S.meta.demo && !(await ctx.confirm('Load demo data?', 'You already have your own data stored. Loading demo data will ADD synthetic days alongside it and mix the two. Back up first, or cancel. Continue?'))) { prog.hidden = true; return; } await wipe(true); await loadDemo(); ctx.refreshChrome(); ctx.go('overview'); };
  root.querySelector('#csvd').onclick = exportDaily; root.querySelector('#csva').onclick = exportActs; root.querySelector('#bk').onclick = backup;
  root.querySelector('#rest').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return; const msg = root.querySelector('#restmsg');
    if (!(await ctx.confirm('Restore backup?', 'This replaces ALL data currently stored in PulseLab with the contents of ' + f.name + '.'))) { e.target.value = ''; return; }
    try { const r = await restoreBackup(await f.text()); msg.innerHTML = `<span class="ok">Restored ${r.days} days and ${r.acts} activities.</span>`; ctx.refreshChrome(); ctx.go('overview'); } catch (err) { msg.innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
    e.target.value = '';
  });
  const num = (el, key, lo, hi, nullable) => el.addEventListener('change', async () => { let v = el.value === '' && nullable ? null : parseFloat(el.value); if (v != null && (!isFinite(v) || v < lo || v > hi)) { el.value = S.settings[key] ?? ''; return; } S.settings[key] = v; if (key === 'maxHr') S.settings.maxHrConfirmed = v != null; await saveSettings(); ctx.refreshChrome(); });
  num(root.querySelector('#s-max'), 'maxHr', 120, 230, true); num(root.querySelector('#s-rest'), 'restHrOverride', 30, 100, true); num(root.querySelector('#s-need'), 'sleepNeedH', 5, 11);
  for (const [id, key] of [['#s-theme', 'theme'], ['#s-units', 'units'], ['#s-sex', 'sex']]) root.querySelector(id).addEventListener('change', async e => { S.settings[key] = e.target.value; await saveSettings(); ctx.refreshChrome(); });
  root.querySelector('#wipe').onclick = async () => { if (await ctx.confirm('Delete all data?', 'This permanently deletes everything PulseLab stores on this device (days, activities, settings). Consider making a backup first. This cannot be undone.', 'Delete everything')) { await wipe(false); ctx.refreshChrome(); ctx.go('data'); } };
  root.querySelector('#upd').onclick = () => ctx.checkUpdate(root.querySelector('#updmsg'));
  root.querySelector('#priv').onclick = () => ctx.privacy();
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { root.querySelector('#persist').textContent = p ? 'Storage is marked persistent, so the browser won’t evict it under pressure.' : 'Storage is not marked persistent: browsers may clear it if the device runs very low on space' + (iosHint ? ' or after weeks of non-use in Safari (install to Home Screen to avoid this)' : '') + '. Make a backup now and then.'; });
}
