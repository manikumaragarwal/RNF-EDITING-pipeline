// Fetch static ffmpeg + ffprobe for a target platform into vendor/ffmpeg/<os>-<arch>/,
// so electron-builder can bundle them (see package.json build.<os>.extraResources).
// GPL builds with libx264 + native AAC + the overlay filter — exactly what renderProject
// needs (no libass). Run per target: node scripts/fetch-ffmpeg.mjs --platform=linux --arch=x64
//
// Integrity: a pinned sha256 (when present) is checked for reproducibility; on mismatch
// we WARN (upstream "latest" builds rotate) but still gate on a FUNCTIONAL smoke check
// (the binary must actually expose aac + libx264 + overlay). Host-incompatible binaries
// (e.g. a win .exe fetched on linux) skip the run-check — validate those on their own OS.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const platform = arg('platform', process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux');
const arch = arg('arch', process.arch === 'arm64' ? 'arm64' : 'x64');
const triple = `${platform}-${arch}`;

// Each source lists one or more archives; ffmpeg+ffprobe are found by name after extraction.
// sha256:null = not pinned (script prints the fetched hash so you can pin it).
const SOURCES = {
  'linux-x64': [{ url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
    sha256: '18cb46c9c0d81d48cc9e1a3db6267a8dce36cab66abddfcc58c799d8acefe535' }],
  'win-x64': [{ url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', sha256: null }],
  // martin-riedl.de: per-arch mac builds (ad-hoc; afterPack ad-hoc-signs them anyway), ffmpeg + ffprobe separate
  'mac-arm64': [
    { url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip', sha256: null },
    { url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip', sha256: null }],
  'mac-x64': [
    { url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip', sha256: null },
    { url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffprobe.zip', sha256: null }],
};

const EXE = platform === 'win' ? '.exe' : '';
const outDir = path.join(ROOT, 'vendor', 'ffmpeg', triple);
const want = ['ffmpeg' + EXE, 'ffprobe' + EXE];

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name === name) return p;
  }
  return null;
}
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  if (archive.endsWith('.zip')) execFileSync('unzip', ['-o', '-q', archive, '-d', into], { stdio: 'inherit' });
  else execFileSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });   // tar handles .tar.xz
}

async function main() {
  const sources = SOURCES[triple];
  if (!sources) { console.error(`No ffmpeg source pinned for ${triple}. Add one to scripts/fetch-ffmpeg.mjs.`); process.exit(2); }
  if (want.every((n) => fs.existsSync(path.join(outDir, n)))) { console.log(`✓ ${triple} already present in ${outDir}`); return; }

  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffdl-'));
  for (const src of sources) {
    const archive = path.join(tmp, path.basename(new URL(src.url).pathname) || 'a.zip');
    console.log(`↓ ${src.url}`);
    await download(src.url, archive);
    const got = sha256(archive);
    if (src.sha256 && got !== src.sha256) console.warn(`⚠ sha256 mismatch for ${src.url}\n  pinned ${src.sha256}\n  got    ${got}\n  (upstream "latest" may have rotated — re-pin if you trust it)`);
    else console.log(`  sha256 ${got}${src.sha256 ? ' (matches pin)' : ' (not pinned)'}`);
    const ex = path.join(tmp, 'x-' + path.basename(archive));
    extract(archive, ex);
    for (const n of want) { const f = findFile(ex, n); if (f) fs.copyFileSync(f, path.join(outDir, n)); }
  }
  const missing = want.filter((n) => !fs.existsSync(path.join(outDir, n)));
  if (missing.length) { console.error(`✗ missing after fetch: ${missing.join(', ')}`); process.exit(3); }
  if (platform !== 'win') for (const n of want) fs.chmodSync(path.join(outDir, n), 0o755);

  // functional smoke check (only if the fetched binary can run on this host)
  const hostTriple = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (hostTriple === triple) {
    const ff = path.join(outDir, 'ffmpeg' + EXE);
    const enc = execFileSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    const fil = execFileSync(ff, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    const ok = /\baac\b/.test(enc) && /libx264/.test(enc) && /\boverlay\b/.test(fil);
    if (!ok) { console.error('✗ smoke check failed: ffmpeg lacks aac / libx264 / overlay'); process.exit(4); }
    console.log('✓ smoke check passed (aac + libx264 + overlay present)');
  } else {
    console.log(`(skipped run-check: ${triple} binary can't run on ${hostTriple} — validate on the target OS)`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ ffmpeg + ffprobe -> ${outDir}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
