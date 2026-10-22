// Pure word -> scene segmentation. NO AI. This is the "15 chars per scene /
// 10 chars per scene / N words per scene" knob.
//
// modes:
//   chars    -> break when the visible line would exceed `max` characters
//   words    -> break when the scene would exceed `max` words
//   duration -> break when the scene would span more than `max` seconds
// Always also breaks on a speech pause > pauseGap, and after sentence-ending
// punctuation. Words with on === false are dropped (an "unchecked" sentence).

const SENT_END = /[.!?…]["'”’)\]]*$/;   // sentence ender + any run of closing quotes/brackets

export function segment(words, cfg = {}) {
  const mode = cfg.mode || 'chars';
  // 'sentence' -> one whole sentence per scene: never split on size, only on sentence-ending
  // punctuation (and a long pause as a safety). Used by caption-per-sentence templates.
  const isSentence = mode === 'sentence';
  const max = isSentence ? Infinity : (cfg.max ?? (mode === 'chars' ? 15 : mode === 'words' ? 4 : 2.5));
  // AUTO-BREAK at speech gaps (opt-in, layered on top of the size break). The silence needed to
  // force a break SCALES with the break length: a longer line needs a longer pause to split early;
  // a short line splits on a shorter pause. (Off -> only the size/sentence break applies.)
  const autoBreak = !!cfg.autoBreak;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const scaledGap = () => mode === 'words' ? clamp(0.18 + max * 0.035, 0.22, 0.9)
    : mode === 'duration' ? clamp(0.2 + max * 0.12, 0.25, 0.9)
    : clamp(0.18 + max * 0.012, 0.22, 0.9);   // chars
  const pauseGap = cfg.pauseGap ?? (isSentence ? 2.5 : (autoBreak ? scaledGap() : Infinity));
  const on = (words || []).filter((w) => w.on !== false && String(w.text).trim() !== '');

  // MANUAL mode: the user has set explicit line breaks (word.br). Lines are defined
  // ONLY by those breaks — no auto size/pause splitting. This is what "move a word to
  // another line" edits. A new line starts at the first word and at every word.br.
  if (cfg.manual) {
    const scenes = [];
    let cur = [];
    for (const w of on) {
      if (cur.length && w.br) { scenes.push(makeScene(cur)); cur = []; }
      cur.push(w);
    }
    if (cur.length) scenes.push(makeScene(cur));
    return scenes;
  }

  const sizeOf = (arr) => {
    if (mode === 'words') return arr.length;
    if (mode === 'duration') return arr.length ? arr[arr.length - 1].end - arr[0].start : 0;
    // chars: sum of word lengths + one space between each
    return arr.reduce((n, w, i) => n + String(w.text).length + (i > 0 ? 1 : 0), 0);
  };

  const scenes = [];
  let cur = [];
  const flush = () => { if (cur.length) { scenes.push(makeScene(cur)); cur = []; } };

  for (const w of on) {
    const prev = cur[cur.length - 1];
    const gap = prev ? w.start - prev.end : 0;
    if (cur.length && (sizeOf([...cur, w]) > max || gap > pauseGap)) flush();
    cur.push(w);
    // w.sentEnd: a sentence boundary preserved when "Remove Punctuation" stripped the . ! ? that
    // would otherwise define it (see depunct) — keeps sentence-mode splitting intact after strip.
    if (SENT_END.test(String(w.text)) || w.sentEnd) flush();
  }
  flush();
  return scenes;
}

function makeScene(ws) {
  // min/max so a line stays correct even if a manually moved word isn't the
  // chronological first/last of its line.
  let start = Infinity, end = -Infinity;
  for (const w of ws) { if (w.start < start) start = w.start; if (w.end > end) end = w.end; }
  return {
    start, end,
    // spread carries through any id/on the caller attached (the editor maps
    // scene words back to the source list by id); renderer reads text/start/end/hi.
    words: ws.map((w) => ({ ...w, text: w.text, start: w.start, end: w.end, hi: !!w.hi })),
  };
}
