// IndexedDB wrapper. Everything the app knows lives here, on this device only.
const NAME = 'pulselab', VERSION = 1;
const STORES = { daily: 'date', activities: 'id', series: 'id', meta: 'key' };
let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [s, k] of Object.entries(STORES)) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: k });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
const wrap = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function txDone(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }

export async function getAll(store) {
  const db = await open(); return wrap(db.transaction(store).objectStore(store).getAll());
}
export async function get(store, key) {
  const db = await open(); return wrap(db.transaction(store).objectStore(store).get(key));
}
export async function putMany(store, items) {
  if (!items.length) return;
  const db = await open();
  // chunk so very large imports don't build one giant transaction
  for (let i = 0; i < items.length; i += 500) {
    const tx = db.transaction(store, 'readwrite'); const os = tx.objectStore(store);
    for (const it of items.slice(i, i + 500)) os.put(it);
    await txDone(tx);
  }
}
export async function deleteKeys(store, keys) {
  if (!keys.length) return;
  const db = await open(); const tx = db.transaction(store, 'readwrite'); const os = tx.objectStore(store);
  for (const k of keys) os.delete(k); await txDone(tx);
}
export async function clearStores(names = Object.keys(STORES)) {
  const db = await open(); const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear(); await txDone(tx);
}
export async function setMeta(key, value) { return putMany('meta', [{ key, value }]); }
export async function getMeta(key, dflt = null) { const r = await get('meta', key); return r ? r.value : dflt; }
