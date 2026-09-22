// Optional: import a library pack made on a Mac (python cli.py export-ipad). Not needed when you add documents on the iPad.
import * as S from "./store.js";
import { rebuildIndex } from "./library.js";

export async function importPack(stream, { onProgress = () => {}, totalBytes = 0 } = {}) {
  let bytes = 0;
  const counted = stream.pipeThrough(new TransformStream({ transform(c, ctl) { bytes += c.byteLength; ctl.enqueue(c); } }));
  const reader = counted.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
  await S.wipeAll();
  let header = null, buf = "", batch = [], done = 0, key = 0, ids = [], counts = [], firsts = [];
  const flush = async () => { if (batch.length) { await S.putChunkBatch(key - batch.length, batch); batch = []; } };
  const handle = async line => {
    if (!line) return;
    const row = JSON.parse(line);
    if (!header) { header = row; for (let i = 0; i < header.docs.length; i++) { ids.push(await S.reserveDocId()); counts.push(0); firsts.push(null); } return; }
    const [docIdx, page, label, text] = row;
    if (firsts[docIdx] === null) firsts[docIdx] = key;
    counts[docIdx]++; batch.push({ doc: ids[docIdx], page, label, text }); key++; done++;
    if (batch.length >= 1500) { await flush(); onProgress({ done, total: header.passages, bytes, totalBytes }); }
  };
  for (;;) {
    const { value, done: fin } = await reader.read();
    if (value) { buf += value; let i; while ((i = buf.indexOf("\n")) >= 0) { await handle(buf.slice(0, i)); buf = buf.slice(i + 1); } }
    if (fin) break;
  }
  if (buf.trim()) await handle(buf);
  await flush();
  if (!header) throw new Error("This is not a Private AI library pack.");
  if (header.format !== 1) throw new Error("This pack needs a newer app. Update the app first.");
  for (let i = 0; i < header.docs.length; i++) {
    const d = header.docs[i], parts = d.path.split("/");
    await S.commitDoc({ id: ids[i], name: parts[parts.length - 1], path: d.path, folder: parts.slice(0, -1).join("/"), domain: d.domain, label: d.label || "", family: d.family || "",
                        order: null, style: "", ocr: !!d.ocr, fp: "", size: 0, added: Date.now(), pages: 0, status: "current", first: firsts[i] ?? 0, count: counts[i] }, i === header.docs.length - 1 ? key : null);
  }
  if (!header.docs.length) await S.kvSet("nextChunk", key);
  onProgress({ done, total: header.passages, bytes, totalBytes, phase: "index" });
  return rebuildIndex();
}
