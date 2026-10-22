// CTC forced-alignment worker (Stage 2). Runs a wav2vec2 CTC acoustic model via
// transformers.js/onnxruntime-node (same runtime as whisper.mjs), and for each chunk
// aligns the KNOWN Gemini words to the audio at ~20ms resolution. Emits per-word times.
//
// usage: node align-ctc.mjs <audio.f32le_16k_mono> <out.json> <chunks.json> [modelId] [cacheDir]
//   chunks.json: [{ start, end, words:[string,...] }]  (times in seconds, model-local plan)
//   out.json   : { chunks: [ [ {start,end}|null, ... ], ... ] }  per input word, in order
// Progress -> stderr as @@PROGRESS {json} lines (download/align stages), like whisper.mjs.
import fs from 'node:fs';

const [pcmPath, outPath, chunksPath, modelId = 'Xenova/wav2vec2-base-960h', cacheDir] = process.argv.slice(2);

const { AutoProcessor, AutoModelForCTC, AutoTokenizer, env } = await import('@huggingface/transformers');
if (cacheDir) env.cacheDir = cacheDir;
env.allowLocalModels = false;
const { alignWords, logSoftmaxRows } = await import('./forced-align.mjs');

const emit = (o) => process.stderr.write('@@PROGRESS ' + JSON.stringify(o) + '\n');
const SR = 16000;

emit({ stage: 'load', msg: 'loading aligner' });
const processor = await AutoProcessor.from_pretrained(modelId, {
  progress_callback: (p) => {
    if (p.status === 'progress' && p.file && p.total) emit({ stage: 'download', file: p.file, pct: Math.round((p.loaded / p.total) * 100) });
    else if (p.status === 'ready') emit({ stage: 'ready' });
  },
});
const model = await AutoModelForCTC.from_pretrained(modelId, { dtype: 'q8' });
const tokenizer = await AutoTokenizer.from_pretrained(modelId);

// wav2vec2 is char-level: encode single chars to their CTC ids. Probe the separator id
// from a two-word encode; blank is the pad token.
const enc1 = (s) => tokenizer.encode(s, { add_special_tokens: false });
const probe = enc1('A B');
const SEP = probe.length >= 3 ? probe[1] : 4;
const BLANK = tokenizer.pad_token_id != null ? tokenizer.pad_token_id : 0;
const UNK = tokenizer.unk_token_id != null ? tokenizer.unk_token_id : 3;
// Drop chars absent from the acoustic vocab. The tokenizer maps OOV chars (digits,
// punctuation, emoji) to <unk>, NOT to empty — so we must reject the unk id explicitly.
// A word left with no ids (e.g. "100", "10x"->just the x... etc.) is unalignable: the
// worker returns null for it and applyCtcTimes interpolates it between its neighbours.
const wordIds = (text) => {
  const ids = [];
  for (const ch of String(text).toUpperCase()) {
    if (ch === ' ') continue;
    const e = enc1(ch);
    if (e && e.length && e[0] !== UNK) ids.push(e[0]);
  }
  return ids;
};

const buf = fs.readFileSync(pcmPath);
const audio = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
const chunks = JSON.parse(fs.readFileSync(chunksPath, 'utf8'));

const outChunks = [];
for (let ci = 0; ci < chunks.length; ci++) {
  const c = chunks[ci];
  const gWords = c.words || [];
  emit({ stage: 'align', i: ci + 1, n: chunks.length });
  let times = gWords.map(() => null);
  try {
    const s0 = Math.max(0, Math.floor(c.start * SR));
    const s1 = Math.min(audio.length, Math.ceil(c.end * SR));
    const slice = audio.subarray(s0, s1);
    if (slice.length > SR * 0.1 && gWords.length) {
      const out = await model(await processor(slice));
      const logits = out.logits;
      const [, T, V] = logits.dims;
      const emission = logSoftmaxRows(logits.data, T, V);
      const secPerFrame = (slice.length / SR) / T;
      const base = s0 / SR;
      const alignable = [];
      const idxMap = [];
      gWords.forEach((w, i) => { const ids = wordIds(w); if (ids.length) { alignable.push({ text: String(w), ids }); idxMap.push(i); } });
      const res = alignWords(emission, T, V, alignable, { blank: BLANK, sep: SEP });
      if (res) {
        res.forEach((r, k) => {
          times[idxMap[k]] = {
            start: +(base + r.startFrame * secPerFrame).toFixed(3),
            end: +(base + r.endFrame * secPerFrame).toFixed(3),
          };
        });
      }
    }
  } catch (e) { emit({ stage: 'align-err', i: ci + 1, msg: String(e.message || e).slice(0, 80) }); }
  outChunks.push(times);
}

fs.writeFileSync(outPath, JSON.stringify({ chunks: outChunks }));
emit({ stage: 'done' });
