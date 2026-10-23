// Shared helpers for the HyperFrames RNF pipeline. Pure Node + ffmpeg/ffprobe, no Python,
// no shell, so it runs the same on Windows, macOS and Linux.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HF = path.dirname(fileURLToPath(import.meta.url));
export const REPO = process.env.RNF_HOME || path.resolve(HF, '..');
// load <repo>/.env (KEY=VALUE lines) without overriding real env vars; values are never printed
try {
  for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (!m || process.env[m[1]]) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2'); if (v) process.env[m[1]] = v;
  }
} catch {}
export const SFX = process.env.RNF_SFX_DIR || path.join(REPO, 'assets', 'sfx-pack');
export const MUSIC_DIR = path.join(SFX, 'bg-music');
export const GAME_ASSETS = process.env.RNF_ASSETS_DIR || path.join(REPO, 'assets', 'game-assets');
export const SECRETS = process.env.RNF_SECRETS_DIR || path.join(REPO, '.secrets');
export const FONT = path.join(REPO, 'app', 'fonts', 'LuckiestGuy-Regular.ttf');
export const FFMPEG = process.env.FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE || 'ffprobe';
export const IS_WIN = process.platform === 'win32';

export const W = 1080, H = 1920, PANEL = 960;   // canvas + split panel height
export const CHEST_Y = 1199;                    // caption centre on full-frame beats
export const SEAM_Y = 960;                      // caption centre during split windows
export const CTA_DROP = 110;                    // locked 2026-10-21
export const CAM_FALLBACK_Y = 440, CAM_HEAD_GAP = 24, CAP_HALF = 70;
export const LOGO_HOLD = 3.0, RISER_LEAD = 1.75;
export const MUSIC_VOL = 0.16, RISER_VOL = 0.5, CASH_VOL = 0.45;

export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const rd = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export const wr = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
export const r2 = (n) => Math.round(n * 100) / 100;
export const log = (m) => process.stdout.write(m + '\n');

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: opts.binary ? null : 'utf8', maxBuffer: 1024 * 1024 * 1024, windowsHide: true, ...opts });
  if (r.error) throw new Error(`${cmd} not runnable: ${r.error.code || r.error.message}. Is it installed and on PATH?`);
  return r;
}
export function ff(args) {
  const r = sh(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', ...args]);
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + String(r.stderr).slice(-1500));
}
export const dur = (f) => parseFloat(sh(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout) || 0;
export function dims(f) {
  const [w, h] = String(sh(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', f]).stdout).trim().split('x').map(Number);
  return { w, h };
}
export const hasAudio = (f) => String(sh(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', f]).stdout).trim().length > 0;

// gray frames as Uint8 planes: [{t, px}] at fps, scaled to w x h
export function grayFrames(file, { fps = 3, w = 216, h = 384, ss = null, t = null } = {}) {
  const a = [];
  if (ss != null) a.push('-ss', String(ss));
  a.push('-i', file);
  if (t != null) a.push('-t', String(t));
  a.push('-vf', `fps=${fps},scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-');
  const r = sh(FFMPEG, ['-nostdin', '-v', 'error', ...a], { binary: true });
  const buf = r.stdout || Buffer.alloc(0); const n = Math.floor(buf.length / (w * h)); const out = [];
  for (let i = 0; i < n; i++) out.push(buf.subarray(i * w * h, (i + 1) * w * h));
  return out;
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * p / 100; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };

// Head top + chin (1920 units). Port of head-scan.py: first strong HORIZONTAL edge (wall -> hair)
// in the central band, per frame, 20th percentile across frames. null if unreliable.
export function headScan(video) {
  const w = 216, h = 384, x0 = Math.floor(w * 0.30), x1 = Math.floor(w * 0.70);
  const need = Math.max(6, Math.floor((x1 - x0) * 0.22));
  const tops = [];
  for (const g of grayFrames(video, { fps: 3, w, h })) {
    const ok = new Array(h).fill(false);
    for (let r = 0; r < h - 3; r++) { let n = 0; for (let x = x0; x < x1; x++) if (Math.abs(g[(r + 3) * w + x] - g[r * w + x]) > 28) n++; ok[r] = n >= need; }
    for (let r = Math.floor(h * 0.10); r < Math.floor(h * 0.70); r++) if (ok[r] && ok[r + 1]) { tops.push(r + 3); break; }
  }
  if (tops.length < 5) return null;
  const top = Math.round(pct(tops.map((t) => t * (H / h)), 20));
  if (top < 250 || top > 1200) return null;
  return { top, chin: top + 470, frames: tops.length };
}

// face-panel crop: head top sits just under the caption on the seam, chin stays inside the panel
export function camCrop(head) {
  if (!head) return CAM_FALLBACK_Y;
  let y = Math.round(head.top - CAP_HALF - CAM_HEAD_GAP);
  y = Math.max(y, head.chin + 70 - PANEL);
  return Math.max(0, Math.min(H - PANEL, y));
}

// mean frame-to-frame motion of [ss, ss+len] (64x36 gray). Used for QC and clip choice.
export function motionSeries(file, ss, len, fps = 5) {
  const f = grayFrames(file, { fps, w: 64, h: 36, ss, t: len });
  const d = [];
  for (let i = 1; i < f.length; i++) { let s = 0; for (let k = 0; k < f[i].length; k++) s += Math.abs(f[i][k] - f[i - 1][k]); d.push(s / f[i].length); }
  return d;
}
export function meanLuma(file, ss, len) {
  const f = grayFrames(file, { fps: 2, w: 64, h: 36, ss, t: len });
  if (!f.length) return 0;
  return Math.min(...f.map((p) => p.reduce((a, b) => a + b, 0) / p.length));
}

// best start for a continuously moving, not-dark window of `len` inside [zs, ze] of a clip.
// Skips the last 4.5s of long clips (trailer end cards with burned-in promo text).
export function bestClipIn(file, len, zs = 0, ze = null) {
  const total = dur(file); const usableEnd = total > 20 ? total - 4.5 : total;
  ze = Math.min(ze ?? usableEnd, usableEnd);
  if (ze - zs < len) { zs = Math.max(0, usableEnd - len); ze = usableEnd; }
  const fps = 5, series = motionSeries(file, zs, ze - zs, fps), win = Math.max(1, Math.round(len * fps));
  let best = zs, bestScore = -1;
  for (let i = 0; i + win <= series.length; i += fps / 2) {
    const s = series.slice(i, i + win); const score = Math.min(...s) * 0.6 + (s.reduce((a, b) => a + b, 0) / s.length) * 0.4;
    if (score > bestScore) { bestScore = score; best = zs + i / fps; }
  }
  // step off near-black spans (fades / black title cards)
  for (let d = 0; d <= 20; d += 0.5) for (const c of [best + d, best - d]) {
    if (c >= 0 && c + len <= usableEnd && meanLuma(file, c, len) >= 32) return r2(c);
  }
  return r2(best);
}

// non-silent music offset (long mixes have silent gaps)
export function audibleStart(file, need, key = 'x') {
  const total = dur(file); if (total <= need + 1) return 0;
  let h = 0; for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const range = Math.max(1, Math.floor(total - need - 5));
  for (const c of [10 + (h % range), 30, Math.floor(total * 0.3), Math.floor(total * 0.55), 0]) {
    const st = Math.max(0, Math.min(c, total - need - 1));
    const e = String(sh(FFMPEG, ['-nostdin', '-ss', String(st), '-t', String(Math.min(need, 8)), '-i', file, '-af', 'volumedetect', '-f', 'null', '-']).stderr || '');
    const m = e.match(/mean_volume:\s*(-?[0-9.]+) dB/); if (m && parseFloat(m[1]) > -40) return r2(st);
  }
  return 0;
}

// caption lines from words with br flags (w.br = first word of a line; w.on=false hides it)
export function linesFrom(words) {
  const lines = []; let cur = null;
  words.forEach((w, i) => {
    if (w.br || !cur) { cur = { start: w.start, end: w.end, words: [] }; lines.push(cur); }
    cur.end = Math.max(cur.end, w.end);
    if (w.on !== false) cur.words.push({ text: w.text, hi: !!w.hi, i });
  });
  return lines.filter((l) => l.words.length).map((l) => ({ ...l, start: r2(l.start), end: r2(l.end) }));
}

// split windows: early-split rule, CTA = last ~22%, cut at caption-line boundaries 2.6-4s apart
export function suggestWindows(lines, nameStart, nameEnd, duration) {
  const ctaStart = Math.max(nameEnd + 3, duration * 0.78);
  let from = Math.max(Math.min(nameStart, nameEnd) - 0.05, 1.5);
  if (from > 3.6) { const early = lines.map((l) => l.start).find((t) => t >= 2.3 && t <= 3.6); from = early ?? 2.6; }
  const to = Math.max(from + 2, ctaStart);
  const cuts = [from]; let last = from;
  for (const b of lines.map((l) => l.start).filter((t) => t > from + 1.6 && t < to - 1.2)) {
    if (b - last >= 2.6 && to - b >= 1.8) { cuts.push(b); last = b; }
  }
  cuts.push(to);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) out.push({ start: r2(cuts[i]), end: r2(cuts[i + 1]) });
  return out;
}

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Run the HyperFrames CLI. On Windows npx is a .cmd file, which Node only spawns through a shell,
// so quote every argument ourselves. Output streams live to this console.
export function hyperframes(args, cwd, { capture = false } = {}) {
  const full = ['--yes', `hyperframes@${process.env.HF_VERSION || 'latest'}`, ...args];
  const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
  const r = IS_WIN
    ? spawnSync('npx ' + full.map(q).join(' '), { cwd, shell: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 256 * 1024 * 1024 })
    : spawnSync('npx', full, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error('npx not runnable: ' + r.error.message + '. Install Node.js 20+.');
  return r;
}

// QC motion: gray top-half samples at given times (270x225), mean abs diff between consecutive ones.
// Frozen panel ~0; real gameplay usually 10-60; brief still moments in trailers ~1-3.
export function sampleDiffs(file, times, top = 900) {
  const w = 270, h = 225, px = [];
  for (const t of times) {
    const r = sh(FFMPEG, ['-nostdin', '-v', 'error', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-frames:v', '1', '-vf', `crop=1080:${top}:0:0,scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { binary: true });
    px.push(r.stdout && r.stdout.length >= w * h ? r.stdout.subarray(0, w * h) : null);
  }
  const d = [];
  for (let i = 1; i < px.length; i++) { if (!px[i] || !px[i - 1]) { d.push(0); continue; } let s2 = 0; for (let k = 0; k < w * h; k++) s2 += Math.abs(px[i][k] - px[i - 1][k]); d.push(s2 / (w * h)); }
  return d;
}
export const windowTimes = (start, end, n = 8) => Array.from({ length: n }, (_, k) => start + 0.15 + (end - start - 0.3) * (k / (n - 1)));
