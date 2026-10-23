# Locked rules: every correction from the editor, newest first

These came from the human editor reviewing real delivered reels. Where two rules conflict, the
**newer one wins**. Each says what to do, why, and how it's enforced (code or your own check).
When you get a new correction, add it at the top in the same format.

---

### 2026-10-22: Background music must never be emotional
- Music has to suit the video's vibe. Never melancholic, sad or sentimental.
- **Safe pool:** `ken_caron_-_yale` (tense trap), `Timeless` (driving electro), `d_savage_private_jet` (groovy lo-fi), `Funny` (playful, cartoon games).
- **Avoid:** `As_It_Was`, `blue`, `gaming-mix-1` (all tagged melancholic in `music-moods.json`). `Broke_In_A_Minute` has a vocal sample, so avoid it under VO.
- **How:** the Gemini picker can still land on a sad track. Pin the track per game in the batch folder's `overrides.json`: `{"Game Name": {"music": "<filename prefix in bg-music/>"}}`.

### 2026-10-21: Face sits just under the split line
- In split beats, the top of the head sits **just below the seam** (where the caption lands). Not cut off, not floating low with a gap.
- **Why:** a fixed crop left a 190-300px gap. Then a luminance head detector latched onto a dark background object and pushed the face out of frame entirely ("the person's face doesn't even show").
- **How (code):** `web/head-scan.py` finds the first strong horizontal edge (wall to hair) in the central band, 20th percentile across frames. `ensureCamCrop()` sets `camCropY = headTop - captionHalfHeight - 24`, with a guard that the chin (+70px) stays inside the 960px face panel. Old luminance scan is the fallback; 440 if both fail.
- **Your check:** look at 3 split frames per reel. Full face visible, head top just under the caption/seam, chin well above the bottom edge. Gemini bounding boxes and skin-colour detection were tried and rejected (repeats one box for all frames; warm walls match skin).
- To re-frame an old project: set `plan.json` `camAuto=false`, then `node web/rnf-run.mjs finalize <id>`.

### 2026-10-21: Split starts early; captions never on the face
1. **Early split.** If the name drop comes after ~3.6s, don't hold the full-frame opening that long. Start the split at the first caption-line boundary between 2.3s and 3.6s (else 2.6s). The logo still lands on the name drop, over the running split. (Code: `suggestWindows`.)
2. **Captions off the face on full-frame beats** (hook + CTA): the caption layer drops until its top clears the chin (chin from head-scan + 30px air, 2-line caption = 100px half-height, centre capped at y=1430). (Code: `finalize`, `plan.faceDrop`.)

### 2026-10-21: CTA captions sit lower
- In the CTA, captions were on the speaker's face. They now drop `CTA_DROP = 110`px below chest default, from the end of the last b-roll window (or the last 22% if no split) to the end. (Code: `finalize`, `plan.ctaDrop`.)
- **Your check:** last 2-3 frames, caption must not touch the chin. If it does, raise `CTA_DROP`.

### 2026-10-21: Pick music by listening, not by filename
- Gemini can't hear a filename, so it guessed (put a sad track on a raw, hard game).
- **How (code):** `assets/sfx-pack/bg-music/music-moods.json` holds listened descriptions (mood, energy, tempo, darkness, fit) and `pickMusicForScript` passes them to Gemini. Override per reel with `meta.music`.
- Dark/tense: Broke In A Minute (115bpm), Timeless (128bpm, energetic), Yale/ken_caron (135bpm). Calm/cozy: blue, As It Was, d_savage, gaming-mix-1. Funny: playful cartoon. (The 2026-10-22 rule above removes the sad ones.)

### 2026-10-19: Tint only on sarcasm; hold the logo
1. **Black-and-white tint only on a sarcastic line.** Not on every dramatic beat, not as a default flourish. No sarcastic line = no tint. Tell the human which line got it.
   - Code: tint comes only from Gemini's `tintBeat` (the old keyword fallback `ensureTintBeat` is disabled). Override in `meta.json`/`overrides.json`: `noTint: true`, `tintTime: [startSec, endSec]` (preferred, robust to word-index drift), or `tintBeat: [i, j]`.
   - Examples that qualified: "meri kismat acchi hai main cheat nahi kar raha" (ironic); the deadpan "firing ho rahi hai to kya hua" (judgment call, flagged).
2. **Game logo on screen ~3s** at the name drop so viewers can read it. Official logo (Steam `logo.png` / `header.jpg`), not a random screenshot. Poster picker prefers `*logo*` then `*header*`.

### 2026-09-29: B-roll cuts with the narration; music after the riser
1. **B-roll cuts every ~2.6-4s at caption-line boundaries**, each segment from a **different motion-scanned zone** of the gameplay clip, so it never jumps backwards.
2. **Music starts at the name drop, after the riser.** The hook runs on VO + riser only.
3. **Music suits the script** (Gemini pick, see above). Not random rotation.
4. To add the logo to an approved reel without re-rendering: `node web/rnf-run.mjs poster <id>`.

### 2026-09-27: v3 look
- B-roll = **real video only, never stills**. Prefer YouTube gameplay over Steam trailers (trailers cut to static title cards and fade to black).
- Split = **true 50/50 centre split**: gameplay fills the top 960px, the face is cropped into the bottom 960px. (Supersedes the 40/60 overlay-hug from the first reels.)
- Clip inputs use `-stream_loop -1` so a short clip loops instead of freezing.
- **Watch the b-roll move before delivering.** A PTS bug once froze the last ~2s of every split window in every reel. The HyperFrames path checks this automatically (`hf/finish.mjs`: render vs source motion per window). The old engine's `rnf-check.mjs` does not, so look yourself there.
- Music must be audible: `audibleMusicStart()` skips silent gaps in long mixes.

### 2026-09-26: Caption look
- Luckiest Guy, ALL CAPS, white, keyword yellow `#F2CE1F`, **no outline** (`outline.width: 0` + `effect: 'hard-shadow'`, `shadow: 0`).
- **Line-by-line, semantic chunks** of ~2-4 words that pop in as a whole line (`animScope: 'line'`, `entrance: 'pop'`, `manualBreaks: true`, `w.br` on each line's first word). Not word-by-word, not karaoke (`highlightMode: 'none'` = only `w.hi` words go yellow).
- **Game name alone on its own line** ("ye hai" | "BR1 INFINITE"). Hide stutters/repeats with `w.on = false`.
- Position: on the split seam during b-roll, chest height on full-frame beats. One caption layer, shifted per segment with a time-gated `overlay y`.
- Poster/logo = the game's original art, **no border or card** around it.

### 2026-09-26: Structure
- RNF is **talking head + b-roll split-screen**, not a floating PIP and not gameplay with a voiceover.
- Hook and CTA are full-frame face. Game-explanation beats are split.
- Never b-roll over head-high shots or the CTA.
- Audio is the supplied pack (riser, cash register, music). **Never generate music or SFX.**
