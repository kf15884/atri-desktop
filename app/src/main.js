'use strict'
/**
 * Atri Desktop 0.5：连新的 Atri（atri-self）。
 * - 自动连接（connection.js / tunnel.js）：一打开就用专用账号和连接钥匙建隧道，断了重连
 * - 聊天（chat-service.js）：对话框、立绘气泡、消息卡片；本地加密存 500 条
 * - 一起看番（together-main.js）
 * 旧的 HDS 对话框、镜像、0.3 本地观察都去掉了（Q94）。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, safeStorage, nativeImage, screen, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { ChatService } = require('./chat-service')

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    // 聊天里的链接用系统浏览器打开（只认 http/https）
    if (/^https?:\/\//.test(url)) void require('electron').shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => { if (!url.startsWith('file:')) event.preventDefault() })
})

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

const userDir = app.getPath('userData')
const settingsFile = path.join(userDir, 'settings.json')
const chatFile = path.join(userDir, 'chat.enc')
const DEFAULTS = { image: '', opacity: 0.95, scale: 1, clickThrough: false, bubbleSeconds: 12, petBounds: null, chatBounds: null, showPet: true, notify: true, autostart: false }

let settings = { ...DEFAULTS }
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } } catch {}
const saveSettings = () => { fs.mkdirSync(userDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)) }
// 0.4 以前的东西：旧 HDS 的口令和明文聊天记录不再用，删掉
for (const k of ['url', 'tokenEnc', 'lastSeq']) delete settings[k]
try { fs.rmSync(path.join(userDir, 'history.json'), { force: true }) } catch {}

let pet, chat, tray, togetherWindow, together, connWindow, connection, notifyWin, service
const live = (w) => (w && !w.isDestroyed() ? w : null)
const send = (w, ch, data) => { if (live(w)) w.webContents.send(ch, data) }
const sendAll = (ch, data) => { for (const w of [pet, chat, notifyWin]) send(w, ch, data) }

// ---------- 本地聊天记录：系统加密 ----------
function loadChat() {
  try {
    const buf = fs.readFileSync(chatFile)
    return JSON.parse(safeStorage.decryptString(buf))
  } catch { return [] }
}
function saveChat(items) {
  if (!safeStorage.isEncryptionAvailable()) return
  fs.mkdirSync(userDir, { recursive: true })
  fs.writeFileSync(chatFile, safeStorage.encryptString(JSON.stringify(items)), { mode: 0o600 })
}

// ---------- 窗口 ----------
const winPrefs = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }

function createPet() {
  if (live(pet) || !settings.showPet) return
  const { workArea } = screen.getPrimaryDisplay()
  const b = settings.petBounds || { width: Math.round(320 * settings.scale), height: Math.round(500 * settings.scale), x: workArea.x + workArea.width - 340, y: workArea.y + workArea.height - 520 }
  pet = new BrowserWindow({ ...b, transparent: true, frame: false, resizable: true, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', webPreferences: winPrefs })
  pet.setAlwaysOnTop(true, 'screen-saver')
  pet.setContentProtection(true)
  pet.loadFile(path.join(__dirname, 'pet.html'))
  const keep = () => { settings.petBounds = pet.getBounds(); saveSettings() }
  pet.on('moved', keep)
  pet.on('resized', keep)
  pet.on('closed', () => { pet = null })
  pet.setIgnoreMouseEvents(!!settings.clickThrough, { forward: true })
}

function createChat() {
  if (live(chat)) { chat.show(); chat.focus(); return }
  const b = settings.chatBounds || { width: 440, height: 680 }
  chat = new BrowserWindow({ ...b, minWidth: 340, minHeight: 420, title: 'Atri', autoHideMenuBar: true, webPreferences: winPrefs })
  chat.setContentProtection(true)
  chat.loadFile(path.join(__dirname, 'chat.html'))
  const keep = () => { settings.chatBounds = chat.getBounds(); saveSettings() }
  chat.on('moved', keep)
  chat.on('resized', keep)
  chat.on('focus', () => hideNotify())
  chat.on('closed', () => { chat = null })
}

function createTogether() {
  if (live(togetherWindow)) { togetherWindow.show(); togetherWindow.focus(); return }
  togetherWindow = new BrowserWindow({ width: 1120, height: 880, minWidth: 380, minHeight: 640, title: 'Atri · 一起看番', autoHideMenuBar: true, webPreferences: { ...winPrefs, backgroundThrottling: false } })
  togetherWindow.setContentProtection(true)
  togetherWindow.loadFile(path.join(__dirname, 'together.html'))
  togetherWindow.on('closed', () => { void together?.stop(); togetherWindow = null })
}

function createConnect() {
  if (live(connWindow)) { connWindow.show(); connWindow.focus(); return }
  connWindow = new BrowserWindow({ width: 820, height: 860, minWidth: 380, title: 'Atri · 连接设置', autoHideMenuBar: true, webPreferences: winPrefs })
  connWindow.loadFile(path.join(__dirname, 'connect.html'))
  connWindow.on('closed', () => { connWindow = null })
}

// ---------- 消息卡片（像 Telegram 那样，屏幕右下角，不用 Windows 通知） ----------
let notifyTimer = null
function showNotify(item) {
  if (!settings.notify) return
  if (live(chat) && chat.isVisible() && chat.isFocused()) return
  const { workArea } = screen.getPrimaryDisplay()
  const w = 360
  const h = 96
  if (!live(notifyWin)) {
    notifyWin = new BrowserWindow({ width: w, height: h, x: workArea.x + workArea.width - w - 16, y: workArea.y + workArea.height - h - 16, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, hasShadow: false, backgroundColor: '#00000000', webPreferences: winPrefs })
    notifyWin.setAlwaysOnTop(true, 'screen-saver')
    notifyWin.setContentProtection(true)
    notifyWin.loadFile(path.join(__dirname, 'notify.html'))
    notifyWin.on('closed', () => { notifyWin = null })
    notifyWin.webContents.once('did-finish-load', () => { send(notifyWin, 'notify-show', { item, image: settings.image }); notifyWin.showInactive() })
  } else {
    send(notifyWin, 'notify-show', { item, image: settings.image })
    notifyWin.showInactive()
  }
  clearTimeout(notifyTimer)
  notifyTimer = setTimeout(hideNotify, 6000)
}
function hideNotify() {
  clearTimeout(notifyTimer)
  if (live(notifyWin)) notifyWin.hide()
}

// ---------- 托盘 ----------
function trayMenu() {
  const st = connection ? connection.state() : null
  return Menu.buildFromTemplate([
    { label: '连接：' + (st ? st.label : '…'), enabled: false },
    { label: '打开对话框', click: createChat },
    { label: '和 Atri 一起看番…', click: createTogether },
    { type: 'separator' },
    { label: '显示立绘', type: 'checkbox', checked: !!settings.showPet, click: (m) => { settings.showPet = m.checked; saveSettings(); m.checked ? createPet() : live(pet)?.close() } },
    { label: '立绘点击穿透', type: 'checkbox', checked: !!settings.clickThrough, click: (m) => { settings.clickThrough = m.checked; saveSettings(); live(pet)?.setIgnoreMouseEvents(m.checked, { forward: true }) } },
    { label: '新消息卡片提示', type: 'checkbox', checked: !!settings.notify, click: (m) => { settings.notify = m.checked; saveSettings() } },
    { label: '开机自动启动', type: 'checkbox', checked: !!settings.autostart, click: (m) => setAutostart(m.checked) },
    { label: '连接设置…', click: createConnect },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit() } },
  ])
}
function refreshTray() {
  if (!tray) return
  tray.setContextMenu(trayMenu())
  const st = connection?.state()
  tray.setToolTip('Atri · ' + (st ? st.label : ''))
}
function setAutostart(on) {
  settings.autostart = !!on
  saveSettings()
  try { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }) } catch {}
  refreshTray()
}

// ---------- 启动 ----------
app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Atri')
  tray.on('click', createChat)
  // 一起看番的窗口要屏幕画面时：给它选定的那个来源（别的窗口都不给）
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try { callback((await together?.displaySource(request)) || {}) } catch { callback({}) }
  })

  connection = require('./connection').install({
    ipcMain,
    userDir,
    getWindow: () => live(connWindow),
    onState: (st) => {
      refreshTray()
      for (const w of [chat, pet]) send(w, 'conn-state', st)
      if (st.ok) void service.start()
      else service.stop()
    },
    migrateToken: () => { try { return JSON.parse(fs.readFileSync(path.join(userDir, 'together.json'), 'utf8')).tokenEnc || '' } catch { return '' } },
  })
  service = new ChatService({ desk: () => connection.desk(), ready: () => connection.state().ok, load: loadChat, save: saveChat, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
  service.on('items', (items) => send(chat, 'chat-items', items))
  service.on('thinking', (t) => { send(chat, 'chat-thinking', t); send(pet, 'chat-thinking', t) })
  service.on('atri', (item) => { send(pet, 'pet-say', item); showNotify(item) })
  together = require('./together-main').install({ ipcMain, userDir, connection, getWindow: () => live(togetherWindow) })

  createPet()
  refreshTray()
  void connection.start()
  if (!connection.configured()) createConnect()
  else if (!process.argv.includes('--hidden')) createChat()
})
app.on('window-all-closed', (e) => { if (!app.isQuitting) e.preventDefault() })
app.on('before-quit', () => { app.isQuitting = true })
app.on('will-quit', () => { void together?.stop(); service?.stop(); connection?.stop() })

// ---------- 和窗口说话 ----------
const fromOurs = (e) => [pet, chat, notifyWin].some((w) => live(w) && e.sender === w.webContents)
const publicSettings = () => ({ image: settings.image, opacity: settings.opacity, scale: settings.scale, clickThrough: settings.clickThrough, bubbleSeconds: settings.bubbleSeconds, showPet: settings.showPet, notify: settings.notify, autostart: settings.autostart })
const pendingImages = new Map()

ipcMain.handle('init', (e) => { if (!fromOurs(e)) throw new Error('untrusted'); return { settings: publicSettings(), conn: connection ? connection.state() : null } })
ipcMain.handle('chat-init', (e) => { if (!fromOurs(e)) throw new Error('untrusted'); return { items: service.items, thinking: service.thinking, conn: connection.state() } })
ipcMain.handle('chat-say', async (e, x) => {
  if (!live(chat) || e.sender !== chat.webContents) throw new Error('untrusted')
  const text = String((x && x.text) || '').slice(0, 2000)
  const images = (Array.isArray(x && x.images) ? x.images : []).slice(0, 4).filter((im) => /^image\/(jpeg|png|gif|webp)$/.test(String(im.mime)) && /^[A-Za-z0-9+/=]+$/.test(String(im.data)) && String(im.data).length < 7_000_000)
  if (!text.trim() && images.length === 0) return null
  const item = await service.say(text, images.map((im) => ({ mime: im.mime, data: im.data, sticker: !!im.sticker, thumb: /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(im.thumb)) && String(im.thumb).length < 200_000 ? im.thumb : null })))
  if (item.state === 'failed' && images.length) pendingImages.set(item.clientId, images)
  return item
})
ipcMain.handle('chat-resend', async (e, clientId) => {
  if (!live(chat) || e.sender !== chat.webContents) throw new Error('untrusted')
  const it = service.items.find((x) => x.clientId === clientId && x.state === 'failed')
  if (!it) return null
  const images = pendingImages.get(clientId) || []
  const r = await service.say(it.text, images, clientId)
  if (r.state !== 'failed') pendingImages.delete(clientId)
  return r
})
const stickerCache = new Map()
ipcMain.handle('chat-sticker', async (e, id) => {
  if (!fromOurs(e)) throw new Error('untrusted')
  const key = String(id).slice(0, 80)
  if (stickerCache.has(key)) return stickerCache.get(key)
  const url = await connection.desk().sticker(key).catch(() => null)
  if (url && stickerCache.size < 200) stickerCache.set(key, url)
  return url
})
ipcMain.handle('open-chat', (e) => { if (fromOurs(e)) { hideNotify(); createChat() } })
ipcMain.handle('open-connect', (e) => { if (fromOurs(e)) createConnect() })
ipcMain.handle('open-together', (e) => { if (fromOurs(e)) createTogether() })
ipcMain.handle('pick-image', async (e) => {
  if (!fromOurs(e)) throw new Error('untrusted')
  const r = await dialog.showOpenDialog(live(chat) || undefined, { filters: [{ name: '图片', extensions: ['png', 'webp', 'gif', 'jpg', 'jpeg'] }], properties: ['openFile'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('save-settings', (e, s) => {
  if (!fromOurs(e) || !s || typeof s !== 'object') throw new Error('untrusted')
  if (typeof s.image === 'string' && (s.image === '' || fs.existsSync(s.image))) settings.image = s.image
  if (Number.isFinite(s.opacity)) settings.opacity = Math.min(1, Math.max(0.2, s.opacity))
  if (Number.isFinite(s.scale)) settings.scale = Math.min(3, Math.max(0.3, s.scale))
  if (Number.isFinite(s.bubbleSeconds)) settings.bubbleSeconds = Math.min(120, Math.max(3, s.bubbleSeconds))
  for (const k of ['notify', 'showPet', 'clickThrough']) if (typeof s[k] === 'boolean') settings[k] = s[k]
  saveSettings()
  if (typeof s.autostart === 'boolean') setAutostart(s.autostart)
  if (settings.showPet) createPet()
  else live(pet)?.close()
  live(pet)?.setIgnoreMouseEvents(!!settings.clickThrough, { forward: true })
  sendAll('settings', publicSettings())
  refreshTray()
  return publicSettings()
})
ipcMain.on('pet-drag', (e, d) => { if (!live(pet) || e.sender !== pet.webContents) return; const [x, y] = pet.getPosition(); pet.setPosition(x + Math.round(Number(d.dx) || 0), y + Math.round(Number(d.dy) || 0)) })
ipcMain.on('notify-hide', (e) => { if (live(notifyWin) && e.sender === notifyWin.webContents) hideNotify() })
