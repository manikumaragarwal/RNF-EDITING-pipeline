# Footage: gameplay b-roll + logos

The edit is only as good as the gameplay in the top half. Free sources only (no paid APIs).

## Priority
1. **Human-supplied gameplay**: best. Drop into `assets/game-assets/<slug>/gameplay/` or upload in the web UI.
2. **YouTube gameplay**: `node app/web/rnf-yt-gameplay.mjs "Game A" "Game B"` searches `"<game> gameplay no commentary"`, grabs a ~60s mid-video section (`0:12-1:12`) of the first result over 25s, re-encodes h264, stages `gameplay/yt-1.mp4`. `--rerender` also archives and re-queues those reels. Needs `.secrets/yt-cookies*.txt`. Prefer no-facecam, no loud commentary. **Verify it's the right game.**
3. **Steam trailer**: cinematic, sometimes title cards. A fallback.
4. **Official site video**: headless Chrome, pull `<video>`/network `.mp4` URLs.

## Steam (`footage/rnf-footage/steam-extract.js`)
```bash
node footage/rnf-footage/steam-extract.js "Game Name" --resolve-only          # list candidates; confirm the right appid
node footage/rnf-footage/steam-extract.js "Game Name" <outDir> --appid <id> [--max-shots N] [--trailers N]
```
Outputs `posters/` (`-poster.jpg` portrait, `-hero`, `-logo.png`, `-header.jpg`, `-capsule`), `screenshots/`
(1920x1080), `trailers/` (or `gameplay/`). For the engine, put the logo/header under
`assets/game-assets/<slug>/broll/posters/` and the trailer under `<slug>/gameplay/`. Keyless public API.
Name + appid are cross-checked and fail loudly on mismatch.

Batch: `node app/web/rnf-pregather.mjs <srcDir>` stages every game in a clip folder and writes
`pregather-coverage.json`. Slow by design.

## Multi-source gather + index (optional, for picking moments)
- `gather-games.js <list.json> [--out dir] [--drive]` runs Steam + YouTube + store screenshots per item → `manifest.json`.
- `index-broll.js <folder> --game "Name"` (needs `GEMINI_API_KEY`) tags each clip: scene_type, activity, camera, intensity, setting, HUD, beats, best_ranges → `broll-index.json`.
- `match-broll.js <folder> "<keywords>" [--activity a] [--no-hud] [--json]` ranks clips for a script beat.
- `build-chart.js <folder>` builds a filterable HTML dashboard.

`list.json`:
```json
{ "slug": "game-slug", "title": "...",
  "items": [
    { "type": "steam", "name": "Game", "appid": 123, "maxShots": 8, "trailers": 1 },
    { "type": "video", "url": "https://youtube.com/watch?v=...", "note": "no-commentary", "maxMB": 300 },
    { "type": "site",  "url": "https://store.steampowered.com/app/123/", "label": "steam-store" } ] }
```

## Rules
- Never analyse gameplay from a thumbnail or title. Download it and look at frames.
- Video only for b-roll. Stills are art for the logo/poster, never the split.
- Third-party game footage is used in a review/commentary context. Keep source URLs (`manifest.json`).
