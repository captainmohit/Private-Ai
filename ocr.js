// Reads scanned pages (photos of paper) on the iPad with Tesseract, offline. Languages are files kept with the app.
import { openPdf, closePdf } from "./extract.js";
let worker = null, workerLangs = "";
function loadScript(src) { return new Promise((res, rej) => { if (globalThis.Tesseract) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("OCR engine missing")); document.head.append(s); }); }
async function getWorker(langs, logger) {
  if (worker && workerLangs === langs) return worker;
  if (worker) { await worker.terminate(); worker = null; }
  await loadScript(new URL("./tesseract.min.js", import.meta.url).href);
  const base = new URL("./", import.meta.url).href;
  worker = await globalThis.Tesseract.createWorker(langs, 1, { workerPath: base + "tesseract-worker.min.js", corePath: base, langPath: base, gzip: true, cacheMethod: "none", workerBlobURL: false, logger });
  workerLangs = langs; return worker;
}
export async function ocrPdfFile(file, { langs = "eng", onPage = () => {}, signal } = {}) {
  const doc = await openPdf(file), out = [], w = await getWorker(langs, () => {});
  for (let n = 1; n <= doc.numPages; n++) {
    if (signal && signal.aborted) throw new Error("cancelled");
    const page = await doc.getPage(n), base = page.getViewport({ scale: 1 });
    const scale = Math.min(3.5, Math.sqrt(12e6 / (base.width * base.height))), vp = page.getViewport({ scale });    // at most ~12 megapixels per page (iOS canvas limit)
    const canvas = document.createElement("canvas"); canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, canvas }).promise;
    const { data } = await w.recognize(canvas); out.push([n, data.text || ""]); onPage(n, doc.numPages);
    canvas.width = canvas.height = 0; page.cleanup();
  }
  closePdf(doc); return out;
}
export async function stopOcr() { if (worker) { await worker.terminate(); worker = null; } }
