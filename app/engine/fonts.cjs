// Shared custom-font helper (CommonJS so both main.cjs `require` and server.mjs `import` can use it).
// Lets a user drop in a font FILE (.ttf/.otf/.woff/.woff2) and have it register everywhere —
// editor picker, live preview, AND the render — with no code edits. Built-in fonts are untouched;
// uploads live in a separate writable dir + a small JSON manifest (the single source of truth for
// user fonts). The real font-family name is read from the font's `name` table so the picker label
// matches what the glyphs actually declare (falls back to a cleaned filename).
const fs = require('fs');
const path = require('path');

const EXT_FMT = { '.ttf': 'truetype', '.otf': 'opentype', '.woff': 'woff', '.woff2': 'woff2' };

// ---- sfnt `name` table parser: pull the family name out of a TTF/OTF buffer ----
const u16 = (b, o) => b.readUInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);
function decodeUtf16be(buf, start, len) {
  let s = '';
  for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode((buf[start + i] << 8) | buf[start + i + 1]);
  return s;
}
function parseFamily(buf) {
  try {
    if (!buf || buf.length < 12) return null;
    const magic = buf.toString('latin1', 0, 4);
    if (magic === 'ttcf' || magic === 'wOFF' || magic === 'wOF2') return null; // collection / compressed: not plain sfnt
    const numTables = u16(buf, 4);
    let nameOff = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (rec + 16 > buf.length) break;
      if (buf.toString('latin1', rec, rec + 4) === 'name') { nameOff = u32(buf, rec + 8); break; }
    }
    if (nameOff < 0 || nameOff + 6 > buf.length) return null;
    const count = u16(buf, nameOff + 2);
    const strOff = nameOff + u16(buf, nameOff + 4);
    let best = null, bestScore = -1;
    for (let i = 0; i < count; i++) {
      const rec = nameOff + 6 + i * 12;
      if (rec + 12 > buf.length) break;
      const plat = u16(buf, rec), lang = u16(buf, rec + 4), nameID = u16(buf, rec + 6), len = u16(buf, rec + 8), off = u16(buf, rec + 10);
      if (nameID !== 1 && nameID !== 16) continue;        // 1 = Font Family, 16 = Typographic Family (preferred)
      const start = strOff + off;
      if (len <= 0 || start + len > buf.length) continue;
      let str = (plat === 3 || plat === 0) ? decodeUtf16be(buf, start, len) : buf.toString('latin1', start, start + len);
      str = str.replace(/\0/g, '').trim();
      if (!str) continue;
      let score = 0;
      if (nameID === 16) score += 4;        // prefer typographic family
      if (plat === 3) score += 2;           // prefer Windows platform
      if (lang === 0x409 || lang === 0) score += 1; // prefer en-US
      if (score > bestScore) { bestScore = score; best = str; }
    }
    return best;
  } catch { return null; }
}

function familyFromFilename(name) {
  let s = String(name || '').replace(/\.(ttf|otf|woff2?|ttc)$/i, '');
  s = s.replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return s || 'Custom Font';
}

const manifestPath = (dir) => path.join(dir, 'custom-fonts.json');
function readManifest(dir) {
  try { const m = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')); return Array.isArray(m) ? m : []; }
  catch { return []; }
}
function writeManifest(dir, arr) { fs.writeFileSync(manifestPath(dir), JSON.stringify(arr, null, 2)); }

const safeFileName = (name) => String(name || 'font').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'font';

// Save a font buffer into `dir`, register it in the manifest, return { family, file, format }.
// `familyOverride` (optional) wins over the parsed name.
function addFont(dir, origName, buf, familyOverride) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(origName || '').toLowerCase();
  if (!EXT_FMT[ext]) throw new Error('Unsupported font type "' + (ext || 'none') + '". Use .ttf, .otf, .woff or .woff2');
  if (!buf || !buf.length) throw new Error('Empty font file');
  const base = safeFileName(path.basename(origName || 'font', ext));
  let file = base + ext, n = 1;
  while (fs.existsSync(path.join(dir, file))) { file = base + '-' + n + ext; n++; }
  fs.writeFileSync(path.join(dir, file), buf);
  let family = (familyOverride && String(familyOverride).trim()) || parseFamily(buf) || familyFromFilename(origName);
  family = family.replace(/['"]/g, '').replace(/\s+/g, ' ').trim() || familyFromFilename(origName);
  const entry = { family, file, format: EXT_FMT[ext] };
  const man = readManifest(dir);
  const idx = man.findIndex((e) => e.family.toLowerCase() === family.toLowerCase());
  if (idx >= 0) man[idx] = entry; else man.push(entry);
  writeManifest(dir, man);
  return entry;
}

module.exports = { EXT_FMT, parseFamily, familyFromFilename, readManifest, writeManifest, addFont, manifestPath };
