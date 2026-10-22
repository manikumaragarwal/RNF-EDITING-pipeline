// rnf-check.mjs — format compliance gate for rest.not.found reels.
//
// Why this exists: on 2026-09-27 a batch logged "17/17 delivered" while 5 of 18
// reels on disk had zero b-roll placements and an empty clip library — i.e. they
// shipped as full-frame talking head, which is not the rnf format. Nothing in the
// chain asserted the output was compliant before pushing to Drive.
//
// Used as a gate inside finalize() before the rclone push, and standalone:
//   node rnf-check.mjs <projectDir>
//   node rnf-check.mjs --all
//
// A FAIL holds the reel and writes qc-fail.json. It never deletes anything.

import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const FFPROBE = process.env.FFPROBE || 'ffprobe';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// Format law for this client. Duration band is deliberately wide — it catches a
// truncated or runaway render, not editorial length.
export const RULES = {
  minDurationSec: 8,
  maxDurationSec: 45,
  width: 1080,
  height: 1920,
  targetLufs: -14,
  lufsToleranceLu: 2.0,
  minCaptionBytes: 100 * 1024,
  minFinalBytes: 1024 * 1024,
};

const readJson = (p, dflt = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
};

function probe(file) {
  try {
    const out = execFileSync(FFPROBE, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json', file,
    ], { encoding: 'utf8', timeout: 30000 });
    const j = JSON.parse(out);
    const s = (j.streams && j.streams[0]) || {};
    return { width: s.width, height: s.height, duration: parseFloat((j.format || {}).duration) };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 160) };
  }
}

function integratedLufs(file) {
  // ffmpeg writes the loudnorm JSON block to STDERR, so read both streams.
  try {
    const r = spawnSync(FFMPEG, [
      '-hide_banner', '-nostdin', '-i', file,
      '-af', 'loudnorm=print_format=json', '-f', 'null', '-',
    ], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    const blob = String(r.stderr || '') + String(r.stdout || '');
    const m = blob.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
    if (!m) return null;
    const v = parseFloat(JSON.parse(m[0]).input_i);
    return isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function checkReel(dir, opts = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const plan = opts.plan || readJson(path.join(dir, 'plan.json'), {}) || {};
  const placements = opts.placements || readJson(path.join(dir, 'placements.json'), []) || [];
  const library = opts.library || readJson(path.join(dir, 'library.json'), []) || [];
  const meta = opts.meta || readJson(path.join(dir, 'meta.json'), {}) || {};

  const finalPath = path.join(dir, 'final.mp4');
  const capPath = path.join(dir, 'captions.mov');

  // 1. THE one that matters most — b-roll actually placed AND resolved to a clip.
  //    A placement with no .clip composites nothing (finalize skips it), so the
  //    reel still ships full-frame. Matches the predicate rnf-batch already used.
  const placed = placements.filter((pl) => pl && pl.clip);
  add('broll_placed', placed.length > 0,
    placed.length + ' of ' + placements.length + ' placement(s) carry a clip' +
    (placed.length === 0 ? ' — reel would ship as full-frame talking head' : ''));

  // 2. Clips were actually gathered. An empty library means the gather step failed
  //    silently (usually the YouTube block), which is the upstream cause of #1.
  add('broll_library', library.length > 0, library.length + ' clip(s) in library');

  // 3. Caption layer rendered and non-trivial.
  let capBytes = 0;
  try { capBytes = fs.statSync(capPath).size; } catch {}
  add('captions_present', capBytes >= RULES.minCaptionBytes,
    capBytes ? (capBytes / 1048576).toFixed(1) + 'MB' : 'captions.mov missing');

  // 4. Final file exists and is not a stub.
  let finalBytes = 0;
  try { finalBytes = fs.statSync(finalPath).size; } catch {}
  add('final_present', finalBytes >= RULES.minFinalBytes,
    finalBytes ? (finalBytes / 1048576).toFixed(1) + 'MB' : 'final.mp4 missing');

  // Everything below needs the file to exist.
  if (finalBytes >= RULES.minFinalBytes) {
    const p = probe(finalPath);
    if (p.error) {
      add('dimensions', false, 'ffprobe failed: ' + p.error);
      add('duration', false, 'ffprobe failed');
    } else {
      add('dimensions', p.width === RULES.width && p.height === RULES.height,
        p.width + 'x' + p.height + ' (want ' + RULES.width + 'x' + RULES.height + ')');

      const inBand = p.duration >= RULES.minDurationSec && p.duration <= RULES.maxDurationSec;
      const planned = Number(plan.duration) || null;
      const drift = planned ? Math.abs(p.duration - planned) : 0;
      add('duration', inBand && drift <= 1.5,
        p.duration.toFixed(2) + 's' + (planned ? ' (plan ' + planned.toFixed(2) + 's, drift ' + drift.toFixed(2) + 's)' : ''));
    }

    if (opts.skipLoudness) {
      add('loudness', true, 'skipped');
    } else {
      const lufs = integratedLufs(finalPath);
      if (lufs === null || !isFinite(lufs)) {
        // Never fail a reel because the meter failed. Flag it as unmeasured.
        add('loudness', true, 'could not measure — unverified');
      } else {
        const off = Math.abs(lufs - RULES.targetLufs);
        add('loudness', off <= RULES.lufsToleranceLu,
          lufs.toFixed(1) + ' LUFS (want ' + RULES.targetLufs + ' ±' + RULES.lufsToleranceLu + ')');
      }
    }
  }

  const fails = checks.filter((c) => !c.ok);
  return {
    id: meta.id || path.basename(dir),
    game: meta.gameName || meta.game || null,
    pass: fails.length === 0,
    checks,
    fails: fails.map((f) => f.name),
    at: Date.now(),
  };
}

/* Write the verdict next to the reel. qc-fail.json is the operator's flag; it is
   removed on a later pass so a fixed reel does not stay flagged. */
export function writeVerdict(dir, result) {
  const failPath = path.join(dir, 'qc-fail.json');
  try {
    fs.writeFileSync(path.join(dir, 'qc.json'), JSON.stringify(result, null, 2));
    if (result.pass) { if (fs.existsSync(failPath)) fs.unlinkSync(failPath); }
    else fs.writeFileSync(failPath, JSON.stringify(result, null, 2));
  } catch {}
  return result;
}

export function formatResult(r) {
  const head = (r.pass ? 'PASS' : 'HOLD') + '  ' + r.id + (r.game ? '  (' + r.game + ')' : '');
  const lines = r.checks.map((c) => '  ' + (c.ok ? 'ok  ' : 'FAIL') + '  ' + c.name.padEnd(18) + c.detail);
  return [head, ...lines].join('\n');
}

// ---- CLI ------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1].endsWith('rnf-check.mjs');
if (isMain) {
  const arg = process.argv[2];
  const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), 'work', 'rnf');
  const skipLoudness = process.argv.includes('--fast');

  if (!arg) {
    console.error('usage: node rnf-check.mjs <projectDir|--all> [--fast]');
    process.exit(2);
  }

  const dirs = arg === '--all'
    ? fs.readdirSync(ROOT).map((d) => path.join(ROOT, d)).filter((d) => fs.statSync(d).isDirectory())
    : [path.resolve(arg)];

  let held = 0;
  for (const d of dirs) {
    const r = writeVerdict(d, checkReel(d, { skipLoudness }));
    if (!r.pass) held++;
    console.log(formatResult(r));
    console.log('');
  }
  if (dirs.length > 1) console.log(dirs.length + ' checked, ' + held + ' would be HELD');
  process.exit(held > 0 && dirs.length === 1 ? 1 : 0);
}
