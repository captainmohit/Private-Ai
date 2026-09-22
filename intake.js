// Decides where each new document belongs, which version it is, and whether it duplicates one you already have.
// A port of the Mac version (intake.py), checked against it on real documents.
import { orderOf, MONTHS } from "./chunker.js";

// [name regex, head regex, folder, label, versioned]. Checked in order; the name has _ and - as spaces.
export const DEFAULT_RULES = [
  ["a350.*fcom", "reference:\\s*aic a350 fleet fcom", "Airline-Pilot/Airbus-A350/FCOM", "A350 FCOM", true],
  ["\\ba350\\b.*fctm", "a350.*flight crew techniques manual", "Airline-Pilot/Airbus-A350/FCTM", "A350 FCTM", true],
  ["\\ba350\\b.*qrh", "a350.*quick reference handbook", "Airline-Pilot/Airbus-A350/QRH", "A350 QRH", true],
  ["\\ba3(18|19|20|21)f?\\b.*fcom", "reference:\\s*aic a318/a319/a320/a321 fleet fcom", "Airline-Pilot/Airbus-A320/FCOM", "A320 family FCOM", true],
  ["\\ba3(18|19|20|21)f?\\b.*fctm", "a318/a319/a320/a321.*flight crew techniques manual", "Airline-Pilot/Airbus-A320/FCTM", "A320 family FCTM", true],
  ["\\ba3(18|19|20|21)f?\\b.*qrh", "a318/a319/a320/a321.*quick reference handbook", "Airline-Pilot/Airbus-A320/QRH", "A320 family QRH", true],
  ["b787.*(fcom|fctm|qrh)", null, "Airline-Pilot/Boeing-787", "B787 manual", true],
  ["b777.*(fcom|fctm|qrh)", null, "Airline-Pilot/Boeing-777", "B777 manual", true],
  ["career[ _-]*progression", "career progression (policy|list)", "Airline-Pilot/Company-Policies", "Career Progression Policy", true],
  ["rostering", "rostering practices policy", "Airline-Pilot/Company-Policies", "Rostering Practices Policy", true],
  ["pilot[ _-]*policy[ _-]*handbook", "pilot policy handbook", "Airline-Pilot/Company-Policies", "Pilot Policy Handbook", true],
  ["benefits", "benefits\\s*(&|and)\\s*reimbursement", "Airline-Pilot/Company-Policies", "Crew Benefits & Reimbursements", true],
  ["travel[ _-]*claim|\\btada\\b", "outstation travel claim", "Airline-Pilot/Company-Policies/Forms", "Travel claim form", false],
  [null, "policy\\s*number\\s*[:\\-]?\\s*[a-z]{2,4}\\s*-", "Airline-Pilot/Company-Policies", "", true],
  ["operations[ _-]*manual.*part[ _-]*a\\b", "ai/ops/oma/", "Airline-Pilot/Company-Manuals/OM-Part-A", "Operations Manual Part A", true],
  ["operations[ _-]*manual.*part[ _-]*b\\b", "ai/ops/omb/", "Airline-Pilot/Company-Manuals/OM-Part-B", "Operations Manual Part B", true],
  ["operations[ _-]*manual.*part[ _-]*c\\b", "ai/ops/omc/", "Airline-Pilot/Company-Manuals/OM-Part-C", "Operations Manual Part C", true],
  ["operations[ _-]*manual.*part[ _-]*d\\b", "ai/ops/omd/", "Airline-Pilot/Company-Manuals/OM-Part-D", "Operations Manual Part D", true],
  ["sepm|safety[ _-]*(&|and)[ _-]*emergency", "ai/cst/sepm|safety (&|and) emergency procedures manual", "Airline-Pilot/Company-Manuals/SEPM-Cabin-Safety", "Safety & Emergency Procedures Manual", true],
  ["flight[ _-]*safety[ _-]*manual", "ai/fs/fsm", "Airline-Pilot/Company-Manuals/Flight-Safety-Manual", "Flight Safety Manual", true],
  ["standards[ _-]*manual", "standards manual", "Airline-Pilot/Company-Manuals/Standards-Manual", "Standards Manual", true],
  ["cbta", "cbta toolkit", "Airline-Pilot/Training/CBTA", "CBTA Toolkit", true],
  ["fatigue[ _-]*management", "fatigue management training", "Airline-Pilot/Training/Fatigue-Management", "Fatigue Management Training", true],
  ["a320.*(trainee|recurrent|rec[ _-]?0\\d)", "airbus a320.*recurrent", "Airline-Pilot/Airbus-A320/Training", "A320 recurrent training", true],
  ["dgca.*approval|sim[ _-]*approval", "directorate general of civil aviation.*(approval|qualification)", "Airline-Pilot/DGCA-Approvals", "DGCA approval", false],
  [null, "civil aviation requirements?\\b", "Airline-Pilot/DGCA-CAR", "", true],
  ["cbse", "central board of secondary education", "School-Delhi-SrSec/CBSE", "", false],
  [null, "delhi school education|directorate of education", "School-Delhi-SrSec/DoE-Circulars", "", false],
  ["\\bbnss\\b|nagarik[ _-]*suraksha", "bharatiya nagarik suraksha", "Legal/BNSS", "", false],
  ["\\bbsa\\b|sakshya", "bharatiya sakshya", "Legal/BSA", "", false],
  ["\\bbns\\b|nyaya[ _-]*sanhita", "bharatiya nyaya sanhita", "Legal/BNS", "", false],
  ["vayuyan", "bharatiya vayuyan", "Legal/Acts", "", false],
].map(([n, h, folder, label, versioned]) => ({ name: n && new RegExp(n), head: h && new RegExp(h), folder, label, versioned }));

// Your own rules, one per line:  name_regex, head_regex, folder, label   (leave a regex empty to skip it)
export function parseUserRules(text) {
  const rules = [];
  for (const line of (text || "").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const r = line.split(",").map(x => x.trim());
    if (r.length < 3 || (!r[0] && !r[1])) continue;
    try { rules.push({ name: r[0] ? new RegExp(r[0]) : null, head: r[1] ? new RegExp(r[1]) : null, folder: r[2].replace(/^\/+|\/+$/g, ""), label: r[3] || "", versioned: false }); } catch { /* bad regex: ignored */ }
  }
  return rules;
}

const normName = name => name.split("/").pop().replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ").toLowerCase();
export function classify(name, head = "", userRules = []) {
  const nm = normName(name), hd = head.slice(0, 3000).replace(/\s+/g, " ").toLowerCase();
  for (const r of [...userRules, ...DEFAULT_RULES]) if ((r.name && r.name.test(nm)) || (r.head && r.head.test(hd))) return { folder: r.folder, label: r.label, versioned: r.versioned };
  return { folder: "Unsorted", label: "", versioned: false };
}

const iso = (day, mon, year) => {
  const m = MONTHS[String(mon).slice(0, 3).toUpperCase()]; if (!m) return "";
  let y = parseInt(year, 10); y = y < 100 ? y + 2000 : y;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(parseInt(day, 10)).padStart(2, "0")}`;
};

// What the document says it is: family (groups its versions), order (newer is bigger), label (shown in citations). Or null.
export function identity(name, head, route = null) {
  route = route || classify(name, head);
  const h = head.replace(/\s+/g, " ");
  let m = /REFERENCE:\s*(?:AIC\s+)?(.+?)\s+FLEET\s+(FCOM|FCTM|QRH)\s+ISSUE DATE:\s*(\d{1,2})\s+([A-Z]{3})\s+(\d{2,4})/.exec(h);
  if (m) {
    const date = iso(m[3], m[4], m[5]), fam = `${m[2]} ${m[1]}`;
    return { family: fam, title: fam, date, issue: "", revision: "", version: "", style: "fcom", label: `${fam}, issue ${date}`, order: orderOf(date) };
  }
  const pm = /Policy\s*(?:number|no\.?)\s*[:\-]?\s*([A-Z]{2,4}\s*-\s*[A-Z0-9]+(?:\s*-\s*\d+)?)/i.exec(h);
  if (pm) {
    const pno = pm[1].replace(/\s+/g, "").toUpperCase();
    const vm = /Version\s*Number\s*[:\-]?\s*([\d.]+)/i.exec(h);
    const em = /Effective\s*From\s*[:\-]?\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s*(\d{4})/i.exec(h);
    const sm = /Supersedes\s*(?:Policy\s*Number)?\s*[:\-]?\s*(?:\(If any\))?\s*([A-Z]{2,4}-[A-Z0-9-]+)/i.exec(h);
    const date = em ? iso(em[1], em[2], em[3]) : "", ver = vm ? vm[1] : "", title = route.label || `Policy ${pno}`;
    return { family: route.label || pno, title, date, issue: "", revision: "", version: ver, policy_no: pno, supersedes: sm ? sm[1].toUpperCase() : "", style: "policy",
             label: `${title} (${pno}) v${ver}` + (date ? `, effective ${date}` : ""), order: orderOf(date, 0, 0, ver || 0) };
  }
  const dm = /\b(AI\/[A-Z0-9]+(?:\/[A-Z0-9\-]+)+)\b/.exec(h);
  if (dm) {
    const im = /ISSUE[\s-]+(\d+)\s+REV(?:ISION)?[\s-]+(\d+)/.exec(h), ym = /YEAR OF ISSUE\s+(\d{4})/.exec(h);
    const em = /Effective\s+(\d{1,2})\s*(?:st|nd|rd|th)?\s*\xa0?\s*([A-Za-z]+)\s*\xa0?\s*(\d{4})/.exec(h);
    const date = em ? iso(em[1], em[2], em[3]) : (ym ? ym[1] : "");
    if (im || date) {
      const [issue, rev] = im ? [im[1], im[2]] : ["", ""], title = route.label || dm[1];
      const bits = [title, ...(im ? [`issue ${issue} rev ${rev}`] : []), ...(date ? [date] : [])];
      return { family: dm[1], title, date, issue, revision: rev, version: "", doc_no: dm[1], style: im ? "manual" : "training", label: bits.join(", "), order: orderOf(date, issue, rev) };
    }
  }
  return null;
}

export function cmpOrder(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }

// items: [{name, head, fp, size}]; library: [{id, family, order, status}] (documents already on the iPad); fps: {fingerprint: name}
// Returns one decision per item: {status: save|superseded|duplicate, folder, reason, ident, replaces: [doc ids]}
export function planBatch(items, library = [], fps = {}, { forceFolder = null, userRules = [] } = {}) {
  const decisions = [], seen = {};
  for (const it of items) {
    const route = classify(it.name, it.head || "", userRules);
    const d = { name: it.name, folder: forceFolder ?? route.folder, status: "save", reason: "", ident: docMeta(it.head || "", it.name, route), fp: it.fp || "", size: it.size || 0, replaces: [], item: it };
    if (d.fp && fps[d.fp]) { d.status = "duplicate"; d.reason = `identical to ${fps[d.fp]} already on this iPad`; }
    else if (d.fp && seen[d.fp]) { d.status = "duplicate"; d.reason = `identical to ${seen[d.fp]} in this batch`; }
    else if (d.fp) seen[d.fp] = it.name;
    decisions.push(d);
  }
  const families = {};
  for (const d of decisions) if (d.status === "save" && d.ident) (families[d.ident.family] ||= []).push(d);
  for (const [fam, group] of Object.entries(families)) {
    const existing = library.filter(m => m.family === fam && m.order && m.status === "current");
    let newest = group[0].ident.order;
    for (const g of group) if (cmpOrder(g.ident.order, newest) > 0) newest = g.ident.order;
    for (const m of existing) if (cmpOrder(m.order, newest) > 0) newest = m.order;
    for (const g of group) if (cmpOrder(g.ident.order, newest) < 0) { g.status = "superseded"; g.folder += "/Superseded"; g.reason = `a newer issue of this document exists (${fam}); kept for reference, not searched`; }
    const current = group.filter(g => g.status === "save" && cmpOrder(g.ident.order, newest) === 0);
    for (const extra of current.slice(1)) { extra.status = "duplicate"; extra.reason = `same issue as ${current[0].name}`; }
    if (current.length) for (const m of existing) if (cmpOrder(m.order, newest) < 0) current[0].replaces.push(m.id);
  }
  return decisions;
}

// The identity of a document from its first pages: a CAR (own recognition) or anything identity() knows
import { carMeta } from "./chunker.js";
export function docMeta(headText, name, route = null) {
  const car = carMeta(headText);
  if (car) {
    const label = [car.car, car.issue ? `Issue ${car.issue}` : "", car.date].filter(Boolean).join(", ");
    return { ...car, family: car.car, style: "car", label, order: orderOf(car.date, car.issue_no) };
  }
  return identity(name, headText.replace(/\s+/g, " "), route);
}
