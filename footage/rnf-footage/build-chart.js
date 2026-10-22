#!/usr/bin/env node
/**
 * build-chart.js — render an rnf gameplay index into a self-contained, filterable HTML
 * dashboard (search + filter by scene/activity/beat/intensity/HUD, live counts). Clean
 * dark "gaming" look. No external deps — openable / host-able as-is.
 *
 *   node build-chart.js <game-folder>        # reads <game-folder>/broll-index.json
 *   node build-chart.js --index <path> --out <html>
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let gameDir = null, indexPath = null, outPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--index') indexPath = args[++i];
  else if (args[i] === '--out') outPath = args[++i];
  else if (!args[i].startsWith('--') && !gameDir) gameDir = args[i];
}
if (!indexPath) indexPath = gameDir ? path.join(path.resolve(gameDir), 'broll-index.json') : null;
if (!indexPath || !fs.existsSync(indexPath)) {
  console.error('Usage: build-chart.js <game-folder>  (or --index <path> [--out <html>])');
  process.exit(1);
}
if (!outPath) outPath = path.join(path.dirname(indexPath), 'broll-chart.html');

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const ok = index.filter((r) => !r._error && !r._parse_error);
const errs = index.length - ok.length;
const totalMin = Math.round(ok.reduce((a, r) => a + (r.duration_s || 0), 0) / 60);
const games = [...new Set(ok.map((r) => r.game).filter(Boolean))];

const SCENES = [...new Set(ok.map((r) => r.scene_type).filter(Boolean))].sort();
const ACTS = [...new Set(ok.map((r) => r.activity).filter(Boolean))].sort();
const BEATS = ['hook-visual', 'gameplay-demo', 'feature-highlight', 'vibe/atmosphere', 'comparison', 'funny-moment', 'verdict/outro'];
const INTENS = ['calm', 'moderate', 'intense'];

const html = `<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>rnf gameplay b-roll — ${games.join(', ') || 'index'}</title>
<style>
:root{--bg:#0b0e14;--panel:#141925;--line:#232a3a;--ink:#e7ecf5;--mut:#8b95a9;--acc:#5ce1a6;--acc2:#7aa2ff}
*{box-sizing:border-box}
body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:var(--ink);background:var(--bg);font-size:14px}
header{padding:22px 28px 12px}
h1{font-size:20px;font-weight:800;margin:0 0 4px}
.sub{color:var(--mut);font-size:13px}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 14px}
.stat b{font-size:18px;display:block;color:var(--acc)}
.stat span{color:var(--mut);font-size:12px}
.controls{position:sticky;top:0;background:var(--bg);padding:12px 28px;border-bottom:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;align-items:center;z-index:5}
input,select{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink)}
input[type=search]{min-width:260px;flex:1}
label.chk{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:13px}
#grid{padding:16px 28px 60px;display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.card .f{font-weight:700;font-size:13px;word-break:break-all;color:var(--acc2)}
.card .s{margin:6px 0;font-size:13.5px}
.meta{color:var(--mut);font-size:12px;margin:6px 0}
.tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.tag{background:#1c2333;color:#aeb8cc;border-radius:6px;padding:2px 8px;font-size:11px}
.beat{background:#14261f;color:var(--acc);border:1px solid #23402f;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600}
.ranges{font-size:12px;color:#c7d0e0;margin-top:6px}
.hud{display:inline-block;border-radius:6px;padding:1px 6px;font-size:11px;margin-left:6px}
.hud.on{background:#2a1e12;color:#e0a35a}.hud.off{background:#12261c;color:var(--acc)}
.count{color:var(--mut);font-size:13px;padding:6px 28px}
</style></head><body>
<header>
<h1>rnf gameplay b-roll index</h1>
<div class="sub">${games.join(' · ') || 'gathered footage'} · tagged by index-broll.js · match a script beat to a clip, then trim by range</div>
<div class="stats">
<div class="stat"><b>${ok.length}</b><span>clips (~${totalMin} min)</span></div>
<div class="stat"><b>${games.length}</b><span>game${games.length === 1 ? '' : 's'}</span></div>
<div class="stat"><b>${ACTS.length}</b><span>activities</span></div>
${errs ? `<div class="stat"><b>${errs}</b><span>errors (re-run)</span></div>` : ''}
</div>
</header>
<div class="controls">
<input type="search" id="q" placeholder="Search subject / activity / setting / tags / notes…">
<select id="scene"><option value="">any scene</option>${SCENES.map((s) => `<option>${s}</option>`).join('')}</select>
<select id="act"><option value="">any activity</option>${ACTS.map((a) => `<option>${a}</option>`).join('')}</select>
<select id="beat"><option value="">any beat</option>${BEATS.map((b) => `<option>${b}</option>`).join('')}</select>
<select id="int"><option value="">any intensity</option>${INTENS.map((i) => `<option>${i}</option>`).join('')}</select>
<label class="chk"><input type="checkbox" id="nohud"> clean (no HUD) only</label>
</div>
<div class="count" id="count"></div>
<div id="grid"></div>
<script>
const DATA=${JSON.stringify(ok)};
const q=document.getElementById('q'),sc=document.getElementById('scene'),ac=document.getElementById('act'),bf=document.getElementById('beat'),intf=document.getElementById('int'),nh=document.getElementById('nohud'),grid=document.getElementById('grid'),count=document.getElementById('count');
function hay(r){return [r.subject,r.activity,r.setting_env,r.scene_type,r.mood,r.on_screen_text,r.notes,(r.tags||[]).join(' ')].join(' ').toLowerCase()}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function render(){
  const words=q.value.toLowerCase().split(/\\s+/).filter(Boolean);
  const rows=DATA.filter(r=>{
    if(sc.value&&r.scene_type!==sc.value)return false;
    if(ac.value&&r.activity!==ac.value)return false;
    if(bf.value&&!(r.beats||[]).some(b=>b.includes(bf.value)))return false;
    if(intf.value&&r.intensity!==intf.value)return false;
    if(nh.checked&&r.has_hud)return false;
    const h=hay(r);return words.every(w=>h.includes(w));
  });
  count.textContent=rows.length+' of '+DATA.length+' clips';
  grid.innerHTML=rows.map(r=>{
    const hud=r.has_hud?'<span class="hud on">HUD</span>':'<span class="hud off">clean</span>';
    return '<div class="card"><div class="f">'+esc(r.folder)+'/'+esc(r.file)+'</div>'+
      '<div class="s">'+esc(r.subject)+'</div>'+
      '<div class="meta">'+esc(r.duration_s)+'s · '+esc(r.camera)+' · '+esc(r.activity)+' · '+esc(r.intensity)+' · '+esc(r.setting_env)+hud+'</div>'+
      '<div class="tags">'+(r.beats||[]).map(b=>'<span class="beat">'+esc(b)+'</span>').join('')+'</div>'+
      (r.best_ranges&&r.best_ranges.length?'<div class="ranges">▶ '+r.best_ranges.map(esc).join(' | ')+'</div>':'')+
      '<div class="tags">'+(r.tags||[]).slice(0,8).map(t=>'<span class="tag">'+esc(t)+'</span>').join('')+'</div>'+
      '</div>';
  }).join('');
}
[q,sc,ac,bf,intf,nh].forEach(e=>e.addEventListener('input',render));render();
</script></body></html>`;

fs.writeFileSync(outPath, html);
console.log('Wrote', outPath, '(' + ok.length + ' records)');
