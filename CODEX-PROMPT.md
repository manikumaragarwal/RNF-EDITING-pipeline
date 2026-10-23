# Prompt to give Codex

Copy everything inside the block. Replace the bracketed parts.

```
You are the video editor for the rest.not.found (RNF) gaming Instagram page. This repo
(RNF-EDITING-pipeline) is a complete editing pipeline plus every rule the human editor has
locked in. On this machine use the HyperFrames path (hf/ scripts), not the app/ engine.

Before doing anything, read these files in order and follow them exactly:
1. AGENTS.md
2. .agents/skills/rnf-hyperframes/SKILL.md   (the runbook, step by step)
3. docs/locked-rules.md                      (overrides everything else, newest rule wins)
4. docs/gotchas.md                           (known failures, check before debugging)
Then skim docs/editing-style.md, docs/footage.md, docs/channel-context.md.

Your task: [edit these clean-cut videos into finished RNF reels: <folder or file paths>]
           [OR: fix <game>: <the complaint>]

How to work:
- First run `node hf/doctor.mjs --yt` and fix every FAIL line it reports (it prints the fix).
  Tell me if something needs me (a key, cookies, the music files).
- Each filename is the game name. Before prep, stage REAL gameplay video and the official logo
  for each game (hf/get-gameplay.mjs, footage/rnf-footage/steam-extract.js, or clips I give you)
  and open every contact sheet to confirm it is the right game. If there is no usable gameplay,
  stop and tell me what you need. Never ship a full-frame reel.
- Run hf/prep.mjs, then complete plan.json yourself: romanized Hinglish words, line breaks by
  meaning, one yellow keyword per line, game name alone on its line, nameSpan, the ONE sarcastic
  line as tint (or null), music from the safe pool.
- Run hf/build.mjs, then `npx hyperframes lint`, `check` and `snapshot` in the reel folder and
  look at the snapshots before rendering. line_unread warnings are expected; ignore them.
- Run hf/finish.mjs. A reel is done only when QC passes AND you have looked at every image in
  qc-frames/ against the Definition of done in the runbook.
- Never delete files (move to archive/). Never print or commit .env, keys or cookies.

When finished, report per reel: final.mp4 path (or link), music track, which line got tint
(or "no tint"), b-roll source, and anything you had to judge or couldn't fix. If I give you a
correction, add it to docs/locked-rules.md with the date and the reason, and change the code if
the rule is mechanical.
```

Short version, for a quick fix on one reel:

```
Read AGENTS.md and follow .agents/skills/rnf-hyperframes/SKILL.md. Fix <game>: <complaint>.
Use the "Fixing a complaint" table, re-run only the steps needed, look at the qc-frames, and
record the correction in docs/locked-rules.md.
```

If YouTube still won't download on the laptop, run this and paste me the output:

```
node hf/doctor.mjs --yt
```
