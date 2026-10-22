#!/usr/bin/env node
/**
 * index-broll.js — rnf (rest.not.found) GAMEPLAY b-roll indexer.
 *
 * Walks a gathered per-game folder (the `gameplay/` + `trailers/` subdirs) and for every
 * clip builds a searchable, gaming-aware content index so a script beat can be matched to
 * "which part of which gameplay clip" by the auto-editor (Phase 2).
 *
 * Per VIDEO:  ffprobe (dur/res/fps) -> 5 evenly-spaced keyframes (downscaled) -> Gemini
 *             vision (gaming taxonomy) -> tags. Files are LOCAL (already gathered), so no
 *             rclone copy per file — ffmpeg/ffprobe run directly on disk.
 *
 * Writes <game-folder>/broll-index.json (resumable, crash-safe incremental writes) so the
 * index ships to Drive alongside the assets.
 *
 *   bash .claude/bin/with-gemini.sh node index-broll.js <game-folder> [--game "Name"] [--limit N] [--only <substr>] [--concurrency N]
 *   # active-person gotcha: if the box-global active person isn't you, pin your key:
 *   #   set -a; . .secrets/gemini-<you>.env; set +a; node index-broll.js <game-folder> ...
 *
 * Vision: Google Generative Language API with the ACTIVE person's OWN Gemini key (free tier).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
// Same model rationale as abhifit-footage: the NON-lite flash models burn their free quota (429)
// and 2.5-flash/flash-latest 503 under load; the LITE models have a separate higher free bucket.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const MIN_INTERVAL = parseInt(process.env.GEMINI_MIN_INTERVAL_MS || '4200', 10);
let _nextSlot = 0;

if (!GEMINI_KEY) { console.error('FATAL: GEMINI_API_KEY not in env. Run via .claude/bin/with-gemini.sh (or pin .secrets/gemini-<you>.env)'); process.exit(3); }

// ---- args ----
const args = process.argv.slice(2);
let GAME_DIR = null, LIMIT = Infinity, ONLY = null, POOL = 3, GAME_NAME = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit') LIMIT = parseInt(args[++i], 10);
  else if (args[i] === '--only') ONLY = args[++i];
  else if (args[i] === '--concurrency') POOL = parseInt(args[++i], 10);
  else if (args[i] === '--game') GAME_NAME = args[++i];
  else if (!args[i].startsWith('--')) GAME_DIR = path.resolve(args[i]);
}
if (!GAME_DIR || !fs.existsSync(GAME_DIR)) { console.error('Usage: index-broll.js <game-folder> [--game "Name"] [--limit N] [--only substr] [--concurrency N]'); process.exit(1); }

const INDEX = path.join(GAME_DIR, 'broll-index.json');
const TMP = path.join(GAME_DIR, '.index-tmp');
fs.mkdirSync(TMP, { recursive: true });

// derive the game name: --game flag > manifest.json title > folder basename
if (!GAME_NAME) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(GAME_DIR, 'manifest.json'), 'utf8'));
    const steam = (m.items || []).find((it) => it.type === 'steam' && it.meta && it.meta.name);
    GAME_NAME = (steam && steam.meta.name) || m.title || path.basename(GAME_DIR);
  } catch { GAME_NAME = path.basename(GAME_DIR).replace(/^rnf-game-/, ''); }
}

const VIDEO_RE = /\.(mov|mp4|m4v|avi|webm|mkv)$/i;
const SCAN_SUBDIRS = ['gameplay', 'trailers'];

function loadJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function sh(cmd, a, opts = {}) { return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }

// ---- rnf gaming context baked into the vision prompt ----
const SCENE_TYPES = `gameplay | cutscene | cinematic-trailer | menu-ui | loading | dialogue | mixed`;
const ACTIVITIES = `combat | boss-fight | exploration | traversal/climb | driving/racing | building/crafting | puzzle | stealth | dialogue/story | scenery/vista | menu/inventory | multiplayer`;
const BEATS = `hook-visual (strong grabby opener) | gameplay-demo (shows how it plays) | feature-highlight (a specific mechanic/feature) | vibe/atmosphere (mood, world, music-bed b-roll) | comparison (vs another game/version) | funny-moment | verdict/outro`;

function visionPrompt(meta) {
  return `You are indexing raw GAMEPLAY footage for rest.not.found (rnf) — an Indian budget-gamer discovery page (Hinglish, understated honest reactions; single-player-leaning: free/cheap game picks, potato-PC lists, story games). Clips get layered as b-roll under a talking-head review, so I need to know what each moment SHOWS. I show you evenly-spaced keyframes from ONE video clip.

Game: ${GAME_NAME}
File: ${meta.file}
Folder: ${meta.folder}
Duration: ${meta.duration_s}s | ${meta.width}x${meta.height} (${meta.orientation}) | ${meta.fps}fps

Scene types: ${SCENE_TYPES}
In-game activities: ${ACTIVITIES}
Script beats this can fill: ${BEATS}

Return ONLY a JSON object (no markdown):
{
  "subject": "what this clip shows, one line (e.g. 'first-person gunfight in a neon alley', 'wide vista of a snowy mountain to climb', 'inventory/skill menu')",
  "scene_type": "one of the scene types above",
  "activity": "the dominant activity from the list above",
  "camera": "first-person | third-person | top-down | isometric | cinematic | unknown",
  "intensity": "calm | moderate | intense (energy of the moment — match to VO beat)",
  "setting_env": "in-game environment in a few words (e.g. 'neon city night', 'green forest', 'space station', 'desert ruins')",
  "has_hud": true/false (is a game HUD / UI overlay visible — matters for clean vs busy b-roll),
  "mood": "one line (e.g. 'tense', 'chill/cozy', 'epic', 'goofy')",
  "on_screen_text": "any burned-in text/subtitles/damage numbers, else 'none'",
  "quality": "cinematic | clean-capture | compressed | low-res (judge sharpness/compression/framing)",
  "beats": [beat labels from the list this can fill],
  "best_ranges": ["short human ranges worth using, e.g. '0-4s slow pan', '8-12s kill'; [] if the whole clip is one usable shot"],
  "tags": ["5-10 lowercase search keywords: game name, genre, setting, action, mood"],
  "notes": "caveats an editor needs: shaky, dark, watermark/facecam, letterboxed, has commentary audio (guess), unusable parts, etc."
}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rateGate() {
  const now = Date.now();
  const start = Math.max(now, _nextSlot);
  _nextSlot = start + MIN_INTERVAL;
  const wait = start - now;
  if (wait > 0) await sleep(wait);
}
async function callGemini(imagePaths, prompt) {
  const backoffs = [0, 8000, 20000, 45000];
  let last = { _error: 'no_attempt' };
  for (const wait of backoffs) {
    if (wait) await sleep(wait);
    await rateGate();
    last = await callGeminiOnce(imagePaths, prompt);
    const e = last._error || '';
    if (!/429|resource|quota|rate|timeout|^5\d\d|overload/i.test(e)) return last;
  }
  return last;
}
function callGeminiOnce(imagePaths, prompt) {
  const parts = imagePaths.filter((p) => fs.existsSync(p)).map((p) => ({
    inline_data: { mime_type: 'image/jpeg', data: fs.readFileSync(p).toString('base64') },
  }));
  parts.push({ text: prompt });
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { maxOutputTokens: 1200, responseMimeType: 'application/json' },
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''; res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return resolve({ _error: `${res.statusCode}:${parsed.error.message}`.slice(0, 200) });
          const txt = (parsed.candidates?.[0]?.content?.parts?.[0]?.text || '{}').replace(/```json\n?/g, '').replace(/```/g, '').trim();
          resolve(JSON.parse(txt));
        } catch { resolve({ _parse_error: data.slice(0, 300) }); }
      });
    });
    req.on('error', (e) => resolve({ _error: e.message }));
    req.setTimeout(120000, () => { req.destroy(); resolve({ _error: 'timeout' }); });
    req.write(body); req.end();
  });
}

function orient(w, h) { if (!w || !h) return 'unknown'; if (w > h * 1.15) return 'horizontal'; if (h > w * 1.15) return 'vertical'; return 'square'; }

function walkVideos() {
  const out = [];
  for (const sub of SCAN_SUBDIRS) {
    const d = path.join(GAME_DIR, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (VIDEO_RE.test(f)) out.push({ abs: path.join(d, f), file: f, folder: sub });
    }
  }
  return out;
}

async function processVideo(item, tmpBase) {
  const local = item.abs;
  let dur = 0, w = 0, h = 0, fps = 0;
  try {
    const out = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate:format=duration', '-of', 'json', local]);
    const j = JSON.parse(out); const s = j.streams?.[0] || {};
    w = s.width || 0; h = s.height || 0; dur = parseFloat(j.format?.duration || 0);
    const [n, d] = (s.avg_frame_rate || '0/1').split('/'); fps = d ? Math.round((+n / +d) * 10) / 10 : 0;
  } catch { }
  const frames = [];
  const pts = [0.1, 0.3, 0.5, 0.7, 0.9];
  for (let i = 0; i < pts.length; i++) {
    const t = Math.max(0.1, (dur || 1) * pts[i]);
    const fp = path.join(TMP, `${tmpBase}-f${i}.jpg`);
    try { sh('ffmpeg', ['-y', '-ss', String(t), '-i', local, '-frames:v', '1', '-vf', 'scale=640:-2', fp], { stdio: 'ignore' }); if (fs.existsSync(fp)) frames.push(fp); } catch { }
  }
  const size_mb = Math.round((fs.statSync(local).size / 1e5)) / 10;
  const meta = { file: item.file, folder: item.folder, duration_s: Math.round(dur * 10) / 10, width: w, height: h, orientation: orient(w, h), fps };
  const tags = await callGemini(frames, visionPrompt(meta));
  frames.forEach((f) => { try { fs.unlinkSync(f); } catch { } });
  return { game: GAME_NAME, ...meta, type: 'video', size_mb, ...tags };
}

async function main() {
  let index = loadJson(INDEX, []);
  const before = index.length;
  index = index.filter((r) => !r._error && !r._parse_error);
  if (index.length !== before) { fs.writeFileSync(INDEX, JSON.stringify(index, null, 2)); console.log(`Requeued ${before - index.length} previously-failed files`); }
  const done = new Set(index.map((r) => r.file + '|' + r.folder));

  let queue = walkVideos().filter((v) => !done.has(v.file + '|' + v.folder));
  if (ONLY) queue = queue.filter((v) => v.file.toLowerCase().includes(ONLY.toLowerCase()));
  queue = queue.slice(0, LIMIT);
  console.log(`Game "${GAME_NAME}" | videos ${walkVideos().length} | already indexed ${index.length} | to do ${queue.length} | concurrency ${POOL}`);

  let cursor = 0, finished = 0;
  const total = queue.length;
  function save() { fs.writeFileSync(INDEX, JSON.stringify(index, null, 2)); }

  async function worker(wid) {
    while (cursor < total) {
      const myIdx = cursor++;
      const item = queue[myIdx];
      const tmpBase = `w${wid}_${myIdx}`;
      const t0 = Date.now();
      try {
        const rec = await processVideo(item, tmpBase);
        index.push(rec); save();
        const s = rec.subject || rec._error || rec._parse_error || '?';
        console.log(`[${++finished}/${total}] ${item.folder}/${item.file}  (${((Date.now() - t0) / 1000).toFixed(1)}s)  -> ${String(s).slice(0, 70)}`);
      } catch (e) {
        index.push({ game: GAME_NAME, file: item.file, folder: item.folder, type: 'video', _error: e.message }); save();
        console.log(`[${++finished}/${total}] FAIL ${item.folder}/${item.file} — ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, total || 1) }, (_, i) => worker(i)));
  try { fs.rmdirSync(TMP); } catch { }
  console.log(`DONE. Index has ${index.length} records at ${INDEX}`);
}
main();
