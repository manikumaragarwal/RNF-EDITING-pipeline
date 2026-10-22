# RNF-EDITING-pipeline

Automated editor for **rest.not.found** gaming reels. Input: a clean-cut 9:16 talking-head video
named after the game. Output: a finished 1080x1920 reel with a head-aware gameplay split-screen,
an animated game logo, music + riser + SFX, sarcasm-only black-and-white tint, and Luckiest Guy
Hinglish captions, gated by an automatic QC check.

**AI agents (Codex etc.): start at [`AGENTS.md`](AGENTS.md).** Everything you need is linked from there.

## Layout
```
AGENTS.md                          agent entry point + hard rules
CODEX-PROMPT.md                    paste-ready prompt to hand a coding agent
.agents/skills/rnf-auto-editor/    the step-by-step runbook (SKILL.md)
docs/                              locked rules, style, architecture, gotchas, footage, channel
app/                               Caption Studio server + engine + RNF orchestrator (app/web/rnf-*.mjs)
footage/                           Steam / YouTube / site gameplay gathering + Gemini b-roll index
assets/sfx-pack/                   riser, cash register, clicks; bg-music/ = bring your own tracks
config/rnf.env.example             every env var
```

## Setup
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
