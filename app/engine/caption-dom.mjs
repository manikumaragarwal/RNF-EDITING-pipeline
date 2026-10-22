// Shared caption renderer — used by BOTH the live editor preview and the headless
// export. Everything is a PURE FUNCTION OF TIME t (no CSS transitions / keyframes),
// so a frame rendered live == a frame rendered during export. That is what makes
// preview == render true by construction.
//
// Runs in a browser/Chromium context (editor renderer + export page).
import { segment } from './segment.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const easeInCubic = (x) => x * x * x;
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

// hex -> rgba() with alpha
function rgba(hex, a = 1) {
  const h = String(hex || '#000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
const caseTx = (t, c) => (c === 'upper' ? t.toUpperCase() : c === 'lower' ? t.toLowerCase() : t);
// relative luminance of a hex color (0..1) — picks readable text over a color card
function luma(hex) {
  const h = String(hex || '#000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Stopwords + a pure importance heuristic. The Focus stack template highlights ONE
// "important" word per line. The app assigns it (AI or manual, stored as w.hi); this
// is the deterministic RENDER-TIME fallback so the template always shows exactly one
// highlight even before any assignment pass has run. Longer, non-stopword, content-y
// words score higher; ties break to the earliest.
const STOPWORDS = new Set(('a an and are as at be been but by can could did do does for from ' +
  'had has have he her him his how i if in into is it its me my no not of off on or our out so ' +
  'than that the their them then there these they this to too up us was we were what when which ' +
  'who will with would you your it\'s i\'m don\'t im').split(' '));
function wordScore(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9']/g, '');
  if (!t) return 0;
  let s = t.length;
  if (!STOPWORDS.has(t)) s += 6;                 // content words strongly preferred
  if (/\d/.test(t)) s += 4;                      // numbers tend to be the point
  return s;
}
function pickImportant(words) {
  let best = 0, bestScore = -1;
  for (let i = 0; i < words.length; i++) {
    const sc = wordScore(words[i].text);
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return best;
}

// Entrance animation as a pure function of progress p (0..1). Returns opacity, a
// transform string, and an optional blur (px @1920, scaled by k at the call site).
// Used for both Line scope (whole caption) and Word scope (per word).
// #15 direction + distance: `dir` ('up'|'down'|'left'|'right' = where the text slides FROM) and `dist`
// (px) override the directional entrances. When both are undefined every entrance keeps its original
// look (defaults below match the previous hard-coded values exactly).
function entranceAt(entrance, p, k, dir, dist) {
  const e = easeOutCubic(p), eb = easeOutBack(p), f = 1 - e;
  const slide = (defDir, defDist) => {
    const d = (dist != null ? dist : defDist) * k;
    switch (dir || defDir) {
      case 'down': return `translateY(${-f * d}px)`;     // from above, dropping down
      case 'left': return `translateX(${f * d}px)`;      // from the right, moving left
      case 'right': return `translateX(${-f * d}px)`;    // from the left, moving right
      default: return `translateY(${f * d}px)`;          // 'up' — from below, rising
    }
  };
  switch (entrance) {
    case 'none': return { opacity: 1, tf: '', blur: 0 };
    case 'fade': return { opacity: e, tf: '', blur: 0 };
    case 'rise':
    case 'slide': return { opacity: e, tf: slide('up', 26), blur: 0 };
    case 'blur-rise': return { opacity: clamp(p * 1.5, 0, 1), tf: slide('up', 34), blur: f * 9 };
    case 'zoom': return { opacity: clamp(p * 2, 0, 1), tf: `scale(${0.5 + 0.5 * e})`, blur: 0 };
    case 'scale': return { opacity: e, tf: `scale(${1.18 - 0.18 * e})`, blur: 0 };
    case 'bounce': return { opacity: clamp(p * 2, 0, 1), tf: `translateY(${(1 - eb) * 22 * k}px) scale(${0.92 + 0.08 * eb})`, blur: 0 };
    case 'whip': return { opacity: clamp(p * 1.7, 0, 1), tf: `${slide('right', 26)} rotate(${f * -5}deg)`, blur: f * 5 };
    case 'pop':
    default: return { opacity: clamp(p * 2, 0, 1), tf: `scale(${0.86 + 0.14 * eb})`, blur: 0 };
  }
}

// segment once; caller passes the result back in to avoid re-segmenting per frame
export function buildScenes(project) {
  const seg = { ...(project.segmentation || { mode: 'words', max: 3 }), manual: !!project.manualBreaks };
  return segment(project.words, seg);
}

// Map a legacy (ASS-era) style onto the new schema so old presets still render.
function normalizeStyle(s) {
  if (s.highlightMode || s.position?.x != null) return s;   // already new-schema
  const align = (s.position && s.position.align) || 2;
  const marginV = (s.position && s.position.marginV) || 200;
  const x = align % 3 === 1 ? 16 : align % 3 === 0 ? 84 : 50;
  const y = align <= 3 ? 100 - (marginV / 1920) * 100 : align <= 6 ? 50 : (marginV / 1920) * 100;
  const anim = s.animation || 'karaoke';
  const mode = anim === 'static' ? 'none' : anim === 'pop' ? 'active' : 'fill';
  return {
    ...s, highlightMode: mode, position: { x, y }, maxWidth: 90,
    weight: s.bold ? 800 : 700, entrance: 'fade', entranceMs: 140,
    dim: s.karaokeBase || s.primary,
  };
}

// Fill text with a vertical (or angled) gradient instead of a flat colour — background-clip:text.
// Survives export (it's just coloured pixels in the alpha PNG, no blend mode needed).
function applyTextGradient(el, g) {
  const fp = g.fromPos != null ? ` ${g.fromPos}%` : '';   // kdenlive-style colour stops (e.g. 19% / 96%)
  const tp = g.toPos != null ? ` ${g.toPos}%` : '';
  el.style.backgroundImage = `linear-gradient(${g.angle ?? 180}deg, ${g.from || '#fff'}${fp}, ${g.to || '#fff'}${tp})`;
  el.style.webkitBackgroundClip = 'text';
  el.style.backgroundClip = 'text';
  el.style.color = 'transparent';
  el.style.webkitTextFillColor = 'transparent';
}

// Text EFFECT (none / soft-shadow / hard-shadow / glow / blur). Returns { shadow?, filter? } for a
// text span, scaled to the 1920-canvas by k. `style.shadow:true` (legacy) maps to soft-shadow.
function effectStyle(style, k) {
  const eff = style.effect || (style.shadow ? 'soft-shadow' : 'none');
  if (eff === 'none') return {};
  if (eff === 'soft-shadow') return { shadow: `0 ${2 * k}px ${8 * k}px rgba(0,0,0,.55)` };
  if (eff === 'hard-shadow') return { shadow: `${Math.max(2, 3 * k)}px ${Math.max(2, 3 * k)}px 0 rgba(0,0,0,.9)` };
  if (eff === 'glow') { const g = style.glowColor || style.accent || '#12E0C8'; const s = (style.glowStrength ?? 50) / 50; return { shadow: `0 0 ${10 * k * s}px ${g}, 0 0 ${22 * k * s}px ${g}` }; }
  if (eff === 'blur') return { filter: `blur(${(style.blurPx ?? 3) * k}px)` };
  return {};
}

// Greedy word-wrap into lines of at most `maxChars` characters (word boundaries only). Returns a
// Set of word indices AFTER which a line break should be forced. Used for character-based caption
// wrapping (e.g. "30 chars per line") instead of pixel-width flex wrapping.
function wrapBreaks(words, maxChars, caseFn) {
  const breaks = new Set();
  let lineLen = 0;
  for (let i = 0; i < words.length; i++) {
    const wlen = caseFn(words[i].text).length;
    const withWord = lineLen === 0 ? wlen : lineLen + 1 + wlen;   // +1 for the space
    if (lineLen > 0 && withWord > maxChars) { breaks.add(i - 1); lineLen = wlen; }
    else lineLen = withWord;
  }
  return breaks;
}

// Closing brand tag ("Leo's Pride . @leosprideworld") — present in EVERY video of a brand, shown
// in the last `brandTagSecs`, bottom-centre, in the caption's own style (gradient included).
// Needs project.duration (the app/export sets it). Pure function of t.
function renderBrandTag(layer, style, project, tt, k) {
  if (!style.brandTag || !project.duration) return;
  const secs = style.brandTagSecs ?? 5;
  const tRemain = project.duration - tt;
  if (tRemain > secs || tRemain < -0.5) return;
  const bUsePx = style.brandTagYPx != null;   // exact pixel Y (top-anchored) like kdenlive +Y
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    position: 'absolute', left: '50%',
    top: bUsePx ? (style.brandTagYPx * k) + 'px' : ((style.brandTagY ?? 88)) + '%',
    transform: bUsePx ? 'translateX(-50%)' : 'translate(-50%,-50%)',
    width: '92%', textAlign: 'center', opacity: String(clamp((secs - tRemain) / 0.4, 0, 1)),   // fade in
    fontFamily: `'${style.font || 'Inter'}', sans-serif`, fontWeight: String(style.weight || 800),
    fontSize: ((style.brandTagSize ?? 44) * k) + 'px', lineHeight: '1.1', whiteSpace: 'pre',
    letterSpacing: `${(style.letterSpacing || 0) * k}px`,
  });
  wrap.textContent = style.brandTag;
  if (style.shadow) wrap.style.textShadow = `0 ${2 * k}px ${4 * k}px rgba(0,0,0,.5)`;
  const ow = (style.outline && style.outline.width || 0) * k;
  if (ow) wrap.style.webkitTextStroke = `${ow}px ${(style.outline && style.outline.color) || '#000'}`;
  if (style.textGradient && (style.gradientLevel || 'word') === 'line') { applyTextGradient(wrap, style.textGradient); if (ow) wrap.style.paintOrder = 'stroke'; }
  else wrap.style.color = style.primary || '#fff';
  layer.appendChild(wrap);
}

// Paint the caption for time `t` into `stage` (an element sized to the video frame).
// scenes = buildScenes(project). style = a preset (+overrides). Deterministic in t.
export function renderCaption(stage, scenes, styleRaw, t, project = {}) {
  const baseStyle = normalizeStyle(styleRaw);
  const H = stage.clientHeight || stage.offsetHeight || project.height || 1920;
  const W = stage.clientWidth || stage.offsetWidth || project.width || Math.round(H * 9 / 16);
  const k = H / 1920;                                   // scale everything vs a 1920-tall canvas
  const tt = t + (baseStyle.offset || 0) + (project.offset || 0);

  let layer = stage.querySelector('.cap-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'cap-layer';
    Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    stage.appendChild(layer);
  }
  layer.innerHTML = '';
  renderBrandTag(layer, baseStyle, project, tt, k);   // closing brand tag (independent of captions)

  const sc = scenes.find((s) => tt >= s.start && tt < s.end + (baseStyle.tail ?? 0.06));
  if (!sc) return;

  const words = sc.words;
  // Per-line override (Granular Caption Control): keyed by the line's first word id,
  // non-destructive, applied over the base style. Survives re-render because the
  // exported project keeps word ids. lov = { font, sizeScale, opacity, dx, dy, color }.
  const lineKey = (words[0] && words[0].id != null) ? words[0].id : null;
  // Per-STACK template override: this line can render with a DIFFERENT template than the
  // rest of the video. The app resolves project.stackStyles[firstWordId] (a style id) into
  // project.stackStyleMap[firstWordId] (a full style object) before rendering; the engine
  // stays pure and just swaps it in for this scene.
  const stackStyleRaw = (project.stackStyleMap && lineKey != null) ? project.stackStyleMap[lineKey] : null;
  const style = stackStyleRaw ? normalizeStyle(stackStyleRaw) : baseStyle;
  const lov = (project.lineStyles && lineKey != null) ? (project.lineStyles[lineKey] || null) : null;
  const wordStyles = project.wordStyles || null;
  const maxLines = style.maxLines ?? project.maxLines ?? 2;   // 1 = force single line (auto-shrink to fit)
  const primary = (lov && lov.color) || style.primary || '#FFFFFF';
  const accent = style.accent || '#12E0C8';
  const dim = style.dim || style.primary || '#C9CED6';
  const mode = style.highlightMode || 'active';
  const activeScale = style.activeScale ?? 1.1;
  const lineFont = (lov && lov.font) || style.font || 'Anton';
  const sizeMul = (lov && lov.sizeScale) || 1;

  // which word is "active" now (last word whose start has passed)
  let activeIdx = -1;
  for (let i = 0; i < words.length; i++) if (tt >= words[i].start) activeIdx = i;

  // ---- position wrapper (x%, y% center anchor) ----
  const pos = style.position || { x: 50, y: 82 };
  // yPx (pixels from the top, in 1920-space) TOP-anchors the caption at an exact height — the way
  // kdenlive positions text (+Y). Otherwise position.y is a percent with a centre anchor.
  const usePx = pos.yPx != null;
  const dyPx = (lov && lov.dy) ? (lov.dy / 100) * H : 0;
  const ta = style.textAlign || 'center';                                            // left / center / right
  const taJustify = ta === 'left' ? 'flex-start' : ta === 'right' ? 'flex-end' : 'center';
  const posEl = document.createElement('div');
  Object.assign(posEl.style, {
    position: 'absolute', left: ((pos.x ?? 50) + (lov && lov.dx || 0)) + '%',
    top: usePx ? (pos.yPx * k + dyPx) + 'px' : ((pos.y ?? 82) + (lov && lov.dy || 0)) + '%',
    transform: usePx ? 'translateX(-50%)' : 'translate(-50%,-50%)', width: (style.maxWidth ?? 88) + '%',
    textAlign: ta, display: 'flex', justifyContent: taJustify,
  });
  if (lineKey != null) posEl.dataset.linekey = String(lineKey);   // editor hit-testing (harmless in export)

  // ---- entrance (function of t) ----
  // Per-stack fade override (unlock mode): lov.entranceMs / lov.exitMs beat the template's own
  // fade timing for just this one caption. null/undefined => fall back to the template value.
  const entMs = (lov && lov.entranceMs != null) ? lov.entranceMs : (style.entranceMs ?? 220);
  const entrance = style.entrance || 'pop';
  const scope = style.animScope || 'line';        // 'line' = whole caption; 'word' = per word as spoken
  // #12 Timing-based animation: the entrance never outlasts the thing it's animating. A quickly-spoken
  // word gets a quick entrance (so it isn't still animating in after it's gone); a held word keeps the
  // full entranceMs. Only ever SHORTENS, so it can't make a look worse. Opt out with timedAnim:false.
  const timedAnim = style.timedAnim !== false, timedFrac = style.animTimedFrac ?? 0.7;
  const fitEnt = (ms, durSec) => timedAnim ? Math.min(ms, Math.max(60, durSec * 1000) * timedFrac) : ms;
  let boxTransform = '', boxOpacity = 1, boxBlur = 0;
  if (scope === 'line') {
    const em = fitEnt(entMs, sc.end - sc.start);
    const pIn = em > 0 ? clamp((tt - sc.start) / (em / 1000), 0, 1) : 1;   // entMs 0 = no fade-in
    const e = entranceAt(entrance, pIn, k, style.transitionDir, style.transitionDist);
    boxTransform = e.tf; boxOpacity = e.opacity; boxBlur = e.blur || 0;
    // linear fade-in (kdenlive-style "Linear" curve) instead of the default eased fade.
    if (entrance === 'fade' && style.fadeCurve === 'linear') boxOpacity = pIn;
    // exit fade: the whole caption fades OUT over exitMs before the scene ends (linear, smooth out).
    const exitMs = (lov && lov.exitMs != null) ? lov.exitMs : (style.exitMs ?? 0);
    if (exitMs > 0) boxOpacity *= clamp(((sc.end + (style.tail ?? 0.06)) - tt) / (exitMs / 1000), 0, 1);
  }
  if (lov && lov.opacity != null) boxOpacity *= lov.opacity;   // per-line opacity override
  if (style.textOpacity != null) boxOpacity *= style.textOpacity;   // Effects: overall Transparency (nests with per-word opacity)

  // ---- 3-LINE FOCUS layout ("stack" highlightMode) ----
  // ONE "important" word is big + centred (the highlight); the words BEFORE it form a small line
  // ABOVE, the words AFTER it a small line BELOW. Exactly ONE highlight per line: the word flagged
  // w.hi (assigned by the app, AI or manual), else the render-time importance pick.
  // Each of the THREE PARTS reveals AS ONE BLOCK (not word-by-word), in speech order, when its
  // first word is spoken — before → highlight → after — each with a zone-specific swipe+blur:
  //   before    = swipe-right (comes from the left)      · small · upper-left
  //   highlight = swipe-up (rises into place)            · BIG   · centre
  //   after     = swipe-right (comes from the left too)  · small · lower-right
  // Rows are absolutely positioned so a hidden part never shifts the others. Pure fn of t.
  //   and less            (before,    swipe-right, upper-left)
  //          Muscle        (highlight, swipe-up,    centre)
  //                means   (after,     swipe-right, lower-right)
  if (mode === 'stack') {
    const bigFont = (style.size || 90) * k * sizeMul;
    const smallFont = bigFont * (style.stackSmallScale ?? 0.42);
    const gap = bigFont * (style.stackGap ?? 0.72);
    const align = style.stackAlign || 'stagger';
    // side lines sit CLOSE to the highlight — a horizontal nudge from centre gives the diagonal look.
    const nudge = (style.stackNudge ?? 0.09) * W;
    const beforeOff = align === 'center' ? 0 : align === 'right' ? nudge : -nudge;
    const afterOff = align === 'center' ? 0 : align === 'left' ? -nudge : nudge;   // stagger: before←, after→
    const invert = !!style.stackInvert;                          // whole-stack invert (off by default now)
    const hiGradient = style.stackHiGradient || null;            // keyword's default fill (cool sky-blue) — invert override beats it
    const owPx0 = (style.outline && style.outline.width || 0) * k;
    const hiIdx = words.findIndex((w) => w.hi);
    const focusIdx = hiIdx >= 0 ? hiIdx : pickImportant(words);   // exactly one highlight per line
    const revealS = (style.stackRevealMs ?? 320) / 1000;
    const DX = (style.stackSwipePx ?? 110) * k, DY = (style.stackSwipeUpPx ?? 88) * k, B = (style.stackBlurPx ?? 16) * k;
    // per-zone case: sides default lowercase ("small"), keyword as-spoken; both fall back to style.case.
    const sideCase = style.stackSideCase !== undefined ? style.stackSideCase : style.case;
    const hiCase = style.stackHiCase !== undefined ? style.stackHiCase : style.case;
    const applyStackCase = (text, mode) => {
      if (mode === 'upper') return String(text).toUpperCase();
      if (mode === 'lower') return String(text).toLowerCase();
      if (mode === 'title') return String(text).replace(/\b(\w)/g, (c) => c.toUpperCase());
      return text;                                               // null / 'as-spoken' -> unchanged
    };

    // per-PART reveal: the whole part is hidden until its onset, then swipes in AS ONE BLOCK.
    const partReveal = (onset, zone) => {
      if (entrance === 'none' || onset == null) return { tf: '', blur: 0, op: 1 };
      if (tt < onset) return { tf: '', blur: 0, op: 0 };         // part not started yet (slot reserved)
      const p = clamp((tt - onset) / revealS, 0, 1);
      const e = easeOutCubic(p);
      const op = clamp(p * 1.9, 0, 1), blur = (1 - e) * B;
      if (zone === 'before') return { tf: `translateX(${-(1 - e) * DX}px)`, blur, op };  // swipe-right
      if (zone === 'after') return { tf: `translateX(${-(1 - e) * DX}px)`, blur, op };   // swipe-right (was left)
      return { tf: `translateY(${(1 - e) * DY}px)`, blur, op };                          // swipe-up
    };

    const col = document.createElement('div');
    // inline-block + alignSelf:center -> the column shrink-wraps the KEYWORD (the only in-flow child),
    // so the side lines can anchor to the keyword's actual left/right EDGES. posEl is a flex row that
    // centres the column horizontally.
    Object.assign(col.style, { position: 'relative', display: 'inline-block', alignSelf: 'center' });

    const makeSpan = (w, fontPx, baseColor, weight, isBig, caseMode) => {
      const wov = (wordStyles && w.id != null) ? (wordStyles[w.id] || null) : null;
      const span = document.createElement('span');
      if (w.id != null) span.dataset.wid = String(w.id);
      span.textContent = applyStackCase(w.text, caseMode);
      Object.assign(span.style, {
        fontFamily: `'${(wov && wov.font) || lineFont}', sans-serif`,
        fontSize: fontPx + 'px', fontStyle: style.italic ? 'italic' : 'normal',
        fontWeight: String((wov && wov.bold) ? 900 : weight),
        // tight tracking on the big keyword; the small side lines read cleaner near 0.
        letterSpacing: `${(isBig ? (style.letterSpacing || 0) : (style.stackSideLetterSpacing ?? 0)) * k}px`,
        lineHeight: '1.05', whiteSpace: 'pre', display: 'inline-block', transformOrigin: 'center center',
      });
      // Colour resolution:
      //  1) per-word invert (wov.invert) OR whole-stack invert  -> solid WHITE knockout
      //  2) per-word colour override                             -> that flat colour
      //  3) the BIG keyword, by default                          -> the template's gradient fill (sky-blue)
      //  4) otherwise                                            -> the base colour (white)
      // NOTE: invert is a SOLID white, not CSS mix-blend. The export renders captions onto a
      // transparent stage and ffmpeg burns them over the video AFTER — so at caption-draw time
      // there is no video behind the text to invert; mix-blend would look inverted in the live
      // editor but render as flat white in the exported file (preview != export). Solid white is
      // what it resolves to anyway, and it stays identical in preview and export.
      const doInvert = (wov && wov.invert) || (invert && !(wov && wov.color));
      if (doInvert) span.style.color = '#fff';
      else if (wov && wov.color) span.style.color = wov.color;
      else if (isBig && hiGradient) applyTextGradient(span, hiGradient);
      else span.style.color = baseColor;
      { const sfx = effectStyle(style, k); if (sfx.shadow) span.style.textShadow = sfx.shadow; if (sfx.filter) span.style.filter = sfx.filter; }
      if (owPx0 && isBig) { span.style.webkitTextStroke = `${owPx0}px ${(style.outline && style.outline.color) || '#000'}`; if (hiGradient && !doInvert) span.style.paintOrder = 'stroke'; }
      const extra = (wov && wov.sizeScale) || 1;
      if (extra !== 1) span.style.transform = `scale(${extra})`;
      return span;
    };
    // A part row: absolutely positioned at its zone offset, with the whole-part swipe applied to
    // the ROW (so every word in the part moves together as one block). Translations compose freely.
    const makeRow = (yOff, xOff, rv) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        position: 'absolute', left: '0', width: '100%', top: '0',
        transform: `${rv.tf} translateY(${yOff}px) translateY(-50%) translateX(${xOff}px)`.trim(),
        opacity: String(rv.op), filter: rv.blur ? `blur(${rv.blur}px)` : '',
        textAlign: 'center', lineHeight: '1.1',
      });
      return row;
    };
    const fillRow = (row, from, to, caseMode) => {
      // Word gap via a real margin (NOT a whitespace text node — those inherit the container's
      // 16px and collapse to nothing between inline-block spans, fusing the words together).
      for (let i = from; i < to; i++) {
        const sp = makeSpan(words[i], smallFont, dim, style.weightDim || 600, false, caseMode);
        if (i < to - 1) sp.style.marginRight = (0.26 * smallFont) + 'px';
        row.appendChild(sp);
      }
    };

    // Each part reveals when ITS first word is spoken: before → highlight → after (speech order).
    const beforeOnset = words[0] ? words[0].start : null;
    const hiOnset = words[focusIdx] ? words[focusIdx].start : null;
    const afterOnset = words[focusIdx + 1] ? words[focusIdx + 1].start : (words[focusIdx] ? words[focusIdx].end : null);
    const overlap = bigFont * (style.stackOverlap ?? 0.12);   // side lines nudge INTO the keyword for a slight overlap

    // KEYWORD — in flow, so the column width = keyword width (the anchor). z-index 2 (middle).
    const hiRv = partReveal(hiOnset, 'highlight');
    const kRow = document.createElement('div');
    Object.assign(kRow.style, { position: 'relative', zIndex: '2', textAlign: 'center', whiteSpace: 'nowrap', lineHeight: '1.0',
      transform: hiRv.tf, opacity: String(hiRv.op), filter: hiRv.blur ? `blur(${hiRv.blur}px)` : '' });
    kRow.appendChild(makeSpan(words[focusIdx], bigFont, accent, style.weight || 800, true, hiCase));
    col.appendChild(kRow);

    // BEFORE line — LEFT edge aligned to the keyword's LEFT edge, flows right; sits just above with a
    // slight overlap. LOWEST z-index (1) so the keyword overlaps it.
    if (focusIdx > 0) {
      const rv = partReveal(beforeOnset, 'before');
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'absolute', left: '0', bottom: '100%', zIndex: '1', textAlign: 'left', whiteSpace: 'nowrap', lineHeight: '1.0',
        transform: `translateY(${overlap}px) ${rv.tf}`.trim(), opacity: String(rv.op), filter: rv.blur ? `blur(${rv.blur}px)` : '' });
      fillRow(r, 0, focusIdx, sideCase); col.appendChild(r);
    }
    // AFTER line — RIGHT edge aligned to the keyword's RIGHT edge, flows left; sits just below with a
    // slight overlap. HIGHEST z-index (3) so it overlaps the keyword.
    if (focusIdx < words.length - 1) {
      const rv = partReveal(afterOnset, 'after');
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'absolute', right: '0', top: '100%', zIndex: '3', textAlign: 'right', whiteSpace: 'nowrap', lineHeight: '1.0',
        transform: `translateY(${-overlap}px) ${rv.tf}`.trim(), opacity: String(rv.op), filter: rv.blur ? `blur(${rv.blur}px)` : '' });
      fillRow(r, focusIdx + 1, words.length, sideCase); col.appendChild(r);
    }

    if (lov && lov.opacity != null) col.style.opacity = String(lov.opacity);   // per-line opacity override
    posEl.appendChild(col);
    layer.appendChild(posEl);
    return;
  }

  // ---- box / pill ----
  const box = style.box || {};
  const inner = document.createElement('div');
  Object.assign(inner.style, {
    display: 'inline-flex', flexWrap: maxLines === 1 ? 'nowrap' : 'wrap',
    gap: `${0.12 * (style.size || 90) * k}px ${0.28 * (style.size || 90) * k}px`,
    justifyContent: taJustify, alignItems: 'baseline', maxWidth: maxLines === 1 ? 'none' : '100%',
    whiteSpace: maxLines === 1 ? 'nowrap' : 'normal',
    transform: boxTransform, opacity: String(boxOpacity),
    transformOrigin: 'center',
  });
  if (box.enabled) {
    Object.assign(inner.style, {
      background: rgba(box.color || '#000000', box.opacity ?? 0.5),
      borderRadius: `${(box.radius ?? 18) * k}px`,
      padding: `${(box.padY ?? 14) * k}px ${(box.padX ?? 26) * k}px`,
      backdropFilter: box.blur ? `blur(${box.blur * k}px)` : '',
      WebkitBackdropFilter: box.blur ? `blur(${box.blur * k}px)` : '',
    });
  }
  if (boxBlur) inner.style.filter = `blur(${boxBlur * k}px)`;   // line-scope entrance blur (blur-rise/whip)

  const fontPx = (style.size || 90) * k * sizeMul;
  const owPx = (style.outline && style.outline.width || 0) * k;
  // character-based line wrapping (e.g. 30 chars/line): break at word boundaries, not pixel width.
  const wrapAt = style.wrapChars ? wrapBreaks(words, style.wrapChars, (tx) => caseTx(tx, style.case)) : null;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isActive = i === activeIdx;
    const forced = !!w.hi;                              // manual highlight always emphasized
    const wov = (wordStyles && w.id != null) ? (wordStyles[w.id] || null) : null;   // per-word typography
    const span = document.createElement('span');
    if (w.id != null) span.dataset.wid = String(w.id);
    span.textContent = caseTx(w.text, style.case);
    Object.assign(span.style, {
      fontFamily: `'${(wov && wov.font) || lineFont}', sans-serif`,
      // NOTE: per-word/line sizeScale is applied via the transform below (a CSS scale), NOT
      // fontSize — so enlarging one word never reflows/shrinks its neighbours and never
      // trips the 1-line auto-shrink. Each element resizes fully independently.
      fontSize: fontPx + 'px',
      fontStyle: style.italic ? 'italic' : 'normal',
      letterSpacing: `${(style.letterSpacing || 0) * k}px`,
      lineHeight: String(style.lineHeight || 1.15),
      display: 'inline-block', whiteSpace: 'pre', transformOrigin: 'center bottom',
    });
    if (owPx) span.style.webkitTextStroke = `${owPx}px ${(style.outline && style.outline.color) || '#000'}`;
    const fx = effectStyle(style, k);                       // none / soft-shadow / hard-shadow / glow / blur
    if (fx.shadow) span.style.textShadow = fx.shadow;

    // per-word active pop (function of t)
    const popMs = style.activePopMs ?? 140;
    const pw = clamp((tt - w.start) / (popMs / 1000), 0, 1);
    let scaleNow = 1;
    // The spoken-word "pop" is an animation — entrance 'none' must silence it too (Bug 6).
    if (entrance !== 'none' && (isActive || forced) && (mode === 'active' || mode === 'bold-dim' || mode === 'chip')) {
      scaleNow = 1 + (activeScale - 1) * (isActive ? easeOutBack(pw) : 1);
    }

    // color / weight / chip per mode
    let color = primary, weight = style.weight || 700;
    if (mode === 'active') { color = (isActive || forced) ? accent : primary; }
    else if (mode === 'bold-dim') {
      color = (isActive || forced) ? accent : dim;
      weight = (isActive || forced) ? (style.weight || 800) : (style.weightDim || 600);
    } else if (mode === 'chip') { color = (isActive || forced) ? (style.chipText || '#FFFFFF') : primary; }
    else if (mode === 'fill') { color = (tt >= w.start || forced) ? accent : primary; }
    else if (mode === 'ghost') { color = (style.ghostAccent && (isActive || forced)) ? accent : primary; }   // Ali-Abdaal: reveal is by OPACITY (below); colour stays primary unless ghostAccent
    else if (mode === 'movebox') { color = (isActive || forced) ? (style.chipText || primary) : primary; }   // Raj-Shamani: active word contrasts against the sliding box
    else { color = forced ? accent : primary; }        // none

    if (wov && wov.color) color = wov.color;             // per-word overrides win
    if (wov && wov.bold) weight = 800;
    // whole-line gradient: words go transparent so the wrap's single gradient shows across the line.
    const lineGrad = style.textGradient && (style.gradientLevel || 'word') === 'line';
    span.style.color = lineGrad ? 'transparent' : color;
    span.style.fontWeight = String(weight);
    // gradient text fill (e.g. gold) — PER WORD by default; a per-word colour opts out; 'line' level
    // is handled on the wrap above.
    if (style.textGradient && (style.gradientLevel || 'word') !== 'line' && !(wov && wov.color)) {
      applyTextGradient(span, style.textGradient);
      // when there's also an outline, paint the stroke BEHIND the gradient fill so the letters read
      // SOLID with a clean dark edge (not glassy) — otherwise the stroke covers the fill's edges.
      if (owPx) span.style.paintOrder = 'stroke';
    }

    // Word-scope entrance: each word animates in as it's spoken; words not yet
    // spoken are hidden (this is the "every word appears on its own" look).
    let wTf = '', wOp = 1, wBlur = 0;
    if (mode === 'ghost') {
      // Ali-Abdaal: every word visible from the start at a low idle opacity; each ramps to full as
      // spoken. NO scale pop (ghost isn't in the pop whitelist above). idleOpacity/spokenOpacity are
      // the "primary/secondary opacity" dials. Independent of animScope.
      const idle = style.idleOpacity ?? 0.35, full = style.spokenOpacity ?? 1;
      const rp = clamp((tt - w.start) / ((style.revealMs ?? 160) / 1000), 0, 1);
      wOp = (forced || tt >= w.start) ? idle + (full - idle) * rp : idle;
    } else if (style.typewriter) {
      wOp = 1;   // per-character reveal below; the word always reserves its full width (no reflow)
    } else if (scope === 'word' && entrance !== 'none') {
      const pw2 = clamp((tt - w.start) / (fitEnt(entMs, w.end - w.start) / 1000), 0, 1);
      const e = entranceAt(entrance, pw2, k, style.transitionDir, style.transitionDist);
      wTf = e.tf; wOp = tt < w.start ? 0 : e.opacity; wBlur = tt < w.start ? 0 : (e.blur || 0);
    }
    // Typewriter: reveal characters left→right over the word's [start,end]. The untyped tail stays in
    // the DOM but hidden (visibility:hidden), so the FULL line width is reserved from the first frame —
    // a centered line no longer drifts left as characters/words appear; it stays anchored, chars fill
    // into their final place. (Was: textContent grew per frame, which reflowed a centered line.)
    if (style.typewriter) {
      const ful = caseTx(w.text, style.case);
      const chars = Array.from(ful);
      let n;
      if (forced || tt >= w.end) n = chars.length;
      else if (tt < w.start) n = 0;
      else n = Math.max(0, Math.floor(clamp((tt - w.start) / Math.max(0.06, w.end - w.start), 0, 1) * chars.length));
      span.textContent = '';
      const typed = chars.slice(0, n).join(''), rest = chars.slice(n).join('');
      if (typed) span.appendChild(document.createTextNode(typed));
      if (rest) { const h = document.createElement('span'); h.style.visibility = 'hidden'; h.textContent = rest; span.appendChild(h); }
      if (!typed && !rest) span.textContent = '​';   // zero-width space keeps the line height
    }
    span.style.opacity = String(wOp);
    const blurFilter = [fx.filter, wBlur ? `blur(${wBlur * k}px)` : ''].filter(Boolean).join(' ');   // effect blur + entrance blur
    if (blurFilter) span.style.filter = blurFilter;
    // per-word free position (F5): frame-relative % offset, applied as a translate that
    // does NOT reflow the others (so a word can be dragged anywhere in the frame).
    const wox = (wov && wov.wx) ? (wov.wx / 100) * W : 0;
    const woy = (wov && wov.wy) ? (wov.wy / 100) * H : 0;
    const wt = (wox || woy) ? `translate(${wox}px,${woy}px) ` : '';
    // #13 emphasis-word properties: a highlighted word can be bigger (hiScale) and/or a distinct
    // colour (hiColor), independent of the active-word animation. A per-word override still wins.
    if (w.hi && !(wov && wov.color)) {
      if (style.hiColor) { span.style.color = style.hiColor; span.style.backgroundImage = 'none'; span.style.webkitTextFillColor = style.hiColor; }
    }
    const hiScale = w.hi ? (style.hiScale || 1) : 1;
    const wScale = scaleNow * hiScale * ((wov && wov.sizeScale) || 1);   // sizeScale here (transform) = no reflow
    // per-word invert = SOLID white (not CSS mix-blend). mix-blend can't sample the video: the
    // posEl transform isolates its stacking context in the editor, and the export burns captions
    // over the video afterward (no backdrop at draw time). It rendered flat white both ways anyway,
    // so make it honest + identical in preview and export. (Same reasoning as the stack path.)
    if (wov && wov.invert) span.style.color = '#fff';
    span.style.transform = `${wt}${wTf} scale(${wScale})`.trim();
    if (wox || woy) span.style.position = 'relative';

    if (mode === 'chip' && (isActive || forced)) {
      span.style.background = rgba(accent, style.chipOpacity ?? 1);
      span.style.borderRadius = `${(style.chipRadius ?? 10) * k}px`;
      span.style.padding = `${2 * k}px ${10 * k}px`;
      if (owPx) span.style.webkitTextStroke = '';       // chip text has its own bg, no stroke
    }
    inner.appendChild(span);
    // forced line break after this word (char-based wrap): a full-width, zero-height flex item
    // makes the following words wrap to the next line, keeping every line <= wrapChars.
    if (wrapAt && wrapAt.has(i)) {
      const br = document.createElement('div');
      Object.assign(br.style, { flexBasis: '100%', width: '100%', height: '0' });
      inner.appendChild(br);
    }
  }

  posEl.appendChild(inner);
  layer.appendChild(posEl);

  // Raj-Shamani sliding highlight box: a rounded box glides from the previous word to the active
  // word (behind the text) as speech advances. Pure fn of t — all words render statically here, so
  // layout is identical every frame; only activeIdx + progress vary. Snaps (no glide) across a line
  // wrap so the box never flies between rows.
  if (mode === 'movebox' && activeIdx >= 0) {
    const spans = [...inner.querySelectorAll('[data-wid]')];
    const cur = spans[activeIdx];
    if (cur) {
      inner.style.position = 'relative';
      const mb = style.moveBox || {};
      const padX = (mb.padX ?? 16) * k, padY = (mb.padY ?? 8) * k;
      const R = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
      const c = R(cur), prev = spans[activeIdx - 1];
      const p = clamp((tt - words[activeIdx].start) / ((style.moveMs ?? 200) / 1000), 0, 1), e = easeOutCubic(p);
      let x = c.x, y = c.y, wd = c.w, ht = c.h;
      if (prev && p < 1) { const pr = R(prev); if (Math.abs(pr.y - c.y) < 4) { x = pr.x + (c.x - pr.x) * e; y = pr.y + (c.y - pr.y) * e; wd = pr.w + (c.w - pr.w) * e; ht = pr.h + (c.h - pr.h) * e; } }
      const boxEl = document.createElement('div');
      Object.assign(boxEl.style, {
        position: 'absolute', left: (x - padX) + 'px', top: (y - padY) + 'px',
        width: (wd + 2 * padX) + 'px', height: (ht + 2 * padY) + 'px', zIndex: '0', pointerEvents: 'none',
        background: rgba(mb.color || accent, mb.opacity ?? 1), borderRadius: ((mb.radius ?? 12) * k) + 'px',
      });
      inner.insertBefore(boxEl, inner.firstChild);
      spans.forEach((s) => { s.style.position = 'relative'; s.style.zIndex = '1'; });   // text above the box
    }
  }

  // 1-line mode: shrink to fit the caption width so a long line never overflows.
  // Ratio-based, so preview (scaled stage) == export (native stage) still holds.
  if (maxLines === 1) {
    const avail = posEl.clientWidth || (stage.clientWidth * (style.maxWidth ?? 88) / 100);
    const need = inner.scrollWidth;
    if (need > avail && need > 0) {
      const fit = avail / need;
      inner.style.transform = `${boxTransform} scale(${fit})`.trim();
    }
  }
}

// ---- KINETIC KEYWORD LAYER ----
// A second, independent layer of big animated word/phrase pop-outs (Submagic/MrBeast
// style), each a time-windowed event with its own text/position/preset. Like
// renderCaption, EVERYTHING here is a pure function of t (springs/shake/typewriter all
// derived from t, no CSS transitions), so preview == export by construction. Events
// carry their own {text,start,end} — never word ids — so they survive cleanProject().
const KINETIC_PRESETS = {
  'scale-punch': { inMs: 200, outMs: 160, render(c) {
    return { transform: `scale(${0.2 + 0.8 * easeOutBack(c.pin)})`, opacity: c.env };
  } },
  'rise-blur': { inMs: 260, outMs: 200, render(c) {
    const ty = (1 - easeOutCubic(c.pin)) * 60 * c.k - (1 - c.pout) * 24 * c.k;
    const blur = Math.min(12 * c.k, ((1 - easeOutCubic(c.pin)) + (1 - c.pout)) * 10 * c.k);
    c.inner.style.filter = `blur(${blur}px)`;
    return { transform: `translateY(${ty}px)`, opacity: easeOutCubic(c.pin) * c.pout };
  } },
  'typewriter': { inMs: 80, outMs: 160, render(c) {
    const chars = Array.from(c.ev.text || '');
    const revealS = Math.max(0.05, Math.min(c.dur * 0.7, chars.length * 0.045));
    const n = clamp(Math.floor((c.local / revealS) * chars.length), 0, chars.length);
    const caret = (c.local < revealS && Math.floor(c.tt * 2) % 2 === 0) ? '▌' : '';
    c.textEl.textContent = chars.slice(0, n).join('') + caret;
    return { transform: '', opacity: c.env };
  } },
  'word-swap': { inMs: 120, outMs: 160, render(c) {
    const list = (c.ev.opts && c.ev.opts.words && c.ev.opts.words.length) ? c.ev.opts.words : [c.ev.text];
    const spinS = Math.min(c.dur * 0.55, 0.5);
    let idx = list.length - 1, frac = 1;
    if (c.local < spinS) { const p = (c.local / spinS) * list.length; idx = Math.floor(p) % list.length; frac = p - Math.floor(p); }
    c.textEl.textContent = list[idx];
    return { transform: `scale(${0.9 + 0.1 * easeOutBack(clamp(frac, 0, 1))})`, opacity: c.env };
  } },
  'shake': { inMs: 180, outMs: 160, render(c) {
    const amp = ((c.ev.opts && c.ev.opts.amp) || 10) * c.k, freq = (c.ev.opts && c.ev.opts.freq) || 42;
    const shk = clamp(c.pin, 0, 1) * c.pout;
    const dx = Math.sin(c.tt * freq) * amp * shk, dy = Math.cos(c.tt * freq * 1.3) * amp * 0.5 * shk, rot = Math.sin(c.tt * freq * 0.7) * 3 * shk;
    return { transform: `translate(${dx}px,${dy}px) scale(${0.6 + 0.4 * easeOutBack(c.pin)}) rotate(${rot}deg)`, opacity: c.env };
  } },
  // color-card — the reference's full-frame punch: the whole frame flips to a solid color
  // (wiping up from the bottom) with ONE word centered in the opposite color.
  'color-card': { inMs: 160, outMs: 160, render(c) {
    const cardIn = easeOutCubic(clamp(c.local / 0.16, 0, 1));
    const card = document.createElement('div');
    Object.assign(card.style, {
      position: 'absolute', inset: '0', background: c.color, opacity: String(c.env),
      transformOrigin: 'center bottom', transform: `scaleY(${0.55 + 0.45 * cardIn})`,
    });
    c.layer.insertBefore(card, c.layer.firstChild);       // behind every word wrap
    // word sits in the readable opposite color (auto by luminance, or ev.opts.textColor)
    // reference uses white-on-teal / dark-on-white: only near-white cards get dark text.
    const tc = (c.ev.opts && c.ev.opts.textColor) || (luma(c.color) > 0.72 ? '#0B0B0B' : '#FFFFFF');
    c.textEl.style.color = tc;
    c.inner.style.webkitTextStroke = '';
    c.inner.style.textShadow = 'none';
    return { transform: `scale(${0.95 + 0.05 * easeOutBack(c.pin)})`, opacity: c.env };
  } },
  'highlighter-sweep': { inMs: 120, outMs: 160, render(c) {
    const sp = easeOutCubic(clamp(c.local / 0.35, 0, 1));
    c.inner.style.webkitTextStroke = '';                  // no outline over the marker bar
    c.textEl.style.color = '#111';
    const bg = document.createElement('div');
    Object.assign(bg.style, { position: 'absolute', left: '-0.1em', top: '0.08em', height: '0.86em', width: (sp * 100) + '%', maxWidth: '112%', background: c.color, borderRadius: `${0.08 * c.size}px`, zIndex: '-1' });
    c.inner.appendChild(bg);
    return { transform: '', opacity: clamp(c.pin * 3, 0, 1) * c.pout };
  } },
};

export function renderKinetic(stage, project, styleRaw, t) {
  const style = normalizeStyle(styleRaw);
  const events = project.kinetic || [];
  const H = stage.clientHeight || stage.offsetHeight || project.height || 1920;
  const k = H / 1920;

  let layer = stage.querySelector('.kinetic-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'kinetic-layer';
    Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '3' });
    stage.appendChild(layer);
  }
  layer.innerHTML = '';
  if (!events.length) return;

  const sorted = [...events].sort((a, b) => (a.start || 0) - (b.start || 0));
  for (const ev of sorted) {
    // word-derived events follow the caption offset; hand-placed ones use the raw clock.
    const tt = t + (ev.off === false ? 0 : (style.offset || 0) + (project.offset || 0));
    if (tt < ev.start - 0.05 || tt > ev.end + 0.05) continue;
    const dur = Math.max(0.1, ev.end - ev.start);
    const local = tt - ev.start;
    const preset = KINETIC_PRESETS[ev.preset] || KINETIC_PRESETS['scale-punch'];
    const inS = (ev.inMs ?? preset.inMs) / 1000;
    const outS = (ev.outMs ?? preset.outMs) / 1000;
    const pin = clamp(local / inS, 0, 1);
    const pout = clamp((dur - local) / outS, 0, 1);
    const env = Math.min(clamp(pin * 2, 0, 1), pout);

    const pos = ev.pos || { x: 50, y: 38 };
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { position: 'absolute', left: (pos.x ?? 50) + '%', top: (pos.y ?? 38) + '%', transform: 'translate(-50%,-50%)', display: 'flex', justifyContent: 'center', alignItems: 'center' });

    const size = (ev.size ?? 1) * (style.size ?? 90) * 1.6 * k;
    const color = ev.color || style.accent || '#FFE01B';
    const inner = document.createElement('div');
    Object.assign(inner.style, {
      position: 'relative', display: 'inline-block', whiteSpace: 'nowrap', lineHeight: '1',
      fontFamily: `'${ev.font || style.font || 'Anton'}', sans-serif`, fontWeight: '800',
      fontSize: size + 'px', color, transformOrigin: 'center center',
    });
    const ow = ((style.outline && style.outline.width) || 0) * k;
    if (ow) inner.style.webkitTextStroke = `${Math.max(ow, 3 * k)}px ${(style.outline && style.outline.color) || '#000'}`;
    inner.style.textShadow = `0 ${3 * k}px ${6 * k}px rgba(0,0,0,.5)`;

    const textEl = document.createElement('span');
    textEl.textContent = ev.text || '';
    inner.appendChild(textEl);

    const res = preset.render({ inner, textEl, wrap, layer, tt, ev, dur, local, pin, pout, env, k, color, size, style });
    inner.style.opacity = String(res.opacity ?? env);
    inner.style.transform = `${res.transform || ''} rotate(${ev.rotate || 0}deg)`.trim();

    wrap.appendChild(inner);
    layer.appendChild(wrap);
  }
}
export const KINETIC_PRESET_IDS = Object.keys(KINETIC_PRESETS);
