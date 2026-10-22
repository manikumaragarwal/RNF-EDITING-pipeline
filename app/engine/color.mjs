// ASS color + time helpers.
// ASS colors are &HAABBGGRR (alpha inverted: 00 = opaque, FF = transparent),
// stored BGR not RGB. Inline \1c tags take &HBBGGRR& (no alpha).

function bgr(hex) {
  const h = String(hex).replace('#', '').trim().padStart(6, '0');
  const rr = h.slice(0, 2), gg = h.slice(2, 4), bb = h.slice(4, 6);
  return (bb + gg + rr).toUpperCase();
}

// Full color for a [V4+ Styles] Format line (with alpha).
export function styleColor(hex, alpha = 0) {
  const aa = Math.max(0, Math.min(255, alpha)).toString(16).padStart(2, '0');
  return `&H${aa}${bgr(hex)}`.toUpperCase();
}

// Inline override color, e.g. {\1c<cTag>}  -> &HBBGGRR&
export function cTag(hex) {
  return `&H${bgr(hex)}&`;
}

// seconds -> ASS timestamp  H:MM:SS.cc  (centiseconds, 2 digits)
export function assTime(t) {
  if (!(t > 0)) t = 0;
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${h}:${p2(m)}:${p2(s)}.${p2(c)}`;
}
