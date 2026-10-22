// rnf-yt-gameplay — pull REAL gameplay b-roll from YouTube for games (cookies now valid).
// For each game: search, then download a ~60s mid-video section of the first result that
// yields a usable clip, and stage it into the seed folder's gameplay/ (gatherBroll treats
// seed gameplay/*.mp4 as the primary b-roll clip). Then optionally clear those reels and
// re-run the render batch so they get real-gameplay splits + varied music.
//   node rnf-yt-gameplay.mjs "Game A" "Game B" ...        (gather only)
//   node rnf-yt-gameplay.mjs --rerender "Game A" ...       (gather + clear + relaunch batch)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SEED_ROOT, YTDLP, SECRETS, ARCHIVE } from './rnf-paths.mjs';

const WEB = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(WEB, 'work', 'rnf-batch-src');
const RNF = path.join(WEB, 'work', 'rnf');
const NODE = process.execPath;
// MULTI-COOKIE ROTATION: Manish drops cookies from several YouTube accounts as
// .secrets/yt-cookies.txt, yt-cookies-2.txt, … Rotating accounts across downloads spreads
// the load so no single account trips YouTube's per-session bot-check as fast.
function cookieFiles() {
  try { return fs.readdirSync(SECRETS).filter((f) => /^yt-cookies.*\.txt$/i.test(f)).sort().map((f) => path.join(SECRETS, f)); }
  catch { return [path.join(SECRETS, 'yt-cookies.txt')]; }
}
const COOKIE_LIST = cookieFiles();
let cookieIdx = 0;
const nextCookie = () => COOKIE_LIST[(cookieIdx++) % Math.max(1, COOKIE_LIST.length)] || path.join(SECRETS, 'yt-cookies.txt');
// slow-drip knobs: YouTube bot-checks this datacenter IP after a few rapid downloads, so a
// retry pass spaces games far apart (YT_DELAY_MS) and can wait out an initial cooldown (YT_START_DELAY_MS).
const DELAY_MS = parseInt(process.env.YT_DELAY_MS || '4000', 10);
const START_DELAY_MS = parseInt(process.env.YT_START_DELAY_MS || '0', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const log = (m) => process.stdout.write(`[yt] ${m}\n`);
const ffdur = (f) => { try { return parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim()) || 0; } catch { return 0; } };

// yt-dlp flags (WITHOUT the binary; run() takes the binary separately) for a real download
function ytFlags(cookie) {
  return ['--cookies', cookie, '--js-runtimes', `node:${NODE}`, '--remote-components', 'ejs:github', '--no-playlist'];
}
function run(cmd, args, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args); let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on('error', () => { clearTimeout(t); resolve({ code: 1, out, err }); });
  });
}

// search -> up to N video ids (flat, cheap)
async function searchIds(query, n = 4, cookie = nextCookie()) {
  const r = await run(YTDLP, ['--cookies', cookie, '--flat-playlist', '--print', '%(id)s', `ytsearch${n}:${query}`], 90000);
  return (r.out || '').split('\n').map((s) => s.trim()).filter((s) => /^[a-zA-Z0-9_-]{6,}$/.test(s));
}
// download a ~60s mid-video section; return path if valid (>25s), else null
async function grabSection(id, dest, cookie = nextCookie()) {
  const args = [...ytFlags(cookie),
    '-f', 'bv*[height<=1080][ext=mp4]+ba/b[height<=1080][ext=mp4]/b[height<=1080]',
    '--download-sections', '*0:12-1:12', '--force-keyframes-at-cuts',
    '-o', dest.replace(/\.mp4$/, '.%(ext)s'), `https://www.youtube.com/watch?v=${id}`];
  await run(YTDLP, args, 260000);
  // yt-dlp may output .mkv/.webm; find whatever landed
  const dir = path.dirname(dest); const stem = path.basename(dest).replace(/\.mp4$/, '');
  const got = fs.readdirSync(dir).find((f) => f.startsWith(stem));
  if (!got) return null;
  const full = path.join(dir, got);
  if (ffdur(full) < 25) { try { fs.rmSync(full); } catch {} return null; }
  return full;
}

async function gatherGame(game) {
  const sl = slug(game); const seedGp = path.join(SEED_ROOT, sl, 'gameplay');
  fs.mkdirSync(seedGp, { recursive: true });
  // idempotent: if a usable gameplay clip is already staged (prior run/test), reuse it
  try { const have = fs.readdirSync(seedGp).find((f) => /\.mp4$/i.test(f) && ffdur(path.join(seedGp, f)) > 20); if (have) { log(`  reuse existing seed for ${game} (${have})`); return { game, sl, id: 'cached', dur: ffdur(path.join(seedGp, have)) }; } } catch {}
  const tmp = path.join(SRC, '_yt', sl); fs.mkdirSync(tmp, { recursive: true });
  const q = `${game} gameplay no commentary`;
  log(`SEARCH ${game} (${COOKIE_LIST.length} cookie${COOKIE_LIST.length === 1 ? '' : 's'})`);
  const ids = await searchIds(q, 4);
  if (!ids.length) { log(`  no results for ${game}`); return null; }
  for (const id of ids) {
    const cookie = nextCookie(); // rotate account per download attempt
    log(`  try ${id} [${path.basename(cookie)}]`);
    const got = await grabSection(id, path.join(tmp, 'clip.mp4'), cookie);
    if (got) {
      // normalize to mp4 h264 into the seed as yt-1.mp4
      const dst = path.join(seedGp, 'yt-1.mp4');
      const r = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', got, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', dst], 180000);
      try { fs.rmSync(got); } catch {}
      if (r.code === 0 && ffdur(dst) > 20) { log(`  -> staged ${game} (${ffdur(dst).toFixed(0)}s) from ${id}`); return { game, sl, id, dur: ffdur(dst) }; }
    }
    await sleep(2500);
  }
  log(`  FAILED ${game} (no usable clip)`);
  return null;
}

(async () => {
  let args = process.argv.slice(2);
  const rerender = args.includes('--rerender'); args = args.filter((a) => a !== '--rerender');
  const games = args;
  if (!games.length) { log('no games given'); process.exit(1); }
  log(`gathering YouTube gameplay for ${games.length} games (rerender=${rerender}, delay=${DELAY_MS}ms, startDelay=${START_DELAY_MS}ms)`);
  if (START_DELAY_MS) { log(`waiting ${Math.round(START_DELAY_MS / 1000)}s for YouTube cooldown before starting…`); await sleep(START_DELAY_MS); }
  const ok = [];
  for (let i = 0; i < games.length; i++) {
    try { const r = await gatherGame(games[i]); if (r) ok.push(r); } catch (e) { log(`  ERR ${games[i]}: ${String(e.message || e).slice(0, 120)}`); }
    if (i < games.length - 1) await sleep(DELAY_MS);
  }
  log(`RECOVERED ${ok.length}/${games.length}: ${ok.map((r) => r.game).join(', ')}`);
  fs.writeFileSync(path.join(SRC, 'yt-coverage.json'), JSON.stringify(ok, null, 2));
  if (!rerender || !ok.length) { log('done (no rerender)'); return; }
  // clear the recovered reels so the batch reprocesses them with the new YT seed + varied music
  const progFile = path.join(SRC, 'batch-progress.json');
  let prog = {}; try { prog = JSON.parse(fs.readFileSync(progFile, 'utf8')); } catch {}
  const archive = path.join(ARCHIVE, 'rnf-pre-yt'); fs.mkdirSync(archive, { recursive: true });
  for (const r of ok) { const id = 'b-' + r.sl; const dir = path.join(RNF, id); try { if (fs.existsSync(dir)) fs.renameSync(dir, path.join(archive, id + '-' + process.pid)); } catch {} delete prog[id]; }
  delete prog.__summary;
  fs.writeFileSync(progFile, JSON.stringify(prog, null, 2));
  const logfd = fs.openSync(path.join(SRC, 'batch-run.log'), 'a');
  const child = spawn('setsid', ['node', path.join(WEB, 'rnf-batch.mjs'), SRC, '2'], { cwd: WEB, detached: true, stdio: ['ignore', logfd, logfd] });
  child.unref();
  log(`BATCH RELAUNCHED to re-render ${ok.length} reels with real gameplay + varied music`);
})();
