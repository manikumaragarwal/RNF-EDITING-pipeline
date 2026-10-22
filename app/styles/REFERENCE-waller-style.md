# Reference template spec — "Waller/Williamson podcast" style

Analyzed from Manish's Drive reference (46s, 720x1280, 2026-09-18). Turn this into a template.

## The look (two alternating registers)
- **Script italic** (flowing calligraphic, semi-connected, moderate contrast — NOT Playfair;
  think Allura / Alex Brush / Pinyon / Dancing Script) — used for softer/reflective words:
  "my achievements", "anything", "failure", "success", "standards", "18 months".
- **Bold sans** (clean humanist grotesk, double-story g; think Hanken/General Sans/Aeonik) —
  used for punchy words, often ALL-CAPS with tight tracking: "THE MINIMUM", "IMPOSTOR
  SYNDROME", "TRY AND DO SOMETHING ELSE", "for celebration", "going to", "less".

## Color
- Default **white** text. Accent = **teal ~#1DE0C8** on key words.
- **Full-frame COLOR CARDS** on a hero word: whole frame becomes solid (white or teal) with
  ONE word in the opposite color, in the script italic. e.g. white bg + teal "my achievements";
  teal bg + white "failure." These punch in on emphasis beats.
- **Invert / difference-blend** words: some words invert whatever they sit on (now supported:
  Words toolbar > Emph > Invert).

## Layout + motion
- 1-3 words at a time, centered (vertically mid-lower), large.
- Word-by-word reveal; occasionally 2 lines stacked ("it means that / success").
- Motion is subtle: quick fade + slight rise/scale in; hero words scale-punch; color cards
  hard-cut/quick-fade. Add a "blur-rise" and a "color-card" as new entrance/kinetic presets.

## Build plan — DONE (2026-09-18)
1. ✅ Fonts: added Allura, Alex Brush, Pinyon Script, Parisienne, Sacramento, Great Vibes,
   Satisfy, Kaushan Script, Dancing Script, Caveat (10). Bold grotesk = Hanken Grotesk.
2. ✅ Templates: `waller-bold` (Hanken 800 UPPER, white + teal, word-scope blur-rise) and
   `waller-script` (Allura, white + teal, line-scope blur-rise). Hero words use the new
   `color-card` kinetic (full-frame teal/white flip, opposite-colour word) + per-word Invert.
3. ✅ 3-line HIGHLIGHT template: `focus-stack` — new `stack` highlightMode. ONE highlight word
   big + teal centred; ALL words BEFORE it = a small line ABOVE, ALL words AFTER = a small line
   BELOW. Highlight = the pinned word (w.hi) if any, else the spoken word. Side-line alignment
   is controllable via `stackAlign` (left | center | right | stagger); stagger = before-left /
   after-right (the diagonal look). e.g. "I am / EXCITED / to work with you".

## New engine capabilities added for this style
- Entrance presets `blur-rise`, `bounce`, `whip` (entrances now carry an optional blur that
  clears as the word settles — per-word or per-caption, pure function of t).
- Kinetic preset `color-card` (full-frame colour flip; text colour auto by luminance >0.72).
- highlightMode `stack` (the 3-line before/highlight/after focus layout). Style knobs:
  `stackAlign` (left|center|right|stagger), `stackSmallScale`, `stackGap`.
