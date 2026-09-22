// Reads text out of documents on the iPad itself: PDF (pdf.js), Word/PowerPoint/Excel (JSZip + XML), text, HTML.
import { redact } from "./chunker.js";
export const SUPPORTED = ["pdf", "docx", "pptx", "xlsx", "txt", "md", "csv", "html", "htm", "json", "log"];
export const extOf = name => (name.split(".").pop() || "").toLowerCase();

let pdfjs = null;
export async function pdfLib() {
  if (!pdfjs) { pdfjs = await import("./pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href; }
  return pdfjs;
}
// Big manuals are read in slices as needed, so the whole file (hundreds of MB) is never held in memory.
export async function openPdf(file) {
  const m = await pdfLib();
  const opts = { useSystemFonts: true, isEvalSupported: false };
  if (file.size <= 60 * 1048576) return m.getDocument({ data: new Uint8Array(await file.arrayBuffer()), ...opts }).promise;
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const transport = new m.PDFDataRangeTransport(file.size, head);
  transport.requestDataRange = (b, e) => { file.slice(b, e).arrayBuffer().then(buf => transport.onDataRange(b, new Uint8Array(buf))); };
  return m.getDocument({ range: transport, disableAutoFetch: true, disableStream: true, ...opts }).promise;
}
// Releases a PDF's memory (the loading task owns it in this pdf.js version)
export function closePdf(doc) { try { if (doc.loadingTask && doc.loadingTask.destroy) doc.loadingTask.destroy(); else if (doc.destroy) doc.destroy(); } catch { /* already closed */ } }
export async function pdfPageText(doc, n) {
  const page = await doc.getPage(n), c = await page.getTextContent(); let out = "";
  for (const it of c.items) { out += it.str; if (it.hasEOL) out += "\n"; }
  page.cleanup(); return out;
}

let zipLib = null;
async function JSZip() { if (!zipLib) { await import("./jszip.min.js"); zipLib = globalThis.JSZip || window.JSZip; } return zipLib; }
const xml = s => new DOMParser().parseFromString(s, "application/xml");
const kids = (el, name) => [...el.getElementsByTagName("*")].filter(e => e.localName === name);
const direct = (el, name) => [...el.children].filter(e => e.localName === name);

async function readDocx(file) {
  const z = await (await JSZip()).loadAsync(file), doc = xml(await z.file("word/document.xml").async("string"));
  const body = kids(doc, "body")[0], lines = [], tables = [];
  const paraText = p => { let t = ""; for (const n of kids(p, "t")) t += n.textContent; return t; };
  for (const el of body ? [...body.children] : []) {
    if (el.localName === "p") lines.push(paraText(el));
    else if (el.localName === "tbl") for (const tr of kids(el, "tr")) tables.push(direct(tr, "tc").map(tc => kids(tc, "p").map(paraText).join(" ").trim()).join(" | "));
  }
  return [[null, [...lines, ...tables].join("\n")]];
}
async function readPptx(file) {
  const z = await (await JSZip()).loadAsync(file);
  const num = n => parseInt((n.match(/(\d+)\.xml$/) || [0, 0])[1], 10);
  const slides = Object.keys(z.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const out = [];
  for (const [i, name] of slides.entries()) {
    const doc = xml(await z.file(name).async("string")), parts = [];
    for (const sp of kids(doc, "sp")) { const t = direct(kids(sp, "txBody")[0] || sp, "p").map(p => kids(p, "t").map(x => x.textContent).join("")).filter(Boolean).join("\n"); if (t.trim()) parts.push(t.trim()); }
    for (const tbl of kids(doc, "tbl")) for (const tr of kids(tbl, "tr")) { const cells = direct(tr, "tc").map(tc => kids(tc, "t").map(x => x.textContent).join("").trim()).filter(Boolean); if (cells.length) parts.push(cells.join(" | ")); }
    const notes = z.file(`ppt/notesSlides/notesSlide${num(name)}.xml`);
    if (notes) { const nd = xml(await notes.async("string")); const t = kids(nd, "sp").filter(sp => /body/.test(sp.outerHTML || "") || true).map(sp => kids(sp, "t").map(x => x.textContent).join("")).join(" ").trim(); if (t) parts.push("Speaker notes: " + t.replace(/^\d+\s*$/, "")); }
    out.push([i + 1, parts.join("\n\n")]);
  }
  return out;
}
async function readXlsx(file) {
  const z = await (await JSZip()).loadAsync(file);
  const shared = z.file("xl/sharedStrings.xml") ? kids(xml(await z.file("xl/sharedStrings.xml").async("string")), "si").map(si => kids(si, "t").map(t => t.textContent).join("")) : [];
  const wb = xml(await z.file("xl/workbook.xml").async("string")), names = kids(wb, "sheet").map(s => s.getAttribute("name"));
  const sheets = Object.keys(z.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]));
  const col = ref => [...ref.replace(/\d+/g, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const out = [];
  for (const [i, name] of sheets.entries()) {
    const doc = xml(await z.file(name).async("string")), rows = [];
    for (const row of kids(doc, "row")) {
      const cells = []; for (const c of direct(row, "c")) {
        const t = c.getAttribute("t"), v = direct(c, "v")[0]; let val = "";
        if (t === "s" && v) val = shared[parseInt(v.textContent, 10)] ?? ""; else if (t === "inlineStr") val = kids(c, "t").map(x => x.textContent).join(""); else if (v) val = v.textContent;
        cells[col(c.getAttribute("r") || "A1") - 1] = val;
      }
      const line = Array.from(cells, x => x ?? "").join("\t"); if (line.replace(/[\t ]/g, "")) rows.push(line);
    }
    out.push([null, `Sheet: ${names[i] || "Sheet" + (i + 1)}\n\n` + rows.join("\n\n")]);
  }
  return out;
}
async function readText(file) {
  const buf = await file.arrayBuffer();
  for (const enc of ["utf-8", "utf-16le", "windows-1252"]) { try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch { /* try the next */ } }
  return new TextDecoder("utf-8").decode(buf);
}
function htmlText(src) {
  const d = new DOMParser().parseFromString(src, "text/html"); d.querySelectorAll("script,style").forEach(e => e.remove());
  return d.body ? d.body.textContent : "";
}

// Non-PDF documents: [[pageOrNull, text]]
export async function readOffice(file) {
  const e = extOf(file.name);
  if (e === "docx") return readDocx(file);
  if (e === "pptx") return readPptx(file);
  if (e === "xlsx") return readXlsx(file);
  if (e === "html" || e === "htm") return [[null, htmlText(await readText(file))]];
  return [[null, redact(await readText(file))]];
}
// Text of the first pages, used to recognise the document and decide where it goes
export async function headText(file) {
  const e = extOf(file.name);
  try {
    if (e === "pdf") { const d = await openPdf(file); const t = []; for (let i = 1; i <= Math.min(3, d.numPages); i++) t.push(await pdfPageText(d, i)); const n = d.numPages; closePdf(d); return { head: t.join(" ").replace(/\s+/g, " "), pages: n }; }
    const pages = await readOffice(file); return { head: pages.slice(0, 3).map(p => p[1]).join(" ").replace(/\s+/g, " ").slice(0, 6000), pages: pages.length };
  } catch (err) { return { head: "", pages: 0, error: String(err.message || err) }; }
}
// Quick fingerprint (size + first and last megabyte) to spot the same file added twice
export async function fingerprint(file) {
  const a = new Uint8Array(await file.slice(0, 1048576).arrayBuffer()), b = new Uint8Array(await file.slice(Math.max(0, file.size - 1048576)).arrayBuffer());
  const all = new Uint8Array(a.length + b.length + 16); all.set(a, 0); all.set(b, a.length); new DataView(all.buffer).setFloat64(a.length + b.length, file.size);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...h.slice(0, 12)].map(x => x.toString(16).padStart(2, "0")).join("") + "-" + file.size;
}
