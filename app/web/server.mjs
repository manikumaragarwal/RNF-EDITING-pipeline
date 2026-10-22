// Captions Studio — HOSTED web backend. Serves the (already browser-based) editor as a
// website and does the two server-side jobs: transcription (whisper) and the MP4 burn
// (headless-Electron render worker + ffmpeg). Auth is handled by Caddy (basic_auth) in
// front; this binds 127.0.0.1 only. No framework — Node built-ins, like ig-server.mjs.
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as rnfAuto from './rnf-auto.mjs';
import fontsLib from '../engine/fonts.cjs';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(WEB, '..');
const WORK = path.join(WEB, 'work');
const UPLOADS = path.join(WORK, 'uploads');
const OUT = path.join(WORK, 'out');
const MODELS = path.join(WORK, 'models');
const CUSTOM_FONTS = path.join(WORK, 'fonts');   // user-uploaded fonts (writable; built-in fonts stay in APP/fonts)
const SETTINGS_FILE = path.join(WORK, 'settings.json');
for (const d of [WORK, UPLOADS, OUT, MODELS, CUSTOM_FONTS]) fs.mkdirSync(d, { recursive: true });

// Custom fonts as the client needs them (family + a ready-to-use same-origin url).
const listCustomFonts = () => fontsLib.readManifest(CUSTOM_FONTS).map((e) => ({ ...e, url: `/customfonts/${e.file}` }));

const PORT = parseInt(process.env.PORT || '3016', 10);
const ELECTRON = path.join(APP, 'node_modules', '.bin', 'electron');
const WHISPER_WORKER = path.join(APP, 'engine', 'whisper.mjs');
const ALIGN_WORKER = path.join(APP, 'engine', 'align-ctc.mjs');
const CTC_MODEL = 'Xenova/wav2vec2-base-960h';   // Stage 2 forced-aligner (runs great on the VPS)
const RENDER_WORKER = path.join(WEB, 'render-worker.cjs');
const FFMPEG = process.env.CAP_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.CAP_FFPROBE || 'ffprobe';

const LANGS = {
  english:  { label: 'English',  model: 'Xenova/whisper-base.en', whisper: 'en', roman: false },
  hindi:    { label: 'Hindi',    model: 'Xenova/whisper-small',   whisper: 'hi', roman: false },
  hinglish: { label: 'Hinglish (offline)', model: 'Xenova/whisper-small', whisper: 'hi', roman: true },
  'hinglish-ai': { label: 'Hinglish (AI - accurate)', model: 'Xenova/whisper-small', whisper: 'hi', roman: true, gemini: true },
  urdu:     { label: 'Urdu',     model: 'Xenova/whisper-small',   whisper: 'ur', roman: false },
};

const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } };
const writeSettings = (s) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
const settingsView = (s) => ({ hasGemini: !!s.geminiKey, whisperQuality: s.whisperQuality || 'balanced', ctcAlign: s.ctcAlign !== false });
const listStyles = () => fs.readdirSync(path.join(APP, 'styles')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(APP, 'styles', f), 'utf8')));

// ---------- SSE progress (PER-CLIENT so concurrent users don't see each other's progress) ----------
const clients = new Map();   // cid -> res
const sendTo = (cid, o) => { const r = cid && clients.get(cid); if (r) { try { r.write(`data: ${JSON.stringify(o)}\n\n`); } catch {} } };
const broadcast = (o) => { const d = `data: ${JSON.stringify(o)}\n\n`; for (const r of clients.values()) { try { r.write(d); } catch {} } };

// ---------- HEAVY-JOB QUEUE ----------
// Transcription + render/export are CPU+RAM heavy; on this small shared box, letting 3-4 users run
// them at once would stampede it (contention / OOM). So serialise them: only CAP_CONCURRENCY run at
// a time; the rest wait in line and get a live "you're #N — someone is transcribing/exporting" note.
const HEAVY_CONCURRENCY = parseInt(process.env.CAP_CONCURRENCY || '1', 10);
let jobsRunning = 0, runningKind = null;
const jobQueue = [];   // { cid, kind, fn, resolve, reject }
function pumpQueue() { jobQueue.forEach((j, i) => sendTo(j.cid, { stage: 'queued', position: i + 1, busyWith: runningKind })); }
function heavy(cid, kind, fn) {
  return new Promise((resolve, reject) => { jobQueue.push({ cid, kind, fn, resolve, reject }); pumpQueue(); drainQueue(); });
}
function drainQueue() {
  while (jobsRunning < HEAVY_CONCURRENCY && jobQueue.length) {
    const j = jobQueue.shift(); jobsRunning++; runningKind = j.kind; pumpQueue();
    Promise.resolve().then(j.fn).then(j.resolve, j.reject).finally(() => { jobsRunning--; if (jobsRunning === 0) runningKind = null; drainQueue(); pumpQueue(); });
  }
}

// ---------- helpers ----------
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts); let out = '', err = '';
    p.stdout && p.stdout.on('data', (d) => (out += d));
    p.stderr && p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error((err || out).slice(-1500)))));
  });
}
// spawn the whisper worker via electron-as-node (onnxruntime N-API is ABI-stable)
function runWhisper(args, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(ELECTRON, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let err = '', buf = '';
    p.stderr.on('data', (d) => { err += d; buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = line.match(/^@@PROGRESS (.*)$/); if (m && onProgress) { try { onProgress(JSON.parse(m[1])); } catch {} } } });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-1500) || 'whisper exit ' + c))));
  });
}
// spawn the render worker as real Electron under xvfb (needs offscreen BrowserWindow)
function runRender(jobPath, onProgress) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn('xvfb-run', ['-a', ELECTRON, RENDER_WORKER, jobPath, '--no-sandbox'], { env });
    let err = '', buf = '';
    p.stderr.on('data', (d) => { err += d; buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = line.match(/^@@PROGRESS (.*)$/); if (m && onProgress) { try { onProgress(JSON.parse(m[1])); } catch {} } } });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-1800) || 'render exit ' + c))));
  });
}
const probeDims = (v) => { try { const d = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', v], { encoding: 'utf8' }).stdout.trim(); const [w, h] = d.split('x').map(Number); if (w && h) return { width: Math.round(1920 * w / h), height: 1920 }; } catch {} return { width: 1080, height: 1920 }; };
const probeDuration = (v) => { try { return parseFloat(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', v], { encoding: 'utf8' }).stdout.trim()) || 0; } catch { return 0; } };
function computePeaks(pcmPath, n = 900) {
  try { const buf = fs.readFileSync(pcmPath); const a = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)); if (!a.length) return []; const per = Math.max(1, Math.floor(a.length / n)); const peaks = []; let max = 1e-6; for (let i = 0; i < n; i++) { let p = 0; const s = i * per, e = Math.min(a.length, s + per); for (let j = s; j < e; j++) { const v = Math.abs(a[j]); if (v > p) p = v; } peaks.push(p); if (p > max) max = p; } return peaks.map((p) => +(p / max).toFixed(3)); } catch { return []; }
}
function resolveStyle(project) {
  const base = listStyles().find((s) => s.id === (project.style || 'hormozi')) || listStyles()[0];
  if (!project.segmentation) project.segmentation = base.segmentation || { mode: 'words', max: 3 };
  return { ...base, ...(project.styleOverrides || {}) };
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
const readJson = async (req) => { try { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return {}; } };

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.css': 'text/css', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveFile(req, res, file, mimeOverride) {
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  const stat = fs.statSync(file); const mime = mimeOverride || MIME[path.extname(file)] || 'application/octet-stream';
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const [s, e] = range.replace('bytes=', '').split('-'); const start = parseInt(s, 10) || 0; const end = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, { 'content-type': mime, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': mime, 'content-length': stat.size, 'accept-ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}
const safeId = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '');

// index.html adapted for the web: inject the web IPC shim + swap the Electron file:-based
// CSP for a same-origin (https) one so /media, /fonts, /out load.
const WEB_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'";
function serveIndex(res) {
  let html = fs.readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${WEB_CSP}" />`);
  html = html.replace('<script type="module" src="./app.mjs"></script>', '<script src="/cap-web.js"></script>\n  <script type="module" src="/app.mjs"></script>');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
}

// ---------- HTTP ----------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/' || p === '/index.html') return serveIndex(res);
    if (p === '/rnf-automation' || p === '/rnf-automation/') return serveFile(req, res, path.join(APP, 'renderer', 'rnf-automation.html'));
    if (p.startsWith('/rnf-media/')) return serveRnfMedia(req, res, p.slice('/rnf-media/'.length));
    if (p === '/cap-web.js') return serveFile(req, res, path.join(WEB, 'cap-web.js'));
    if (p === '/app.mjs') return serveFile(req, res, path.join(APP, 'renderer', 'app.mjs'));
    if (p.startsWith('/engine/')) return serveFile(req, res, path.join(APP, safeJoin(p)));
    if (p.startsWith('/fonts/')) return serveFile(req, res, path.join(APP, safeJoin(p)));
    if (p.startsWith('/customfonts/')) return serveFile(req, res, path.join(CUSTOM_FONTS, safeId(p.slice('/customfonts/'.length))));
    if (p.startsWith('/media/')) return serveFile(req, res, path.join(UPLOADS, safeId(p.slice('/media/'.length))));
    if (p.startsWith('/out/')) return serveFile(req, res, path.join(OUT, safeId(p.slice('/out/'.length))));

    if (p === '/api/init') return send(res, 200, { styles: listStyles(), languages: Object.entries(LANGS).map(([id, v]) => ({ id, label: v.label, roman: v.roman })), settings: settingsView(readSettings()), customFonts: listCustomFonts() });
    if (p === '/api/fonts' && req.method === 'GET') return send(res, 200, { ok: true, fonts: listCustomFonts() });
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, settingsView(readSettings()));
    if (p === '/api/settings' && req.method === 'POST') { const s = await readJson(req); const cur = readSettings(); if (typeof s.geminiKey === 'string') cur.geminiKey = s.geminiKey.trim(); if (s.whisperQuality === 'balanced' || s.whisperQuality === 'high') cur.whisperQuality = s.whisperQuality; if (typeof s.ctcAlign === 'boolean') cur.ctcAlign = s.ctcAlign; writeSettings(cur); return send(res, 200, { ok: true, ...settingsView(cur) }); }

    if (p === '/api/progress') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const cid = url.searchParams.get('cid') || ('c' + Math.random().toString(36).slice(2));
      clients.set(cid, res); req.on('close', () => { if (clients.get(cid) === res) clients.delete(cid); }); return;
    }

    if (p === '/api/upload-font' && req.method === 'POST') {
      try {
        const buf = await readBody(req);
        const name = req.headers['x-filename'] || 'font.ttf';
        let family = ''; try { family = decodeURIComponent(req.headers['x-family'] || ''); } catch {}
        const entry = fontsLib.addFont(CUSTOM_FONTS, name, buf, family);
        return send(res, 200, { ok: true, font: { ...entry, url: `/customfonts/${entry.file}` } });
      } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const name = safeId(req.headers['x-filename'] || 'video.mp4');
      const ext = path.extname(name).toLowerCase() || '.mp4';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const dest = path.join(UPLOADS, id);
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on('finish', () => send(res, 200, { ok: true, id, fileUrl: `/media/${id}` }));
      ws.on('error', (e) => send(res, 500, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (p === '/api/transcribe' && req.method === 'POST') {
      const { id, style, language = 'english', script = 'native', cid } = await readJson(req);
      const prog = (o) => sendTo(cid, o);
      const video = path.join(UPLOADS, safeId(id));
      if (!fs.existsSync(video)) return send(res, 400, { ok: false, error: 'upload not found' });
      try {
        const project = await heavy(cid, 'transcribe', async () => {
        const cfg = LANGS[language] || LANGS.english;
        prog({ stage: 'extract' });
        const pcm = path.join(WORK, `audio-${safeId(id)}.f32`);
        await run(FFMPEG, ['-y', '-i', video, '-ar', '16000', '-ac', '1', '-f', 'f32le', pcm]);
        const duration = probeDuration(video);
        // PREVIEW PROXY (runs in PARALLEL with transcription): a light ~540p h264 the browser can
        // decode smoothly in the editor. Un-accelerated browsers (common on Linux) choke on a full
        // 1080x1920 clip live under the caption overlay. The full-res ORIGINAL is untouched and is
        // what export uses (render resolves project.__id). If it fails, we fall back to the original.
        const proxyName = safeId(id).replace(/\.[^.]+$/, '') + '.proxy.mp4';
        const proxyPath = path.join(UPLOADS, proxyName);
        const proxyProm = run(FFMPEG, ['-y', '-i', video,
          '-vf', 'scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '96k', proxyPath])
          .then(() => (fs.existsSync(proxyPath) ? `/media/${proxyName}` : `/media/${id}`))
          .catch(() => `/media/${id}`);

        let words = null, outScript;
        // FAST PATH: AI Hinglish + CTC — no whisper (silence-detect -> Gemini -> CTC).
        if (cfg.gemini && readSettings().geminiKey && readSettings().ctcAlign !== false) {
          words = await geminiCtcFastWeb(video, pcm, duration, id, prog);
          if (words && words.length) outScript = 'roman';
        }
        // FALLBACK: whisper (non-AI modes, or when the fast path couldn't run).
        if (!words || !words.length) {
          const { fromWhisper } = await import(new URL('../engine/import.mjs', import.meta.url));
          const tj = path.join(WORK, `tx-${safeId(id)}.json`);
          const highAcc = readSettings().whisperQuality === 'high';
          const useMedium = highAcc && !cfg.gemini;
          const model = /\.en$/i.test(cfg.model) ? cfg.model : (useMedium ? 'Xenova/whisper-medium' : cfg.model);
          await runWhisper([WHISPER_WORKER, pcm, tj, model, MODELS, cfg.whisper], prog);
          let w = fromWhisper(JSON.parse(fs.readFileSync(tj, 'utf8')));
          if (!w.length) { fs.rmSync(pcm, { force: true }); fs.rmSync(tj, { force: true }); throw new Error('NO_SPEECH'); }
          if (cfg.gemini && readSettings().geminiKey) {
            words = await geminiReconcileWeb(video, w, prog, pcm);
            outScript = 'roman';
          } else {
            const wantRoman = cfg.roman || (language === 'hindi' && script === 'roman');
            if (wantRoman) { const { romanizeWords } = await import(new URL('../engine/translit.cjs', import.meta.url)); w = romanizeWords(w); }
            words = w;
            outScript = language === 'english' ? 'latin' : wantRoman ? 'roman' : 'native';
          }
          fs.rmSync(tj, { force: true });
        }
        const dims = probeDims(video);
        const previewUrl = await proxyProm;   // editor plays the light proxy; __id keeps the original for export
        const proj = { video: id, ...dims, fps: 30, style: style || 'hormozi-active', styleOverrides: {}, segmentation: null, offset: 0.12, maxLines: 2, language, script: outScript, autoHighlight: { enabled: true, rules: ['numbers', 'allcaps'], keywords: [] }, kinetic: [], words, duration, waveform: computePeaks(pcm), fileUrl: previewUrl, __id: id };
        fs.rmSync(pcm, { force: true });
        return proj;
        });   // end heavy()
        prog({ stage: 'done' });
        return send(res, 200, { ok: true, project });
      } catch (e) {
        if (String(e && e.message) === 'NO_SPEECH') { prog({ stage: 'error' }); return send(res, 200, { ok: false, error: 'No speech detected.' }); }
        prog({ stage: 'error' }); return send(res, 200, { ok: false, error: 'Transcription failed: ' + String(e.message || e).slice(0, 400) });
      }
    }

    if ((p === '/api/render' || p === '/api/preview') && req.method === 'POST') {
      const clip = p === '/api/preview';
      const body = await readJson(req);
      const project = body.project;
      const prog = (o) => sendTo(body.cid, o);
      // client sends the uploaded id; resolve the real path server-side
      project.video = path.join(UPLOADS, safeId(project.__id || (project.fileUrl || '').replace('/media/', '')));
      if (!fs.existsSync(project.video)) return send(res, 400, { ok: false, error: 'source video not found' });
      const style = resolveStyle(project);
      const outId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const out = path.join(OUT, outId);
      const jobPath = path.join(WORK, `job-${outId}.json`);
      const job = { project, style, out };
      if (clip) { job.ss = Math.max(0, body.ss || 0); job.dur = body.dur || 4; }
      fs.writeFileSync(jobPath, JSON.stringify(job));
      try {
        await heavy(body.cid, 'export', () => runRender(jobPath, prog));
        fs.rmSync(jobPath, { force: true });
        return send(res, 200, { ok: true, fileUrl: `/out/${outId}`, path: `/out/${outId}` });
      } catch (e) { prog({ stage: 'error' }); return send(res, 200, { ok: false, error: (clip ? 'Preview' : 'Export') + ' failed: ' + String(e.message || e).slice(0, 400) }); }
    }

    if (p === '/api/exportAlpha' && req.method === 'POST') {
      const body = await readJson(req);
      const project = body.project;
      const prog = (o) => sendTo(body.cid, o);
      project.video = path.join(UPLOADS, safeId(project.__id || (project.fileUrl || '').replace('/media/', '')));
      if (!fs.existsSync(project.video)) return send(res, 400, { ok: false, error: 'source video not found' });
      const style = resolveStyle(project);
      const outId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mov`;
      const out = path.join(OUT, outId);
      const jobPath = path.join(WORK, `job-${outId}.json`);
      fs.writeFileSync(jobPath, JSON.stringify({ project, style, out, alpha: true }));
      try {
        await heavy(body.cid, 'export', () => runRender(jobPath, prog));
        fs.rmSync(jobPath, { force: true });
        return send(res, 200, { ok: true, fileUrl: `/out/${outId}`, path: `/out/${outId}` });
      } catch (e) { prog({ stage: 'error' }); return send(res, 200, { ok: false, error: 'Alpha export failed: ' + String(e.message || e).slice(0, 400) }); }
    }

    if (p === '/api/polish' && req.method === 'POST') return gemini(res, await readJson(req), 'polish');
    if (p === '/api/ai-highlight' && req.method === 'POST') return gemini(res, await readJson(req), 'highlight');

    // ---------- rnf auto-editor (/rnf-automation web UI) ----------
    if (p === '/api/rnf/project' && req.method === 'POST') {
      const { game } = await readJson(req);
      if (!game || !String(game).trim()) return send(res, 200, { ok: false, error: 'game name required' });
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const dir = rnfAuto.projDir(id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, game: String(game).trim(), gameName: String(game).trim(), source: 'source.mp4', createdAt: Date.now() }, null, 2));
      rnfAuto.setStatus(id, { stage: 'new', pct: 0, msg: 'created', done: false });
      return send(res, 200, { ok: true, id });
    }
    if (p === '/api/rnf/source' && req.method === 'POST') {
      const id = safeId(url.searchParams.get('id'));
      const dir = rnfAuto.projDir(id);
      if (!fs.existsSync(dir)) return send(res, 200, { ok: false, error: 'unknown project' });
      const ws = fs.createWriteStream(path.join(dir, 'source.mp4'));
      req.pipe(ws);
      ws.on('finish', () => send(res, 200, { ok: true }));
      ws.on('error', (e) => send(res, 500, { ok: false, error: String(e.message || e) }));
      return;
    }
    if (p === '/api/rnf/prepare' && req.method === 'POST') {
      const { id } = await readJson(req);
      const dir = rnfAuto.projDir(safeId(id));
      if (!fs.existsSync(path.join(dir, 'source.mp4'))) return send(res, 200, { ok: false, error: 'upload the video first' });
      launchRnf('prepare', safeId(id));
      return send(res, 200, { ok: true, started: true });
    }
    if (p === '/api/rnf/status' && req.method === 'GET') {
      return send(res, 200, { ok: true, status: rnfAuto.getStatus(safeId(url.searchParams.get('id'))) });
    }
    if (p === '/api/rnf/projects' && req.method === 'GET') {
      // server-side gallery: every rnf project on the box (batch reels + tool-made + demo)
      const root = path.join(WEB, 'work', 'rnf');
      let items = [];
      try {
        for (const id of fs.readdirSync(root)) {
          const dir = path.join(root, id);
          if (!fs.statSync(dir).isDirectory()) continue;
          const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
          const meta = rd('meta.json', null); if (!meta) continue;
          const st = rd('status.json', {}); const deliver = rd('deliver.json', null);
          const lib = rd('library.json', []); const pl = rd('placements.json', []);
          const has = (f) => fs.existsSync(path.join(dir, f));
          const INTERNAL = new Set(['arknights-test', 'demo-arknights']); // hide scaffolding
          if (INTERNAL.has(id)) continue;
          if (!has('final.mp4') && !has('preview.mp4')) continue; // hide un-prepared shells
          items.push({ id, game: meta.game || meta.gameName || id, stage: st.stage || 'new', at: meta.createdAt || 0,
            hasFinal: has('final.mp4'), hasPreview: has('preview.mp4'), batch: !!meta.batch,
            hasBroll: Array.isArray(lib) && lib.length > 0 && Array.isArray(pl) && pl.some((x) => x.clip),
            driveLink: (deliver && deliver.driveLink) || st.driveLink || null,
            thumb: has('poster.png') ? `/rnf-media/${id}/poster.png` : null });
        }
      } catch {}
      // delivered reels first, then batch, then most-recent
      const rank = (p) => (p.hasFinal ? 0 : 1);
      items.sort((a, b) => rank(a) - rank(b) || (b.batch - a.batch) || (b.at || 0) - (a.at || 0));
      return send(res, 200, { ok: true, projects: items });
    }
    if (p === '/api/rnf/project' && req.method === 'GET') {
      const id = safeId(url.searchParams.get('id'));
      const dir = rnfAuto.projDir(id);
      if (!fs.existsSync(dir)) return send(res, 200, { ok: false, error: 'unknown project' });
      const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
      const meta = rd('meta.json', {}); const plan = rd('plan.json', null); const library = rd('library.json', []);
      const placements = rd('placements.json', plan ? plan.placements : []);
      const deliver = rd('deliver.json', null);
      const has = (f) => fs.existsSync(path.join(dir, f));
      return send(res, 200, { ok: true, id, meta, plan, library, placements, deliver, status: rnfAuto.getStatus(id),
        media: { preview: has('preview.mp4') ? `/rnf-media/${id}/preview.mp4` : null, final: has('final.mp4') ? `/rnf-media/${id}/final.mp4` : null } });
    }
    if (p === '/api/rnf/broll-upload' && req.method === 'POST') {
      const id = safeId(url.searchParams.get('id'));
      const dir = rnfAuto.projDir(id);
      if (!fs.existsSync(dir)) return send(res, 200, { ok: false, error: 'unknown project' });
      const name = safeId(req.headers['x-filename'] || 'gameplay.mp4');
      const tmp = path.join(dir, 'upload-tmp-' + Date.now() + path.extname(name));
      const ws = fs.createWriteStream(tmp);
      req.pipe(ws);
      ws.on('error', (e) => send(res, 500, { ok: false, error: String(e.message || e) }));
      ws.on('finish', async () => {
        try { const item = await rnfAuto.addUpload(id, tmp, req.headers['x-filename'] || name); fs.rmSync(tmp, { force: true }); send(res, 200, { ok: true, item }); }
        catch (e) { fs.rmSync(tmp, { force: true }); send(res, 200, { ok: false, error: String(e.message || e).slice(0, 300) }); }
      });
      return;
    }
    if (p === '/api/rnf/placements' && req.method === 'POST') {
      const { id, placements } = await readJson(req);
      const dir = rnfAuto.projDir(safeId(id));
      if (!fs.existsSync(dir)) return send(res, 200, { ok: false, error: 'unknown project' });
      fs.writeFileSync(path.join(dir, 'placements.json'), JSON.stringify(placements || [], null, 2));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/rnf/render' && req.method === 'POST') {
      const { id, placements } = await readJson(req);
      const dir = rnfAuto.projDir(safeId(id));
      if (!fs.existsSync(path.join(dir, 'base_nocap.mp4'))) return send(res, 200, { ok: false, error: 'not prepared yet' });
      if (Array.isArray(placements)) fs.writeFileSync(path.join(dir, 'placements.json'), JSON.stringify(placements, null, 2));
      launchRnf('finalize', safeId(id));
      return send(res, 200, { ok: true, started: true });
    }

    res.writeHead(404); res.end('not found');
  } catch (e) { try { send(res, 500, { ok: false, error: String(e.message || e) }); } catch {} }
});

function safeJoin(p) { return p.split('/').map(safeSeg).filter(Boolean).join(path.sep); }
function safeSeg(s) { return s === '..' ? '' : s.replace(/[^a-zA-Z0-9._-]/g, ''); }

// serve a file under work/rnf/<id>/... (project media: preview, final, b-roll clips/thumbs)
function serveRnfMedia(req, res, rel) {
  const parts = rel.split('/').map(safeSeg).filter(Boolean);
  if (parts.length < 2) { res.writeHead(404); return res.end('not found'); }
  const file = path.join(WEB, 'work', 'rnf', ...parts);
  return serveFile(req, res, file);
}
// launch the detached rnf runner (prepare/finalize) so long renders survive teardown
function launchRnf(cmd, id) {
  const dir = path.join(WEB, 'work', 'rnf', safeSeg(id));
  const logfd = fs.openSync(path.join(dir, 'run.log'), 'a');
  const child = spawn('setsid', ['node', path.join(WEB, 'rnf-run.mjs'), cmd, id], { cwd: WEB, detached: true, stdio: ['ignore', logfd, logfd], env: { ...process.env } });
  child.unref();
}

// Auto-resolve the Gemini model from the user's key (cached in settings); mirrors main.cjs.
async function geminiModelIdWeb(key, force = false) {
  if (!force) { const s = readSettings(); if (s.geminiModel) return s.geminiModel; }
  else { const c = readSettings(); delete c.geminiModel; writeSettings(c); }
  const gem = (await import(new URL('../engine/gemini-hinglish.cjs', import.meta.url))).default;
  return gem.resolveModel({ key, saveModel: (m) => { const c = readSettings(); c.geminiModel = m; writeSettings(c); } });
}

// AI Hinglish content pass for the web server (mirrors main.cjs geminiReconcile). Any
// failure degrades to the offline romanized-whisper words so the mode never regresses.
// silence intervals via ffmpeg silencedetect (no model) -> [{start,end}]
function detectSilencesWeb(wav) {
  return new Promise((resolve) => {
    let err = '';
    try {
      const p = spawn(FFMPEG, ['-i', wav, '-af', 'silencedetect=noise=-30dB:d=0.25', '-f', 'null', '-']);
      p.stderr.on('data', (d) => (err += d));
      p.on('error', () => resolve([]));
      p.on('close', () => {
        const s = []; let c = null;
        for (const l of err.split('\n')) {
          const a = l.match(/silence_start:\s*([0-9.]+)/); const b = l.match(/silence_end:\s*([0-9.]+)/);
          if (a) c = parseFloat(a[1]);
          if (b && c != null) { s.push({ start: c, end: parseFloat(b[1]) }); c = null; }
        }
        resolve(s);
      });
    } catch { resolve([]); }
  });
}

// FAST AI-Hinglish path for the web (mirrors main.cjs geminiCtcFast): NO whisper.
async function geminiCtcFastWeb(video, pcm, duration, id, broadcast) {
  const key = readSettings().geminiKey;
  const gem = (await import(new URL('../engine/gemini-hinglish.cjs', import.meta.url))).default;
  const eng = await import(new URL('../engine/reconcile.mjs', import.meta.url));
  const wav = path.join(WORK, `audio16-${safeId(id)}.wav`);
  const chunksPath = path.join(WORK, `ctc-chunks-${safeId(id)}.json`);
  const ctcOut = path.join(WORK, `ctc-out-${safeId(id)}.json`);
  try {
    await run(FFMPEG, ['-y', '-i', video, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    broadcast({ stage: 'gemini', msg: 'transcribing' });
    const silences = await detectSilencesWeb(wav);
    const plan = gem.planChunksByTime(duration, silences.map((s) => (s.start + s.end) / 2));
    if (!plan.length) return null;
    let ci = 0;
    const extractChunkB64 = async (start, dur) => {
      const cf = path.join(WORK, `gc-${safeId(id)}-${ci++}.wav`);
      try {
        await run(FFMPEG, ['-y', '-ss', String(start), '-t', String(dur), '-i', wav, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', cf]);
        return fs.readFileSync(cf).toString('base64');
      } finally { fs.rmSync(cf, { force: true }); }
    };
    const { chunks } = await gem.transcribeHinglish({
      key, chunks: plan, extractChunkB64,
      resolveCandidates: () => gem.resolveModelCandidates({ key, saveModel: (m) => { const c = readSettings(); c.geminiModel = m; writeSettings(c); } }),
      onProgress: broadcast,
    });
    if (!chunks.length || !chunks.some((c) => c.gWords && c.gWords.length)) return null;
    let ctc = null;
    try {
      fs.writeFileSync(chunksPath, JSON.stringify(chunks.map((c) => ({ start: Math.max(0, c.tStart - 0.1), end: c.tEnd + 0.1, words: c.gWords }))));
      await runWhisper([ALIGN_WORKER, pcm, ctcOut, chunksPath, CTC_MODEL, MODELS], broadcast);
      ctc = JSON.parse(fs.readFileSync(ctcOut, 'utf8')).chunks;
    } catch (e) { broadcast({ stage: 'ctc-fallback', msg: String(e.message || e).slice(0, 120) }); return null; }
    const all = [];
    chunks.forEach((c, i) => {
      let w = ctc && ctc[i] ? eng.applyCtcTimes(c.gWords, ctc[i], c.tStart, c.tEnd) : null;
      if (!w || !w.length) { try { w = eng.reconcileChunk(c.wWords, c.gWords, c.tStart, c.tEnd); } catch { w = null; } }
      if (w && w.length) for (const x of w) all.push(x);
    });
    const resArr = eng.enforceTimeline(all);
    return (resArr && resArr.length) ? resArr : null;
  } catch (e) { broadcast({ stage: 'gemini-fallback', msg: String(e.message || e).slice(0, 140) }); return null; }
  finally { fs.rmSync(wav, { force: true }); fs.rmSync(chunksPath, { force: true }); fs.rmSync(ctcOut, { force: true }); }
}

async function geminiReconcileWeb(video, whisperWords, broadcast, pcm) {
  const key = readSettings().geminiKey;
  const gem = (await import(new URL('../engine/gemini-hinglish.cjs', import.meta.url))).default;
  const eng = await import(new URL('../engine/reconcile.mjs', import.meta.url));   // reconcileChunk, applyCtcTimes, enforceTimeline
  const { romanizeWords } = await import(new URL('../engine/translit.cjs', import.meta.url));
  const romanCanon = (ws) => romanizeWords(ws).map((w) => ({ text: w.text, start: +w.start, end: +w.end, hi: false, on: true, conf: 1 }));
  const wav = path.join(WORK, `audio16-${Date.now()}.wav`);
  try {
    await run(FFMPEG, ['-y', '-i', video, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    let ci = 0;
    const extractChunkB64 = async (start, dur) => {
      const cf = path.join(WORK, `gchunk-${Date.now()}-${ci++}.wav`);
      try {
        await run(FFMPEG, ['-y', '-ss', String(start), '-t', String(dur), '-i', wav, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', cf]);
        return fs.readFileSync(cf).toString('base64');
      } finally { fs.rmSync(cf, { force: true }); }
    };
    const { chunks } = await gem.transcribeHinglish({
      key, words: whisperWords, extractChunkB64,
      resolveCandidates: () => gem.resolveModelCandidates({ key, saveModel: (m) => { const c = readSettings(); c.geminiModel = m; writeSettings(c); } }),
      onProgress: broadcast,
    });
    if (!chunks.length) return romanCanon(whisperWords);

    // Stage 2: CTC forced-alignment (frame-perfect), then reconcile then offline per chunk.
    let ctc = null;
    if (readSettings().ctcAlign !== false && pcm && fs.existsSync(pcm)) {
      const chunksPath = path.join(WORK, `ctc-chunks-${Date.now()}.json`);
      const ctcOut = path.join(WORK, `ctc-out-${Date.now()}.json`);
      try {
        fs.writeFileSync(chunksPath, JSON.stringify(chunks.map((c) => ({ start: Math.max(0, c.tStart - 0.1), end: c.tEnd + 0.1, words: c.gWords }))));
        await runWhisper([ALIGN_WORKER, pcm, ctcOut, chunksPath, CTC_MODEL, MODELS], broadcast);
        ctc = JSON.parse(fs.readFileSync(ctcOut, 'utf8')).chunks;
      } catch (e) { broadcast({ stage: 'ctc-fallback', msg: String(e.message || e).slice(0, 120) }); ctc = null; }
      finally { fs.rmSync(chunksPath, { force: true }); fs.rmSync(ctcOut, { force: true }); }
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
  } catch (e) { broadcast({ stage: 'gemini-fallback', msg: String(e.message || e).slice(0, 140) }); return romanCanon(whisperWords); }
  finally { fs.rmSync(wav, { force: true }); }
}

async function gemini(res, body, mode) {
  const key = readSettings().geminiKey;
  if (!key) return send(res, 200, { ok: false, error: 'No Gemini API key set (open Settings).' });
  const words = body.words || [];
  let prompt;
  if (mode === 'highlight') {
    const numbered = words.map((w, i) => `${i}:${w.text}`).join(' ');
    prompt = `You label caption words for punchy short-form video. From the numbered words, choose the 15-25% most impactful "power words" (numbers, key nouns, strong verbs, emotional words). Skip filler. Return ONLY JSON: {"highlight":[<indices>]}.\nWords: ${numbered}`;
  } else {
    const list = words.map((w) => String(w.text));
    const target = body.script === 'roman' ? 'natural Roman Hinglish how Indian creators type (e.g. "aapka","mein","kyunki") — keep English words in English' : body.language === 'hindi' ? 'correct Devanagari Hindi' : body.language === 'urdu' ? 'correct Urdu script' : 'correctly spelled words';
    prompt = `Fix ASR caption spelling. Rewrite each word to ${target}. Return EXACTLY ${list.length} strings, same order, one per input word. Do NOT split/merge/add/drop. Return ONLY JSON: {"words":[...]}.\nInput (${list.length}): ${JSON.stringify(list)}`;
  }
  try {
    const url = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
    const post = (m) => fetch(url(m), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.15 } }) });
    let r = await post(await geminiModelIdWeb(key));
    if (r.status === 404) r = await post(await geminiModelIdWeb(key, true));
    if (!r.ok) return send(res, 200, { ok: false, error: `Gemini ${r.status}` });
    const data = await r.json(); const parsed = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    if (mode === 'highlight') { const hi = Array.isArray(parsed.highlight) ? parsed.highlight.filter((n) => Number.isInteger(n) && n >= 0 && n < words.length) : []; return send(res, 200, { ok: true, highlight: hi }); }
    const fixed = Array.isArray(parsed.words) ? parsed.words.map((s) => String(s)) : [];
    if (fixed.length !== words.length) return send(res, 200, { ok: false, error: `Gemini changed the word count; kept original.` });
    return send(res, 200, { ok: true, words: fixed });
  } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
}

server.listen(PORT, '127.0.0.1', () => console.log(`captions-web on http://127.0.0.1:${PORT}`));
