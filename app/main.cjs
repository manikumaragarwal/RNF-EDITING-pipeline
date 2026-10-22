// Captions Studio — Electron main process.
// Owns the window + all native work (file dialogs, whisper transcription, ffmpeg
// libass burn, optional Gemini highlight). The renderer holds the project state
// and reuses the same engine modules for live preview.
const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

// Software compositing so offscreen frame-capture (the HTML export renderer) is
// reliable on every machine + headless. The editor is light, so no real cost.
app.disableHardwareAcceleration();

const ROOT = __dirname;
const STYLES = path.join(ROOT, 'styles');
const FONTS = path.join(ROOT, 'fonts');
const ENGINE = path.join(ROOT, 'engine');
const fontsLib = require('./engine/fonts.cjs');
// User-uploaded fonts live in a WRITABLE dir (the bundled fonts/ is read-only inside the asar).
// Dev default here; repointed to userData/custom-fonts once the app is ready + packaged.
let CUSTOM_FONTS_DIR = path.join(ROOT, 'web', 'work', 'fonts');
const customFontsList = () => { try { return fontsLib.readManifest(CUSTOM_FONTS_DIR).map((e) => ({ ...e, url: pathToFileURL(path.join(CUSTOM_FONTS_DIR, e.file)).href })); } catch { return []; } };
const WHISPER_WORKER = path.join(ENGINE, 'whisper.mjs');
const ALIGN_WORKER = path.join(ENGINE, 'align-ctc.mjs');
const CTC_MODEL = 'Xenova/wav2vec2-base-960h';   // Stage 2 forced-aligner (English-strong, already ONNX)

// bundled binaries (packaged into resources/bin); fall back to system tools in dev
const BIN = fs.existsSync(path.join(process.resourcesPath || '', 'bin'))
  ? path.join(process.resourcesPath, 'bin') : path.join(ROOT, 'bin');
const has = (p) => { try { return fs.existsSync(p) && p; } catch { return false; } };
const EXE = process.platform === 'win32' ? '.exe' : '';   // bundled Windows binaries are ffmpeg.exe/ffprobe.exe
const FFMPEG = process.env.CAP_FFMPEG || has(path.join(BIN, 'ffmpeg' + EXE)) || 'ffmpeg';
const FFPROBE = process.env.CAP_FFPROBE || has(path.join(BIN, 'ffprobe' + EXE)) || 'ffprobe';

let WORK, MODEL_CACHE, SETTINGS_FILE, win, engine;

async function getEngine() {
  if (!engine) {
    const [c, i, h, r] = await Promise.all([
      import(pathToFileURL(path.join(ENGINE, 'compile-ass.mjs')).href),
      import(pathToFileURL(path.join(ENGINE, 'import.mjs')).href),
      import(pathToFileURL(path.join(ENGINE, 'highlight.mjs')).href),
      import(pathToFileURL(path.join(ENGINE, 'reconcile.mjs')).href),
    ]);
    engine = { ...c, ...i, ...h, ...r };
  }
  return engine;
}
const gem = require('./engine/gemini-hinglish.cjs');

const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } };
const writeSettings = (s) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
const listStyles = () => fs.readdirSync(STYLES).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(STYLES, f), 'utf8')));

// run a binary, resolve stdout (reject with combined output on failure)
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let out = '', err = '';
    p.stdout && p.stdout.on('data', (d) => (out += d));
    p.stderr && p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((err || out || 'exit ' + code).slice(-1500)))));
  });
}
// spawn a Node worker via our OWN electron binary (ELECTRON_RUN_AS_NODE) so the
// packaged app never needs system node; stream @@PROGRESS lines to onProgress.
function runWorker(args, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let err = '', buf = '';
    p.stderr.on('data', (d) => {
      err += d; buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/^@@PROGRESS (.*)$/);
        if (m && onProgress) { try { onProgress(JSON.parse(m[1])); } catch {} }
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve();
      // Drop the @@PROGRESS download spam so the REAL failure (OOM, download error, etc.)
      // is what surfaces to the user instead of a wall of "pct":100 lines.
      const clean = err.split('\n').filter((l) => !l.startsWith('@@PROGRESS')).join('\n').trim();
      reject(new Error((clean || 'worker exit ' + code).slice(-1200)));
    });
  });
}
const probeDims = (video) => {
  try {
    const d = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', video], { encoding: 'utf8' }).stdout.trim();
    const [w, h] = d.split('x').map(Number);
    if (w && h) return { width: Math.round(1920 * w / h), height: 1920 };
  } catch {}
  return { width: 1080, height: 1920 };
};

// Language -> which Whisper model + language code + whether to romanize the output.
// English keeps the small fast base.en; everything else uses the multilingual small
// model (word timestamps work; turbo is deliberately avoided — its word timing is broken).
const LANGS = {
  english:      { label: 'English',  model: 'Xenova/whisper-base.en', whisper: 'en', roman: false },
  hindi:        { label: 'Hindi',    model: 'Xenova/whisper-small',   whisper: 'hi', roman: false },
  hinglish:     { label: 'Hinglish (offline)', model: 'Xenova/whisper-small', whisper: 'hi', roman: true },
  // Gemini reads the audio for accurate code-switched words; Whisper still supplies the
  // per-word timing, and reconcile.mjs re-times Gemini's words onto it. Needs a Gemini
  // key; with no key it transparently falls back to the offline romanized path above.
  'hinglish-ai': { label: 'Hinglish (AI - accurate)', model: 'Xenova/whisper-small', whisper: 'hi', roman: true, gemini: true },
  urdu:         { label: 'Urdu',     model: 'Xenova/whisper-small',   whisper: 'ur', roman: false },
};

// Which Gemini model to call. Auto-discovered from the user's key (newest *-flash that
// supports generateContent) and cached in settings; falls back to a rolling alias.
async function geminiModelId(key, { force = false } = {}) {
  if (!force) { const s = readSettings(); if (s.geminiModel) return s.geminiModel; }
  else { const c = readSettings(); delete c.geminiModel; writeSettings(c); }
  return gem.resolveModel({ key, saveModel: (m) => { const c = readSettings(); c.geminiModel = m; writeSettings(c); } });
}

// One-shot Gemini generateContent against the auto-resolved model, with a single
// re-resolve+retry if the cached model id has been retired (404). Shared by highlight,
// polish, and (indirectly) the Hinglish path so nothing hardcodes a soon-dead model id.
async function geminiGenerate(key, parts, generationConfig) {
  const url = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
  const send = (m) => fetch(url(m), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }], generationConfig }) });
  let res = await send(await geminiModelId(key));
  if (res.status === 404) res = await send(await geminiModelId(key, { force: true }));
  return res;
}

// AI Hinglish content pass. Extract a 16 kHz mono 16-BIT wav (Gemini needs 16-bit, not
// the 32-bit-float PCM whisper uses), send it to Gemini in silence-cut chunks for
// accurate romanized words, then reconcile those words onto whisper's timing. Any
// failure (no chunks, network, bad JSON) degrades to the offline romanized whisper
// words so the mode never returns worse than today's offline Hinglish.
async function geminiReconcile(video, whisperWords, send, pcm) {
  const key = readSettings().geminiKey;
  const eng = await getEngine();   // reconcileChunk, applyCtcTimes, enforceTimeline
  const { romanizeWords } = require('./engine/translit.cjs');
  const romanCanon = (ws) => romanizeWords(ws).map((w) => ({ text: w.text, start: +w.start, end: +w.end, hi: false, on: true, conf: 1 }));
  const wav = path.join(WORK, 'audio16.wav');
  try {
    await run(FFMPEG, ['-y', '-i', video, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    let ci = 0;
    const extractChunkB64 = async (start, dur) => {
      const cf = path.join(WORK, `gchunk_${ci++}.wav`);
      try {
        await run(FFMPEG, ['-y', '-ss', String(start), '-t', String(dur), '-i', wav, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', cf]);
        return fs.readFileSync(cf).toString('base64');
      } finally { try { fs.unlinkSync(cf); } catch {} }
    };
    const { chunks } = await gem.transcribeHinglish({
      key, words: whisperWords, extractChunkB64,
      resolveCandidates: () => gem.resolveModelCandidates({ key, saveModel: (m) => { const c = readSettings(); c.geminiModel = m; writeSettings(c); } }),
      onProgress: send,
    });
    if (!chunks.length) return romanCanon(whisperWords);

    // Stage 2: CTC forced-alignment — align Gemini's exact words to the audio at ~20ms.
    // This is the PRIMARY timing; if it can't run (no model / offline / error) each chunk
    // falls back to reconcile (Gemini words on whisper's timing), then to offline romanize.
    let ctc = null;
    if (readSettings().ctcAlign !== false && pcm && fs.existsSync(pcm)) {
      const chunksPath = path.join(WORK, 'ctc-chunks.json');
      const ctcOut = path.join(WORK, 'ctc-out.json');
      try {
        fs.writeFileSync(chunksPath, JSON.stringify(chunks.map((c) => ({ start: Math.max(0, c.tStart - 0.1), end: c.tEnd + 0.1, words: c.gWords }))));
        await runWorker([ALIGN_WORKER, pcm, ctcOut, chunksPath, CTC_MODEL, MODEL_CACHE], send);
        ctc = JSON.parse(fs.readFileSync(ctcOut, 'utf8')).chunks;
      } catch (e) { send({ stage: 'ctc-fallback', msg: String(e.message || e).slice(0, 120) }); ctc = null; }
      finally { try { fs.unlinkSync(chunksPath); } catch {} try { fs.unlinkSync(ctcOut); } catch {} }
    }

    const all = [];
    chunks.forEach((c, i) => {
      let words = null;
      if (ctc && ctc[i]) words = eng.applyCtcTimes(c.gWords, ctc[i], c.tStart, c.tEnd);
      if (!words || !words.length) { try { words = eng.reconcileChunk(c.wWords, c.gWords, c.tStart, c.tEnd); } catch { words = null; } }
      if (!words || !words.length) words = romanCanon(c.wWords);
      for (const w of words) all.push(w);
    });
    return eng.enforceTimeline(all);
  } catch (e) {
    send({ stage: 'gemini-fallback', msg: String(e.message || e).slice(0, 140) });
    return romanCanon(whisperWords);
  } finally { try { fs.unlinkSync(wav); } catch {} }
}

// Detect silent intervals via ffmpeg silencedetect (fast, no model) -> [{start,end}].
// Used to cut Gemini/CTC chunks at natural pauses without needing whisper.
function detectSilences(wav) {
  return new Promise((resolve) => {
    let err = '';
    try {
      const p = spawn(FFMPEG, ['-i', wav, '-af', 'silencedetect=noise=-30dB:d=0.25', '-f', 'null', '-']);
      p.stderr.on('data', (d) => (err += d));
      p.on('error', () => resolve([]));
      p.on('close', () => {
        const silences = []; let cur = null;
        for (const line of err.split('\n')) {
          const s = line.match(/silence_start:\s*([0-9.]+)/);
          const e = line.match(/silence_end:\s*([0-9.]+)/);
          if (s) cur = parseFloat(s[1]);
          if (e && cur != null) { silences.push({ start: cur, end: parseFloat(e[1]) }); cur = null; }
        }
        resolve(silences);
      });
    } catch { resolve([]); }
  });
}

// FAST AI-Hinglish path: NO whisper. Silence-detect -> time-planned chunks -> Gemini
// (concurrent) for words -> CTC forced-align for frame-perfect timing. Whisper (minutes of
// CPU) is skipped entirely; it only runs as a fallback if this returns null (CTC missing/
// offline/error), where its timing is genuinely needed. Returns canonical words or null.
async function geminiCtcFast(video, pcm, duration, send) {
  const key = readSettings().geminiKey;
  const eng = await getEngine();   // applyCtcTimes, reconcileChunk, enforceTimeline
  const wav = path.join(WORK, 'audio16.wav');
  const chunksPath = path.join(WORK, 'ctc-chunks.json');
  const ctcOut = path.join(WORK, 'ctc-out.json');
  try {
    await run(FFMPEG, ['-y', '-i', video, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    send({ stage: 'gemini', msg: 'transcribing' });
    const silences = await detectSilences(wav);
    const plan = gem.planChunksByTime(duration, silences.map((s) => (s.start + s.end) / 2));
    if (!plan.length) return null;
    let ci = 0;
    const extractChunkB64 = async (start, dur) => {
      const cf = path.join(WORK, `gchunk_${ci++}.wav`);
      try {
        await run(FFMPEG, ['-y', '-ss', String(start), '-t', String(dur), '-i', wav, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', cf]);
        return fs.readFileSync(cf).toString('base64');
      } finally { try { fs.unlinkSync(cf); } catch {} }
    };
    const { chunks } = await gem.transcribeHinglish({
      key, chunks: plan, extractChunkB64,
      resolveCandidates: () => gem.resolveModelCandidates({ key, saveModel: (m) => { const c = readSettings(); c.geminiModel = m; writeSettings(c); } }),
      onProgress: send,
    });
    if (!chunks.length || !chunks.some((c) => c.gWords && c.gWords.length)) return null;

    // CTC is the timing here — with no whisper there is no reconcile fallback, so if CTC
    // can't run we return null and let the caller take the (slower) whisper path.
    let ctc = null;
    try {
      fs.writeFileSync(chunksPath, JSON.stringify(chunks.map((c) => ({ start: Math.max(0, c.tStart - 0.1), end: c.tEnd + 0.1, words: c.gWords }))));
      await runWorker([ALIGN_WORKER, pcm, ctcOut, chunksPath, CTC_MODEL, MODEL_CACHE], send);
      ctc = JSON.parse(fs.readFileSync(ctcOut, 'utf8')).chunks;
    } catch (e) { send({ stage: 'ctc-fallback', msg: String(e.message || e).slice(0, 120) }); return null; }

    const all = [];
    chunks.forEach((c, i) => {
      let w = ctc && ctc[i] ? eng.applyCtcTimes(c.gWords, ctc[i], c.tStart, c.tEnd) : null;
      if (!w || !w.length) { try { w = eng.reconcileChunk(c.wWords, c.gWords, c.tStart, c.tEnd); } catch { w = null; } }  // wWords empty -> even-spread
      if (w && w.length) for (const x of w) all.push(x);
    });
    const res = eng.enforceTimeline(all);
    return (res && res.length) ? res : null;
  } catch (e) {
    send({ stage: 'gemini-fallback', msg: String(e.message || e).slice(0, 140) });
    return null;
  } finally {
    try { fs.unlinkSync(wav); } catch {}
    try { fs.unlinkSync(chunksPath); } catch {}
    try { fs.unlinkSync(ctcOut); } catch {}
  }
}

function newProject(video, words, style, meta = {}) {
  const dims = probeDims(video);
  return {
    video, ...dims, fps: 30,
    style: style || 'hormozi', styleOverrides: {},
    segmentation: null,
    offset: 0.12,   // lead captions slightly to counter whisper's word-start lag
    language: meta.language || 'english', script: meta.script || 'latin',
    autoHighlight: { enabled: true, rules: ['numbers', 'allcaps'], keywords: [] },
    words,
  };
}

// ---------- IPC ----------
const settingsView = (s) => ({ hasGemini: !!s.geminiKey, whisperQuality: s.whisperQuality || 'balanced', ctcAlign: s.ctcAlign !== false });
ipcMain.handle('app:init', () => ({
  styles: listStyles(),
  languages: Object.entries(LANGS).map(([id, v]) => ({ id, label: v.label, roman: v.roman })),
  settings: settingsView(readSettings()),
  customFonts: customFontsList(),
}));

// Add a font file (.ttf/.otf/.woff/.woff2) → register it in the writable custom-fonts dir.
ipcMain.handle('fonts:upload', (_e, { buf, name, family }) => {
  try {
    const entry = fontsLib.addFont(CUSTOM_FONTS_DIR, name, Buffer.from(buf), family);
    return { ok: true, font: { ...entry, url: pathToFileURL(path.join(CUSTOM_FONTS_DIR, entry.file)).href } };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('fonts:list', () => ({ ok: true, fonts: customFontsList() }));

ipcMain.handle('settings:get', () => settingsView(readSettings()));
ipcMain.handle('settings:set', (_e, s) => {
  const cur = readSettings();
  if (typeof s.geminiKey === 'string') cur.geminiKey = s.geminiKey.trim();
  if (s.whisperQuality === 'balanced' || s.whisperQuality === 'high') cur.whisperQuality = s.whisperQuality;
  if (typeof s.ctcAlign === 'boolean') cur.ctcAlign = s.ctcAlign;
  writeSettings(cur);
  return { ok: true, ...settingsView(cur) };
});

ipcMain.handle('dialog:openVideo', async () => {
  if (process.env.CAP_DEV_VIDEO) { const p = process.env.CAP_DEV_VIDEO; return { path: p, fileUrl: pathToFileURL(p).href }; } // test hook
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { path: p, fileUrl: pathToFileURL(p).href };
});

ipcMain.handle('project:transcribe', async (_e, { video, style, language = 'english', script = 'native' }) => {
  try {
    const cfg = LANGS[language] || LANGS.english;
    const send = (o) => { try { win && win.webContents.send('transcribe:progress', o); } catch {} };
    // raw 32-bit float PCM, mono 16 kHz — feeds the CTC aligner, whisper, and the waveform
    const pcm = path.join(WORK, 'audio.f32');
    send({ stage: 'extract', msg: 'extracting audio' });
    await run(FFMPEG, ['-y', '-i', video, '-ar', '16000', '-ac', '1', '-f', 'f32le', pcm]);
    const duration = probeDuration(video);

    let words = null, outScript;
    // FAST PATH: AI Hinglish + CTC — skip whisper entirely (Gemini words + CTC timing).
    if (cfg.gemini && readSettings().geminiKey && readSettings().ctcAlign !== false) {
      words = await geminiCtcFast(video, pcm, duration, send);
      if (words && words.length) outScript = 'roman';
    }
    // FALLBACK PATH: whisper (needed for non-AI modes, or when the fast path couldn't run).
    if (!words || !words.length) {
      const { fromWhisper } = await getEngine();
      const tj = path.join(WORK, 'transcript.json');
      const highAcc = readSettings().whisperQuality === 'high';
      const useMedium = highAcc && !cfg.gemini;   // AI mode: Gemini owns words, whisper only times -> small is enough
      const model = /\.en$/i.test(cfg.model) ? cfg.model : (useMedium ? 'Xenova/whisper-medium' : cfg.model);
      send({ stage: 'transcribe', seconds: +(duration || 0).toFixed(1) });
      await runWorker([WHISPER_WORKER, pcm, tj, model, MODEL_CACHE, cfg.whisper], send);
      let w = fromWhisper(JSON.parse(fs.readFileSync(tj, 'utf8')));
      if (!w.length) return { ok: false, error: 'No speech detected in the audio.' };
      if (cfg.gemini && readSettings().geminiKey) {
        words = await geminiReconcile(video, w, send, pcm);
        outScript = 'roman';
      } else {
        const wantRoman = cfg.roman || (language === 'hindi' && script === 'roman');
        if (wantRoman) { const { romanizeWords } = require('./engine/translit.cjs'); w = romanizeWords(w); }
        words = w;
        outScript = language === 'english' ? 'latin' : wantRoman ? 'roman' : 'native';
      }
    }
    const proj = newProject(video, words, style, { language, script: outScript });
    proj.duration = duration;
    proj.waveform = computePeaks(pcm);
    proj.fileUrl = pathToFileURL(video).href;
    return { ok: true, project: proj };
  } catch (e) {
    return { ok: false, error: 'Transcription failed: ' + String(e.message || e).slice(0, 400) };
  }
});

function probeNativeDims(video) {
  try {
    const d = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', video], { encoding: 'utf8' }).stdout.trim();
    const [w, h] = d.split('x').map(Number);
    if (w && h) return { w, h };
  } catch {}
  return { w: 1080, h: 1920 };
}
function probeDuration(video) {
  try { return parseFloat(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' }).stdout.trim()) || 0; }
  catch { return 0; }
}
// Downsample the extracted 16k mono f32 PCM into N normalized peaks (0..1) for the
// timeline waveform. Cheap — we already have the PCM from the transcribe step.
function computePeaks(pcmPath, n = 900) {
  try {
    const buf = fs.readFileSync(pcmPath);
    const a = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    if (!a.length) return [];
    const per = Math.max(1, Math.floor(a.length / n));
    const peaks = [];
    let max = 1e-6;
    for (let i = 0; i < n; i++) {
      let p = 0; const s = i * per, e = Math.min(a.length, s + per);
      for (let j = s; j < e; j++) { const v = Math.abs(a[j]); if (v > p) p = v; }
      peaks.push(p); if (p > max) max = p;
    }
    return peaks.map((p) => +(p / max).toFixed(3));   // normalize to 0..1
  } catch { return []; }
}
function resolveStyle(project) {
  const base = listStyles().find((s) => s.id === (project.style || 'hormozi')) || listStyles()[0];
  if (!project.segmentation) project.segmentation = base.segmentation || { mode: 'words', max: 3 };
  return { ...base, ...(project.styleOverrides || {}) };
}

// The fast render path pipes raw PREMULTIPLIED BGRA frames to ffmpeg and relies on the
// `unpremultiply` filter to reproduce toPNG()'s straight-alpha composite. It has shipped in
// ffmpeg since 3.2 (2016), but probe once so an ancient build cleanly falls back to the PNG
// path instead of silently double-darkening every semi-transparent caption edge.
let _hasUnpremul = null;
function ffmpegHasUnpremultiply() {
  if (_hasUnpremul !== null) return _hasUnpremul;
  try {
    const o = spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '';
    _hasUnpremul = /\bunpremultiply\b/.test(o);
  } catch { _hasUnpremul = false; }
  return _hasUnpremul;
}

// Render only a TRANSPARENT caption layer per frame (the shared caption-dom
// renderer, pure function of t — no video, no per-frame decoder seek), then let
// ffmpeg composite those alpha PNGs over the real video in ONE native overlay pass.
// This is ~20-40x faster than seeking the video per frame, and preview == export
// still holds because the very same caption-dom paints both.
async function renderProject(project, style, { ss = 0, dur = null, alpha = false } = {}, onProgress) {
  const video = project.video;
  const nd = probeNativeDims(video);
  const fps = project.fps || 30;
  const length = dur != null ? dur : probeDuration(video) || 30;
  const clip = dur != null;
  const nFrames = Math.max(1, Math.round(length * fps));

  // alpha = export the caption layer ALONE on a transparent background (ProRes 4444 .mov), to drop
  // onto a track ABOVE the footage in Premiere/AE. Same frames as a normal export, just no video
  // overlay + a codec that carries alpha. .mov extension so editors recognise it.
  const out = alpha
    ? path.join(path.dirname(video), path.basename(video).replace(/\.[^.]+$/, '') + '__captions.mov')
    : clip
      ? path.join(WORK, `preview_${Date.now()}.mp4`)
      : path.join(path.dirname(video), path.basename(video).replace(/\.[^.]+$/, '') + '__captioned.mp4');
  // Invert templates: the caption's "inverted colour" (mix-blend difference over white ==
  // negate) can't survive a plain alpha overlay onto a transparent export frame. When the whole
  // caption is invert (no per-stack overrides, no fixed per-word colours), reproduce it natively:
  // negate the video and merge it through the caption's alpha, which EQUALS the live preview.
  const invertAll = !!style.stackInvert
    && !(project.stackStyles && Object.keys(project.stackStyles).length)
    && !(project.wordStyles && Object.values(project.wordStyles).some((v) => v && v.color));

  const w = new BrowserWindow({
    show: false, width: nd.w, height: nd.h, useContentSize: true, transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: false, sandbox: false },
  });
  w.webContents.setFrameRate(120);   // faster rAF cadence -> shorter per-frame settle
  let ff = null, ffDone = null;
  try {
    await w.loadFile(path.join(ROOT, 'renderer', 'export.html'));
    // export.html's hooks are defined by an ES module (async) — wait for them or
    // the calls below silently no-op and we capture blank frames.
    for (let i = 0; i < 100; i++) {
      if (await w.webContents.executeJavaScript('typeof window.__setup==="function" && typeof window.__seek==="function"')) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await w.webContents.executeJavaScript('__fontsReady()');
    // resolve per-stack template overrides (firstWordId -> style id) into full style objects
    // so a single line can render with a different template than the rest of the video.
    let stackStyleMap = null;
    if (project.stackStyles) {
      const all = listStyles(); stackStyleMap = {};
      for (const key in project.stackStyles) { const st = all.find((s) => s.id === project.stackStyles[key]); if (st) stackStyleMap[key] = st; }
    }
    const payload = JSON.stringify({ project: { ...project, __w: nd.w, __h: nd.h, stackStyleMap, duration: length }, style, customFonts: customFontsList() });
    await w.webContents.executeJavaScript(`__setup(${payload})`);
    // Warm up: the very first offscreen paint after load can lag the capture and
    // yield a blank frame. Seek + settle once before the loop so frame 0 is solid.
    await w.webContents.executeJavaScript(`__seek(${ss})`);
    await new Promise((r) => setTimeout(r, 250));

    // Exact captured surface size. deviceScaleFactor can make it differ from nd.w/nd.h, and the
    // raw pipe tells ffmpeg the size explicitly — so measure it from a warm capture, never assume.
    const cs = (await w.webContents.capturePage()).getSize();
    const CW = cs.width, CH = cs.height, frameBytes = CW * CH * 4;

    // TURN-BACK SWITCH: set CAP_RENDER_LEGACY=1 to force the original PNG-sequence path exactly,
    // with no code change or git revert — the instant escape hatch if the fast path ever misbehaves.
    if (!process.env.CAP_RENDER_LEGACY && ffmpegHasUnpremultiply()) {
      // FAST PATH — stream raw frames straight into ONE ffmpeg (no PNG zlib, no temp files), so the
      // overlay+encode runs CONCURRENTLY with frame capture instead of as a trailing pass. Two wins:
      // kill the wasted per-frame PNG compression, and overlap the whole encode with the loop.
      //
      // capturePage().toBitmap() returns PREMULTIPLIED BGRA; toPNG() emitted STRAIGHT (unassociated)
      // alpha. So the non-invert branch adds `unpremultiply=inplace=1` to reproduce today's composite.
      // The invert branch consumes only the alpha channel (alphaextract), which is premultiplication-
      // invariant, so it is byte-for-byte identical to the old PNG path with no filter change.
      const capFilter = invertAll
        ? `[0:v]fps=${fps},setpts=PTS-STARTPTS,format=rgba,split[b1][b2];[b2]negate[neg];[1:v]setpts=PTS-STARTPTS[cap];[cap]alphaextract[a];[neg][a]alphamerge[negA];[b1][negA]overlay=0:0:shortest=1,format=yuv420p[v]`
        : `[0:v]fps=${fps},setpts=PTS-STARTPTS[base];[1:v]setpts=PTS-STARTPTS,unpremultiply=inplace=1[cap];[base][cap]overlay=0:0:shortest=1,format=yuv420p[v]`;
      // 0 = source video (native decode), 1 = raw premultiplied BGRA caption frames on stdin.
      const args = ['-y'];
      if (alpha) {
        // Caption layer ONLY -> ProRes 4444 with a straight-alpha channel (unpremultiply reverses
        // the premultiplied BGRA capture, exactly like the export composite). No video, no audio.
        args.push('-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', `${CW}x${CH}`, '-framerate', String(fps), '-i', 'pipe:0',
          '-vf', 'unpremultiply=inplace=1,format=yuva444p10le',
          '-c:v', 'prores_ks', '-profile:v', '4444', '-alpha_bits', '16', '-vendor', 'apl0',
          '-movflags', '+faststart', out);
      } else {
        if (clip) args.push('-ss', String(ss), '-t', String(dur));   // input-seek is safe here (no subtitles filter)
        args.push('-i', video,
          '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', `${CW}x${CH}`, '-framerate', String(fps), '-i', 'pipe:0',
          '-filter_complex', capFilter,
          '-map', '[v]', '-map', '0:a:0?',
          '-c:v', 'libx264', '-crf', '18', '-preset', clip ? 'veryfast' : 'medium',
          '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k', out);
      }
      ff = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let ffErr = '';
      ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-8000); });
      ff.stdin.on('error', () => {});   // swallow EPIPE if ffmpeg exits early; the real error surfaces on close
      ffDone = new Promise((res, rej) => {
        ff.on('error', rej);
        ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c + ': ' + ffErr.slice(-1500)))));
      });
      for (let f = 0; f < nFrames; f++) {
        const t = ss + f / fps;
        await w.webContents.executeJavaScript(`__seek(${t})`);
        const buf = (await w.webContents.capturePage()).toBitmap();
        if (buf.length !== frameBytes) throw new Error(`frame ${f}: capture ${buf.length} != expected ${frameBytes} (${CW}x${CH})`);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));   // backpressure = memory guard
        if (ff.exitCode !== null) break;   // ffmpeg died — stop feeding; the error surfaces via ffDone
        if (onProgress && f % 5 === 0) onProgress({ stage: 'render', pct: Math.round((f / nFrames) * 100) });
      }
      ff.stdin.end();
      if (onProgress) onProgress({ stage: 'encode', pct: 99 });
      await ffDone;
    } else {
      // FALLBACK — ffmpeg too old for `unpremultiply` (< 3.2): the original write-PNG-sequence path.
      const framesDir = fs.mkdtempSync(path.join(WORK, 'frames-'));
      try {
        for (let f = 0; f < nFrames; f++) {
          const t = ss + f / fps;
          await w.webContents.executeJavaScript(`__seek(${t})`);
          const img = await w.webContents.capturePage();
          fs.writeFileSync(path.join(framesDir, `cap_${String(f).padStart(5, '0')}.png`), img.toPNG());
          if (onProgress && f % 5 === 0) onProgress({ stage: 'render', pct: Math.round((f / nFrames) * 100) });
        }
        if (onProgress) onProgress({ stage: 'encode', pct: 99 });
        const capFilter = invertAll
          ? `[0:v]fps=${fps},setpts=PTS-STARTPTS,format=rgba,split[b1][b2];[b2]negate[neg];[1:v]setpts=PTS-STARTPTS[cap];[cap]alphaextract[a];[neg][a]alphamerge[negA];[b1][negA]overlay=0:0:shortest=1,format=yuv420p[v]`
          : `[0:v]fps=${fps},setpts=PTS-STARTPTS[base];[1:v]setpts=PTS-STARTPTS[cap];[base][cap]overlay=0:0:shortest=1,format=yuv420p[v]`;
        const args = ['-y'];
        if (alpha) {
          // PNGs are already straight-alpha, so no unpremultiply — just carry alpha into ProRes 4444.
          args.push('-framerate', String(fps), '-i', path.join(framesDir, 'cap_%05d.png'),
            '-vf', 'format=yuva444p10le',
            '-c:v', 'prores_ks', '-profile:v', '4444', '-alpha_bits', '16', '-vendor', 'apl0',
            '-movflags', '+faststart', out);
        } else {
          if (clip) args.push('-ss', String(ss), '-t', String(dur));
          args.push('-i', video, '-framerate', String(fps), '-i', path.join(framesDir, 'cap_%05d.png'),
            '-filter_complex', capFilter,
            '-map', '[v]', '-map', '0:a:0?',
            '-c:v', 'libx264', '-crf', '18', '-preset', clip ? 'veryfast' : 'medium',
            '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k', out);
        }
        await run(FFMPEG, args);
      } finally { fs.rmSync(framesDir, { recursive: true, force: true }); }
    }
  } catch (e) {
    if (ffDone) ffDone.catch(() => {});   // ffmpeg's rejection is now expected — don't leak it as unhandled
    if (ff && ff.exitCode === null) { try { ff.stdin.destroy(); } catch {} try { ff.kill('SIGKILL'); } catch {} }
    throw e;
  } finally { w.destroy(); }
  return out;
}

ipcMain.handle('project:preview', async (_e, { project, ss, dur }) => {
  try {
    const send = (o) => { try { win && win.webContents.send('render:progress', o); } catch {} };
    const out = await renderProject(project, resolveStyle(project), { ss: Math.max(0, ss || 0), dur: dur || 4 }, send);
    return { ok: true, fileUrl: pathToFileURL(out).href };
  } catch (e) { return { ok: false, error: 'Preview failed: ' + String(e.message || e).slice(0, 400) }; }
});

ipcMain.handle('project:render', async (_e, { project }) => {
  try {
    const send = (o) => { try { win && win.webContents.send('render:progress', o); } catch {} };
    const out = await renderProject(project, resolveStyle(project), {}, send);
    return { ok: true, path: out, fileUrl: pathToFileURL(out).href };
  } catch (e) { return { ok: false, error: 'Export failed: ' + String(e.message || e).slice(0, 400) }; }
});

ipcMain.handle('project:exportAlpha', async (_e, { project }) => {
  try {
    const send = (o) => { try { win && win.webContents.send('render:progress', o); } catch {} };
    const out = await renderProject(project, resolveStyle(project), { alpha: true }, send);
    return { ok: true, path: out, fileUrl: pathToFileURL(out).href };
  } catch (e) { return { ok: false, error: 'Alpha export failed: ' + String(e.message || e).slice(0, 400) }; }
});

ipcMain.handle('project:exportSrt', async (_e, { srt, name }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: (name || 'captions') + '.srt' });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, srt);
  return { ok: true, path: r.filePath };
});

ipcMain.handle('shell:showItem', (_e, p) => { if (p) shell.showItemInFolder(p); });

// Gemini: pick the most impactful words to highlight. Optional; needs the user's key.
ipcMain.handle('ai:highlight', async (_e, { words }) => {
  const key = readSettings().geminiKey;
  if (!key) return { ok: false, error: 'No Gemini API key set (open Settings).' };
  const numbered = words.map((w, i) => `${i}:${w.text}`).join(' ');
  const prompt = `You label caption words for punchy short-form video captions. From the numbered words below, choose the 15-25% most impactful "power words" to visually highlight — numbers, key nouns, strong verbs, emotional/surprising words. Skip filler (the, a, is, of, and). Return ONLY JSON: {"highlight":[<indices>]}.\nWords: ${numbered}`;
  try {
    const res = await geminiGenerate(key, [{ text: prompt }], { responseMimeType: 'application/json', temperature: 0.2 });
    if (!res.ok) return { ok: false, error: `Gemini ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(txt);
    const hi = Array.isArray(parsed.highlight) ? parsed.highlight.filter((n) => Number.isInteger(n) && n >= 0 && n < words.length) : [];
    return { ok: true, highlight: hi };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Gemini: fix transliteration/spelling to natural creator-style Roman Hinglish (or
// clean Devanagari). CRITICAL: the LLM only rewrites the text of each word — it must
// return the SAME number of words in the SAME order, so the Whisper timestamps stay
// aligned. If the count doesn't match, we reject and keep the original words.
ipcMain.handle('ai:polish', async (_e, { words, language, script }) => {
  const key = readSettings().geminiKey;
  if (!key) return { ok: false, error: 'No Gemini API key set (open Settings).' };
  const list = words.map((w) => String(w.text));
  const target = script === 'roman'
    ? 'natural Roman Hinglish exactly how Indian creators type on Instagram (e.g. "aapka", "mein", "kyunki", "mehnat") — keep English words in English'
    : language === 'hindi' ? 'correct Devanagari Hindi'
    : language === 'urdu' ? 'correct Urdu script' : 'correctly spelled words';
  const prompt = `You fix ASR caption spelling. Rewrite each word to ${target}. Fix obvious mis-transcriptions from context. RULES: return EXACTLY ${list.length} strings, same order, one per input word. Do NOT split, merge, add, or drop words. Keep proper nouns. Return ONLY JSON: {"words":[...]}.\nInput (${list.length} words): ${JSON.stringify(list)}`;
  try {
    const res = await geminiGenerate(key, [{ text: prompt }], { responseMimeType: 'application/json', temperature: 0.1 });
    if (!res.ok) return { ok: false, error: `Gemini ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const parsed = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    const fixed = Array.isArray(parsed.words) ? parsed.words.map((s) => String(s)) : [];
    if (fixed.length !== list.length) return { ok: false, error: `Gemini changed the word count (${fixed.length} vs ${list.length}); kept original to protect timing.` };
    return { ok: true, words: fixed };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 680,
    backgroundColor: '#0e1117', title: 'Captions Studio',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  if (process.env.CAP_SMOKE) win.webContents.once('did-finish-load', () => runSmoke().catch((e) => { console.log('SMOKE ERR', e && e.stack || e); app.quit(); }));
}

// ---------- auto-update (electron-updater over the GitHub Releases feed) ----------
// Silent background download; the renderer shows a small "Update ready — Restart" affordance when
// a new version has finished downloading. quitAndInstall swaps the app in on the user's click (or
// automatically on next quit). Only runs in a PACKAGED build — `npm start` dev has no update feed.
function setupAutoUpdate() {
  if (!app.isPackaged || process.env.CAP_SMOKE) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (o) => { try { win && !win.isDestroyed() && win.webContents.send('update:status', o); } catch {} };
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => send({ state: 'available', version: i && i.version }));
  autoUpdater.on('update-not-available', () => send({ state: 'current' }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (i) => send({ state: 'ready', version: i && i.version }));
  autoUpdater.on('error', (e) => send({ state: 'error', message: String((e && e.message) || e).slice(0, 300) }));
  ipcMain.handle('update:install', () => { try { autoUpdater.quitAndInstall(); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; } });
  ipcMain.handle('update:check', () => autoUpdater.checkForUpdates().then(() => ({ ok: true })).catch((e) => ({ ok: false, error: String(e) })));
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);            // first check just after launch
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);   // then every 6h
}

// Headless end-to-end smoke: boot -> capture welcome -> transcribe -> capture editor
// -> short preview render -> report. Guarded by CAP_SMOKE; never runs for real users.
async function runSmoke() {
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(process.env.CAP_SMOKE, name), img.toPNG()); console.log('SMOKE shot', name); };
  await new Promise((r) => setTimeout(r, 1500));
  const langs = await win.webContents.executeJavaScript('document.getElementById("langSel").options.length');
  console.log('SMOKE langOptions', langs);
  await shot('01-welcome.png');
  const video = process.env.CAP_DEV_VIDEO;
  console.log('SMOKE transcribing', video);
  const r = await win.webContents.executeJavaScript(`window.cap.transcribe(${JSON.stringify(video)}, 'hormozi-active', 'english', 'native')`);
  console.log('SMOKE transcribe ok=', r && r.ok, 'words=', r && r.project && r.project.words.length);
  if (!r || !r.ok) { app.quit(); return; }
  await win.webContents.executeJavaScript(`window.__test.loadProject(${JSON.stringify(r.project)})`);
  await new Promise((res) => setTimeout(res, 900));
  // seek to a moment with a caption so the overlay is visible
  await win.webContents.executeJavaScript(`new Promise(res=>{const v=document.getElementById('video');v.onseeked=()=>res(1);v.currentTime=1.4;})`);
  await new Promise((res) => setTimeout(res, 400));
  await shot('02-editor.png');
  // drag-to-retime checks: resize a fresh on-screen word (shrink right edge), then ripple-move.
  const drag = await win.webContents.executeJavaScript(`(async () => {
    const tw = document.getElementById('tlWords');
    const rAF = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.getElementById('tlScroll').scrollLeft = 0; await rAF();
    // (1) resize: shrink the first word's right edge inward
    const c1 = document.querySelector('#tlWords .tlword:not(.narrow)'); if (!c1) return { error: 'no chip' };
    const b1 = window.__test.words()[0]; const r1 = c1.getBoundingClientRect(); const edge = c1.querySelector('.tlw-edge.r');
    const ey = r1.top + r1.height/2, ex = r1.right - 2;
    edge.dispatchEvent(new PointerEvent('pointerdown', { pointerId:5, clientX:ex, clientY:ey, bubbles:true }));
    tw.dispatchEvent(new PointerEvent('pointermove', { pointerId:5, clientX:ex-18, clientY:ey, bubbles:true }));
    await rAF();
    tw.dispatchEvent(new PointerEvent('pointerup', { pointerId:5, clientX:ex-18, clientY:ey, bubbles:true }));
    const a1 = window.__test.words()[0];
    const resize = { beforeEnd: b1.end, afterEnd: a1.end, changed: Math.abs(a1.end - b1.end) > 0.05 };
    // (2) ripple move: push the first word (and everything after) +80px
    const rc = document.getElementById('tlRippleCb'); rc.checked = true; rc.onchange({ target: rc });
    const c2 = document.querySelector('#tlWords .tlword'); const b2 = window.__test.words()[0];
    const r2 = c2.getBoundingClientRect(); const cy = r2.top + r2.height/2, cx = r2.left + r2.width/2;
    c2.dispatchEvent(new PointerEvent('pointerdown', { pointerId:6, clientX:cx, clientY:cy, bubbles:true }));
    c2.dispatchEvent(new PointerEvent('pointermove', { pointerId:6, clientX:cx+80, clientY:cy, bubbles:true }));
    await rAF();
    c2.dispatchEvent(new PointerEvent('pointerup', { pointerId:6, clientX:cx+80, clientY:cy, bubbles:true }));
    const a2 = window.__test.words()[0]; rc.checked = false; rc.onchange({ target: rc });
    return { pps: window.__test.pps(), resize, rippleMove: { before: b2.start, after: a2.start, moved: Math.abs(a2.start - b2.start) > 0.1 } };
  })()`);
  console.log('SMOKE drag', JSON.stringify(drag));
  await win.webContents.executeJavaScript(`document.querySelector('.tabs button[data-tab=Templates]').click()`);
  await new Promise((res) => setTimeout(res, 300)); await shot('03-templates.png');
  await win.webContents.executeJavaScript(`document.querySelector('.tabs button[data-tab=Transitions]').click()`);
  await new Promise((res) => setTimeout(res, 300)); await shot('04-transitions.png');
  // kinetic: add a keyword at the playhead, confirm it renders over the video
  await win.webContents.executeJavaScript(`(()=>{ document.querySelector('.tabs button[data-tab=Kinetic]').click(); document.getElementById('kinAdd').click(); const ev=window.__test; })()`);
  await new Promise((res) => setTimeout(res, 300));
  const kin = await win.webContents.executeJavaScript(`document.querySelectorAll('.kinetic-layer > div').length`);
  console.log('SMOKE kinetic layers rendered=', kin);
  await shot('04b-kinetic.png');
  // apply a style override (enable box + red highlight) and confirm the overlay changes
  await win.webContents.executeJavaScript(`(()=>{const s=window.__test; const b=document.getElementById('boxOn'); b.checked=true; b.onchange(); const a=document.getElementById('colAccentHex'); a.value='#ff2d55'; a.onchange();})()`);
  await new Promise((res) => setTimeout(res, 300));
  await win.webContents.executeJavaScript(`document.querySelector('.tabs button[data-tab=Text]').click()`);
  await shot('05-override.png');
  // export path check: render a 3s preview with the override applied and dump a frame
  const pr = await win.webContents.executeJavaScript(`window.__test.previewNow(1.2, 3)`);
  console.log('SMOKE preview ok=', pr && pr.ok, pr && pr.error ? pr.error : '');
  if (pr && pr.ok) {
    const src = pr.fileUrl.replace('file://', '');
    await run(FFMPEG, ['-y', '-ss', '0.3', '-i', src, '-frames:v', '1', path.join(process.env.CAP_SMOKE, '06-export-frame.png')]);
    console.log('SMOKE wrote 06-export-frame.png');
  }
  console.log('SMOKE done'); app.quit();
}

app.whenReady().then(() => {
  WORK = path.join(app.getPath('temp'), 'captions-studio');
  fs.mkdirSync(WORK, { recursive: true });
  MODEL_CACHE = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(MODEL_CACHE, { recursive: true });
  SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
  // Writable custom-fonts dir (the packaged fonts/ is read-only inside the asar).
  CUSTOM_FONTS_DIR = path.join(app.getPath('userData'), 'custom-fonts');
  fs.mkdirSync(CUSTOM_FONTS_DIR, { recursive: true });
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
