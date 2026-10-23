// doctor.mjs: check everything the HyperFrames RNF pipeline needs on this machine.
//   node hf/doctor.mjs [--yt]      (--yt also runs a live YouTube search + 5s download test)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as L from './lib.mjs';

const rows = []; let bad = 0;
const ok = (name, good, detail, fix = '') => { rows.push(`${good ? 'OK  ' : 'FAIL'} ${name.padEnd(18)} ${detail}${!good && fix ? `\n     fix: ${fix}` : ''}`); if (!good) bad++; };
const ver = (cmd, args = ['--version']) => { try { const r = L.sh(cmd, args, { timeout: 60000 }); return r.status === 0 ? String(r.stdout || r.stderr).split('\n')[0].trim() : null; } catch { return null; } };
const W = L.IS_WIN;

const nodeMajor = parseInt(process.versions.node, 10);
ok('node', nodeMajor >= 20, process.versions.node, W ? 'winget install OpenJS.NodeJS.LTS' : 'install Node 20+');
const ffv = ver(L.FFMPEG, ['-version']); ok('ffmpeg', !!ffv, ffv || 'not found', W ? 'winget install Gyan.FFmpeg, then open a NEW terminal' : 'install ffmpeg');
const fpv = ver(L.FFPROBE, ['-version']); ok('ffprobe', !!fpv, fpv || 'not found', 'comes with ffmpeg');
const ytv = ver(process.env.YTDLP || 'yt-dlp');
const ytAgeDays = ytv && /^\d{4}\.\d{2}\.\d{2}/.test(ytv) ? (Date.now() - new Date(ytv.slice(0, 10).replace(/\./g, '-'))) / 864e5 : null;
ok('yt-dlp', !!ytv && (ytAgeDays == null || ytAgeDays < 60), ytv ? `${ytv}${ytAgeDays != null ? ` (${Math.round(ytAgeDays)} days old)` : ''}` : 'not found',
  ytv ? 'old builds fail on YouTube: yt-dlp -U  (or winget upgrade yt-dlp.yt-dlp)' : (W ? 'winget install yt-dlp.yt-dlp' : 'pip install -U yt-dlp'));
const hf = L.hyperframes(['--version'], process.cwd(), { capture: true });
const hfv = String(hf.stdout || '').trim().split('\n').pop();
ok('hyperframes', hf.status === 0, hf.status === 0 ? hfv : String(hf.stderr || '').slice(-200), 'needs internet for the first npx download');
ok('font', fs.existsSync(L.FONT), L.FONT, 'repo is incomplete: re-clone');
for (const f of ['Riser - 5.mp3', 'Cash Register 3.wav']) ok('sfx ' + f.split(' ')[0], fs.existsSync(path.join(L.SFX, f)), path.join(L.SFX, f));
const music = fs.existsSync(L.MUSIC_DIR) ? fs.readdirSync(L.MUSIC_DIR).filter((f) => /\.(mp3|wav|m4a|mp4|aac|ogg)$/i.test(f)) : [];
ok('music tracks', music.length > 0, `${music.length} in ${L.MUSIC_DIR}`, 'copy the licensed bg-music files in (see the README in that folder)');
ok('GROQ_API_KEY', !!process.env.GROQ_API_KEY, process.env.GROQ_API_KEY ? 'set' : 'not set (transcription falls back to local whisper.cpp)', 'free key at console.groq.com, put it in .env');
const cookies = fs.existsSync(L.SECRETS) ? fs.readdirSync(L.SECRETS).filter((f) => /^yt-cookies.*\.txt$/i.test(f)) : [];
rows.push(`info cookies            ${cookies.length ? cookies.length + ' cookies file(s) in ' + L.SECRETS : 'none (fine on a home connection; needed on servers/VPN)'}`);
rows.push(`info platform           ${process.platform} ${os.release()}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`);
if (/[^\x00-\x7F]/.test(L.REPO) || /\s/.test(L.REPO)) rows.push(`warn repo path         "${L.REPO}" has spaces/non-ASCII. Works, but a plain path like C:\\rnf is safer for ffmpeg/yt-dlp.`);

if (process.argv.includes('--yt') && ytv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rnf-yt-'));
  const ck = cookies.length ? ['--cookies', path.join(L.SECRETS, cookies[0])] : [];
  const s = L.sh(process.env.YTDLP || 'yt-dlp', [...ck, '--flat-playlist', '--print', '%(id)s', 'ytsearch1:minecraft gameplay no commentary'], { timeout: 90000 });
  const id = String(s.stdout || '').trim().split('\n')[0];
  ok('youtube search', !!id, id || String(s.stderr).split('\n').filter((l) => /ERROR/.test(l)).join(' ').slice(0, 300));
  if (id) {
    const d = L.sh(process.env.YTDLP || 'yt-dlp', [...ck, '--no-playlist', '--js-runtimes', 'node', '--remote-components', 'ejs:github', '-f', 'b[height<=480]/b',
      '--download-sections', '*10-15', '-o', path.join(tmp, 'probe.%(ext)s'), `https://www.youtube.com/watch?v=${id}`], { timeout: 300000 });
    const got = fs.readdirSync(tmp).some((f) => f.startsWith('probe.') && !f.endsWith('.part'));
    const err = String(d.stderr || '');
    const why = /not a bot|Sign in to confirm/i.test(err) ? 'YouTube bot-check: use a home connection or fresh cookies / --browser firefox'
      : /n challenge|nsig|reload/i.test(err) ? 'signature challenge: update yt-dlp, make sure `node` is on PATH'
        : /ffmpeg/i.test(err) ? 'ffmpeg not found by yt-dlp' : err.split('\n').filter((l) => /ERROR/.test(l)).join(' ').slice(0, 300);
    ok('youtube download', got, got ? '5s test clip downloaded' : why);
  }
}
console.log(rows.join('\n'));
console.log(bad ? `\n${bad} problem(s). Fix the FAIL lines, open a new terminal, run again.` : '\nAll good.');
process.exitCode = bad ? 1 : 0;
