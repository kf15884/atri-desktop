'use strict'
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, globalShortcut, safeStorage, nativeImage, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { Bridge } = require('./bridge')

app.on('web-contents-created', (_e,wc) => { wc.setWindowOpenHandler(()=>({action:'deny'}));wc.on('will-navigate',(event,url)=>{if(!url.startsWith('file:'))event.preventDefault()}) })

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

const userDir = app.getPath('userData')
const settingsFile = path.join(userDir, 'settings.json')
const historyFile = path.join(userDir, 'history.json')
const DEFAULTS = { url: 'ws://127.0.0.1:15150', tokenEnc: '', image: '', opacity: 0.9, scale: 1, clickThrough: false,
  bubbleSeconds: 12, petBounds: null, chatBounds: null, lastSeq: 0 }

let settings = { ...DEFAULTS }
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } } catch { }
const saveSettings = () => { fs.mkdirSync(userDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)) }

let history = []
try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')) } catch { }
let historyTimer
const saveHistory = () => { clearTimeout(historyTimer); historyTimer = setTimeout(() => fs.writeFileSync(historyFile, JSON.stringify(history.slice(-500))), 500) }

const getToken = () => {
  if (!settings.tokenEnc) return ''
  try { return safeStorage.decryptString(Buffer.from(settings.tokenEnc, 'base64')) } catch { return '' }
}
const setToken = (t) => { settings.tokenEnc = t ? safeStorage.encryptString(t).toString('base64') : ''; saveSettings() }

let pet, chat, setup, tray, bridge, observeWindow, observation
const send = (win, ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data) }
const broadcast = (ch, data) => { send(pet, ch, data); send(chat, ch, data) }

function addItems(items) {
  const known = new Set(history.map(i => i.id))
  let added = 0
  for (const it of items) if (!known.has(it.id)) { history.push(it); known.add(it.id); added++ }
  history.sort((a, b) => a.seq - b.seq)
  if (history.length > 500) history = history.slice(-500)
  const maxSeq = Math.max(settings.lastSeq || 0, ...items.map(i => i.seq || 0))
  if (maxSeq !== settings.lastSeq) { settings.lastSeq = maxSeq; saveSettings() }
  if (added) saveHistory()
  return added
}

function createPet() {
  const { workArea } = screen.getPrimaryDisplay()
  const b = settings.petBounds || { width: Math.round(360 * settings.scale), height: Math.round(560 * settings.scale), x: workArea.x + workArea.width - 380, y: workArea.y + workArea.height - 580 }
  pet = new BrowserWindow({ ...b, transparent: true, frame: false, resizable: true, skipTaskbar: true, alwaysOnTop: true,
    hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } })
  pet.setAlwaysOnTop(true, 'screen-saver')
  pet.setContentProtection(true) // 不出现在截图/识屏里
  pet.loadFile(path.join(__dirname, 'pet.html'))
  pet.on('moved', () => { settings.petBounds = pet.getBounds(); saveSettings() })
  pet.on('resized', () => { settings.petBounds = pet.getBounds(); saveSettings() })
  applyClickThrough()
}

function createChat() {
  if (chat && !chat.isDestroyed()) { chat.show(); chat.focus(); return }
  const b = settings.chatBounds || { width: 420, height: 620 }
  chat = new BrowserWindow({ ...b, minWidth: 320, minHeight: 360, title: 'Atri', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } })
  chat.setContentProtection(true)
  chat.loadFile(path.join(__dirname, 'chat.html'))
  const keep = () => { settings.chatBounds = chat.getBounds(); saveSettings() }
  chat.on('moved', keep); chat.on('resized', keep)
}

function createObserve() {
  if(observeWindow && !observeWindow.isDestroyed()){ observeWindow.show();observeWindow.focus();return }
  observeWindow = new BrowserWindow({width:1080,height:850,minWidth:380,minHeight:640,title:'Atri · 本地观察',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,sandbox:true}})
  observeWindow.setContentProtection(true)
  observeWindow.loadFile(path.join(__dirname,'observe.html'))
  observeWindow.on('closed',()=>{observation?.stop();observeWindow=null})
}
function createSetup() {
  if (setup && !setup.isDestroyed()) { setup.focus(); return }
  setup = new BrowserWindow({ width: 460, height: 520, title: 'Atri 设置', autoHideMenuBar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } })
  setup.loadFile(path.join(__dirname, 'setup.html'))
}

function applyClickThrough() {
  if (!pet) return
  pet.setIgnoreMouseEvents(!!settings.clickThrough, { forward: true })
  send(pet, 'settings', publicSettings())
  if (tray) tray.setContextMenu(trayMenu())
}

const publicSettings = () => ({ url: settings.url, hasToken: !!settings.tokenEnc, image: settings.image, opacity: settings.opacity,
  scale: settings.scale, clickThrough: settings.clickThrough, bubbleSeconds: settings.bubbleSeconds })

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开对话框 (Ctrl+Alt+A)', click: createChat },
    { label: pet && pet.isVisible() ? '隐藏立绘' : '显示立绘', click: () => { pet.isVisible() ? pet.hide() : pet.showInactive(); tray.setContextMenu(trayMenu()) } },
    { label: '点击穿透', type: 'checkbox', checked: !!settings.clickThrough, click: (m) => { settings.clickThrough = m.checked; saveSettings(); applyClickThrough() } },
    { type: 'separator' },
    { label: '本地观察 / 一起看番…', click: createObserve },
    { label: '停止观察并清缓存 (Ctrl+Alt+O)', click: () => observation?.stop() },
    { label: '设置…', click: createSetup },
    { label: '重新连接', click: () => bridge.restart() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit() } },
  ])
}

function startBridge() {
  bridge = new Bridge(() => ({ url: settings.url, token: getToken(), since: settings.lastSeq || 0 }))
  bridge.on('state', (s) => { if(!s.online)observation?.connectionLost();broadcast('conn', s); if (tray) tray.setToolTip('Atri · ' + s.label) })
  bridge.on('history', (items) => { addItems(items); broadcast('history', history) })
  bridge.on('msg', (item) => { if (addItems([item])) broadcast('msg', item) })
  bridge.start()
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Atri')
  tray.on('click', createChat)
  createPet()
  tray.setContextMenu(trayMenu())
  globalShortcut.register('Control+Alt+A', () => { chat && !chat.isDestroyed() && chat.isFocused() ? chat.hide() : createChat() })
  observation = require('./observe-main').install({ipcMain,getWindow:()=>observeWindow&&!observeWindow.isDestroyed()?observeWindow:null,bridge:()=>bridge})
  globalShortcut.register('Control+Alt+O', () => observation?.stop())
  startBridge()
  if (!settings.tokenEnc || !settings.image) createSetup()
})
app.on('window-all-closed', (e) => { if (!app.isQuitting) e.preventDefault() })
app.on('will-quit', () => { globalShortcut.unregisterAll(); observation?.stop();if (bridge) bridge.stop() })

ipcMain.handle('init', () => ({ settings: publicSettings(), history, conn: bridge ? bridge.state : { label: '未连接' } }))
ipcMain.handle('say', async (_e, text) => bridge.say(String(text || '')))
ipcMain.handle('open-chat', () => createChat())
ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(setup || pet, { filters: [{ name: '图片', extensions: ['png', 'webp', 'gif', 'jpg', 'jpeg'] }], properties: ['openFile'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('save-settings', (_e, s) => {
  if (typeof s.url === 'string' && /^wss?:\/\//.test(s.url)) settings.url = s.url.trim()
  if (typeof s.token === 'string' && s.token) setToken(s.token.trim())
  if (typeof s.image === 'string') settings.image = s.image
  if (Number.isFinite(s.opacity)) settings.opacity = Math.min(1, Math.max(0.1, s.opacity))
  if (Number.isFinite(s.scale)) settings.scale = Math.min(3, Math.max(0.3, s.scale))
  if (Number.isFinite(s.bubbleSeconds)) settings.bubbleSeconds = Math.min(120, Math.max(3, s.bubbleSeconds))
  saveSettings(); broadcast('settings', publicSettings())
  if (s.token || s.url) bridge.restart()
  return publicSettings()
})
ipcMain.handle('preview', (_e, s) => { send(pet, 'settings', { ...publicSettings(), ...s }) })
ipcMain.on('pet-drag', (_e, { dx, dy }) => { if (!pet) return; const [x, y] = pet.getPosition(); pet.setPosition(x + dx, y + dy) })

ipcMain.handle('open-observe',()=>createObserve())
