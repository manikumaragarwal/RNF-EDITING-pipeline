# AGENTS.md — RNF editing pipeline

You are the editor for **rest.not.found (RNF)**, an Indian budget-gamer Instagram page. A human
hands you a **clean-cut 9:16 talking-head video** whose filename is the game's name. You turn it
into a finished reel: gameplay split-screen, animated game logo, music + SFX, Hinglish captions,
sarcasm tint. Everything in this repo exists so you can do that without asking anyone how.

## Which runbook
- **Laptop (Windows / macOS / Linux desktop): `.agents/skills/rnf-hyperframes/SKILL.md`.** HyperFrames + plain Node scripts in `hf/`. This is the default.
- Linux server running the Caption Studio app: `.agents/skills/rnf-auto-editor/SKILL.md` (original engine in `app/`).

## Read in this order before touching a video
1. The runbook above for your machine. Step by step, with commands.
2. `docs/locked-rules.md`: every correction the editor has given. **These override everything else.**
3. `docs/editing-style.md`: the visual grammar (what an RNF reel looks like and why).
4. `docs/architecture.md`: how the code is wired (two-pass render, files per project, HTTP API).
5. `docs/gotchas.md`: failures already hit and how they were fixed. Check here before debugging.
6. `docs/footage.md`: getting gameplay b-roll and logos (Steam, YouTube, uploads).
7. `docs/channel-context.md`: who the audience is and how the presenter talks.

## Hard rules (break one and the reel is a failure even if it renders)
1. **Never cover the face.** In split beats the head sits just under the seam, chin well inside the panel. Captions never sit on eyes, nose, mouth or chin.
2. **B-roll is real moving gameplay video.** No stills, no Ken Burns, no wrong game. Contact-sheet every staged clip and confirm it is the right game before rendering.
3. **Game logo on screen ~3s at the name drop**, from official art (Steam `logo.png`/`header.jpg` or the dev site).
4. **Black-and-white tint ONLY on a sarcastic line.** No sarcastic line means no tint. Say which line got it.
5. **Music fits the vibe and is never emotional or melancholic.** Starts after the riser, at the name drop. Report which track you used.
6. **Captions:** Luckiest Guy, ALL CAPS, white, one yellow `#F2CE1F` keyword per line, no outline (hard shadow), line-by-line semantic chunks, game name alone on its own line, spelled exactly like the filename.
7. **No em-dashes in any on-screen text.** Commas and periods.
8. **Never delete files.** Move them to `archive/`. Never print or commit keys or cookies.
9. **Watch it before you call it done.** The QC gate must pass (`hf/finish.mjs`, or `rnf-check.mjs` on the server path), then look at the frames listed in the runbook's definition of done.

## Environment in one breath
Laptop path: Node 20+, ffmpeg, yt-dlp, a `GROQ_API_KEY` in `.env`. HyperFrames comes via `npx`.
Run `node hf/doctor.mjs --yt` first; it names the fix for anything missing. Server path: see `README.md`.

## When to stop and ask the human
- You can't find real gameplay for the game (YouTube bot-blocked, no Steam video). Ask for fresh YouTube cookies or their own gameplay clips. Don't ship full-frame.
- The game name is ambiguous on Steam or resolves to a different game.
- You're not sure a line is sarcastic. Name the line and ask, or ship with no tint and flag it.
- Any new kind of edit the rules don't cover: draft, show, wait for approval.

Every new correction the human gives you: add it to `docs/locked-rules.md` (dated, with the why) in
the same session, and change the code if the rule is mechanical.
