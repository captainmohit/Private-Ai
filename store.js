// The iPad's own database (IndexedDB). Nothing here is ever sent anywhere.
// docs:   one record per document (id, name, folder, label, family, order, status current|superseded, first, count ...)
// chunks: the passages, keyed by a running number; a document owns the range [first, first+count)
const DB = "privateai-lib";
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("kv"); d.createObjectStore("chunks"); d.createObjectStore("docs", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export async function kvGet(k) { const d = await open(); return wrap(d.transaction("kv").objectStore("kv").get(k)); }
export async function kvSet(k, v) { const d = await open(), t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); return done(t); }

export async function reserveDocId() {
  const d = await open(), t = d.transaction("kv", "readwrite"), s = t.objectStore("kv");
  const id = (await wrap(s.get("nextDoc"))) || 0; s.put(id + 1, "nextDoc"); await done(t); return id;
}
export async function nextChunkKey() { return (await kvGet("nextChunk")) || 0; }
export async function putChunkBatch(startKey, rows) {
  const d = await open(), t = d.transaction("chunks", "readwrite"), s = t.objectStore("chunks");
  rows.forEach((r, i) => s.put(r, startKey + i)); return done(t);
}
// A document counts only once this succeeds: it stores the record and moves the chunk counter in one step, so an interrupted
// import leaves nothing half-finished (unclaimed passages are simply overwritten by the next document).
export async function commitDoc(doc, endKey) {
  const d = await open(), t = d.transaction(["docs", "kv"], "readwrite");
  t.objectStore("docs").put(doc); if (endKey != null) t.objectStore("kv").put(endKey, "nextChunk"); return done(t);
}
export async function allDocs() { const d = await open(); return wrap(d.transaction("docs").objectStore("docs").getAll()); }
export async function putDoc(doc) { const d = await open(), t = d.transaction("docs", "readwrite"); t.objectStore("docs").put(doc); return done(t); }
export async function chunksOf(doc) {
  if (!doc.count) return [];
  const d = await open(); return wrap(d.transaction("chunks").objectStore("chunks").getAll(IDBKeyRange.bound(doc.first, doc.first + doc.count - 1)));
}
export async function dropChunks(doc) {
  if (!doc.count) return; const d = await open(), t = d.transaction("chunks", "readwrite");
  t.objectStore("chunks").delete(IDBKeyRange.bound(doc.first, doc.first + doc.count - 1)); return done(t);
}
export async function deleteDoc(doc) { await dropChunks(doc); const d = await open(), t = d.transaction("docs", "readwrite"); t.objectStore("docs").delete(doc.id); return done(t); }
export async function getChunk(key) { const d = await open(); return wrap(d.transaction("chunks").objectStore("chunks").get(key)); }
export async function getChunks(keys) { const d = await open(), s = d.transaction("chunks").objectStore("chunks"); return Promise.all(keys.map(k => wrap(s.get(k)))); }
export async function wipeAll() {
  const d = await open(), t = d.transaction(["chunks", "docs", "kv"], "readwrite");
  for (const n of ["chunks", "docs", "kv"]) t.objectStore(n).clear(); return done(t);
}
