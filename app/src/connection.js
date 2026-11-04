'use strict'
/**
 * 连接（0.5，P11-01）：服务器地址、专用账号、连接钥匙、桌面口令都在这里；
 * 一打开就自动建隧道，聊天和一起看番共用这一条。设置存在 connect.json（口令系统加密），钥匙在应用目录里。
 */
const { safeStorage } = require('electron')
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { Tunnel, setupCommand } = require('./tunnel')
const { DeskClient } = require('./together-net')

const DEFAULTS = { host: '', port: 22, user: 'atri-desk', localPort: 15160, remotePort: 5160, tokenEnc: '' }

function findSsh() {
  const win = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH')
  for (const dir of [win, '/usr/bin', '/usr/local/bin']) {
    const p = path.join(dir, process.platform === 'win32' ? 'ssh.exe' : 'ssh')
    if (fs.existsSync(p)) return { ssh: p, keygen: path.join(dir, process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen') }
  }
  return { ssh: 'ssh', keygen: 'ssh-keygen' }
}

function install({ ipcMain, userDir, getWindow, onState, migrateToken }) {
  const file = path.join(userDir, 'connect.json')
  const keyPath = path.join(userDir, 'desk_ed25519')
  const knownHosts = path.join(userDir, 'known_hosts')
  let s = { ...DEFAULTS }
  try { s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch {}
  const save = () => { fs.mkdirSync(userDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 }) }
  const enc = (t) => (t ? safeStorage.encryptString(t).toString('base64') : '')
  const dec = (b) => { if (!b) return ''; try { return safeStorage.decryptString(Buffer.from(b, 'base64')) } catch { return '' } }
  // 0.4 的口令存在一起看番的设置里：搬过来
  if (!s.tokenEnc && migrateToken) { const t = migrateToken(); if (t) { s.tokenEnc = t; save() } }
  const tools = findSsh()
  const base = () => `http://127.0.0.1:${s.localPort}`
  const desk = () => new DeskClient({ base: base(), token: dec(s.tokenEnc) })
  const hasKey = () => fs.existsSync(keyPath) && fs.existsSync(keyPath + '.pub')
  const pub = () => ({ host: s.host, port: s.port, user: s.user, localPort: s.localPort, remotePort: s.remotePort, hasToken: !!s.tokenEnc, hasKey: hasKey(), publicKey: hasKey() ? fs.readFileSync(keyPath + '.pub', 'utf8').trim() : '', setupCommand: hasKey() ? setupCommand(fs.readFileSync(keyPath + '.pub', 'utf8')) : '' })

  /** 本机端口上有没有 Atri（任何 HTTP 回答都算通；口令对不对另外看） */
  const probe = async (port) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/desk/hello`, { headers: { authorization: 'Bearer ' + dec(s.tokenEnc) }, signal: AbortSignal.timeout(4000), redirect: 'error' })
      await r.body?.cancel().catch(() => {})
      return r.status === 200 || r.status === 401 || r.status === 429
    } catch { return false }
  }
  const tunnel = new Tunnel({
    sshPath: tools.ssh,
    spawn: (cmd, args) => spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }),
    probe,
    config: () => (s.host && hasKey() ? { host: s.host, port: s.port, user: s.user, localPort: s.localPort, remotePort: s.remotePort, keyPath, knownHosts } : null),
  })
  let authOk = null
  tunnel.on('state', async (st) => {
    if (st.phase === 'connected') {
      const h = await desk().hello().catch((e) => ({ ok: false, error: e.message }))
      authOk = h.ok === true
      if (!authOk) tunnel.state = { ...st, label: '连上了，但' + (/口令/.test(h.error || '') ? '口令不对' : '打招呼没成功：' + (h.error || '')), error: h.error || null }
    }
    onState?.(view())
    getWindow()?.webContents.send('conn-state', view())
  })
  const view = () => ({ ...tunnel.state, ok: tunnel.state.phase === 'connected' && authOk === true })

  function trusted(e) { const w = getWindow(); if (!w || e.sender !== w.webContents) throw new Error('untrusted-window') }

  ipcMain.handle('conn-init', (e) => { trusted(e); return { settings: pub(), state: view() } })
  ipcMain.handle('conn-save', async (e, x) => {
    trusted(e)
    if (!x || typeof x !== 'object') throw new Error('invalid')
    if (typeof x.host === 'string') {
      const h = x.host.trim()
      if (h && !/^[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:]+\]$/.test(h)) throw new Error('服务器地址只能是域名或 IP')
      s.host = h
    }
    if (x.port !== undefined) { const p = Number(x.port); if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('ssh 端口不对'); s.port = p }
    if (typeof x.user === 'string') { const u = x.user.trim(); if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(u)) throw new Error('账号名不对'); if (u === 'root') throw new Error('不用 root：用服务器脚本建的专用账号 atri-desk'); s.user = u }
    if (x.localPort !== undefined) { const p = Number(x.localPort); if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('本机端口要在 1024–65535'); s.localPort = p }
    if (typeof x.token === 'string' && x.token.trim()) { if (x.token.trim().length < 24) throw new Error('口令至少 24 位'); s.tokenEnc = enc(x.token.trim()) }
    save()
    void tunnel.restart()
    return pub()
  })
  /** 生成连接钥匙（ed25519，不设口令，只放在应用目录、只有你能读） */
  ipcMain.handle('conn-keygen', async (e) => {
    trusted(e)
    for (const f of [keyPath, keyPath + '.pub']) { try { fs.unlinkSync(f) } catch {} }
    await new Promise((res, rej) => execFile(tools.keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'atri-desk@' + (os.hostname().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 30) || 'pc'), '-f', keyPath], { windowsHide: true }, (err, _o, se) => (err ? rej(new Error('生成钥匙失败：' + (se || err.message))) : res())))
    if (process.platform === 'win32') {
      // Windows 的 ssh 要求私钥只有自己能读
      await new Promise((res) => execFile('icacls', [keyPath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { windowsHide: true }, () => res()))
    } else fs.chmodSync(keyPath, 0o600)
    void tunnel.restart()
    return pub()
  })
  ipcMain.handle('conn-forget-host', (e) => { trusted(e); try { fs.unlinkSync(knownHosts) } catch {} ; void tunnel.restart(); return true })
  ipcMain.handle('conn-retry', (e) => { trusted(e); void tunnel.restart(); return view() })

  return { tunnel, desk, base, start: () => tunnel.start(), stop: () => tunnel.stop(), state: view, configured: () => !!(s.host && hasKey() && s.tokenEnc) }
}

module.exports = { install }
