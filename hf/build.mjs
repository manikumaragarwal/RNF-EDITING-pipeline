// build.mjs: completed plan.json -> HyperFrames composition (index.html) + build.json.
//   node hf/build.mjs <projectDir>
// All judgment (romanized words, line breaks, keywords, name span, tint, music) lives in plan.json.
// Everything mechanical (windows, clip zones, caption positions, timings, audio) is computed here.
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const proj = path.resolve(process.argv[2] || '.');
const plan = L.rd(path.join(proj, 'plan.json'));
if (!plan) throw new Error('no plan.json in ' + proj + ' (run hf/prep.mjs first)');
const A = path.join(proj, 'assets');

// ---------- validate the agent's part ----------
const errs = [];
const words = plan.words || [];
if (plan._todo) errs.push('plan._todo still present: finish the checklist, then delete _todo');
if (!words.length) errs.push('no words');
if (words.some((w) => /[ऀ-ॿ]/.test(w.text))) errs.push('words still contain Devanagari: romanize every word (captions are roman Hinglish)');
if (words.some((w) => /[–—]/.test(w.text))) errs.push('em/en dash in caption text: use commas or periods');
if (!words.some((w) => w.br)) errs.push('no line breaks: set br:true on the first word of each caption line');
if (!Array.isArray(plan.nameSpan) || plan.nameSpan.length !== 2) errs.push('nameSpan missing: [firstIndex, lastIndex] of the spoken game name');
if (!plan.music) errs.push('music not chosen');
if (!plan.gameplay?.length) errs.push('no gameplay clips: an RNF reel is never full-frame. Get gameplay, re-run prep');
if (plan.tint != null && !(Array.isArray(plan.tint) && plan.tint[1] > plan.tint[0])) errs.push('tint must be [startSec, endSec] or null');
if (errs.length) { console.error('[build] plan.json not ready:\n  - ' + errs.join('\n  - ')); process.exit(1); }

const D = plan.duration;
const [ni, nj] = plan.nameSpan;
const nameStart = words[ni].start, nameEnd = words[Math.min(nj, words.length - 1)].end;
for (let k = ni; k <= nj && k < words.length; k++) words[k].hi = true; // game name always yellow
const lines = L.linesFrom(words);

// ---------- split windows + gameplay zones ----------
let windows = plan.windows === 'auto' || !Array.isArray(plan.windows) ? L.suggestWindows(lines, nameStart, nameEnd, D) : plan.windows;
const G = plan.gameplay;
// windows sharing one clip each get a different zone of it, so the b-roll visibly cuts
const byClip = {};
windows = windows.map((w, k) => ({ ...w, clip: w.clip || G[k % G.length].file }));
windows.forEach((w) => { (byClip[w.clip] ||= []).push(w); });
const segs = []; // video elements: one window may need several if the clip is shorter than it
for (const [clip, ws] of Object.entries(byClip)) {
  const file = path.join(proj, clip); const cd = L.dur(file);
  const zone = (cd > 20 ? cd - 4.5 : cd) / ws.length; // zones over the usable part (trailer end cards skipped)
  ws.forEach((w, z) => {
    const len = L.r2(w.end - w.start);
    if (w.clipIn == null) w.clipIn = (zone > len + 1.5) ? L.bestClipIn(file, len, z * zone, (z + 1) * zone) : L.bestClipIn(file, len);
    let t = w.start, inPt = w.clipIn;
    while (t < w.end - 0.05) { // loop a short clip instead of freezing on its last frame
      const take = Math.min(w.end - t, cd - inPt - 0.05);
      segs.push({ clip, start: L.r2(t), dur: L.r2(take), mediaStart: L.r2(inPt), win: w });
      t += take; inPt = 0;
    }
  });
}
windows.sort((a, b) => a.start - b.start);
L.log(`[build] ${windows.length} split window(s): ${windows.map((w) => `${w.start}-${w.end}@${w.clipIn}`).join(', ')}`);

// ---------- captions: position per line (seam in splits, off the face on full-frame) ----------
const inWin = (t) => windows.some((w) => t >= w.start && t < w.end);
const ctaStart = Math.max(...windows.map((w) => w.end));
const chin = plan.head?.chin ?? null;
const faceDrop = chin != null ? Math.max(0, Math.min(1430 - L.CHEST_Y, Math.round(chin + 30 + 100 - L.CHEST_Y))) : 0;
const ctaDrop = Math.max(L.CTA_DROP, faceDrop);
const capLines = lines.map((l, k) => {
  const next = lines[k + 1];
  const end = L.r2(Math.min(next ? next.start : D - 0.05, Math.max(l.end + 0.25, l.start + 0.5)));
  const mid = (l.start + Math.min(l.end, end)) / 2;
  const y = inWin(mid) ? L.SEAM_Y : (l.start >= ctaStart ? L.CHEST_Y + ctaDrop : L.CHEST_Y + faceDrop);
  return { ...l, end, y };
});

// ---------- logo, tint, audio ----------
const logoIn = L.r2(Math.max(0.1, nameStart - 0.05)), logoOut = L.r2(Math.min(D - 0.1, logoIn + L.LOGO_HOLD));
const mFile = fs.readdirSync(L.MUSIC_DIR).find((f) => f === plan.music) || fs.readdirSync(L.MUSIC_DIR).find((f) => f.startsWith(plan.music));
if (!mFile) throw new Error(`music "${plan.music}" not found in ${L.MUSIC_DIR}`);
const mExt = path.extname(mFile).toLowerCase() === '.mp4' ? '.m4a' : path.extname(mFile).toLowerCase();
const mOut = path.join(A, 'music' + mExt);
if (mExt === '.m4a') L.ff(['-i', path.join(L.MUSIC_DIR, mFile), '-vn', '-c:a', 'aac', '-b:a', '192k', mOut]); else fs.copyFileSync(path.join(L.MUSIC_DIR, mFile), mOut);
const mLen = L.r2(D - nameStart);
const mStart = L.audibleStart(mOut, mLen, plan.slug);
const lane = (pts) => JSON.stringify({ version: 1, lanes: [{ target: 'volume', points: pts }] });
const musicLane = lane([{ t: 0, v: 0 }, { t: 0.5, v: L.MUSIC_VOL }, { t: L.r2(Math.max(0.6, mLen - 0.8)), v: L.MUSIC_VOL }, { t: L.r2(mLen - 0.02), v: 0 }]);
const riserAt = L.r2(Math.max(0, nameStart - L.RISER_LEAD));
const tint = plan.tint;

// ---------- HTML ----------
const X = L.esc;
const capHtml = capLines.map((l, k) => `      <div class="cap" style="top:${l.y}px"><div class="cap-in" id="cg-${k}">${l.words.map((w) => w.hi ? `<span class="hi">${X(w.text)}</span>` : X(w.text)).join(' ')}</div></div>`).join('\n');
const gpHtml = segs.map((s, k) => `      <video id="gp-${k}" class="gp" src="${s.clip}" muted playsinline data-start="${s.start}" data-duration="${s.dur}" data-media-start="${s.mediaStart}" data-track-index="2"></video>`).join('\n');
const faceHtml = windows.map((w, k) => `        <video id="face-${k}" class="face" src="assets/source.mp4" muted playsinline data-start="${w.start}" data-duration="${L.r2(w.end - w.start)}" data-media-start="${w.start}" data-track-index="3" style="top:-${plan.camCropY}px"></video>`).join('\n');
const sfx = (id, f, at, vol) => fs.existsSync(path.join(A, 'sfx', f)) ? `    <audio id="${id}" src="assets/sfx/${f}" data-start="${at}" data-volume="${vol}" data-track-index="${id === 'riser' ? 7 : 8}"></audio>` : '';

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=1080, height=1920" />
  <title>RNF ${X(plan.game)}</title>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    @font-face { font-family: "Luckiest Guy"; src: url("assets/fonts/LuckiestGuy-Regular.ttf") format("truetype"); font-display: block; }
    body { margin: 0; background: #000; }
    #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
    .layer { position: absolute; inset: 0; }
    #aroll { position: absolute; left: 0; top: 0; width: 1080px; height: 1920px; object-fit: cover; }
    .gp { position: absolute; left: 0; top: 0; width: 1080px; height: 960px; object-fit: cover; }
    #face-panel { position: absolute; left: 0; top: 960px; width: 1080px; height: 960px; overflow: hidden; }
    .face { position: absolute; left: 0; width: 1080px; height: 1920px; }
    #logo-slot { position: absolute; left: 0; top: 0; width: 1080px; height: 960px; display: flex; align-items: center; justify-content: center; pointer-events: none; }
    #logo-img { display: block; width: 560px; height: auto; max-height: 520px; object-fit: contain; }
    .cap { position: absolute; left: 0; right: 0; height: 0; display: flex; align-items: center; justify-content: center; }
    .cap-in { font-family: "Luckiest Guy", sans-serif; font-size: 78px; line-height: 1.1; color: #fff; text-transform: uppercase; text-align: center; max-width: 920px; text-shadow: 4px 5px 0 rgba(0, 0, 0, 0.85); opacity: 0; }
    .hi { color: #F2CE1F; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="rnf" data-start="0" data-width="1080" data-height="1920" data-duration="${D}" data-fps="30">
    <div id="aroll-wrap" class="layer">
      <video id="aroll" src="assets/source.mp4" playsinline data-has-audio="true" data-start="0" data-duration="${D}" data-volume="1" data-track-index="0"></video>
    </div>
    <div id="split-layer" class="layer">
${gpHtml}
      <div id="face-panel">
${faceHtml}
      </div>
    </div>
${plan.logo ? `    <div id="logo-slot"><img id="logo-img" class="clip" src="${plan.logo}" alt="" data-start="${logoIn}" data-duration="${L.r2(logoOut - logoIn)}" data-track-index="4" /></div>` : ''}
    <div id="captions" class="layer">
${capHtml}
    </div>
    <audio id="music" src="assets/music${mExt}" data-start="${L.r2(nameStart)}" data-duration="${mLen}" data-media-start="${mStart}" data-volume="1" data-track-index="6" data-automation='${musicLane}'></audio>
${sfx('riser', 'riser.mp3', riserAt, L.RISER_VOL)}
${sfx('cash', 'cash.wav', L.r2(nameStart), L.CASH_VOL)}
  </div>
  <script>
    const LINES = ${JSON.stringify(capLines.map((l) => [l.start, l.end]))};
    const tl = gsap.timeline({ paused: true });
    const GRADE = ["#aroll-wrap", "#face-panel"];
    tl.set(GRADE, { filter: "none" }, 0);
${tint ? `    tl.set(GRADE, { filter: "grayscale(1) brightness(0.94) contrast(1.06)" }, ${tint[0]});\n    tl.set(GRADE, { filter: "none" }, ${tint[1]});` : '    // no sarcastic line: no tint'}
${plan.logo ? `    tl.fromTo("#logo-img", { opacity: 0, y: -30 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, ${logoIn});\n    tl.to("#logo-img", { opacity: 0, duration: 0.35, ease: "power1.in" }, ${L.r2(logoOut - 0.4)});` : ''}
    LINES.forEach(function (l, i) {
      const el = document.getElementById("cg-" + i);
      tl.fromTo(el, { opacity: 0, scale: 0.72 }, { opacity: 1, scale: 1, duration: 0.18, ease: "back.out(2.2)" }, l[0]);
      tl.set(el, { opacity: 0, visibility: "hidden" }, l[1]);
    });
    window.__timelines["rnf"] = tl;
  </script>
</body>
</html>
`;
fs.writeFileSync(path.join(proj, 'index.html'), html);
if (!fs.existsSync(path.join(proj, 'hyperframes.json'))) L.wr(path.join(proj, 'hyperframes.json'), { name: 'rnf-' + plan.slug });
L.wr(path.join(proj, 'build.json'), { slug: plan.slug, duration: D, nameStart, logoIn, logoOut, tint, music: mFile, musicStart: mStart, camCropY: plan.camCropY, faceDrop, ctaDrop, ctaStart, windows, segments: segs.map(({ win, ...s }) => s), lines: capLines.map((l) => ({ text: l.words.map((w) => w.text).join(' '), start: l.start, end: l.end, y: l.y })) });
L.log(`[build] index.html written: ${capLines.length} caption lines, logo ${logoIn}-${logoOut}s, tint ${tint ? tint.join('-') + 's' : 'none'}, music ${mFile} @${mStart}s`);
L.log(`[build] next: node hf/finish.mjs "${proj}"   (or preview: npx hyperframes preview, in that folder)`);
