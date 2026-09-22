// Tokenising and BM25 search, entirely on the device. Works for English, Hindi (Devanagari) and Punjabi (Gurmukhi).
const STOP = new Set(("the of and to in is are was were be been for on at by with from as an a or that this it its their there than then when where which who what how " +
  "shall will may can not no if any all each per into out up under over also such these those has have had do does did about between " +
  "क्या कि कौन कैसे कब क्यों कहाँ यह वह एक और तो भी था थे करें करना बताइए बताओ मुझे हमें लिए साथ होता होती होते हैं है का की के में से को पर " +
  "ਹੈ ਹਨ ਦਾ ਦੀ ਦੇ ਵਿੱਚ ਕੀ ਤੇ ਅਤੇ ਨੂੰ ਨੇ ਕਿਵੇਂ ਕਦੋਂ ਕੌਣ ਕਿਉਂ ਸੀ ਕਰੋ ਦੱਸੋ ਮੈਨੂੰ ਲਈ ਨਾਲ ਇਹ ਉਹ ਵੀ ਤਾਂ").split(" "));
const DIGITS = { "०":"0","१":"1","२":"2","३":"3","४":"4","५":"5","६":"6","७":"7","८":"8","९":"9","੦":"0","੧":"1","੨":"2","੩":"3","੪":"4","੫":"5","੬":"6","੭":"7","੮":"8","੯":"9" };
const WORD = /[\p{L}\p{N}\p{M}]+(?:[-_./][\p{L}\p{N}\p{M}]+)*/gu;

export function normalize(s) { return s.replace(/[०-९੦-੯]/g, c => DIGITS[c]).toLowerCase(); }
function stem(w) { return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w; }

// Codes such as DSC-22_20-10-40-10, HR-FO-04, 03.09.2027 are kept whole AND split, so "DSC-22" and the full code both match.
export function tokenize(text) {
  const out = [];
  for (const m of normalize(text).matchAll(WORD)) {
    const w = m[0], parts = w.split(/[-_./]/);
    if (parts.length > 1) {
      out.push(stem(w));
      for (const p of parts) if ((p.length > 1 || /\d/.test(p)) && !STOP.has(p)) out.push(stem(p));
    } else if (!STOP.has(w) && (w.length > 1 || /\d/.test(w))) out.push(stem(w));
  }
  return out;
}

export class IndexBuilder {
  constructor() { this.termId = new Map(); this.terms = []; this.post = []; this.docLen = []; this.docOf = []; this.keys = []; this.n = 0; }
  // docId: which document; key: the passage's key in the database (the index remembers it, so results can be looked up)
  add(docId, text, key = this.n) {
    const toks = tokenize(text), tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const id = this.n++;
    this.docLen.push(Math.min(toks.length, 65535)); this.docOf.push(docId); this.keys.push(key);
    for (const [t, c] of tf) {
      let ti = this.termId.get(t);
      if (ti === undefined) { ti = this.terms.length; this.termId.set(t, ti); this.terms.push(t); this.post.push([]); }
      this.post[ti].push(id, Math.min(c, 65535));
    }
    return id;
  }
  finish() {
    const T = this.terms.length; let total = 0;
    for (const p of this.post) total += p.length / 2;
    const offsets = new Uint32Array(T + 1), ids = new Uint32Array(total), tfs = new Uint16Array(total);
    let k = 0;
    for (let t = 0; t < T; t++) {
      offsets[t] = k; const p = this.post[t];
      for (let j = 0; j < p.length; j += 2) { ids[k] = p[j]; tfs[k] = p[j + 1]; k++; }
    }
    offsets[T] = k;
    let sum = 0; for (const l of this.docLen) sum += l;
    return { terms: this.terms, offsets, ids, tfs, docLen: Uint16Array.from(this.docLen), docOf: Uint32Array.from(this.docOf), keys: Uint32Array.from(this.keys),
             n: this.n, avgdl: this.n ? sum / this.n : 1 };
  }
}

export class Index {
  constructor(d) { Object.assign(this, d); this.map = new Map(); for (let i = 0; i < d.terms.length; i++) this.map.set(d.terms[i], i); }
  // allowDoc: optional Uint8Array indexed by document number (1 = searchable)
  search(query, { allowDoc = null, limit = 60 } = {}) {
    const qt = [...new Set(tokenize(query))], N = this.n, k1 = 1.2, b = 0.75;
    const score = new Float32Array(N), hit = new Uint8Array(N), touched = [];
    for (const t of qt) {
      const ti = this.map.get(t); if (ti === undefined) continue;
      const s = this.offsets[ti], e = this.offsets[ti + 1], df = e - s, idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let j = s; j < e; j++) {
        const id = this.ids[j];
        if (allowDoc && !allowDoc[this.docOf[id]]) continue;
        const tf = this.tfs[j], dl = this.docLen[id];
        if (!hit[id]) touched.push(id);
        score[id] += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / this.avgdl));
        hit[id]++;
      }
    }
    const out = touched.map(id => [id, score[id] * (1 + 0.3 * (hit[id] - 1))]);   // reward passages that match more of the words
    out.sort((a, b2) => b2[1] - a[1]);
    return { hits: out.slice(0, limit), terms: qt, matchedTerms: qt.filter(t => this.map.has(t)) };
  }
}
