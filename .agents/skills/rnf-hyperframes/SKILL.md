---
name: rnf-hyperframes
description: Edit a rest.not.found (RNF) gaming reel with HyperFrames on Windows, macOS or Linux, with no custom caption engine. Clean-cut 9:16 talking-head video (filename = game name) → real gameplay b-roll + logo → head-aware 50/50 split, logo reveal, music + riser + SFX, sarcasm-only B&W tint, Luckiest Guy line-by-line Hinglish captions → HyperFrames render → -14 LUFS → QC gate. Use for any RNF edit on a laptop: "edit this RNF reel", "make the <game> reel", "re-render <game>", "fix <complaint> on <game>".
---

# rnf-hyperframes: the runbook (default path on laptops)

Scripts live in `hf/`, all plain Node + ffmpeg (no Python, no Electron, no bash). Commands work the
same in PowerShell, cmd, macOS and Linux terminals. Rules that override this file: `docs/locked-rules.md`.

Split of work:
- **Scripts:** everything mechanical (media normalizing, head framing, split windows, clip zones, caption positions, audio timing, render, loudness, QC).
- **You:** everything that needs judgment, written into `plan.json`: romanized words, line breaks, yellow keywords, game-name span, which line is sarcastic, music choice. Plus checking the gameplay and looking at the QC frames.

## 0. Setup (once per machine)
Windows (PowerShell):
```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg yt-dlp.yt-dlp
# open a NEW terminal so PATH updates, then in the repo folder:
copy config\rnf.env.example .env      # add GROQ_API_KEY (free, console.groq.com)
node hf\doctor.mjs --yt
```
macOS: `brew install node ffmpeg yt-dlp`. Linux: your package manager + `pip install -U yt-dlp`.
- Put the licensed music in `assets\sfx-pack\bg-music\` (names in that folder's README).
- `.env` is read by the scripts automatically. Never print it, never commit it.
- `doctor.mjs --yt` must show no FAIL lines before you edit. It names the fix for each one.
- HyperFrames runs through `npx` and downloads itself on first use. Pin a version with `HF_VERSION=0.8.186` in `.env` if you need reproducible renders.
- Use a short, plain repo path (e.g. `C:\rnf`). Spaces work, but short paths avoid trouble with other tools.

## 1. Gameplay + logo first (decides quality; never skip)
Assets live in `assets\game-assets\<slug>\` (`<slug>` = lowercase-hyphenated name, e.g. `who-s-cheating`):
```
gameplay\*.mp4           real moving gameplay (REQUIRED, an RNF reel is never full-frame)
broll\posters\*logo*     official logo (else *header*), shown 3s at the name drop
```
Get them, best source first:
1. **The human's own gameplay clips**: copy into `gameplay\`.
2. **YouTube:** `node hf\get-gameplay.mjs "Who's Cheating" --n 2`
   - It only accepts results whose **title names the game** (YouTube's top hit is often a different game). It tries 4 queries, then gives up with a message. Override with `--url <link>` or `--query "..."`.
   - It writes a contact sheet next to each clip (`yt-<id>.sheet.jpg`). **Open it**: right game, real gameplay, no facecam, no end card. Move bad ones to `archive\`.
   - Cookies are optional. On a home connection it usually works without them. If it reports a bot-check: export cookies from a private browser window into `.secrets\yt-cookies.txt`, or try `--browser firefox`. Chrome/Edge cookie reading often fails on Windows.
3. **Steam trailer + logo:** `node footage\rnf-footage\steam-extract.js "Game" --resolve-only` to confirm the appid is the right game. Then `node footage\rnf-footage\steam-extract.js "Game" assets\game-assets\<slug>\broll --appid <id>`, and move the trailer mp4 into `gameplay\`.
No usable gameplay anywhere → **stop and ask the human** for clips or cookies.

## 2. Prep
```powershell
node hf\prep.mjs "D:\clips\Who's Cheating.mp4"
```
This creates `reels\<slug>\` with `assets\` (source normalized to 1080x1920 30fps with 1s keyframes,
gameplay cover-cropped to 1080x960, logo, font, SFX), head framing (`head`, `camCropY`), the raw
transcript and `plan.json`. Transcription is Groq whisper-large-v3 (Hindi) when `GROQ_API_KEY` is set,
otherwise `hyperframes transcribe --engine whisper --model large-v3 --language hi` (needs whisper.cpp
on the machine). `--transcript words.json` imports any `[{text,start,end}]` list.
- Exit code 2 = BLOCKERS printed. Fix them and re-run (an existing `plan.json` is kept).
- The filename is the game name. Drive's `Game- Sub` is restored to `Game: Sub`. Override with `--game "Exact Name"`.

## 3. Complete plan.json (your judgment)
Follow its `_todo`, then delete `_todo`:
- **words[].text**: romanized Hinglish, English words stay English ("paisa", "virtual", "casino"). Fix misheard words using context. Spell the game name exactly. Keep `start`/`end` untouched. Keep the word count. If two transcript words are really one, keep both entries (put the text on one, `on:false` on the other).
- **words[].br = true** on the first word of each caption line. 2-4 words, grouped by meaning ("jahan par tumhara" | "har ek kill" | "matter karta hai"). **Game name alone on its own line** ("naam hai" | "WHO'S CHEATING").
- **words[].hi = true** on at most ONE punch word per line (it turns yellow). The game name words are always hi.
- **words[].on = false** hides stutters and repeated words.
- **nameSpan**: `[first, last]` word index of the spoken game name. The logo, riser, cash SFX and music all key off it.
- **tint**: `[startSec, endSec]` of the ONE sarcastic/ironic line (deadpan contradiction, e.g. "bhai sach mein meri kismat bahut acchi hai, main cheat nahi kar raha"). Not hype, not drama. None → `null`. Tell the human which line you chose.
- **music**: a file (or unique prefix) from `musicChoices`. Safe pool: ken_caron (tense), Timeless (driving), d_savage (groovy/flex), Funny (cartoon/silly). **Never** As_It_Was, blue, gaming-mix-1. Avoid Broke_In_A_Minute (vocals).
- **windows**: leave `"auto"`. Override only to fix a complaint: `[{start, end, clip?, clipIn?}]`.

## 4. Build → check → look
```powershell
node hf\build.mjs reels\who-s-cheating
cd reels\who-s-cheating
npx hyperframes lint                     # must be 0 errors
npx hyperframes check                    # 0 errors; "line_unread" warnings are EXPECTED (RNF lines swap with speech ~1s). Don't lengthen lines to silence them.
npx hyperframes snapshot --at 1.2,4.6,9.3,25.6,30.4   # pick: hook, a split, name drop+1s, tint, last second
npx hyperframes preview                  # optional: Studio, the human can scrub/edit
```
Open the snapshot contact sheet before rendering. Fix framing/caption problems now (cheap), not after.

What build.mjs lays down (in `index.html`, readable and editable):
- `#aroll`: the source, full-frame, carries the VO.
- Split windows: `.gp` gameplay video in the top 1080x960, plus `.face` video of the same source in `#face-panel` (bottom 960, shifted up by `camCropY`, `data-media-start` = window start so it stays in sync). Windows start at the name drop, or early (2.3-3.6s) if the name comes late. They end before the CTA (last ~22%) and cut every 2.6-4s at line boundaries, each cut from a different moving zone of the clip.
- `#logo-img`: centred in the top panel, slides/fades in at the name drop, held 3s.
- Captions: one `.cap` per line. Centre at the seam (y 960) in split windows, chest (1199) pushed below the chin on full-frame beats, ≥110px lower in the CTA. Pop-in 0.18s, hard kill at line end.
- Tint: `filter: grayscale(1)` on the face layers between `tint[0]` and `tint[1]`.
- Audio: music from the name drop at 0.16 with fade in/out (volume lane), riser ending on the name drop, cash register on it.

## 5. Render + QC
```powershell
node hf\finish.mjs reels\who-s-cheating            # --quality draft for a fast test; --workers 2 on weak laptops
```
It runs lint, `hyperframes render --gpu`, a loudness pass (-14 LUFS, -1.5 dBTP), and the QC gate
(1080x1920, duration, loudness, and per split window: no render freeze where the source moves, b-roll
not static). It then extracts frames to `qc-frames\`. Exit 0 = PASS, 3 = FAIL (`qc-fail.json` says why).
A 30s reel takes a few minutes on a laptop. Keep the terminal open, or start it in a separate window.

## 6. Definition of done (all, every reel)
- [ ] `finish.mjs` QC PASS. Read any "brief still moment" notes and look at that window.
- [ ] `qc-frames\01-hook`, `02-hook`: caption below the chin, never on the face.
- [ ] `04/05/06-split`: right game, real gameplay, full face visible, top of head just under the seam/caption, chin inside the panel.
- [ ] `03-logo`: logo readable. Game name alone on a yellow line, spelled right.
- [ ] `07-tint` (if any): B&W on the sarcastic line only.
- [ ] `08-cta`, `09-cta-last`: caption below the chin.
- [ ] Music fits the mood, not sad, audible under the VO. No em-dashes in captions (build refuses them).
Look at the images. A passing script is not the same as a good reel.

## 7. Fixing a complaint
| Complaint | Do |
|---|---|
| Face cut / too low / gap under the seam | set `camCropY` in plan.json (smaller = face moves down), build, snapshot, finish |
| Caption on the face | check `head.chin` in plan.json is right (it drives the drop). Raise `CTA_DROP` in hf/lib.mjs only if the CTA rule itself needs to change |
| Wrong game / static / bad gameplay | replace the clip in game-assets, re-run prep (plan kept), build, finish |
| B-roll starts too late / covers the hook | set `windows` explicitly in plan.json |
| Wrong or sad music | change `music`, build, finish |
| Tint on the wrong line | change `tint`, build, finish |
| Logo missing / wrong | put the right `*logo*` image in `broll\posters\`, re-run prep, build, finish |
Every correction from the human goes into `docs/locked-rules.md` the same day.

## 8. Batch
Run steps 1-2 for every clip, complete every plan.json, then `build` + `finish` one reel at a
time (renders compete for CPU/RAM). Report per reel: path/link, music, tint line (or "no tint"),
b-roll source, judgment calls.
