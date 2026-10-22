// Import adapters -> the one canonical `words[]` model:
//   { text, start, end, hi:false, on:true }
// Unifies the three legacy shapes found in the workspace + SRT.

// faster-whisper / whisper JSON  ({ words:[{word,start,end}] } or segments)
export function fromWhisper(json) {
  let src = [];
  if (Array.isArray(json.words) && json.words.length) src = json.words;
  else if (Array.isArray(json.segments)) src = json.segments.flatMap((s) => s.words || []);
  return src
    .filter((w) => (w.word ?? w.text) != null)
    .map((w) => ({ text: String(w.word ?? w.text).trim(), start: +w.start, end: +w.end, hi: false, on: true }))
    .filter((w) => w.text !== '');
}

// Legacy reel-editor caption track: [{ s, e, w:[{t, k}] }]  (scene-level times).
// Interpolates per-word times evenly across the scene so karaoke has a grid.
export function fromCaps(arr) {
  const out = [];
  for (const sc of arr) {
    const ws = sc.w || [];
    const s = +sc.s, e = +sc.e;
    const step = ws.length ? (e - s) / ws.length : 0;
    ws.forEach((w, i) => {
      out.push({ text: String(w.t).trim(), start: +(s + i * step).toFixed(3), end: +(s + (i + 1) * step).toFixed(3), hi: !!w.k, on: true });
    });
  }
  return out;
}

// Abhiveer chunks.json: { chunks:[{ words:[{t,y}], start/in, end/out }] }
export function fromChunks(json) {
  const out = [];
  for (const c of json.chunks || []) {
    const ws = c.words || [];
    const s = +(c.start ?? c.in), e = +(c.end ?? c.out);
    const step = ws.length ? (e - s) / ws.length : 0;
    ws.forEach((w, i) => {
      out.push({ text: String(w.t).trim(), start: +(s + i * step).toFixed(3), end: +(s + (i + 1) * step).toFixed(3), hi: !!w.y, on: true });
    });
  }
  return out;
}

// ---- SRT (round-trip so you can literally "edit the SRT") ----
const srtTime = (t) => {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(mm, 3)}`;
};
const parseSrtTime = (str) => {
  const m = str.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
};

// Words -> SRT by grouping through the segmenter (one cue per scene).
export function toSRT(scenes) {
  return scenes
    .map((sc, i) => {
      const text = sc.words.map((w) => (w.hi ? `[${w.text}]` : w.text)).join(' ');
      return `${i + 1}\n${srtTime(sc.start)} --> ${srtTime(sc.end)}\n${text}\n`;
    })
    .join('\n');
}

// SRT -> words[]. [word] marks a highlight. Word times are interpolated across
// the cue (SRT has no word-level timing).
export function fromSRT(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/).filter((b) => b.trim());
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const tl = lines.find((l) => l.includes('-->'));
    if (!tl) continue;
    const [a, z] = tl.split('-->');
    const s = parseSrtTime(a), e = parseSrtTime(z);
    const body = lines.slice(lines.indexOf(tl) + 1).join(' ').trim();
    const toks = body.split(/\s+/).filter(Boolean);
    const step = toks.length ? (e - s) / toks.length : 0;
    toks.forEach((tok, i) => {
      const hi = /^\[.*\]$/.test(tok);
      out.push({ text: tok.replace(/^\[|\]$/g, ''), start: +(s + i * step).toFixed(3), end: +(s + (i + 1) * step).toFixed(3), hi, on: true });
    });
  }
  return out;
}
