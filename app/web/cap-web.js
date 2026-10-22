// Web build of the Electron `window.cap` bridge. Same API app.mjs calls, but backed by
// HTTP endpoints + a real file upload + an SSE progress stream instead of IPC.
(function () {
  const J = (url, opts) => fetch(url, opts).then((r) => r.json());
  const POST = (url, body) => J(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let txCb = null, rndCb = null;
  // per-client id so the server sends OUR progress + queue position only to us (not every open tab)
  const CID = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // one shared progress stream; route render/encode to the render callback, rest to transcribe
  try {
    const es = new EventSource('/api/progress?cid=' + CID);
    es.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch { return; } if (d.stage === 'render' || d.stage === 'encode') rndCb && rndCb(d); else txCb && txCb(d); };
  } catch {}

  // Upload a File to the server, resolving to { path, fileUrl }. Shared by the picker and drag-drop.
  // Uses XHR (not fetch) so we can report real upload % — a big video takes a while and the user
  // needs to see it's working. Progress is pushed through the transcribe-progress channel as
  // { stage:'upload', pct } so the existing progress box shows "uploading… N%".
  function uploadFile(f) {
    if (!f) return Promise.resolve(null);
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('x-filename', f.name || 'video.mp4');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const pct = Math.round((e.loaded / e.total) * 100); txCb && txCb({ stage: 'upload', pct }); } };
      xhr.onload = () => { try { const j = JSON.parse(xhr.responseText); resolve(j && j.ok ? { path: j.id, fileUrl: j.fileUrl } : null); } catch { resolve(null); } };
      xhr.onerror = () => resolve(null);
      xhr.ontimeout = () => resolve(null);
      xhr.send(f);
    });
  }

  // The picker just returns the chosen File — the caller (app.mjs) runs it through the same
  // ingest path as drag-drop, which shows "Uploading…" BEFORE the upload starts (the old version
  // uploaded silently inside here, so the button looked dead until transcription began).
  function openVideo() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'video/*';
      inp.onchange = () => resolve((inp.files && inp.files[0]) || null);
      inp.click();
    });
  }

  // Upload a font FILE (.ttf/.otf/.woff/.woff2). Resolves to { ok, font:{family,file,format,url} }.
  function uploadFont(file, family) {
    if (!file) return Promise.resolve({ ok: false, error: 'no file' });
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload-font');
      xhr.setRequestHeader('x-filename', file.name || 'font.ttf');
      if (family) xhr.setRequestHeader('x-family', encodeURIComponent(family));
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ ok: false, error: 'bad response' }); } };
      xhr.onerror = () => resolve({ ok: false, error: 'upload failed' });
      xhr.send(file);
    });
  }

  window.cap = {
    init: () => J('/api/init'),
    getSettings: () => J('/api/settings'),
    uploadFont,
    listFonts: () => J('/api/fonts'),
    setSettings: (s) => POST('/api/settings', s),
    openVideo,
    uploadFile,
    transcribe: (video, style, language, script) => POST('/api/transcribe', { id: String(video).split('/').pop(), style, language, script, cid: CID }),
    preview: (project, ss, dur) => POST('/api/preview', { project, ss, dur, cid: CID }),
    render: (project) => POST('/api/render', { project, cid: CID }),
    exportAlpha: (project) => POST('/api/exportAlpha', { project, cid: CID }),
    exportSrt: async (srt, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([srt], { type: 'text/plain' })); a.download = (name || 'captions') + '.srt'; a.click(); return { ok: true }; },
    aiHighlight: (words) => POST('/api/ai-highlight', { words }),
    polish: (words, language, script) => POST('/api/polish', { words, language, script }),
    showItem: (p) => { try { window.open(p, '_blank'); } catch {} },
    onTranscribeProgress: (cb) => { txCb = cb; },
    onRenderProgress: (cb) => { rndCb = cb; },
  };
})();
