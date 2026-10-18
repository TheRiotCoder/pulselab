// PulseLab bootstrap: routing, chrome, theme, service worker + install/update flow.
import { S, loadAll, saveRange, hasData } from './state.js';
import { model, inRange } from './analysis.js';
import * as V from './views.js';
import { dataView } from './dataview.js';
import { loadDemo } from './demo.js';
import { esc } from './util.js';
import { VERSION } from './version.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const TABS = [
  ['overview', 'Overview', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  ['sleep', 'Sleep', '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'],
  ['heart', 'Heart', '<path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.4-7 10-7 10z"/>'],
  ['stress', 'Stress', '<rect x="3" y="8" width="16" height="9" rx="2"/><path d="M21 11v3M7 11v3M11 11v3"/>'],
  ['activity', 'Activity', '<path d="M3 13h4l3-8 4 14 3-6h4"/>'],
  ['insights', 'Insights', '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>'],
  ['data', 'Data', '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3 3 7 3s7-1.3 7-3"/>']
];
const TITLES = { overview: 'Overview', sleep: 'Sleep', heart: 'Heart', stress: 'Stress & Battery', activity: 'Activity', insights: 'Insights', data: 'Data & settings' };
const RANGES = [[7, '7d'], [30, '30d'], [90, '90d'], [365, '1y'], [0, 'All']];

// ---------- modal / toast ----------
function modal(html) { const el = $('#modal'); el.innerHTML = `<div class="box" role="dialog" aria-modal="true">${html}</div>`; el.hidden = false; return el; }
function closeModal() { const el = $('#modal'); el.hidden = true; el.innerHTML = ''; }
function confirmBox(title, text, okLabel = 'Continue') {
  return new Promise(res => {
    const el = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="btns"><button class="btn secondary" id="m-no">Cancel</button><button class="btn danger" id="m-yes">${esc(okLabel)}</button></div>`);
    el.querySelector('#m-no').onclick = () => { closeModal(); res(false); }; el.querySelector('#m-yes').onclick = () => { closeModal(); res(true); };
    el.querySelector('#m-no').focus();
  });
}
function privacyBox() {
  const el = modal(`<h2>Privacy &amp; limits</h2><ul class="summary-list small"><li>Your data is read and stored only on this device (IndexedDB). The app makes no network requests with it; the page’s security policy forbids connecting anywhere except this app’s own files.</li><li>No Garmin login or password is ever requested.</li><li>PulseLab is not a medical device and gives no medical advice. Scores are transparent, simple formulas and statistical associations.</li><li>Garmin’s data layout changes over time, so some files may not be recognised. The import summary shows what was found.</li></ul><div class="btns"><button class="btn" id="m-ok">Close</button></div>`);
  el.querySelector('#m-ok').onclick = closeModal;
}

// ---------- theme ----------
function applyTheme() {
  const t = S.settings.theme || 'auto'; document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches);
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#0b1117' : '#f3f6fa';
}
matchMedia('(prefers-color-scheme: light)').addEventListener && matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

// ---------- chrome ----------
function renderTabs() {
  const cur = route().name;
  $('#tabs').innerHTML = TABS.map(([id, label, path]) => `<a href="#/${id}" ${cur === id || (id === 'activity' && cur === 'activity') ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg><span>${label}</span></a>`).join('');
}
function renderRange() {
  const r = route(); const el = $('#range');
  el.classList.toggle('hidden', r.name === 'data' || !!r.id);
  el.innerHTML = RANGES.map(([v, l]) => `<button role="tab" data-r="${v}" aria-selected="${S.range === v}">${l}</button>`).join('');
}
function renderBanners() {
  const b = $('#banners'); let h = '';
  if (S.meta.demo) h += `<div class="banner demo" role="status"><b>Demo data.</b> Everything you see is synthetic, generated on this device. <div class="row"><button class="btn small secondary" data-go="data">Import my own data</button></div></div>`;
  b.innerHTML = h + (b.querySelector('.update') ? b.querySelector('.update').outerHTML : '') + (b.querySelector('.install') ? b.querySelector('.install').outerHTML : '');
}
export function refreshChrome() { applyTheme(); renderBanners(); renderTabs(); renderRange(); }

// ---------- routing ----------
function route() {
  const h = location.hash.replace(/^#\/?/, ''); const [name, ...rest] = h.split('/');
  const n = TABS.some(t => t[0] === name) ? name : 'overview';
  return { name: n, id: rest.length ? decodeURIComponent(rest.join('/')) : null };
}
let renderToken = 0;
async function render() {
  const tok = ++renderToken; const r = route();
  $('#title').textContent = r.id ? 'Activity' : TITLES[r.name]; renderTabs(); renderRange();
  const m = model(); const ctx = makeCtx(m);
  const root = document.createElement('div');
  try {
    if (r.name === 'activity' && r.id) await V.activityDetail(root, ctx, r.id);
    else if (r.name === 'data') dataView(root, ctx);
    else V[r.name](root, ctx);
  } catch (e) { console.error(e); root.innerHTML = `<section class="card"><h2>Something went wrong</h2><p class="muted">${esc(e && e.message || e)}</p></section>`; }
  if (tok !== renderToken) return;
  view.replaceChildren(root); V.applyW(view);
  if (!ctx.keepScroll) window.scrollTo(0, 0);
  view.focus({ preventScroll: true });
}
function makeCtx(m) {
  return { m, days: inRange(m, S.range), refreshChrome, confirm: confirmBox, privacy: privacyBox, checkUpdate, go: n => { location.hash = '#/' + n; if (route().name === n) render(); }, rerender: () => render(),
    afterImport: () => { }, };
}

document.addEventListener('click', async e => {
  const rb = e.target.closest('#range [data-r]');
  if (rb) { S.range = +rb.dataset.r; saveRange(); const y = window.scrollY; await render(); window.scrollTo(0, y); return; }
  const go = e.target.closest('[data-go]'); if (go) { e.preventDefault(); location.hash = '#/' + go.dataset.go; return; }
  const act = e.target.closest('[data-act="demo"]');
  if (act) { act.disabled = true; act.textContent = 'Generating…'; await new Promise(r => setTimeout(r, 30)); await loadDemo(); refreshChrome(); location.hash = '#/overview'; render(); return; }
  const inst = e.target.closest('[data-install]');
  if (inst) { if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; removeInstall(); } return; }
  const dis = e.target.closest('[data-dismiss-install]'); if (dis) { localStorage.setItem('pl_install_dismissed', '1'); removeInstall(); return; }
  const up = e.target.closest('[data-update]'); if (up && swReg && swReg.waiting) swReg.waiting.postMessage('SKIP_WAITING');
});
window.addEventListener('hashchange', render);

// ---------- install banner ----------
let deferredPrompt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function removeInstall() { const i = $('#banners .install'); if (i) i.remove(); }
function showInstall(kind) {
  if (standalone() || localStorage.getItem('pl_install_dismissed') || $('#banners .install')) return;
  const d = document.createElement('div'); d.className = 'banner install'; d.setAttribute('role', 'region'); d.setAttribute('aria-label', 'Install');
  d.innerHTML = kind === 'android'
    ? `<b>Install PulseLab</b> for offline use and a home-screen icon.<div class="row"><button class="btn small" data-install>Install</button><button class="btn small secondary" data-dismiss-install>Not now</button></div>`
    : `<b>Install on iPhone:</b> tap the <b>Share</b> button in Safari, choose <b>Add to Home Screen</b>, then <b>Add</b>. This helps stop Safari clearing your stored data (it can still happen), so also take a <b>backup</b> in the Data tab now and then.<div class="row"><button class="btn small secondary" data-dismiss-install>Got it</button></div>`;
  $('#banners').append(d);
}
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; if (!IOS) showInstall('android'); });
window.addEventListener('appinstalled', removeInstall);
if (IOS && !standalone()) setTimeout(() => showInstall('ios'), 1200);

// ---------- service worker / updates ----------
let swReg = null;
function showUpdate() {
  if ($('#banners .update')) return;
  const d = document.createElement('div'); d.className = 'banner update'; d.setAttribute('role', 'status');
  d.innerHTML = `<b>Update available.</b> A new version of PulseLab is ready.<div class="row"><button class="btn small" data-update>Reload to update</button></div>`;
  $('#banners').prepend(d);
}
async function checkUpdate(msgEl) {
  if (!swReg) { msgEl.textContent = 'Offline mode is not active in this browser.'; return; }
  msgEl.textContent = 'Checking…';
  try { await swReg.update(); } catch { msgEl.textContent = 'Could not check (offline?).'; return; }
  setTimeout(() => { msgEl.textContent = swReg.waiting ? 'An update is ready; use the banner at the top.' : 'You have the latest version (' + VERSION + ').'; }, 800);
}
if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
  window.addEventListener('load', async () => {
    try {
      swReg = await navigator.serviceWorker.register('sw.js');
      if (swReg.waiting && navigator.serviceWorker.controller) showUpdate();
      swReg.addEventListener('updatefound', () => { const nw = swReg.installing; nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(); }); });
      window.__swReady = true;
    } catch (e) { console.warn('Service worker unavailable', e); }
  });
}

// ---------- start ----------
(async function start() {
  try { await loadAll(); } catch (e) { console.error(e); view.innerHTML = '<section class="card"><h2>Storage unavailable</h2><p>This browser blocked local storage (private mode?). PulseLab needs IndexedDB to keep your data on this device.</p></section>'; return; }
  refreshChrome(); await render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
})();
