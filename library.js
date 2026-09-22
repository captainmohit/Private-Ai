import { IndexBuilder } from "./bm25.js";
import * as S from "./store.js";
const tick = () => new Promise(r => setTimeout(r, 0));

// Builds the search index from every current document's passages. Superseded (older) documents are not searched.
export async function rebuildIndex(onProgress = () => {}) {
  const docs = (await S.allDocs()).filter(d => d.status === "current" && d.count > 0);
  const total = docs.reduce((n, d) => n + d.count, 0), b = new IndexBuilder(); let done = 0;
  for (const d of docs) {
    const rows = await S.chunksOf(d);
    rows.forEach((r, i) => b.add(d.id, r.text, d.first + i));
    done += rows.length; onProgress({ done, total }); await tick();
  }
  await S.kvSet("index", b.finish()); await S.kvSet("ready", docs.length > 0);
  return { documents: docs.length, passages: total };
}

// Stores one document's passages and record. rows: [[page, label, text]]
export async function storeDocument(doc, rows, onProgress = () => {}) {
  const first = await S.nextChunkKey(); let key = first;
  for (let i = 0; i < rows.length; i += 1500) {
    const part = rows.slice(i, i + 1500).map(([page, label, text]) => ({ doc: doc.id, page, label, text }));
    await S.putChunkBatch(key, part); key += part.length; onProgress({ stored: key - first, total: rows.length }); await tick();
  }
  await S.commitDoc({ ...doc, first, count: rows.length }, key);
  return { first, count: rows.length };
}

// Marks a document older (kept as a record, its passages are dropped to save space and it is no longer searched)
export async function supersede(doc) { await S.dropChunks(doc); await S.putDoc({ ...doc, status: "superseded", count: 0 }); }
