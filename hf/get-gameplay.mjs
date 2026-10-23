// get-gameplay.mjs: YouTube gameplay -> assets/game-assets/<slug>/gameplay/yt-<id>.mp4 (+ contact sheet).
// Works on Windows, macOS, Linux.
//   node hf/get-gameplay.mjs "Game Name" [--n 2] [--url <youtube url> ...] [--query "..."]
//        [--cookies <cookies.txt>] [--browser firefox|edge|chrome] [--any]
// Cookies are OPTIONAL. On a home connection YouTube usually works without them. Order tried:
//   --cookies / YT_COOKIES_FILE  ->  .secrets/yt-cookies*.txt (only files that exist)
//   ->  --browser / YT_BROWSER (yt-dlp --cookies-from-browser)  ->  no cookies.
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const game = argv[0];
if (!game || game.startsWith('--')) { console.error('usage: node hf/get-gameplay.mjs "Game Name" [--n 2] [--url URL] [--browser firefox]'); process.exit(1); }
const opt = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const all = (k) => argv.flatMap((a, i) => (a === '--' + k ? [argv[i + 1]] : []));
const N = parseInt(opt('n', '2'), 10);
const YTDLP = process.env.YTDLP || 'yt-dlp';
const sl = L.slug(game);
const outDir = path.join(L.GAME_ASSETS, sl, 'gameplay');
const tmp = path.join(L.GAME_ASSETS, sl, '_yt_tmp');
fs.mkdirSync(outDir, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });

// ---- cookies (never pass a path that doesn't exist: yt-dlp crashes on it) ----
const cookieFiles = [opt('cookies'), process.env.YT_COOKIES_FILE].filter((f) => f && fs.existsSync(f));
if (!cookieFiles.length && fs.existsSync(L.SECRETS)) cookieFiles.push(...fs.readdirSync(L.SECRETS).filter((f) => /^yt-cookies.*\.txt$/i.test(f)).sort().map((f) => path.join(L.SECRETS, f)));
const browser = opt('browser') || process.env.YT_BROWSER || null;
let ci = 0;
const cookieArgs = () => cookieFiles.length ? ['--cookies', cookieFiles[ci++ % cookieFiles.length]] : browser ? ['--cookies-from-browser', browser] : [];
const base = () => ['--no-playlist', '--js-runtimes', 'node', '--remote-components', 'ejs:github', ...cookieArgs(),
  ...(process.env.FFMPEG && fs.existsSync(process.env.FFMPEG) ? ['--ffmpeg-location', process.env.FFMPEG] : [])];
L.log(`[yt] ${game}: cookies = ${cookieFiles.length ? cookieFiles.length + ' file(s)' : browser ? 'from ' + browser : 'none'}`);

let botChecked = false;
function yt(args, timeout = 300000) {
  const r = L.sh(YTDLP, args, { timeout });
  const err = String(r.stderr || '');
  if (/confirm you.re not a bot|Sign in to confirm/i.test(err)) botChecked = true;
  if (botChecked) L.log('[yt] YouTube bot-check. Fix: run from a home connection, or add fresh cookies (export from a private window, close it right away) / --browser firefox');
  else if (/n challenge|nsig|page needs to be reloaded/i.test(err)) L.log('[yt] signature challenge failed: update yt-dlp (yt-dlp -U, or winget upgrade yt-dlp) and make sure node is on PATH');
  else if (/could not (copy|find).*cookie|decrypt|DPAPI/i.test(err)) L.log('[yt] could not read browser cookies (Chrome/Edge on Windows often block this). Close the browser, try --browser firefox, or use a cookies.txt');
  else if (/ffmpeg.*not (found|installed)/i.test(err)) L.log('[yt] ffmpeg not found: install it (winget install Gyan.FFmpeg) and reopen the terminal');
  return { ok: r.status === 0, out: String(r.stdout || ''), err };
}

// ---- candidates: search results whose TITLE names the game (stops wrong-game grabs) ----
const norm = (s) => String(s).toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'game', 'to', 'in']);
const tokens = norm(game).split(' ').filter((t) => t.length > 1 && !STOP.has(t));
const namesGame = (title) => { const t = ' ' + norm(title) + ' '; return t.includes(' ' + norm(game) + ' ') || tokens.every((k) => t.includes(' ' + k + ' ')); };
let cands = all('url').map((u) => ({ url: u, id: (u.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{6,})/) || [])[1] || 'url', title: '(given url)', dur: 0 }));
if (!cands.length) {
  // most specific first; new/indie games often only match a quoted name or "trailer"
  const queries = opt('query') ? [opt('query')] : [`${game} gameplay no commentary`, `"${game}" gameplay`, `"${game}" game`, `"${game}" trailer`];
  for (const q of queries) {
    L.log(`[yt] search: ${q}`);
    const s = yt([...base(), '--flat-playlist', '--print', '%(id)s\t%(duration)s\t%(channel)s\t%(title)s', `ytsearch10:${q}`], 90000);
    if (!s.ok && !s.out) { L.log('[yt] search failed:\n' + s.err.split('\n').filter((l) => /ERROR|WARNING/.test(l)).slice(-5).join('\n')); process.exit(2); }
    const rows = s.out.split('\n').filter(Boolean).map((l) => { const [id, d, ch, ...t] = l.split('\t'); return { id, dur: parseFloat(d) || 0, channel: ch, title: t.join('\t'), url: `https://www.youtube.com/watch?v=${id}` }; });
    rows.forEach((r) => L.log(`  ${namesGame(r.title) ? 'OK ' : '-- '} ${r.id}  ${Math.round(r.dur)}s  ${r.title}  [${r.channel}]`));
    cands = rows.filter((r) => r.dur >= 30 && r.dur <= 4 * 3600 && (argv.includes('--any') || namesGame(r.title)));
    if (cands.length) break;
  }
  if (!cands.length) { L.log(`[yt] no result whose title names "${game}". Check the spelling, pass --query, --url, or --any (then verify the sheet!)`); process.exit(2); }
}

// ---- download a ~60s mid section of each, normalize, contact sheet ----
let got = 0;
for (const c of cands) {
  if (got >= N) break;
  const st = c.dur ? Math.min(12, Math.floor(c.dur * 0.1)) : 12;
  const en = c.dur ? Math.min(st + 60, Math.floor(c.dur - 3)) : st + 60;
  L.log(`[yt] downloading ${c.id} ${st}-${en}s  ${c.title}`);
  for (const f of fs.readdirSync(tmp)) if (f.startsWith(c.id)) fs.renameSync(path.join(tmp, f), path.join(tmp, f + '.old-' + Date.now()));
  const d = yt([...base(), '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b',
    '--download-sections', `*${st}-${en}`, '--force-keyframes-at-cuts', '--merge-output-format', 'mp4',
    '-o', path.join(tmp, '%(id)s.%(ext)s'), c.url], 600000);
  const file = fs.readdirSync(tmp).find((f) => f.startsWith(c.id + '.') && !/\.(part|ytdl|old-\d+)$/.test(f));
  if (!d.ok && botChecked) { L.log('[yt] stopping: every download will hit the same bot-check until cookies/network change'); break; }
  if (!d.ok || !file) { L.log('[yt]   failed: ' + d.err.split('\n').filter((l) => /ERROR/.test(l)).slice(-2).join(' | ')); continue; }
  const dst = path.join(outDir, `yt-${c.id}.mp4`);
  L.ff(['-i', path.join(tmp, file), '-an', '-vf', 'scale=-2:1080,fps=30', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', dst]);
  const len = L.dur(dst);
  if (len < 20) { fs.renameSync(dst, dst + '.too-short'); L.log(`[yt]   too short (${len.toFixed(0)}s), skipped`); continue; }
  const sheet = dst.replace(/\.mp4$/, '.sheet.jpg');
  L.ff(['-i', dst, '-vf', `fps=${(8 / len).toFixed(4)},scale=480:-1,tile=4x2`, '-frames:v', '1', sheet]);
  fs.renameSync(path.join(tmp, file), path.join(tmp, file + '.used'));
  got++; L.log(`[yt]   -> ${dst} (${len.toFixed(0)}s). LOOK at ${sheet}: right game, real gameplay, no facecam/end card?`);
}
L.log(`[yt] ${got}/${N} clip(s) staged in ${outDir}`);
process.exitCode = got ? 0 : 2;
