// CTC forced alignment: given a wav2vec2 emission matrix (per-frame character
// log-probabilities) and a KNOWN word sequence, find where each word sits in the audio
// at frame (~20ms) resolution. A pure-JS port of torchaudio's forced-align
// (get_trellis / backtrack / merge_repeats / merge_words). No deps.
//
// This is Stage 2's timing engine: Gemini gives the exact words, wav2vec2 says exactly
// WHEN each was spoken — frame-perfect even on the words Whisper misheard.

// Row-wise log-softmax of raw logits [T*V] -> log-probs [T*V] (new Float32Array).
export function logSoftmaxRows(logits, T, V) {
  const out = new Float32Array(T * V);
  for (let t = 0; t < T; t++) {
    const base = t * V;
    let mx = -Infinity;
    for (let v = 0; v < V; v++) { const x = logits[base + v]; if (x > mx) mx = x; }
    let sum = 0;
    for (let v = 0; v < V; v++) sum += Math.exp(logits[base + v] - mx);
    const lse = mx + Math.log(sum);
    for (let v = 0; v < V; v++) out[base + v] = logits[base + v] - lse;
  }
  return out;
}

// words: [{ text, ids:[charTokenId,...] }] — only alignable words (>=1 char id), in order.
// emission: Float32Array log-probs [T*V]. blank: CTC blank/pad id. sep: word-delimiter id
// inserted between words (kept in the token stream so the trellis can rest on gaps).
// Returns [{ text, startFrame, endFrame, score }] in word order, or null if it can't
// align (more tokens than frames / empty), so the caller can fall back.
export function alignWords(emission, T, V, words, { blank = 0, sep = 4 } = {}) {
  if (!words || !words.length || !T) return null;
  // flat token stream with SEP between words; wordOf maps token index -> word index (-1 for SEP)
  const tokens = [];
  const wordOf = [];
  for (let k = 0; k < words.length; k++) {
    if (k > 0) { tokens.push(sep); wordOf.push(-1); }
    for (const id of words[k].ids) { tokens.push(id); wordOf.push(k); }
  }
  const N = tokens.length;
  if (!N || T < N) return null;                 // need at least one frame per token
  const E = (t, v) => emission[t * V + v];

  // get_trellis: trellis[t*N+j] = best score aligning first j+1 tokens in first t+1 frames
  const NEG = -1e30;
  const trellis = new Float64Array(T * N).fill(NEG);
  trellis[0] = 0;
  for (let t = 1; t < T; t++) trellis[t * N + 0] = trellis[(t - 1) * N + 0] + E(t - 1, blank);
  for (let t = 0; t < T - 1; t++) {
    const row = t * N, next = (t + 1) * N;
    const eb = E(t, blank);
    for (let j = 1; j < N; j++) {
      const stay = trellis[row + j] + eb;
      const change = trellis[row + (j - 1)] + E(t, tokens[j]);
      trellis[next + j] = stay > change ? stay : change;
    }
  }

  // backtrack from the last token at the last frame. Two phases (torchaudio): walk back
  // choosing stay-vs-change until token 0, THEN keep walking the remaining frames on
  // token 0 so the FIRST token gets its full span (not just one frame).
  let t = T - 1, j = N - 1;
  const pts = [{ j, t }];                        // {j, t}
  while (j > 0) {
    const stay = trellis[(t - 1) * N + j] + E(t - 1, blank);
    const change = trellis[(t - 1) * N + (j - 1)] + E(t - 1, tokens[j]);
    t -= 1;
    if (change > stay) j -= 1;
    pts.push({ j, t });
  }
  while (t > 0) { t -= 1; pts.push({ j, t }); }
  pts.reverse();

  // merge_repeats: consecutive same-token points -> one segment [startFrame, endFrame)
  // then fold segments into their word's min-start / max-end frame.
  const wStart = new Array(words.length).fill(Infinity);
  const wEnd = new Array(words.length).fill(-Infinity);
  let i = 0;
  while (i < pts.length) {
    const jj = pts[i].j;
    let k = i;
    while (k < pts.length && pts[k].j === jj) k++;
    const w = wordOf[jj];
    if (w >= 0) {
      const s = pts[i].t, e = pts[k - 1].t + 1;
      if (s < wStart[w]) wStart[w] = s;
      if (e > wEnd[w]) wEnd[w] = e;
    }
    i = k;
  }

  const res = [];
  for (let w = 0; w < words.length; w++) {
    if (wStart[w] === Infinity) return null;    // a word never got a frame -> alignment unreliable
    res.push({ text: words[w].text, startFrame: wStart[w], endFrame: wEnd[w] });
  }
  return res;
}
