---
name: rnf-auto-editor
description: Edit a rest.not.found (RNF) gaming reel end to end from a clean-cut 9:16 talking-head video whose filename is the game name. Gathers real gameplay b-roll + the official logo, builds the head-aware 50/50 split, adds music + riser + SFX, sarcasm-only B&W tint, and Luckiest Guy line-by-line Hinglish captions, then QC-gates and delivers. Use for "edit this RNF reel", "run the RNF batch", "re-render <game>", "fix the music/framing/captions on <game>".
---

# rnf-auto-editor: the runbook (original engine, Linux server)

> On a Windows/macOS laptop use `.agents/skills/rnf-hyperframes/SKILL.md` instead. This engine needs Electron + xvfb + bash.

Paths are relative to the repo root. `app/web/` holds the engine. Rules that override this file:
`docs/locked-rules.md`.

## 0. One-time setup (skip if done)
```bash
cd app && npm install && cd ..                 # electron + transformers.js (whisper) + sanscript
pip install numpy pillow                       # head-scan.py, motion-scan.py
cp config/rnf.env.example .env && $EDITOR .env # GEMINI_API_KEY at minimum
mkdir -p .secrets                              # yt-cookies*.txt go here (gitignored)
```
Needs on PATH: `ffmpeg` + `ffprobe` (with libass), `xvfb-run`, `yt-dlp` (nightly is best),
optionally `rclone`. Music tracks are **not** in the repo (licensed). Put them in
`assets/sfx-pack/bg-music/` (filenames in `assets/sfx-pack/bg-music/README.md`).

Start the caption server. Everything calls it, so it must be up before any prepare:
```bash
set -a; . ./.env; set +a
node app/web/server.mjs            # :3016  (PORT env to change). Leave it running.
curl -s localhost:3016/api/settings   # {"hasGemini":...}
```
First transcription downloads the Whisper model (~100-250 MB) once.

## 1. Intake
- Input = **clean-cut** 1080x1920 talking head. The filename is the game name, spelled exactly how it should appear on screen. Use ASCII (`Mayhem a la Carte`, not `À`). Drive turns `:` into `- `. The batch converts `Game- Subtitle` back to `Game: Subtitle`.
- **4K source (2160x3840)? Downscale first** or the caption export times out:
  `ffmpeg -nostdin -i in.mp4 -vf scale=1080:1920 -c:v libx264 -crf 18 -c:a copy out.mp4`
- RAW multi-take video instead of a clean cut? See section 9 first.

## 2. Get b-roll and logo BEFORE rendering (the step that decides quality)
The engine reads staged assets from `assets/game-assets/<slug>/`:
```
<slug>/gameplay/*.mp4          real moving gameplay, the split b-roll (REQUIRED for a split)
<slug>/broll/posters/*logo*    official logo, else *header*, the 3s name-drop overlay
<slug>/broll/screenshots/*.jpg art only, never used as b-roll
```
`<slug>` = lowercase-hyphenated game name (`who-s-cheating`, `arknights-endfield`). The first-word
slug (`arknights`) also matches.

Sources, best first (details in `docs/footage.md`):
1. **The human's own gameplay clips.** Copy them into `gameplay/`.
2. **YouTube gameplay** (needs fresh cookies in `.secrets/yt-cookies*.txt`):
   `node app/web/rnf-yt-gameplay.mjs "Game Name"`. It takes the first search result, which is **often the wrong game**. Check it.
3. **Steam trailer + logo:** `node footage/rnf-footage/steam-extract.js "Game Name" --resolve-only`, confirm the appid is the right game, then
   `node footage/rnf-footage/steam-extract.js "Game Name" assets/game-assets/<slug>/broll --appid <id>`, and move the trailer mp4 into `<slug>/gameplay/`.
   Batch version: `node app/web/rnf-pregather.mjs <srcDir>` (slow on purpose, Steam rate-limits hard).
4. Official site `<video>` URLs (headless Chrome), when nothing above exists.

**Verify every staged clip** before rendering. Make a contact sheet and look at it:
`ffmpeg -nostdin -i clip.mp4 -vf "fps=1/5,scale=320:-1,tile=4x2" -frames:v 1 sheet.jpg`
It must be the right game, real gameplay (not a title card or live-action trailer), and without a
burned-in "WISHLIST ON STEAM" end card or long fades to black. **No usable gameplay → stop and ask
the human** for cookies or clips. Never ship full-frame.

## 3. Per-reel overrides (optional, decide them before prepare)
Batch: `<srcDir>/overrides.json`. Single: the project's `meta.json`.
```json
{ "Who's Cheating": { "music": "ken_caron", "tintTime": [24.7, 27.3] },
  "Kidnapped Simulator": { "music": "Timeless", "noTint": true } }
```
- `music`: filename prefix in `bg-music/`. **Pin it every time** from the safe pool in `docs/locked-rules.md`, matched to the game's mood.
- Tint: read the transcript. Only a **sarcastic** line gets `tintTime: [start, end]`. None → `noTint: true`.

## 4. Run
**Batch (normal path):** put the clean cuts in one folder, then:
```bash
setsid nohup node app/web/rnf-batch.mjs /path/to/srcDir 1 > /path/to/srcDir/batch-run.log 2>&1 < /dev/null &
```
Concurrency 1-2. The caption server serialises transcribe/export anyway. Progress is in
`batch-progress.json` and `batch-log.txt`. Re-running is resume-safe: delivered reels are skipped,
and QC-held reels (`qc-fail.json` present) are re-done automatically.

**Single reel / re-render:** a project = `app/web/work/rnf/<id>/` with `source.mp4` + `meta.json`
`{"id","game","gameName","source":"source.mp4", ...overrides}`. Then:
```bash
node app/web/rnf-run.mjs prepare  <id>   # transcribe → plan → gather → captions.mov → base_nocap.mp4 (~2.5 min)
node app/web/rnf-run.mjs finalize <id>   # Pass B: splits + logo + captions → final.mp4 → QC → deliver (~1 min)
node app/web/rnf-run.mjs poster   <id>   # add the logo to an existing final.mp4 only
```
- Changed **b-roll, framing, logo or music placement only** → `finalize` (reuses base + captions).
- Changed **captions, tint, music track or plan** → `prepare` + `finalize`.
- **Always detach long renders** (`setsid nohup … &`) and poll `status.json`. Foreground shells get killed at session teardown.
- Web UI alternative: `http://localhost:3016/rnf-automation` (upload, drag b-roll windows, render).

## 5. What the engine does (so you know what to inspect)
1. Transcribe a 540p proxy via `/api/transcribe` (`hinglish-ai`, Gemini + CTC alignment) → word timings.
2. `geminiPlan`: semantic caption line breaks, yellow keywords, `gameNameSpan`, `tintBeat`, `hideWords`. Heuristic fallback if Gemini fails. `correctGameName` rewrites the misheard name to the filename spelling on its own line.
3. `suggestWindows`: split windows from the early-split point to before the CTA (last ~22%), cut into 2.6-4s segments at caption-line boundaries. Each gets a different motion-scanned zone (`motion-scan.py`), avoiding dark zones.
4. `renderCaptionAlpha`: `/api/exportAlpha` → `captions.mov` (ProRes 4444 alpha, full-res).
5. `renderBase` (Pass A): source 1080x1920 + B&W tint beat + audio (VO + riser ending on the name drop + cash register on the reveal + music from the name drop at 0.16 with fades → `amix → alimiter → loudnorm I=-14`) → `base_nocap.mp4`.
6. `finalize` (Pass B): `head-scan.py` → face crop. Per window, `vstack` gameplay top 960 + face bottom 960. Logo overlay ~3s at the name drop, on top of the split. Captions with time-gated y (seam during splits, chest on full-frame, lower on CTA/face beats). → `final.mp4` → `rnf-check.mjs` QC → rclone (if `RNF_DRIVE_DEST` set).

## 6. Definition of done (all of these, every reel)
- [ ] QC passed (`node app/web/rnf-check.mjs app/web/work/rnf/<id>`): 1080x1920, 8-45s, ~-14 LUFS, captions present, b-roll placed. It does NOT measure motion: check that yourself (sample ~8 top-half frames per window, they must change).
- [ ] **Hook frames (0-3s):** captions clear of the face.
- [ ] **3 split frames:** right game, real moving gameplay, full face visible, head top just under the seam, chin inside the panel.
- [ ] **Name drop:** logo readable for ~3s; game name alone on a yellow line, spelled right.
- [ ] **Last 2-3 CTA frames:** caption below the chin.
- [ ] Tint only on the sarcastic line (or none). Music matches the mood and isn't sad. Audible.
- [ ] No em-dashes in caption text (`grep -c '—'` on the plan/caption words = 0).
Extract frames: `ffmpeg -nostdin -ss <t> -i final.mp4 -frames:v 1 f.jpg`, then **look at them**.

## 7. Report back to the human
Per reel: the link (Drive link in a code span, since IDs ending in `_` break in markdown), music
track, which line got tint (or "no tint, no sarcastic line"), b-roll source, and anything you
judged or couldn't fix. The human has no terminal. Give links, not local paths or commands.

## 8. Fixing a complaint
| Complaint | Fix |
|---|---|
| Face cut / too low / gap under seam | Check `plan.json` `headTop`/`camCropY`. Set `camAuto:false` (or a manual `camCropY`), then `finalize`. |
| Captions on the face | `faceDrop`/`CTA_DROP` in `finalize` (rnf-auto.mjs). Raise, then `finalize`. |
| Wrong/sad music | `meta.music` = safe-pool track → `prepare` + `finalize`. |
| B-roll wrong game / static / freezes | Replace `gameplay/` clip, delete project `library.json` + `placements.json` (move to archive), `prepare` + `finalize`. |
| Logo missing / too short | Put `*logo*` png in `broll/posters/`, then `poster <id>` or `finalize`. |
| Tint on the wrong line | `tintTime` or `noTint` in meta → `prepare` + `finalize`. |

## 9. RAW (uncut, multi-take) input
Transcribe the raw (proxy is fine, timeline matches). Each line is said 2-3 times; keep each
idea's **last clean, complete take** → clean script + keep-list of time spans → `ffmpeg` trim +
concat off a 1080x1920 downscale. iPhone .MOV is 4K with a rotation flag: just `scale=1080:1920`.
Show the rough cut to the human before editing it.
