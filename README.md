# RNF-EDITING-pipeline

Automated editor for **rest.not.found** gaming reels. Input: a clean-cut 9:16 talking-head video
named after the game. Output: a finished 1080x1920 reel with a head-aware gameplay split-screen,
an animated game logo, music + riser + SFX, sarcasm-only black-and-white tint, and Luckiest Guy
Hinglish captions, gated by an automatic QC check.

**AI agents (Codex etc.): start at [`AGENTS.md`](AGENTS.md).** Everything you need is linked from there.

Two ways to run it:
- **Laptop (Windows / macOS / Linux): HyperFrames path, `hf/`.** Node + ffmpeg + yt-dlp, nothing else to build. Runbook: `.agents/skills/rnf-hyperframes/SKILL.md`.
- **Linux server: original engine, `app/`.** Caption Studio server (Electron + xvfb). Runbook: `.agents/skills/rnf-auto-editor/SKILL.md`.

## Quick start on Windows
```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg yt-dlp.yt-dlp
# new terminal
git clone https://github.com/manikumaragarwal/RNF-EDITING-pipeline.git C:\rnf
cd C:\rnf
copy config\rnf.env.example .env        # add GROQ_API_KEY
# copy the licensed music into assets\sfx-pack\bg-music\
node hf\doctor.mjs --yt

node hf\get-gameplay.mjs "Who's Cheating"          # or drop your own clips in assets\game-assets\<slug>\gameplay\
node hf\prep.mjs "D:\clips\Who's Cheating.mp4"     # then complete reels\who-s-cheating\plan.json
node hf\build.mjs reels\who-s-cheating
node hf\finish.mjs reels\who-s-cheating            # -> reels\who-s-cheating\final.mp4 + qc-frames\
```

## Layout
```
AGENTS.md                          agent entry point + hard rules
CODEX-PROMPT.md                    paste-ready prompt to hand a coding agent
.agents/skills/rnf-hyperframes/    laptop runbook (HyperFrames)
.agents/skills/rnf-auto-editor/    server runbook (original engine)
hf/                                HyperFrames pipeline: doctor, get-gameplay, prep, build, finish
docs/                              locked rules, style, architecture, gotchas, footage, channel
app/                               Caption Studio server + engine + RNF orchestrator (app/web/rnf-*.mjs)
footage/                           Steam / YouTube / site gameplay gathering + Gemini b-roll index
assets/sfx-pack/                   riser, cash register, clicks; bg-music/ = bring your own tracks
config/rnf.env.example             every env var
```

## Setup (server path)
Requirements: Node 20+, ffmpeg + ffprobe (with libass), Python 3 with `numpy` and `Pillow`,
`xvfb-run` and Electron's Linux libs (headless caption render), `yt-dlp`, optional `rclone`.
Linux is the tested platform.

```bash
git clone https://github.com/manikumaragarwal/RNF-EDITING-pipeline.git
cd RNF-EDITING-pipeline
cd app && npm install && cd ..
pip install numpy pillow
cp config/rnf.env.example .env          # add GEMINI_API_KEY
mkdir -p .secrets assets/game-assets    # yt-cookies*.txt in .secrets/ (optional)
# add licensed music to assets/sfx-pack/bg-music/ (see the README there)

set -a; . ./.env; set +a
node app/web/server.mjs                 # caption server on 127.0.0.1:3016; keep it running
```

## Use
```bash
# whole folder of clean cuts (each filename = game name), detached
setsid nohup node app/web/rnf-batch.mjs /path/to/clips 1 > /path/to/clips/batch-run.log 2>&1 < /dev/null &

# one project
node app/web/rnf-run.mjs prepare  <id>
node app/web/rnf-run.mjs finalize <id>

# web UI: http://127.0.0.1:3016/rnf-automation
```
Output: `app/web/work/rnf/<id>/final.mp4` (and an rclone upload if `RNF_DRIVE_DEST` is set).

## Not included
API keys, YouTube cookies, the licensed music tracks, and per-game gameplay/art (gathered per run).
Four commercial fonts from the original Caption Studio were also left out. The RNF look only needs
Luckiest Guy (OFL, included).
