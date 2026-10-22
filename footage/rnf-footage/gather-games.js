#!/usr/bin/env node
'use strict';

/**
 * gather-games.js — the rnf (rest.not.found) GAMING footage orchestrator.
 *
 * Sibling of footage-gather's gather.js, purpose-built for a game: pulls official
 * Steam art + screenshots + trailer, YouTube gameplay clips, and store-page
 * screenshots (Steam / Play Store) into ONE per-game folder tree, writes
 * manifest.json (every source URL, for attribution + re-runs), optional Drive push.
 *
 *   node gather-games.js <gather-list.json> [--out <dir>] [--drive]
 *
 * gather-list.json shape:
 *   {
 *     "slug": "cyberpunk-2077",
 *     "title": "Cyberpunk 2077 — free-weekend pickup",
 *     "items": [
 *       { "type": "steam", "name": "Cyberpunk 2077", "appid": 1091500, "maxShots": 8, "trailers": 1 },
 *       { "type": "video", "url": "https://youtube.com/watch?v=...", "note": "gameplay walkthrough", "maxMB": 300 },
 *       { "type": "site",  "url": "https://store.steampowered.com/app/1091500/", "label": "steam-store" },
 *       { "type": "site",  "url": "https://play.google.com/store/apps/details?id=...", "label": "playstore" }
 *     ]
 *   }
 *
 * Output tree (per game):
 *   rnf-game-<slug>/
 *   ├── posters/      Steam key art (portrait poster, hero, logo, header, capsule) [+ SteamGridDB if key]
 *   ├── screenshots/  Steam store screenshots (full-res 1920x1080)
 *   ├── trailers/     Steam-hosted trailer mp4(s)
 *   ├── gameplay/     YouTube gameplay / trailer clips (yt-dlp)
 *   ├── store/        Steam + Play Store listing screenshots (hero + full page)
 *   └── manifest.json
 *
 * Credit-free: Steam public API + CDN, yt-dlp (+ .secrets/yt-cookies.txt for YouTube),
 * headless Chrome, rclone. No Apify, no Magnific.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch } = require('../footage-gather/lib/chrome');
const { screenshotUrl } = require('../footage-gather/screenshot-url');
const { downloadVideo } = require('../footage-gather/dl-video');
const { extractSteam } = require('./steam-extract');
const { ensureDir, slugify } = require('../footage-gather/lib/util');

function rel(root, p) {
  return path.relative(root, p);
}

async function handleSteam(item, root) {
  const r = await extractSteam(item.appid || item.name, root, {
    appid: item.appid || null,
    expectName: item.appid && item.name ? item.name : null,
    maxShots: item.maxShots != null ? item.maxShots : 8,
    trailers: item.trailers != null ? item.trailers : 1,
    cc: item.cc,
    lang: item.lang,
  });
  // steam-extract already writes paths relative to root
  return { files: r.files.map((f) => f.file), meta: { appid: r.appid, name: r.name, candidates: r.candidates, ...r.meta } };
}

async function handleVideo(item, root) {
  const dir = ensureDir(path.join(root, 'gameplay'));
  const r = await downloadVideo(item.url, dir, { maxMB: item.maxMB || 300 });
  return { files: [rel(root, r.file)], meta: { title: r.title, kind: r.kind } };
}

async function handleSite(item, root, browser) {
  const dir = ensureDir(path.join(root, 'store'));
  const label = slugify(item.label || item.url, 40);
  const prefix = path.join(dir, label);
  const shots = await screenshotUrl(item.url, prefix, { browser, mode: item.mode || 'both' });
  return { files: shots.map((f) => rel(root, f)), meta: {} };
}

async function main() {
  const args = process.argv.slice(2);
  const listPath = args.find((a) => !a.startsWith('--'));
  if (!listPath) {
    console.error('Usage: gather-games.js <gather-list.json> [--out <dir>] [--drive]');
    process.exit(1);
  }
  const list = JSON.parse(fs.readFileSync(path.resolve(listPath), 'utf8'));
  const slug = slugify(list.slug || list.title || 'game', 50);

  const outDir = args.includes('--out')
    ? path.resolve(args[args.indexOf('--out') + 1])
    : path.resolve(process.env.FOOTAGE_STAGING || '/tmp/footage', `rnf-game-${slug}`);
  ensureDir(outDir);

  const items = list.items || [];
  const log = (m) => console.error(m);
  log(`\n▶ gathering ${items.length} items for "${list.title || slug}" → ${outDir}\n`);

  // only spin up Chrome if a site screenshot is actually requested
  const needsBrowser = items.some((it) => it.type === 'site');
  const browser = needsBrowser ? await launch() : null;

  const results = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const label = item.url || item.name || item.appid || item.type;
      const tag = `[${i + 1}/${items.length}] ${item.type}: ${label}`;
      try {
        let r;
        if (item.type === 'steam') r = await handleSteam(item, outDir);
        else if (item.type === 'video') r = await handleVideo(item, outDir);
        else if (item.type === 'site') r = await handleSite(item, outDir, browser);
        else throw new Error(`unknown item type: ${item.type}`);
        results.push({ ...item, status: 'ok', files: r.files, meta: r.meta });
        log(`  ✓ ${tag}  (${r.files.length} file${r.files.length === 1 ? '' : 's'})`);
      } catch (e) {
        results.push({ ...item, status: 'error', files: [], error: e.message });
        log(`  ✗ ${tag}\n      ${e.message}`);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  const counts = { steam: 0, video: 0, site: 0, errors: 0, files: 0 };
  for (const r of results) {
    if (r.status === 'ok') counts[r.type] = (counts[r.type] || 0) + 1;
    else counts.errors += 1;
    counts.files += r.files.length;
  }

  const manifest = {
    slug,
    title: list.title || slug,
    generatedAt: new Date().toISOString(),
    root: outDir,
    counts,
    items: results,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  let driveFolder = null;
  if (args.includes('--drive')) {
    driveFolder = `rnf-game-${slug}`;
    log(`\n▶ pushing to gdrive:${driveFolder} ...`);
    execFileSync('bash', [path.join(__dirname, '..', 'footage-gather', 'push-drive.sh'), outDir, driveFolder], {
      stdio: 'inherit',
    });
  }

  log(`\n✔ done — ${counts.files} files, ${counts.errors} errors\n`);
  console.log(JSON.stringify({ success: true, outDir, driveFolder, counts, manifest: path.join(outDir, 'manifest.json') }, null, 2));
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
