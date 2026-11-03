'use strict'
/**
 * 一起看番（0.4）主进程这边：设置（口令、看图密钥用系统加密存在这台电脑上）、选来源、
 * 帮观看窗口问看图模型、把文字交给 Atri、取角色头像。画面在观看窗口里截、挑、拼，不在这里留。
 */
const { desktopCapturer, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { DeskClient, askVision, fetchPortrait, atriBase, visionBase } = require('./together-net')

const DEFAULTS = { atriUrl: 'http://127.0.0.1:15160', tokenEnc: '', visionBase: 'https://api.deepseek.com', visionModel: '', keyEnc: '', extraBody: '', priceIn: 0, priceOut: 0, mode: 'interval', fps: 4, castRef: true, strip: true }

function install({ ipcMain, userDir, getWindow }) {
  const file = path.join(userDir, 'together.json')
  let s = { ...DEFAULTS }
  try { s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch {}
  const save = () => { fs.mkdirSync(userDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 }) }
  const enc = (t) => (t ? safeStorage.encryptString(t).toString('base64') : '')
  const dec = (b) => { if (!b) return ''; try { return safeStorage.decryptString(Buffer.from(b, 'base64')) } catch { return '' } }
  const pub = () => ({ atriUrl: s.atriUrl, hasToken: !!s.tokenEnc, visionBase: s.visionBase, visionModel: s.visionModel, hasKey: !!s.keyEnc, extraBody: s.extraBody, priceIn: s.priceIn, priceOut: s.priceOut, mode: s.mode, fps: s.fps, castRef: s.castRef, strip: s.strip })
  const desk = () => new DeskClient({ base: s.atriUrl, token: dec(s.tokenEnc) })
  let session = null // { id, prompt, sourceId, sourceName }
  let selected = null

  function trusted(e) { const w = getWindow(); if (!w || e.sender !== w.webContents) throw new Error('untrusted-window') }

  ipcMain.handle('together-init', (e) => { trusted(e); return { settings: pub(), session: session ? { id: session.id } : null } })
  ipcMain.handle('together-save', (e, x) => {
    trusted(e)
    if (!x || typeof x !== 'object') throw new Error('invalid')
    if (typeof x.atriUrl === 'string') s.atriUrl = atriBase(x.atriUrl)
    if (typeof x.token === 'string' && x.token.trim()) { if (x.token.trim().length < 24) throw new Error('口令至少 24 位'); s.tokenEnc = enc(x.token.trim()) }
    if (typeof x.visionBase === 'string') s.visionBase = visionBase(x.visionBase)
    if (typeof x.visionModel === 'string') s.visionModel = x.visionModel.trim().slice(0, 120)
    if (typeof x.key === 'string' && x.key.trim()) s.keyEnc = enc(x.key.trim())
    if (typeof x.extraBody === 'string') { const t = x.extraBody.trim(); if (t) { const v = JSON.parse(t); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('额外参数要是 JSON 对象') } s.extraBody = t }
    for (const k of ['priceIn', 'priceOut']) if (Number.isFinite(Number(x[k]))) s[k] = Math.max(0, Number(x[k]))
    if (x.mode === 'interval' || x.mode === 'realtime') s.mode = x.mode
    if (Number.isFinite(Number(x.fps))) s.fps = Math.min(6, Math.max(2, Math.round(Number(x.fps))))
    if (typeof x.castRef === 'boolean') s.castRef = x.castRef
    if (typeof x.strip === 'boolean') s.strip = x.strip
    save()
    return pub()
  })
  ipcMain.handle('together-hello', async (e) => { trusted(e); return desk().hello() })
  ipcMain.handle('together-sources', async (e) => {
    trusted(e)
    const list = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } })
    return list.filter((x) => !x.name.startsWith('Atri')).map((x) => ({ id: x.id, name: x.name, kind: x.id.startsWith('screen:') ? 'screen' : 'window', preview: x.thumbnail.toDataURL() }))
  })
  ipcMain.handle('together-start', async (e, x) => {
    trusted(e)
    if (!x || typeof x !== 'object' || typeof x.sourceId !== 'string') throw new Error('先选一个窗口')
    if (!s.visionModel || !s.keyEnc) throw new Error('先在设置里填好看图模型和密钥')
    const sources = await desktopCapturer.getSources({ types: [x.sourceId.startsWith('screen:') ? 'screen' : 'window'], thumbnailSize: { width: 0, height: 0 } })
    const src = sources.find((y) => y.id === x.sourceId)
    if (!src) throw new Error('这个窗口现在截不到了，刷新一下')
    const d = desk()
    const hello = await d.hello()
    if (!hello.ok) throw new Error('连不上 Atri：' + (hello.error || ''))
    const r = await d.start({ title: String(x.title || '').slice(0, 60), episode: String(x.episode || '').slice(0, 20), startSec: Math.max(0, Number(x.startSec) || 0) })
    if (!r.ok) throw new Error('Atri 没开成：' + (r.error || ''))
    selected = src
    session = { id: r.sessionId, prompt: hello.prompt }
    // 角色头像：取到的给观看窗口拼参考图（data URL，只在内存里）
    const cast = []
    if (s.castRef && r.cast && Array.isArray(r.cast.members)) {
      for (const m of r.cast.members.slice(0, 8)) {
        let img = null
        if (m.img) try { const p = await fetchPortrait(m.img); img = 'data:' + p.type + ';base64,' + p.data.toString('base64') } catch {}
        cast.push({ n: m.n, name: m.name, looks: m.looks || '', img })
      }
    }
    return { sessionId: r.sessionId, prompt: hello.prompt, cast, settings: pub() }
  })
  ipcMain.handle('together-analyse', async (e, x) => {
    trusted(e)
    if (!session || x.sessionId !== session.id) return { ok: false, error: '这一场已经停了' }
    const id = session.id
    const images = (Array.isArray(x.images) ? x.images : []).slice(0, 3).map((b) => Buffer.from(b))
    if (images.length === 0 || images.some((b) => b.length > 2 * 1024 * 1024)) return { ok: false, error: '图不对' }
    let extraBody = {}
    try { extraBody = s.extraBody ? JSON.parse(s.extraBody) : {} } catch {}
    let res
    try {
      res = await askVision({ base: s.visionBase, model: s.visionModel, key: dec(s.keyEnc), extraBody, system: session.prompt.system, prompt: String(x.prompt || '').slice(0, 6000), images })
    } catch (err) {
      return { ok: false, error: err.message, usage: err.usage || null }
    }
    // 停了以后回来的结果不交
    if (!session || session.id !== id) return { ok: false, error: '这一场已经停了', usage: res.usage }
    const out = { ok: true, text: res.text, usage: res.usage }
    let data = null
    try { const a = res.text.indexOf('{'), b = res.text.lastIndexOf('}'); data = JSON.parse(res.text.slice(a, b + 1)) } catch {}
    if (!data) return { ...out, ok: false, error: '看图模型没按格式写，这一段没交给 Atri' }
    const post = await desk().segment({ sessionId: id, seq: x.seq, from: x.from, to: x.to, data, usage: [res.usage] }).catch((err) => ({ ok: false, error: err.message }))
    return { ...out, data, delivered: post.ok === true, deliveryError: post.ok ? null : post.error || null, speak: post.speak === true }
  })
  ipcMain.handle('together-pause', async (e, paused) => { trusted(e); if (!session) return false; const r = await desk().pause(session.id, paused === true).catch(() => ({ ok: false })); return r.ok === true })
  ipcMain.handle('together-stop', async (e) => { trusted(e); return stop() })

  async function stop() {
    const id = session && session.id
    session = null
    selected = null
    if (!id) return { ok: true }
    return desk().stop(id).catch((err) => ({ ok: false, error: err.message }))
  }

  /** 观看窗口要屏幕画面时：给它选定的那个来源（别的窗口、没开始时都不给） */
  function displaySource(request) {
    const w = getWindow()
    if (!w || request.frame !== w.webContents.mainFrame || !selected) return null
    return selected
  }

  return { stop, displaySource }
}

module.exports = { install }
