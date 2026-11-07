'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const EVENTS = ['settings', 'conn-state', 'chat-items', 'chat-thinking', 'pet-say', 'notify-show']
contextBridge.exposeInMainWorld('atri', {
  init: () => ipcRenderer.invoke('init'),
  chat: (action, data) => { if (!['init', 'say', 'resend', 'sticker'].includes(action)) throw new Error('invalid-action'); return ipcRenderer.invoke('chat-' + action, data) },
  conn: (action, data) => { if (!['init', 'save', 'keygen', 'forget-host', 'retry'].includes(action)) throw new Error('invalid-action'); return ipcRenderer.invoke('conn-' + action, data) },
  together: (action, data) => { if (!['init', 'save', 'hello', 'heartest', 'sources', 'start', 'analyse', 'pause', 'stop'].includes(action)) throw new Error('invalid-action'); return ipcRenderer.invoke('together-' + action, data) },
  open: (what) => { if (!['chat', 'connect', 'together'].includes(what)) throw new Error('invalid'); return ipcRenderer.invoke('open-' + what) },
  pickImage: () => ipcRenderer.invoke('pick-image'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  drag: (dx, dy) => ipcRenderer.send('pet-drag', { dx, dy }),
  hideNotify: () => ipcRenderer.send('notify-hide'),
  on: (ch, fn) => { if (EVENTS.includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)) },
})
