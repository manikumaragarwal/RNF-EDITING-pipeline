// rnf-auto — orchestration for the rest.not.found (rnf) auto-editor tool
// (/rnf-automation web UI). Wraps the proven Arknights recipe:
//   prepare(id)  : transcribe -> author captions + edit-plan -> gather b-roll ->
//                  render Pass A base (source+poster+tint+audio) + caption alpha +
//                  b-roll thumbnails.  b-roll is NOT baked here.
//   finalize(id) : Pass B composite (chosen b-roll 50/50 splits + captions y-shift)
//                  -> mux -> rclone push to Drive.
// Progress is written to work/rnf/<id>/status.json (the UI polls it). Long renders run
// inside a DETACHED wrapper (rnf-run.mjs) so a session teardown never SIGKILLs them.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkReel, writeVerdict } from './rnf-check.mjs';
import { REPO, SFX, SEED_ROOT, STEAM_EXTRACT, GEMINI_ENV, DRIVE_DEST } from './rnf-paths.mjs';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(WEB, '..');
const RNF_ROOT = path.join(WEB, 'work', 'rnf');
const PORT = parseInt(process.env.PORT || '3016', 10);
const FFMPEG = process.env.CAP_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.CAP_FFPROBE || 'ffprobe';

fs.mkdirSync(RNF_ROOT, { recursive: true });

// ---------- tiny fs / proc helpers ----------
export const projDir = (id) => path.join(RNF_ROOT, String(id).replace(/[^a-zA-Z0-9._-]/g, ''));
const rd = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wr = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
export function setStatus(id, patch) {
  const f = path.join(projDir(id), 'status.json');
  const cur = rd(f, {});
  const next = { ...cur, ...patch, at: Date.now() };
  wr(f, next);
  return next;
}
export const getStatus = (id) => rd(path.join(projDir(id), 'status.json'), { stage: 'new' });

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts); let out = '', err = '';
    p.stdout && p.stdout.on('data', (d) => (out += d));
    p.stderr && p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error((err || out).slice(-1800)))));
  });
}
const ffprobeDur = (v) => { try { return parseFloat(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', v], { encoding: 'utf8' }).stdout.trim()) || 0; } catch { return 0; } };
const ffprobeDims = (v) => { try { const s = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', v], { encoding: 'utf8' }).stdout.trim(); const [w, h] = s.split('x').map(Number); return { w, h }; } catch { return { w: 0, h: 0 }; } };
// motion-scan a clip → start-seconds of a windowLen section that is CONTINUOUSLY MOVING
// (avoids static title-cards / frozen shots). Falls back to 0 on any error.
const MOTION_SCAN = path.join(WEB, 'motion-scan.py');
function bestClipIn(clipPath, windowLen, zoneStart, zoneEnd) {
  try {
    const args = [MOTION_SCAN, clipPath, String(windowLen)];
    if (zoneStart != null && zoneEnd != null) args.push(String(zoneStart), String(zoneEnd));
    const o = spawnSync('python3', args, { encoding: 'utf8', timeout: 60000 }).stdout.trim();
    const n = parseFloat(o); return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}
// mean volume (dB) of a section; -99 for silence/error. Used to guarantee AUDIBLE music.
function sectionMeanVol(file, start, dur) {
  try { const e = spawnSync(FFMPEG, ['-ss', String(start), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || ''; const m = e.match(/mean_volume:\s*(-?[0-9.]+) dB/); return m ? parseFloat(m[1]) : -99; } catch { return -99; }
}
// pick a NON-SILENT start offset in a music track (some long mixes have silent gaps; a random
// offset there = "no music"). Try a few id-derived offsets, return the first audible one.
function audibleMusicStart(file, dur, key) {
  const mDur = ffprobeDur(file); if (mDur <= dur + 1) return 0;
  let h = 0; const s = String(key || 'x'); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const range = Math.max(1, Math.floor(mDur - dur - 5));
  const cands = [10 + (h % range), 30, Math.floor(mDur * 0.3), Math.floor(mDur * 0.55), 0];
  for (const c of cands) { const st = Math.max(0, Math.min(c, mDur - dur - 1)); if (sectionMeanVol(file, st, Math.min(dur, 8)) > -40) return +st.toFixed(2); }
  return 30;
}

// ---------- self-call the running captions server (reuses transcribe + exportAlpha) ----------
function api(pathname, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const isBuf = Buffer.isBuffer(body);
    const data = body == null ? null : (isBuf ? body : Buffer.from(JSON.stringify(body)));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method,
      headers: { ...(data && !isBuf ? { 'content-type': 'application/json' } : {}), ...(data ? { 'content-length': data.length } : {}), ...headers } },
      (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(s); } }); });
    req.on('error', reject);
    req.setTimeout(590000, () => req.destroy(new Error('api timeout ' + pathname)));
    if (data) req.write(data);
    req.end();
  });
}

// Pin the active person's Gemini key so hinglish-ai transcription never depends on who
// last greeted (box-global active-person churns). Never logs the key.
function pinGeminiKey() {
  try {
    if (process.env.GEMINI_API_KEY) return api('/api/settings', 'POST', { geminiKey: process.env.GEMINI_API_KEY }).then(() => true).catch(() => false);
    if (!fs.existsSync(GEMINI_ENV)) return false;
    const raw = fs.readFileSync(GEMINI_ENV, 'utf8');
    const m = raw.match(/(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*["']?([^"'\s]+)/);
    if (!m) return false;
    return api('/api/settings', 'POST', { geminiKey: m[1] }).then(() => true).catch(() => false);
  } catch { return false; }
}

// ---------- Gemini edit-planner (authors caption lines + keywords + beats) ----------
// One structured call over the transcript. Robust heuristic fallback if it fails.
function readSettings() { try { return JSON.parse(fs.readFileSync(path.join(WEB, 'work', 'settings.json'), 'utf8')); } catch { return {}; } }
async function geminiPlan(words, gameName, duration) {
  const st = readSettings();
  // key: prefer the pinned settings key, else the person's env file
  const key = st.geminiKey || process.env.GEMINI_API_KEY || (() => { try { const raw = fs.readFileSync(GEMINI_ENV, 'utf8'); const m = raw.match(/(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*["']?([^"'\s]+)/); return m ? m[1] : null; } catch { return null; } })();
  // model: reuse whatever the server already resolved for this key (avoids retired-model 404s)
  const models = [st.geminiModel, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'].filter(Boolean);
  const numbered = words.map((w, i) => `${i}:${w.text}`).join(' ');
  const prompt = `You are editing a Hinglish gaming reel about the game "${gameName}". Below are the transcript words, each "index:word". Return ONLY JSON:
{"lineBreaks":[<word indices that START a new caption line>],
 "keywords":[<word indices to color yellow: the punchy nouns/verbs/numbers, ~15%>],
 "gameNameSpan":[<startIdx>,<endIdx>] or null (the words where the game's name is spoken; these should be their OWN caption line),
 "tintBeat":[<startIdx>,<endIdx>] or null (ONLY a line that is genuinely SARCASTIC: the speaker says the opposite of what he means, mocks, or makes a dry deadpan jab. Dramatic, hype, challenge or "but here's the catch" lines are NOT sarcasm. If no line is clearly sarcastic return null, which is the normal case),
 "hideWords":[<indices of stutters/false-starts/repeats to hide>]}
Rules: caption lines are short semantic phrases of ~2-4 words (never 1 long run-on). The game name gets its own isolated line. tintBeat is at most ONE line and only if it is sarcastic; otherwise null. Word 0 is always a line break.
Words: ${numbered}`;
  if (key) {
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }) });
        if (r.status === 404) continue; // retired model — try next candidate
        if (!r.ok) break;
        const data = await r.json();
        const parsed = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
        if (Array.isArray(parsed.lineBreaks)) return normalizePlan(parsed, words);
      } catch { /* try next / fall through */ }
    }
  }
  return heuristicPlan(words);
}
function normalizePlan(p, words) {
  const n = words.length;
  const clamp = (a) => (Array.isArray(a) ? a.filter((x) => Number.isInteger(x) && x >= 0 && x < n) : []);
  const lb = new Set(clamp(p.lineBreaks)); lb.add(0);
  return {
    lineBreaks: [...lb].sort((a, b) => a - b),
    keywords: clamp(p.keywords),
    gameNameSpan: Array.isArray(p.gameNameSpan) && p.gameNameSpan.length === 2 ? p.gameNameSpan.map(Number) : null,
    tintBeat: Array.isArray(p.tintBeat) && p.tintBeat.length === 2 ? p.tintBeat.map(Number) : null,
    hideWords: clamp(p.hideWords),
  };
}
function heuristicPlan(words) {
  const lineBreaks = []; for (let i = 0; i < words.length; i += 3) lineBreaks.push(i);
  return { lineBreaks, keywords: [], gameNameSpan: null, tintBeat: null, hideWords: [] };
}

// Overwrite the mis-transcribed game-name words with the exact filename spelling, mark
// them yellow, and force the name onto its own caption line. Mutates `words` + `plan`.
function correctGameName(words, plan, gameName) {
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
  const nameN = norm(gameName);
  // The planner (Gemini) is not deterministic and can mark the wrong words as the name ("satte" in
  // "who's cheating", seen 2026-10-19). If the transcript spells the name out exactly (words joined
  // == name), that exact match wins over the planner's span.
  let exact = null;
  for (let i = 0; i < words.length && !exact; i++) {
    let acc = '';
    for (let j = i; j < words.length && j - i < 5; j++) {
      acc += norm(words[j].text);
      if (acc === nameN && j - i >= 0) { exact = [i, j]; break; }
      if (!nameN.startsWith(acc)) break;
    }
  }
  if (exact) plan.gameNameSpan = exact;
  const span = plan.gameNameSpan;
  if (!span || span.length !== 2) return;
  const [s, e0] = [Math.max(0, span[0]), Math.min(words.length - 1, span[1])];
  if (e0 < s) return;
  // hinglish-ai splits one-word names ("Brushland" -> "brush","land") and the planner may mark only
  // the first half. Absorb following words while the joined spoken text is still a prefix of the name.
  let e = e0;
  let joined = words.slice(s, e + 1).map((w) => norm(w.text)).join('');
  while (e + 1 < words.length && joined.length < nameN.length && nameN.startsWith(joined) && nameN.startsWith(joined + norm(words[e + 1].text))) {
    e += 1; joined += norm(words[e].text);
  }
  plan.gameNameSpan = [s, e];
  const tokens = String(gameName).trim().split(/\s+/); // ["Arknights:", "Endfield"]
  const nSpan = e - s + 1;
  for (let i = s; i <= e; i++) {
    const ti = i - s;
    if (ti < tokens.length) {
      // if the span is shorter than the name, cram the remaining tokens onto the last span word
      words[i].text = (ti === nSpan - 1) ? tokens.slice(ti).join(' ') : tokens[ti];
      words[i].on = true;
    } else {
      words[i].on = false; // span longer than the name -> hide the extra words
    }
  }
  // make the name its own line + keyword-yellow
  const brk = new Set(plan.lineBreaks); brk.add(s); if (e + 1 < words.length) brk.add(e + 1);
  plan.lineBreaks = [...brk].sort((a, b) => a - b);
  const key = new Set(plan.keywords); for (let i = s; i <= e; i++) key.add(i);
  plan.keywords = [...key];
}

// Ensure a B&W dramatic beat "when needed": if the planner didn't flag one, look for a
// provocative/negative line in the first ~45% of the reel (the hook) and tint THAT.
const TINT_MARKERS = /^(thoo|thu|thuu|chi|chhi|mat|nahi|nhi|na|waste|bakwaas|bekaar|ghatiya|bura|buri|worst|galat|sharam|pathetic|trash|bhaag|bhag|ruk|stop|warna|nikal|chhod|chod|kabhi|never|sabse|disgust|cringe|noob|loser|gareeb)$/i;
function ensureTintBeat(words, plan, duration) {
  if (plan.tintBeat && plan.tintBeat.length === 2) return;
  const cutoff = duration * 0.45;
  const brk = [...new Set(plan.lineBreaks)].sort((a, b) => a - b);
  for (let li = 0; li < brk.length; li++) {
    const s = brk[li]; const e = (brk[li + 1] != null ? brk[li + 1] - 1 : words.length - 1);
    if (!words[s] || words[s].start > cutoff) break;
    const hit = words.slice(s, e + 1).some((w) => TINT_MARKERS.test(String(w.text).replace(/[^a-zA-Z]/g, '')));
    if (hit) { plan.tintBeat = [s, e]; return; }
  }
}

// Build caption LINES (for the UI timeline) from a plan + words.
function linesFromPlan(words, plan) {
  const brk = new Set(plan.lineBreaks);
  const lines = []; let cur = null;
  words.forEach((w, i) => {
    if (brk.has(i) || cur == null) { cur = { start: w.start, end: w.end, words: [], idxs: [] }; lines.push(cur); }
    if (w.on !== false) cur.words.push(w.text);
    cur.idxs.push(i); cur.end = w.end;
  });
  return lines.map((l) => ({ text: l.words.join(' '), start: +l.start.toFixed(2), end: +l.end.toFixed(2), idxs: l.idxs }));
}

// Suggested b-roll split windows = the "explanation" span between the name reveal and the
// closing CTA. We split it into ~6s chunks so each gets its own b-roll pick.
function suggestWindows(words, plan, duration, lines) {
  const nameStart = plan.gameNameSpan ? (words[plan.gameNameSpan[0]]?.start ?? duration * 0.12) : Math.min(duration * 0.12, 2.5);
  const nameEnd = plan.gameNameSpan ? words[Math.min(plan.gameNameSpan[1], words.length - 1)]?.end || 0 : Math.min(duration * 0.18, 3);
  // CTA heuristic: last ~22% of the clip is the call-to-action -> full frame, no b-roll.
  const ctaStart = Math.max(nameEnd + 3, duration * 0.78);
  // Start the split AT the name reveal (= poster reveal) so the poster sits IN the upper
  // split, not over a full-frame shot. Hook (before the name) stays full-frame.
  let from = Math.max(Math.min(nameStart, nameEnd) - 0.05, 1.5);
  // Manish 2026-10-21 (Who's Cheating, name said at 8.4s): if the full-frame opening would run past ~3.6s
  // before the name, split EARLY (first caption-line boundary in 2.3-3.6s, else 2.6s). The poster still
  // lands on the name drop, overlaid on top of the split.
  if (from > 3.6) { const early = (lines || []).map((l) => l.start).find((t) => t >= 2.3 && t <= 3.6); from = early != null ? +early : 2.6; }
  const to = Math.max(from + 2, ctaStart);
  // Multiple beat-aligned segments so the b-roll CUTS to roughly match what's being said.
  // Cut at caption-line boundaries, ~2.6-4s each; each segment gets a DIFFERENT clip zone in
  // prepare so the gameplay visibly changes each beat. (PTS-offset fix keeps each cut smooth.)
  const bounds = (lines || []).map((l) => l.start).filter((t) => t > from + 1.6 && t < to - 1.2);
  const cuts = [from]; let last = from;
  for (const b of bounds) { if (b - last >= 2.6 && to - b >= 1.8) { cuts.push(+b.toFixed(2)); last = b; } }
  cuts.push(+to.toFixed(2));
  const windows = [];
  for (let i = 0; i < cuts.length - 1; i++) windows.push({ start: +cuts[i].toFixed(2), end: +cuts[i + 1].toFixed(2) });
  return windows.length ? windows : [{ start: +from.toFixed(2), end: +to.toFixed(2) }];
}

// ---------- b-roll gathering + normalization ----------
// Every library item becomes a playable clip (trailers as-is; screenshots -> Ken-Burns
// pan clips sized to the 1080x960 top panel) with a thumbnail + duration.
async function gatherBroll(dir, gameName, id) {
  const bdir = path.join(dir, 'broll'); const tdir = path.join(bdir, 'thumbs'); const cdir = path.join(bdir, 'clips');
  for (const d of [bdir, tdir, cdir]) fs.mkdirSync(d, { recursive: true });
  // staged demo assets may live under the full slug ("arknights-endfield") or the first
  // word ("arknights"); try both so a seeded game is found regardless of naming.
  const seedRoot = SEED_ROOT;
  const seedCandidates = [slug(gameName), slug(String(gameName).split(/[:\s]/)[0])];
  const seedDir = seedCandidates.map((s) => path.join(seedRoot, s)).find((d) => fs.existsSync(d)) || path.join(seedRoot, seedCandidates[0]);
  // 1) prefer already-staged demo assets for this game (Arknights); else run steam-extract.
  let trailers = [], shots = [], poster = null;
  if (fs.existsSync(seedDir)) {
    const gp = path.join(seedDir, 'gameplay');
    if (fs.existsSync(gp)) trailers = fs.readdirSync(gp).filter((f) => /\.mp4$/i.test(f)).map((f) => path.join(gp, f));
    const shotsDir = path.join(seedDir, 'broll', 'screenshots');
    if (fs.existsSync(shotsDir)) shots = fs.readdirSync(shotsDir).filter((f) => /\.jpe?g$/i.test(f)).map((f) => path.join(shotsDir, f));
    const postDir = path.join(seedDir, 'broll', 'posters');
    if (fs.existsSync(postDir)) { const hd = fs.readdirSync(postDir).find((f) => /logo/i.test(f)) || fs.readdirSync(postDir).find((f) => /header/i.test(f)) || fs.readdirSync(postDir)[0]; if (hd) poster = path.join(postDir, hd); }
  }
  if (!trailers.length && !shots.length) {
    try {
      setStatus(id, { stage: 'gather', msg: 'searching Steam for ' + gameName });
      await run('node', [STEAM_EXTRACT, gameName, bdir], { cwd: REPO });
      const g = path.join(bdir, 'gameplay'); if (fs.existsSync(g)) trailers = fs.readdirSync(g).filter((f) => /\.mp4$/i.test(f)).map((f) => path.join(g, f));
      const sd = path.join(bdir, 'screenshots'); if (fs.existsSync(sd)) shots = fs.readdirSync(sd).filter((f) => /\.jpe?g$/i.test(f)).map((f) => path.join(sd, f));
      const pd = path.join(bdir, 'posters'); if (fs.existsSync(pd)) { const hd = fs.readdirSync(pd).find((f) => /logo/i.test(f)) || fs.readdirSync(pd).find((f) => /header/i.test(f)) || fs.readdirSync(pd)[0]; if (hd) poster = path.join(pd, hd); }
    } catch (e) { setStatus(id, { stage: 'gather', msg: 'steam gather failed: ' + String(e.message || e).slice(0, 120) }); }
  }
  const library = [];
  // trailers -> copy in, thumbnail at 25%
  for (let i = 0; i < trailers.length; i++) {
    const src = trailers[i]; const name = `trailer-${i + 1}.mp4`; const dst = path.join(cdir, name);
    try { fs.copyFileSync(src, dst); } catch { continue; }
    const dur = ffprobeDur(dst); if (dur <= 0.5) { fs.rmSync(dst, { force: true }); continue; } // skip broken/empty
    const thumb = `t-trailer-${i + 1}.jpg`;
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(Math.max(1, dur * 0.25)), '-i', dst, '-frames:v', '1', '-vf', 'scale=320:-1', path.join(tdir, thumb)]).catch(() => {});
    library.push({ id: `clip-${library.length}`, name: `Trailer ${i + 1}`, kind: 'trailer', file: `clips/${name}`, thumb: `thumbs/${thumb}`, duration: +dur.toFixed(2) });
  }
  // NOTE: screenshots are deliberately NOT turned into b-roll anymore (Manish: real game
  // VIDEO only, never stills). The split uses trailers + YouTube gameplay + his uploads.
  // `shots` are still gathered above only for the poster/art; they never enter the library.
  return { library, poster };
}

// A user upload -> normalized clip + thumb, appended to library.json
export async function addUpload(id, srcPath, origName) {
  const dir = projDir(id); const cdir = path.join(dir, 'broll', 'clips'); const tdir = path.join(dir, 'broll', 'thumbs');
  for (const d of [cdir, tdir]) fs.mkdirSync(d, { recursive: true });
  const lib = rd(path.join(dir, 'library.json'), []);
  const n = lib.length; const name = `upload-${n}.mp4`; const dst = path.join(cdir, name);
  // re-encode to a uniform h264 so Pass B can trim/scale it reliably
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', srcPath, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', dst]);
  const dur = ffprobeDur(dst); const thumb = `t-upload-${n}.jpg`;
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(Math.min(1, dur / 3)), '-i', dst, '-frames:v', '1', '-vf', 'scale=320:-1', path.join(tdir, thumb)]).catch(() => {});
  const item = { id: `clip-${n}`, name: (origName || 'My gameplay').replace(/\.[^.]+$/, '').slice(0, 40), kind: 'upload', file: `clips/${name}`, thumb: `thumbs/${thumb}`, duration: +dur.toFixed(2) };
  lib.push(item); wr(path.join(dir, 'library.json'), lib);
  return item;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// The animated-poster overlay is shared by the preview AND the final composite so it
// always sits ON TOP of any b-roll split (matching the proven v2 layer order). Returns a
// filter snippet [inLabel] -> [outLabel]; caller must add `-loop 1 -t <posterOut+0.5> -i poster.png`
// as ffmpeg input `posterIdx`. Original art, no card, slide-down + fade, centered near top.
function posterFilter(inLabel, outLabel, posterIdx, posterIn, posterOut) {
  // Poster sits in the VERTICAL CENTER of the top 960px (the upper split), not the top edge.
  // y = center-of-top-half minus a small settle-in slide. overlay_h resolves the scaled height.
  return `[${posterIdx}:v]scale=560:-1,format=rgba,fade=t=in:st=${posterIn.toFixed(2)}:d=0.35:alpha=1,fade=t=out:st=${(posterOut - 0.35).toFixed(2)}:d=0.35:alpha=1[pos];` +
    `[${inLabel}][pos]overlay=x='(main_w-overlay_w)/2':y='(960-overlay_h)/2 - 30 + 30*min(1\\,max(0\\,(t-${posterIn.toFixed(2)})/0.4))':enable='between(t,${posterIn.toFixed(2)},${posterOut.toFixed(2)})'[${outLabel}];`;
}

// Mean luma (0-255) of a clip section, sampled sparsely. -1 on error.
function sectionLuma(file, start, len) {
  try {
    const o = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(start), '-t', String(len), '-i', file, '-vf', 'fps=2,scale=64:-1,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000 }).stdout || '';
    const v = [...o.matchAll(/YAVG=([\d.]+)/g)].map((m) => parseFloat(m[1]));
    return v.length ? Math.min(...v) : -1;
  } catch { return -1; }
}
// If any half-second sample of [clipIn, clipIn+len] is near-black (<32), step the start forward 0.5s at a
// time (then backward) until a clean span is found. Trailers fade to black / show black title cards.
function avoidDarkZone(file, clipIn, len, clipDur) {
  const ok = (t) => t >= 0 && t + len <= clipDur - 0.2 && sectionLuma(file, t, len) >= 32;
  if (ok(clipIn)) return clipIn;
  for (let d = 0.5; d <= 20; d += 0.5) { if (ok(clipIn + d)) return +(clipIn + d).toFixed(2); if (ok(clipIn - d)) return +(clipIn - d).toFixed(2); }
  return clipIn;
}

// ---------- Pass A: base edit (source + tint + audio only), NO poster, NO b-roll, NO captions.
// Poster + b-roll + captions are all overlaid in later passes so they layer correctly. ----------
async function renderBase(dir, meta, plan, words) {
  const src = path.join(dir, 'source.mp4');
  const dur = ffprobeDur(src);
  // name-drop time = start of the game-name span (poster slides in here)
  const nameDrop = plan.gameNameSpan ? (words[plan.gameNameSpan[0]]?.start || dur * 0.12) : dur * 0.12;
  const posterIn = Math.max(0.1, nameDrop - 0.05); const posterHold = 3.0; const posterOut = posterIn + posterHold; // Manish 2026-10-19: game logo stays a few seconds (was 1s)
  const tint = plan.tintBeat ? { a: words[plan.tintBeat[0]]?.start || 0, b: words[plan.tintBeat[1]]?.end || 0 } : null;
  const inputs = ['-i', src];
  let nIn = 1; // src is input 0; nIn = index of the NEXT input we push
  let vf = `[0:v]scale=1080:1920,setsar=1[bs];`;
  let last = 'bs';
  if (tint && tint.b > tint.a) {
    // BLACK-AND-WHITE dramatic beat (Manish's lock): desaturate to grayscale + slight darken.
    vf += `[${last}]eq=saturation=0:brightness=-0.06:contrast=1.06:enable='between(t,${tint.a.toFixed(2)},${tint.b.toFixed(2)})'[tv];`;
    last = 'tv';
  }
  vf += `[${last}]format=yuv420p[v]`;
  // audio: VO + dimmed music bed + riser into the name-drop + cash-register on the poster reveal
  const music = await pickMusicForScript(words, meta);
  const riser = path.join(SFX, 'Riser - 5.mp3');
  const cash = path.join(SFX, 'Cash Register 3.wav');
  // audio inputs are appended AFTER src (0) and the optional poster (1). Track the ffmpeg
  // input index (nIn) as we push, so slot.* always matches the actual -i order.
  const slot = {};
  if (music) { slot.mus = nIn++; inputs.push('-i', music); }
  if (fs.existsSync(riser)) { slot.ris = nIn++; inputs.push('-i', riser); }
  if (fs.existsSync(cash)) { slot.cash = nIn++; inputs.push('-i', cash); }
  const riserLead = 1.75; const risAt = Math.max(0, nameDrop - riserLead);
  let af = `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[vo];`;
  const mixIns = ['vo'];
  // Music STARTS AFTER THE RISER (~name-drop), not from t=0 (Manish): the hook builds on the
  // riser+VO, then the bed drops in at the reveal. adelay shifts it; fade-in at nameDrop.
  const musicLen = Math.max(1.5, dur - nameDrop);
  const mStart = music ? audibleMusicStart(music, musicLen, meta.id || meta.gameName || meta.game) : 0;
  if (music) { const dMs = Math.round(nameDrop * 1000); af += `[${slot.mus}:a]atrim=${mStart}:${(mStart + musicLen).toFixed(2)},asetpts=PTS-STARTPTS,adelay=${dMs}|${dMs},volume=0.16,afade=t=in:st=${nameDrop.toFixed(2)}:d=0.5,afade=t=out:st=${(dur - 0.8).toFixed(2)}:d=0.8[mus];`; mixIns.push('mus'); }
  if (fs.existsSync(riser)) { af += `[${slot.ris}:a]adelay=${Math.round(risAt * 1000)}|${Math.round(risAt * 1000)},volume=0.5[ris];`; mixIns.push('ris'); }
  if (fs.existsSync(cash)) { af += `[${slot.cash}:a]adelay=${Math.round(nameDrop * 1000)}|${Math.round(nameDrop * 1000)},volume=0.45[cash];`; mixIns.push('cash'); }
  af += `${mixIns.map((x) => `[${x}]`).join('')}amix=inputs=${mixIns.length}:normalize=0:duration=first[mix];[mix]alimiter=limit=0.97,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
  const out = path.join(dir, 'base_nocap.mp4');
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
    '-filter_complex', vf + ';' + af, '-map', '[v]', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', out]);
  return { out, nameDrop, posterIn, posterOut, dur };
}
// Rotate through the whole bg-music folder, deterministically per reel, so reels don't all
// share one track (Manish: "almost everyone has the same background music"). Add more files
// to sfx-pack/bg-music to widen the rotation.
function pickMusic(key) {
  const dir = path.join(SFX, 'bg-music');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(mp3|mp4|wav|m4a|aac|ogg)$/i.test(f)).sort(); } catch {}
  if (!files.length) return null;
  let h = 0; const s = String(key || 'x'); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return path.join(dir, files[h % files.length]);
}
// B4: pick a track whose VIBE fits the script (Manish: "music isn't suiting the script").
// Gemini reads the game + transcript + the track filenames and returns the best fit.
// Falls back to the hash rotation if Gemini fails.
async function pickMusicForScript(words, meta) {
  const dir = path.join(SFX, 'bg-music');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(mp3|mp4|wav|m4a|aac|ogg)$/i.test(f)); } catch {}
  if (!files.length) return null;
  // meta.music = exact filename in bg-music/ (Manish/Claude override, e.g. batch overrides.json)
  if (meta.music) { const hit = files.find((f) => f === meta.music || f.toLowerCase().startsWith(String(meta.music).toLowerCase())); if (hit) return path.join(dir, hit); }
  // music-moods.json = Gemini's description of each track from actually LISTENING (2026-10-21);
  // filenames alone made it pick the calm "blue" for a raw horror game.
  let moods = {}; try { moods = JSON.parse(fs.readFileSync(path.join(dir, 'music-moods.json'), 'utf8')); } catch {}
  const key = meta.id || meta.gameName || meta.game;
  const st = readSettings();
  const apiKey = st.geminiKey || process.env.GEMINI_API_KEY || (() => { try { const raw = fs.readFileSync(GEMINI_ENV, 'utf8'); const m = raw.match(/(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*["']?([^"'\s]+)/); return m ? m[1] : null; } catch { return null; } })();
  if (!apiKey) return pickMusic(key);
  const transcript = (words || []).map((w) => w.text).join(' ').slice(0, 500);
  const prompt = `Pick the ONE background-music track that best fits this short gaming reel's energy/vibe. Game: "${meta.gameName || meta.game}". Transcript (Hinglish): "${transcript}". Tracks with listened-to descriptions (match mood/darkness/energy to the game, NOT the filename): ${JSON.stringify(files.map((f) => ({ file: f, ...(moods[f] || {}) })))}. Consider tempo/mood: hype action → energetic/trap; calm/cozy game → mellow; epic → cinematic. Return ONLY JSON: {"file":"<exact filename from the list>"}.`;
  const models = [st.geminiModel, 'gemini-2.5-flash', 'gemini-flash-latest'].filter(Boolean);
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }) });
      if (r.status === 404) continue; if (!r.ok) break;
      const data = await r.json(); const parsed = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
      const pick = parsed.file && files.find((f) => f === parsed.file || f.toLowerCase() === String(parsed.file).toLowerCase());
      if (pick) return path.join(dir, pick);
    } catch { /* try next / fall through */ }
  }
  return pickMusic(key);
}

// ---------- caption alpha (self-call /api/exportAlpha at FULL res) ----------
async function renderCaptionAlpha(dir, project, plan) {
  // upload the FULL-RES source so exportAlpha renders 1080x1920 (render-dims fix)
  const src = fs.readFileSync(path.join(dir, 'source.mp4'));
  const up = await api('/api/upload', 'POST', src, { 'x-filename': 'rnffull.mp4', 'content-type': 'application/octet-stream' });
  const p = JSON.parse(JSON.stringify(project));
  p.__id = up.id; p.video = up.id; p.fileUrl = '/media/' + up.id; p.width = 1080; p.height = 1920;
  p.manualBreaks = true;
  const brk = new Set(plan.lineBreaks); const key = new Set(plan.keywords); const hide = new Set(plan.hideWords);
  p.words.forEach((w, i) => { w.br = brk.has(i); w.hi = key.has(i); if (hide.has(i)) w.on = false; });
  p.styleOverrides = {
    font: 'Luckiest Guy', case: 'upper', size: 78, weight: 400,
    primary: '#FFFFFF', accent: '#F2CE1F',
    highlightMode: 'none', animScope: 'line', entrance: 'pop', entranceMs: 200,
    outline: { width: 0 }, shadow: 0, effect: 'hard-shadow',
    box: { enabled: false }, position: { x: 50, y: 63 }, maxWidth: 90,
    segmentation: { mode: 'words', max: 3 },
  };
  p.segmentation = { mode: 'words', max: 3 };
  const ex = await api('/api/exportAlpha', 'POST', { project: p, cid: 'rnf-' + Date.now() });
  if (!ex || !ex.ok) throw new Error('caption alpha failed: ' + (ex && ex.error));
  // copy the rendered .mov out of the server OUT dir into the project dir
  const outRel = (ex.path || ex.fileUrl || '').replace('/out/', '');
  const srcMov = path.join(APP, 'web', 'work', 'out', outRel.replace(/[^a-zA-Z0-9._-]/g, ''));
  const dstMov = path.join(dir, 'captions.mov');
  if (fs.existsSync(srcMov)) fs.copyFileSync(srcMov, dstMov);
  else throw new Error('caption mov not found at ' + srcMov);
  return dstMov;
}

// measure the vertical center (in px) of the caption text so the seam-shift is exact
function measureCaptionCenter(mov) {
  try {
    // grab a frame with text, flatten alpha to white-on-black, find bright rows
    const tmp = path.join(path.dirname(mov), 'capprobe.png');
    // pick a frame ~ 40% through
    const dur = ffprobeDur(mov);
    spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(dur * 0.4), '-i', mov, '-frames:v', '1', tmp]);
    if (!fs.existsSync(tmp)) return 1199;
    const out = spawnSync(FFMPEG, ['-i', tmp, '-vf', 'format=gray,cropdetect=24:2:0', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
    const m = out.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    fs.rmSync(tmp, { force: true });
    if (m) { const h = +m[2], y = +m[4]; measureCaptionCenter.lastHeight = h; return Math.round(y + h / 2); }
  } catch { /* fall back */ }
  return 1199; // chest center for y=63 in a 1920 frame
}

// Manish 2026-10-21: the face half of the 50/50 split had too much gap between the top of the head
// and the split line (camera crop was a fixed y=440, so a head at ~660 landed ~190px below the seam).
// Detect the head-top (dark hair vs lighter wall) in the base edit and pick the crop so the head
// sits JUST BELOW the caption that straddles the seam.
const CAM_PANEL_H = 960, CAM_FALLBACK_Y = 440, CAM_HEAD_GAP = 24;
function detectHeadTop(video) {
  try {
    const W = 108, H = 192, dur = ffprobeDur(video);
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', video, '-vf', `fps=3,scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 256 * 1024 * 1024 });
    const buf = r.stdout; if (!buf || buf.length < W * H * 6) return null;
    const x0 = Math.round(W * 0.25), x1 = Math.round(W * 0.75), tops = [];
    for (let f = 0; f + W * H <= buf.length; f += W * H) {
      const lum = (y, x) => buf[f + y * W + x];
      // wall brightness = median of the top rows, central band
      const wall = []; for (let y = 2; y < 14; y++) for (let x = x0; x < x1; x++) wall.push(lum(y, x));
      wall.sort((a, b) => a - b); const wl = wall[wall.length >> 1];
      if (wl < 90) continue; // dark/blown-out wall: dark-hair-vs-wall scan is unreliable here
      const thr = wl - 55, need = Math.max(3, Math.round((x1 - x0) * 0.06));
      for (let y = 8; y < H * 0.6; y++) {
        let n = 0, n2 = 0;
        for (let x = x0; x < x1; x++) { if (lum(y, x) < thr) n++; if (lum(y + 1, x) < thr) n2++; }
        if (n >= need && n2 >= need) { tops.push(y * (1920 / H)); break; }
      }
    }
    if (tops.length < 5) return null;
    tops.sort((a, b) => a - b);
    return Math.round(tops[Math.floor(tops.length * 0.15)]); // near the highest head position so he never rises into the caption
  } catch { return null; }
}

// Head finder (Manish 2026-10-21, Mayhem a la Carte): the old dark-hair scan latched onto a dark background
// object at y=80 and the real head (~y=750) fell out of the face panel. head-scan.py finds the first strong
// HORIZONTAL edge (wall -> hair) in the central band per frame, verified on 5 different speakers/walls.
// Returns {top, chin} in 1920px units, or null (caller falls back to the old luminance scan).
function detectHeadScan(video) {
  try {
    const r = spawnSync('python3', [path.join(WEB, 'head-scan.py'), video], { encoding: 'utf8', timeout: 120000 });
    const j = JSON.parse((r.stdout || 'null').trim() || 'null');
    if (!j || j.top < 250 || j.top > 1200) return null; // implausible -> fall back
    return { top: j.top, chin: j.chin };
  } catch { return null; }
}

// returns the camera-crop y for the bottom (face) panel; persists it into plan.json
function ensureCamCrop(dir, plan, capHeight) {
  if (plan.camAuto) return plan.camCropY || CAM_FALLBACK_Y;
  const base = path.join(dir, 'base_nocap.mp4');
  const gem = fs.existsSync(base) ? detectHeadScan(base) : null;
  const headTop = gem ? gem.top : (fs.existsSync(base) ? detectHeadTop(base) : null);
  let camY = CAM_FALLBACK_Y;
  if (headTop != null) {
    const half = Math.min(120, Math.max(40, (capHeight || plan.capHeight || 140) / 2)) /* 2-line caption safe: head never under caption text */;
    camY = Math.max(0, Math.min(1920 - CAM_PANEL_H, Math.round(headTop - half - CAM_HEAD_GAP)));
    // face must never be cut: the chin (+70px air) has to land inside the 960px panel
    if (gem) camY = Math.max(camY, Math.min(1920 - CAM_PANEL_H, gem.chin + 70 - CAM_PANEL_H));
    plan.headChin = gem ? gem.chin : null; plan.headSrc = gem ? 'edge' : 'luma';
  }
  plan.camCropY = camY; plan.headTop = headTop; plan.camAuto = true;
  wr(path.join(dir, 'plan.json'), plan);
  return camY;
}

// ---------- PREPARE ----------
export async function prepare(id) {
  const dir = projDir(id); const meta = rd(path.join(dir, 'meta.json'));
  if (!meta) throw new Error('no meta for ' + id);
  const src = path.join(dir, 'source.mp4');
  if (!fs.existsSync(src)) throw new Error('no source.mp4');
  try {
    setStatus(id, { phase: 'prepare', stage: 'transcribe', pct: 5, msg: 'transcribing (hinglish-ai)', done: false, error: null });
    await pinGeminiKey();
    // upload a small proxy for a fast transcribe; timeline matches the full-res source
    const proxy = path.join(dir, 'proxy.mp4');
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', src, '-vf', 'scale=540:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', proxy]);
    const up = await api('/api/upload', 'POST', fs.readFileSync(proxy), { 'x-filename': 'rnfproxy.mp4', 'content-type': 'application/octet-stream' });
    const tr = await api('/api/transcribe', 'POST', { id: up.id, language: 'hinglish-ai', script: 'roman', cid: 'rnf-tx-' + id });
    if (!tr || !tr.ok) throw new Error('transcribe failed: ' + (tr && tr.error));
    const project = tr.project; const words = project.words || [];
    const dur = project.duration || ffprobeDur(src);

    setStatus(id, { stage: 'plan', pct: 25, msg: 'authoring captions + edit plan' });
    const plan = await geminiPlan(words, meta.gameName || meta.game, dur);
    // fix the mis-heard game name on the name-reveal line (hinglish-ai mangles proper nouns
    // e.g. "Arknights: Endfield" -> "Enfield Arknights"). Use the exact filename spelling.
    correctGameName(words, plan, meta.gameName || meta.game);
    // Manish 2026-10-19: tint ONLY on sarcastic lines. No keyword fallback (ensureTintBeat) any more;
    // a manual tint span can be passed via meta.tintBeat (word indices) when Claude judges a line sarcastic.
    // Overrides in meta.json (Claude's own sarcasm judgment beats the planner): noTint:true clears it,
    // tintTime:[startSec,endSec] sets it by time (robust to transcript index drift), tintBeat:[i,j] by word index.
    if (meta.noTint) plan.tintBeat = null;
    if (Array.isArray(meta.tintTime) && meta.tintTime.length === 2) {
      const [ta, tb] = meta.tintTime.map(Number);
      const ia = words.findIndex((w) => w.end > ta); let ib = -1; words.forEach((w, i) => { if (w.start < tb) ib = i; });
      if (ia >= 0 && ib >= ia) plan.tintBeat = [ia, ib];
    } else if (Array.isArray(meta.tintBeat) && meta.tintBeat.length === 2) plan.tintBeat = meta.tintBeat.map(Number);
    const lines = linesFromPlan(words, plan);
    const windows = suggestWindows(words, plan, dur, lines);

    setStatus(id, { stage: 'gather', pct: 35, msg: 'gathering b-roll for ' + (meta.gameName || meta.game) });
    const { library, poster } = await gatherBroll(dir, meta.gameName || meta.game, id);
    wr(path.join(dir, 'library.json'), library);
    if (poster) { const pdst = path.join(dir, 'poster.png'); try { fs.copyFileSync(poster, pdst); meta.poster = 'poster.png'; } catch {} }

    setStatus(id, { stage: 'captions', pct: 50, msg: 'rendering captions layer' });
    await renderCaptionAlpha(dir, project, plan);
    const capCenter = measureCaptionCenter(path.join(dir, 'captions.mov'));

    setStatus(id, { stage: 'base', pct: 70, msg: 'rendering base edit' });
    const base = await renderBase(dir, meta, plan, words);

    // preview = base + animated poster + captions@chest (accurate for the no-b-roll state)
    setStatus(id, { stage: 'preview', pct: 88, msg: 'building preview' });
    const preview = path.join(dir, 'preview.mp4');
    const posterFile = path.join(dir, 'poster.png');
    const pIn = ['-i', base.out, '-i', path.join(dir, 'captions.mov')];
    let pfg = '[0:v]null[b];';
    let plabel = 'b';
    if (fs.existsSync(posterFile)) { const pIdx = pIn.length / 2; pIn.push('-loop', '1', '-t', String(base.posterOut + 0.5), '-i', posterFile); pfg += posterFilter('b', 'bp', pIdx, base.posterIn, base.posterOut); plabel = 'bp'; }
    // downscale to ~480 wide + faststart so the browser plays the preview INLINE (Manish
    // couldn't play the full 1080x1920 preview and had to download it).
    pfg += `[${plabel}][1:v]overlay=0:0:format=auto,scale=480:-2[v]`;
    await run(FFMPEG, ['-y', '-loglevel', 'error', ...pIn,
      '-filter_complex', pfg, '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', preview]);

    // pre-fill each suggested window with a best-guess clip (first trailer, else first clip)
    const firstClip = library.find((c) => c.kind === 'trailer') || library[0];
    const firstClipPath = firstClip ? path.join(dir, 'broll', firstClip.file) : null;
    const clipDur = firstClipPath ? ffprobeDur(firstClipPath) : 0;
    const N = windows.length;
    const placements = windows.map((w, i) => {
      const winLen = +(w.end - w.start).toFixed(2);
      let clipIn = 0;
      if (firstClipPath) {
        // each segment shows a DIFFERENT zone of the clip so the b-roll cuts to a new moment
        const zoneLen = clipDur / Math.max(1, N);
        clipIn = (N > 1 && zoneLen > winLen + 1.5)
          ? bestClipIn(firstClipPath, winLen, +(i * zoneLen).toFixed(1), +((i + 1) * zoneLen).toFixed(1))
          : bestClipIn(firstClipPath, winLen);
        clipIn = avoidDarkZone(firstClipPath, clipIn, winLen, clipDur > 20 ? clipDur - 4.5 : clipDur); // also skip the last ~4.5s (trailer end cards with burned-in promo text) // never land on a fade-to-black / black title card
      }
      return { id: 'w' + i, start: w.start, end: w.end, clip: firstClip ? firstClip.id : null, clipIn };
    });

    const planOut = {
      duration: +dur.toFixed(2), gameName: meta.gameName || meta.game,
      nameDrop: base.nameDrop, posterIn: base.posterIn, posterOut: base.posterOut, capCenter,
      captionLines: lines.map(({ text, start, end }) => ({ text, start, end })),
      suggestedWindows: windows, placements,
      camCropY: CAM_FALLBACK_Y, capHeight: measureCaptionCenter.lastHeight || null, seamShift: 960 - capCenter,
      tintBeat: plan.tintBeat || null,
    };
    ensureCamCrop(dir, planOut, planOut.capHeight); // writes plan.json (camCropY from head-top)
    wr(path.join(dir, 'placements.json'), placements);
    setStatus(id, { stage: 'ready', pct: 100, msg: 'ready — pick your b-roll', done: true, error: null, ready: true });
  } catch (e) {
    setStatus(id, { stage: 'error', done: true, error: String(e.message || e).slice(0, 400) });
    throw e;
  }
}

// ---------- FINALIZE (Pass B: composite chosen b-roll splits + captions) ----------
export async function finalize(id, placementsOverride) {
  const dir = projDir(id); const meta = rd(path.join(dir, 'meta.json'));
  const plan = rd(path.join(dir, 'plan.json')); const lib = rd(path.join(dir, 'library.json'), []);
  const base = path.join(dir, 'base_nocap.mp4'); const capmov = path.join(dir, 'captions.mov');
  const placements = (placementsOverride && placementsOverride.length ? placementsOverride : rd(path.join(dir, 'placements.json'), []))
    .filter((p) => p.clip && p.end > p.start).sort((a, b) => a.start - b.start);
  wr(path.join(dir, 'placements.json'), placements);
  try {
    setStatus(id, { phase: 'render', stage: 'composite', pct: 10, msg: 'compositing b-roll splits', done: false, error: null, ready: false });
    const camY = ensureCamCrop(dir, plan); // older projects (camAuto unset) get re-framed here
    const N = placements.length;
    const inputs = ['-i', base, '-i', capmov];
    const clipInput = {}; // placement idx -> ffmpeg input index
    let nInput = 2; // base=0, capmov=1
    // -stream_loop -1 so a clip SHORTER than its window loops instead of freezing on the last frame.
    placements.forEach((pl, i) => { const c = lib.find((x) => x.id === pl.clip); if (c) { inputs.push('-stream_loop', '-1', '-i', path.join(dir, 'broll', c.file)); clipInput[i] = nInput++; } });
    // filtergraph
    let fg = `[0:v]scale=1080:1920,setsar=1,split=${N + 1}[full]${placements.map((_, i) => `[c${i}]`).join('')};`;
    placements.forEach((pl, i) => {
      const inp = clipInput[i]; if (inp == null) { fg += `[c${i}]null[o_skip${i}];`; return; }
      const win = (pl.end - pl.start).toFixed(2); const ci = (pl.clipIn || 0).toFixed(2); const st = pl.start.toFixed(2);
      fg += `[c${i}]crop=1080:960:0:${camY},setsar=1[cam${i}];`;
      // OFFSET the gameplay PTS to the window START (pl.start). Without this the clip plays
      // from reel t=0, runs out before the window ends, and the overlay repeats its last
      // frame = the b-roll "freezes" for the tail of the window. This was the freeze bug.
      fg += `[${inp}:v]trim=${ci}:${(+ci + +win).toFixed(2)},setpts=PTS-STARTPTS+${st}/TB,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[gp${i}];`;
      fg += `[gp${i}][cam${i}]vstack=inputs=2,setsar=1[sp${i}];`;
    });
    // chain overlays of each split over the full frame, time-gated
    let cur = 'full';
    placements.forEach((pl, i) => {
      if (clipInput[i] == null) return;
      const nxt = `ov${i}`;
      fg += `[${cur}][sp${i}]overlay=0:0:enable='between(t,${pl.start.toFixed(2)},${pl.end.toFixed(2)})'[${nxt}];`;
      cur = nxt;
    });
    // poster overlay ON TOP of the splits (so a split never covers the name reveal)
    const posterFile = path.join(dir, 'poster.png');
    if (fs.existsSync(posterFile) && plan.posterIn != null) {
      const posterIdx = nInput++; // input counter (clip inputs used -stream_loop, so length/2 is wrong)
      inputs.push('-loop', '1', '-t', String(plan.posterOut + 0.5), '-i', posterFile);
      fg += posterFilter(cur, 'wp', posterIdx, plan.posterIn, plan.posterOut);
      cur = 'wp';
    }
    // caption overlay with time-gated y-shift (seam during any split window, chest otherwise)
    const shift = Math.round(plan.seamShift || -239);
    const inAny = placements.filter((p) => clipInput[placements.indexOf(p)] != null)
      .map((p) => `between(t,${p.start.toFixed(2)},${p.end.toFixed(2)})`).join('+') || '0';
    // Captions must NEVER sit on the face (Manish 2026-10-21). Full-frame beats (hook + CTA): drop the caption
    // layer until its top clears the chin (chin from head-scan + 30px air; caption assumed up to 2 lines = 100px
    // half-height), capped so it stays above the IG bottom UI. CTA is additionally at least CTA_DROP lower.
    const CTA_DROP = 110;
    const chin = plan.headChin != null ? plan.headChin : (plan.headTop != null ? plan.headTop + 470 : null);
    const capC = plan.capCenter || 1199;
    let faceDrop = 0;
    if (chin != null) faceDrop = Math.max(0, Math.min(1430 - capC, Math.round(chin + 30 + 100 - capC)));
    const winEnds = placements.filter((p) => clipInput[placements.indexOf(p)] != null).map((p) => p.end);
    const ctaStart = winEnds.length ? Math.max(...winEnds) : (plan.duration || 0) * 0.78;
    const ctaDrop = Math.max(CTA_DROP, faceDrop);
    plan.faceDrop = faceDrop; plan.ctaDrop = ctaDrop; wr(path.join(dir, 'plan.json'), plan);
    fg += `[${cur}][1:v]overlay=x=0:y='if(${inAny},${shift},if(gte(t,${ctaStart.toFixed(2)}),${ctaDrop},${faceDrop}))':format=auto[v]`;
    const out = path.join(dir, 'final.mp4');
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
      '-filter_complex', fg, '-map', '[v]', '-map', '0:a',
      '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', out]);

    // QC gate (2026-09-29) - a reel that is not format-compliant must not reach
    // the client. 5 of 18 delivered reels had shipped with no b-roll at all,
    // while the batch log still read "delivered". Holds instead of pushing.
    const qc = writeVerdict(dir, checkReel(dir, { plan, meta, placements }));
    if (!qc.pass) {
      const heldUrl = '/rnf-media/' + id + '/final.mp4';
      // Retire any previous deliver.json so a stale Drive link cannot be
      // re-reported as success. Renamed, never deleted.
      try {
        const dp = path.join(dir, 'deliver.json');
        if (fs.existsSync(dp)) fs.renameSync(dp, path.join(dir, 'deliver.superseded-' + Date.now() + '.json'));
      } catch {}
      setStatus(id, {
        stage: 'qc-hold', pct: 95, done: true, ready: false,
        msg: 'HELD by QC: ' + qc.fails.join(', '),
        qc: qc.fails, finalUrl: heldUrl,
      });
      return { finalUrl: heldUrl, driveLink: null, qcHold: qc.fails };
    }

    if (DRIVE_DEST) setStatus(id, { stage: 'upload', pct: 80, msg: 'uploading to Drive' });
    const gname = (meta.gameName || meta.game).replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-');
    const driveName = `rnf-${gname}-${String(id).slice(-6)}.mp4`;
    let driveLink = null;
    if (DRIVE_DEST) try {
      await run('rclone', ['copyto', out, `${DRIVE_DEST}/${driveName}`]);
      const link = await run('rclone', ['link', `${DRIVE_DEST}/${driveName}`]);
      driveLink = link.trim();
    } catch (e) { setStatus(id, { msg: 'Drive upload failed: ' + String(e.message || e).slice(0, 120) }); }
    wr(path.join(dir, 'deliver.json'), { driveLink, driveName, at: Date.now() });
    setStatus(id, { stage: 'delivered', pct: 100, msg: 'done', done: true, ready: true, driveLink, finalUrl: `/rnf-media/${id}/final.mp4` });
    return { finalUrl: `/rnf-media/${id}/final.mp4`, driveLink };
  } catch (e) {
    setStatus(id, { stage: 'error', done: true, error: String(e.message || e).slice(0, 400) });
    throw e;
  }
}

// Overlay ONLY the 1s animated game poster onto an already-delivered final.mp4 — no
// transcribe / base / caption re-render (Manish: "just add the poster on top, don't
// render the full video"). Reuses posterFilter + plan.posterIn/out; re-pushes to Drive.
export async function addPosterToFinal(id) {
  const dir = projDir(id); const meta = rd(path.join(dir, 'meta.json')); const plan = rd(path.join(dir, 'plan.json'));
  const finalMp4 = path.join(dir, 'final.mp4'); const posterFile = path.join(dir, 'poster.png');
  if (!fs.existsSync(finalMp4)) throw new Error('no final.mp4 for ' + id);
  if (!fs.existsSync(posterFile)) throw new Error('no poster.png for ' + id);
  if (plan.posterIn == null) throw new Error('no posterIn in plan for ' + id);
  const tmp = path.join(dir, 'final_poster.mp4');
  const fg = posterFilter('0:v', 'v', 1, plan.posterIn, plan.posterOut) + '';
  // posterFilter emits "…[v];" — drop the trailing ';' for a single-chain filtergraph
  const fgClean = fg.replace(/;\s*$/, '');
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', finalMp4, '-loop', '1', '-t', String(plan.posterOut + 0.5), '-i', posterFile,
    '-filter_complex', fgClean, '-map', '[v]', '-map', '0:a',
    '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy', tmp]);
  fs.renameSync(tmp, finalMp4);
  const gname = (meta.gameName || meta.game).replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-');
  const driveName = `rnf-${gname}-${String(id).slice(-6)}.mp4`;
  // QC gate (2026-09-29) — the poster pass re-encodes final.mp4 and re-pushes to
  // the SAME Drive name, so without this it is a second, ungated route to the
  // client. Re-check the modified render before it goes anywhere.
  const qcp = writeVerdict(dir, checkReel(dir, { plan, meta }));
  if (!qcp.pass) {
    // Same as the finalize hold path: a stale Drive link must not survive a hold.
    try {
      const dp = path.join(dir, 'deliver.json');
      if (fs.existsSync(dp)) fs.renameSync(dp, path.join(dir, 'deliver.superseded-' + Date.now() + '.json'));
    } catch {}
    setStatus(id, {
      stage: 'qc-hold', done: true, ready: false,
      msg: 'HELD by QC (poster pass): ' + qcp.fails.join(', '), qc: qcp.fails,
    });
    return { driveLink: null, qcHold: qcp.fails };
  }
  let driveLink = null, uploadError = null;
  if (DRIVE_DEST) try {
    await run('rclone', ['copyto', finalMp4, `${DRIVE_DEST}/${driveName}`]);
    driveLink = (await run('rclone', ['link', `${DRIVE_DEST}/${driveName}`])).trim();
  } catch (e) {
    // Do NOT fall back to the previous link: that would report a failed upload
    // as success, pointing the client at the poster-less render.
    uploadError = String(e.message || e).slice(0, 160);
    setStatus(id, { msg: 'Drive upload failed (poster pass): ' + uploadError });
  }
  const deliver = rd(path.join(dir, 'deliver.json'), {});
  wr(path.join(dir, 'deliver.json'), { ...deliver, driveLink, posterAdded: !uploadError, uploadError });
  return { driveLink, uploadError };
}
