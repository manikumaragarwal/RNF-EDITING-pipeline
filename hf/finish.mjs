// finish.mjs: lint -> render -> loudness -14 LUFS -> QC gate -> review frames.
//   node hf/finish.mjs <projectDir> [--quality draft|looks|delivery] [--workers N] [--skip-render]
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const proj = path.resolve(argv[0] || '.');
const qi = argv.indexOf('--quality'); const quality = qi >= 0 ? argv[qi + 1] : 'delivery';
const wi = argv.indexOf('--workers'); const workers = wi >= 0 ? ['--workers', argv[wi + 1]] : [];
const b = L.rd(path.join(proj, 'build.json'));
if (!b) throw new Error('no build.json: run hf/build.mjs first');
const out = path.join(proj, 'renders'); fs.mkdirSync(out, { recursive: true });
const raw = path.join(out, 'raw.mp4'), final = path.join(proj, 'final.mp4');

if (!argv.includes('--skip-render')) {
  L.log('[finish] lint');
  const lint = L.hyperframes(['lint'], proj);
  if (lint.status !== 0) { console.error('[finish] lint has errors. Fix index.html/plan and rebuild before rendering.'); process.exit(1); }
  L.log(`[finish] render (${quality}). Long: keep the window open, or run detached.`);
  const r = L.hyperframes(['render', '.', '--output', 'renders/raw.mp4', '--quality', quality, '--fps', '30', '--gpu', ...workers], proj);
  if (r.status !== 0 || !fs.existsSync(raw)) { console.error('[finish] render failed'); process.exit(1); }
  // master loudness like the old pipeline (VO dominant, -14 LUFS, -1.5 dBTP); video stream copied
  L.ff(['-i', raw, '-c:v', 'copy', '-af', 'alimiter=limit=0.97,loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', final]);
}
if (!fs.existsSync(final)) throw new Error('no final.mp4');

// ---------- QC gate (format law) ----------
const fails = [], notes = [];
const d = L.dims(final), fd = L.dur(final);
if (d.w !== 1080 || d.h !== 1920) fails.push(`dimensions ${d.w}x${d.h}`);
if (fd < 8 || fd > 45 || Math.abs(fd - b.duration) > 0.5) fails.push(`duration ${fd.toFixed(2)}s (source ${b.duration}s)`);
const e = String(L.sh(L.FFMPEG, ['-nostdin', '-i', final, '-af', 'ebur128', '-f', 'null', '-']).stderr || '');
const lufs = parseFloat((e.match(/I:\s+(-?[0-9.]+) LUFS(?![\s\S]*I:\s+-?[0-9.]+ LUFS)/) || [])[1]);
if (!(Math.abs(lufs + 14) <= 2)) fails.push(`loudness ${lufs} LUFS`);
if (!b.windows.length) fails.push('no b-roll split windows');
// every split window: the render must move wherever its source clip moves (catches render freezes),
// and the chosen b-roll must not be static overall (catches title cards / dead shots)
b.windows.forEach((w, k) => {
  const times = L.windowTimes(w.start, w.end);
  const rd = L.sampleDiffs(final, times);
  const src = times.map((t) => { const sg = b.segments.find((g) => t >= g.start && t < g.start + g.dur) || b.segments[0]; return { clip: sg.clip, t: sg.mediaStart + (t - sg.start) }; });
  const sd = []; // source diffs per pair (same clip only)
  for (let i = 1; i < src.length; i++) sd.push(src[i].clip === src[i - 1].clip ? L.sampleDiffs(path.join(proj, src[i].clip), [src[i - 1].t, src[i].t], 900)[0] : 99);
  const frozen = rd.filter((v, i) => v < 1 && sd[i] > 3).length;
  const mean = rd.reduce((a, c) => a + c, 0) / rd.length, mn = Math.min(...rd);
  const tag = `window ${k} (${w.start}-${w.end}s)`;
  if (frozen) fails.push(`${tag}: render frozen on ${frozen} sample(s) where the source moves`);
  else if (mean < 5) fails.push(`${tag}: b-roll nearly static (mean motion ${mean.toFixed(1)}), pick another clip/clipIn`);
  else if (mn < 3) notes.push(`${tag}: brief still moment (min ${mn.toFixed(1)}, mean ${mean.toFixed(1)}), look at it`);
  else notes.push(`${tag}: moving (min ${mn.toFixed(1)}, mean ${mean.toFixed(1)})`);
});

// ---------- frames to LOOK at (the agent's half of the gate) ----------
const fr = path.join(proj, 'qc-frames'); fs.mkdirSync(fr, { recursive: true });
const shots = [['01-hook', 1.0], ['02-hook', Math.min(2.2, b.windows[0]?.start - 0.2 || 2.2)], ['03-logo', b.logoIn + 1.2]];
const ws = b.windows; [0, Math.floor(ws.length / 2), ws.length - 1].filter((v, i, a) => a.indexOf(v) === i)
  .forEach((k, j) => shots.push([`0${4 + j}-split-w${k}`, (ws[k].start + ws[k].end) / 2]));
if (b.tint) shots.push(['07-tint', (b.tint[0] + b.tint[1]) / 2]);
shots.push(['08-cta', fd - 1.0], ['09-cta-last', fd - 0.3]);
for (const [name, t] of shots) L.ff(['-ss', String(Math.max(0, t).toFixed(2)), '-i', final, '-frames:v', '1', '-q:v', '3', path.join(fr, `${name}.jpg`)]);
L.ff(['-i', final, '-vf', `fps=${(12 / fd).toFixed(4)},scale=270:-1,tile=6x2`, '-frames:v', '1', path.join(fr, 'sheet.jpg')]);

const pass = fails.length === 0;
L.wr(path.join(proj, 'qc.json'), { pass, fails, notes, lufs, duration: fd, at: new Date().toISOString() });
if (!pass) { L.wr(path.join(proj, 'qc-fail.json'), { fails }); }
else if (fs.existsSync(path.join(proj, 'qc-fail.json'))) fs.renameSync(path.join(proj, 'qc-fail.json'), path.join(proj, `qc-fail.superseded-${Date.now()}.json`));
L.log(`[finish] QC ${pass ? 'PASS' : 'FAIL'}${fails.length ? ':\n  - ' + fails.join('\n  - ') : ''}`);
L.log(`[finish] ${final}\n[finish] now LOOK at every image in ${fr} (Definition of done in the skill) before calling it done.`);

if (pass && process.env.RNF_DRIVE_DEST) {
  const name = `rnf-${b.slug || path.basename(proj)}.mp4`;
  const r = L.sh(process.env.RCLONE || 'rclone', ['copyto', final, `${process.env.RNF_DRIVE_DEST}/${name}`]);
  if (r.status === 0) L.log('[finish] uploaded: ' + String(L.sh(process.env.RCLONE || 'rclone', ['link', `${process.env.RNF_DRIVE_DEST}/${name}`]).stdout).trim());
  else L.log('[finish] upload failed: ' + String(r.stderr).slice(-300));
}
process.exitCode = pass ? 0 : 3;
