# rest.not.found (rnf) — Reel Editing Style Spec

The reverse-engineered edit recipe for rnf reels, learned from 3 real shipped reels
(DdqYRUbStHX 36.8s listicle, Dds7HHUByQb 26.9s single-game, Ddlqf3rPZUP 22.8s single-game),
each torn down frame-by-frame and adversarially verified. **This document is the blueprint
the auto-editor implements.** Learned 2026-09-26 by Manish.

> Note: sections 1-10 are the ORIGINAL teardown (2026-09-26). Later corrections in `locked-rules.md` override it: 50/50 split (not 40/60), no caption outline, line-by-line chunks, B&W tint only on sarcasm, logo ~3s.

---

## 0. The one architectural fact
rnf is **talking-head + b-roll**, NOT gameplay-with-a-voiceover. A real presenter (the creator) is the
**spine** of every reel. Gameplay is layered ON TOP of him. The three-act
skeleton is identical across all 3 reels:

1. **COLD-OPEN HOOK** — full-frame, an *acted / physical stunt* with a real prop
   (lights a phone on fire; smashes a monitor with a stick; slumps sad then smiles).
   2 to 7s. This is filmed by the creator and comes IN the raw cut.
2. **SPLIT-SCREEN BODY** — gameplay in the **top ~40%**, the talking head in the **bottom ~60%**,
   divided by a hard horizontal seam. This is where the games are explained.
3. **FULL-FRAME CTA** — back to the face (split removed), final ~2-3s, "comment <keyword>".

> **PLAN CORRECTION (important):** our approved Phase-2 plan assumed b-roll as a *floating PIP
> window over the talking head*. That is WRONG for rnf. The real move is a **top/bottom
> SPLIT-SCREEN** (gameplay top, face bottom), applied ONLY to the game-explanation segments.
> The auto-editor is segment-aware: hook and CTA stay full-frame, the body is split.

---

## 1. What the auto-editor receives vs. makes vs. gathers

| Layer | Where it comes from |
|---|---|
| Presenter footage (cold-open stunt + talking-head VO) | **RAW CUT** — Manish supplies the recorded video |
| Cut/trim to flow (kill retakes, dead air, tighten) | **GENERATED** — auto-editor |
| Gameplay b-roll (top split panel) | **GATHERED** — Phase-1 `rnf-footage` lane (YouTube gameplay / Steam trailer) |
| Game key-art / posters (reveal cards) | **GATHERED** — `rnf-footage` (Steam art, app icon) |
| Celebrity / product cutout cards (CR7, phone) | **GATHERED** — image fetch |
| Captions (Luckiest Guy, white+yellow) | **GENERATED** — caption-studio |
| Split-screen composite, reveal cards, mosaic tease, keyword-yellow | **GENERATED** — auto-editor overlays |
| SFX + music | **SUPPLIED** — Manish's Drive folder |
| Which game(s) / approval | **HUMAN INPUT** |

---

## 2. Caption system (the signature) — caption-studio

- **Font: Luckiest Guy** (Manish's locked choice; heavy all-caps display, matches the chunky
  rounded look of the reference reels). Available + render-wired in caption-studio.
- **Case:** ALL CAPS, always.
- **Fill/stroke:** WHITE fill, thick uniform BLACK outline + soft drop shadow (reads on any bg).
- **Keyword highlight:** the ONE power word per chunk flips to bright **YELLOW `#F2CE1F`**
  (range `#F2CE1F`–`#F5D21E`). Color swap only, **no box** behind the word.
- **Chunking:** ~**2-3 words per screen**, 1-2 lines, swapped roughly **once per second**,
  phrase/word-timed to the VO (CapCut/Submagic "pop" cadence). Size ~8-11% of frame height/line.
- **Hook line:** the cold-open caption is a **designed punch line** (often an English paraphrase
  of the Hinglish VO, e.g. on-screen "THIS GAME FEELS LIKE THERAPY" while the VO says
  "yeh game tumhara depression theek kar dega"). Usually the WHOLE hook line is yellow and larger.
  This is a SEPARATE input from the auto-captions — the editor needs a "hook line" field.
- **Body captions** track the VO literally (romanized Hinglish).
- **Position:** on/just below the **split seam** (~40% down) during the split body; **lower-center**
  during the full-frame hook and CTA.
- **Emoji:** sparse to none. At most one tiny sticker. Do not litter emojis.
- **No em-dashes** in any on-screen copy (house law) — commas/periods only.

## 3. Split-screen b-roll (the core composite)
- **Layout:** gameplay letterboxed into the **top ~38-40%**; presenter (from the raw cut, scaled
  to fit) in the **bottom ~60%**; a hard straight seam between. No PIP, no phone-frame.
- **Applied only** to game-explanation segments (detected from the VO/transcript). Hook + CTA
  are full-frame face.
- **Gameplay swaps** to a fresh clip every ~1-2s (keeps freshness) while the face runs
  continuously underneath. **Hard cuts only** — no wipes/zooms between clips.
- **Pre-reveal mosaic tease (signature):** before the first game name lands, the gameplay window
  can be shown **pixel-mosaic censored** ("wait for it") for a beat, then snap clean on the reveal.

## 4. Game-name reveal + cards (light graphic layer)
- **Name reveal:** the game name appears as a **yellow caption word** synced to the VO reveal,
  PLUS (usually) an **official key-art / app-icon CARD** that drops into the top panel at that
  moment (Sky app icon, eFootball Messi key art, Data Wing poster, Super Cat title card).
- **Cutout cards:** rectangular image cards with soft edges, dropped straight onto frame:
  product cutout (e.g. Realme phone), **celebrity portrait card at the CTA** (CR7 Ronaldo pops in
  under the yellow "CR7" keyword). Understated, no heavy meme framing.
- **Listicle counting:** carried by the VO ("Number one/two/three") + the caption word.
  **No numbered "01/02/03" badge graphic.**
- No arrows, circles, or zoom-highlight callouts. Emphasis = the yellow caption word only.

## 5. CTA
- **Comment-to-DM keyword** ("peace", "CR7"). Full-frame talking head, final ~2-3s.
- Keyword shown in **yellow caption**, often with a **portrait/graphic card** popping under it.
- Spoken + caption, **no dedicated designed end-card**. (A pure listicle may end on a value tease
  with no CTA — keep the CTA only if the raw VO has one.)

## 6. Sound design
- **VO** (recorded on the creator's condenser mic) is the dominant layer and drives the cut.
- **Music bed:** low, under the VO. **SFX:** light — on the stunt impact, on card pops, on
  gameplay cuts. Use **Manish's supplied SFX + music folder**; do not generate audio.
- (Note: the reference reels' exact SFX/music could not be measured — our waveform export
  rendered blank. Fix the extraction next time with `ffmpeg astats`/a proper `showwavespic`
  scale. Non-blocking since audio is supplied.)

## 7. Pacing + color
- **Pacing:** few hard section cuts (3-5), but ~1s caption swaps + ~1-2s gameplay-window swaps
  make it *feel* fast. Minimal/no punch-in zooms. Energy: high spike at the stunt open, steady
  honest explainer through the body, mild lift at the CTA.
- **Color:** understated, honest, budget-authentic. Desaturated presenter side, saturated
  gameplay pops, max-contrast white+yellow captions. Not neon, not glossy.

---

## 8. Beat template (what the auto-editor lays down)
```
[0]  COLD-OPEN HOOK  (full-frame, from raw cut)     -> big YELLOW hook line (designed punch)
[1]  (optional) pre-reveal MOSAIC tease on gameplay
[2]  per game:  hard cut -> SPLIT (gameplay top / face bottom)
                 -> NAME REVEAL (yellow word + key-art card)
                 -> VO breakdown w/ word-timed WHITE captions + YELLOW keywords
     (listicle: repeat [2] per game, count via VO + caption word)
[3]  CTA  (full-frame face) -> keyword in YELLOW + portrait/graphic card -> "comment X for the link"
```

## 9. PRODUCTION CHECKLIST (auto-editor self-check)
1. Hook is full-frame with the designed yellow hook line (not an auto-caption).
2. Game-explanation segments are SPLIT-SCREEN (gameplay top ~40% / face bottom ~60%), hook & CTA full-frame.
3. Captions: Luckiest Guy, ALL-CAPS, white + black outline, one YELLOW keyword per chunk, ~2-3 words, word-timed.
4. Each game gets a name-reveal (yellow word + key-art card); listicle count via VO.
5. Gameplay top-window swaps every ~1-2s; hard cuts only.
6. CTA keyword in yellow (+ portrait card if a person is named); full-frame.
7. Music bed (low) + SFX from Manish's folder; VO stays dominant. No em-dashes on screen.
8. Clip is cut so it flows (no retakes/dead air); final is 1080x1920.

## 10. CRITICAL FLAGS vs. the approved Phase-2 plan
- **PIP -> SPLIT-SCREEN.** Biggest change. Build a segment-aware top/bottom split, not a floating PIP.
- **Segment detection required.** Split applies only to game-explanation beats; hook + CTA stay full-frame — the editor must find those segments from the VO transcript.
- **New rnf-specific graphics** to build (beyond the neutral set): the game-name reveal card, the mosaic-tease, the celebrity/product cutout card, the yellow-keyword CTA. 
- **Hook line is a separate input** (a designed, often-English punch line), distinct from the VO auto-captions.
- **Caption font = Luckiest Guy** (Manish's call), keeping white + yellow-keyword + black outline.
- **Audio is supplied, not generated;** fix the blank-waveform extraction for future style analysis.
