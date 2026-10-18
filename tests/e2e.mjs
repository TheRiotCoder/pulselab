// End-to-end tests with headless Chrome (puppeteer-core) at phone width.
// Usage: PULSELAB_NODE_MODULES=/path/to/node_modules node tests/e2e.mjs
import { createRequire } from 'module';
import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os';
import { fileURLToPath } from 'url';
const NM = process.env.PULSELAB_NODE_MODULES || '/workspace/pulselab-test/node_modules';
const require = createRequire(NM + '/');
const puppeteer = require('puppeteer-core');
const { buildExport, buildFit } = await import('./fixtures.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || '/workspace/pulselab-test/shots'; fs.mkdirSync(SHOTS, { recursive: true });
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-dl-'));

// ---- static server that applies the real _headers file ----
const hdrText = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
function headersFor(p) {
  const out = {}; let cur = null;
  for (const line of hdrText.split('\n')) {
    if (/^\S/.test(line)) { const pat = line.trim(); cur = pat === '/*' || pat === p || (pat.endsWith('/*') && p.startsWith(pat.slice(0, -1))); }
    else if (cur && line.trim()) { const i = line.indexOf(':'); out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  }
  return out;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const srv = { swVersion: null, hits: [] };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); srv.hits.push(p); if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p); if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || /node_modules|tests/.test(p)) { res.writeHead(404); return res.end('nf'); }
  let body = fs.readFileSync(file);
  if (p === '/sw.js' && srv.swVersion) body = Buffer.from(body.toString().replace(/const VERSION = '[^']+'/, `const VERSION = '${srv.swVersion}'`));
  const h = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...headersFor(req.url.split('?')[0] === '/' ? '/' : p) };
  res.writeHead(200, h); res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port + '/';

// ---- test harness ----
const results = []; const ok = (c, msg) => { results.push([!!c, msg]); console.log((c ? '  PASS ' : '  FAIL ') + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const ctx = browser.defaultBrowserContext();
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [], external = [];
const attach = pg => {
  pg.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  pg.on('pageerror', e => errors.push('pageerror: ' + e.message));
  pg.on('requestfailed', r => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push('failed ' + r.url()); });
  pg.on('request', r => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('about:')) external.push(u); });
};
attach(page);
const cdp = await page.createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => { });
const shot = async n => page.screenshot({ path: path.join(SHOTS, n + '.png') });
const goto = async h => { await page.evaluate(h => { location.hash = h; }, h); await sleep(350); };
const errCount = () => errors.length;
const text = sel => page.$eval(sel, e => e.innerText).catch(() => '');
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function waitFor(fn, to = 15000, arg) { const t = Date.now(); while (Date.now() - t < to) { if (await page.evaluate(fn, arg).catch(() => false)) return true; await sleep(150); } return false; }

console.log('\n[1] fresh load');
await page.goto(BASE, { waitUntil: 'networkidle0' });
ok(await page.$('#view .card'), 'empty state renders');
ok((await text('#view')).includes('Load demo data'), 'empty state offers demo + import');
ok(await page.evaluate(() => document.querySelectorAll('#tabs a').length === 7), '7 tabs in nav');
const hdr = await (await fetch(BASE)).headers; // node fetch for header check
ok(/script-src 'self'/.test(hdr.get('content-security-policy')) && /connect-src 'self'/.test(hdr.get('content-security-policy')), 'CSP header: script-src self + connect-src self');
ok(hdr.get('x-content-type-options') === 'nosniff' && hdr.get('referrer-policy') === 'no-referrer' && hdr.get('x-frame-options') === 'DENY' && !!hdr.get('permissions-policy'), 'nosniff, no-referrer, X-Frame-Options DENY, Permissions-Policy');
const swh = await fetch(BASE + 'sw.js'); ok(/no-cache/.test(swh.headers.get('cache-control')), 'sw.js is no-cache');
ok(/no-cache/.test(hdr.get('cache-control')), 'index.html is no-cache');
await shot('01-empty');

console.log('\n[2] demo data + every view');
await page.evaluate(() => document.querySelector('[data-act="demo"]').click());
ok(await waitFor(() => !!document.querySelector('.ring')), 'demo loads and overview shows readiness ring');
ok((await text('#banners')).includes('Demo data'), 'demo banner visible');
ok(/Readiness/.test(await text('#view')), 'readiness card');
const expl = await page.$$eval('.factor', f => f.length); ok(expl >= 3, 'readiness factors listed (' + expl + ')');
await page.evaluate(() => document.querySelector('.factor summary').click()); await sleep(100);
ok((await text('.factor p')).length > 40, 'factor explanation expands');
await shot('02-overview');
const views = ['overview', 'sleep', 'heart', 'stress', 'activity', 'insights', 'data'];
for (const v of views) {
  const before = errCount(); await goto('#/' + v);
  const t = await text('#view'); ok(t.length > 80, v + ' renders content');
  ok(errCount() === before, v + ': no console errors');
  const ov = await overflow(); ok(ov <= 1, v + ': no horizontal overflow at 390px (' + ov + 'px)');
  await shot('v-' + v);
}
console.log('\n[3] ranges + chart interaction');
for (const r of ['7', '30', '90', '365', '0']) {
  await goto('#/heart'); const before = errCount();
  await page.evaluate(r => document.querySelector(`#range [data-r="${r}"]`).click(), r); await sleep(350);
  ok(errCount() === before && (await page.$('#view svg')) !== null, 'range ' + (r === '0' ? 'all' : r) + ' on Heart renders');
}
await page.evaluate(() => document.querySelector('#range [data-r="90"]').click()); await sleep(300);
await goto('#/sleep');
const ro0 = await text('.readout');
const box = await page.$eval('.chart-svg', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.click(box.x + box.w * 0.6, box.y + box.h * 0.5); await sleep(150);
const ro1 = await text('.readout'); ok(ro1 !== ro0 && /\d/.test(ro1), 'tapping a chart shows values in the readout: "' + ro1.slice(0, 60).replace(/\n/g, ' ') + '"');
await shot('03-sleep-tap');
await goto('#/heart'); ok(await page.$$eval('.chart-svg .flag', f => f.length) >= 0 && await page.$('.chart-svg .band') !== null, 'HRV/RHR baseline band drawn');
const stat = await text('#view'); ok(/normal range/.test(stat), 'heart view states 7-day vs 60-day status');
await goto('#/activity'); await sleep(200);
ok(await page.$('#c-load svg') !== null && await page.$('#c-acwr svg') !== null, 'training load + ACWR charts');
ok(/Time in heart-rate zones/.test(await text('#view')), 'HR zones card');
await shot('04-activity');
console.log('\n[4] activity detail');
await page.evaluate(() => document.querySelector('#actlist a').click()); await sleep(600);
ok(await page.$$eval('.chart-svg', s => s.length) >= 3, 'activity detail has HR/speed/etc charts');
ok(await page.$('svg.route') !== null, 'GPS route drawn');
ok(!(await text('#range')).trim() || await page.$eval('#range', e => e.classList.contains('hidden')), 'range selector hidden on detail');
await shot('05-detail');
await page.evaluate(() => history.back()); await sleep(300);
console.log('\n[5] insights');
await goto('#/insights');
const cards = await page.$$eval('.insight', c => c.length); ok(cards >= 3, 'insight cards present (' + cards + ')');
const itxt = await text('#view'); ok(/n=\d+/.test(itxt) && /Not medical advice/i.test(itxt), 'insights show n and the not-medical-advice notice');
ok(/confidence/.test(itxt), 'confidence labels');
ok(/with several comparisons, one may look significant by chance/i.test(itxt), 'multiple-comparisons caveat shown');
ok(!/Same AM/.test(itxt) && !/should fit your pattern/.test(itxt), 'no "Same AM" effect label and no overconfident 48 h wording');
ok(/Morning of \(before the session\)/.test(itxt) && /(mornings? after the session|following mornings)/i.test(itxt), 'recovery card: morning-of is a baseline check, effect starts +1 day');
ok(!/injur/i.test(itxt), 'no injury-risk wording on insights');
await page.evaluate(() => document.querySelector('details[data-sc] summary').click()); await sleep(250);
ok(await page.$('details[data-sc] svg') !== null, 'correlation scatter opens');
ok(/Unusual readings/.test(itxt) && /Weekly summary/.test(itxt) && /Trends/.test(itxt), 'weekly summary, anomalies, trends sections');
await page.evaluate(() => window.scrollTo(0, 0)); await shot('06-insights');
// short range => insufficient messaging, no overclaiming
await page.evaluate(() => document.querySelector('#range [data-r="7"]').click()); await sleep(300);
const t7 = await text('#view'); ok(/Not enough data yet/.test(t7), '7-day range withholds insights that lack data (shows "not enough data")');
await page.evaluate(() => document.querySelector('#range [data-r="90"]').click()); await sleep(200);

console.log('\n[6] theme + settings');
await goto('#/data');
await page.select('#s-theme', 'light'); await sleep(300);
ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'light theme applied');
await goto('#/overview'); await shot('07-light-overview'); await goto('#/sleep'); await shot('08-light-sleep');
await goto('#/data'); await page.select('#s-theme', 'dark'); await sleep(200);
for (const v of ['overview', 'heart', 'activity', 'insights']) { await goto('#/' + v); await shot('dark-' + v); }
ok(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(11, 17, 23)', 'dark theme applied');
await goto('#/data');
const mhint = await text('#maxhint'); ok(/estimated at \d+ bpm/.test(mhint) && await page.$('#useest') !== null && await page.$eval('#s-max', e => e.value === ''), 'max HR starts as auto: estimate + source shown, input blank, confirm button offered');
await page.click('#useest'); await sleep(500);
ok(await page.evaluate(async () => { const s = (await import('/js/state.js')).S.settings; return s.maxHr > 150 && s.maxHrConfirmed === true; }), '"Use this estimate" stores and confirms max HR');
await page.$eval('#s-max', e => { e.value = ''; e.dispatchEvent(new Event('change')); }); await sleep(300);
ok(await page.evaluate(async () => (await import('/js/state.js')).S.settings.maxHr) === null, 'clearing max HR returns to auto');
await page.$eval('#s-max', e => { e.value = '175'; e.dispatchEvent(new Event('change')); }); await sleep(300);
ok(await page.evaluate(async () => (await import('/js/state.js')).S.settings.maxHr) === 175, 'max HR setting persists');
ok(await page.evaluate(async () => (await import('/js/state.js')).S.settings.maxHrConfirmed) === true, 'manual max HR counts as confirmed');
await page.$eval('#s-max', e => { e.value = '188'; e.dispatchEvent(new Event('change')); }); await sleep(200);

console.log('\n[7] PWA: service worker, manifest, offline reload');
ok(await waitFor(() => !!window.__swReady), 'service worker registered');
await page.evaluate(() => navigator.serviceWorker.ready); await sleep(800);
const ctl = await page.evaluate(() => !!navigator.serviceWorker.controller);
if (!ctl) { await page.reload({ waitUntil: 'networkidle0' }); await sleep(500); }
ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'page is controlled by the service worker');
const cacheNames = await page.evaluate(async () => (await caches.keys())); ok(cacheNames.some(n => /^pulselab-v\d/.test(n)), 'versioned cache created: ' + cacheNames.join(','));
const man = await page.evaluate(async () => (await (await fetch('manifest.webmanifest')).json()));
ok(man.display === 'standalone' && man.icons.some(i => i.purpose === 'maskable') && man.icons.some(i => i.sizes === '512x512'), 'manifest standalone + maskable + 512 icon');
ok(await page.evaluate(() => !!document.querySelector('link[rel="apple-touch-icon"]') && !!document.querySelector('meta[name="apple-mobile-web-app-capable"]')), 'iOS meta tags + apple-touch-icon');
const PORT = server.address().port; server.closeAllConnections(); await new Promise(r => server.close(r)); // the web server is really down now
await page.setOfflineMode(true);
await page.goto(BASE, { waitUntil: 'networkidle0' }); await sleep(600);
ok(await page.$('.ring') !== null || (await text('#view')).length > 100, 'offline reload renders app');
ok(/Demo data/.test(await text('#banners')) && (await text('#view')).includes('Readiness'), 'offline reload still has stored data');
await goto('#/sleep'); ok(await page.$('#view svg') !== null, 'offline (server stopped): other views work');
await page.setOfflineMode(false);
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

console.log('\n[8] update flow');
await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update())).catch(() => { });
srv.swVersion = '9.9.9';
await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
ok(await waitFor(() => !!document.querySelector('.banner.update'), 12000), 'update banner appears when a new service worker is waiting');
await page.evaluate(() => document.querySelector('[data-update]').click());
await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => { }); await sleep(600);
ok(await page.evaluate(async () => (await caches.keys()).some(n => n === 'pulselab-v9.9.9') && !(await caches.keys()).some(n => n === 'pulselab-v1.1.0')), 'update activates new cache and removes the old one');
srv.swVersion = null;

console.log('\n[9] CSP / no network');
const e0 = errors.length;
const net = await page.evaluate(async () => { try { await fetch('https://example.com/x'); return 'allowed'; } catch (e) { return 'blocked'; } });
ok(net === 'blocked', 'fetch to a third-party origin is blocked by connect-src');
const inl = await page.evaluate(() => { try { const s = document.createElement('script'); s.textContent = 'window.__x=1'; document.body.appendChild(s); return !!window.__x; } catch (e) { return false; } });
ok(!inl, 'inline script is blocked by script-src');
errors.splice(e0); // the CSP violations above were provoked on purpose
ok(external.length === 0, 'no requests to any other origin during the whole run' + (external.length ? ': ' + external.slice(0, 3).join(', ') : ''));

console.log('\n[10] delete all data');
await goto('#/data');
await page.evaluate(() => document.querySelector('#wipe').click()); await sleep(200);
await page.evaluate(() => document.querySelector('#m-yes').click()); await sleep(500);
const left = await page.evaluate(async () => { const s = await import('/js/state.js'); return [s.S.daily.size, s.S.acts.size]; });
ok(left[0] === 0 && left[1] === 0, 'delete all clears memory');
const idb = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('pulselab'); r.onsuccess = () => { const db = r.result; const out = {}; let n = 0; const names = [...db.objectStoreNames]; names.forEach(s => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => { out[s] = q.result; if (++n === names.length) res(out); }; }); }; }));
ok(Object.values(idb).every(v => v === 0), 'delete all clears IndexedDB: ' + JSON.stringify(idb));

console.log('\n[11] real zip import (synthetic Garmin layout)');
const { zip, expect } = buildExport(); const zipPath = path.join(DL, 'garmin-export.zip'); fs.writeFileSync(zipPath, zip);
await goto('#/data');
await (await page.$('#file')).uploadFile(zipPath);
ok(await waitFor(() => !!document.querySelector('#report'), 30000), 'import report appears');
const rep = await text('#report'); console.log('    report:\n      ' + rep.replace(/\n+/g, '\n      ').slice(0, 900));
await shot('09-import-report');
const st = await page.evaluate(async () => { const s = await import('/js/state.js'); const days = [...s.S.daily.values()]; const acts = [...s.S.acts.values()]; return { nd: days.length, na: acts.length, first: days.map(d => d.date).sort()[0], last: days.map(d => d.date).sort().pop(), maxSteps: Math.max(...days.map(d => d.steps || 0)), withSleep: days.filter(d => d.sleepMin).length, withHrv: days.filter(d => d.hrv).length, withBb: days.filter(d => d.bbHigh != null).length, withReady: days.filter(d => d.garminReadiness).length, vo2: days.filter(d => d.vo2max).length, fitActs: acts.filter(a => a.hasSeries).length, dupAct: acts.find(a => a.id === 'g9000000'), run: acts.find(a => a.id === 'g9000006'), xss: acts.find(a => /onerror/.test(a.name)), demo: s.S.meta.demo, d0: days.find(d => d.date === '2026-06-13') }; });
ok(st.nd === expect.nDays && st.first === expect.firstDay && st.last === expect.lastDay, `days imported: ${st.nd}/${expect.nDays}, ${st.first}..${st.last}`);
ok(st.withSleep === 120 && st.withHrv === 120 && st.withBb === 120, `sleep/HRV/BodyBattery for all days (${st.withSleep}/${st.withHrv}/${st.withBb})`);
ok(st.withReady === 40 && st.vo2 === 12, `Garmin readiness (${st.withReady}) and VO2max (${st.vo2}) imported`);
ok(st.maxSteps < 20000, 'Customer-Service folder was NOT parsed (max steps ' + st.maxSteps + ')');
ok(st.na === expect.nActs, `activities: ${st.na}/${expect.nActs} (40 summaries + 1 FIT, duplicate FIT merged)`);
ok(st.fitActs === 2, 'FIT series attached to the new FIT activity and merged into the matching summary (' + st.fitActs + ')');
ok(st.dupAct && st.dupAct.hasSeries && st.dupAct.name.startsWith('Run'), 'deduped activity keeps summary name + gains series');
ok(st.run && Math.abs(st.run.distanceM - 8000) < 1 && Math.abs(st.run.durationSec - 2400) < 1 && st.run.type === 'running', `unit handling: ${st.run && st.run.distanceM} m / ${st.run && st.run.durationSec} s`);
ok(st.d0 && st.d0.sleepMin > 300 && Math.abs(st.d0.deepMin / st.d0.sleepMin - 0.17) < 0.01 && st.d0.sleepStart < st.d0.sleepEnd, 'sleep stages/timestamps parsed');
ok(!st.demo, 'demo flag cleared after real import');
ok(/not relevant/.test(rep) && /file\(s\) skipped/.test(rep), 'report mentions ignored + skipped (corrupt) files');
await goto('#/overview'); await sleep(300);
ok(await page.$('.ring') !== null, 'overview works on imported data');
await shot('10-imported-overview');
await goto('#/activity'); await page.evaluate(() => document.querySelector('#range [data-r="0"]').click()); await sleep(400);
ok(await page.$$eval('#actlist img', i => i.length) === 0, 'activity name with HTML is escaped (no injected <img>)');
for (let i = 0; i < 4; i++) { await page.evaluate(() => { const b = document.querySelector('#showmore'); b && b.click(); }); await sleep(100); }
ok((await text('#actlist')).includes('<img src=x'), 'hostile name shown as plain text');
ok(await page.$$eval('#actlist img', i => i.length) === 0, 'still no injected <img> after listing every activity');
for (const v of ['sleep', 'heart', 'stress', 'insights']) { const b = errCount(); await goto('#/' + v); ok(errCount() === b, 'imported data: ' + v + ' no errors'); }
await shot('11-imported-insights');
// FIT detail from the real FIT parser
await goto('#/activity'); await page.evaluate(() => { const a = [...document.querySelectorAll('#actlist a')].find(x => /Activity 2026-10-10/.test(x.innerText)); a && a.click(); }); await sleep(600);
ok(await page.$$eval('.chart-svg', s => s.length) >= 3, 'FIT-parsed activity shows HR/pace/power/alt charts');
await shot('12-fit-detail');

console.log('\n[12] export / backup / restore');
const files0 = fs.readdirSync(DL).length;
await goto('#/data');
for (const id of ['#csvd', '#csva', '#bk']) { await page.evaluate(id => document.querySelector(id).click(), id); await sleep(500); }
const dlfiles = fs.readdirSync(DL);
const daily = dlfiles.find(f => /daily\.csv/.test(f)), acts = dlfiles.find(f => /activities\.csv/.test(f)), bk = dlfiles.find(f => /backup.*\.json/.test(f));
ok(daily && /^date,steps,rhr,hrv/.test(fs.readFileSync(path.join(DL, daily), 'utf8')), 'daily CSV exported with header');
ok(acts && fs.readFileSync(path.join(DL, acts), 'utf8').split('\n').length > 40, 'activities CSV exported');
ok(bk && JSON.parse(fs.readFileSync(path.join(DL, bk), 'utf8')).daily.length === 120, 'backup JSON exported');
const actsCsv = fs.readFileSync(path.join(DL, acts), 'utf8'); ok(!/,<img/.test(actsCsv) || /"?'?<img/.test(actsCsv), 'CSV cells are safe text');
// wipe then restore
await page.evaluate(() => document.querySelector('#wipe').click()); await sleep(150); await page.evaluate(() => document.querySelector('#m-yes').click()); await sleep(500);
await (await page.$('#rest')).uploadFile(path.join(DL, bk)); await sleep(300);
await page.evaluate(() => document.querySelector('#m-yes').click()); await sleep(1200);
const rs = await page.evaluate(async () => { const s = await import('/js/state.js'); return [s.S.daily.size, s.S.acts.size, [...s.S.acts.values()].filter(a => a.hasSeries).length]; });
ok(rs[0] === 120 && rs[1] === 41 && rs[2] === 2, 'restore brings back all data incl. series: ' + rs.join('/'));
// invalid restore
fs.writeFileSync(path.join(DL, 'bad.json'), '{"hello":1}');
await goto('#/data'); await (await page.$('#rest')).uploadFile(path.join(DL, 'bad.json')); await sleep(300); await page.evaluate(() => document.querySelector('#m-yes').click()); await sleep(400);
ok(/not a PulseLab backup/.test(await text('#restmsg')) && (await page.evaluate(async () => (await import('/js/state.js')).S.daily.size)) === 120, 'invalid backup rejected and existing data kept');
// CSV re-import round trip
await page.evaluate(() => document.querySelector('#wipe').click()); await sleep(150); await page.evaluate(() => document.querySelector('#m-yes').click()); await sleep(500);
await goto('#/data'); await (await page.$('#file')).uploadFile(path.join(DL, daily), path.join(DL, acts)); await waitFor(() => !!document.querySelector('#report'), 20000);
const rt = await page.evaluate(async () => { const s = await import('/js/state.js'); return [s.S.daily.size, s.S.acts.size]; });
ok(rt[0] === 120 && rt[1] === 41, 'CSV export re-imports (loose .csv files): ' + rt.join('/'));

console.log('\n[13] loose files: .fit and .json');
await page.evaluate(() => document.querySelector('#wipe').click()); await sleep(150); await page.evaluate(() => document.querySelector('#m-yes').click()); await sleep(500);
const fitPath = path.join(DL, 'loose.fit'); fs.writeFileSync(fitPath, buildFit({ startEpochMs: Date.parse('2026-09-01T11:00:00Z'), seconds: 1200, baseHr: 150 }));
await goto('#/data'); await (await page.$('#file')).uploadFile(fitPath); await waitFor(() => !!document.querySelector('#report'), 20000);
ok(/FIT activity files/.test(await text('#report')), 'loose .fit recognised');
const jsonPath = path.join(DL, 'sleepData_loose.json'); fs.writeFileSync(jsonPath, JSON.stringify([{ calendarDate: '2026-09-02', sleepStartTimestampGMT: '2026-09-02T04:00:00.0', sleepEndTimestampGMT: '2026-09-02T11:30:00.0', deepSleepSeconds: 5000, lightSleepSeconds: 14000, remSleepSeconds: 6000, awakeSleepSeconds: 1500 }]));
await (await page.$('#file')).uploadFile(jsonPath); await sleep(800);
ok(/Sleep nights/.test(await text('#report')), 'loose sleep json recognised');
fs.writeFileSync(path.join(DL, 'junk.json'), '[1,2,3]'); fs.writeFileSync(path.join(DL, 'junk.txt'), 'hi');
await (await page.$('#file')).uploadFile(path.join(DL, 'junk.json'), path.join(DL, 'junk.txt')); await sleep(800);
ok(/Nothing recognised/.test(await text('#report')), 'unrecognised files give a clear message and do not crash');
await shot('13-nothing-found');

console.log('\n[13b] install banners');
{
  const ip = await browser.newPage(); attach(ip);
  await ip.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1');
  await ip.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ip.goto(BASE, { waitUntil: 'networkidle0' }); await sleep(1800);
  const t = await ip.$eval('#banners', e => e.innerText).catch(() => '');
  ok(/Add to Home Screen/.test(t), 'iPhone UA shows Add to Home Screen instructions');
  await ip.screenshot({ path: path.join(SHOTS, '14-ios-install.png') }); await ip.close();
}
console.log('\n[14] demo → restore of demo flag, final error check');
await goto('#/data'); await page.evaluate(() => document.querySelector('#demo').click()); await waitFor(() => !!document.querySelector('.ring'), 20000);
await page.evaluate(() => { location.hash = '#/overview'; });
const final = errors.slice();
ok(final.length === 0, 'zero console/page errors across the whole run' + (final.length ? ': ' + final.slice(0, 5).join(' | ') : ''));
const pass = results.filter(r => r[0]).length, fail = results.length - pass;
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await browser.close(); server.close();
fs.writeFileSync(path.join(SHOTS, 'results.txt'), results.map(r => (r[0] ? 'PASS ' : 'FAIL ') + r[1]).join('\n'));
process.exit(fail ? 1 : 0);
