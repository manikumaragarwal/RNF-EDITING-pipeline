#!/usr/bin/env node
/**
 * match-broll.js — match an rnf script beat / keywords to indexed GAMEPLAY b-roll.
 *
 *   node match-broll.js <game-folder> "neon city gunfight"
 *   node match-broll.js <game-folder> --beat hook-visual --intensity intense
 *   node match-broll.js <game-folder> --activity traversal/climb --no-hud "mountain"
 *   node match-broll.js <game-folder> "boss" --scene gameplay --top 15 --json
 *
 * Flags: --beat <b> --activity <a> --scene <s> --intensity <i> --no-hud
 *        --top N (default 12)  --json   [--index <path> overrides <game-folder>/broll-index.json]
 * Free-text words score against subject/activity/setting_env/tags/notes/on_screen_text.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = { top: 12, words: [] };
let gameDir = null, indexPath = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--beat') opt.beat = args[++i];
  else if (a === '--activity') opt.activity = args[++i];
  else if (a === '--scene') opt.scene = args[++i];
  else if (a === '--intensity') opt.intensity = args[++i];
  else if (a === '--no-hud') opt.noHud = true;
  else if (a === '--top') opt.top = parseInt(args[++i], 10);
  else if (a === '--json') opt.json = true;
  else if (a === '--index') indexPath = args[++i];
  else if (!a.startsWith('--') && !gameDir && !indexPath) gameDir = a;
  else opt.words.push(a.toLowerCase());
}
if (!indexPath) indexPath = gameDir ? path.join(path.resolve(gameDir), 'broll-index.json') : null;
if (!indexPath || !fs.existsSync(indexPath)) {
  console.error('Usage: match-broll.js <game-folder> "<keywords>" [--beat b] [--activity a] [--scene s] [--intensity i] [--no-hud] [--top N] [--json]');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')).filter((r) => !r._error && !r._parse_error);
const hay = (r) => [r.subject, r.activity, r.setting_env, r.scene_type, r.mood, r.on_screen_text, r.notes, (r.tags || []).join(' ')].join(' ').toLowerCase();

function score(r) {
  if (opt.scene && r.scene_type !== opt.scene) return -1;
  if (opt.noHud && r.has_hud) return -1;
  let s = 0;
  const h = hay(r);
  for (const w of opt.words) if (h.includes(w)) s += 3;
  if (opt.beat && (r.beats || []).some((b) => b.includes(opt.beat))) s += 5;
  if (opt.activity && (r.activity || '').toLowerCase().includes(opt.activity.toLowerCase())) s += 4;
  if (opt.intensity && (r.intensity || '').toLowerCase() === opt.intensity.toLowerCase()) s += 3;
  if (r.quality === 'cinematic') s += 0.5;
  return s;
}

const ranked = index.map((r) => ({ r, s: score(r) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, opt.top);

if (opt.json) { console.log(JSON.stringify(ranked.map((x) => ({ score: x.s, ...x.r })), null, 2)); process.exit(0); }

if (!ranked.length) { console.log('No matches. Try broader keywords or drop a filter.'); process.exit(0); }
console.log(`Top ${ranked.length} of ${index.length} indexed clips:\n`);
for (const { r, s } of ranked) {
  const dur = `${r.duration_s}s`;
  const hud = r.has_hud ? ' · HUD' : ' · clean';
  console.log(`• (${s.toFixed(1)}) ${r.folder}/${r.file}`);
  console.log(`    ${r.subject}`);
  console.log(`    ${dur} · ${r.camera} · ${r.activity} · ${r.intensity}${hud} · ${r.quality} · beats:[${(r.beats || []).join(', ')}]`);
  if (r.best_ranges && r.best_ranges.length) console.log(`    ranges: ${r.best_ranges.join(' | ')}`);
  console.log('');
}
