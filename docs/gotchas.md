# Gotchas: failures already hit, and the fix

## B-roll / footage
- **YouTube first result is often the wrong game** (got Age of Empires 4 for "Horn of Africa", Battlefield V for "Who's Cheating"). Always contact-sheet the staged clip.
- **YouTube bot-check** ("Sign in to confirm you're not a bot") on datacenter IPs. Needs fresh cookies exported from an **incognito** window, which you close right after exporting (browsing kills them). One account gets flagged after ~2-3 downloads, so use several `yt-cookies*.txt` (round-robin is built in). The full yt-dlp recipe is `--cookies <f> --js-runtimes node:$(command -v node) --remote-components ejs:github`. Without the last two you get "n challenge solving failed".
- **Steam rate-limits with HTTP 200 + `{success:false}`**, not an error code. Retries with backoff are built in, but a sustained IP block can last 20+ minutes. Gather once, slowly (`rnf-pregather.mjs`), never inside the render loop.
- **Never guess a Steam appid.** Guessed IDs silently fetched "Deadly Traps" and "No Hope". Resolve by name with `--resolve-only`. The extractor filters soundtrack/DLC/demo/sequel and requires `type==='game'`. "War Legends" resolves to the unrelated "Car War Legends". Mobile/console-only games (Pokemon Unite, Poinpy, Matiks, Nameless Cat) are not on Steam at all, so use YouTube or human uploads.
- **Steam trailers are DASH/HLS now.** Use `movie_max.mp4` derived from the movie id, or `ffmpeg -i <dash_h264.mpd> -t 60 -map 0:v:0 -c:v copy`. Age-gated games strip `movies` entirely.
- **Trailers fade to black and end with "WISHLIST ON STEAM" cards.** `avoidDarkZone()` guards placements, but check the tail. Some trailers open on a title card, so prefer the pure-gameplay one.
- **Screenshots/stills are never b-roll** (Ken Burns was rejected). They're only used for art.
- Unreleased game with no video anywhere: try the official site's `<video>` sources via headless Chrome (worked for BR1: the site CDN served 1080p mp4s).

## Framing
- Luminance head detection latched onto dark background objects → face pushed out of frame. `head-scan.py` (edge-based) replaced it. Always eyeball 3 split frames.
- Different creators and setups (standing vs seated, head high ~26% vs ~40%) need different crops. That's why it's auto-detected per reel, not fixed.

## Captions
- `exportAlpha` renders at the **uploaded** video's size. Transcribe on a proxy is fine, but the caption export must use full-res, or captions come out tiny. The engine handles it. Don't "optimise" it away.
- 4K sources time out `/api/exportAlpha`. Downscale to 1080x1920 first.
- hinglish-ai mangles proper nouns ("Arknights: Endfield" → "Enfield Arknights"). `correctGameName` matches the name in the transcript text and overwrites it with the filename spelling.
- The Gemini planner is non-deterministic and once marked the wrong word as the game name (logo landed 5s early). Check the name-drop timing.
- Read the Gemini model from the server's resolved `work/settings.json` `geminiModel`. Hardcoded retired models (2.0-flash) 404 and silently fall back to dumb 3-word chunks.

## Audio
- A random offset into a long gaming mix landed on silence = "no music". `audibleMusicStart()` probes with `volumedetect`.
- Gemini picking music from filenames = guessing. It now gets `music-moods.json`. Still pin per game.

## Render / ops
- **Detach long jobs** (`setsid nohup … < /dev/null &`). Foreground shells get SIGKILLed at session boundaries (exit 137/144). Poll `status.json`.
- `ffmpeg` inside a `while read` loop eats stdin. Always pass `-nostdin`.
- `pkill -f rnf-batch` / `pgrep -f server.mjs` match your own shell's command line and kill it. Kill by exact PID (`ss -ltnp | grep :3016`).
- The caption server serialises heavy jobs (`CAP_CONCURRENCY=1`), so batch concurrency above 2 buys nothing.
- On a memory-capped host, run batches under a cgroup/scope (`systemd-run --scope -p MemoryMax=4G …`). Uncapped ffmpeg has OOM-killed neighbouring services before.
- Drive links: IDs can end in `_`, and markdown eats it. Give links in code spans, as `/file/d/<id>/view`.
- Use ASCII batch filenames so the slug matches the asset folder.

## Windows / laptop (HyperFrames path)
- **YouTube "no results" for every game on a fresh clone** came from two bugs in `app/web/rnf-yt-gameplay.mjs`, both fixed 2026-10-23: (1) it always passed `--cookies .secrets/yt-cookies.txt` even when the file didn't exist, and yt-dlp crashes with `FileNotFoundError` on a missing cookies file; (2) it built paths from `new URL(import.meta.url).pathname`, which on Windows gives `/C:/Users/...` (and `%20` for spaces), so `mkdir` failed before any search ran. Use `hf/get-gameplay.mjs` on laptops.
- **Old yt-dlp fails on YouTube** (signature/"n challenge" errors). Update it: `winget upgrade yt-dlp.yt-dlp` or `yt-dlp -U`. `node` must be on PATH (yt-dlp uses it to solve the challenge).
- **Chrome/Edge cookies** usually can't be read on Windows (`--cookies-from-browser chrome` fails to decrypt). Use Firefox or an exported cookies.txt, or nothing at all on a home connection.
- **Sparse keyframes freeze HyperFrames video.** It seeks every frame. Every encode in `hf/` uses `-g 30 -keyint_min 30` (1s). If you add media by hand, re-encode it the same way (HyperFrames prints a "sparse keyframes" warning when you forget).
- **`hyperframes transcribe` needs whisper.cpp** on the machine ("whisper-cpp not found" → empty transcript). The default is Groq's hosted whisper-large-v3 (set `GROQ_API_KEY`), so this only matters without a key.
- **npx on Windows is a `.cmd`**, which Node only spawns through a shell. `hf/lib.mjs` → `hyperframes()` handles the quoting. Don't call `spawn('npx', ...)` directly.
- PowerShell has no `set -a; . ./.env`. The `hf/` scripts load `<repo>/.env` themselves.
