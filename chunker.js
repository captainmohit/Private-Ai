// Splits a document into passages and gives each an exact reference (FCOM section code, manual chapter/revision/page, CAR paragraph,
// Act section, slide number). This is a port of the Mac version and is checked against it on real documents.
export const CHUNK_CHARS = 1000, CHUNK_OVERLAP = 150;
// Python's idea of whitespace (JavaScript's trim() and \s also treat the invisible byte-order mark U+FEFF as a space; Python does not)
const WS_CHARS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_LEAD = new RegExp(`^[${WS_CHARS}]+`), WS_TRAIL = new RegExp(`[${WS_CHARS}]+$`), WS_RUN = new RegExp(`[${WS_CHARS}]+`, "g"), PARA_SPLIT = new RegExp(`\\n[${WS_CHARS}]*\\n`);
export const pyStrip = s => s.replace(WS_LEAD, "").replace(WS_TRAIL, "");
const NL = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
export function splitLines(text) { const p = text.split(NL); if (p.length && p[p.length - 1] === "") p.pop(); return p; }

export function chunkText(text, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  text = text.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  const chunks = []; let buf = "";
  const emit = () => { if (pyStrip(buf)) chunks.push(pyStrip(buf)); buf = ""; };
  for (let para of text.split(PARA_SPLIT)) {
    para = pyStrip(para); if (!para) continue;
    while (para.length > size) {
      emit();
      const win = para.slice(0, size);
      let cut = Math.max(win.lastIndexOf("\n"), win.lastIndexOf(" "));
      if (cut < Math.floor(size / 2)) cut = size;
      chunks.push(pyStrip(para.slice(0, cut)));
      para = para.slice(cut - overlap);
    }
    if (buf.length + para.length + 2 <= size) buf = buf ? `${buf}\n\n${para}` : para;
    else {
      const old = buf; emit();
      let tail = old.slice(-overlap);
      tail = tail.includes(" ") ? tail.slice(tail.indexOf(" ") + 1) : "";
      buf = tail ? `${tail}\n\n${para}` : para;
    }
  }
  emit();
  return chunks.filter(c => pyStrip(c).length > 20);
}

const LEADERS = /\.{3,}\s*\d{1,4}\s*$/;
// A contents page only repeats titles ("Title ..... 45") and would outrank the real text.
export function isToc(text) {
  const lines = splitLines(text).filter(l => pyStrip(l));
  const n = lines.filter(l => LEADERS.test(l)).length;
  return n >= 2 && n >= 0.4 * lines.length;
}

const CAR_TOKENS = new Set(["car", "cars"]);
const ACT = new Set(["act", "acts", "sanhita", "adhiniyam", "bns", "bnss", "bsa"]);
const RULE = new Set(["rules", "rule"]);
const STATUTE = new Set([...ACT, ...RULE, ...CAR_TOKENS, "dsear", "rte", "regulations"]);
const HEAD_WORD = /^\s*((?:Section|Sec\.|Rule|Regulation|Article)\s+\d+[A-Za-z]{0,2})\b/i;
const HEAD_NUM = /^\s*(\d{1,3}[A-Z]{0,2})\.\s+[A-Z("'\u201c]/;
const HEAD_DEC = /^\s*(\d{1,2}(?:\.\d{1,2}){1,3})\s*$|^\s*(\d{1,2}(?:\.\d{1,2}){1,3})\s+[A-Z("'\u201c]/;
const TOC_LINE = /(\.{3,}|\s{2,}|\t)\s*\d{1,4}\s*$/;
const tokensOf = rel => new Set(rel.toLowerCase().match(/[a-z0-9]+/g) || []);
const hasAny = (set, other) => { for (const x of other) if (set.has(x)) return true; return false; };
export function statuteLike(rel) { return hasAny(tokensOf(rel), STATUTE); }
function unitOf(rel) {
  const t = tokensOf(rel);
  if (hasAny(t, CAR_TOKENS)) return "Para";
  if (hasAny(t, RULE) && !hasAny(t, new Set([...ACT, "dsear"]))) return "Rule";
  if (hasAny(t, ACT) && !hasAny(t, new Set([...RULE, "dsear"]))) return "Section";
  return "Section/Rule";
}
function heading(line, unit) {
  if (TOC_LINE.test(line)) return null;
  if (unit === "Para") {
    let m = HEAD_DEC.exec(line); if (m) return `Para ${m[1] || m[2]}`;
    m = HEAD_NUM.exec(line); return m ? `Para ${m[1]}` : null;
  }
  let m = HEAD_WORD.exec(line);
  if (m) return m[1].replace(/\s+/g, " ").replace("Sec.", "Section");
  m = HEAD_NUM.exec(line); return m ? `${unit} ${m[1]}` : null;
}
// [[page, text]] -> [[page, label, block]], carrying the current Section/Rule across pages
export function splitSections(pages, unit) {
  const out = []; let label = null;
  for (const [page, text] of pages) {
    let buf = [], cur = label;
    for (const line of splitLines(text)) {
      const h = heading(line, unit);
      if (h) {
        if (buf.reduce((n, x) => n + x.length, 0) >= 120) { out.push([page, cur, buf.join("\n")]); buf = []; }
        cur = h;
      }
      buf.push(line);
    }
    out.push([page, cur, buf.join("\n")]); label = cur;
  }
  return out;
}

const FCOM_CODE = /FLEET\s+([A-Z]{2,5}-[A-Za-z0-9_\-]+)\s+P\s*(\d+)\s*\/\s*(\d+)/;
const MANUAL_HDR = /(CHAPTER|PART|SECTION)\s*[-\u2013]\s*(\d+)\s*(?:SECTION\s*[-\u2013]\s*([\d.]+))?\s+(.{3,90}?)\s+ISSUE-(\d+)\s+REV-(\d+)\s+(\d{1,2}\s+[A-Z]{3}\s+\d{4})\s+([\dA-Za-z.]+-\d+)/;
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
export const MONTHS = Object.fromEntries(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].map((m, i) => [m, i + 1]));
const ws = s => s.replace(WS_RUN, " ");

// Python's str.title(): every run of letters starts with a capital
export function pyTitle(s) {
  let out = "", prev = false;
  for (const ch of s) { const L = /\p{L}/u.test(ch); out += L ? (prev ? ch.toLowerCase() : ch.toUpperCase()) : ch; prev = L; }
  return out;
}

export function orderOf(date, issue = 0, rev = 0, ver = 0) {
  const y = /^\d{4}/.test(date || "") ? parseInt(date.slice(0, 4), 10) : 0;
  const ymd = date ? parseInt(date.replace(/-/g, "").slice(0, 8).padEnd(8, "0"), 10) : 0;
  return [ymd || y * 10000, parseInt(issue || 0, 10) || 0, parseInt(rev || 0, 10) || 0, Math.round(parseFloat(ver || 0) * 100)];
}

// A DGCA Civil Aviation Requirement, recognised from its header
export function carMeta(text) {
  const head = text.slice(0, 3000).replace(/[\s\u00b7]+/g, " ");
  const m0 = /CIVIL AVIATION REQUIREMENTS?\b/i.exec(head);
  if (!m0) return null;
  const seg = head.slice(m0.index, m0.index + 900);
  const sec = /SECTION\s*[-\u2013\u2014]?\s*(\d{1,2})\b/i.exec(seg);
  if (!sec) return null;
  const series = /[Ss][Ee][Rr][Ii][Ee][Ss]\s*['"\u2018\u2019\u201c]?([A-Z]{1,2})\b/.exec(seg);
  const part = /[Pp][Aa][Rr][Tt]\s+([IVX]{1,5}|\d{1,2})\b/.exec(seg);
  const issue = /[Ii][Ss][Ss][Uu][Ee]\s+([IVX]{1,5}|\d{1,2})\b/.exec(seg);
  const date = /DATED?\s*[:.]?\s*(\d{1,2})(?:ST|ND|RD|TH)?[\s.,-]+([A-Z]{3,9})[\s.,-]+(\d{4})/i.exec(seg);
  let iso = "";
  if (date && MONTHS[date[2].slice(0, 3).toUpperCase()]) iso = `${date[3]}-${String(MONTHS[date[2].slice(0, 3).toUpperCase()]).padStart(2, "0")}-${String(parseInt(date[1], 10)).padStart(2, "0")}`;
  else { const d2 = /DATED?\s*[:.]?\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})/i.exec(seg); if (d2) iso = `${d2[3]}-${String(parseInt(d2[2], 10)).padStart(2, "0")}-${String(parseInt(d2[1], 10)).padStart(2, "0")}`; }
  const subj = /Subject\s*:\s*(.{10,220}?)(?:\s\d{1,2}\.\s|$)/i.exec(head);
  const name = `CAR Section ${sec[1]}` + (series ? ` Series ${series[1]}` : "") + (part ? ` Part ${part[1]}` : "");
  const issueNo = issue ? (ROMAN[issue[1]] ?? (/^\d+$/.test(issue[1]) ? parseInt(issue[1], 10) : 0)) : 0;
  return { car: name, section: parseInt(sec[1], 10), series: series ? series[1] : "", part: part ? part[1] : "", issue: issue ? issue[1] : "",
           issue_no: issueNo, date: iso, subject: subj ? subj[1].replace(/^[ .]+|[ .]+$/g, "") : "" };
}

function pageLabel(text, style) {
  const head = ws(text.slice(0, 700));
  if (style === "fcom") { const m = FCOM_CODE.exec(head) || FCOM_CODE.exec(ws(text.slice(-400))); return m ? m[1] : null; }
  const m = MANUAL_HDR.exec(head); if (!m) return null;
  const [, kind, num, sec, title, , rev, date, pg] = m;
  return `${pyTitle(kind)} ${num}${sec ? ` section ${sec}` : ""} ${pyTitle(title).replace("&And", "&")}, rev ${rev} (${date}), p.${pg}`;
}

// [[page, text]] -> [[page, label, text]] ready to index
export function makeChunks(pages, rel, meta = null) {
  const style = (meta && meta.style) || "";
  const notToc = rows => rows.filter(r => !isToc(r[2]));
  if (rel.toLowerCase().endsWith(".pptx")) {
    const rows = []; for (const [pg, text] of pages) for (const c of chunkText(text)) rows.push([null, `Slide ${pg}`, `[Slide ${pg}] ${c}`]);
    return notToc(rows);
  }
  if (style === "fcom" || style === "manual") {
    const rows = [];
    for (const [pg, text] of pages) { const label = pageLabel(text, style); for (const c of chunkText(text)) rows.push([pg, label, label ? `[${label}] ${c}` : c]); }
    return notToc(rows);
  }
  const isCar = !!(meta && meta.car);
  let rows = [];
  if (!(statuteLike(rel) || isCar)) { for (const [pg, text] of pages) for (const c of chunkText(text)) rows.push([pg, null, c]); }
  else for (const [pg, label, block] of splitSections(pages, isCar ? "Para" : unitOf(rel))) for (const c of chunkText(block)) rows.push([pg, label, label ? `[${label}] ${c}` : c]);
  return notToc(rows);
}
export const looksScanned = (texts, maxPages = 300) => { const n = texts.length, empty = texts.filter(t => pyStrip(t || "").length < 15).length; return n > 0 && n <= maxPages && empty >= 0.8 * n; };

const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED KEY]"], [/AIza[0-9A-Za-z_\-]{35}/g, "[REDACTED KEY]"],
  [/("?(?:private_key|client_secret|api[_-]?key|secret|password|passwd|token)"?\s*[:=]\s*)["'][^"'\n]{6,}["']/gi, '$1"[REDACTED]"'],
];
export function redact(text) { for (const [re, r] of SECRETS) text = text.replace(re, r); return text; }
