// Safe bridge: exposes a small, explicit API to the renderer. No Node in the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cap', {
  init: () => ipcRenderer.invoke('app:init'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  uploadFont: async (file, family) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    return ipcRenderer.invoke('fonts:upload', { buf, name: file.name || 'font.ttf', family });
  },
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  openVideo: () => ipcRenderer.invoke('dialog:openVideo'),
  transcribe: (video, style, language, script) => ipcRenderer.invoke('project:transcribe', { video, style, language, script }),
  polish: (words, language, script) => ipcRenderer.invoke('ai:polish', { words, language, script }),
  preview: (project, ss, dur) => ipcRenderer.invoke('project:preview', { project, ss, dur }),
  render: (project) => ipcRenderer.invoke('project:render', { project }),
  exportAlpha: (project) => ipcRenderer.invoke('project:exportAlpha', { project }),
  exportSrt: (srt, name) => ipcRenderer.invoke('project:exportSrt', { srt, name }),
  aiHighlight: (words) => ipcRenderer.invoke('ai:highlight', { words }),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  onTranscribeProgress: (cb) => ipcRenderer.on('transcribe:progress', (_e, d) => cb(d)),
  onRenderProgress: (cb) => ipcRenderer.on('render:progress', (_e, d) => cb(d)),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, d) => cb(d)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
});
