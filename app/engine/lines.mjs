// Pure manual-line algebra (NO DOM). `lines` is an array of arrays of word ids
// (each inner array is one caption line, in order). `startOf(id)` returns a word's
// start time so a moved word lands at the right chronological spot in its new line.
// app.mjs holds the DOM/state; these functions are unit-tested in isolation.

export function lineIndexOf(lines, id) { return lines.findIndex((l) => l.includes(id)); }

function removeId(lines, id) {
  const src = lineIndexOf(lines, id);
  if (src >= 0) lines[src] = lines[src].filter((x) => x !== id);
  return src;
}

export function insertChrono(lineIds, id, startOf) {
  let pos = lineIds.findIndex((x) => startOf(x) > startOf(id));
  if (pos < 0) pos = lineIds.length;
  lineIds.splice(pos, 0, id);
}

// Move a word into an existing line (by index), placed at its time-position.
export function moveToLine(lines, id, targetIdx, startOf) {
  const src = lineIndexOf(lines, id);
  if (src < 0 || src === targetIdx || targetIdx < 0 || targetIdx >= lines.length) return lines;
  removeId(lines, id);
  insertChrono(lines[targetIdx], id, startOf);
  return lines;
}

// Put a word on its OWN new line, just before or after its current line.
export function moveToNewLine(lines, id, where /* 'before' | 'after' */) {
  const src = lineIndexOf(lines, id);
  if (src < 0 || lines[src].length < 2) return lines;   // a lone word is already its own line
  removeId(lines, id);
  lines.splice(where === 'after' ? src + 1 : src, 0, [id]);
  return lines;
}

// Arrow-move a word to the adjacent line; at the boundary it spills to a fresh line.
export function moveAdjacent(lines, id, dir /* -1 up, +1 down */, startOf) {
  const src = lineIndexOf(lines, id);
  if (src < 0) return lines;
  const tgt = src + dir;
  if (tgt >= 0 && tgt < lines.length) return moveToLine(lines, id, tgt, startOf);
  return moveToNewLine(lines, id, dir > 0 ? 'after' : 'before');
}

// Drop a word into an explicit empty-line slot anchored after `anchorId`'s line
// (anchorId === null means the very top).
export function fillEmpty(lines, anchorId, id) {
  const src = lineIndexOf(lines, id);
  if (src < 0) return lines;
  removeId(lines, id);
  let at;
  if (anchorId == null) at = 0;
  else { const ai = lines.findIndex((l) => l[l.length - 1] === anchorId); at = ai < 0 ? lines.length : ai + 1; }
  lines.splice(at, 0, [id]);
  return lines;
}

// Map every word id -> whether it starts a line (its .br flag), dropping empties.
export function toBrMap(lines) {
  const m = new Map();
  lines.filter((l) => l.length).forEach((l) => l.forEach((id, i) => m.set(id, i === 0)));
  return m;
}
