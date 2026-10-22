// Local Whisper via transformers.js (ONNX) — NO python, NO pip, NO system whisper.
// Runs as a child of system `node` (matches onnxruntime-node's ABI), so it works
// from-source and dodges Electron native-module rebuilds.
//
// usage: node whisper.mjs <audio.f32le_16k_mono> <out.json> [modelId] [cacheDir] [language]
//   language: whisper code (en, hi, ur, ...) or '' to auto-detect. Ignored for *.en models.
// Emits progress to stderr as lines: @@PROGRESS {json}
import fs from 'node:fs';

const [pcmPath, outPath, modelId = 'Xenova/whisper-base.en', cacheDir, language = ''] = process.argv.slice(2);

const { pipeline, env } = await import('@huggingface/transformers');
if (cacheDir) env.cacheDir = cacheDir;   // keep the model download inside the app's data dir
env.allowLocalModels = false;

const emit = (o) => process.stderr.write('@@PROGRESS ' + JSON.stringify(o) + '\n');

emit({ stage: 'load', msg: 'loading model' });
const asr = await pipeline('automatic-speech-recognition', modelId, {
  dtype: 'q8',
  progress_callback: (p) => {
    if (p.status === 'progress' && p.file && p.total) emit({ stage: 'download', file: p.file, pct: Math.round((p.loaded / p.total) * 100) });
    else if (p.status === 'ready') emit({ stage: 'ready' });
  },
});

// raw 32-bit float PCM, mono, 16 kHz -> Float32Array
const buf = fs.readFileSync(pcmPath);
const audio = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
emit({ stage: 'transcribe', seconds: +(audio.length / 16000).toFixed(1) });

// language/task only apply to multilingual models; whisper-*.en reject them.
const multilingual = !/\.en$/i.test(modelId);
// chunk_length_s:29 (not 30) — a 30s chunk triggers a transformers.js word-timestamp
// corruption bug on >30s audio (times collapse to 29.98); 29 is within whisper's 30s
// receptive field and safe. Applies to every model.
const opts = { return_timestamps: 'word', chunk_length_s: 29, stride_length_s: 5 };
if (multilingual && language) { opts.language = language; opts.task = 'transcribe'; }
const out = await asr(audio, opts);

// normalize to the shape fromWhisper() expects: { words:[{word,start,end}] }
const chunks = Array.isArray(out.chunks) ? out.chunks : [];
const words = chunks
  .filter((c) => c && c.timestamp && c.timestamp[0] != null)
  .map((c) => ({ word: String(c.text).trim(), start: +c.timestamp[0], end: +(c.timestamp[1] ?? c.timestamp[0]) }))
  .filter((w) => w.word !== '');

fs.writeFileSync(outPath, JSON.stringify({ text: (out.text || '').trim(), words }, null, 1));
emit({ stage: 'done', words: words.length });
