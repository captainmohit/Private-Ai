import { Index, tokenize, normalize } from "./bm25.js";
import * as S from "./store.js";
import { importPack } from "./pack.js";
import { expand } from "./glossary.js";
import * as llm from "./llm.js";
import { pickable, planFiles, ingestPlan, removeDocument } from "./ingest.js";
import { parseUserRules } from "./intake.js";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Big files saved for offline use, one at a time, after the app is running (see prepareOffline)
const OFFLINE_EXTRA = ["tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js", "eng.traineddata.gz", "hin.traineddata.gz", "pan.traineddata.gz", ...("gpu" in navigator ? ["web-llm.js"] : [])];
const state = { offline: { done: 0, total: 0, ready: false, failed: 0 }, docs: [], docList: [], index: null, domain: null, doc: null, results: [], query: "", extra: JSON.parse(localStorage.getItem("pai.extra") || "{}") };

// ------------------------------------------------------------------ helpers
const fileName = p => p.split("/").pop().replace(/-AIC-AUTO-[\w-]*(?=\.\w+$)/, "");
const docCite = d => d.label || fileName(d.path);
function citeOf(c) {
  const d = state.docs[c.doc], ref = c.label || (c.page ? `p.${c.page}` : "");
  return [docCite(d), ref].filter(Boolean).join(" · ") + (d.ocr ? " (scanned, OCR)" : "");
}
const terms = q => [...new Set(tokenize(q))].filter(t => t.length > 1).sort((a, b) => b.length - a.length);
function highlight(text, qterms) {
  let out = esc(text);
  for (const t of qterms.slice(0, 12)) out = out.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "giu"), "<mark>$1</mark>");
  return out;
}
function snippet(text, qterms, len = 420) {
  const low = normalize(text); let at = -1;
  for (const t of qterms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, (at < 0 ? 0 : at) - 120), end = Math.min(text.length, start + len);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
function toast(msg) { $("info").textContent = msg; }
async function copy(text) { try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); } }
const fmtMB = b => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + " MB";
const current = () => state.docList.filter(d => d.status === "current" && d.count > 0);

// ------------------------------------------------------------------ library
async function loadLibrary() {
  const ready = await S.kvGet("ready"), list = await S.allDocs();
  state.docList = list.sort((a, b) => a.path.localeCompare(b.path)); state.docs = []; list.forEach(d => { state.docs[d.id] = d; });
  const data = ready ? await S.kvGet("index") : null;
  state.index = data && current().length ? new Index(data) : null;
  if (state.doc !== null && !(state.docs[state.doc] && state.docs[state.doc].status === "current")) state.doc = null;
  $("empty").hidden = !!state.index; $("search").hidden = !state.index; renderFilters();
}
function allowDocs() {
  const a = new Uint8Array(Math.max(1, ...state.docList.map(d => d.id + 1)));
  for (const d of current()) a[d.id] = (!state.domain || d.domain === state.domain) && (state.doc === null || state.doc === d.id) ? 1 : 0;
  return a;
}
function renderFilters() {
  const box = $("filters"); box.innerHTML = "";
  const domains = [...new Set(current().map(d => d.domain))].sort();
  const mk = (label, on, fn) => { const b = document.createElement("button"); b.className = "chip" + (on ? " on" : ""); b.textContent = label; b.onclick = fn; box.append(b); };
  mk("All", !state.domain && state.doc === null, () => { state.domain = null; state.doc = null; renderFilters(); rerun(); });
  for (const d of domains) mk(d, state.domain === d, () => { state.domain = d; state.doc = null; renderFilters(); rerun(); });
  mk(state.doc !== null ? "📄 " + docCite(state.docs[state.doc]).slice(0, 34) + " ✕" : "📄 One document…", state.doc !== null, () => { if (state.doc !== null) { state.doc = null; renderFilters(); rerun(); } else openDocs(); });
}
function openDocs() {
  const rows = current().map(d => `<div class="card"><div class="cite">${esc(docCite(d))}</div><div class="sub">${esc(d.folder)} · ${esc(d.name)}</div><div class="actions"><button data-i="${d.id}">Search only this</button></div></div>`).join("");
  sheet("Documents on this iPad (" + current().length + ")", rows || "<p>No documents.</p>");
  $("sheet-body").querySelectorAll("button[data-i]").forEach(b => b.onclick = () => { state.doc = +b.dataset.i; state.domain = null; closeSheet(); renderFilters(); rerun(); });
}

// ------------------------------------------------------------------ search
async function search(q) {
  state.query = q; if (!q.trim() || !state.index) return [];
  const ex = expand(q, state.extra);
  const r = state.index.search(ex.query, { allowDoc: allowDocs(), limit: 60 });
  const keys = r.hits.map(h => state.index.keys[h[0]]);
  const chunks = await S.getChunks(keys);
  const qn = normalize(q).trim(), multi = qn.split(/\s+/).length > 1;
  const rows = r.hits.map(([, s], i) => {
    const c = chunks[i]; let score = s;
    if (multi && normalize(c.text).includes(qn)) score *= 1.6;
    if (c.label && normalize(c.label).includes(qn)) score *= 1.4;
    return { id: keys[i], score, c };
  }).sort((a, b) => b.score - a.score).slice(0, 12);
  state.results = rows; state.added = ex.added; state.qterms = terms(ex.query);
  return rows;
}
function renderResults() {
  const box = $("results"); box.innerHTML = "";
  if (!state.results.length) { $("info").textContent = "No passages found. Try other words, or remove a filter."; return; }
  $("info").innerHTML = `${state.results.length} best passages` + (state.added && state.added.length ? ` · also searched: <i>${esc(state.added.join(", "))}</i>` : "");
  state.results.forEach((r, i) => {
    const d = state.docs[r.c.doc], div = document.createElement("div"); div.className = "card"; div.id = "r" + (i + 1);
    div.innerHTML = `<div class="cite">[${i + 1}] ${esc(citeOf(r.c))}</div><div class="sub">${esc(d.domain)} · ${esc(fileName(d.path))}</div>` +
      `<div class="snip">${highlight(snippet(r.c.text, state.qterms), state.qterms)}</div>` +
      `<div class="actions"><button data-a="read">Read more</button><button data-a="copy">Copy citation</button></div>`;
    div.querySelector('[data-a="read"]').onclick = () => readPassage(r.id);
    div.querySelector('[data-a="copy"]').onclick = async e => { await copy(citeOf(r.c)); e.target.textContent = "Copied ✓"; };
    box.append(div);
  });
  addAiButton();
}
async function rerun() { if (state.query) { $("results").innerHTML = ""; $("info").textContent = "Searching…"; await search(state.query); renderResults(); } }

async function readPassage(key) {
  const c = await S.getChunk(key); if (!c) return;
  const [prev, next] = await Promise.all([S.getChunk(key - 1), S.getChunk(key + 1)]);
  sheet(citeOf(c), `<div class="sub">${esc(state.docs[c.doc].path)}</div><div class="snip">${highlight(c.text, state.qterms || [])}</div>` +
    `<div class="actions"><button id="rp" ${prev && prev.doc === c.doc ? "" : "disabled"}>◀ Previous passage</button><button id="rn" ${next && next.doc === c.doc ? "" : "disabled"}>Next passage ▶</button><button id="rc">Copy citation</button></div>`);
  $("rp").onclick = () => readPassage(key - 1); $("rn").onclick = () => readPassage(key + 1);
  $("rc").onclick = async e => { await copy(citeOf(c)); e.target.textContent = "Copied ✓"; };
}

// ------------------------------------------------------------------ AI summary (optional, on device)
function addAiButton() {
  const old = document.getElementById("ai-btn"); if (old) old.remove();
  if (!state.results.length) return;
  const b = document.createElement("button"); b.id = "ai-btn"; b.className = "primary"; b.style.marginLeft = ".6rem"; b.textContent = "✨ Summarize";
  b.onclick = summarize; $("info").append(b);
}
let abort = null;
async function summarize() {
  const model = localStorage.getItem("pai.model");
  const st = await llm.webgpuStatus();
  if (!model || !st.ok || !(llm.loadedModel() || await llm.isDownloaded(model))) {
    openSettings(); toast(!st.ok ? st.note : "First download an AI model in Settings (needs internet once)."); return;
  }
  $("ai").hidden = false; const out = $("ai-answer"); out.textContent = "Loading the model…";
  try { await llm.load(model, p => { out.textContent = p.text || "Loading…"; }); } catch (e) { out.textContent = "Could not start the model: " + e.message; return; }
  const top = state.results.slice(0, 4).map(r => ({ cite: citeOf(r.c), text: r.c.text }));
  out.textContent = ""; abort = new AbortController(); $("ai-stop").hidden = false;
  try { for await (const t of llm.answer(state.query, top, abort.signal)) out.textContent += t; }
  catch (e) { out.textContent += "\n\n(" + e.message + ")"; }
  $("ai-stop").hidden = true;
  out.innerHTML = esc(out.textContent).replace(/\[(\d)\]/g, '<a href="#r$1">[$1]</a>');
}
$("ai-stop").onclick = () => abort && abort.abort();

// ------------------------------------------------------------------ sheets
function sheet(title, html) { $("sheet-title").textContent = title; $("sheet-body").innerHTML = html; $("sheet").hidden = false; }
function closeSheet() { $("sheet").hidden = true; }
$("sheet-close").onclick = closeSheet; $("sheet").onclick = e => { if (e.target.id === "sheet") closeSheet(); };

// ------------------------------------------------------------------ adding documents (all on the iPad)
let addAbort = null;
const STATUS = { save: ["new", "st-ok"], superseded: ["older version: kept, not searched", "st-old"], duplicate: ["already have it: skipped", "st-old"], failed: ["cannot be read", "st-bad"] };
function openAdd() {
  const ocrOn = localStorage.getItem("pai.ocr") !== "0";
  sheet("Add documents", `
    <div class="muted">Your files are read on this iPad and stay here. Large manuals take a few minutes: keep this screen open and the iPad awake.</div>
    <div class="row" style="margin:.6rem 0">
      <label class="filebtn primary">Choose files…<input id="pick-files" type="file" multiple accept=".pdf,.docx,.pptx,.xlsx,.txt,.md,.csv,.html,.htm,.json,.log" hidden></label>
      <label class="filebtn">Choose a folder…<input id="pick-dir" type="file" webkitdirectory multiple hidden></label>
    </div>
    <div class="row"><label><input id="opt-ocr" type="checkbox" ${ocrOn ? "checked" : ""}> Read scanned pages (OCR)</label></div>
    <div class="row muted">OCR languages: English and <label><input id="lang-hin" type="checkbox" ${localStorage.getItem("pai.hin") === "1" ? "checked" : ""}> Hindi</label> <label><input id="lang-pan" type="checkbox" ${localStorage.getItem("pai.pan") === "1" ? "checked" : ""}> Punjabi</label></div>
    <div id="add-status" class="muted" style="margin:.5rem 0"></div><div id="add-plan"></div>
    <div id="add-go" class="row"></div><div class="bar" id="add-bar" hidden><i></i></div><div id="add-log" class="muted"></div>`);
  const onPick = async e => {
    const files = pickable(e.target.files); e.target.value = "";
    if (!files.length) { $("add-status").textContent = "No supported documents were chosen (PDF, Word, PowerPoint, Excel, text)."; return; }
    localStorage.setItem("pai.ocr", $("opt-ocr").checked ? "1" : "0"); localStorage.setItem("pai.hin", $("lang-hin").checked ? "1" : "0"); localStorage.setItem("pai.pan", $("lang-pan").checked ? "1" : "0");
    $("add-plan").innerHTML = ""; $("add-go").innerHTML = "";
    let plan; try { plan = await planFiles(files, { userRules: parseUserRules(localStorage.getItem("pai.rules") || ""), onStatus: t => { $("add-status").textContent = t; } }); }
    catch (err) { $("add-status").textContent = "Could not read the selection: " + err.message; return; }
    showPlan(plan, files);
  };
  $("pick-files").onchange = onPick; $("pick-dir").onchange = onPick;
}
function showPlan(plan, files) {
  const rows = plan.map(d => { const [txt, cls] = STATUS[d.status] || [d.status, ""]; const note = d.reason || (d.ident ? d.ident.label : "");
    return `<tr><td>${esc(d.name)}<div class="muted">${fmtMB(d.size)}</div></td><td>${d.status === "duplicate" || d.status === "failed" ? "" : esc(d.folder)}</td><td class="${cls}">${esc(txt)}<div class="muted">${esc(note)}</div></td></tr>`; }).join("");
  const n = plan.filter(d => d.status === "save" || d.status === "superseded").length, big = plan.reduce((m, d) => m + (d.status === "save" ? d.size : 0), 0);
  $("add-status").textContent = `${files.length} file(s) chosen, ${fmtMB(files.reduce((m, f) => m + f.size, 0))}.` + (big > 100 * 1048576 ? " This will take several minutes." : "");
  $("add-plan").innerHTML = `<table class="plan"><tr><th>File</th><th>Goes to</th><th>Result</th></tr>${rows}</table>`;
  $("add-go").innerHTML = n ? `<button id="do-add" class="primary">Add ${n} document${n === 1 ? "" : "s"}</button>` : `<span class="muted">Nothing new to add.</span>`;
  if (n) $("do-add").onclick = () => runIngest(plan);
}
async function runIngest(plan) {
  const langs = ["eng", ...($("lang-hin").checked ? ["hin"] : []), ...($("lang-pan").checked ? ["pan"] : [])].join("+");
  addAbort = new AbortController(); const bar = $("add-bar"); bar.hidden = false; const fill = bar.firstElementChild;
  $("add-go").innerHTML = `<button id="do-cancel">Stop</button>`; $("do-cancel").onclick = () => addAbort.abort();
  const t0 = Date.now();
  const { results, index } = await ingestPlan(plan, { langs, ocr: $("opt-ocr").checked, signal: addAbort.signal, onProgress: p => {
    const frac = p.total ? p.done / p.total : 0; fill.style.width = (p.phase === "building the search index" ? frac : ((p.index - 1) + frac) / (p.of || 1)) * 100 + "%";
    $("add-status").textContent = p.phase === "building the search index" ? "Building the search index…" : `${p.index} of ${p.of}: ${p.file} (${p.phase}${p.total ? ` ${p.done}/${p.total}` : ""})`;
  } });
  await loadLibrary(); try { await navigator.storage.persist(); } catch { /* optional */ }
  fill.style.width = "100%";
  const added = results.filter(r => r.status === "added");
  $("add-status").innerHTML = `<b class="ok">Done in ${Math.round((Date.now() - t0) / 1000)} s.</b> ${added.length} document(s) added, ${added.reduce((m, r) => m + r.passages, 0).toLocaleString()} passages. The library is on this iPad and works offline.`;
  $("add-plan").innerHTML = `<table class="plan"><tr><th>File</th><th>Result</th><th>Passages</th></tr>${results.map(r => `<tr><td>${esc(r.name)}</td><td class="${r.status === "added" ? "st-ok" : r.status === "failed" || r.status === "no text" ? "st-bad" : "st-old"}">${esc(r.status)}${r.ocr ? " (OCR)" : ""}<div class="muted">${esc(r.reason || "")}</div></td><td>${r.passages || ""}</td></tr>`).join("")}</table>`;
  $("add-go").innerHTML = `<button id="add-more">Add more</button> <button id="add-close" class="primary">Done</button>`;
  $("add-more").onclick = openAdd; $("add-close").onclick = closeSheet;
}

// ------------------------------------------------------------------ settings
async function openSettings() {
  const st = await llm.webgpuStatus();
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  const cur = current(), old = state.docList.filter(d => d.status === "superseded"), bad = state.docList.filter(d => d.status === "unreadable"), passages = cur.reduce((n, d) => n + d.count, 0);
  const row = (d, tag = "") => `<div class="docrow"><div class="t"><b>${esc(docCite(d))}${tag}</b><span class="muted">${esc(d.folder)} · ${esc(d.name)}</span></div><button data-del="${d.id}" aria-label="Remove">✕</button></div>`;
  const modelRows = !st.ok ? "" : (await Promise.all(llm.MODELS.map(async x => {     // only touch the AI library when the device can use it
    const have = await llm.isDownloaded(x.key);
    return `<div class="model"><b>${x.name}</b> · ${x.size}${have ? ' · <span class="ok">downloaded</span>' : ""}${llm.loadedModel() === x.key ? " · <b>in use</b>" : ""}<div class="muted">${x.note}</div>
      <div class="actions"><button data-m="${x.key}" data-a="use" ${st.ok ? "" : "disabled"}>${have ? "Use this model" : "Download & use (internet)"}</button>${have ? `<button data-m="${x.key}" data-a="del">Delete</button>` : ""}</div></div>`;
  }))).join("");
  const extra = Object.entries(state.extra).map(([k, v]) => `${k} = ${v}`).join("\n");
  sheet("Settings", `
    <div class="sect">Documents</div>
    <div id="lib-info">${cur.length ? `${cur.length} documents · ${passages.toLocaleString()} passages` : "No documents yet."}</div>
    <div class="row" style="margin:.4rem 0"><button id="btn-add" class="primary">Add documents…</button></div>
    ${cur.map(d => row(d)).join("")}
    ${old.length ? `<div class="sect">Older versions (kept, not searched)</div>${old.map(d => row(d, " <span class='tag'>older</span>")).join("")}` : ""}
    ${bad.length ? `<div class="sect">Could not be read</div><div class="muted">These had no readable text (a scan?). Remove them, turn on OCR in Add documents, and add them again.</div>${bad.map(d => row(d, " <span class='tag'>no text</span>")).join("")}` : ""}
    <div class="sect">On-device AI (optional)</div><div class="muted">${esc(st.note)} The library search works either way.</div>${modelRows}<div id="mprog" class="muted"></div>
    <div class="sect">Extra words (Hindi/Punjabi → English)</div><div class="muted">One per line, like <code>उड़ान = flight</code>.</div>
    <textarea id="extra" class="field" rows="3">${esc(extra)}</textarea><button id="saveextra">Save words</button>
    <div class="sect">Sorting rules (advanced)</div><div class="muted">Your own rules, checked first. One per line: <code>name_regex, head_regex, Folder/Path, label</code></div>
    <textarea id="rules" class="field" rows="3" placeholder="cabin, , Airline-Pilot/Cabin, ">${esc(localStorage.getItem("pai.rules") || "")}</textarea><button id="saverules">Save rules</button>
    <div class="sect">Library from a Mac (optional)</div><div class="muted">Only if you also use the Mac version: copy its library here instead of adding files.</div>
    <label class="muted">Mac address</label><input id="mac" class="field" value="${esc(localStorage.getItem("pai.mac") || "")}" placeholder="https://your-mac.local:8443" autocapitalize="none" spellcheck="false">
    <label class="muted">Passcode</label><input id="pass" class="field" type="password" autocomplete="off">
    <div class="row"><button id="upd">Update library from Mac</button><label class="row"><button id="pick">Import a pack file…</button><input id="file" type="file" accept=".pack" hidden></label></div>
    <div class="bar" id="bar" hidden><i></i></div><div id="prog" class="muted"></div>
    <div class="sect">Offline copy</div><div class="muted">${state.offline.ready ? '<span class="ok">Complete: the app, the OCR engine and its language data are saved on this iPad.</span>' : `Saving the large files for offline use: ${state.offline.done} of ${state.offline.total}. Keep the app open on Wi-Fi until this says Complete.`}</div>
    <div class="sect">Storage</div><div class="muted">${est ? `${fmtMB(est.usage)} used of about ${fmtMB(est.quota)} available.` : ""} ${persisted ? '<span class="ok">Protected from automatic clean-up.</span>' : ""}</div>
    ${persisted ? "" : '<button id="persist">Protect my data from clean-up</button>'}
    <div class="sect">About</div><div class="muted">Everything stays on this iPad. Add this page to your Home Screen (Share → Add to Home Screen) so iPadOS keeps it. The optional AI is a small model and can be wrong: check the passages it cites. For legal, DGCA and operational decisions the source document is the authority.</div>
    <div class="row" style="margin-top:1rem"><button id="wipe">Remove all documents from this iPad</button></div>`);
  wireSettings();
}
function wireSettings() {
  const prog = t => { $("prog").textContent = t; };
  $("btn-add").onclick = openAdd;
  $("sheet-body").querySelectorAll("button[data-del]").forEach(b => b.onclick = async () => {
    const d = state.docs[+b.dataset.del]; if (!d || !confirm(`Remove "${docCite(d)}" from this iPad?`)) return;
    await removeDocument(d.id); await loadLibrary(); openSettings();
  });
  const importFrom = async (stream, total) => {
    $("bar").hidden = false; const bar = $("bar").firstElementChild;
    try {
      await importPack(stream, { totalBytes: total, onProgress: p => { bar.style.width = (p.total ? Math.min(100, 100 * p.done / p.total) : 0) + "%"; prog(p.phase === "index" ? "Building the search index…" : `Storing passages ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`); } });
      await loadLibrary(); prog("Done. The library is on this iPad and works offline."); bar.style.width = "100%";
    } catch (e) { prog("Failed: " + e.message); await loadLibrary(); }
  };
  $("upd").onclick = async () => {
    const base = $("mac").value.replace(/\/+$/, ""), pass = $("pass").value; localStorage.setItem("pai.mac", base); prog("Contacting your Mac…");
    let resp; try { resp = await fetch(base + "/library.pack", { headers: { "X-Passcode": pass }, cache: "no-store" }); } catch { prog("Can't reach your Mac."); return; }
    if (resp.status === 401) { prog("Wrong passcode."); return; }
    if (!resp.ok) { prog("The Mac has no library pack yet."); return; }
    await importFrom(resp.body, Number(resp.headers.get("content-length") || 0));
  };
  $("pick").onclick = () => $("file").click();
  $("file").onchange = async e => { const f = e.target.files[0]; if (f) { prog("Reading " + f.name + "…"); await importFrom(f.stream(), f.size); } };
  $("saveextra").onclick = () => { const x = {}; for (const line of $("extra").value.split("\n")) { const i = line.indexOf("="); if (i > 0) x[line.slice(0, i).trim()] = line.slice(i + 1).trim(); } state.extra = x; localStorage.setItem("pai.extra", JSON.stringify(x)); $("saveextra").textContent = "Saved ✓"; };
  $("saverules").onclick = () => { localStorage.setItem("pai.rules", $("rules").value); $("saverules").textContent = "Saved ✓"; };
  if ($("persist")) $("persist").onclick = async () => { await navigator.storage.persist(); openSettings(); };
  $("wipe").onclick = async () => { if (confirm("Remove ALL documents from this iPad? You can add them again from Files.")) { await S.wipeAll(); await loadLibrary(); closeSheet(); } };
  $("sheet-body").querySelectorAll("button[data-m]").forEach(b => b.onclick = async () => {
    const id = b.dataset.m;
    if (b.dataset.a === "del") { await llm.deleteModel(id); if (localStorage.getItem("pai.model") === id) localStorage.removeItem("pai.model"); openSettings(); return; }
    try { await llm.load(id, p => { $("mprog").textContent = p.text || ""; }); localStorage.setItem("pai.model", id); $("mprog").textContent = "Ready. Tap ✨ Summarize under your search results."; }
    catch (e) { $("mprog").textContent = "Could not load: " + e.message; }
  });
}
$("settings-btn").onclick = openSettings; $("btn-add-empty").onclick = openAdd;

// ------------------------------------------------------------------ start
$("form").onsubmit = async e => {
  e.preventDefault(); const q = $("q").value;
  $("ai").hidden = true; $("results").innerHTML = ""; $("info").textContent = "Searching…";
  await search(q); renderResults(); $("q").blur();
};
function net() { const b = $("net"); b.textContent = navigator.onLine ? "online" : "offline"; b.className = "badge" + (navigator.onLine ? "" : " off"); }
addEventListener("online", net); addEventListener("offline", net);
async function prepareOffline() {
  const o = state.offline; o.total = OFFLINE_EXTRA.length; o.done = 0; o.failed = 0; o.ready = false;
  try {
    const name = (await caches.keys()).find(k => k.startsWith("pai-shell-")); if (!name) return;
    const cache = await caches.open(name);
    for (const f of OFFLINE_EXTRA) {
      try { if (!(await cache.match(f))) { if (!navigator.onLine) { o.failed++; continue; } await cache.add(f); } o.done++; } catch { o.failed++; }
      $("net").title = `Offline copy: ${o.done} of ${o.total} large files saved`;
    }
  } finally { o.ready = o.done === o.total; $("net").title = o.ready ? "Everything needed offline is saved on this iPad" : `Offline copy incomplete (${o.done} of ${o.total}); reopen the app online to finish`; }
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).then(prepareOffline).catch(() => {});
net(); loadLibrary();
window.PAI = { state, search, renderResults, llm, loadLibrary, openAdd };
