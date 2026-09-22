// Optional AI that runs INSIDE Safari on the iPad (WebGPU). Off until you download a model once; after that it works offline.
// If the iPad or Safari has no WebGPU, the app still works as a fast offline search with exact citations.
export const MODELS = [
  { key: "Llama-3.2-1B-Instruct", name: "Compact", size: "about 0.9 to 1.1 GB", note: "Llama 3.2 1B. Fastest; simple summaries. Fine on most iPads." },
  { key: "Qwen2.5-1.5B-Instruct", name: "Balanced", size: "about 1.6 to 1.9 GB", note: "Qwen 2.5 1.5B. Better with Hindi. Suggested for iPads with 6 GB or more." },
  { key: "Llama-3.2-3B-Instruct", name: "Larger", size: "about 2.3 to 3 GB", note: "Llama 3.2 3B. Best answers; needs an iPad with 8 GB or more." },
];
let engine = null, engineKey = null, factory = null;
export function setEngineFactory(f) { factory = f; }          // used by tests
export const loadedModel = () => engineKey;

async function hasF16() {
  if (factory) return true;
  try { const a = await navigator.gpu.requestAdapter(); return !!a && a.features.has("shader-f16"); } catch { return false; }
}
// Some GPUs lack 16-bit shader maths; then the 32-bit build of the same model is used (a little larger).
export async function resolve(key) { return `${key}-${(await hasF16()) ? "q4f16_1" : "q4f32_1"}-MLC`; }

export async function webgpuStatus() {
  if (factory) return { ok: true, note: "test engine" };
  if (!("gpu" in navigator)) return { ok: false, note: "This Safari has no WebGPU (needs iPadOS 26 or later)." };
  try {
    const a = await navigator.gpu.requestAdapter();
    return a ? { ok: true, note: "WebGPU is available (" + (a.features.has("shader-f16") ? "16-bit" : "32-bit") + " maths)." } : { ok: false, note: "No GPU adapter available." };
  } catch (e) { return { ok: false, note: "WebGPU error: " + e.message }; }
}

async function lib() { return import("./web-llm.js"); }

export async function isDownloaded(key) { try { return await (await lib()).hasModelInCache(await resolve(key)); } catch { return false; } }
export async function deleteModel(key) { if (engineKey === key) { engine = null; engineKey = null; } return (await lib()).deleteModelAllInfoInCache(await resolve(key)); }

export async function load(key, onProgress = () => {}) {
  if (engine && engineKey === key) return;
  engine = null; engineKey = null;
  const id = await resolve(key);
  if (factory) engine = await factory(id, onProgress);
  else engine = await (await lib()).CreateMLCEngine(id, { initProgressCallback: p => onProgress({ text: p.text, progress: p.progress }) });
  engineKey = key;
}

export function buildMessages(question, passages) {
  const ctx = passages.map((p, i) => `[${i + 1}] (${p.cite})\n${p.text.slice(0, 850)}`).join("\n\n");
  return [
    { role: "system", content:
      "You answer questions for an airline pilot using ONLY the numbered EXCERPTS from the user's own documents. " +
      "Cite every statement like [1] or [2]. If the excerpts do not contain the answer, say exactly: \"Not found in these excerpts.\" " +
      "Never state a limit, number, date or procedure that is not written in the excerpts. Answer in the language of the question. Be brief." },
    { role: "user", content: `EXCERPTS:\n${ctx}\n\nQUESTION: ${question}` },
  ];
}

export async function* answer(question, passages, signal) {
  if (!engine) throw new Error("No AI model is loaded.");
  const stream = await engine.chat.completions.create({ messages: buildMessages(question, passages), stream: true, temperature: 0.1, max_tokens: 420 });
  for await (const chunk of stream) {
    if (signal && signal.aborted) { try { await engine.interruptGenerate(); } catch {} return; }
    const t = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
    if (t) yield t;
  }
}
