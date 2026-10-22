// project.json + style preset  ->  a burnable .ass subtitle file. NO AI.
// This is the whole "styling" engine: one Dialogue event per scene, per-word
// timing/highlight expressed as libass override tags.
import { styleColor, cTag, assTime } from './color.mjs';
import { segment } from './segment.mjs';
import { autoHighlight, applyLongest } from './highlight.mjs';

// ASS reserves { } \ — escape them inside dialogue text.
function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}
function tx(t, c) {
  if (c === 'upper') return String(t).toUpperCase();
  if (c === 'lower') return String(t).toLowerCase();
  return String(t);
}

export function buildScenes(project) {
  if (project.scenes && project.scenes.length) return project.scenes;
  const words = project.words.map((w) => ({ ...w }));
  const ah = project.autoHighlight;
  if (ah && ah.enabled) autoHighlight(words, ah);
  const scenes = segment(words, project.segmentation);
  if (ah && ah.enabled && (ah.rules || []).includes('longest')) applyLongest(scenes);
  return scenes;
}

export function compileASS(project, style) {
  const W = project.width || 1080;
  const H = project.height || 1920;
  const scenes = buildScenes(project);

  const primary = style.primary || '#FFFFFF';
  const accent = style.accent || style.highlight || '#FFD64A';
  const base = style.karaokeBase || primary;         // SecondaryColour (unfilled)
  const outlineC = (style.outline && style.outline.color) || '#000000';
  const outlineW = (style.outline && style.outline.width) ?? 4;
  const shadow = style.shadow ?? 0;
  const font = style.font || 'DejaVu Sans';
  const size = style.size || 84;
  const bold = style.bold ? -1 : 0;
  const italic = style.italic ? -1 : 0;
  const align = (style.position && style.position.align) || 2;   // 2=bottom-center, 5=middle-center
  const marginV = (style.position && style.position.marginV) ?? 210;
  const marginL = (style.position && style.position.marginL) ?? 80;
  const marginR = (style.position && style.position.marginR) ?? 80;
  const anim = style.animation || 'karaoke';
  const caseTx = style.case || null;
  const fillAll = !!style.karaokeFillAll;
  const tail = style.tail ?? 0.05;
  const fade = style.fade ?? (anim === 'fade' ? 150 : 0);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},${styleColor(primary)},${styleColor(base)},${styleColor(outlineC)},${styleColor('#000000')},${bold},${italic},0,0,100,100,0,0,1,${outlineW},${shadow},${align},${marginL},${marginR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const opt = { anim, primary, accent, base, caseTx, fillAll, fade };
  const events = scenes.map((sc, i) => {
    const next = scenes[i + 1];
    // linger by `tail`, but never overlap the next cue (they share a position)
    const endT = next ? Math.min(sc.end + tail, next.start) : sc.end + tail;
    const start = assTime(sc.start);
    const end = assTime(Math.max(endT, sc.end));
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${renderScene(sc, opt)}`;
  });

  return header.concat(events).join('\n') + '\n';
}

function renderScene(sc, opt) {
  const { anim, primary, accent, caseTx, fillAll, fade } = opt;
  const words = sc.words;
  const prefix = fade ? `{\\fad(${fade},0)}` : '';
  const parts = [];

  if (anim === 'karaoke') {
    // Cumulative left-to-right fill synced to speech. Unfilled = SecondaryColour;
    // each word fills to accent (fillAll) / accent-if-highlighted / else primary.
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = words[i + 1];
      const durCs = Math.max(1, Math.round(((next ? next.start : sc.end) - w.start) * 100));
      const fill = fillAll || w.hi ? accent : primary;
      parts.push(`{\\1c${cTag(fill)}\\kf${durCs}}${esc(tx(w.text, caseTx))}`);
    }
    return prefix + parts.join(' ');
  }

  if (anim === 'pop') {
    // Active-word emphasis: each word scales up + recolors while spoken.
    // (experimental — libass per-word \t on shared props can overlap; karaoke
    // is the fully-reliable path.)
    const t0 = sc.start;
    for (const w of words) {
      const a0 = Math.max(0, Math.round((w.start - t0) * 1000));
      const a1 = Math.round((w.end - t0) * 1000);
      const up = w.hi ? accent : accent;
      const rest = w.hi ? accent : primary;
      parts.push(
        `{\\fscx100\\fscy100\\1c${cTag(primary)}` +
        `\\t(${a0},${a0 + 90},\\fscx122\\fscy122\\1c${cTag(up)})` +
        `\\t(${a1},${a1 + 140},\\fscx100\\fscy100\\1c${cTag(rest)})}` +
        esc(tx(w.text, caseTx)),
      );
    }
    return prefix + parts.join(' ');
  }

  // static / none: highlighted words in accent, the rest in primary; no timing.
  for (const w of words) {
    parts.push(`{\\1c${cTag(w.hi ? accent : primary)}}${esc(tx(w.text, caseTx))}`);
  }
  return prefix + parts.join(' ');
}
