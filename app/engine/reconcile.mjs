// Reconcile: marry Gemini's accurate Hinglish WORDS to Whisper's accurate word
// TIMING. Gemini knows *what* was said (code-switched Hindi+English, romanized the
// way creators type it); Whisper knows *when* each word lands (frame-accurate word
// timestamps). Gemini's own timestamps drift and are discarded. This module aligns
// the two word sequences and transfers Whisper's times onto Gemini's text, so every
// caption word keeps Gemini's spelling but lands on Whisper's beat.
//
// Output is the app's canonical word model: { text, start, end, hi:false, on:true }
// (+ conf: 1 for a directly-timed word, 0.5 for one whose time was interpolated).
//
// Pure JS, zero new deps. Reuses translit.cjs so a Devanagari Whisper token and a
// Roman Gemini token compare in one phonetic space.
import translit from './translit.cjs';
const { romanizeWord } = translit;

// ---- phonetic normalization: fold both sides into a comparable key --------------
// Whisper (hi) may emit Devanagari; Gemini emits Roman. Romanize, lowercase, strip
// punctuation/diacritics, then fold the spelling variants that don't change the sound
// (aa/a, ee|ii/i, oo|uu/u, w/v, ph/f, doubled letters) so "sacchai"~"sachai",
// "mehnat"~"mehanat", "kyunki"~"kyonki" score as near-matches.
export function phoneticKey(text) {
  let t = romanizeWord(String(text == null ? '' : text));
  t = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/[^a-z0-9]/g, '');
  if (!t) return '';
  t = t.replace(/aa+/g, 'a').replace(/(?:ee|ii)/g, 'i').replace(/(?:oo|uu)/g, 'u');
  t = t.replace(/ph/g, 'f').replace(/w/g, 'v');
  t = t.replace(/([a-z])\1+/g, '$1');       // collapse doubled LETTERS only (never digits — 1000 != 100)
  return t;
}

// Levenshtein on short strings (two-row rolling buffer).
function lev(a, b) {
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

// 1.0 identical, down to 0.0 fully different. Two all-digit tokens compare EXACTLY
// (never soft-match) so a mis-heard number can't align to a different number.
export function sim(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return 0;   // distinct numbers: no soft match
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}

// ---- global alignment (Needleman-Wunsch) ----------------------------------------
// ops: [{ w:i|null, g:j|null }] in reading order.
//   { w, g }        -> Whisper token i corresponds to Gemini word j (match OR
//                      substitution — either way the POSITION/time maps)
//   { w:i, g:null }  -> Whisper token with no Gemini word (Whisper heard extra) -> drop
//   { w:null, g:j }  -> Gemini word with no Whisper anchor (Whisper dropped/merged) ->
//                      time is interpolated from neighbours
const GAP = -0.7;   // gap penalty; a same-position substitution (score 2*sim-1) is
                    // preferred over a gap whenever sim > ~0.15, so real correspondences
                    // stay diagonal and only genuine inserts/deletes take a gap.
export function align(wKeys, gKeys) {
  const n = wKeys.length, m = gKeys.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const bt = Array.from({ length: n + 1 }, () => new Int8Array(m + 1)); // 0 diag, 1 up(del W), 2 left(ins G)
  for (let i = 1; i <= n; i++) { dp[i][0] = i * GAP; bt[i][0] = 1; }
  for (let j = 1; j <= m; j++) { dp[0][j] = j * GAP; bt[0][j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = 2 * sim(wKeys[i - 1], gKeys[j - 1]) - 1;
      const diag = dp[i - 1][j - 1] + s;
      const up = dp[i - 1][j] + GAP;
      const left = dp[i][j - 1] + GAP;
      let best = diag, b = 0;
      if (up > best) { best = up; b = 1; }
      if (left > best) { best = left; b = 2; }
      dp[i][j] = best; bt[i][j] = b;
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && bt[i][j] === 0) { ops.push({ w: i - 1, g: j - 1 }); i--; j--; }
    else if (i > 0 && (j === 0 || bt[i][j] === 1)) { ops.push({ w: i - 1, g: null }); i--; }
    else { ops.push({ w: null, g: j - 1 }); j--; }
  }
  ops.reverse();
  return ops;
}

// ---- timestamp transfer for one chunk -------------------------------------------
// wWords: [{text,start,end}] (timing truth). gWords: [string] (content truth).
// tStart/tEnd bound the chunk so head/tail inserts have something to interpolate into.
// Returns canonical words carrying Gemini text on Whisper time, or null if unusable
// (empty Gemini side) so the caller can fall back to the romanized Whisper words.
export function reconcileChunk(wWords, gWords, tStart, tEnd) {
  const G = (gWords || []).map((x) => String(x)).filter((s) => s.trim() !== '');
  const W = (wWords || []).filter((w) => w && w.text != null);
  if (!G.length) return null;
  if (!W.length) {
    // No timing to borrow: spread Gemini words evenly across the span by char length.
    return spread(G, tStart, tEnd);
  }
  const wKeys = W.map((w) => phoneticKey(w.text));
  const gKeys = G.map((g) => phoneticKey(g));
  const ops = align(wKeys, gKeys);

  const out = G.map((text) => ({ text, start: null, end: null, anchor: false }));
  // Walk ops in order. A diagonal op anchors a Gemini word to a Whisper token's time.
  // A Whisper-only op (delete) is either (a) Gemini MERGING that token into an adjacent
  // word ("new"+"york" -> "newyork") or (b) filler Gemini dropped ("um"). We tell them
  // apart phonetically: a delete is absorbed into an anchor's span ONLY if its key is a
  // substring of that anchor's Gemini word (the real merge); otherwise it's left as dead
  // space (the dropped filler keeps its own gap). Deletes not claimed by the previous
  // anchor are held and offered to the next one (covers merges in either direction).
  let lastAnchorG = -1;
  let pending = [];   // unabsorbed deletes: { start, end, key }
  const partOf = (delKey, gKey) => delKey.length >= 2 && gKey.includes(delKey);
  for (const op of ops) {
    if (op.w != null && op.g != null) {
      let s = +W[op.w].start;
      for (const pd of pending) if (partOf(pd.key, gKeys[op.g])) s = Math.min(s, pd.start);
      pending = [];
      out[op.g].start = s;
      out[op.g].end = +W[op.w].end;
      out[op.g].anchor = true;
      lastAnchorG = op.g;
    } else if (op.w != null && op.g == null) {
      const wk = wKeys[op.w];
      if (lastAnchorG >= 0 && partOf(wk, gKeys[lastAnchorG])) {
        if (+W[op.w].end > out[lastAnchorG].end) out[lastAnchorG].end = +W[op.w].end;
      } else {
        pending.push({ start: +W[op.w].start, end: +W[op.w].end, key: wk });
      }
    }
  }
  // interpolate unanchored runs across the time between their bracketing anchors
  let j = 0;
  while (j < out.length) {
    if (out[j].anchor) { j++; continue; }
    let k = j;
    while (k < out.length && !out[k].anchor) k++;
    const lo = j > 0 ? out[j - 1].end : tStart;
    const hi = Math.max(k < out.length ? out[k].start : tEnd, lo);
    fill(out, j, k, lo, hi);
    j = k;
  }
  return enforceTimeline(out);
}

// evenly spread words (by char length) across [lo,hi) — used when there is no anchor
function spread(texts, lo, hi) {
  const items = texts.map((text) => ({ text, start: null, end: null, anchor: false }));
  fill(items, 0, items.length, lo, Math.max(hi, lo));
  return enforceTimeline(items);
}

// assign items[j..k) proportional slices of [lo,hi) by character length
function fill(items, j, k, lo, hi) {
  if (k <= j) return;
  const lens = [];
  let tot = 0;
  for (let x = j; x < k; x++) { const L = Math.max(1, String(items[x].text).length); lens.push(L); tot += L; }
  const span = Math.max(hi - lo, 1e-3);
  let acc = 0;
  for (let x = j, idx = 0; x < k; x++, idx++) {
    const s = lo + span * (acc / tot);
    acc += lens[idx];
    const e = lo + span * (acc / tot);
    items[x].start = s; items[x].end = e;
  }
}

// Stage 2 path: apply CTC forced-alignment times to Gemini words. ctcTimes[i] is
// { start, end } for word i, or null where CTC couldn't align it (e.g. a pure-number
// token with no letters in the acoustic vocab). Unaligned words are interpolated between
// their aligned neighbours, exactly like reconcile's inserts. Returns canonical words, or
// null if nothing aligned (caller falls back to reconcile/offline).
export function applyCtcTimes(gWords, ctcTimes, tStart, tEnd) {
  // Pair each word with its CTC time BEFORE dropping blanks — ctcTimes is indexed by the
  // worker's ORIGINAL word position, so filtering the words first would misalign them.
  const clamp = (x) => Math.min(Math.max(+x, tStart), tEnd);   // keep times inside this chunk (no seam leak, no boundary over-reach)
  const pairs = (gWords || []).map((w, i) => ({ text: String(w), c: ctcTimes && ctcTimes[i] }))
    .filter((p) => p.text.trim() !== '');
  if (!pairs.length) return null;
  const out = pairs.map(({ text, c }) => {
    const has = c && c.start != null && c.end != null;
    return { text, start: has ? clamp(c.start) : null, end: has ? clamp(c.end) : null, anchor: !!has };
  });
  if (!out.some((w) => w.anchor)) return null;   // nothing aligned -> let caller fall back
  let j = 0;
  while (j < out.length) {
    if (out[j].anchor) { j++; continue; }
    let k = j;
    while (k < out.length && !out[k].anchor) k++;
    const lo = j > 0 ? out[j - 1].end : tStart;
    const hi = Math.max(k < out.length ? out[k].start : tEnd, lo);
    fill(out, j, k, lo, hi);
    j = k;
  }
  return enforceTimeline(out);
}

// Enforce the caption timeline: strictly-increasing starts (>= minDur apart), every
// word >= minDur long, no overlap. Order is READING order — NW alignment is monotonic,
// so we must NOT sort by start (ties would scramble word order). Where two anchors sit
// back-to-back and an inserted word has no room, we NUDGE the following words forward by
// minDur (a ~60ms ripple) rather than collapsing the insert to zero duration and dropping
// it — that inserted word is exactly the one Gemini recovered, so it must stay visible.
export function enforceTimeline(items, minDur = 0.06) {
  const o = items.filter((w) => w.start != null)
    .map((w) => ({ text: w.text, start: +w.start, end: +w.end, conf: w.conf != null ? w.conf : (w.anchor ? 1 : 0.5) }));
  for (let i = 0; i < o.length; i++) {
    if (i > 0 && o[i].start < o[i - 1].start + minDur) o[i].start = o[i - 1].start + minDur;
    if (o[i].end < o[i].start + minDur) o[i].end = o[i].start + minDur;
    if (i > 0 && o[i - 1].end > o[i].start) o[i - 1].end = o[i].start;   // start[i] > start[i-1] guaranteed -> no zeroing
  }
  return o.map((w) => ({ text: w.text, start: +w.start.toFixed(3), end: +w.end.toFixed(3), hi: false, on: true, conf: +w.conf.toFixed(2) }));
}

// ---- top level: reconcile a whole reel given time-ordered chunks ----------------
// chunks: [{ wWords:[{text,start,end}], gWords:[string], tStart, tEnd }]
// perChunkFallback(i) is called when a chunk can't be reconciled (returns canonical
// words to use for that span, e.g. the romanized Whisper words). Returns the full
// concatenated word list, ordered and with the timeline invariants enforced across
// chunk seams. Chunks are time-ordered (planned sequentially) so concatenation is
// reading order — we enforce, we do NOT re-sort (which would scramble tied starts).
export function reconcile(chunks, perChunkFallback) {
  const all = [];
  chunks.forEach((c, i) => {
    let words = null;
    try { words = reconcileChunk(c.wWords, c.gWords, c.tStart, c.tEnd); } catch { words = null; }
    if (!words || !words.length) {
      words = perChunkFallback ? (perChunkFallback(i) || []) : [];
    }
    for (const w of words) all.push(w);
  });
  return enforceTimeline(all);
}
