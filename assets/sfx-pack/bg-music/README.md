# bg-music (bring your own, not committed)

The tracks are licensed or third-party, so they aren't in this repo. Put the files here (the
editor's music folder). The picker reads every audio/video file in this folder and uses
`music-moods.json` (listened descriptions, keyed by exact filename) to choose. Override per reel
with `"music": "<filename prefix>"`.

| File (exact name expected by music-moods.json) | Mood | Use? |
|---|---|---|
| `ken_caron_-_yale_(instrumental).mp3` | gritty, tense trap, 135bpm | **safe** (tense/raw games) |
| `The Weeknd, Playboi Carti - Timeless (INSTRUMENTAL) BEST ON YOUTUBE.mp3` | dark, driving electro, 128bpm | **safe** (action, chaos) |
| `d_savage_private_jet_instrumental_(no_synth).mp3` | groovy lo-fi, flex | **safe** (money/flex/chill) |
| `Funny.mp4` | playful, cartoon | **safe** (silly/physics/cartoon games) |
| `Broke_In_A_Minute_-_Tory_Lanez_(OFFICIAL_INSTRUMENTAL)_(BEST_IN_YOUTUBE) (1).mp3` | dark trap, 115bpm | avoid: vocal sample fights the VO |
| `As_It_Was_(128_kbps).mp3` | melancholic | **never** |
| `blue (instrumental).mp4` | sad, calming | **never** |
| `gaming-mix-1.mp3` | lo-fi 65bpm, melancholic, long mix | **never** |

New tracks: drop them in and add an entry to `music-moods.json` (same shape as the others) after
actually listening. The picker treats unlisted files as unknown.
