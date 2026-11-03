'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('atri', {
  openObserve: () => ipcRenderer.invoke('open-observe'),
  observation: (action,data) => { if(!['sources','start','stop','clear','state','zoom','audio','audio-error'].includes(action))throw new Error('invalid-action');return ipcRenderer.invoke('observe-'+action,data) },
  together: (action, data) => { if (!['init', 'save', 'hello', 'sources', 'start', 'analyse', 'pause', 'stop'].includes(action)) throw new Error('invalid-action'); return ipcRenderer.invoke('together-' + action, data) },
  init: () => ipcRenderer.invoke('init'),
  say: (text) => ipcRenderer.invoke('say', text),
  openChat: () => ipcRenderer.invoke('open-chat'),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  preview: (s) => ipcRenderer.invoke('preview', s),
  drag: (dx, dy) => ipcRenderer.send('pet-drag', { dx, dy }),
  on: (ch, fn) => { const ok = ['msg', 'history', 'conn', 'settings','observe-state','observe-report','observe-stop-audio']; if (ok.includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)) },
})
