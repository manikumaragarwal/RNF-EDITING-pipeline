// Captions Studio renderer. Kalakar-style editor: left captions list, center preview,
// right Text/Templates/Transitions tabs, bottom waveform timeline. Reuses the engine
// modules so the on-screen preview is identical to the burned output.
import { segment } from '../engine/segment.mjs';
import { autoHighlight } from '../engine/highlight.mjs';
import { toSRT } from '../engine/import.mjs';
import { buildScenes, renderCaption, renderKinetic } from '../engine/caption-dom.mjs';
import * as L from '../engine/lines.mjs';

const $ = (id) => document.getElementById(id);
const cap = window.cap;
const FONTS = [
  // newly added (Manish's list)
  'Luckiest Guy', 'Coolvetica', 'Helvetica', 'SF Pro Display', 'Thunderbolt',
  // impact / condensed
  'Anton', 'Bebas Neue', 'Oswald', 'Teko', 'Big Shoulders Display', 'Barlow Condensed', 'Roboto Condensed', 'Archivo Black', 'Archivo',
  // clean sans / workhorse
  'Inter', 'Poppins', 'Poppins ExtraBold', 'Poppins SemiBold', 'Montserrat', 'Outfit', 'Plus Jakarta Sans', 'Hanken Grotesk',
  // trendy display / grotesk
  'Space Grotesk', 'Sora', 'Bricolage Grotesque', 'Unbounded',
  // playful rounded
  'Fredoka', 'Baloo 2', 'Lilita One', 'Nunito', 'Paytone One',
  // editorial serif / italic accents
  'Playfair Italic', 'DM Serif Display', 'Fraunces', 'Instrument Serif', 'Bodoni Moda',
  // script / calligraphic (flowing italic — reference "Waller" style)
  'Allura', 'Alex Brush', 'Pinyon Script', 'Parisienne', 'Sacramento', 'Great Vibes', 'Satisfy', 'Kaushan Script', 'Dancing Script', 'Caveat',
  // brand
  'Tactic Sans',
];
const KIN_PRESETS = ['scale-punch', 'rise-blur', 'color-card', 'typewriter', 'word-swap', 'shake', 'highlighter-sweep'];

// ---- User-uploaded fonts: drop in a font file and it registers everywhere (picker + preview + render) ----
let customFonts = [];                                       // {family,file,format,url} from the backend
const fontFamilies = () => [...customFonts.map((f) => f.family), ...FONTS];
function injectCustomFontFaces() {
  let el = document.getElementById('cfFaces');
  if (!el) { el = document.createElement('style'); el.id = 'cfFaces'; document.head.appendChild(el); }
  el.textContent = customFonts.map((f) => `@font-face{font-family:'${String(f.family).replace(/'/g, '')}';src:url('${f.url}') format('${f.format || 'truetype'}');font-display:swap;}`).join('\n');
}
function rebuildFontSelect(selFamily) {
  const cur = selFamily || ($('fontSel') && $('fontSel').value);
  if (!$('fontSel')) return;
  $('fontSel').innerHTML = fontFamilies().map((f) => `<option value="${f}">${f}</option>`).join('');
  if (cur && fontFamilies().includes(cur)) $('fontSel').value = cur;
}
async function doAddFont() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.ttf,.otf,.woff,.woff2,font/*';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    setStatus('Adding font…');
    let r; try { r = await cap.uploadFont(f); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (!r || !r.ok) { setStatus(''); alert('Could not add font: ' + ((r && r.error) || 'unknown error')); return; }
    const font = r.font;
    customFonts = customFonts.filter((c) => c.family.toLowerCase() !== font.family.toLowerCase());
    customFonts.unshift(font);
    injectCustomFontFaces();
    rebuildFontSelect(font.family);
    try { await document.fonts.load(`32px '${font.family.replace(/'/g, '')}'`); } catch {}
    if (project) { $('fontSel').value = font.family; setOv('font', font.family); }
    setStatus('Added "' + font.family + '"');
  };
  inp.click();
}

let project = null, styles = [], styleMap = {}, byId = new Map(), nextId = 1, renderScenes = [], languages = [];
let nextKinId = 1, selKin = null;   // kinetic events: id counter + selected event id
let tlDrag = null, tlRaf = 0, tlRipple = false, tlSnapOn = true, suppressScrollClickUntil = 0;   // timeline drag
const DRAG_THRESH_PX = 4, MIN_DUR = 0.05, SNAP_PX = 6, AUTOSCROLL_EDGE = 32, AUTOSCROLL_STEP = 16;
let pxPerSec = 100;                         // timeline zoom
let selWords = new Set();                   // multi-select on the timeline (word ids)
let tlView = 'word';                        // timeline view: 'word' (per-word chips) | 'sentence' (per-scene chunks)
let tlSizeMode = 'normal';                  // timeline height: 'min' | 'normal' | 'tall'
let emptyLineAnchors = new Set();           // transient empty-line markers: anchor = last word id of the line above (null = top)
let unlocked = false, sel = null, uDrag = null;   // P4 layout editor: unlock flag, selection {kind,key|id}, active canvas drag
let playRaf = 0;                                   // 60fps preview loop while the video plays (animations need per-frame sampling)
const video = $('video');
const stage = () => $('vwrap');
const setStatus = (t) => ($('status').textContent = t);
// Center progress overlay (not the tiny side status) for transcribe/render.
let progressOn = false;
const showProgress = (title, sub = '') => { progressOn = true; $('progressTitle').textContent = title; $('progressSub').textContent = sub; $('progressBox').style.display = 'flex'; };
const setProgress = (title, sub) => { if (!progressOn) return; $('progressTitle').textContent = title; if (sub != null) $('progressSub').textContent = sub; };
const hideProgress = () => { progressOn = false; $('progressBox').style.display = 'none'; };

(async function boot() {
  const st = await cap.init();
  styles = st.styles; styleMap = Object.fromEntries(styles.map((s) => [s.id, s]));
  loadSavedTemplates().forEach((t) => { if (!styleMap[t.id]) { styles.push(t); styleMap[t.id] = t; } });   // device-local saved templates
  languages = st.languages || [{ id: 'english', label: 'English' }];
  const langOpts = languages.map((l) => `<option value="${l.id}">${l.label}</option>`).join('');
  $('langSel').innerHTML = langOpts; $('langSel2').innerHTML = langOpts;
  customFonts = st.customFonts || [];
  injectCustomFontFaces();
  $('fontSel').innerHTML = fontFamilies().map((f) => `<option value="${f}">${f}</option>`).join('');
  if ($('addFontBtn')) $('addFontBtn').onclick = doAddFont;
  bindStatic();
  syncScriptVis('langSel', 'scriptWrap', 'langHint');
  cap.onTranscribeProgress((d) => { const t = progressText(d); setStatus(t); setProgress(t, 'This runs on the server — hang tight.'); });
  cap.onRenderProgress((d) => { const t = `Rendering… ${d.pct || 0}%`; setStatus(t); setProgress(t, 'Burning captions into the video.'); });
  // Auto-update: silent background download; surface a "Restart" pill only once it's ready.
  if (cap.onUpdateStatus) cap.onUpdateStatus((d) => {
    const btn = $('updateBtn'); if (!btn) return;
    if (d.state === 'downloading') { setStatus(`downloading update… ${d.percent || 0}%`); }
    else if (d.state === 'ready') { btn.textContent = `⬆ Update ready${d.version ? ' (v' + d.version + ')' : ''} — Restart`; btn.style.display = ''; }
    else if (d.state === 'error') { console.log('update error:', d.message); }
  });
  if (cap.installUpdate) $('updateBtn').onclick = async () => { $('updateBtn').textContent = 'Restarting…'; await cap.installUpdate(); };
  setStatus('ready');
  if (new URLSearchParams(location.search).has('demo')) loadDemo();   // dev-only preview (?demo=1): mock project, no video needed
})();

// Dev affordance: load a synthetic project so the editor UI can be inspected without a real video.
async function loadDemo() {
  // A small, already-transcribed clip that ships with the app, so you can see caption/render
  // changes instantly without transcribing anything. Loaded as an ES module (works from file://
  // in the desktop app and over http on the web — no fetch(file://) issues).
  let demo;
  try { demo = JSON.parse(JSON.stringify((await import('../samples/demo.js')).default)); }
  catch (e) { console.warn('demo load failed', e); setStatus('Demo clip not found'); return; }
  demo.fileUrl = new URL('../samples/demo.mp4', import.meta.url).href;   // real video behind the captions
  demo.video = 'samples/demo.mp4';
  loadProject(demo);
  rebuild();   // render immediately; the real video's loadedmetadata will rebuild again once it's ready
  const q = new URLSearchParams(location.search);
  if (q.has('sel')) { selWords = new Set([5]); refreshSelectionUI(); }
  if (q.has('empty')) { const l = manualLines(); if (l[1]) addEmptyLine(l[1][l[1].length - 1]); }
  if (q.has('unlock')) {   // dev preview of the P4 layout editor (needs a sized preview surface)
    Object.assign(video.style, { width: '340px', height: '604px', background: '#141b27' });
    setUnlock(true);
    const s2 = renderScenes[1];
    if (s2 && q.has('moved')) project.lineStyles[s2.words[0].id] = { dx: 10, dy: -22, sizeScale: 1.3, color: '#ffd166' };
    if (s2 && q.has('wmove')) project.wordStyles[s2.words[1].id] = { wx: 16, wy: -32, sizeScale: 1.7, color: '#ffd166', bold: true };
    if (s2 && q.has('big')) project.wordStyles[s2.words[1].id] = { sizeScale: 2.0 };            // only enlarge (test: neighbours unaffected)
    if (s2 && q.has('inv')) project.wordStyles[s2.words[1].id] = { invert: true };
    if (s2 && q.get('font')) { project.lineStyles[s2.words[0].id] = { ...(project.lineStyles[s2.words[0].id] || {}), font: q.get('font') }; try { document.fonts.load(`40px "${q.get('font')}"`).then(() => renderOverlay(2.0)); } catch {} }
    if (s2) sel = q.has('word') ? { kind: 'word', id: s2.words[1].id, key: s2.words[0].id } : { kind: 'stack', key: s2.words[0].id };
    if (s2 && q.has('line')) { curLevel = 'line'; const ids = s2.words.map((w) => w.id); sel = { kind: 'line', key: s2.words[0].id, ids }; if (q.has('lstyle')) ids.forEach((id) => { project.wordStyles[id] = { color: '#7dd3fc', sizeScale: 1.25 }; }); }
    if (q.get('ct')) ctIcon = q.get('ct');
    renderLayoutPanel(); renderOverlay(2.0);
  }
}

window.__test = { loadProject: (p) => loadProject(p), previewNow: (ss, dur) => cap.preview(cleanProject(), ss, dur), words: () => project.words.map((w) => ({ text: w.text, start: w.start, end: w.end })), pps: () => pxPerSec };   // headless smoke hook (CAP_SMOKE)

function syncScriptVis(langId, wrapId, hintId) {
  const lang = $(langId).value;
  $(wrapId).style.display = lang === 'hindi' ? '' : 'none';
  if (hintId) {
    const map = {
      english: 'Fast local model. Best for English speech.',
      hindi: 'Devanagari, or Roman for the Hinglish look. Multilingual model (~250 MB, one time).',
      hinglish: 'Offline: Hindi speech in Roman letters, how creators type it. Multilingual model (~250 MB, one time).',
      'hinglish-ai': 'Most accurate for code-switched Hinglish. Gemini reads the words, Whisper keeps the timing. Needs a Gemini key (Settings); no key falls back to offline.',
      urdu: 'Urdu (Arabic script). Multilingual model (~250 MB, one time).',
    };
    $(hintId).textContent = map[lang] || '';
  }
}

// ---------- open / transcribe ----------
const progressText = (d) => {
  if (!d) return 'working…';
  if (d.stage === 'queued') { const who = d.busyWith === 'transcribe' ? 'transcribing' : 'exporting a video'; const pos = (d.position || 1) <= 1 ? "you're next" : `you're #${d.position} in line`; return `waiting — someone else is ${who}… (${pos})`; }
  if (d.stage === 'upload') return `uploading… ${d.pct || 0}%`;
  if (d.stage === 'extract') return 'extracting audio…';
  if (d.stage === 'download') return `downloading model… ${d.pct || 0}% (one time)`;
  if (d.stage === 'load') return 'loading model…';
  if (d.stage === 'ready') return 'model ready — transcribing…';
  if (d.stage === 'transcribe') return `transcribing ${d.seconds || ''}s…`;
  if (d.stage === 'gemini') return `Gemini transcribing… chunk ${d.i || 1}/${d.n || 1}`;
  if (d.stage === 'gemini-fallback') return 'Gemini unavailable — using offline Hinglish…';
  if (d.stage === 'align') return `aligning to audio… chunk ${d.i || 1}/${d.n || 1}`;
  if (d.stage === 'ctc-fallback') return 'aligner unavailable — timing from Whisper…';
  if (d.stage === 'render') return `rendering… ${d.pct || 0}%`;
  if (d.stage === 'encode') return 'encoding video…';
  if (d.stage === 'done') return 'finishing…';
  return 'working…';
};
let txCancelled = false;   // set by the Cancel button to abort an in-flight transcription/render result
function cancelOp() {
  txCancelled = true;
  hideProgress();
  setStatus('cancelled');
  if (!project) goHome();   // cancelling a fresh video's transcription -> back to the start screen
}
// Return to the start/welcome screen so you can pick a NEW video AND choose the transcription method
// (language / AI-Hinglish / local). Reverses loadProject's show/hide.
function goHome() {
  txCancelled = true;
  try { video.pause(); } catch {}
  stopPlayLoop();
  if (unlocked) toggleUnlock();
  project = null;
  hideProgress();
  $('welcome').style.display = '';
  $('vwrap').style.display = 'none'; $('pbar').style.display = 'none'; $('inspector').style.display = 'none';
  $('tlWrap').style.visibility = 'hidden';
  $('projName').textContent = '';
  for (const b of ['btnSrt', 'btnPreview', 'btnExport', 'btnExportAlpha', 'btnUnlock', 'btnHome']) $(b).disabled = true;
  setStatus('ready');
}
async function openVideo() {
  const pick = await cap.openVideo();
  if (!pick) return;
  // Web: the picker returns a File — run it through ingestFile so the "Uploading…" progress shows
  // (and the upload % streams in). Desktop: the picker returns { path } to a local file.
  if (cap.uploadFile) return ingestFile(pick);
  return runTranscribe(pick.path);
}
// Shared transcribe flow — from the file picker or from a drag-and-drop ingest.
async function runTranscribe(pathOrId) {
  txCancelled = false;
  try {
    setStatus('preparing…'); showProgress('Preparing…', 'Extracting audio');
    const r = await cap.transcribe(pathOrId, $('styleSel')?.value || project?.style || 'hormozi-active', $('langSel').value, $('scriptSel').value);
    if (txCancelled) return;                                   // user hit Cancel — drop the result
    if (!r || !r.ok) { setStatus('transcribe failed'); alert((r && r.error) || 'Transcription failed.'); return; }
    loadProject(r.project); setStatus('ready');
  } catch (e) { if (!txCancelled) { setStatus('transcribe failed'); alert('Could not transcribe: ' + (e && e.message || e)); } }
  finally { if (!txCancelled) hideProgress(); }
}
// Ingest a dropped video: desktop exposes file.path directly; web uploads the File first.
async function ingestFile(file) {
  if (!file) return;
  if (!/^video\//.test(file.type || '') && !/\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name || '')) { alert('Please drop a video file.'); return; }
  if (file.path) return runTranscribe(file.path);            // Electron gives a real fs path
  if (cap.uploadFile) {                                        // web: upload then transcribe by id
    try {
      showProgress('Uploading…', file.name || '');
      const up = await cap.uploadFile(file);
      if (up && up.path) return runTranscribe(up.path);
      hideProgress(); alert('Upload failed.');
    } catch (e) { hideProgress(); alert('Upload failed: ' + (e && e.message || e)); }
    return;
  }
  return openVideo();                                          // fallback: open the picker
}
async function reTranscribe() {
  if (!project) return;
  if (!confirm('Re-transcribe this video? Manual edits and highlights will be replaced.')) return;
  setStatus('re-transcribing…'); showProgress('Re-transcribing…', 'Extracting audio'); $('btnReTx').disabled = true; txCancelled = false;
  try {
    const r = await cap.transcribe(project.video, project.style, $('langSel2').value, $('scriptSel2').value);
    if (txCancelled) return;
    if (!r || !r.ok) { setStatus('transcribe failed'); alert((r && r.error) || 'failed'); return; }
    loadProject(r.project); setStatus('ready');
  } catch (e) { if (!txCancelled) { setStatus('failed'); alert('Re-transcribe failed: ' + (e && e.message || e)); } }
  finally { $('btnReTx').disabled = false; if (!txCancelled) hideProgress(); }
}
async function polishSpelling() {
  if (!project) return;
  setStatus('✨ polishing spelling…'); $('btnPolish').disabled = true;
  try {
    const r = await cap.polish(project.words.map((w) => ({ text: w.text })), project.language, project.script);
    if (!r || !r.ok) { setStatus('polish unavailable'); alert(r.error); if (/key/i.test(r.error || '')) $('btnSettings').click(); return; }
    project.words.forEach((w, i) => { if (r.words[i] != null) w.text = r.words[i]; });
    rebuild(); setStatus('✨ spelling polished');
  } catch (e) { setStatus('failed'); alert('Polish failed: ' + (e && e.message || e)); }
  finally { $('btnPolish').disabled = false; }
}

function loadProject(p) {
  project = p;
  selWords = new Set(); emptyLineAnchors = new Set();
  unlocked = false; sel = null; uDrag = null; document.body.classList.remove('unlocked');
  $('btnUnlock').classList.remove('on'); $('btnUnlock').textContent = '🔓 Unlock';
  project.styleOverrides = project.styleOverrides || {};
  project.segmentation = project.segmentation || (styleMap[project.style] || {}).segmentation || { mode: 'chars', max: 15 };
  project.autoHighlight = project.autoHighlight || { enabled: false, rules: [], keywords: [] };
  project.maxLines = project.maxLines || 2;
  project.language = project.language || 'english'; project.script = project.script || 'latin';
  project.kinetic = project.kinetic || [];
  project.lineStyles = project.lineStyles || {};    // per-line overrides (P4), keyed by line's first word id
  project.wordStyles = project.wordStyles || {};    // per-word typography (P4), keyed by word id
  nextKinId = 1; selKin = null;
  project.kinetic.forEach((e) => { if (e.id == null) e.id = nextKinId++; else nextKinId = Math.max(nextKinId, e.id + 1); });
  nextId = 1;
  project.words.forEach((w) => { w.id = nextId++; if (w.on === undefined) w.on = true; if (w.hi === undefined) w.hi = false; });
  if (project.autoHighlight.enabled) { autoHighlight(project.words, project.autoHighlight); project.autoHighlight.enabled = false; }
  $('projName').textContent = project.video.split('/').pop();
  video.src = project.fileUrl;
  $('welcome').style.display = 'none';
  $('vwrap').style.display = ''; $('pbar').style.display = ''; $('inspector').style.display = '';
  $('tlWrap').style.visibility = 'visible';
  for (const b of ['btnSrt', 'btnPreview', 'btnExport', 'btnExportAlpha', 'btnUnlock', 'btnHome']) $(b).disabled = false;
  $('langSel2').value = project.language; $('scriptSel2').value = project.script === 'roman' ? 'roman' : 'native';
  syncScriptVis('langSel2', 'scriptWrap2');
  $('btnPolish').style.display = project.language !== 'english' ? '' : 'none';
  renderTemplates();
  syncTextControls();
  syncTransitionControls();
  video.addEventListener('loadedmetadata', () => { if (!project.duration) project.duration = video.duration; rebuild(); }, { once: true });
  rebuild();
}

const mergedStyle = () => {
  const base = styleMap[project.style] || styles[0];
  const o = project.styleOverrides || {};
  const m = { ...base, ...o };
  if (base.box || o.box) m.box = { ...(base.box || {}), ...(o.box || {}) };
  if (base.position || o.position) m.position = { ...(base.position || {}), ...(o.position || {}) };
  if (base.outline || o.outline) m.outline = { ...(base.outline || {}), ...(o.outline || {}) };
  return m;
};

// ---------- Saved custom templates (localStorage: device-local, survives app updates) ----------
const TPL_KEY = 'capStudio.templates.v1';
function loadSavedTemplates() { try { const a = JSON.parse(localStorage.getItem(TPL_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function persistSavedTemplates(arr) { try { localStorage.setItem(TPL_KEY, JSON.stringify(arr)); } catch {} }
// Small cross-platform name dialog (window.prompt is disabled in Electron).
function promptName(def) {
  return new Promise((resolve) => {
    closeContextMenu();
    const m = document.createElement('div'); m.className = 'ctxMenu'; m.style.padding = '12px'; m.style.minWidth = '240px';
    const lbl = document.createElement('div'); lbl.style.cssText = 'font-size:12px;color:var(--dim);margin-bottom:7px'; lbl.textContent = 'Template name';
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = def || ''; inp.style.width = '100%';
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;margin-top:10px;justify-content:flex-end';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const ok = document.createElement('button'); ok.className = 'go'; ok.textContent = 'Save';
    row.append(cancel, ok); m.append(lbl, inp, row); document.body.appendChild(m);
    const r = m.getBoundingClientRect(); m.style.left = (innerWidth - r.width) / 2 + 'px'; m.style.top = Math.max(40, innerHeight / 3) + 'px';
    _ctxMenu = m;
    const done = (v) => { closeContextMenu(); resolve(v); };
    ok.onclick = () => done(inp.value.trim() || null);
    cancel.onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value.trim() || null); } else if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  });
}
async function saveAsTemplate() {
  if (!project) return;
  const name = await promptName('My template'); if (!name) return;
  const id = 'custom-' + Date.now().toString(36);
  const t = { ...mergedStyle(), id, label: name, custom: true }; delete t.stackStyleMap;
  const arr = loadSavedTemplates(); arr.push(t); persistSavedTemplates(arr);
  styles.push(t); styleMap[id] = t;
  project.style = id; project.styleOverrides = {};   // switch to the new template; its look is now baked in
  renderTemplates(); rebuild(); setStatus('Saved template "' + name + '"');
}
function deleteSavedTemplate(id) {
  persistSavedTemplates(loadSavedTemplates().filter((t) => t.id !== id));
  const i = styles.findIndex((s) => s.id === id); if (i >= 0) styles.splice(i, 1); delete styleMap[id];
  if (project && project.style === id) { project.style = (styles[0] && styles[0].id) || 'hormozi-active'; rebuild(); }
  renderTemplates();
}

// ---------- Resizable panes + collapsible inspector (persisted per device) ----------
function dragResize(handle, onMove, onEnd) {
  let x0 = 0, active = false, pid = null;
  handle.addEventListener('pointerdown', (e) => { active = true; x0 = e.clientX; pid = e.pointerId; try { handle.setPointerCapture(pid); } catch {} document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
  handle.addEventListener('pointermove', (e) => { if (!active || e.pointerId !== pid) return; const dx = e.clientX - x0; x0 = e.clientX; onMove(dx); });
  const end = () => { if (!active) return; active = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; onEnd && onEnd(); };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
}
function setupPanes() {
  const editor = document.querySelector('.editor'); const caps = document.querySelector('.caps'); const insp = $('inspector');
  if (!editor || !caps || !insp || editor._panes) return; editor._panes = true;
  const LS = localStorage;
  let leftW = +LS.getItem('capStudio.leftW') || 300;
  let rightW = +LS.getItem('capStudio.rightW') || 360;
  let collapsed = LS.getItem('capStudio.inspCollapsed') === '1';
  const apply = () => { editor.style.gridTemplateColumns = `${leftW}px minmax(0,1fr) ${collapsed ? 0 : rightW}px`; };
  const lh = document.createElement('div'); lh.className = 'paneResizer'; lh.style.right = '-3px'; caps.appendChild(lh);
  dragResize(lh, (dx) => { leftW = Math.max(200, Math.min(640, leftW + dx)); apply(); }, () => LS.setItem('capStudio.leftW', leftW));
  const rh = document.createElement('div'); rh.className = 'paneResizer'; rh.style.left = '-3px'; insp.appendChild(rh);
  dragResize(rh, (dx) => { rightW = Math.max(260, Math.min(680, rightW - dx)); apply(); }, () => LS.setItem('capStudio.rightW', rightW));
  const tabs = insp.querySelector('.tabs');
  const col = document.createElement('button'); col.className = 'inspCollapse'; col.title = 'Collapse panel'; col.textContent = '⟩'; if (tabs) tabs.appendChild(col);
  const reopen = document.createElement('button'); reopen.className = 'inspReopen'; reopen.title = 'Open panel'; reopen.textContent = '⟨'; document.body.appendChild(reopen);
  const sync = () => { reopen.style.display = collapsed ? 'block' : 'none'; insp.classList.toggle('isCollapsed', collapsed); apply(); };
  col.onclick = () => { collapsed = true; LS.setItem('capStudio.inspCollapsed', '1'); sync(); };
  reopen.onclick = () => { collapsed = false; LS.setItem('capStudio.inspCollapsed', '0'); sync(); };
  sync();
}
// Far-left Kalakar icon rail. Captions is the always-on primary view; Fonts/Library map to
// existing actions (custom-font upload / the Templates tab) so there's no dead UI.
function setupRail() {
  const fonts = $('railFonts'), lib = $('railLibrary'), caps = $('railCaptions');
  if (fonts) fonts.onclick = () => { const b = $('addFontBtn'); if (b) b.click(); };
  if (lib) lib.onclick = () => { const insp = $('inspector'); if (insp && insp.classList.contains('isCollapsed')) { const r = document.querySelector('.inspReopen'); if (r) r.click(); } switchTab('Templates'); };
  if (caps) caps.onclick = () => { const w = $('words'); if (w) w.scrollTop = 0; };
}
// Per-stack template override: resolve project.stackStyles (firstWordId -> style id) into a
// map of firstWordId -> full style object the engine swaps in for that one line. Rebuilt each
// render so it always reflects the current styleMap; the resolved map is never persisted.
function buildStackStyleMap() {
  const ss = project.stackStyles;
  if (!ss) return null;
  const map = {};
  for (const key in ss) { const st = styleMap[ss[key]]; if (st) map[key] = st; }
  return Object.keys(map).length ? map : null;
}
// The template id in effect for a given scene (per-stack override wins over the whole-video one).
const effStyleId = (sc) => (sc && project.stackStyles && project.stackStyles[sc.words[0].id]) || project.style;
const effIsStack = (sc) => ((styleMap[effStyleId(sc)] || {}).highlightMode === 'stack');
// The Focus stack template allows exactly ONE highlight per line: selecting a word makes it
// THE highlight (radio) — you can change it, but never remove it or add a second. Every other
// template free-toggles w.hi (any number of highlighted words).
function setHi(w, desired) {
  const sc = renderScenes.find((s) => s.words.some((x) => x.id === w.id));
  if (sc && effIsStack(sc)) {
    if (desired === false) return;                                  // can't clear the sole highlight
    sc.words.forEach((x) => { const o = byId.get(x.id); if (o) o.hi = (o.id === w.id); });
  } else { w.hi = desired; }
}
function refreshHi() {   // re-sync every view after a highlight change (radio may touch siblings)
  // Rebuild the scene copies the CANVAS renders from — segment() snapshots w.hi at build time,
  // so without this the new highlight (esp. the Focus-stack big word) never reaches the preview.
  renderScenes = buildScenes(project);
  const seg = { ...project.segmentation, manual: !!project.manualBreaks };
  renderList(segment(project.words.map((x) => ({ ...x, on: true })), seg));
  renderTimeline(); renderOverlay(video.currentTime || 0);
}

/* ---- Draft autosave + recovery (added 2026-09-29) ------------------------
   Captions Studio had no persistence of any kind: a refresh, a browser crash,
   or a server restart destroyed the entire caption pass. This saves the
   project to localStorage on a debounce and offers it back on the next load.
   localStorage can throw (private window, blocked site data), so every access
   is guarded and the app must work identically when it fails. */
const DRAFT_KEY = 'capstudio:draft:v1';
let draftTimer = null, lastDraftAt = 0;

function draftBadge(text, tone) {
  try {
    let el = document.getElementById('draftBadge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'draftBadge';
      el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;' +
        'font:12px/1.4 system-ui,sans-serif;padding:6px 10px;border-radius:4px;' +
        'background:rgba(20,24,28,.88);color:#dfe6e1;pointer-events:none;' +
        'transition:opacity .3s;opacity:0';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.color = tone === 'warn' ? '#ffc96b' : '#dfe6e1';
    el.style.opacity = '1';
    clearTimeout(el._fade);
    el._fade = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  } catch (e) { /* badge is cosmetic - never break the app for it */ }
}

function saveDraftNow() {
  if (!project) return;
  try {
    const payload = {
      savedAt: Date.now(),
      name: (project.name || project.file || 'untitled'),
      project: cleanProject(),
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    lastDraftAt = payload.savedAt;
    draftBadge('Saved ' + new Date(payload.savedAt).toLocaleTimeString());
  } catch (e) {
    // Quota exceeded, private window, or blocked storage. Say so once, keep working.
    draftBadge('Not saved - browser storage unavailable', 'warn');
  }
}

function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 1500);
  markEdit();
}

/* ---------- Undo / redo ---------------------------------------------------
   Snapshots DISTINCT project states on a short debounce (so a slider drag =
   one undo step, not 50). ctrl+z / ctrl+y. History auto-resets when a new
   project is loaded (detected by the `project` reference changing). The big
   `waveform` array is kept out of snapshots (it never changes). */
let _undo = [], _redo = [], _lastHist = null, _histTimer = 0, _histRef = null, _restoring = false;
function histState() { const p = { ...project }; delete p.waveform; return JSON.stringify(p); }
function histCapture() {
  if (!project || _restoring) return;
  const s = histState();
  if (s === _lastHist) return;
  if (_lastHist !== null) { _undo.push(_lastHist); if (_undo.length > 100) _undo.shift(); }
  _redo.length = 0; _lastHist = s; updateUndoButtons();
}
function markEdit() {
  if (_restoring || !project) return;
  if (project !== _histRef) { _histRef = project; _undo = []; _redo = []; _lastHist = histState(); updateUndoButtons(); return; }
  clearTimeout(_histTimer); _histTimer = setTimeout(histCapture, 450);
}
function applyHist(s) {
  _restoring = true;
  try {
    const keepWave = project.waveform;
    const p = JSON.parse(s);
    for (const k of Object.keys(project)) if (!(k in p) && k !== 'waveform') delete project[k];
    for (const k of Object.keys(p)) project[k] = p[k];
    project.waveform = keepWave;
    byId = new Map(project.words.map((w) => [w.id, w]));
    rebuild();
    [syncTextControls, syncTransitionControls, syncAnimateControls, syncEffectsControls].forEach((f) => { try { f(); } catch {} });
  } finally { _restoring = false; }
  _lastHist = s; updateUndoButtons();
}
function undo() { if (!_undo.length) return; clearTimeout(_histTimer); _redo.push(histState()); applyHist(_undo.pop()); setStatus('Undo'); }
function redo() { if (!_redo.length) return; clearTimeout(_histTimer); _undo.push(histState()); applyHist(_redo.pop()); setStatus('Redo'); }
function updateUndoButtons() { const u = $('undoBtn'), r = $('redoBtn'); if (u) u.disabled = !_undo.length; if (r) r.disabled = !_redo.length; }

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
}

/* Offer the draft back. Called once at boot. */
function offerDraftRecovery() {
  const d = readDraft();
  if (!d || !d.project || !d.project.words || !d.project.words.length) return;
  const age = Date.now() - (d.savedAt || 0);
  if (age > 1000 * 60 * 60 * 24 * 7) { clearDraft(); return; }  // a week old, let it go

  try {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:10000;' +
      'display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;' +
      'padding:10px 16px;background:#1F6F5C;color:#fff;' +
      'font:14px/1.4 system-ui,sans-serif;box-shadow:0 1px 6px rgba(0,0,0,.25)';
    const when = new Date(d.savedAt).toLocaleString();
    const msg = document.createElement('span');
    msg.textContent = 'Unsaved work found from ' + when + ' (' + d.name + ').';
    const yes = document.createElement('button');
    yes.textContent = 'Restore it';
    yes.style.cssText = 'font:inherit;padding:5px 12px;border:0;border-radius:3px;cursor:pointer;background:#fff;color:#1F6F5C;font-weight:600';
    const no = document.createElement('button');
    no.textContent = 'Discard';
    no.style.cssText = 'font:inherit;padding:5px 12px;border:1px solid rgba(255,255,255,.6);border-radius:3px;cursor:pointer;background:transparent;color:#fff';
    yes.onclick = () => {
      try {
        project = d.project;
        nextId = Math.max(0, ...project.words.map((w) => w.id || 0)) + 1;
        rebuild();
        bar.remove();
        draftBadge('Restored');
      } catch (e) {
        msg.textContent = 'That draft could not be opened. It has been kept, not deleted.';
        yes.remove();
      }
    };
    no.onclick = () => { clearDraft(); bar.remove(); };
    bar.appendChild(msg); bar.appendChild(yes); bar.appendChild(no);
    document.body.appendChild(bar);
  } catch (e) { /* never block startup */ }
}

/* Warn before losing work that has not hit the debounce yet. */
window.addEventListener('beforeunload', (e) => {
  if (project && Date.now() - lastDraftAt > 2000) {
    e.preventDefault();
    e.returnValue = '';
  }
});

try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', offerDraftRecovery, { once: true });
  } else {
    setTimeout(offerDraftRecovery, 0);
  }
} catch (e) {}


function rebuild() {
  saveDraftSoon();
  byId = new Map(project.words.map((w) => [w.id, w]));
  renderScenes = buildScenes(project);
  const seg = { ...project.segmentation, manual: !!project.manualBreaks };
  const listScenes = segment(project.words.map((w) => ({ ...w, on: true })), seg);
  renderList(listScenes);
  renderTimeline();          // also renders the kinetic timeline track
  renderKineticList();
  renderOverlay(video.currentTime || 0);
}

// ---------- captions list (left) ----------
function emptyLineRow(anchorId) {
  const row = document.createElement('div'); row.className = 'scene emptyline';
  row.innerHTML = '<span class="rm" title="remove this empty line">×</span><span>Empty line — drag a word here (or select one and press the arrows)</span>';
  row.querySelector('.rm').onclick = () => { emptyLineAnchors.delete(anchorId); rebuild(); };
  row.ondragover = (e) => { e.preventDefault(); row.classList.add('dragover'); };
  row.ondragleave = () => row.classList.remove('dragover');
  row.ondrop = (e) => { e.preventDefault(); row.classList.remove('dragover'); const id = +e.dataTransfer.getData('text/plain'); if (id) fillEmptyLine(anchorId, id); };
  return row;
}
function renderList(scenes) {
  const host = $('words'); host.innerHTML = '';
  // drop empty-line markers whose anchor word no longer exists
  for (const a of [...emptyLineAnchors]) if (a != null && !byId.has(a)) emptyLineAnchors.delete(a);
  if (emptyLineAnchors.has(null)) host.appendChild(emptyLineRow(null));
  scenes.forEach((sc, si) => {
    const srcWords = sc.words.map((w) => byId.get(w.id)).filter(Boolean);
    const allOff = srcWords.every((w) => w.on === false);
    const lastId = srcWords.length ? srcWords[srcWords.length - 1].id : null;
    const div = document.createElement('div');
    div.className = 'scene' + (allOff ? ' off' : ''); div.dataset.start = sc.start; div.dataset.idx = si;
    const head = document.createElement('div'); head.className = 'sh';
    head.innerHTML = `<input type="checkbox" ${allOff ? '' : 'checked'} title="include line"/><span>${fmt(sc.start)} → ${fmt(sc.end)}</span><span class="grow"></span><span class="addline" title="Add an empty line below this one">＋ line</span><span>${srcWords.length}w</span>`;
    head.querySelector('input').onchange = (e) => { srcWords.forEach((w) => (w.on = e.target.checked)); rebuild(); };
    head.querySelector('.addline').onclick = () => addEmptyLine(lastId);
    div.appendChild(head);
    const chips = document.createElement('div'); chips.className = 'chips';
    srcWords.forEach((w) => chips.appendChild(chip(w)));
    const add = document.createElement('span'); add.className = 'chip'; add.style.cursor = 'pointer'; add.innerHTML = '<span class="add">+ word</span>';
    add.onclick = () => addWordAfter(srcWords[srcWords.length - 1]);
    chips.appendChild(add); div.appendChild(chips);
    // drop target: move a dragged word into this line
    div.ondragover = (e) => { e.preventDefault(); div.classList.add('dragover'); };
    div.ondragleave = () => div.classList.remove('dragover');
    div.ondrop = (e) => { e.preventDefault(); div.classList.remove('dragover'); const id = +e.dataTransfer.getData('text/plain'); if (id) moveWordToLine(id, si); };
    host.appendChild(div);
    if (lastId != null && emptyLineAnchors.has(lastId)) host.appendChild(emptyLineRow(lastId));
  });
}
function chip(w) {
  const el = document.createElement('span');
  el.className = 'chip' + (w.hi ? ' hi' : '') + (w.on === false ? ' off' : '');
  el.dataset.id = w.id;
  el.draggable = true;
  // Don't start a chip drag when the gesture begins on the ✎ edit or × delete glyph (a click with
  // a little movement would otherwise move the word to another line instead of editing/deleting).
  el.ondragstart = (e) => { if (t.isContentEditable || e.target === ed || e.target === x) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', String(w.id)); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); };
  el.ondragend = () => el.classList.remove('dragging');
  el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); wordMenu(w, e.clientX, e.clientY); };
  const t = document.createElement('span'); t.textContent = w.text; t.title = 'click: highlight · ✎ edit text · drag: move to another line · right-click: make kinetic';
  // Editing a word's text goes through the ✎ pencil ONLY — it's discoverable and side-effect-free.
  // (A double-click can't be used: the two clicks that precede it toggle the highlight and rebuild
  // the chip list, detaching this node before the dblclick would fire.)
  const enterEdit = (e) => { if (e) e.stopPropagation(); el.draggable = false; t.contentEditable = 'true'; t.focus(); document.getSelection().selectAllChildren(t); };
  t.addEventListener('click', (e) => { if (t.isContentEditable) return; e.stopPropagation(); wordMenu(w, e.clientX, e.clientY); });
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } if (e.key === 'Escape') { t.textContent = w.text; t.blur(); } });
  t.addEventListener('blur', () => { t.contentEditable = 'false'; el.draggable = true; const v = t.textContent.trim(); if (v && v !== w.text) { w.text = v; rebuild(); } else { t.textContent = w.text; } });
  const ed = document.createElement('span'); ed.className = 'ed'; ed.textContent = '✎'; ed.title = 'edit text';
  ed.onclick = enterEdit;
  const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = 'delete';
  x.onclick = () => { const i = project.words.indexOf(w); if (i >= 0) project.words.splice(i, 1); rebuild(); };
  el._edit = enterEdit; el.appendChild(t); el.appendChild(ed); el.appendChild(x); return el;
}

// ---------- Reusable floating context menu (word list + timeline) ----------
let _ctxMenu = null;
function closeContextMenu() {
  if (!_ctxMenu) return;
  _ctxMenu.remove(); _ctxMenu = null;
  document.removeEventListener('pointerdown', _ctxOutside, true);
  document.removeEventListener('keydown', _ctxKey, true);
}
function _ctxOutside(e) { if (_ctxMenu && !_ctxMenu.contains(e.target)) closeContextMenu(); }
function _ctxKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeContextMenu(); } }
function showContextMenu(items, x, y) {
  closeContextMenu();
  const m = document.createElement('div'); m.className = 'ctxMenu';
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctxSep'; m.appendChild(s); return; }
    const b = document.createElement('div'); b.className = 'ctxItem' + (it.danger ? ' danger' : '');
    b.innerHTML = `<span>${it.label}</span>` + (it.sub ? `<span class="ctxSub">${it.sub}</span>` : '');
    b.onclick = () => { closeContextMenu(); try { it.action(); } catch (e) {} };
    m.appendChild(b);
  });
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 8)) + 'px';
  _ctxMenu = m;
  setTimeout(() => { document.addEventListener('pointerdown', _ctxOutside, true); document.addEventListener('keydown', _ctxKey, true); }, 0);
}
function wordMenu(w, x, y) {
  if (!w) return;
  const editChip = () => { const el = document.querySelector(`#words .chip[data-id="${w.id}"]`); if (el && el._edit) el._edit(); };
  showContextMenu([
    { label: w.hi ? 'Remove emphasis' : 'Emphasize', sub: 'Highlight', action: () => { setHi(w, !w.hi); refreshHi(); markEdit(); } },
    { label: 'Spotlight', sub: 'Make kinetic', action: () => makeKineticFromWord(w) },
    { label: 'Edit text', action: editChip },
    { sep: true },
    { label: 'Split line here', sub: 'New line at this word', action: () => { ensureManual(); w.br = true; rebuild(); } },
    { label: 'Move to previous line', action: () => moveWordAdjacent(w.id, -1) },
    { label: 'Move to next line', action: () => moveWordAdjacent(w.id, 1) },
    { label: (w.on === false ? 'Enable word' : 'Disable word'), action: () => { w.on = !(w.on === false) ? false : true; rebuild(); } },
    { sep: true },
    { label: 'Search & replace', action: () => { toggleFind(true); $('findInp').value = w.text; runFind(); } },
    { label: 'Delete word', danger: true, action: () => { const i = project.words.indexOf(w); if (i >= 0) project.words.splice(i, 1); rebuild(); } },
  ], x, y);
}
function addWordAfter(w) {
  if (!w) return;
  const i = project.words.indexOf(w);
  const nextStart = project.words[i + 1] ? project.words[i + 1].start : w.end + 0.4;
  project.words.splice(i + 1, 0, { id: nextId++, text: 'word', start: w.end, end: Math.min(w.end + 0.3, nextStart), hi: false, on: true, br: false });
  rebuild();
}

// ---------- move a word between lines (manual line-break model) ----------
function ensureManual() {
  if (project.manualBreaks) return;
  const scenes = segment(project.words, project.segmentation);
  const starts = new Set(scenes.map((s) => s.words[0].id));
  project.words.forEach((w) => { w.br = starts.has(w.id); });
  project.manualBreaks = true;
}
// The manual line model as arrays of word-ids, in current order. All structural edits
// go through the pure engine/lines.mjs helpers (unit-tested); commitLines writes back.
function manualLines() {
  ensureManual();
  return segment(project.words, { manual: true }).map((s) => s.words.map((w) => w.id));
}
const startOf = (id) => { const w = byId.get(id); return w ? w.start : 0; };
// Rewrite project.words + the .br flags from a lines[] structure, then rebuild.
// manualLines() comes from segment(), which drops off/blank words — so re-insert any word
// NOT in `lines` at its time position, else an unchecked line would be permanently lost.
function commitLines(lines) {
  const brMap = L.toBrMap(lines);
  const inLines = new Set(lines.flat());
  const rebuilt = lines.filter((l) => l.length).flat().map((id) => { const w = byId.get(id); w.br = brMap.get(id); return w; });
  for (const w of project.words) {
    if (inLines.has(w.id)) continue;                 // already placed
    let at = rebuilt.findIndex((x) => x.start > w.start);
    if (at < 0) at = rebuilt.length;
    rebuilt.splice(at, 0, w);                          // keep dropped (off) words at their time slot
  }
  project.words = rebuilt;
  rebuild();
}
function moveWordToLine(wordId, targetIdx) { commitLines(L.moveToLine(manualLines(), wordId, targetIdx, startOf)); }
function moveWordAdjacent(wordId, dir) { commitLines(L.moveAdjacent(manualLines(), wordId, dir, startOf)); }
function fillEmptyLine(anchorWordId, wordId) { emptyLineAnchors.delete(anchorWordId); commitLines(L.fillEmpty(manualLines(), anchorWordId, wordId)); }
function addEmptyLine(anchorWordId /* last word id of the line to insert after, or null for top */) {
  ensureManual();
  emptyLineAnchors.add(anchorWordId ?? null);
  rebuild();
}
function addEmptyLineAtEnd() {
  if (!project) return;
  const lines = manualLines();
  const last = lines[lines.length - 1];
  addEmptyLine(last ? last[last.length - 1] : null);
}
function depunct() {
  if (!project) return;
  // Capture sentence ends BEFORE stripping. Sentence-mode segmentation (e.g. Leo's Pride World)
  // splits ONLY on sentence-ending punctuation; removing it blindly collapses the whole video
  // into one caption. w.sentEnd preserves the boundary so segmentation is unchanged by depunct.
  const SENT_END = /[.!?…]["'”’)\]]*$/;   // sentence ender + any run of closing quotes/brackets
  const kept = [];
  for (const w of project.words) {
    const endsHere = SENT_END.test(String(w.text));
    w.text = String(w.text).replace(/[.,!?;:"'“”‘’()\[\]{}…]+/g, '').trim();
    if (w.text === '') {
      // a punctuation-only token that ended a sentence: hand the boundary to the previous word.
      if (endsHere && kept.length) kept[kept.length - 1].sentEnd = true;
      continue;
    }
    if (endsHere) w.sentEnd = true;
    kept.push(w);
  }
  project.words = kept;
  rebuild();
}

// ---------- live overlay (SAME renderer as export) ----------
function renderOverlay(t) {
  if (!project) return;
  const s = mergedStyle();
  if (video && video.duration && isFinite(video.duration)) project.duration = video.duration;   // for the brand end-tag
  project.stackStyleMap = buildStackStyleMap();     // per-stack template overrides (transient)
  renderCaption(stage(), renderScenes, s, t, project);
  renderKinetic(stage(), project, s, t);
  const tt = t + (s.offset || 0) + (project.offset || 0);
  const sc = renderScenes.find((x) => tt >= x.start && tt < x.end + (s.tail || 0.06));
  document.querySelectorAll('.scene').forEach((el) => el.classList.toggle('active', !!sc && Math.abs(+el.dataset.start - sc.start) < 0.001));
  document.querySelectorAll('.tlword').forEach((el) => { const w = byId.get(+el.dataset.id); el.classList.toggle('active', !!w && tt >= w.start && tt <= w.end); });
  if (unlocked) decorateUnlock();
}

// 60fps preview loop. video.ontimeupdate only fires ~4x/sec — far too coarse for the ~200ms
// entrance/word animations (they'd pop in fully-formed, which is why they "didn't work").
// While playing we sample renderCaption every animation frame, so preview == the burned export.
let lastOverlayMs = 0;   // throttle the live caption rebuild to ~33fps (was every rAF); export still renders every frame
function playFrame() {
  if (video.paused || video.ended) { playRaf = 0; return; }
  const t = video.currentTime;
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (now - lastOverlayMs >= 30) { renderOverlay(t); lastOverlayMs = now; }   // caption re-render, throttled
  updatePlayhead(t);                                                          // playhead move is cheap — every frame
  $('seek').value = Math.round((t / (video.duration || 1)) * 1000);
  $('tlabel').textContent = `${t.toFixed(2)} / ${(video.duration || 0).toFixed(2)}`;
  playRaf = requestAnimationFrame(playFrame);
}
function startPlayLoop() { if (!playRaf) playRaf = requestAnimationFrame(playFrame); }
function stopPlayLoop() { if (playRaf) { cancelAnimationFrame(playRaf); playRaf = 0; } }
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.floor((t % 1) * 100)).padStart(2, '0')}`;

// ---------- timeline (bottom) ----------
const tlDur = () => project.duration || (project.words.length ? project.words[project.words.length - 1].end + 0.5 : 10);
const MV_BTNS = '<div class="tlw-mv l" title="Move to previous line (Alt+←)">◀</div><div class="tlw-mv r" title="Move to next line (Alt+→)">▶</div>';
// Refresh selection outlines + the single-word move arrows without a full rebuild.
function refreshSelectionUI() {
  const single = selWords.size === 1 ? [...selWords][0] : null;
  document.querySelectorAll('#tlWords .tlword').forEach((el) => {
    if (el.classList.contains('tlscene')) {   // sentence chunk = selected when all its words are
      const ids = (el.dataset.ids || '').split(',').filter(Boolean).map(Number);
      el.classList.toggle('sel', ids.length > 0 && ids.every((i) => selWords.has(i)));
      return;
    }
    const id = +el.dataset.id;
    el.classList.toggle('sel', selWords.has(id));
    el.querySelectorAll('.tlw-mv').forEach((b) => b.remove());
    if (id === single) el.insertAdjacentHTML('beforeend', MV_BTNS);
  });
}
// Smooth, gradient-filled mirrored waveform (a real "wave", not square bars).
function drawWave(ctx, W, H, peaks) {
  if (!peaks || !peaks.length) return;
  const mid = H * 0.55, amp = H * 0.42, step = 2;
  const top = [], bot = [];
  for (let x = 0; x <= W; x += step) {
    const p = peaks[Math.min(peaks.length - 1, Math.floor((x / W) * peaks.length))] || 0;
    const h = Math.max(0.8, p * amp);
    top.push([x, mid - h]); bot.push([x, mid + h]);
  }
  const smooth = (pts, forward) => {
    const seq = forward ? pts : pts.slice().reverse();
    ctx.lineTo(seq[0][0], seq[0][1]);
    for (let i = 1; i < seq.length; i++) { const [x, y] = seq[i]; const [px, py] = seq[i - 1]; ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2); }
  };
  const g = ctx.createLinearGradient(0, mid - amp, 0, mid + amp);
  g.addColorStop(0, 'rgba(130,170,235,.40)'); g.addColorStop(0.5, 'rgba(130,170,235,.14)'); g.addColorStop(1, 'rgba(130,170,235,.40)');
  ctx.beginPath(); ctx.moveTo(top[0][0], top[0][1]); smooth(top, true); smooth(bot, false); ctx.closePath();
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.moveTo(top[0][0], top[0][1]); smooth(top, true);
  ctx.strokeStyle = 'rgba(150,185,240,.55)'; ctx.lineWidth = 1.25; ctx.stroke();
}

function renderTimeline() {
  if (!project) return;
  const dur = tlDur();
  const W = Math.max(600, Math.ceil(dur * pxPerSec));
  $('tlInner').style.width = W + 'px';
  const cv = $('tlWave'); const H = $('tlScroll').clientHeight || 150;
  cv.width = W; cv.height = H; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const peaks = project.waveform || [];
  drawWave(ctx, W, H, peaks);
  const host = $('tlWords'); host.innerHTML = '';
  const single = selWords.size === 1 ? [...selWords][0] : null;
  if (tlView === 'sentence') {
    // One chunk per caption line (scene). Click selects the whole line + seeks; box-select still works.
    for (const sc of renderScenes) {
      const ids = sc.words.map((w) => w.id);
      const el = document.createElement('div');
      el.className = 'tlword tlscene' + (sc.words.some((w) => w.hi) ? ' hi' : '') + (ids.length && ids.every((i) => selWords.has(i)) ? ' sel' : '');
      el.dataset.ids = ids.join(','); el.dataset.start = sc.start;
      el.style.left = (sc.start * pxPerSec) + 'px';
      el.style.width = Math.max(28, (sc.end - sc.start) * pxPerSec - 2) + 'px';
      el.textContent = sc.words.map((w) => w.text).join(' ');
      el.title = `${el.textContent}  (${sc.start.toFixed(2)}–${sc.end.toFixed(2)}s) · click to select this line · shift-click to add`;
      host.appendChild(el);
    }
  } else {
    for (const w of project.words) {
      const el = document.createElement('div'); el.className = 'tlword' + (w.hi ? ' hi' : '') + (selWords.has(w.id) ? ' sel' : ''); el.dataset.id = w.id;
      positionChip(el, w);
      el.textContent = w.text; el.title = `${w.text}  (${w.start.toFixed(2)}–${w.end.toFixed(2)}s) · click to select · drag to retime · shift-click to multi-select`;
      if ((w.end - w.start) * pxPerSec < 24) el.classList.add('narrow');   // too small to split into zones
      else el.insertAdjacentHTML('beforeend', '<div class="tlw-edge l"></div><div class="tlw-edge r"></div>');
      if (w.id === single) el.insertAdjacentHTML('beforeend', MV_BTNS);
      host.appendChild(el);   // pointer handling is delegated on #tlWords (see bindStatic)
    }
  }
  renderSceneBars();
  $('tlInfo').textContent = `${dur.toFixed(1)}s · ${project.words.length} words · ${renderScenes.length} lines`;
  renderKineticTrack();
  updatePlayhead(video.currentTime || 0);
}
function positionChip(el, w) {
  el.style.left = (w.start * pxPerSec) + 'px';
  el.style.width = Math.max(14, (w.end - w.start) * pxPerSec - 2) + 'px';
}
function renderSceneBars() {
  const lines = $('tlLines'); if (!lines) return; lines.innerHTML = '';
  for (const sc of renderScenes) {
    const el = document.createElement('div'); el.className = 'tlline';
    el.style.left = (sc.start * pxPerSec) + 'px'; el.style.width = Math.max(8, (sc.end - sc.start) * pxPerSec) + 'px';
    lines.appendChild(el);
  }
}

// ---------- timeline drag-to-retime ----------
function buildSnaps(word) {
  const s = new Set([0]);
  for (const w of project.words) { if (w === word) continue; s.add(+w.start.toFixed(3)); s.add(+w.end.toFixed(3)); }
  s.add(+(video.currentTime || 0).toFixed(3));
  return [...s].sort((a, b) => a - b);
}
function snapTime(t) {
  if (!tlSnapOn || (tlDrag && tlDrag.alt)) { $('tlSnap').style.display = 'none'; return t; }
  const snaps = tlDrag ? tlDrag.snaps : []; let best = null, bd = Infinity;
  for (const c of snaps) { const d = Math.abs(t - c); if (d < bd) { bd = d; best = c; } }
  if (best != null && bd <= SNAP_PX / pxPerSec) { $('tlSnap').style.left = (best * pxPerSec) + 'px'; $('tlSnap').style.display = 'block'; return best; }
  $('tlSnap').style.display = 'none'; return t;
}
function rippleShift(from, dt) { for (let j = from; j < project.words.length; j++) { project.words[j].start += dt; project.words[j].end += dt; } }
// ---------- Timeline height: shrink (video full height) / normal / expand ----------
function applyTlSize() {
  const rows = tlSizeMode === 'min' ? '52px 1fr 44px'
             : tlSizeMode === 'tall' ? '52px 1fr 46vh'
             : '52px 1fr 214px';
  document.body.style.gridTemplateRows = rows;
  document.body.classList.toggle('tl-min', tlSizeMode === 'min');
  document.body.classList.toggle('tl-tall', tlSizeMode === 'tall');
  const sc = $('tlScroll'); if (sc) sc.style.display = tlSizeMode === 'min' ? 'none' : '';
  try { localStorage.setItem('capStudio.tlSize', tlSizeMode); } catch {}
  const ex = $('tlExpand'), sh = $('tlShrink');
  if (ex) ex.disabled = tlSizeMode === 'tall';
  if (sh) sh.disabled = tlSizeMode === 'min';
  if (project && tlSizeMode !== 'min') { renderTimeline(); renderOverlay(video.currentTime || 0); }
}
// ---------- Timeline rubber-band box-select ----------
let tlBox = null;
function startBoxSelect(e) {
  if (!project) return;
  const rect = $('tlInner').getBoundingClientRect();
  tlBox = { x0: e.clientX, y0: e.clientY, rectLeft: rect.left, additive: e.shiftKey || e.ctrlKey || e.metaKey, base: new Set(selWords), moved: false, el: null };
  window.addEventListener('pointermove', boxMove);
  window.addEventListener('pointerup', boxUp);
}
function boxMove(e) {
  if (!tlBox) return;
  if (!tlBox.moved && Math.abs(e.clientX - tlBox.x0) < 4 && Math.abs(e.clientY - tlBox.y0) < 4) return;
  if (!tlBox.moved) {
    tlBox.moved = true;
    tlBox.el = document.createElement('div'); tlBox.el.className = 'tlSelBox'; $('tlWords').appendChild(tlBox.el);
    document.body.style.userSelect = 'none';
  }
  const l = Math.min(tlBox.x0, e.clientX) - tlBox.rectLeft, r = Math.max(tlBox.x0, e.clientX) - tlBox.rectLeft;
  tlBox.el.style.left = l + 'px'; tlBox.el.style.width = Math.max(0, r - l) + 'px';
  const tA = l / pxPerSec, tB = r / pxPerSec;
  const inRange = project.words.filter((w) => w.end >= tA && w.start <= tB).map((w) => w.id);
  selWords = new Set(tlBox.additive ? [...tlBox.base, ...inRange] : inRange);
  refreshSelectionUI();
}
function boxUp() {
  window.removeEventListener('pointermove', boxMove);
  window.removeEventListener('pointerup', boxUp);
  if (tlBox) { if (tlBox.el) tlBox.el.remove(); if (tlBox.moved) suppressScrollClickUntil = performance.now() + 250; document.body.style.userSelect = ''; }
  tlBox = null;
}
// Bulk actions on the current timeline selection (right-click).
function timelineSelMenu(x, y) {
  const ids = [...selWords];
  const ws = () => ids.map((i) => byId.get(i)).filter(Boolean);
  const n = ids.length, anyOff = ws().some((w) => w.on === false), anyHi = ws().some((w) => w.hi);
  showContextMenu([
    { label: anyHi ? 'Remove emphasis' : 'Emphasize', sub: n + ' word' + (n > 1 ? 's' : ''), action: () => { ws().forEach((w) => setHi(w, !anyHi)); rebuild(); } },
    { label: anyOff ? 'Enable captions' : 'Disable captions', action: () => { ws().forEach((w) => (w.on = anyOff ? true : false)); rebuild(); } },
    { label: 'Make kinetic', action: () => { ws().forEach((w) => makeKineticFromWord(w)); } },
    { sep: true },
    { label: 'Split line before selection', action: () => { ensureManual(); const f = ws().sort((a, b) => a.start - b.start)[0]; if (f) f.br = true; rebuild(); } },
    { sep: true },
    { label: 'Delete ' + n + ' word' + (n > 1 ? 's' : ''), danger: true, action: () => { project.words = project.words.filter((w) => !selWords.has(w.id)); selWords.clear(); rebuild(); } },
    { label: 'Clear selection', action: () => { selWords.clear(); refreshSelectionUI(); } },
  ], x, y);
}

function onTlPointerDown(e) {
  // move-to-adjacent-line arrows on the selected word
  if (e.target.classList.contains('tlw-mv')) {
    e.preventDefault(); e.stopPropagation();
    const c = e.target.closest('.tlword'); const mid = c && +c.dataset.id;
    if (mid) moveWordAdjacent(mid, e.target.classList.contains('r') ? 1 : -1);
    return;
  }
  // Sentence view: a chunk represents a whole caption line. Click = select all its words + seek (no per-line drag).
  const sceneChip = e.target.closest('.tlscene');
  if (sceneChip) {
    const ids = (sceneChip.dataset.ids || '').split(',').filter(Boolean).map(Number);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    selWords = additive ? new Set([...selWords, ...ids]) : new Set(ids);
    refreshSelectionUI();
    if (!additive && sceneChip.dataset.start != null && video) video.currentTime = Math.max(0, +sceneChip.dataset.start);
    e.preventDefault();
    return;
  }
  const chip = e.target.closest('.tlword');
  if (!chip) { if (e.button === 0 && !e.target.closest('.tlkin')) startBoxSelect(e); return; }
  const id = +chip.dataset.id, word = byId.get(id); if (!word) return;
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const isEdge = e.target.classList.contains('tlw-edge');
  if (additive && !isEdge) {                              // toggle multi-selection, no drag
    if (selWords.has(id)) selWords.delete(id); else selWords.add(id);
    refreshSelectionUI(); e.preventDefault(); e.stopPropagation(); return;
  }
  if (!selWords.has(id)) { selWords = new Set([id]); refreshSelectionUI(); }   // fresh single selection
  if (!video.paused) video.pause();
  const idx = project.words.indexOf(word);
  const mode = isEdge ? (e.target.classList.contains('l') ? 'resize-l' : 'resize-r') : 'move';
  const rectLeft = $('tlInner').getBoundingClientRect().left;
  const tDown = (e.clientX - rectLeft) / pxPerSec;
  const others = project.words.filter((w) => w !== word);
  const leftBound = Math.max(0, ...others.filter((w) => w.start < word.start).map((w) => w.end));
  const rightBound = Math.min(tlDur(), ...others.filter((w) => w.start > word.start).map((w) => w.start));
  // group move: drag every selected word together (move mode only; resize stays single)
  const group = (mode === 'move' && selWords.size > 1 && selWords.has(id))
    ? project.words.filter((w) => selWords.has(w.id)).map((w) => ({ w, s0: w.start, e0: w.end })) : null;
  tlDrag = { id, word, chip, mode, pointerId: e.pointerId, startClientX: e.clientX, moved: false,
    dur: word.end - word.start, grabOffset: tDown - word.start, primaryS0: word.start, idx, leftBound, rightBound,
    snaps: buildSnaps(word), lastClientX: e.clientX, alt: e.altKey, group };
  try { chip.setPointerCapture(e.pointerId); } catch {}   // capture is an optimization; ok if unavailable
  chip.classList.add('dragging');
  e.preventDefault(); e.stopPropagation();
}
function onTlPointerMove(e) {
  if (!tlDrag || e.pointerId !== tlDrag.pointerId) return;
  tlDrag.lastClientX = e.clientX; tlDrag.alt = e.altKey;
  if (!tlDrag.moved && Math.abs(e.clientX - tlDrag.startClientX) > DRAG_THRESH_PX) { tlDrag.moved = true; document.body.classList.add('tl-dragging'); }
  if (tlDrag.moved && !tlRaf) tlRaf = requestAnimationFrame(applyDragFrame);
}
function applyDragFrame() {
  tlRaf = 0; if (!tlDrag) return;
  const { word, mode, dur, grabOffset, leftBound, rightBound, idx } = tlDrag;
  const rectLeft = $('tlInner').getBoundingClientRect().left;
  const tP = Math.max(0, (tlDrag.lastClientX - rectLeft) / pxPerSec);
  if (mode === 'move') {
    let ns = snapTime(tP - grabOffset);
    if (tlDrag.group) {                          // move the whole selection by one shared delta
      let dt = ns - tlDrag.primaryS0;
      const minS = Math.min(...tlDrag.group.map((g) => g.s0));
      if (minS + dt < 0) dt = -minS;             // never push any word before 0
      for (const g of tlDrag.group) { g.w.start = g.s0 + dt; g.w.end = g.e0 + dt; }
    } else if (!tlRipple) { ns = clampN(ns, leftBound, rightBound - dur); word.start = ns; word.end = ns + dur; }
    else { ns = Math.max(ns, leftBound); rippleShift(idx, ns - word.start); }
  } else if (mode === 'resize-l') {
    word.start = clampN(snapTime(tP), leftBound, word.end - MIN_DUR);
  } else {
    let ne = snapTime(tP);
    if (!tlRipple) word.end = clampN(ne, word.start + MIN_DUR, rightBound);
    else { ne = Math.max(ne, word.start + MIN_DUR); const dt = ne - word.end; word.end = ne; rippleShift(idx + 1, dt); }
  }
  positionChip(tlDrag.chip, word);
  if (tlDrag.group) for (const g of tlDrag.group) { const c = $('tlWords').querySelector(`.tlword[data-id="${g.w.id}"]`); if (c) positionChip(c, g.w); }
  else if (tlRipple) for (let j = idx + 1; j < project.words.length; j++) { const c = $('tlWords').querySelector(`.tlword[data-id="${project.words[j].id}"]`); if (c) positionChip(c, project.words[j]); }
  renderScenes = buildScenes(project);
  renderSceneBars();
  renderOverlay(video.currentTime || 0);
  maybeAutoScroll(tlDrag.lastClientX);
}
function maybeAutoScroll(clientX) {
  const sc = $('tlScroll'); const r = sc.getBoundingClientRect();
  if (clientX < r.left + AUTOSCROLL_EDGE) { sc.scrollLeft -= AUTOSCROLL_STEP; if (!tlRaf) tlRaf = requestAnimationFrame(applyDragFrame); }
  else if (clientX > r.right - AUTOSCROLL_EDGE) { sc.scrollLeft += AUTOSCROLL_STEP; if (!tlRaf) tlRaf = requestAnimationFrame(applyDragFrame); }
}
function onTlPointerUp(e) {
  if (!tlDrag || (e && e.pointerId !== tlDrag.pointerId)) return;
  try { tlDrag.chip.releasePointerCapture(tlDrag.pointerId); } catch {}
  tlDrag.chip.classList.remove('dragging'); document.body.classList.remove('tl-dragging'); $('tlSnap').style.display = 'none';
  if (tlRaf) { cancelAnimationFrame(tlRaf); tlRaf = 0; }
  const { moved, word, id } = tlDrag; tlDrag = null;
  if (!moved) { selWords = new Set([id]); refreshSelectionUI(); video.currentTime = word.start; }   // plain click = select this + seek
  else { suppressScrollClickUntil = performance.now() + 250; rebuild(); }
}
function onTlPointerCancel() {
  if (!tlDrag) return;
  tlDrag.chip.classList.remove('dragging'); document.body.classList.remove('tl-dragging'); $('tlSnap').style.display = 'none';
  if (tlRaf) { cancelAnimationFrame(tlRaf); tlRaf = 0; }
  const moved = tlDrag.moved; tlDrag = null; if (moved) rebuild();
}
function updatePlayhead(t) {
  const x = t * pxPerSec; $('tlPlay').style.left = x + 'px';
  const sc = $('tlScroll');
  if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2);
  syncActiveCaption(t);
}
// Keep the caption LIST following the playhead: highlight the line being spoken and
// scroll it into view (only when it changes, so there's no per-frame scroll churn).
let _activeSceneEl = null;
function syncActiveCaption(t) {
  const host = $('words'); if (!host) return;
  let active = null;
  host.querySelectorAll('.scene').forEach((el) => { if (parseFloat(el.dataset.start) <= t + 1e-3) active = el; });
  if (active === _activeSceneEl) return;
  if (_activeSceneEl) _activeSceneEl.classList.remove('playing');
  _activeSceneEl = active;
  if (active) { active.classList.add('playing'); active.scrollIntoView({ block: 'nearest' }); }
}

// ---------- Find & replace (per-word caption text) ----------
let findMatches = [], findIdx = -1;
function toggleFind(force) {
  const bar = $('findBar'); if (!bar) return;
  const show = force === undefined ? bar.style.display === 'none' : !!force;
  bar.style.display = show ? 'flex' : 'none';
  if (show) { $('findInp').focus(); $('findInp').select(); runFind(); } else { clearFindHi(); }
}
// NON-global for matching (a shared /g regex's lastIndex would corrupt repeated .test()); global only for replace.
function findRegex(global) {
  const q = $('findInp').value; if (!q) return null;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let f = $('findCase').checked ? '' : 'i'; if (global) f = 'g' + f;
  try { return new RegExp(esc, f); } catch { return null; }
}
function clearFindHi() { document.querySelectorAll('#words .chip.found,#words .chip.foundcur').forEach((c) => c.classList.remove('found', 'foundcur')); }
function runFind() {
  if (!project) return;
  clearFindHi();
  const re = findRegex(false);
  if (!re) { findMatches = []; findIdx = -1; $('findCount').textContent = ''; return; }
  findMatches = project.words.filter((w) => w.on !== false && re.test(w.text)).map((w) => w.id);
  $('findCount').textContent = findMatches.length ? findMatches.length + ' found' : 'none';
  document.querySelectorAll('#words .chip').forEach((c) => { if (findMatches.includes(+c.dataset.id)) c.classList.add('found'); });
  if (findMatches.length) { if (findIdx < 0 || findIdx >= findMatches.length) findIdx = 0; markCurrentMatch(); } else findIdx = -1;
}
function markCurrentMatch() {
  document.querySelectorAll('#words .chip.foundcur').forEach((c) => c.classList.remove('foundcur'));
  const id = findMatches[findIdx]; if (id == null) return;
  const w = byId.get(id); if (!w) return;
  const chipEl = document.querySelector(`#words .chip[data-id="${id}"]`);
  if (chipEl) { chipEl.classList.add('foundcur'); chipEl.scrollIntoView({ block: 'nearest' }); }
  selWords = new Set([id]); refreshSelectionUI();
  if (video) { video.pause(); video.currentTime = w.start; renderOverlay(w.start); updatePlayhead(w.start); }
}
function findStep(d) { if (!findMatches.length) return; findIdx = (findIdx + d + findMatches.length) % findMatches.length; markCurrentMatch(); }
function replaceCurrent() {
  const re = findRegex(true); if (!re || findIdx < 0) return;
  const w = byId.get(findMatches[findIdx]); if (!w) return;
  w.text = w.text.replace(re, $('replInp').value); markEdit();
  const keep = findIdx; rebuild(); runFind();
  if (findMatches.length) { findIdx = Math.min(keep, findMatches.length - 1); markCurrentMatch(); }
}
function replaceAll() {
  const re = findRegex(true); if (!re) return;
  const repl = $('replInp').value; let n = 0;
  project.words.forEach((w) => { if (w.on !== false && findRegex(false).test(w.text)) { w.text = w.text.replace(re, repl); n++; } });
  if (n) { markEdit(); rebuild(); }
  runFind(); setStatus(`Replaced ${n}`);
}

// ---------- Scrubby numeric inputs (tap + drag L/R to change the value) ----------
// A plain click still focuses the field for typing; dragging past a few px scrubs.
// Per-pixel change scales to the field's own range so every property feels right.
function makeScrub(el) {
  if (!el || el._scrub) return; el._scrub = true;
  el.classList.add('scrub');
  const step = parseFloat(el.step) || 1;
  const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
  const max = el.max !== '' ? parseFloat(el.max) : Infinity;
  const bounded = isFinite(min) && isFinite(max);
  const perPx = bounded ? (max - min) / 320 : step;
  const dec = (String(step).split('.')[1] || '').length;
  let startX = 0, startV = 0, dragging = false, moved = false, pid = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    startX = e.clientX; startV = parseFloat(el.value) || 0; dragging = true; moved = false; pid = e.pointerId;
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    if (!moved) { moved = true; if (document.activeElement === el) el.blur(); document.body.style.cursor = 'ew-resize'; document.body.style.userSelect = 'none'; }
    e.preventDefault();
    let v = startV + dx * perPx * (e.shiftKey ? 0.25 : 1);
    v = Math.min(max, Math.max(min, v));
    v = +(Math.round(v / step) * step).toFixed(dec);
    if (String(v) !== el.value) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  window.addEventListener('pointerup', (e) => {
    if (!dragging || e.pointerId !== pid) return;
    if (moved) { el.dispatchEvent(new Event('change', { bubbles: true })); document.body.style.cursor = ''; document.body.style.userSelect = ''; }
    dragging = false; moved = false; pid = null;
  });
}
function scrubAll(root) { (root || document).querySelectorAll('input[type="number"]:not([data-noscrub])').forEach(makeScrub); }
function syncTimelineHi() { document.querySelectorAll('.tlword').forEach((el) => { const w = byId.get(+el.dataset.id); if (w) el.classList.toggle('hi', !!w.hi); }); }

// ---------- kinetic keyword layer (editor) ----------
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const selEv = () => (project.kinetic || []).find((e) => e.id === selKin);
function renderKineticTrack() {
  const host = $('tlKinetic'); if (!host) return; host.innerHTML = '';
  for (const ev of (project.kinetic || [])) {
    const el = document.createElement('div'); el.className = 'tlkin' + (ev.id === selKin ? ' on' : ''); el.dataset.id = ev.id;
    el.style.left = (ev.start * pxPerSec) + 'px'; el.style.width = Math.max(20, (ev.end - ev.start) * pxPerSec - 2) + 'px';
    el.textContent = '⚡ ' + (ev.text || ''); el.title = ev.text || '';
    el.onclick = () => selectKinetic(ev.id);
    host.appendChild(el);
  }
}
function renderKineticList() {
  const host = $('kinList'); if (!host) return; host.innerHTML = '';
  const evs = [...(project.kinetic || [])].sort((a, b) => a.start - b.start);
  for (const ev of evs) {
    const row = document.createElement('div'); row.className = 'kinrow' + (ev.id === selKin ? ' on' : '');
    row.innerHTML = `<span>⚡</span><span class="grow">${escapeHtml(ev.text || '')}</span><span>${fmt(ev.start)}</span><span class="x" title="delete">×</span>`;
    row.onclick = (e) => { if (e.target.classList.contains('x')) { deleteKinetic(ev.id); return; } selectKinetic(ev.id); };
    host.appendChild(row);
  }
  const has = selKin != null && (project.kinetic || []).some((e) => e.id === selKin);
  $('kinForm').style.display = has ? 'flex' : 'none';
  if (has) syncKinForm();
}
function syncKinForm() {
  const ev = selEv(); if (!ev) return;
  if (document.activeElement !== $('kinText')) $('kinText').value = ev.text || '';
  document.querySelectorAll('#kinPresets .an').forEach((el) => el.classList.toggle('on', el.dataset.kp === (ev.preset || 'scale-punch')));
  const pos = ev.pos || { x: 50, y: 38 };
  $('kinX').value = pos.x; $('kinXVal').textContent = pos.x + '%';
  $('kinY').value = pos.y; $('kinYVal').textContent = pos.y + '%';
  const sz = ev.size ?? 1.4; $('kinSize').value = sz; $('kinSizeVal').textContent = (+sz).toFixed(1) + '×';
  const col = norm6(ev.color || mergedStyle().accent || '#ffe01b'); $('kinColor').value = col; $('kinColorHex').value = col;
  $('kinTimeHint').textContent = `Shows ${fmt(ev.start)} → ${fmt(ev.end)}${ev.off === false ? '' : ' (locked to its word)'}`;
}
function selectKinetic(id) {
  selKin = id; switchTab('Kinetic');
  const ev = selEv(); if (ev) video.currentTime = ev.start + 0.001;
  renderKineticList(); renderKineticTrack(); renderOverlay(video.currentTime || 0);
}
function deleteKinetic(id) {
  const i = (project.kinetic || []).findIndex((e) => e.id === id);
  if (i >= 0) project.kinetic.splice(i, 1);
  if (selKin === id) selKin = null;
  renderKineticList(); renderKineticTrack(); renderOverlay(video.currentTime || 0);
}
function addKineticAtPlayhead() {
  const t = +(video.currentTime || 0).toFixed(2);
  const ev = { id: nextKinId++, text: 'KEYWORD', start: t, end: +(t + 0.9).toFixed(2), preset: 'scale-punch', pos: { x: 50, y: 38 }, size: 1.4, color: mergedStyle().accent || '#FFE01B', off: false, opts: {} };
  project.kinetic.push(ev); selectKinetic(ev.id);
}
function makeKineticFromWord(w) {
  const ev = { id: nextKinId++, text: String(w.text).toUpperCase().replace(/[.,!?;:"'…]+$/, ''), start: w.start, end: Math.max(w.end, w.start + 0.7), preset: 'scale-punch', pos: { x: 50, y: 38 }, size: 1.6, color: mergedStyle().accent || '#FFE01B', off: true, wordIds: [w.id], opts: {} };
  project.kinetic.push(ev); selectKinetic(ev.id);
}
function kinPos(axis, v) { const ev = selEv(); if (!ev) return; ev.pos = { ...(ev.pos || { x: 50, y: 38 }), [axis]: v }; renderOverlay(video.currentTime || 0); }

// ---------- inspector: tabs ----------
function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  for (const t of ['Text', 'Templates', 'Animate', 'Effects', 'Transitions', 'Kinetic', 'Layout']) $('tab' + t).classList.toggle('on', t === name);
  if (name === 'Layout') renderLayoutPanel();
  if (name === 'Animate') syncAnimateControls();
  if (name === 'Effects') syncEffectsControls();
}

// ---------- inspector: Text tab (per-element overrides) ----------
const norm6 = (hex) => { let h = String(hex || '#ffffff').replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return '#' + h.slice(0, 6).toLowerCase(); };
function syncTextControls() {
  const s = mergedStyle();
  $('fontSel').value = fontFamilies().includes(s.font) ? s.font : 'Inter';
  $('fontSize').value = s.size || 90;
  $('letterSp').value = s.letterSpacing || 0;
  $('lineHt').value = s.lineHeight || 1.15;
  $('weightSel').value = String(s.weight || 700);
  const al = s.textAlign || 'center';
  document.querySelectorAll('#alignToggle button').forEach((b) => b.classList.toggle('on', b.dataset.al === al));
  $('colPrimary').value = norm6(s.primary); $('colPrimaryHex').value = norm6(s.primary);
  $('colAccent').value = norm6(s.accent); $('colAccentHex').value = norm6(s.accent);
  const tg = s.textGradient;
  if ($('gradOn')) { $('gradOn').checked = !!tg; $('gradCtls').style.display = tg ? '' : 'none'; if (tg) { $('gradFrom').value = norm6(tg.from || '#ffffff'); $('gradTo').value = norm6(tg.to || '#8ed4ff'); $('gradAngle').value = tg.angle ?? 180; } $('gradLevel').value = s.gradientLevel || 'word'; }
  if ($('hiScale')) { const hs = s.hiScale || 1; $('hiScale').value = hs; $('hiScaleVal').textContent = (+hs).toFixed(2) + '×'; }
  $('caseSel').value = s.case || '';
  const box = s.box || {};
  $('boxOn').checked = !!box.enabled;
  $('boxColor').value = norm6(box.color || '#000000'); $('boxColorHex').value = norm6(box.color || '#000000');
  $('boxOpacity').value = box.opacity ?? 0.5; $('boxOpVal').textContent = (+(box.opacity ?? 0.5)).toFixed(2);
  const pos = s.position || { x: 50, y: 82 };
  $('posX').value = pos.x ?? 50; $('posXVal').textContent = (pos.x ?? 50) + '%';
  $('posY').value = pos.y ?? 82; $('posYVal').textContent = (pos.y ?? 82) + '%';
  $('segMode').value = project.segmentation.mode; $('segMax').value = project.segmentation.max; $('segValLbl').textContent = project.segmentation.max;
  if ($('segAutoBreak')) $('segAutoBreak').checked = !!project.segmentation.autoBreak;
  $('linesSel').value = String(project.maxLines || 2);
  if (project.offset === undefined) project.offset = 0.12;
  $('offset').value = project.offset; $('offVal').textContent = (project.offset >= 0 ? '+' : '') + (+project.offset).toFixed(2) + 's';
}
const setOv = (k, v) => { project.styleOverrides[k] = v; renderOverlay(video.currentTime || 0); markEdit(); };
const setBoxOv = (k, v) => { const b = { ...(mergedStyle().box || {}), [k]: v }; project.styleOverrides.box = b; renderOverlay(video.currentTime || 0); markEdit(); };
const setPosOv = (k, v) => { const p = { ...(mergedStyle().position || { x: 50, y: 82 }), [k]: v }; project.styleOverrides.position = p; renderOverlay(video.currentTime || 0); markEdit(); };

// ---------- inspector: Templates tab ----------
function renderTemplates() {
  const host = $('tpls'); host.innerHTML = '';
  // Template scope is contextual: unlock + a STACK selected -> that stack only; otherwise the
  // whole video. (Templates are stack-level, never per word/line.)
  const perStack = unlocked && sel && sel.kind === 'stack';
  const curId = perStack ? ((project.stackStyles && project.stackStyles[sel.key]) || project.style) : project.style;
  const overridden = perStack && !!(project.stackStyles && project.stackStyles[sel.key]);

  const banner = document.createElement('div'); banner.className = 'tpl-scope';
  banner.textContent = perStack ? 'This stack only — pick a template for the selected stack' : 'Whole video — unlock and select a stack to change just one';
  host.appendChild(banner);

  if (perStack) {   // "Global" clears the stack's override so it follows the whole-video template
    const g = document.createElement('div'); g.className = 'tpl' + (!overridden ? ' on' : ''); g.dataset.id = '__global';
    const pv = document.createElement('div'); pv.className = 'prev'; pv.textContent = '↺'; pv.style.fontSize = '22px'; pv.style.color = 'var(--dim)';
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = 'Global';
    g.appendChild(pv); g.appendChild(nm); g.onclick = () => applyTemplate('__global'); host.appendChild(g);
  }

  for (const s of styles) {
    const card = document.createElement('div'); card.className = 'tpl' + (s.id === curId && (!perStack || overridden) ? ' on' : ''); card.dataset.id = s.id;
    const prev = document.createElement('div'); prev.className = 'prev';
    const span = document.createElement('span'); span.textContent = s.case === 'upper' ? 'WORD' : 'Word';
    span.style.fontFamily = `'${s.font}',sans-serif`; span.style.color = s.accent || '#fff';
    if (s.box && s.box.enabled) { prev.style.background = s.box.color || '#fff'; span.style.color = s.primary || '#111'; }
    prev.appendChild(span);
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = s.label;
    card.appendChild(prev); card.appendChild(nm);
    if (s.custom) { const del = document.createElement('span'); del.className = 'tplDel'; del.textContent = '×'; del.title = 'Delete this saved template'; del.onclick = (e) => { e.stopPropagation(); deleteSavedTemplate(s.id); }; card.appendChild(del); }
    card.onclick = () => applyTemplate(s.id);
    host.appendChild(card);
  }
}
function applyTemplate(id) {
  // Per-stack override when a stack is selected in unlock mode; else the whole-video template.
  if (unlocked && sel && sel.kind === 'stack') {
    project.stackStyles = project.stackStyles || {};
    if (id === '__global') delete project.stackStyles[sel.key];
    else project.stackStyles[sel.key] = id;
    renderTemplates(); refresh();
    return;
  }
  if (id === '__global') return;
  project.style = id;
  project.styleOverrides = {};                       // template is the fresh base; tweak in Text tab
  const seg = (styleMap[id] || {}).segmentation;
  if (seg && !project.manualBreaks) project.segmentation = { ...seg };
  renderTemplates(); syncTextControls(); syncTransitionControls(); rebuild();
}

// ---------- inspector: Transitions tab ----------
const SPEED_MIN = 90, SPEED_MAX = 600;              // ms; higher speed = shorter (snappier)
const msToSpeed = (ms) => Math.round((SPEED_MAX - clampN(ms, SPEED_MIN, SPEED_MAX)) / (SPEED_MAX - SPEED_MIN) * 100);
const speedToMs = (sp) => Math.round(SPEED_MAX - (sp / 100) * (SPEED_MAX - SPEED_MIN));
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
function syncTransitionControls() {
  const s = mergedStyle();
  const ent = s.entrance || 'pop';
  document.querySelectorAll('#entGrid .an').forEach((el) => el.classList.toggle('on', el.dataset.ent === ent));
  const scope = s.animScope || 'line';
  document.querySelectorAll('#scopeToggle button').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
  const sp = msToSpeed(s.entranceMs ?? 200);
  $('spd').value = sp; $('spdVal').textContent = sp;
  if ($('trDir')) { $('trDir').value = s.transitionDir || ''; const td = s.transitionDist ?? 26; $('trDist').value = td; $('trDistVal').textContent = td + 'px'; }
  // Focus 3-line alignment control — only relevant when the style is the stack layout.
  const isStack = (s.highlightMode || '') === 'stack';
  $('stackAlignBlock').style.display = isStack ? '' : 'none';
  if (isStack) {
    const sa = s.stackAlign || 'stagger';
    document.querySelectorAll('#stackAlignToggle button').forEach((b) => b.classList.toggle('on', b.dataset.sa === sa));
  }
}

// ---------- inspector: Animate tab (pick the caption animation style) ----------
const ANIM_PRESETS = {
  'word-appear': { animScope: 'word', entrance: 'fade', highlightMode: 'none', typewriter: false },
  'word-pop':    { animScope: 'word', entrance: 'pop', highlightMode: 'none', typewriter: false, entranceMs: 120 },
  'movebox':     { animScope: 'line', entrance: 'rise', highlightMode: 'movebox', typewriter: false },
  'typewriter':  { animScope: 'word', entrance: 'none', highlightMode: 'none', typewriter: true },
  'ghost':       { animScope: 'line', entrance: 'rise', highlightMode: 'ghost', typewriter: false },
  'sentence':    { animScope: 'line', entrance: 'fade', highlightMode: 'none', typewriter: false },
  'stack':       { highlightMode: 'stack', typewriter: false },
};
function currentAnimKey() {
  const s = mergedStyle();
  if (s.highlightMode === 'stack') return 'stack';
  if (s.highlightMode === 'movebox') return 'movebox';
  if (s.highlightMode === 'ghost') return 'ghost';
  if (s.typewriter) return 'typewriter';
  if ((s.animScope || 'line') === 'word') return s.entrance === 'pop' ? 'word-pop' : 'word-appear';
  return 'sentence';
}
function applyAnimPreset(name) {
  const p = ANIM_PRESETS[name]; if (!p) return;
  for (const k in p) project.styleOverrides[k] = p[k];
  syncAnimateControls(); syncTransitionControls(); rebuild();
}
function syncAnimateControls() {
  if (!project) return;
  const s = mergedStyle(), key = currentAnimKey();
  document.querySelectorAll('#animGrid .an').forEach((el) => el.classList.toggle('on', el.dataset.anim === key));
  const sp = msToSpeed(s.entranceMs ?? 200); $('animSpd').value = sp; $('animSpdVal').textContent = sp;
  const fi = s.entranceMs ?? 200, fo = s.exitMs ?? 0;
  $('animFadeIn').value = fi; $('animFadeInVal').textContent = (fi / 1000).toFixed(2) + 's';
  $('animFadeOut').value = fo; $('animFadeOutVal').textContent = (fo / 1000).toFixed(2) + 's';
  const isGhost = s.highlightMode === 'ghost';
  $('ghostIdleRow').style.display = isGhost ? '' : 'none';
  if (isGhost) { const io = Math.round((s.idleOpacity ?? 0.4) * 100); $('ghostIdle').value = io; $('ghostIdleVal').textContent = io + '%'; }
}
// ---------- inspector: Effects tab ----------
function syncEffectsControls() {
  if (!project) return;
  const s = mergedStyle();
  const eff = s.effect || (s.shadow ? 'soft-shadow' : 'none');
  document.querySelectorAll('#fxGrid .an').forEach((el) => el.classList.toggle('on', el.dataset.fx === eff));
  $('fxGlowRow').style.display = eff === 'glow' ? '' : 'none';
  if ($('fxGlowStrRow')) { $('fxGlowStrRow').style.display = eff === 'glow' ? '' : 'none'; const gs = s.glowStrength ?? 50; $('fxGlowStr').value = gs; $('fxGlowStrVal').textContent = gs + '%'; }
  $('fxBlurRow').style.display = eff === 'blur' ? '' : 'none';
  const gc = norm6(s.glowColor || s.accent || '#12E0C8'); $('fxGlowColor').value = gc; $('fxGlowHex').value = gc;
  const bl = s.blurPx ?? 3; $('fxBlur').value = bl; $('fxBlurVal').textContent = bl + 'px';
  const ow = (s.outline && s.outline.width) || 0;
  $('fxOutlineOn').checked = ow > 0; $('fxOutW').value = ow; $('fxOutWVal').textContent = ow + 'px';
  $('fxOutColor').value = norm6((s.outline && s.outline.color) || '#000000');
  const op = Math.round((s.textOpacity ?? 1) * 100); $('fxOpacity').value = op; $('fxOpacityVal').textContent = op + '%';
}
function bindAnimateEffects() {
  document.querySelectorAll('#animGrid .an').forEach((el) => (el.onclick = () => applyAnimPreset(el.dataset.anim)));
  $('animSpd').oninput = () => { setOv('entranceMs', speedToMs(+$('animSpd').value)); $('animSpdVal').textContent = $('animSpd').value; };
  $('animFadeIn').oninput = () => { const v = +$('animFadeIn').value; setOv('entranceMs', v); $('animFadeInVal').textContent = (v / 1000).toFixed(2) + 's'; };
  $('animFadeOut').oninput = () => { const v = +$('animFadeOut').value; setOv('exitMs', v); $('animFadeOutVal').textContent = (v / 1000).toFixed(2) + 's'; };
  $('ghostIdle').oninput = () => { const v = +$('ghostIdle').value / 100; setOv('idleOpacity', v); $('ghostIdleVal').textContent = Math.round(v * 100) + '%'; };
  document.querySelectorAll('#fxGrid .an').forEach((el) => (el.onclick = () => { setOv('effect', el.dataset.fx); syncEffectsControls(); }));
  $('fxGlowColor').oninput = () => { $('fxGlowHex').value = $('fxGlowColor').value; setOv('glowColor', $('fxGlowColor').value); };
  $('fxGlowHex').onchange = () => { const v = norm6($('fxGlowHex').value); $('fxGlowColor').value = v; setOv('glowColor', v); };
  $('fxBlur').oninput = () => { const v = +$('fxBlur').value; setOv('blurPx', v); $('fxBlurVal').textContent = v + 'px'; };
  const applyOutline = () => { const on = $('fxOutlineOn').checked; const w = on ? Math.max(1, +$('fxOutW').value || 4) : 0; setOv('outline', { width: w, color: $('fxOutColor').value }); $('fxOutWVal').textContent = w + 'px'; };
  $('fxOutlineOn').onchange = () => { if ($('fxOutlineOn').checked && (+$('fxOutW').value || 0) === 0) $('fxOutW').value = 4; applyOutline(); };
  $('fxOutW').oninput = () => { $('fxOutlineOn').checked = +$('fxOutW').value > 0; applyOutline(); };
  $('fxOutColor').oninput = applyOutline;
  $('fxOpacity').oninput = () => { const v = +$('fxOpacity').value / 100; setOv('textOpacity', v); $('fxOpacityVal').textContent = Math.round(v * 100) + '%'; };
}

// ---------- P4: layout editor (unlock, per-line/word overrides, spotlight, wand) ----------
const repaint = () => renderOverlay(video.currentTime || 0);          // live overlay only
const refresh = () => { renderOverlay(video.currentTime || 0); renderLayoutPanel(); renderTemplates(); };   // + rebuild panel + template scope
function setUnlock(on) {
  unlocked = on;
  document.body.classList.toggle('unlocked', on);
  $('btnUnlock').classList.toggle('on', on); $('btnUnlock2').classList.toggle('on', on);
  $('btnUnlock').textContent = on ? '🔒 Lock' : '🔓 Unlock';
  $('btnUnlock2').textContent = on ? '🔒 Lock layout' : '🔓 Unlock layout';
  const fb = $('capFinder'); if (fb) fb.style.display = on ? 'block' : 'none';
  if (on) { if (!video.paused) video.pause(); switchTab('Layout'); }
  else { sel = null; finderOn = false; ctIcon = null; if (fb) fb.classList.remove('on'); ['capHandle', 'capGhost', 'capToolbar'].forEach((id) => { const x = $(id); if (x) x.style.display = 'none'; }); }
  refresh();
}
function toggleUnlock() { if (project) setUnlock(!unlocked); }
function lineKeyOfWord(id) { for (const sc of renderScenes) if (sc.words.some((w) => w.id === id)) return sc.words[0].id; return null; }
function sceneByKey(key) { return renderScenes.find((sc) => sc.words[0] && sc.words[0].id === key) || null; }
const lovOf = (key) => (project.lineStyles[key] || (project.lineStyles[key] = {}));
const wovOf = (id) => (project.wordStyles[id] || (project.wordStyles[id] = {}));
const pruneEmpty = (map, key) => { const o = map[key]; if (o && !Object.keys(o).length) delete map[key]; };
let finderOn = false, curLevel = 'word';   // curLevel = what a canvas click selects (word / line / stack)
// Viewport-space bounding rect of the current selection: a word span, a visual-line row
// (union of its word rects), or the whole stack box.
function selBox() {
  const layer = stage().querySelector('.cap-layer'); if (!layer || !sel) return null;
  if (sel.kind === 'word') { const e = layer.querySelector(`[data-wid="${sel.id}"]`); return e ? e.getBoundingClientRect() : null; }
  if (sel.kind === 'line' && sel.ids) {
    const rs = sel.ids.map((id) => layer.querySelector(`[data-wid="${id}"]`)).filter(Boolean).map((e) => e.getBoundingClientRect());
    if (!rs.length) return null;
    const left = Math.min(...rs.map((r) => r.left)), top = Math.min(...rs.map((r) => r.top)), right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  const e = layer.querySelector(`[data-linekey="${sel.key}"]`); return e ? e.getBoundingClientRect() : null;
}
// word ids sharing the clicked word's visual row (grouped by offsetTop after wrap)
function visualRowIds(anchorWid) {
  const layer = stage().querySelector('.cap-layer'); if (!layer) return [anchorWid];
  const anchor = layer.querySelector(`[data-wid="${anchorWid}"]`); if (!anchor) return [anchorWid];
  const at = anchor.offsetTop;
  const ids = [...layer.querySelectorAll('[data-wid]')].filter((e) => Math.abs(e.offsetTop - at) < 8).map((e) => +e.dataset.wid);
  return ids.length ? ids : [anchorWid];
}
function decorateUnlock() {
  const layer = stage().querySelector('.cap-layer');
  if (sel && layer) {
    if (sel.kind === 'word') { const e = layer.querySelector(`[data-wid="${sel.id}"]`); if (e) e.classList.add('cap-sel-word'); }
    else if (sel.kind === 'line' && sel.ids) sel.ids.forEach((id) => { const e = layer.querySelector(`[data-wid="${id}"]`); if (e) e.classList.add('cap-sel-word'); });
    else { const e = layer.querySelector(`[data-linekey="${sel.key}"]`); if (e) e.classList.add('cap-sel-line'); }
  }
  const box = selBox();
  positionHandle(box);   // corner resize handle
  positionGhost();       // dashed STACK-home box (F3, Bugs 1+2)
  renderToolbar(box);    // floating Stack/Lines/Words toolbar (F4)
}
// F3 (Bugs 1+2): a FIXED dashed ghost at the whole STACK's HOME position — where this
// caption sits by default. It never tracks the moving word/line (that made it drift the
// wrong way); it's the stack box minus the stack's own dx/dy. Shows whenever anything in
// this stack has been moved (or the finder is on).
function positionGhost() {
  const g = $('capGhost'); if (!g) return;
  const layer = stage().querySelector('.cap-layer');
  if (!unlocked || !sel || !layer) { g.style.display = 'none'; return; }
  const stackEl = layer.querySelector(`[data-linekey="${sel.key}"]`);
  if (!stackEl) { g.style.display = 'none'; return; }
  const sr = stage().getBoundingClientRect(), r = stackEl.getBoundingClientRect();
  const W = sr.width || 1, H = sr.height || 1;
  const lov = project.lineStyles[sel.key] || {};
  const offX = (lov.dx || 0) / 100 * W, offY = (lov.dy || 0) / 100 * H;   // the whole caption's own move
  const stackMoved = Math.abs(offX) > 0.5 || Math.abs(offY) > 0.5;
  const sc = sceneByKey(sel.key);
  const anyWordMoved = sc && sc.words.some((w) => { const o = project.wordStyles[w.id]; return o && (o.wx || o.wy); });
  if (!stackMoved && !anyWordMoved && !finderOn) { g.style.display = 'none'; return; }
  g.style.display = 'block';
  g.style.left = ((r.left - sr.left) - offX) + 'px';   // stack box is unaffected by word translates, so this is stable
  g.style.top = ((r.top - sr.top) - offY) + 'px';
  g.style.width = r.width + 'px';
  g.style.height = r.height + 'px';
  const arrow = g.querySelector('.cap-ghost-arrow'); if (arrow) arrow.style.display = (stackMoved || anyWordMoved) ? 'block' : 'none';
}
// the stack whose caption is on screen right now (used by the finder when nothing is selected)
function activeSceneKey() {
  const s = mergedStyle(); const tt = (video.currentTime || 0) + (s.offset || 0) + (project.offset || 0);
  const sc = renderScenes.find((x) => tt >= x.start && tt < x.end + (s.tail || 0.06)) || renderScenes[0];
  return sc && sc.words[0] ? sc.words[0].id : null;
}

// ---------- F4: floating context toolbar (Stack / Lines / Words) ----------
let ctIcon = null;   // which icon's popover is open
let lastToolbarSig = null;   // rebuild the toolbar's icons/popover ONLY when this changes — else a
                             // plain repaint (e.g. live color drag) would wipe the open <input type=color>.
const lvlOf = () => (sel && sel.kind === 'word' ? 'word' : sel && sel.kind === 'line' ? 'line' : 'stack');
const currentToolbarSig = () => (sel ? `${lvlOf()}|${sel.kind}|${sel.id ?? ''}|${(sel.ids || []).join(',')}|${sel.key}|${ctIcon}` : '');
const ICONS = {
  stack: [['font', 'Aa', 'Font'], ['size', '⇕', 'Size'], ['color', '●', 'Color'], ['opacity', '◐', 'Opacity'], ['align', '⇄', 'Align'], ['wand', '🪄', 'Wand']],
  line:  [['font', 'Aa', 'Font'], ['size', '⇕', 'Size'], ['color', '●', 'Color']],
  word:  [['font', 'Aa', 'Font'], ['size', '⇕', 'Size'], ['color', '●', 'Color'], ['emph', '✦', 'Emph'], ['spot', '🔦', 'Spot']],
};
function setLevel(lvl) {
  if (!sel) return;
  curLevel = lvl;
  const key = sel.key;
  const sc = sceneByKey(key);
  const anchor = sel.kind === 'word' ? sel.id : (sel.kind === 'line' && sel.ids ? sel.ids[0] : (sc && sc.words[0] && sc.words[0].id));
  if (lvl === 'word') { if (anchor != null) sel = { kind: 'word', id: anchor, key }; }
  else if (lvl === 'line') { const ids = anchor != null ? visualRowIds(anchor) : (sc ? sc.words.map((w) => w.id) : []); sel = { kind: 'line', key, ids }; }
  else sel = { kind: 'stack', key };
  ctIcon = null; refresh();
}
function renderToolbar(box) {
  const tb = $('capToolbar'); if (!tb) return;
  if (!unlocked || !sel || !box) { tb.style.display = 'none'; return; }
  tb.style.display = 'block';
  tb.querySelectorAll('.ct-tab').forEach((b) => b.classList.toggle('on', b.dataset.lvl === lvlOf()));
  // Only rebuild icons/popover when the selection or open popover changed. On a plain repaint
  // (same selection — e.g. dragging the color wheel) keep the existing popover so the live
  // <input type=color> survives; just reposition the toolbar below.
  if (currentToolbarSig() !== lastToolbarSig) buildIcons();
  const sr = stage().getBoundingClientRect();
  const tw = tb.offsetWidth, th = tb.offsetHeight;
  let left = (box.left - sr.left) + box.width / 2 - tw / 2;
  let top = (box.top - sr.top) - th - 12;
  left = Math.max(4, Math.min(left, sr.width - tw - 4));
  if (top < 4) top = (box.bottom - sr.top) + 12;   // flip below if no room above
  tb.style.left = left + 'px'; tb.style.top = Math.max(4, top) + 'px';
}
function buildIcons() {
  const host = $('ctIcons'); if (!host) return; host.innerHTML = '';
  for (const [act, glyph, label] of ICONS[lvlOf()]) {
    const b = document.createElement('button'); b.className = 'ct-icon' + (ctIcon === act ? ' on' : '');
    b.innerHTML = `${glyph}<small>${label}</small>`; b.title = label;
    b.onclick = (e) => { e.stopPropagation(); ctIcon = ctIcon === act ? null : act; buildIcons(); };
    host.appendChild(b);
  }
  buildPop();
  lastToolbarSig = currentToolbarSig();   // keep in sync so the next repaint won't needlessly rebuild
}
function buildPop() {
  const pop = $('ctPop'); if (!pop) return; pop.innerHTML = '';
  if (!ctIcon || !sel) { pop.style.display = 'none'; return; }
  pop.style.display = 'block';
  const isWord = sel.kind === 'word', isLine = sel.kind === 'line';
  // representative style (for control defaults) + an applier that fans out to every target
  const repr = isWord ? (project.wordStyles[sel.id] || {}) : isLine ? (project.wordStyles[sel.ids[0]] || {}) : (project.lineStyles[sel.key] || {});
  const each = (fn) => {
    if (isWord) { fn(wovOf(sel.id)); pruneEmpty(project.wordStyles, sel.id); }
    else if (isLine) { sel.ids.forEach((id) => { fn(wovOf(id)); pruneEmpty(project.wordStyles, id); }); }
    else { fn(lovOf(sel.key)); pruneEmpty(project.lineStyles, sel.key); }
    repaint();
  };
  if (ctIcon === 'font') {
    const s = document.createElement('select');
    s.innerHTML = `<option value="">(default)</option>` + fontFamilies().map((f) => `<option value="${f}"${repr.font === f ? ' selected' : ''}>${f}</option>`).join('');
    s.onchange = () => each((o) => { if (s.value) o.font = s.value; else delete o.font; });
    pop.appendChild(s);
  } else if (ctIcon === 'size') {
    pop.appendChild(ctSize(repr.sizeScale || 1, (v) => each((o) => { o.sizeScale = v; if (Math.abs(v - 1) < 0.02) delete o.sizeScale; })));
  } else if (ctIcon === 'color') {
    pop.appendChild(ctColor(repr.color || '#ffd166', (v) => each((o) => { o.color = v; }), () => each((o) => { delete o.color; })));
  } else if (ctIcon === 'opacity') {
    const o = lovOf(sel.key);
    pop.appendChild(ctSlider(0.1, 1, 0.05, o.opacity ?? 1, (v) => { o.opacity = v; if (v === 1) delete o.opacity; repaint(); pruneEmpty(project.lineStyles, sel.key); }, (v) => Math.round(v * 100) + '%'));
  } else if (ctIcon === 'align') {
    const o = lovOf(sel.key);
    pop.appendChild(ctSeg([['⇤', -25], ['≡', 0], ['⇥', 25]], (v) => { if (v === 0) delete o.dx; else o.dx = v; repaint(); pruneEmpty(project.lineStyles, sel.key); }));
  } else if (ctIcon === 'wand') {
    pop.appendChild(ctBtn('🪄 Apply this look to all lines below', () => applyStyleBelow(sel.key)));
  } else if (ctIcon === 'emph') {
    const o = wovOf(sel.id), row = document.createElement('div'); row.className = 'ct-emph';
    row.appendChild(ctTog('Bold', !!o.bold, (on) => { if (on) o.bold = true; else delete o.bold; repaint(); pruneEmpty(project.wordStyles, sel.id); }));
    const w = byId.get(sel.id);
    row.appendChild(ctTog('Highlight', !!(w && w.hi), (on) => { if (w) { setHi(w, on); refreshHi(); } }));
    row.appendChild(ctTog('Invert', !!o.invert, (on) => { if (on) o.invert = true; else delete o.invert; repaint(); pruneEmpty(project.wordStyles, sel.id); }));
    pop.appendChild(row);
  } else if (ctIcon === 'spot') {
    pop.appendChild(ctBtn('🔦 Spotlight — isolate to its own line', () => spotlightWord(sel.id)));
  }
}
function ctSlider(min, max, step, val, on, fmt) {
  const w = document.createElement('div'); w.className = 'ct-ctl';
  const i = document.createElement('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = val;
  const s = document.createElement('span'); s.textContent = fmt(val);
  i.oninput = () => { s.textContent = fmt(+i.value); on(+i.value); };
  w.append(i, s); return w;
}
function ctColor(val, on, clear) {
  const w = document.createElement('div'); w.className = 'ct-ctl';
  const c = document.createElement('input'); c.type = 'color'; c.value = norm6(val); c.oninput = () => on(c.value);
  const x = ctBtn('none', clear); x.className = 'ct-btn ct-mini';
  w.append(c, x); return w;
}
function ctSeg(opts, on) {
  const w = document.createElement('div'); w.className = 'ct-seg';
  opts.forEach(([g, v]) => { const b = document.createElement('button'); b.textContent = g; b.onclick = () => on(v); w.appendChild(b); });
  return w;
}
function ctBtn(label, on) { const b = document.createElement('button'); b.className = 'ct-btn'; b.textContent = label; b.onclick = on; return b; }
// Direct numeric size control (Bug 3b) — type a %, or −/+ in 10% steps. val/on use sizeScale (1 = 100%).
function ctSize(val, on) {
  const w = document.createElement('div'); w.className = 'ct-ctl ct-size';
  const dec = document.createElement('button'); dec.className = 'ct-btn ct-mini'; dec.textContent = '−';
  const i = document.createElement('input'); i.type = 'number'; i.min = 10; i.max = 400; i.step = 5; i.value = Math.round((val || 1) * 100);
  const pct = document.createElement('span'); pct.textContent = '%';
  const inc = document.createElement('button'); inc.className = 'ct-btn ct-mini'; inc.textContent = '+';
  const apply = () => on(clampN(+i.value || 100, 10, 400) / 100);
  dec.onclick = () => { i.value = Math.max(10, (+i.value || 100) - 10); apply(); };
  inc.onclick = () => { i.value = Math.min(400, (+i.value || 100) + 10); apply(); };
  i.oninput = apply;
  w.append(dec, i, pct, inc); return w;
}
function ctTog(label, val, on) {
  const l = document.createElement('label'); l.className = 'ct-tog';
  const i = document.createElement('input'); i.type = 'checkbox'; i.checked = val; i.onchange = () => on(i.checked);
  l.append(i, document.createTextNode(' ' + label)); return l;
}
// Place the corner resize handle over the selected element's bottom-right (or hide it).
function positionHandle(box) {
  const h = $('capHandle'); if (!h) return;
  if (!box || !unlocked) { h.style.display = 'none'; return; }
  const sr = stage().getBoundingClientRect();
  h.style.display = 'block';
  h.style.left = (box.right - sr.left) + 'px';
  h.style.top = (box.bottom - sr.top) + 'px';
}
// --- on-canvas select + drag. Click selects at curLevel (word / line-row / stack); the
// selected thing then drags (word -> wx/wy, line -> wx/wy on all its words, stack -> dx/dy).
function onCanvasDown(e) {
  if (!unlocked || !project) return;
  if (e.target.id === 'capHandle') { startResize(e); return; }
  const wEl = e.target.closest('[data-wid]'), lEl = e.target.closest('[data-linekey]');
  if (!wEl && !lEl) return;
  const wid = wEl ? +wEl.dataset.wid : null;
  const key = lEl ? +lEl.dataset.linekey : lineKeyOfWord(wid);
  if (key == null) return;
  if (curLevel === 'stack' || wid == null) sel = { kind: 'stack', key };
  else if (curLevel === 'line') sel = { kind: 'line', key, ids: visualRowIds(wid) };
  else sel = { kind: 'word', id: wid, key };
  const rect = stage().getBoundingClientRect();
  const W = rect.width || 1, H = rect.height || 1;
  if (sel.kind === 'word') uDrag = { target: 'word', id: wid, startX: e.clientX, startY: e.clientY, base: { ...(project.wordStyles[wid] || {}) }, W, H, pointerId: e.pointerId };
  else if (sel.kind === 'line') uDrag = { target: 'line', ids: sel.ids, bases: sel.ids.map((id) => ({ ...(project.wordStyles[id] || {}) })), startX: e.clientX, startY: e.clientY, W, H, pointerId: e.pointerId };
  else uDrag = { target: 'stack', key, startX: e.clientX, startY: e.clientY, base: { ...(project.lineStyles[key] || {}) }, W, H, pointerId: e.pointerId };
  try { stage().setPointerCapture(e.pointerId); } catch {}   // capture on vwrap: survives the caption layer repaint mid-drag
  e.preventDefault(); e.stopPropagation();
  refresh();
}
function startResize(e) {
  const box = selBox(); if (!box) return;
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const baseScale = sel.kind === 'word' ? ((project.wordStyles[sel.id] || {}).sizeScale || 1)
    : sel.kind === 'line' ? ((project.wordStyles[sel.ids[0]] || {}).sizeScale || 1)
    : ((project.lineStyles[sel.key] || {}).sizeScale || 1);
  uDrag = { target: 'resize', cx, cy, startDist: Math.hypot(e.clientX - cx, e.clientY - cy) || 1, baseScale, pointerId: e.pointerId };
  try { stage().setPointerCapture(e.pointerId); } catch {}
  e.preventDefault(); e.stopPropagation();
}
function onCanvasMove(e) {
  if (!uDrag || e.pointerId !== uDrag.pointerId) return;
  if (uDrag.target === 'resize') {
    const scale = +clampN(uDrag.baseScale * (Math.hypot(e.clientX - uDrag.cx, e.clientY - uDrag.cy) / uDrag.startDist), 0.3, 4).toFixed(3);
    const set = (o, map, kk) => { o.sizeScale = scale; if (Math.abs(scale - 1) < 0.02) delete o.sizeScale; pruneEmpty(map, kk); };
    if (sel.kind === 'word') set(wovOf(sel.id), project.wordStyles, sel.id);
    else if (sel.kind === 'line') sel.ids.forEach((id) => set(wovOf(id), project.wordStyles, id));
    else set(lovOf(sel.key), project.lineStyles, sel.key);
    repaint(); return;
  }
  const ddx = ((e.clientX - uDrag.startX) / uDrag.W) * 100, ddy = ((e.clientY - uDrag.startY) / uDrag.H) * 100;
  if (uDrag.target === 'word') {
    const o = wovOf(uDrag.id);
    o.wx = +clampN((uDrag.base.wx || 0) + ddx, -60, 60).toFixed(2);
    o.wy = +clampN((uDrag.base.wy || 0) + ddy, -80, 80).toFixed(2);
  } else if (uDrag.target === 'line') {
    uDrag.ids.forEach((id, i) => { const o = wovOf(id); o.wx = +clampN((uDrag.bases[i].wx || 0) + ddx, -60, 60).toFixed(2); o.wy = +clampN((uDrag.bases[i].wy || 0) + ddy, -80, 80).toFixed(2); });
  } else {
    const o = lovOf(uDrag.key);
    o.dx = +clampN((uDrag.base.dx || 0) + ddx, -45, 45).toFixed(2);
    o.dy = +clampN((uDrag.base.dy || 0) + ddy, -45, 45).toFixed(2);
  }
  repaint();
}
function onCanvasUp() {
  if (!uDrag) return; uDrag = null;
  if (sel && sel.kind === 'word') pruneEmpty(project.wordStyles, sel.id);
  else if (sel && sel.kind === 'line' && sel.ids) sel.ids.forEach((id) => pruneEmpty(project.wordStyles, id));
  else if (sel && sel.key != null) pruneEmpty(project.lineStyles, sel.key);
  renderLayoutPanel();
}
// --- structural ops ---
function spotlightWord(id) {
  const lines = manualLines(); const li = L.lineIndexOf(lines, id); if (li < 0) return;
  const line = lines[li], wi = line.indexOf(id);
  const before = line.slice(0, wi), after = line.slice(wi + 1), repl = [];
  if (before.length) repl.push(before); repl.push([id]); if (after.length) repl.push(after);
  lines.splice(li, 1, ...repl);
  commitLines(lines);                       // rebuild() re-segments; the word is now its own line
  sel = { kind: 'word', id, key: id }; refresh();
}
function applyStyleBelow(key) {              // Mother → children (Visual Wand): copy look downward
  const src = project.lineStyles[key];
  if (!src || !Object.keys(src).some((k) => k !== 'dx' && k !== 'dy')) { setStatus('this line has no look to copy'); return; }
  const look = { ...src }; delete look.dx; delete look.dy;   // propagate look, keep each line's own position
  const idx = renderScenes.findIndex((sc) => sc.words[0] && sc.words[0].id === key);
  if (idx < 0) return; let n = 0;
  for (let i = idx + 1; i < renderScenes.length; i++) { const k = renderScenes[i].words[0].id; project.lineStyles[k] = { ...(project.lineStyles[k] || {}), ...look }; n++; }
  repaint(); setStatus(`🪄 applied look to ${n} line${n === 1 ? '' : 's'} below`);
}
// Thorough reset of the current selection. A STACK reset clears the whole caption — its
// line override AND every word's override — so it truly restores everything (Bug 4).
function resetSel() {
  if (!sel) return;
  if (sel.kind === 'word') delete project.wordStyles[sel.id];
  else if (sel.kind === 'line' && sel.ids) sel.ids.forEach((id) => delete project.wordStyles[id]);
  else { delete project.lineStyles[sel.key]; const sc = sceneByKey(sel.key); if (sc) sc.words.forEach((w) => delete project.wordStyles[w.id]); }
}
function resetPositions() { for (const k in project.lineStyles) { delete project.lineStyles[k].dx; delete project.lineStyles[k].dy; pruneEmpty(project.lineStyles, k); } refresh(); setStatus('positions reset'); }
function resetLayout() { project.lineStyles = {}; project.wordStyles = {}; sel = null; refresh(); setStatus('all layout overrides cleared'); }
// --- selection panel ---
function renderLayoutPanel() {
  const host = $('layoutBody'); if (!host) return; host.innerHTML = '';
  if (!unlocked) { host.innerHTML = '<div class="layout-none">Unlock to move lines &amp; words on the video.</div>'; return; }
  if (!sel) { host.innerHTML = '<div class="layout-none">Click a line or a word on the video to edit it.</div>'; return; }
  host.appendChild(sel.kind === 'word' ? wordControls(sel.id) : lineControls(sel.key));
}
function fontOpts(cur, first) { return `<option value="">${first}</option>` + fontFamilies().map((f) => `<option value="${f}"${f === cur ? ' selected' : ''}>${f}</option>`).join(''); }
function lineControls(key) {
  const sc = sceneByKey(key), o = project.lineStyles[key] || {};
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  const txt = sc ? sc.words.map((w) => w.text).join(' ') : '(line)';
  wrap.innerHTML = `
    <div class="layout-sel">Line: “${escapeHtml(txt).slice(0, 60)}”</div>
    <div class="ctl"><span>Font</span><select id="loFont">${fontOpts(o.font || '', '(template)')}</select></div>
    <div class="row two">
      <div class="ctl"><span>Size <b id="loSizeVal" class="seg-val"></b></span><input id="loSize" type="range" min="0.5" max="2" step="0.05"/></div>
      <div class="ctl"><span>Opacity <b id="loOpVal" class="seg-val"></b></span><input id="loOp" type="range" min="0.1" max="1" step="0.05"/></div>
    </div>
    <div class="row two">
      <div class="ctl"><span>Move X <b id="loXVal" class="seg-val"></b></span><input id="loX" type="range" min="-45" max="45" step="1"/></div>
      <div class="ctl"><span>Move Y <b id="loYVal" class="seg-val"></b></span><input id="loY" type="range" min="-45" max="45" step="1"/></div>
    </div>
    <div class="row two">
      <div class="ctl"><span>Fade in <b id="loFinVal" class="seg-val"></b></span><input id="loFin" type="range" min="0" max="2000" step="50"/></div>
      <div class="ctl"><span>Fade out <b id="loFoutVal" class="seg-val"></b></span><input id="loFout" type="range" min="0" max="2000" step="50"/></div>
    </div>
    <div class="ctl"><span>Line color</span><div class="rowflex"><label class="f"><input type="checkbox" id="loColOn"/> override</label><input id="loCol" type="color"/></div></div>
    <div class="row"><button id="loWand" class="ai" title="Copy this line's look to every line below">🪄 Apply to lines below</button><button id="loFind" title="Jump the video to this line">Find stack</button></div>
    <div class="row"><button id="loReset" class="ghost">Reset this line</button></div>`;
  const q = (i) => wrap.querySelector('#' + i);
  q('loSize').value = o.sizeScale || 1; q('loSizeVal').textContent = (o.sizeScale || 1).toFixed(2) + '×';
  q('loOp').value = o.opacity ?? 1; q('loOpVal').textContent = Math.round((o.opacity ?? 1) * 100) + '%';
  q('loX').value = o.dx || 0; q('loXVal').textContent = (o.dx || 0) + '%';
  q('loY').value = o.dy || 0; q('loYVal').textContent = (o.dy || 0) + '%';
  // Fade in/out: the slider shows the TEMPLATE's fade by default; moving it sets a per-stack
  // override (entranceMs/exitMs, ms). Sliding back to the template value clears the override.
  const baseSt = (sc ? styleMap[effStyleId(sc)] : null) || {};
  const tplIn = baseSt.entranceMs != null ? baseSt.entranceMs : 220;
  const tplOut = baseSt.exitMs != null ? baseSt.exitMs : 0;
  const curIn = o.entranceMs != null ? o.entranceMs : tplIn;
  const curOut = o.exitMs != null ? o.exitMs : tplOut;
  q('loFin').value = curIn; q('loFinVal').textContent = (curIn / 1000).toFixed(2) + 's';
  q('loFout').value = curOut; q('loFoutVal').textContent = (curOut / 1000).toFixed(2) + 's';
  q('loColOn').checked = !!o.color; q('loCol').value = o.color || '#ffffff';
  q('loFont').onchange = () => { const v = q('loFont').value; const oo = lovOf(key); if (v) oo.font = v; else delete oo.font; pruneEmpty(project.lineStyles, key); repaint(); };
  q('loSize').oninput = () => { const v = +q('loSize').value; const oo = lovOf(key); oo.sizeScale = v; if (v === 1) delete oo.sizeScale; q('loSizeVal').textContent = v.toFixed(2) + '×'; pruneEmpty(project.lineStyles, key); repaint(); };
  q('loOp').oninput = () => { const v = +q('loOp').value; const oo = lovOf(key); oo.opacity = v; if (v === 1) delete oo.opacity; q('loOpVal').textContent = Math.round(v * 100) + '%'; pruneEmpty(project.lineStyles, key); repaint(); };
  q('loX').oninput = () => { const v = +q('loX').value; const oo = lovOf(key); oo.dx = v; if (!v) delete oo.dx; q('loXVal').textContent = v + '%'; pruneEmpty(project.lineStyles, key); repaint(); };
  q('loY').oninput = () => { const v = +q('loY').value; const oo = lovOf(key); oo.dy = v; if (!v) delete oo.dy; q('loYVal').textContent = v + '%'; pruneEmpty(project.lineStyles, key); repaint(); };
  q('loFin').oninput = () => { const v = +q('loFin').value; const oo = lovOf(key); if (v === tplIn) delete oo.entranceMs; else oo.entranceMs = v; q('loFinVal').textContent = (v / 1000).toFixed(2) + 's'; pruneEmpty(project.lineStyles, key); repaint(); };
  q('loFout').oninput = () => { const v = +q('loFout').value; const oo = lovOf(key); if (v === tplOut) delete oo.exitMs; else oo.exitMs = v; q('loFoutVal').textContent = (v / 1000).toFixed(2) + 's'; pruneEmpty(project.lineStyles, key); repaint(); };
  const applyCol = () => { const oo = lovOf(key); if (q('loColOn').checked) oo.color = q('loCol').value; else delete oo.color; pruneEmpty(project.lineStyles, key); repaint(); };
  q('loColOn').onchange = applyCol; q('loCol').oninput = () => { q('loColOn').checked = true; applyCol(); };
  q('loWand').onclick = () => applyStyleBelow(key);
  q('loFind').onclick = () => { if (sc) video.currentTime = sc.start + 0.001; };
  q('loReset').onclick = () => { delete project.lineStyles[key]; const sc2 = sceneByKey(key); if (sc2) sc2.words.forEach((w) => delete project.wordStyles[w.id]); refresh(); };
  return wrap;
}
function wordControls(id) {
  const w = byId.get(id), o = project.wordStyles[id] || {};
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  wrap.innerHTML = `
    <div class="layout-sel">Word: “${escapeHtml(w ? w.text : '')}”</div>
    <div class="row two">
      <div class="ctl"><span>Size <b id="woSizeVal" class="seg-val"></b></span><input id="woSize" type="range" min="0.5" max="2.5" step="0.05"/></div>
      <div class="ctl"><span>Weight</span><label class="f"><input type="checkbox" id="woBold"/> bold</label></div>
    </div>
    <div class="ctl"><span>Font</span><select id="woFont">${fontOpts(o.font || '', '(line)')}</select></div>
    <div class="ctl"><span>Color</span><div class="rowflex"><label class="f"><input type="checkbox" id="woColOn"/> override</label><input id="woCol" type="color"/></div></div>
    <div class="row"><button id="woSpot" class="ai" title="Isolate this word onto its own line">🔦 Spotlight</button><button id="woHi" title="Toggle highlight">Highlight</button></div>
    <div class="row"><button id="woReset" class="ghost">Reset this word</button></div>`;
  const q = (i) => wrap.querySelector('#' + i);
  q('woSize').value = o.sizeScale || 1; q('woSizeVal').textContent = (o.sizeScale || 1).toFixed(2) + '×';
  q('woBold').checked = !!o.bold; q('woColOn').checked = !!o.color; q('woCol').value = o.color || '#ffe01b';
  q('woSize').oninput = () => { const v = +q('woSize').value; const oo = wovOf(id); oo.sizeScale = v; if (v === 1) delete oo.sizeScale; q('woSizeVal').textContent = v.toFixed(2) + '×'; pruneEmpty(project.wordStyles, id); repaint(); };
  q('woBold').onchange = () => { const oo = wovOf(id); if (q('woBold').checked) oo.bold = true; else delete oo.bold; pruneEmpty(project.wordStyles, id); repaint(); };
  q('woFont').onchange = () => { const v = q('woFont').value; const oo = wovOf(id); if (v) oo.font = v; else delete oo.font; pruneEmpty(project.wordStyles, id); repaint(); };
  const applyCol = () => { const oo = wovOf(id); if (q('woColOn').checked) oo.color = q('woCol').value; else delete oo.color; pruneEmpty(project.wordStyles, id); repaint(); };
  q('woColOn').onchange = applyCol; q('woCol').oninput = () => { q('woColOn').checked = true; applyCol(); };
  q('woSpot').onclick = () => spotlightWord(id);
  q('woHi').onclick = () => { if (w) { setHi(w, !w.hi); refreshHi(); } };
  q('woReset').onclick = () => { delete project.wordStyles[id]; refresh(); };
  return wrap;
}

// ---------- controls wiring ----------
function bindStatic() {
  $('btnOpen').onclick = openVideo;
  $('btnOpen2').onclick = (e) => { e.stopPropagation(); openVideo(); };
  if ($('btnDemo')) $('btnDemo').onclick = (e) => { e.stopPropagation(); loadDemo(); };
  $('undoBtn').onclick = undo;
  $('redoBtn').onclick = redo;
  $('btnFind').onclick = () => toggleFind();
  $('findInp').oninput = runFind;
  $('findCase').onchange = runFind;
  $('findInp').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { toggleFind(false); } };
  $('replInp').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); } };
  $('findNext').onclick = () => findStep(1);
  $('findPrev').onclick = () => findStep(-1);
  $('replOne').onclick = replaceCurrent;
  $('replAll').onclick = replaceAll;
  scrubAll();   // tap+drag any number field to change it
  if ($('btnSaveTpl')) $('btnSaveTpl').onclick = saveAsTemplate;
  setupPanes();   // resizable columns + collapsible inspector
  setupRail();    // far-left Kalakar icon rail
  $('btnHome').onclick = goHome;
  $('progressCancel').onclick = cancelOp;
  // Homepage drop zone: click anywhere (except a control) to pick; real drag-and-drop to ingest.
  const dz = $('dropZone');
  if (dz) {
    dz.onclick = (e) => { if (e.target.closest('button,select,label,option,a')) return; openVideo(); };
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('dragover'); };
    dz.ondragleave = (e) => { if (e.target === dz || !dz.contains(e.relatedTarget)) dz.classList.remove('dragover'); };
    dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('dragover'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) ingestFile(f); };
  }
  // Stop the browser from navigating away if a file is dropped outside the zone.
  window.addEventListener('dragover', (e) => { if (!project) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (!project) e.preventDefault(); });
  $('langSel').onchange = () => syncScriptVis('langSel', 'scriptWrap', 'langHint');
  $('langSel2').onchange = () => syncScriptVis('langSel2', 'scriptWrap2');
  $('btnReTx').onclick = reTranscribe;
  $('btnPolish').onclick = polishSpelling;
  $('btnDepunct').onclick = depunct;
  const bAddLine = $('btnAddLine'); if (bAddLine) bAddLine.onclick = addEmptyLineAtEnd;
  // Alt+←/→ move the single selected word to the adjacent line; Esc clears selection.
  document.addEventListener('keydown', (e) => {
    if (!project) return;
    const t = e.target; const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); toggleFind(); return; }
    // Undo / redo (not while typing in a field)
    if (mod && (e.key === 'z' || e.key === 'Z')) { if (typing) return; e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { if (typing) return; e.preventDefault(); redo(); return; }
    if (typing) return;
    // Space = play / pause
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); return; }
    // Left / Right = scrub the timeline (Shift = 1s, plain = 0.2s). Alt+arrow still moves a selected word between lines.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (e.altKey && selWords.size === 1) { e.preventDefault(); moveWordAdjacent([...selWords][0], dir); return; }
      e.preventDefault();
      const step = e.shiftKey ? 1 : 0.2;
      const max = project.duration || video.duration || 1e9;
      if (!video.paused) video.pause();
      video.currentTime = Math.max(0, Math.min(max, (video.currentTime || 0) + dir * step));
      updatePlayhead(video.currentTime || 0); renderOverlay(video.currentTime || 0);
      return;
    }
    if (e.key === 'Escape' && selWords.size) { selWords.clear(); refreshSelectionUI(); }
  });
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  // Text tab
  $('fontSel').onchange = () => setOv('font', $('fontSel').value);
  $('fontSize').onchange = () => setOv('size', +$('fontSize').value);
  $('letterSp').onchange = () => setOv('letterSpacing', +$('letterSp').value);
  $('colPrimary').oninput = () => { $('colPrimaryHex').value = $('colPrimary').value; setOv('primary', $('colPrimary').value); };
  $('colPrimaryHex').onchange = () => { const v = norm6($('colPrimaryHex').value); $('colPrimary').value = v; $('colPrimaryHex').value = v; setOv('primary', v); };
  $('colAccent').oninput = () => { $('colAccentHex').value = $('colAccent').value; setOv('accent', $('colAccent').value); };
  $('colAccentHex').onchange = () => { const v = norm6($('colAccentHex').value); $('colAccent').value = v; $('colAccentHex').value = v; setOv('accent', v); };
  const applyGrad = () => {
    const on = $('gradOn').checked; $('gradCtls').style.display = on ? '' : 'none';
    if (on) { setOv('textGradient', { from: $('gradFrom').value, to: $('gradTo').value, angle: +$('gradAngle').value }); setOv('gradientLevel', $('gradLevel').value); }
    else setOv('textGradient', null);
  };
  $('gradOn').onchange = applyGrad; $('gradFrom').oninput = applyGrad; $('gradTo').oninput = applyGrad;
  $('gradAngle').onchange = applyGrad; $('gradLevel').onchange = applyGrad;
  $('hiScale').oninput = () => { setOv('hiScale', +$('hiScale').value); $('hiScaleVal').textContent = (+$('hiScale').value).toFixed(2) + '×'; };          // #13 emphasis size
  $('fxGlowStr').oninput = () => { setOv('glowStrength', +$('fxGlowStr').value); $('fxGlowStrVal').textContent = $('fxGlowStr').value + '%'; };            // #14 glow strength
  $('trDir').onchange = () => setOv('transitionDir', $('trDir').value || null);                                                                             // #15 transition direction
  $('trDist').oninput = () => { setOv('transitionDist', +$('trDist').value); $('trDistVal').textContent = $('trDist').value + 'px'; };                        // #15 transition distance
  $('caseSel').onchange = () => setOv('case', $('caseSel').value || null);
  $('lineHt').oninput = () => setOv('lineHeight', +$('lineHt').value || 1.15);
  $('weightSel').onchange = () => setOv('weight', +$('weightSel').value);
  document.querySelectorAll('#alignToggle button').forEach((b) => (b.onclick = () => { setOv('textAlign', b.dataset.al); document.querySelectorAll('#alignToggle button').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('boxOn').onchange = () => setBoxOv('enabled', $('boxOn').checked);
  $('boxColor').oninput = () => { $('boxColorHex').value = $('boxColor').value; setBoxOv('color', $('boxColor').value); };
  $('boxColorHex').onchange = () => { const v = norm6($('boxColorHex').value); $('boxColor').value = v; setBoxOv('color', v); };
  $('boxOpacity').oninput = () => { $('boxOpVal').textContent = (+$('boxOpacity').value).toFixed(2); setBoxOv('opacity', +$('boxOpacity').value); };
  $('posX').oninput = () => { $('posXVal').textContent = $('posX').value + '%'; setPosOv('x', +$('posX').value); };
  $('posY').oninput = () => { $('posYVal').textContent = $('posY').value + '%'; setPosOv('y', +$('posY').value); };
  const onSeg = () => { project.manualBreaks = false; project.words.forEach((w) => (w.br = false)); project.segmentation = { mode: $('segMode').value, max: +$('segMax').value, autoBreak: $('segAutoBreak').checked }; $('segValLbl').textContent = $('segMax').value; rebuild(); };
  $('segMode').onchange = onSeg;
  $('segMax').oninput = () => ($('segValLbl').textContent = $('segMax').value);
  $('segMax').onchange = onSeg;
  $('segAutoBreak').onchange = onSeg;
  $('linesSel').onchange = () => { project.maxLines = +$('linesSel').value; rebuild(); };
  $('offset').oninput = () => { project.offset = +$('offset').value; $('offVal').textContent = (project.offset >= 0 ? '+' : '') + project.offset.toFixed(2) + 's'; renderOverlay(video.currentTime || 0); };
  $('btnApplyHi').onclick = () => {
    const rules = []; if ($('rNumbers').checked) rules.push('numbers'); if ($('rAllcaps').checked) rules.push('allcaps'); if ($('rKeywords').checked) rules.push('keywords');
    autoHighlight(project.words, { rules, keywords: $('kw').value.split(',').map((s) => s.trim()).filter(Boolean) });
    if ($('rLongest').checked) applyLongest();
    rebuild();
  };
  $('btnClearHi').onclick = () => { project.words.forEach((w) => (w.hi = false)); rebuild(); };
  $('btnAi').onclick = aiPick;
  $('btnResetStyle').onclick = () => { project.styleOverrides = {}; syncTextControls(); syncTransitionControls(); rebuild(); };

  // Transitions tab
  document.querySelectorAll('#entGrid .an').forEach((el) => (el.onclick = () => { setOv('entrance', el.dataset.ent); syncTransitionControls(); }));
  document.querySelectorAll('#scopeToggle button').forEach((b) => (b.onclick = () => { setOv('animScope', b.dataset.scope); syncTransitionControls(); }));
  document.querySelectorAll('#stackAlignToggle button').forEach((b) => (b.onclick = () => { setOv('stackAlign', b.dataset.sa); syncTransitionControls(); }));
  $('spd').oninput = () => { $('spdVal').textContent = $('spd').value; setOv('entranceMs', speedToMs(+$('spd').value)); };
  bindAnimateEffects();

  // kinetic tab
  $('kinAdd').onclick = addKineticAtPlayhead;
  $('kinText').oninput = () => { const ev = selEv(); if (!ev) return; ev.text = $('kinText').value; renderOverlay(video.currentTime || 0); renderKineticTrack(); };
  document.querySelectorAll('#kinPresets .an').forEach((el) => (el.onclick = () => { const ev = selEv(); if (!ev) return; ev.preset = el.dataset.kp; syncKinForm(); renderOverlay(video.currentTime || 0); }));
  $('kinX').oninput = () => { $('kinXVal').textContent = $('kinX').value + '%'; kinPos('x', +$('kinX').value); };
  $('kinY').oninput = () => { $('kinYVal').textContent = $('kinY').value + '%'; kinPos('y', +$('kinY').value); };
  $('kinSize').oninput = () => { const ev = selEv(); if (!ev) return; ev.size = +$('kinSize').value; $('kinSizeVal').textContent = (+$('kinSize').value).toFixed(1) + '×'; renderOverlay(video.currentTime || 0); };
  $('kinColor').oninput = () => { const ev = selEv(); if (!ev) return; ev.color = $('kinColor').value; $('kinColorHex').value = $('kinColor').value; renderOverlay(video.currentTime || 0); };
  $('kinColorHex').onchange = () => { const ev = selEv(); if (!ev) return; const v = norm6($('kinColorHex').value); ev.color = v; $('kinColor').value = v; renderOverlay(video.currentTime || 0); };
  $('kinDelete').onclick = () => { if (selKin != null) deleteKinetic(selKin); };

  // timeline
  $('tlZoomIn').onclick = () => { pxPerSec = Math.min(400, pxPerSec * 1.4); renderTimeline(); };
  $('tlZoomOut').onclick = () => { pxPerSec = Math.max(20, pxPerSec / 1.4); renderTimeline(); };
  // drag-to-retime: delegated on #tlWords (survives every renderTimeline rebuild; pointer
  // capture retargets move/up to the captured chip even when the pointer leaves it).
  const tw = $('tlWords');
  tw.addEventListener('pointerdown', onTlPointerDown);
  tw.addEventListener('pointermove', onTlPointerMove);
  tw.addEventListener('pointerup', onTlPointerUp);
  tw.addEventListener('pointercancel', onTlPointerCancel);
  tw.addEventListener('contextmenu', (e) => {
    const chip = e.target.closest('.tlword'); e.preventDefault();
    if (chip) { const id = +chip.dataset.id; if (!selWords.has(id)) { selWords = new Set([id]); refreshSelectionUI(); } }
    if (selWords.size) timelineSelMenu(e.clientX, e.clientY);
  });
  $('tlRippleCb').onchange = (e) => (tlRipple = e.target.checked);
  $('tlSnapCb').onchange = (e) => (tlSnapOn = e.target.checked);
  // Empty-area rubber-band box-select. #tlWords is 0-height (its chips are absolute), so the
  // empty timeline never reaches it — bind on the full-size #tlInner instead. (This is the fix.)
  $('tlInner').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !project) return;
    if (e.target.closest('.tlword') || e.target.closest('.tlkin')) return;   // chips/kinetic handled on #tlWords
    startBoxSelect(e);
  });
  // Timeline view: per-word chips vs full-sentence (per-line) chunks.
  tlView = (() => { try { return localStorage.getItem('capStudio.tlView') || 'word'; } catch { return 'word'; } })();
  document.querySelectorAll('#tlViewToggle button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tlv === tlView);
    b.onclick = () => {
      tlView = b.dataset.tlv;
      try { localStorage.setItem('capStudio.tlView', tlView); } catch {}
      document.querySelectorAll('#tlViewToggle button').forEach((x) => x.classList.toggle('on', x.dataset.tlv === tlView));
      if (project) renderTimeline();
    };
  });
  // Timeline height: expand taller / shrink to just the bar (video reclaims the height).
  tlSizeMode = (() => { try { return localStorage.getItem('capStudio.tlSize') || 'normal'; } catch { return 'normal'; } })();
  applyTlSize();
  $('tlExpand').onclick = () => { tlSizeMode = tlSizeMode === 'min' ? 'normal' : 'tall'; applyTlSize(); };
  $('tlShrink').onclick = () => { tlSizeMode = tlSizeMode === 'tall' ? 'normal' : 'min'; applyTlSize(); };
  $('tlScroll').addEventListener('click', (e) => {
    if (performance.now() < suppressScrollClickUntil) return;   // just finished a drag
    if (e.target.closest('.tlword') || e.target.closest('.tlkin')) return;
    if (selWords.size) { selWords.clear(); refreshSelectionUI(); }   // click empty space = clear selection
    const rect = $('tlInner').getBoundingClientRect();
    video.currentTime = Math.max(0, (e.clientX - rect.left) / pxPerSec);
  });
  // Ctrl/⌘ + wheel zooms the timeline around the cursor (like a real NLE).
  $('tlScroll').addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !project) return;
    e.preventDefault();
    const sc = $('tlScroll'); const rect = $('tlInner').getBoundingClientRect();
    const tAtCursor = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    pxPerSec = Math.min(400, Math.max(20, pxPerSec * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    renderTimeline();
    sc.scrollLeft = Math.max(0, tAtCursor * pxPerSec - (e.clientX - sc.getBoundingClientRect().left));
  }, { passive: false });

  // playback
  $('playBtn').onclick = () => (video.paused ? video.play() : video.pause());
  video.onplay = () => { $('playBtn').textContent = '❚❚'; startPlayLoop(); };
  video.onpause = () => { $('playBtn').textContent = '▶'; stopPlayLoop(); renderOverlay(video.currentTime); updatePlayhead(video.currentTime); };
  video.onended = () => { $('playBtn').textContent = '▶'; stopPlayLoop(); };
  // While paused (scrubbing) render on timeupdate; while playing the rAF loop owns rendering.
  video.ontimeupdate = () => {
    $('seek').value = Math.round((video.currentTime / (video.duration || 1)) * 1000);
    $('tlabel').textContent = `${video.currentTime.toFixed(2)} / ${(video.duration || 0).toFixed(2)}`;
    if (video.paused) { renderOverlay(video.currentTime); updatePlayhead(video.currentTime); }
  };
  $('seek').oninput = () => (video.currentTime = (+$('seek').value / 1000) * (video.duration || 0));
  window.addEventListener('resize', () => { if (project) { renderTimeline(); renderOverlay(video.currentTime); } });

  // export / settings / dialogs
  $('btnPreview').onclick = doPreview;
  $('btnExport').onclick = doExport;
  $('btnExportAlpha').onclick = doExportAlpha;
  $('btnSrt').onclick = exportSRT;

  // P4 layout editor: unlock toggle + on-canvas select/drag + resets
  $('btnUnlock').onclick = toggleUnlock; $('btnUnlock2').onclick = toggleUnlock;
  $('btnResetPos').onclick = resetPositions; $('btnResetLayout').onclick = resetLayout;
  const fbtn = $('capFinder');
  if (fbtn) fbtn.onclick = () => { finderOn = !finderOn; fbtn.classList.toggle('on', finderOn); if (finderOn && !sel) { const k = activeSceneKey(); if (k != null) sel = { kind: 'stack', key: k }; } refresh(); };
  // floating toolbar: tabs switch level, reset/close, and never start a canvas drag
  const ctb = $('capToolbar');
  if (ctb) {
    ctb.addEventListener('pointerdown', (e) => e.stopPropagation());
    ctb.querySelectorAll('.ct-tab').forEach((b) => (b.onclick = () => setLevel(b.dataset.lvl)));
    $('ctReset').onclick = () => { resetSel(); ctIcon = null; refresh(); };
    $('ctClose').onclick = () => { sel = null; ctIcon = null; refresh(); };
  }
  const vw = $('vwrap');
  vw.addEventListener('pointerdown', onCanvasDown);
  vw.addEventListener('pointermove', onCanvasMove);
  vw.addEventListener('pointerup', onCanvasUp);
  vw.addEventListener('pointercancel', onCanvasUp);
  $('btnSettings').onclick = async () => { const s = await cap.getSettings(); $('geminiKey').value = ''; $('geminiKey').placeholder = s.hasGemini ? '•••••• (saved)' : 'AIza…'; $('whisperQuality').value = s.whisperQuality || 'balanced'; $('ctcAlign').checked = s.ctcAlign !== false; $('settingsDlg').showModal(); };
  $('settingsClose').onclick = () => $('settingsDlg').close();
  $('settingsSave').onclick = async () => { const v = $('geminiKey').value.trim(); const patch = { whisperQuality: $('whisperQuality').value, ctcAlign: $('ctcAlign').checked }; if (v) patch.geminiKey = v; await cap.setSettings(patch); $('settingsDlg').close(); setStatus('settings saved'); };
  $('closePrev').onclick = () => $('previewDlg').close();
}

function applyLongest() {
  const seg = { ...project.segmentation, manual: !!project.manualBreaks };
  for (const sc of segment(project.words, seg)) {
    if (sc.words.some((w) => w.hi)) continue;
    let best = null;
    for (const w of sc.words) { const len = (w.text.match(/\p{L}/gu) || []).length; if (len >= 4 && (!best || len > best.len)) best = { id: w.id, len }; }
    if (best) { const o = byId.get(best.id); if (o) o.hi = true; }
  }
}
async function aiPick() {
  setStatus('✨ Gemini picking…'); $('btnAi').disabled = true;
  const r = await cap.aiHighlight(project.words.map((w) => ({ text: w.text })));
  $('btnAi').disabled = false;
  if (!r.ok) { setStatus('AI unavailable'); alert(r.error); if (/key/i.test(r.error || '')) $('btnSettings').click(); return; }
  const set = new Set(r.highlight); project.words.forEach((w, i) => { if (set.has(i)) w.hi = true; });
  rebuild(); setStatus(`✨ highlighted ${r.highlight.length}`);
}

// ---------- output ----------
function cleanProject() {
  const p = JSON.parse(JSON.stringify(project));
  delete p.fileUrl; delete p.waveform;
  delete p.stackStyleMap;   // derived from stackStyles at render time — never persist the resolved map
  p.autoHighlight = { enabled: false, rules: [], keywords: [] };
  // keep word ids: per-line / per-word overrides (project.lineStyles / wordStyles) key off them
  (p.kinetic || []).forEach((e) => { delete e.id; delete e.wordIds; });   // renderer keys off text/start/end only
  return p;
}
async function doPreview() {
  setStatus('rendering clip…'); showProgress('Rendering clip…', 'Burning captions into a 4s preview.'); $('btnPreview').disabled = true;
  const r = await cap.preview(cleanProject(), +video.currentTime.toFixed(2), 4);
  $('btnPreview').disabled = false; hideProgress();
  if (!r.ok) { setStatus('preview failed'); alert(r.error); return; }
  setStatus('ready'); $('previewTitle').textContent = 'Exact preview (4s)'; $('previewInfo').textContent = ''; $('previewShow').style.display = 'none';
  $('previewVid').src = r.fileUrl; $('previewDlg').showModal();
}
async function doExport() {
  setStatus('rendering full video…'); showProgress('Exporting…', 'Burning captions into the full video.'); $('btnExport').disabled = true;
  let r;
  try {
    r = await cap.render(cleanProject());
  } catch (e) {
    setStatus('export failed');
    alert('The export stopped before it finished. Nothing was saved, but your edits are safe. Try exporting again.\n\nTechnical details: ' + String((e && e.message) || e).slice(0, 300));
    return;
  } finally {
    $('btnExport').disabled = false; hideProgress();
  }
  if (!r.ok) { setStatus('export failed'); alert(r.error); return; }
  setStatus('exported ✓');
  $('previewTitle').textContent = 'Exported video'; $('previewInfo').textContent = 'Saved next to your source: ' + r.path;
  $('previewShow').style.display = ''; $('previewShow').onclick = () => cap.showItem(r.path);
  $('previewVid').src = r.fileUrl; $('previewDlg').showModal();
}
async function doExportAlpha() {
  setStatus('rendering alpha .mov…'); showProgress('Exporting alpha…', 'Rendering the captions on a transparent background (ProRes 4444) — layer it over your footage in Premiere.'); $('btnExportAlpha').disabled = true;
  let r;
  try {
    r = await cap.exportAlpha(cleanProject());
  } catch (e) {
    setStatus('alpha export failed');
    alert('The alpha export stopped before it finished. Nothing was saved, but your edits are safe. Try again.\n\nTechnical details: ' + String((e && e.message) || e).slice(0, 300));
    return;
  } finally {
    $('btnExportAlpha').disabled = false; hideProgress();
  }
  if (!r.ok) { setStatus('alpha export failed'); alert(r.error); return; }
  setStatus('alpha .mov exported ✓');
  // ProRes 4444 won't play in the built-in <video>, so skip the inline preview — reveal the file
  // and tell the user how to use it.
  $('previewVid').removeAttribute('src'); $('previewVid').load && $('previewVid').load();
  $('previewTitle').textContent = 'Alpha caption track (ProRes 4444 .mov)';
  $('previewInfo').textContent = 'Saved next to your source: ' + r.path + '  ·  In Premiere/After Effects, drop it on a track ABOVE your footage — the transparent areas show your video through.';
  $('previewShow').style.display = ''; $('previewShow').onclick = () => cap.showItem(r.path);
  $('previewDlg').showModal();
}
async function exportSRT() {
  const seg = { ...project.segmentation, manual: !!project.manualBreaks };
  const srt = toSRT(segment(project.words, seg));
  const name = (project.video.split('/').pop() || 'captions').replace(/\.[^.]+$/, '');
  const r = await cap.exportSrt(srt, name); if (r.ok) setStatus('SRT saved');
}
