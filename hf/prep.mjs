// prep.mjs: clean-cut clip -> HyperFrames reel project with normalized media, head framing,
// raw transcript and a plan.json for the agent to complete.
//   node hf/prep.mjs "<clip.mp4>" [--game "Name"] [--out <reelsDir>] [--model large-v3|medium|small]
//                    [--transcript words.json] [--skip-transcribe]
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);
const clip = argv[0];
if (!clip || !fs.existsSync(clip)) { console.error('usage: node hf/prep.mjs "<clip.mp4>" [--game "Name"]'); process.exit(1); }

// Drive turns "Game: Sub" into "Game- Sub"; restore it
const game = opt('game') || path.basename(clip).replace(/\.[^.]+$/, '').replace(/-\s+/g, ': ').replace(/\s+/g, ' ').trim();
const sl = L.slug(game);
const proj = path.resolve(opt('out', path.join(L.REPO, 'reels')), sl);
const A = path.join(proj, 'assets');
for (const d of [A, path.join(A, 'fonts'), path.join(A, 'sfx')]) fs.mkdirSync(d, { recursive: true });
L.log(`[prep] ${game} -> ${proj}`);
const blockers = [];

// 1. source: 1080x1920, 30fps CFR, h264 + aac 48k (any input: 4K, iPhone rotation, VFR)
const src = path.join(A, 'source.mp4');
if (!L.hasAudio(clip)) throw new Error('clip has no audio track');
L.ff(['-i', clip, '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1',
  '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', src]);
const D = L.r2(L.dur(src));
L.log(`[prep] source normalized, ${D}s`);

// 2. font + sfx
if (fs.existsSync(L.FONT)) fs.copyFileSync(L.FONT, path.join(A, 'fonts', 'LuckiestGuy-Regular.ttf')); else blockers.push('font missing: ' + L.FONT);
for (const [from, to] of [['Riser - 5.mp3', 'riser.mp3'], ['Cash Register 3.wav', 'cash.wav']]) {
  const f = path.join(L.SFX, from); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(A, 'sfx', to)); else blockers.push('sfx missing: ' + f);
}

// 3. gameplay + logo from assets/game-assets/<slug>/ (full slug or first word)
const gdir = [sl, L.slug(game.split(/[:\s]/)[0])].map((s) => path.join(L.GAME_ASSETS, s)).find((d) => fs.existsSync(d));
const gameplay = [];
let logo = null;
if (gdir) {
  const gp = path.join(gdir, 'gameplay');
  const clips = fs.existsSync(gp) ? fs.readdirSync(gp).filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f)).sort() : [];
  clips.forEach((f, i) => {
    const out = path.join(A, `gameplay-${i + 1}.mp4`);
    // top panel is 1080x960: cover-crop once here so the composition plays a light h264 file
    L.ff(['-i', path.join(gp, f), '-an', '-vf', 'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,fps=30,setsar=1',
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', out]);
    const d = L.r2(L.dur(out)); if (d > 2) gameplay.push({ file: `assets/gameplay-${i + 1}.mp4`, from: f, duration: d }); else fs.renameSync(out, out + '.too-short');
  });
  const pd = path.join(gdir, 'broll', 'posters');
  const imgs = fs.existsSync(pd) ? fs.readdirSync(pd).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
  const pick = imgs.find((f) => /logo/i.test(f)) || imgs.find((f) => /header/i.test(f)) || imgs[0];
  if (pick) { const ext = path.extname(pick).toLowerCase(); fs.copyFileSync(path.join(pd, pick), path.join(A, 'logo' + ext)); logo = 'assets/logo' + ext; }
}
if (!gameplay.length) blockers.push(`no gameplay video in ${path.join(L.GAME_ASSETS, sl, 'gameplay')} (run hf/get-gameplay.mjs or add the human's clips)`);
if (!logo) blockers.push(`no logo/header image in ${path.join(L.GAME_ASSETS, sl, 'broll', 'posters')} (run footage/rnf-footage/steam-extract.js)`);

// 4. framing
const head = L.headScan(src);
const camCropY = L.camCrop(head);
L.log(`[prep] head ${head ? `top ${head.top} chin ${head.chin}` : 'not found (fallback crop)'} -> face crop y=${camCropY}`);
if (!head) blockers.push('head not detected; face crop uses fallback 440, check split frames and set plan.camCropY by hand');

// 5. transcript (word timings). Hindi/Hinglish: whisper with --language hi (Parakeet has no Hindi).
let words = [];
const tFile = opt('transcript');
if (tFile) {
  const t = L.rd(tFile); words = (Array.isArray(t) ? t : t?.words || []).map((w) => ({ text: String(w.text || w.word).trim(), start: +w.start, end: +w.end }));
} else if (!flag('skip-transcribe') && process.env.GROQ_API_KEY && opt('engine', 'groq') === 'groq') {
  // default: Groq-hosted whisper-large-v3 (free tier, fast, good on Hindi, nothing to install)
  L.log('[prep] transcribing with Groq whisper-large-v3 (hi)');
  const mp3 = path.join(proj, 'audio16k.mp3');
  L.ff(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'audio.mp3');
  fd.append('model', 'whisper-large-v3'); fd.append('language', 'hi');
  fd.append('response_format', 'verbose_json'); fd.append('timestamp_granularities[]', 'word');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY }, body: fd });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) blockers.push(`Groq transcription failed (HTTP ${res.status}): ${JSON.stringify(j.error || j).slice(0, 300)}`);
  words = (j.words || []).map((w) => ({ text: String(w.word).trim(), start: +w.start, end: +w.end })).filter((w) => w.text);
  fs.renameSync(mp3, mp3 + '.used');
} else if (!flag('skip-transcribe')) {
  const model = opt('model', 'large-v3');
  L.log(`[prep] transcribing with whisper ${model} (hi). First run downloads the model.`);
  const r = L.hyperframes(['transcribe', 'assets/source.mp4', '--engine', 'whisper', '--model', model, '--language', 'hi', '--json'], proj, { capture: true });
  const j = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
  const found = j && (j.words || j.transcript || (Array.isArray(j) ? j : null));
  if (Array.isArray(found)) words = found;
  else { const tj = path.join(proj, 'transcript.json'); if (fs.existsSync(tj)) { const t = L.rd(tj); words = Array.isArray(t) ? t : t.words || []; } }
  if (!words.length) blockers.push('transcription produced no words (' + (j?.reason || String(r.stderr || '').slice(-200)) + '). Set GROQ_API_KEY (free at console.groq.com) and re-run prep, or install whisper.cpp, or pass --transcript words.json');
  words = words.map((w) => ({ text: String(w.text).trim(), start: +w.start, end: +w.end })).filter((w) => w.text && !/^[♪�\W]$/.test(w.text));
}
if (words.length) L.wr(path.join(proj, 'transcript.raw.json'), words);
else if (fs.existsSync(path.join(proj, 'transcript.raw.json'))) words = L.rd(path.join(proj, 'transcript.raw.json'), []);

// 6. music candidates
const moods = L.rd(path.join(L.MUSIC_DIR, 'music-moods.json'), {});
const music = fs.existsSync(L.MUSIC_DIR) ? fs.readdirSync(L.MUSIC_DIR).filter((f) => /\.(mp3|wav|m4a|mp4|aac|ogg)$/i.test(f)).map((f) => ({ file: f, mood: moods[f] || null })) : [];
if (!music.length) blockers.push('no music in ' + L.MUSIC_DIR);

const plan = {
  _todo: [
    'words: rewrite every text as romanized Hinglish (English words in English), keep start/end. Fix misheard words; spell the game name exactly as "game".',
    'words: set br:true on the FIRST word of each caption line (2-4 words, by meaning; game name alone on its own line).',
    'words: set hi:true on ONE punch word per line (yellow). on:false hides stutters/repeats.',
    'nameSpan: [firstIndex, lastIndex] of the spoken game name.',
    'tint: [startSec, endSec] of the ONE sarcastic line, or null if none is sarcastic.',
    'music: filename (or unique prefix) from musicChoices, from the safe pool, matching the game mood. Never sad/emotional.',
    'windows: leave "auto" unless you need to override [{start,end,clip?,clipIn?}].',
    'Delete _todo when done, then run: node hf/build.mjs ' + proj,
  ],
  game, slug: sl, duration: D, head, camCropY, gameplay, logo,
  musicChoices: music, music: null, nameSpan: null, tint: null, windows: 'auto',
  words: words.map((w, i) => ({ i, text: w.text, start: L.r2(w.start), end: L.r2(w.end), br: false, hi: false })),
  blockers,
};
const planFile = path.join(proj, 'plan.json');
if (fs.existsSync(planFile)) { L.wr(path.join(proj, 'plan.prep.json'), plan); L.log('[prep] plan.json exists, kept it; fresh draft in plan.prep.json'); }
else L.wr(planFile, plan);
L.log(`[prep] ${words.length} words, ${gameplay.length} gameplay clip(s), logo ${logo || 'NONE'}, ${music.length} music track(s)`);
if (blockers.length) { L.log('[prep] BLOCKERS:\n  - ' + blockers.join('\n  - ')); process.exitCode = 2; }
L.log(`[prep] next: complete ${planFile} (see _todo), then node hf/build.mjs "${proj}"`);
