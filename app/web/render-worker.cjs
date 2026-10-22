// Standalone headless-Electron render worker for the HOSTED web app. Same offscreen
// caption-capture + ffmpeg overlay as the desktop app's renderProject (verified), but
// driven from a job JSON so the web server can spawn it per render.
//   xvfb-run -a electron render-worker.cjs <job.json>   (env -u ELECTRON_RUN_AS_NODE)
// job.json = { project, style, ss?, dur?, out }   — emits @@PROGRESS {stage,pct} to stderr.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');
const fontsLib = require('../engine/fonts.cjs');
const CUSTOM_FONTS_DIR = path.join(__dirname, 'work', 'fonts');
const customFonts = () => fontsLib.readManifest(CUSTOM_FONTS_DIR).map((e) => ({ ...e, url: pathToFileURL(path.join(CUSTOM_FONTS_DIR, e.file)).href }));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const APP_ROOT = path.join(__dirname, '..');
const EXPORT_HTML = path.join(APP_ROOT, 'renderer', 'export.html');
const FFMPEG = process.env.CAP_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.CAP_FFPROBE || 'ffprobe';
const emit = (o) => process.stderr.write('@@PROGRESS ' + JSON.stringify(o) + '\n');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args); let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-1500)))));
  });
}
function probeNativeDims(v) {
  try {
    const d = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', v], { encoding: 'utf8' }).stdout.trim();
    const [w, h] = d.split('x').map(Number); if (w && h) return { w, h };
  } catch {}
  return { w: 1080, h: 1920 };
}
function probeDuration(v) {
  try { return parseFloat(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', v], { encoding: 'utf8' }).stdout.trim()) || 0; }
  catch { return 0; }
}

async function render(job) {
  const { project, style, out } = job;
  const alpha = !!job.alpha;   // export captions-only on transparent bg (ProRes 4444) for Premiere/AE
  const ss = job.ss || 0, dur = job.dur != null ? job.dur : null;
  const video = project.video;
  const nd = probeNativeDims(video);
  const fps = project.fps || 30;
  const length = dur != null ? dur : probeDuration(video) || 30;
  const clip = dur != null;
  const nFrames = Math.max(1, Math.round(length * fps));
  const framesDir = fs.mkdtempSync(path.join(path.dirname(out), 'frames-'));

  const w = new BrowserWindow({
    show: false, width: nd.w, height: nd.h, useContentSize: true, transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: false, sandbox: false },
  });
  w.webContents.setFrameRate(120);
  try {
    await w.loadFile(EXPORT_HTML);
    for (let i = 0; i < 100; i++) { if (await w.webContents.executeJavaScript('typeof window.__setup==="function" && typeof window.__seek==="function"')) break; await new Promise((r) => setTimeout(r, 30)); }
    await w.webContents.executeJavaScript('__fontsReady()');
    await w.webContents.executeJavaScript(`__setup(${JSON.stringify({ project: { ...project, __w: nd.w, __h: nd.h }, style, customFonts: customFonts() })})`);
    await w.webContents.executeJavaScript(`__seek(${ss})`);       // warm-up so frame 0 isn't blank
    await new Promise((r) => setTimeout(r, 250));
    for (let f = 0; f < nFrames; f++) {
      const t = ss + f / fps;
      await w.webContents.executeJavaScript(`__seek(${t})`);
      const img = await w.webContents.capturePage();
      fs.writeFileSync(path.join(framesDir, `cap_${String(f).padStart(5, '0')}.png`), img.toPNG());
      if (f % 5 === 0) emit({ stage: 'render', pct: Math.round((f / nFrames) * 100) });
    }
  } finally { w.destroy(); }
  emit({ stage: 'encode', pct: 99 });

  const args = ['-y'];
  if (alpha) {
    // captions ONLY -> ProRes 4444 straight-alpha .mov (PNG frames are already straight alpha).
    args.push('-framerate', String(fps), '-i', path.join(framesDir, 'cap_%05d.png'),
      '-vf', 'format=yuva444p10le',
      '-c:v', 'prores_ks', '-profile:v', '4444', '-alpha_bits', '16', '-vendor', 'apl0',
      '-movflags', '+faststart', out);
  } else {
    if (clip) args.push('-ss', String(ss), '-t', String(dur));
    args.push('-i', video, '-framerate', String(fps), '-i', path.join(framesDir, 'cap_%05d.png'),
      '-filter_complex', `[0:v]fps=${fps},setpts=PTS-STARTPTS[base];[1:v]setpts=PTS-STARTPTS[cap];[base][cap]overlay=0:0:shortest=1,format=yuv420p[v]`,
      '-map', '[v]', '-map', '0:a:0?',
      '-c:v', 'libx264', '-crf', '18', '-preset', clip ? 'veryfast' : 'medium',
      '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k', out);
  }
  await run(FFMPEG, args);
  fs.rmSync(framesDir, { recursive: true, force: true });
  emit({ stage: 'done', pct: 100 });
}

app.whenReady().then(async () => {
  try {
    const jobArg = process.argv.find((a) => a.endsWith('.json'));   // robust vs electron flags like --no-sandbox
    if (!jobArg) throw new Error('no job json arg');
    const job = JSON.parse(fs.readFileSync(jobArg, 'utf8'));
    await render(job);
    app.exit(0);
  } catch (e) { process.stderr.write('RENDER_ERROR ' + String(e && e.stack || e) + '\n'); app.exit(1); }
});
