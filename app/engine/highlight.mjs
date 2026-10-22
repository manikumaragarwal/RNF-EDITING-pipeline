// Rule-based auto-highlight. NO AI. Sets word.hi = true on matches.
// Never clears an existing manual highlight. Rules:
//   numbers   -> any token containing a digit (10x, 2-3, 2026, 50%)
//   allcaps   -> multi-letter token already in ALL CAPS (acronyms, shouts)
//   keywords  -> token matches the provided keyword list (case-insensitive)
//   longest   -> the single longest alphabetic word in each scene
// `longest` needs scenes, so it runs after segmentation (see applyLongest).

export function autoHighlight(words, cfg = {}) {
  const rules = new Set(cfg.rules || []);
  const kws = new Set((cfg.keywords || []).map((s) => String(s).toLowerCase()));
  for (const w of words) {
    if (w.hi) continue;
    const t = String(w.text).replace(/[^\p{L}\p{N}%]/gu, '');
    if (!t) continue;
    if (rules.has('numbers') && /\d/.test(t)) { w.hi = true; continue; }
    if (rules.has('allcaps') && t.length > 1 && /[A-Z]/.test(t) && t === t.toUpperCase() && !/\d/.test(t)) { w.hi = true; continue; }
    if (rules.has('keywords') && kws.has(t.toLowerCase())) { w.hi = true; continue; }
  }
  return words;
}

// Mark the longest alphabetic word per scene (only if nothing in the scene is
// already highlighted, so it doesn't fight manual/other-rule picks).
export function applyLongest(scenes) {
  for (const sc of scenes) {
    if (sc.words.some((w) => w.hi)) continue;
    let best = null;
    for (const w of sc.words) {
      const len = String(w.text).replace(/[^\p{L}]/gu, '').length;
      if (len >= 4 && (!best || len > best.len)) best = { w, len };
    }
    if (best) best.w.hi = true;
  }
  return scenes;
}
