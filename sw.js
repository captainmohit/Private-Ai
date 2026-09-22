// Makes the app work with no network: everything it needs is stored on the iPad when it is first opened.
const VERSION = "0939b22b53f2";
const CACHE = "pai-shell-" + VERSION;
// Only the small essentials are stored at install (about 3 MB). The big optional files (OCR engine, language data, AI library) are
// saved one at a time by the app afterwards; downloading 26 MB all at once is fragile.
const SHELL = ["./", "index.html", "styles.css", "app.js", "bm25.js", "store.js", "library.js", "extract.js", "ocr.js", "ingest.js", "intake.js", "chunker.js", "pack.js", "llm.js", "glossary.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "pdf.min.mjs", "pdf.worker.min.mjs", "jszip.min.js", "tesseract.min.js", "tesseract-worker.min.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("pai-shell-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;            // model downloads etc. are handled elsewhere
  if (u.pathname.endsWith("/library.pack") || u.pathname.endsWith("/library.json")) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try { const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r; }
    catch (err) { if (e.request.mode === "navigate") return (await c.match("index.html")) || Response.error(); throw err; }
  }));
});
