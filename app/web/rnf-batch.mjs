// rnf-batch — process a folder of clean-cut rnf clips through the auto-editor pipeline.
// Each filename = the game. Runs prepare()+finalize() per clip (50/50 split, B&W dramatic
// beat, poster, BGM+SFX, captions) with a concurrency-2 pool (the caption queue serializes
// server-side; local ffmpeg overlaps). Writes batch-progress.json + batch-log.txt and
// delivers every reel to gdrive:rnf-batch-edits/. Launch DETACHED so it survives teardown:
//   setsid nohup node rnf-batch.mjs <srcDir> > <srcDir>/batch-run.log 2>&1 < /dev/null &
import fs from 'node:fs';
import path from 'node:path';
import { prepare, finalize, projDir, setStatus } from './rnf-auto.mjs';

const SRC = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'work', 'rnf-batch-src');
const CONCURRENCY = parseInt(process.argv[3] || '2', 10);
const PROGRESS = path.join(SRC, 'batch-progress.json');
const LOG = path.join(SRC, 'batch-log.txt');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Drive strips ":" from filenames -> "Game- Subtitle.mp4". Restore ": " for the display name.
const displayName = (base) => base.replace(/-\s+/g, ': ').replace(/\s+/g, ' ').trim();
const log = (m) => { const line = `[${new Date().toISOString?.() || Date.now()}] ${m}\n`; try { fs.appendFileSync(LOG, line); } catch {} process.stdout.write(line); };

function loadProgress() { try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); } catch { return {}; } }
function saveProgress(p) { fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2)); }

async function processOne(rec, files) {
  const { file, game, id } = rec;
  const prog = loadProgress();
  // Resume-safe: skip clips already delivered — but NEVER skip one the QC gate
  // has flagged. Progress written before the gate existed marked bad reels
  // 'delivered', which would make them permanently unreachable by the gate.
  const qcHeld = fs.existsSync(path.join(projDir(id), 'qc-fail.json'));
  if (prog[id] && prog[id].stage === 'delivered' && prog[id].driveLink && !qcHeld) { log(`SKIP ${game} (already delivered)`); return prog[id]; }
  if (qcHeld) log(`RECHECK ${game} (was marked delivered, but QC has it flagged)`);
  const dir = projDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(SRC, file), path.join(dir, 'source.mp4'));
  // optional per-game overrides: <SRC>/overrides.json  { "Game": { "noTint": true, "tintTime": [a,b] } }
  const ov = (() => { try { return JSON.parse(fs.readFileSync(path.join(SRC, 'overrides.json'), 'utf8'))[game] || {}; } catch { return {}; } })();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, game, gameName: game, source: 'source.mp4', createdAt: Date.now(), batch: true, ...ov }, null, 2));
  const mark = (patch) => { const p = loadProgress(); p[id] = { game, id, ...(p[id] || {}), ...patch }; saveProgress(p); };
  mark({ stage: 'preparing', error: null });
  try {
    log(`PREPARE ${game}`);
    await prepare(id);
    const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
    const pl = JSON.parse(fs.readFileSync(path.join(dir, 'placements.json'), 'utf8'));
    const hasBroll = lib.length > 0 && pl.some((x) => x.clip);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
    mark({ stage: 'finalizing', hasBroll, bw: !!(plan && plan.tintBeat) });
    log(`FINALIZE ${game} (b-roll: ${hasBroll ? lib.length + ' clips' : 'NONE — full-frame'})`);
    const res = await finalize(id);
    if (res && res.qcHold) {
      mark({ stage: 'qc-hold', qc: res.qcHold, driveLink: null, hasBroll, finishedAt: Date.now() });
      log(`HELD ${game} -> QC: ${res.qcHold.join(', ')} (not delivered)`);
      return loadProgress()[id];
    }
    const deliver = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'deliver.json'), 'utf8')); } catch { return {}; } })();
    mark({ stage: 'delivered', driveLink: res.driveLink || deliver.driveLink || null, driveName: deliver.driveName || null, hasBroll, finishedAt: Date.now() });
    log(`DONE ${game} -> ${res.driveLink || '(no drive link)'}`);
    return loadProgress()[id];
  } catch (e) {
    mark({ stage: 'error', error: String(e.message || e).slice(0, 300) });
    log(`ERROR ${game}: ${String(e.message || e).slice(0, 200)}`);
    return loadProgress()[id];
  }
}

async function pool(items, worker, n) {
  const q = items.slice(); const running = new Set();
  async function next() {
    if (!q.length) return;
    const item = q.shift();
    const pr = worker(item).finally(() => running.delete(pr));
    running.add(pr);
    if (running.size >= n) await Promise.race(running);
    return next();
  }
  await next();
  await Promise.allSettled(running);
}

(async () => {
  const files = fs.readdirSync(SRC).filter((f) => /\.mp4$/i.test(f)).sort();
  const manifest = files.map((f) => { const base = f.replace(/\.[^.]+$/, ''); const game = displayName(base); return { file: f, game, id: 'b-' + slug(game) }; });
  log(`BATCH START — ${manifest.length} clips, concurrency ${CONCURRENCY}`);
  manifest.forEach((m, i) => log(`  ${String(i + 1).padStart(2, '0')}. ${m.game}  [${m.id}]`));
  await pool(manifest, (rec) => processOne(rec, files), CONCURRENCY);
  const prog = loadProgress();
  const done = Object.values(prog).filter((p) => p.stage === 'delivered');
  const noBroll = done.filter((p) => !p.hasBroll).map((p) => p.game);
  const failed = Object.values(prog).filter((p) => p.stage === 'error');
  log(`BATCH COMPLETE — ${done.length}/${manifest.length} delivered.` +
    (noBroll.length ? ` Full-frame (no b-roll found): ${noBroll.join(', ')}.` : '') +
    (failed.length ? ` FAILED: ${failed.map((p) => p.game).join(', ')}.` : ''));
  const heldList = Object.values(prog).filter((p) => p && p.stage === 'qc-hold');
  if (heldList.length) log(`HELD BY QC (NOT delivered): ${heldList.map((p) => p.game + ' [' + ((p.qc) || []).join('/') + ']').join(', ')}`);
  saveProgress({ ...prog, __summary: { total: manifest.length, delivered: done.length, held: heldList.map((p) => ({ game: p.game, qc: p.qc })), noBroll, failed: failed.map((p) => p.game), at: Date.now() } });
})();
