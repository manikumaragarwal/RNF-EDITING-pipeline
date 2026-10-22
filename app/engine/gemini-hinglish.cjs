// Gemini as the Hinglish CONTENT engine: send the audio, get back verbatim,
// creator-natural romanized Hinglish words. Timing is NOT taken from Gemini (its
// timestamps drift badly on long audio) — reconcile.mjs re-times these words onto
// Whisper's frame-accurate word grid.
//
// Design notes:
//  - Model id is AUTO-DISCOVERED from the user's key via ListModels (the Gemini flash
//    line churns fast — 2.0/2.5/3.5/3.6/3.8 within a year — so we never hardcode a bet;
//    we pick the newest plain `*-flash` that supports generateContent and cache it).
//  - Audio goes inline as base64 of a 16 kHz mono 16-BIT WAV (audio/wav). Do NOT send
//    the raw f32le PCM whisper uses — that's 32-bit float and Gemini would garble it.
//  - The clip is cut into ~40s chunks AT WHISPER'S SILENCE GAPS so no word is split and
//    each chunk stays tiny (well under the 20 MB inline cap) and low-drift.
//
// Main-process module (uses global fetch, same as main.cjs's existing Gemini calls).

const API = 'https://generativelanguage.googleapis.com/v1beta';

// ordered safety net if ListModels can't be reached; runtime still tries the next id
// on a 404 so a dead default self-heals.
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];

const PROMPT = [
  'You are a verbatim speech transcriber for short-form video captions. Transcribe the',
  'attached audio EXACTLY as spoken — do not translate, summarize, correct grammar, or',
  'add words. The speech is Hinglish (Hindi + English code-switching).',
  'Rules:',
  '- Write Hindi words in ROMAN letters the way Indian creators actually type on Instagram',
  '  (aapko, mehnat, kyunki, matlab, hai, nahi, thoda, bilkul, karna, chahiye). No Devanagari.',
  '- Keep English words in normal English spelling (business, mindset, growth, content) —',
  '  never spell them phonetically.',
  '- No IAST/diacritics. Lowercase. Minimal punctuation. No emojis. No filler you did not hear.',
  '- Break the transcript into short segments of one breath each (<= ~8 words).',
  'Return ONLY JSON matching the schema: an array "segments", each with the spoken text.',
  'Do NOT include timestamps — only the words.',
].join('\n');

// Text only. Whisper owns the timing, so asking Gemini for per-segment timestamps just
// burns output tokens and risks truncating a long transcript (which would drop the chunk).
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  required: ['segments'],
};

// --- model discovery -------------------------------------------------------------
// TIER-FIRST ranking (empirical, 2026-09): the newest gemini-3.x-flash models are
// frequently QUOTA-GATED (HTTP 429) or thinking-slow (~50 s/call) on typical/free keys,
// while the gemini-2.5-flash / flash-latest line is fast (~4 s), accurate enough for
// verbatim transcription, and has generous free quota. So we prefer the proven workhorse
// tier and keep 3.x as a fallback for keys where it is actually fast. The per-call timeout
// + fast 429-skip in transcribeHinglish are the adaptive safety net on top of this.
function scoreFlash(rawName) {
  const n = String(rawName).replace(/^models\//, '');
  if (!/gemini/.test(n) || !/flash/.test(n)) return -1;
  // reject non-text / specialized flash variants
  if (/lite|tts|image|native|dialog|thinking|transcribe|embed|vision|omni|learnlm|live|audio/.test(n)) return -1;
  if (/^gemini-2\.5-flash$/.test(n)) return 800;          // validated sweet spot: fast + accurate + high free quota
  if (/^gemini-flash-latest$/.test(n)) return 790;        // Google's curated stable pointer
  let major, minor = 0, mm = n.match(/gemini-(\d+)\.(\d+)-flash/);
  if (mm) { major = +mm[1]; minor = +mm[2]; }
  else if ((mm = n.match(/gemini-(\d+)-flash/))) { major = +mm[1]; }
  else return -1;
  let base;
  if (major === 2) base = 600 + minor;                    // rest of the 2.x workhorse tier
  else if (major >= 3) base = 300 + major * 10 + minor;   // 3.x premium/preview tier — fallback only
  else base = 100 + major * 10 + minor;                   // very old
  if (/preview|exp|-\d{3,}$/.test(n)) base -= 0.5;         // prefer GA over dated/preview
  return base;
}

async function listModels(key, fetchImpl) {
  const res = await fetchImpl(`${API}/models?key=${encodeURIComponent(key)}&pageSize=1000`);
  if (!res.ok) throw new Error('ListModels ' + res.status);
  const d = await res.json();
  return Array.isArray(d.models) ? d.models : [];
}

// Returns flash model ids best-first (newest that support generateContent), with
// FALLBACK_MODELS appended. The orchestrator walks this list, stepping down when the
// top (newest, most in-demand) model is overloaded (503) or retired (404). Caches the
// top id via saveModel. Never throws — returns FALLBACK_MODELS on any failure.
async function resolveModelCandidates({ key, saveModel, fetchImpl = fetch } = {}) {
  try {
    const models = await listModels(key, fetchImpl);
    const scored = models
      .filter((m) => {
        const methods = m.supportedGenerationMethods || m.supported_generation_methods;
        return Array.isArray(methods) && methods.includes('generateContent');
      })
      .map((m) => [String(m.name).replace(/^models\//, ''), scoreFlash(m.name)])
      .filter((x) => x[1] > 0)
      .sort((a, b) => b[1] - a[1])
      .map((x) => x[0]);
    for (const f of FALLBACK_MODELS) if (!scored.includes(f)) scored.push(f);
    if (scored.length) { if (saveModel) { try { saveModel(scored[0]); } catch {} } return scored; }
  } catch { /* fall through */ }
  return FALLBACK_MODELS.slice();
}

// Single best model (cached). Used by the text-only polish/highlight calls.
async function resolveModel({ key, cached, saveModel, fetchImpl = fetch } = {}) {
  if (cached && typeof cached === 'string') return cached;
  const list = await resolveModelCandidates({ key, saveModel, fetchImpl });
  return list[0];
}

// --- chunk planning --------------------------------------------------------------
// Cut the reel into chunks at whisper's silence gaps: grow a chunk until it is at
// least TARGET seconds long AND the next gap is >= MIN_GAP (a natural pause), or force
// a cut at HARD_CAP seconds. Because boundaries are whisper word boundaries, the same
// words fall in the same chunk on both the whisper and the gemini side.
function planChunks(words, { target = 22, hardCap = 30, minGap = 0.35, pad = 0.15 } = {}) {
  const W = (words || []).filter((w) => w && w.text != null && isFinite(w.start) && isFinite(w.end));
  const chunks = [];
  if (!W.length) return chunks;
  let i = 0;
  while (i < W.length) {
    let j = i;
    const startT = W[i].start;
    while (j < W.length) {
      const dur = W[j].end - startT;
      const nextGap = j + 1 < W.length ? W[j + 1].start - W[j].end : Infinity;
      if (dur >= hardCap) break;                         // hard cut regardless of gap
      if (dur >= target && nextGap >= minGap) break;     // natural cut at a pause
      j++;
    }
    if (j >= W.length) j = W.length - 1;
    const wWords = W.slice(i, j + 1).map((w) => ({ text: w.text, start: +w.start, end: +w.end }));
    chunks.push({
      wWords,
      tStart: wWords[0].start,
      tEnd: wWords[wWords.length - 1].end,
      audioStart: Math.max(0, wWords[0].start - pad),
      audioEnd: wWords[wWords.length - 1].end + pad,
    });
    i = j + 1;
  }
  return chunks;
}

// Plan chunks by TIME (no whisper needed) for the CTC-primary fast path. Cut [0,duration]
// into ~target-second chunks, snapping each boundary to the nearest silence cut point so a
// word is never split; hard-cap at hardCap. cutPoints = candidate cut times (seconds),
// e.g. midpoints of ffmpeg-detected silent intervals. Chunks carry empty wWords (no
// whisper); the CTC path times them, and a per-chunk CTC miss even-spreads instead.
function planChunksByTime(duration, cutPoints = [], { target = 22, hardCap = 30, pad = 0.15 } = {}) {
  const chunks = [];
  if (!(duration > 0)) return chunks;
  const cuts = (cutPoints || []).filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
  let start = 0;
  let guard = 0;
  while (start < duration - 0.05 && guard++ < 1000) {
    let end;
    if (start + target >= duration - 0.05) {
      end = duration;                                     // last chunk takes the remainder
    } else {
      const ideal = start + target;
      const limit = Math.min(start + hardCap, duration);
      const inWindow = cuts.filter((t) => t > start + target * 0.5 && t <= limit);
      end = inWindow.length
        ? inWindow.reduce((best, t) => (Math.abs(t - ideal) < Math.abs(best - ideal) ? t : best), inWindow[0])
        : limit;
    }
    end = Math.min(Math.max(end, start + 0.5), duration);
    chunks.push({
      wWords: [],
      tStart: +start.toFixed(3), tEnd: +end.toFixed(3),
      audioStart: Math.max(0, start - pad), audioEnd: Math.min(duration, end + pad),
    });
    start = end;
  }
  return chunks;
}

// --- single-chunk transcription --------------------------------------------------
function endpoint(model, key) {
  return `${API}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
}

// Returns { words:[string], segments:[{start,end,text}] } for one audio chunk.
// Throws err.code==='MODEL_NOT_FOUND' on a 404 so the caller can re-resolve the model.
async function transcribeChunk({ key, model, wavBase64, fetchImpl = fetch, timeoutMs = 25000 }) {
  const parts = [{ text: PROMPT }, { inlineData: { mimeType: 'audio/wav', data: wavBase64 } }];
  // maxOutputTokens headroom so a chunk's transcript never truncates (which would drop the
  // tail words); thinkingBudget 0 so a flash model doesn't burn latency "thinking" about a
  // verbatim transcription. These are optional speed/safety extras — if a (usually older)
  // candidate model rejects one with a 400, we retry once with just the required config so
  // an unsupported param never knocks the whole fast path onto the slow whisper route.
  // A hard per-call timeout (AbortController) guarantees a pathologically slow model
  // (some 3.x flash take ~50 s/call) can't hang a chunk — it aborts and the orchestrator
  // steps to the next candidate.
  const full = { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } };
  const minimal = { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 };
  const call = async (generationConfig) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await fetchImpl(endpoint(model, key), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }], generationConfig }), signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  };
  let res;
  try { res = await call(full); if (res.status === 400) res = await call(minimal); }   // drop optional params and retry once
  catch (e) { const t = new Error('Gemini call timed out / aborted on ' + model); t.code = 'TIMEOUT'; throw t; }
  if (res.status === 404) { const e = new Error('Gemini model not found: ' + model); e.code = 'MODEL_NOT_FOUND'; throw e; }
  if (res.status === 429) { const e = new Error('Gemini 429 (quota): ' + (await res.text()).slice(0, 120)); e.code = 'QUOTA'; throw e; }
  if (res.status >= 500) { const e = new Error('Gemini ' + res.status + ' (transient): ' + (await res.text()).slice(0, 120)); e.code = 'TRANSIENT'; throw e; }
  if (!res.ok) throw new Error('Gemini ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const txt = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
  return { words: parseWords(txt) };
}

// Extract the word list from Gemini's JSON. Falls back to a regex sweep of "text":"..."
// values if JSON.parse fails (e.g. a rare truncated response) so we never lose the whole
// chunk to one malformed tail.
function parseWords(txt) {
  let segments = null;
  try { const parsed = JSON.parse(txt || '{}'); if (Array.isArray(parsed.segments)) segments = parsed.segments.map((s) => s && s.text); } catch { /* fall through */ }
  if (!segments) { segments = []; const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g; let m; while ((m = re.exec(txt || ''))) segments.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')); }
  const words = [];
  for (const s of segments) for (const tok of String(s || '').trim().split(/\s+/)) if (tok) words.push(tok);
  return words;
}

// --- orchestrator ----------------------------------------------------------------
// Transcribe a whole reel's worth of Whisper-timed words with Gemini, chunk by chunk.
//   words             : Whisper words [{text,start,end}] — the timing grid + chunk plan
//   extractChunkB64   : async (audioStart, durationSec) => base64 of a 16k mono 16-bit WAV
//                       cut from the source (ffmpeg lives in the caller, not here)
//   resolveCandidates : async () => ordered model ids, best (newest) first
//   onProgress        : optional ({stage:'gemini', i, n, model?}) => void
//   sleep             : optional (ms) => Promise, for transient-retry backoff
// Returns { chunks:[{wWords, gWords, tStart, tEnd}], model } ready for reconcile().
// Retries transient errors (503 overloaded / 429 / 5xx) up to twice per model, then
// steps DOWN the candidate list (newest is the most in-demand, so an older flash is the
// resilience path) before giving up. Throws only when every candidate is exhausted, so
// the caller falls back to offline ONLY as a true last resort.
async function transcribeHinglish({ key, chunks, words, extractChunkB64, resolveCandidates, onProgress, fetchImpl = fetch, sleep, concurrency = 4 }) {
  const plan = (chunks && chunks.length) ? chunks : planChunks(words);
  if (!plan.length) return { chunks: [], model: null };
  let candidates = await resolveCandidates();
  if (!candidates || !candidates.length) candidates = FALLBACK_MODELS.slice();
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const shared = { mi: 0 };        // shared model cursor: advances once when a model is overloaded/retired
  let done = 0;

  const transcribeOne = async (c) => {
    const b64 = await extractChunkB64(c.audioStart, Math.max(0.1, c.audioEnd - c.audioStart));
    let attempt = 0;
    for (;;) {
      const idx = Math.min(shared.mi, candidates.length - 1);
      try {
        const tc = await transcribeChunk({ key, model: candidates[idx], wavBase64: b64, fetchImpl });
        if (onProgress) onProgress({ stage: 'gemini', i: ++done, n: plan.length, model: candidates[idx] });
        return { wWords: c.wWords || [], gWords: tc.words, tStart: c.tStart, tEnd: c.tEnd };
      } catch (e) {
        const code = e && e.code;
        // QUOTA (429) can be a transient RPM burst on a GOOD model — retry the SAME model
        // twice with a short backoff before abandoning it (don't throw away 2.5-flash over a
        // momentary burst); a hard quota just falls through to the step-down below.
        if (code === 'QUOTA' && attempt < 2) { attempt++; await wait(1500 * attempt); continue; }
        // genuine transient overload (503/5xx): brief retry on the same model
        if (code === 'TRANSIENT' && attempt < 2) { attempt++; await wait(500 * attempt); continue; }
        // TIMEOUT (slow model) / exhausted-QUOTA / dead model / overloaded: step DOWN
        // immediately (no further wait) so this and every peer chunk skip it too.
        if ((code === 'QUOTA' || code === 'TIMEOUT' || code === 'TRANSIENT' || code === 'MODEL_NOT_FOUND') && idx < candidates.length - 1) {
          if (shared.mi === idx) shared.mi = idx + 1;   // advance the shared cursor once so peers skip the dead model too
          attempt = 0; continue;
        }
        throw e;                                        // exhausted every candidate -> offline fallback
      }
    }
  };

  // bounded-concurrency worker pool over the chunk plan (order preserved via index)
  const out = new Array(plan.length);
  let next = 0;
  const worker = async () => { while (next < plan.length) { const i = next++; out[i] = await transcribeOne(plan[i]); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
  return { chunks: out, model: candidates[Math.min(shared.mi, candidates.length - 1)] };
}

module.exports = {
  FALLBACK_MODELS, PROMPT, RESPONSE_SCHEMA,
  scoreFlash, resolveModel, resolveModelCandidates, planChunks, planChunksByTime, transcribeChunk, transcribeHinglish, parseWords, endpoint,
};
