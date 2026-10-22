// rnf-pregather — fetch b-roll (poster + screenshots + trailer) for every game in the batch
// ONCE, slowly and politely (Steam appdetails is heavily rate-limited), and STAGE it into the
// seed folders the render pipeline reads (clients-current/rest-not-found/rnf-automation-assets/
// <slug>/{gameplay,broll/screenshots,broll/posters}). Decoupling gather from render means a
// rate-limit hiccup never wastes a render, and coverage is verifiable before rendering.
// Run detached:  setsid nohup node rnf-pregather.mjs <srcDir> > <srcDir>/pregather.log 2>&1 &
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { STEAM_EXTRACT, SEED_ROOT } from './rnf-paths.mjs';
const { extractSteam } = require(STEAM_EXTRACT);

const SRC = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'work', 'rnf-batch-src');
const TMP = path.join(SRC, '_pregather_tmp');
const COVERAGE = path.join(SRC, 'pregather-coverage.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const displayName = (base) => base.replace(/-\s+/g, ': ').replace(/\s+/g, ' ').trim();
const log = (m) => process.stdout.write(`[pregather] ${m}\n`);
const cpAll = (fromDir, toDir, filter) => {
  if (!fs.existsSync(fromDir)) return 0;
  fs.mkdirSync(toDir, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(fromDir)) { if (filter && !filter(f)) continue; try { fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f)); n++; } catch {} }
  return n;
};

(async () => {
  const files = fs.readdirSync(SRC).filter((f) => /\.mp4$/i.test(f)).sort();
  const cov = {};
  log(`staging b-roll for ${files.length} games -> ${SEED_ROOT}`);
  for (let gi = 0; gi < files.length; gi++) {
    const game = displayName(files[gi].replace(/\.[^.]+$/, ''));
    const sl = slug(game);
    const seed = path.join(SEED_ROOT, sl);
    // idempotent: skip if already staged with screenshots or a trailer
    const already = fs.existsSync(path.join(seed, 'broll', 'screenshots')) && fs.readdirSync(path.join(seed, 'broll', 'screenshots')).length;
    if (already) { cov[game] = { slug: sl, skipped: true, shots: fs.readdirSync(path.join(seed, 'broll', 'screenshots')).length }; log(`SKIP ${game} (already staged)`); continue; }
    const tmp = path.join(TMP, sl);
    try {
      log(`GATHER ${game}`);
      const r = await extractSteam(game, tmp, { maxShots: 8, trailers: 1 });
      const shots = cpAll(path.join(tmp, 'screenshots'), path.join(seed, 'broll', 'screenshots'));
      const posters = cpAll(path.join(tmp, 'posters'), path.join(seed, 'broll', 'posters'));
      const trailers = cpAll(path.join(tmp, 'trailers'), path.join(seed, 'gameplay'), (f) => /\.mp4$/i.test(f));
      cov[game] = { slug: sl, appid: r.appid, resolvedName: r.name, shots, posters, trailers };
      log(`  -> ${r.name} (appid ${r.appid}): ${shots} shots, ${trailers} trailer, ${posters} posters`);
    } catch (e) {
      cov[game] = { slug: sl, error: String(e.message || e).slice(0, 160) };
      log(`  -> FAIL ${game}: ${String(e.message || e).slice(0, 140)}`);
    }
    fs.writeFileSync(COVERAGE, JSON.stringify(cov, null, 2));
    if (gi < files.length - 1) await sleep(4500); // be polite to Steam between games
  }
  const ok = Object.values(cov).filter((c) => (c.shots || 0) > 0 || (c.trailers || 0) > 0 || c.skipped);
  const none = Object.entries(cov).filter(([, c]) => !c.skipped && !((c.shots || 0) > 0 || (c.trailers || 0) > 0)).map(([g]) => g);
  log(`PREGATHER COMPLETE — ${ok.length}/${files.length} have b-roll.` + (none.length ? ` NO b-roll: ${none.join(', ')}` : ''));
  fs.writeFileSync(COVERAGE, JSON.stringify({ ...cov, __summary: { total: files.length, withBroll: ok.length, none } }, null, 2));
})();
