#!/usr/bin/env node
'use strict';

/**
 * steam-extract.js — pull official art + screenshots + trailers for a game from
 * the public Steam Storefront API (keyless, credit-free). Built for the rnf
 * (rest.not.found) gaming footage lane.
 *
 *   node steam-extract.js "<game name or appid>" <out-dir> [flags]
 *   node steam-extract.js "<game name>" --resolve-only        # just print candidates (approval step)
 *
 * Flags:
 *   --appid <id>       force a specific Steam appid (skip name resolution)
 *   --resolve-only     print name->appid candidates as JSON and exit (no downloads)
 *   --max-shots N      max store screenshots to download (default 8)
 *   --trailers N       max trailers to download (default 1; 0 = none)
 *   --cc XX --lang L   storefront country / language (default us / english)
 *   --json             print a JSON summary to stdout (default on when run as CLI)
 *
 * Exports extractSteam(input, outDir, opts) -> { appid, name, chosen, candidates, files, meta }
 * and resolveAppId(term, opts) -> [{ id, name, tiny_image, price, ... }].
 *
 * Credit-free: only the public store.steampowered.com JSON APIs + Steam CDN images/mp4.
 * Optional SteamGridDB posters run ONLY if STEAMGRIDDB_KEY is in env (free key); skipped cleanly otherwise.
 */

const fs = require('fs');
const path = require('path');
const { httpGet, httpGetJson, download, ensureDir, slugify } = require('../footage-gather/lib/util');

const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const STEAM_SHARED = 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** small retry around a JSON GET — the store API 429s if hammered */
async function getJsonRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(Math.min(9000, 900 * 2 ** i)); // exponential backoff — Steam appdetails throttles hard
    try {
      return await httpGetJson(url);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** name -> [candidate apps]. Uses the storefront search suggest endpoint. */
async function resolveAppId(term, { cc = 'us', lang = 'english' } = {}) {
  if (/^\d{1,10}$/.test(String(term).trim())) {
    return [{ id: Number(term), name: `appid ${term}`, exact: true }];
  }
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=${lang}&cc=${cc}`;
  // storesearch ALSO returns an empty item list when throttled (not an HTTP error), so retry
  // on empty with backoff before concluding a game genuinely isn't on Steam.
  let items = [];
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(Math.min(9000, 1200 * 2 ** i));
    let j; try { j = await httpGetJson(url); } catch { continue; }
    items = (j && j.items) || [];
    if (items.length) break;
  }
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    tiny_image: it.tiny_image || null,
    price: it.price ? (it.price.final != null ? it.price.final / 100 : null) : 0,
    platforms: it.platforms || null,
  }));
}

/** appid -> appdetails.data (or throws). Steam signals rate-limiting with HTTP 200 +
 * {success:false}, so we must RETRY on success:false (with backoff), not just on network
 * errors. A genuinely unreleased/region-locked app stays false through all tries -> throws. */
async function appDetails(appid, { cc = 'us', lang = 'english', tries = 6 } = {}) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=${lang}&cc=${cc}`;
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(Math.min(12000, 1200 * 2 ** i));
    let j;
    try { j = await httpGetJson(url); } catch (e) { last = e; continue; }
    const node = j && j[String(appid)];
    if (node && node.success && node.data) return node.data;
    last = new Error(`appdetails success:false for appid ${appid} (rate-limited or unreleased)`);
  }
  throw last;
}

/** try a list of candidate CDN urls, download the first that returns 200 */
async function downloadFirst(urls, dest) {
  for (const u of urls) {
    try {
      await download(u, dest);
      return { url: u, file: dest };
    } catch (e) {
      /* try next */
    }
  }
  return null;
}

/** optional: SteamGridDB portrait posters (needs a free STEAMGRIDDB_KEY) */
async function steamGridPosters(appid, dir, max = 3) {
  const key = process.env.STEAMGRIDDB_KEY;
  if (!key) return [];
  const files = [];
  try {
    const r = await httpGet(`https://www.steamgriddb.com/api/v2/grids/steam/${appid}?dimensions=600x900&types=static`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (r.status !== 200) return [];
    const j = JSON.parse(r.body.toString('utf8'));
    const grids = (j && j.data) || [];
    for (let i = 0; i < Math.min(max, grids.length); i++) {
      const ext = (grids[i].url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [, 'png'])[1];
      const dest = path.join(dir, `sgdb-poster-${i + 1}.${ext}`);
      try {
        await download(grids[i].url, dest);
        files.push(dest);
      } catch (e) {
        /* skip */
      }
    }
  } catch (e) {
    /* SteamGridDB is best-effort */
  }
  return files;
}

async function extractSteam(input, outDir, opts = {}) {
  const cc = opts.cc || 'us';
  const lang = opts.lang || 'english';
  const maxShots = opts.maxShots != null ? opts.maxShots : 8;
  const maxTrailers = opts.trailers != null ? opts.trailers : 1;

  // 1) resolve
  let appid = opts.appid || null;
  let candidates = [];
  let data = null;
  let name = null;
  if (appid) {
    data = await appDetails(appid, { cc, lang });
    name = data.name || String(input);
  } else {
    candidates = await resolveAppId(input, { cc, lang });
    if (!candidates.length) throw new Error(`no Steam results for "${input}"`);
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const want = norm(input);
    // drop companion apps that are NOT the game (soundtracks/art books/season passes/demos);
    // Steam's storesearch returns these alongside the game and blindly picking one gathered
    // e.g. "Crashlands Soundtrack" (type: music) instead of the game.
    const NONGAME = /soundtrack|original score|\bost\b|art ?book|artbook|digital (art|deluxe|book)|design book|season pass|\bdlc\b|bonus|wallpaper|\bdemo\b|upgrade|edition pack/i;
    let poolC = candidates.filter((c) => !NONGAME.test(c.name));
    if (!poolC.length) poolC = candidates.slice();
    // RANK: exact name match first, then startsWith, then contains — within a tier prefer the
    // SHORTER name (the base game over "… 2"/"Deluxe"). Search often returns the sequel first.
    const tier = (nm) => { const n = norm(nm); return n === want ? 0 : n.startsWith(want) ? 1 : n.includes(want) ? 2 : 3; };
    const ranked = poolC.sort((a, b) => (tier(a.name) - tier(b.name)) || (norm(a.name).length - norm(b.name).length));
    // pick the first candidate whose appdetails is an actual GAME. Space the calls out — Steam's
    // appdetails is aggressively rate-limited and firing them back-to-back returns spurious nulls.
    let lastErr = null;
    for (let i = 0; i < Math.min(ranked.length, 5); i++) {
      if (i) await sleep(900);
      try {
        const d = await appDetails(ranked[i].id, { cc, lang });
        if (d && (d.type === 'game' || d.type === 'dlc')) { data = d; appid = ranked[i].id; name = d.name || ranked[i].name; break; }
        lastErr = new Error(`appid ${ranked[i].id} is type ${d && d.type}`);
      } catch (e) { lastErr = e; }
    }
    if (!data) throw new Error(`no game appdetails for "${input}" (${lastErr && lastErr.message})`);
  }

  // guard: if a name was supplied alongside a forced appid, fail LOUDLY on a mismatch
  // (a stale/guessed appid silently gathering the wrong game is the top risk here).
  if (opts.expectName) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const want = norm(opts.expectName).split(' ').filter((w) => w.length > 2);
    const got = new Set(norm(name).split(' '));
    if (want.length && !want.some((w) => got.has(w))) {
      throw new Error(`appid ${appid} resolves to "${name}", not "${opts.expectName}". Resolve first: steam-extract.js "${opts.expectName}" --resolve-only`);
    }
  }

  const slug = slugify(name, 40);

  const postersDir = path.join(outDir, 'posters');
  const shotsDir = path.join(outDir, 'screenshots');
  const trailersDir = path.join(outDir, 'trailers');
  [postersDir, shotsDir, trailersDir].forEach(ensureDir);

  const files = [];
  const rec = (label, res) => {
    if (res) files.push({ label, url: res.url, file: path.relative(outDir, res.file) });
  };

  // 3) posters / key art (portrait poster is the money asset for gaming content)
  rec('poster-portrait', await downloadFirst([
    `${STEAM_CDN}/${appid}/library_600x900_2x.jpg`,
    `${STEAM_SHARED}/${appid}/library_600x900_2x.jpg`,
    `${STEAM_CDN}/${appid}/library_600x900.jpg`,
    `${STEAM_SHARED}/${appid}/library_600x900.jpg`,
  ], path.join(postersDir, `${slug}-poster.jpg`)));

  rec('hero', await downloadFirst([
    `${STEAM_CDN}/${appid}/library_hero.jpg`,
    `${STEAM_SHARED}/${appid}/library_hero.jpg`,
  ], path.join(postersDir, `${slug}-hero.jpg`)));

  rec('logo', await downloadFirst([
    `${STEAM_CDN}/${appid}/logo.png`,
    `${STEAM_SHARED}/${appid}/logo.png`,
  ], path.join(postersDir, `${slug}-logo.png`)));

  if (data.header_image) rec('header', await downloadFirst([data.header_image], path.join(postersDir, `${slug}-header.jpg`)));
  if (data.capsule_imagev5 || data.capsule_image) {
    rec('capsule', await downloadFirst([data.capsule_imagev5, data.capsule_image].filter(Boolean), path.join(postersDir, `${slug}-capsule.jpg`)));
  }

  // optional SteamGridDB posters
  const sgdb = await steamGridPosters(appid, postersDir, 3);
  sgdb.forEach((f) => files.push({ label: 'sgdb-poster', url: null, file: path.relative(outDir, f) }));

  // 4) store screenshots (full-res)
  const shots = (data.screenshots || []).slice(0, maxShots);
  for (let i = 0; i < shots.length; i++) {
    const dest = path.join(shotsDir, `${slug}-shot-${String(i + 1).padStart(2, '0')}.jpg`);
    try {
      await download(shots[i].path_full, dest);
      files.push({ label: 'screenshot', url: shots[i].path_full, file: path.relative(outDir, dest) });
    } catch (e) {
      /* skip a failed shot */
    }
  }

  // 5) trailers — Steam now returns DASH/HLS manifests (dash_h264/hls_h264), NOT the old
  // mp4:{max} fields. But the classic direct mp4 is still served at /steam/apps/<movieId>/movie_max.mp4
  // (verified 2026-09-24), so derive it from the movie id and download directly (no yt-dlp).
  const movies = (data.movies || []).slice(0, Math.max(0, maxTrailers));
  for (let i = 0; i < movies.length; i++) {
    const m = movies[i];
    const dest = path.join(trailersDir, `${slug}-trailer-${i + 1}.mp4`);
    const res = await downloadFirst([
      `https://cdn.akamai.steamstatic.com/steam/apps/${m.id}/movie_max.mp4`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${m.id}/movie_max.mp4`,
      `https://cdn.akamai.steamstatic.com/steam/apps/${m.id}/movie480.mp4`,
    ], dest);
    if (res) files.push({ label: 'trailer', url: res.url, file: path.relative(outDir, res.file), name: m.name || null });
  }

  const meta = {
    appid,
    name,
    type: data.type,
    is_free: !!data.is_free,
    release_date: (data.release_date && data.release_date.date) || null,
    genres: (data.genres || []).map((g) => g.description),
    developers: data.developers || [],
    publishers: data.publishers || [],
    short_description: data.short_description || '',
    store_url: `https://store.steampowered.com/app/${appid}/`,
    counts: {
      posters: files.filter((f) => /poster|hero|logo|header|capsule/.test(f.label)).length,
      screenshots: files.filter((f) => f.label === 'screenshot').length,
      trailers: files.filter((f) => f.label === 'trailer').length,
    },
  };

  return { appid, name, chosen: name, candidates, files, meta };
}

module.exports = { extractSteam, resolveAppId, appDetails };

// ---- CLI ----
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const flag = (n) => argv.includes(n);
    const val = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
    const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--resolve-only', '--json'].includes(argv[i - 1])));
    const input = positional[0];
    const outDir = positional[1];
    if (!input) {
      console.error('Usage: steam-extract.js "<game name or appid>" <out-dir> [--appid ID] [--resolve-only] [--max-shots N] [--trailers N]');
      process.exit(1);
    }
    const opts = {
      appid: val('--appid', null),
      cc: val('--cc', 'us'),
      lang: val('--lang', 'english'),
      maxShots: parseInt(val('--max-shots', '8'), 10),
      trailers: parseInt(val('--trailers', '1'), 10),
    };

    try {
      if (flag('--resolve-only')) {
        const cands = await resolveAppId(input, opts);
        console.log(JSON.stringify({ success: true, term: input, candidates: cands }, null, 2));
        return;
      }
      if (!outDir) {
        console.error('ERROR: out-dir is required unless --resolve-only');
        process.exit(1);
      }
      ensureDir(path.resolve(outDir));
      const r = await extractSteam(input, path.resolve(outDir), opts);
      console.log(JSON.stringify({ success: true, ...r }, null, 2));
    } catch (e) {
      console.error('ERROR:', e.message);
      process.exit(1);
    }
  })();
}
