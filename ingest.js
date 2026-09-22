// Adds documents to the library on the iPad: read the first pages, decide the folder and version, then (after you confirm)
// read every page, OCR scans, cut into cited passages, store, and retire older versions.
import { headText, fingerprint, openPdf, pdfPageText, closePdf, readOffice, extOf, SUPPORTED } from "./extract.js";
import { makeChunks, looksScanned } from "./chunker.js";
import { planBatch, docMeta } from "./intake.js";
import { ocrPdfFile } from "./ocr.js";
import * as S from "./store.js";
import { storeDocument, supersede, rebuildIndex } from "./library.js";

export const pickable = files => [...files].filter(f => SUPPORTED.includes(extOf(f.name)) && !f.name.startsWith("."));

// Phase 1 (fast): what is each file, where does it go, is it new, older, or a duplicate?
export async function planFiles(files, { userRules = [], forceFolder = null, onStatus = () => {} } = {}) {
  const docs = await S.allDocs(), fps = {};
  for (const d of docs) if (d.fp && (d.status === "current" || d.status === "superseded")) fps[d.fp] = d.name;   // an unreadable earlier attempt does not count
  const items = [];
  for (const [i, f] of files.entries()) {
    onStatus(`Reading ${i + 1} of ${files.length}: ${f.name}`);
    const [h, fp] = await Promise.all([headText(f), fingerprint(f)]);
    items.push({ name: f.name, head: h.head, fp, size: f.size, pages: h.pages, error: h.error, file: f });
  }
  const library = docs.map(d => ({ id: d.id, family: d.family, order: d.order, status: d.status }));
  const plan = planBatch(items, library, fps, { userRules, forceFolder });
  for (const d of plan) if (d.item.error && d.status !== "duplicate") { d.status = "failed"; d.reason = "could not be opened: " + d.item.error; }
  return plan;
}

export async function keepAwake() {
  try { const l = await navigator.wakeLock.request("screen"); return () => l.release().catch(() => {}); } catch { return () => {}; }
}

// Phase 2 (slow for big manuals): read, OCR, chunk and store
export async function ingestPlan(plan, { langs = "eng", ocr = true, onProgress = () => {}, signal } = {}) {
  const todo = plan.filter(d => d.status === "save" || d.status === "superseded"), results = [];
  const release = await keepAwake();
  try {
    for (const [k, d] of todo.entries()) {
      const f = d.item.file, res = { name: d.name, status: d.status, folder: d.folder, reason: d.reason, passages: 0, ocr: false };
      const say = (phase, done, total) => onProgress({ file: d.name, index: k + 1, of: todo.length, phase, done, total });
      try {
        if (signal && signal.aborted) throw new Error("cancelled");
        const id = await S.reserveDocId();
        const base = { id, name: d.name, folder: d.folder, path: `${d.folder}/${d.name}`, domain: d.folder.split("/")[0], label: d.ident ? d.ident.label : "",
                       family: d.ident ? d.ident.family : "", order: d.ident ? d.ident.order : null, style: d.ident ? d.ident.style || "" : "", fp: d.fp, size: d.size,
                       added: Date.now(), pages: d.item.pages || 0, ocr: false };
        if (d.status === "superseded") { await S.commitDoc({ ...base, status: "superseded", first: 0, count: 0 }, null); results.push(res); continue; }
        let pages;
        if (extOf(f.name) === "pdf") {
          const pdf = await openPdf(f), n = pdf.numPages; pages = [];
          for (let i = 1; i <= n; i++) {
            if (signal && signal.aborted) throw new Error("cancelled");
            pages.push([i, await pdfPageText(pdf, i)]);
            if (i % 20 === 0 || i === n) say("reading pages", i, n);
          }
          closePdf(pdf);
          if (ocr && looksScanned(pages.map(p => p[1]))) {
            say("scanned: reading with OCR", 0, n);
            try { pages = await ocrPdfFile(f, { langs, signal, onPage: (i, m) => say("scanned: reading with OCR", i, m) }); base.ocr = true; res.ocr = true; }
            catch (e) { if (e.message === "cancelled") throw e; throw new Error("this is a scan and the OCR step failed (" + e.message + ")"); }
          }
        } else pages = await readOffice(f);
        const meta = docMeta(pages.slice(0, 3).map(p => p[1]).join(" "), d.name);
        if (meta) { base.label = meta.label || base.label; base.family = meta.family || base.family; base.order = meta.order || base.order; base.style = meta.style || base.style; }
        const rows = makeChunks(pages, base.path, meta);
        if (!rows.length) { await S.commitDoc({ ...base, status: "unreadable", first: 0, count: 0 }, null); res.status = "no text"; res.reason = "no readable text (a scan? turn on OCR)"; results.push(res); continue; }
        await storeDocument({ ...base, status: "current" }, rows, p => say("saving", p.stored, p.total));
        res.passages = rows.length; res.status = "added";
        if (d.replaces.length) { const all = await S.allDocs(); for (const old of all.filter(x => d.replaces.includes(x.id))) await supersede(old); res.reason = `replaced ${d.replaces.length} older version(s)`; }
      } catch (e) { res.status = e.message === "cancelled" ? "cancelled" : "failed"; res.reason = e.message; }
      results.push(res);
      if (res.status === "cancelled") break;
    }
    onProgress({ phase: "building the search index", done: 0, total: 1 });
    const idx = await rebuildIndex(p => onProgress({ phase: "building the search index", done: p.done, total: p.total }));
    return { results, index: idx };
  } finally { release(); }
}

export async function removeDocument(id) {
  const doc = (await S.allDocs()).find(d => d.id === id); if (!doc) return;
  await S.deleteDoc(doc); return rebuildIndex();
}
