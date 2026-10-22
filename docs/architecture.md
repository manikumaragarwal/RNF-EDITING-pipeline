# Architecture

## Pieces
| Path | Role |
|---|---|
| `app/web/server.mjs` | HTTP server (:3016). Caption Studio API (upload, transcribe, exportAlpha, settings) + RNF routes + the RNF web UI. Heavy jobs serialised (`CAP_CONCURRENCY`, default 1). |
| `app/engine/` | Caption engine: whisper worker (transformers.js/ONNX), Gemini Hinglish reconcile, CTC forced alignment, segmentation (`segment.mjs`), caption DOM renderer, fonts. |
| `app/web/render-worker.cjs` | Electron offscreen renderer (run under `xvfb-run`) that draws the caption layer frame by frame → ProRes 4444 alpha. |
| `app/web/rnf-auto.mjs` | **The RNF orchestrator**: `prepare`, `finalize`, `addPosterToFinal`, `addUpload`. All edit logic lives here. |
| `app/web/rnf-run.mjs` | Detached CLI wrapper: `prepare|finalize|poster <id>`. |
| `app/web/rnf-batch.mjs` | Folder of clips → prepare + finalize each, resume-safe, QC-aware. |
| `app/web/rnf-check.mjs` | QC gate (format law). Fail → `qc-fail.json`, reel held, never delivered. |
| `app/web/rnf-pregather.mjs` | Batch Steam gather into `assets/game-assets/<slug>/` (polite, decoupled from render). |
| `app/web/rnf-yt-gameplay.mjs` | YouTube gameplay grabber (cookie rotation), stages `gameplay/yt-1.mp4`. |
| `app/web/head-scan.py` | Head-top + chin detector (horizontal edge, wall → hair). Drives the face crop. |
| `app/web/motion-scan.py` | Finds a continuously moving window in a clip (optionally within a zone). |
| `app/web/rnf-paths.mjs` | All machine paths, env-overridable. |
| `app/renderer/rnf-automation.html` | Web UI: project gallery, b-roll timeline editor, render + status polling. |
| `footage/rnf-footage/` | Steam extractor, multi-source gatherer, Gemini b-roll indexer, matcher, chart. |
| `footage/footage-gather/` | Shared helpers (yt-dlp wrapper, headless Chrome screenshot, util, Drive push). |
| `assets/sfx-pack/` | Riser, cash register, mouse clicks. `bg-music/` = licensed tracks you supply + `music-moods.json`. |

## Two-pass render
The b-roll choice sits between the passes, so it can change without re-transcribing.

```
source.mp4 ──► transcribe (proxy) ──► geminiPlan ──► correctGameName ──► suggestWindows
                                                                         │
             gatherBroll ──► library.json + poster.png                    ▼
                                                                  placements.json
renderCaptionAlpha ──► captions.mov  (ProRes4444, alpha, 1080x1920)
renderBase (Pass A) ──► base_nocap.mp4 (source + B&W beat + mixed audio, NO b-roll/logo/captions)
preview.mp4 (480w proxy: base + logo + captions at chest)
                 ── human or agent may edit placements here ──
finalize (Pass B): head-scan → camCropY; per window vstack(gameplay 1080x960, face crop 1080x960)
                   enable=between(t,start,end); logo overlay; captions overlay with time-gated y
                   → final.mp4 → rnf-check → rclone copyto + link (optional)
```

Gameplay PTS is offset to the window start (`setpts=PTS-STARTPTS+start/TB`) and inputs use
`-stream_loop -1`. Without both, the last seconds of each window freeze.

## Project folder `app/web/work/rnf/<id>/`
| File | What |
|---|---|
| `source.mp4`, `meta.json` | Input + per-reel settings (`game`, `gameName`, `music`, `noTint`, `tintTime`, `tintBeat`, `poster`). |
| `status.json` | `{stage, pct, msg, done, error, driveLink}`. Poll this. |
| `plan.json` | Planner output + framing: `lineBreaks`, `keywords`, `gameNameSpan`, `tintBeat`, `hideWords`, `posterIn/Out`, `headTop`, `headChin`, `camCropY`, `camAuto`, `capCenter`, `seamShift`, `faceDrop`, `ctaDrop`. |
| `library.json` | B-roll clips (`broll/clips/*`, thumbs `broll/thumbs/*`). Paths relative to `broll/`. |
| `placements.json` | `[{start, end, clip, clipIn}]` split windows. |
| `captions.mov`, `base_nocap.mp4`, `preview.mp4`, `final.mp4` | Render artefacts. |
| `qc.json` / `qc-fail.json`, `deliver.json` | QC verdict, delivery record. |

## Caption server API used by the pipeline
- `POST /api/settings {geminiKey}` (key never echoed back).
- `POST /api/upload` (raw body, header `x-filename`) → `{id}`.
- `POST /api/transcribe {id, language:'hinglish-ai', script:'roman'}` → `{ok, project:{words:[{text,start,end,hi,br,on}], duration}}`.
- `POST /api/exportAlpha {project}` → ProRes 4444 alpha `.mov` at the uploaded video's size (upload full-res for this, or captions render tiny).
- Caption style the RNF path sets: `font:'Luckiest Guy', case:'upper', primary:'#FFFFFF', accent:'#F2CE1F', highlightMode:'none', outline:{width:0}, effect:'hard-shadow', shadow:0, animScope:'line', entrance:'pop', manualBreaks:true`.

## RNF routes (web UI)
`GET /rnf-automation`, `GET /rnf-media/<id>/<file>` (range), `POST /api/rnf/project|source|prepare|broll-upload|placements|render`,
`GET /api/rnf/status?id=`, `GET /api/rnf/project?id=`, `GET /api/rnf/projects`. Render/prepare spawn
`rnf-run.mjs` detached. The UI polls status every 2s. There's no auth in the server. Put it behind a
reverse proxy with auth if you expose it.
