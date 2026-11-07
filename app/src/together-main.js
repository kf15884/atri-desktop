'use strict'
/**
 * 一起看番（0.4）主进程这边：设置（口令、看图密钥用系统加密存在这台电脑上）、选来源、
 * 帮观看窗口问看图模型、把文字交给 Atri、取角色头像。画面在观看窗口里截、挑、拼，不在这里留。
 */
const { desktopCapturer, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { askVision, askHearing, fetchPortrait, visionBase } = require('./together-net')
const { transcribe, localBase } = require('./asr-local')
const { finalAnswer, fillHeard, clock } = require('./frames-core')

const DEFAULTS = { atriUrl: 'http://127.0.0.1:15160', tokenEnc: '', visionBase: 'https://api.deepseek.com', visionModel: '', keyEnc: '', extraBody: '', priceIn: 0, priceOut: 0, mode: 'interval', fps: 4, castRef: true, strip: true,
  hearingMode: 'cloud', hearingBase: '', hearingModel: '', hearingKeyEnc: '', hearPriceIn: 0, hearPriceOut: 0, asrBase: 'http://127.0.0.1:8000/v1', asrModel: 'small' }

function install({ ipcMain, userDir, getWindow, connection }) {
  const file = path.join(userDir, 'together.json')
  let s = { ...DEFAULTS }
  try { s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch {}
  const save = () => { fs.mkdirSync(userDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 }) }
  const enc = (t) => (t ? safeStorage.encryptString(t).toString('base64') : '')
  const dec = (b) => { if (!b) return ''; try { return safeStorage.decryptString(Buffer.from(b, 'base64')) } catch { return '' } }
  const pub = () => ({ visionBase: s.visionBase, visionModel: s.visionModel, hasKey: !!s.keyEnc, extraBody: s.extraBody, priceIn: s.priceIn, priceOut: s.priceOut, mode: s.mode, fps: s.fps, castRef: s.castRef, strip: s.strip,
    hearingMode: s.hearingMode, hearingBase: s.hearingBase, hearingModel: s.hearingModel, hasHearingKey: !!s.hearingKeyEnc, hearPriceIn: s.hearPriceIn, hearPriceOut: s.hearPriceOut, asrBase: s.asrBase, asrModel: s.asrModel })
  // 连 Atri 用自动连接那一条（0.5）
  const desk = () => connection.desk()
  let session = null // { id, prompt, sourceId, sourceName }
  let selected = null

  function trusted(e) { const w = getWindow(); if (!w || e.sender !== w.webContents) throw new Error('untrusted-window') }

  ipcMain.handle('together-init', (e) => { trusted(e); return { settings: pub(), session: session ? { id: session.id } : null } })
  ipcMain.handle('together-save', (e, x) => {
    trusted(e)
    if (!x || typeof x !== 'object') throw new Error('invalid')
    if (typeof x.visionBase === 'string') s.visionBase = visionBase(x.visionBase)
    if (typeof x.visionModel === 'string') s.visionModel = x.visionModel.trim().slice(0, 120)
    if (typeof x.key === 'string' && x.key.trim()) s.keyEnc = enc(x.key.trim())
    if (typeof x.extraBody === 'string') { const t = x.extraBody.trim(); if (t) { const v = JSON.parse(t); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('额外参数要是 JSON 对象') } s.extraBody = t }
    if (x.hearingMode === 'cloud' || x.hearingMode === 'local' || x.hearingMode === 'off') s.hearingMode = x.hearingMode
    if (typeof x.hearingBase === 'string') s.hearingBase = x.hearingBase.trim() ? visionBase(x.hearingBase) : ''
    if (typeof x.hearingModel === 'string') s.hearingModel = x.hearingModel.trim().slice(0, 120)
    if (typeof x.hearingKey === 'string' && x.hearingKey.trim()) s.hearingKeyEnc = enc(x.hearingKey.trim())
    if (typeof x.asrBase === 'string') s.asrBase = localBase(x.asrBase)
    if (typeof x.asrModel === 'string') s.asrModel = x.asrModel.trim().slice(0, 120)
    for (const k of ['hearPriceIn', 'hearPriceOut']) if (Number.isFinite(Number(x[k]))) s[k] = Math.max(0, Number(x[k]))
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
    session = { id: r.sessionId, prompt: hello.prompt, hearing: s.hearingMode }
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
    // 先听（这一段的声音），听到的填进看图的提示词里，再一起交给 Atri
    const sound = await hear(x, id)
    const usages = sound.usage ? [sound.usage] : []
    let res
    try {
      res = await askVision({ base: s.visionBase, model: s.visionModel, key: dec(s.keyEnc), extraBody, system: session.prompt.system, prompt: fillHeard(String(x.prompt || '').slice(0, 6000), sound.state === 'heard' ? sound.text : ''), images })
    } catch (err) {
      return { ok: false, error: err.message, usage: err.usage || null, hearingUsage: sound.usage || null, sound: soundOut(sound) }
    }
    // 停了以后回来的结果不交
    if (!session || session.id !== id) return { ok: false, error: '这一场已经停了', usage: res.usage }
    const out = { ok: true, text: res.text, usage: res.usage, hearingUsage: sound.usage || null, sound: soundOut(sound), soundError: sound.error || null }
    let data = null
    try { const a = res.text.indexOf('{'), b = res.text.lastIndexOf('}'); data = JSON.parse(res.text.slice(a, b + 1)) } catch {}
    if (!data) return { ...out, ok: false, error: '看图模型没按格式写，这一段没交给 Atri' }
    const post = await desk().segment({ sessionId: id, seq: x.seq, from: x.from, to: x.to, data, sound: soundOut(sound), usage: [res.usage, ...usages] }).catch((err) => ({ ok: false, error: err.message }))
    return { ...out, data, delivered: post.ok === true, deliveryError: post.ok ? null : post.error || null, speak: post.speak === true }
  })
  ipcMain.handle('together-pause', async (e, paused) => { trusted(e); if (!session) return false; const r = await desk().pause(session.id, paused === true).catch(() => ({ ok: false })); return r.ok === true })
  ipcMain.handle('together-stop', async (e) => { trusted(e); return stop() })

  const soundOut = (x) => ({ state: x.state, text: x.text || '', via: x.via || '' })

  /** 听这一段：没开 / 没录到 → none；太安静 → silent（不去听，省钱）；出错 → failed（只说没听成，画面照看） */
  async function hear(x, id) {
    if (s.hearingMode === 'off') return { state: 'none' }
    if (x.audio === 'none' || !x.wav) return { state: x.audio === 'silent' ? 'silent' : 'none' }
    const wav = Buffer.from(x.wav)
    if (wav.length > 2 * 1024 * 1024 || wav.toString('ascii', 0, 4) !== 'RIFF') return { state: 'failed', text: '' }
    try {
      if (s.hearingMode === 'local') {
        const r = await transcribe({ base: s.asrBase, model: s.asrModel, wav, signal: AbortSignal.timeout(60000) })
        return r.text ? { state: 'heard', text: '日语原文：' + r.text.slice(0, 380), via: 'local' } : { state: 'silent', via: 'local' }
      }
      const prompt = String(session && session.prompt && session.prompt.hearing || '只写听到的台词、音乐和气氛，150 字以内，结果放在 <结果></结果> 里。').replace('{from}', clock(x.from)).replace('{to}', clock(x.to))
      const r = await askHearing({ base: s.hearingBase, model: s.hearingModel, key: dec(s.hearingKeyEnc), prompt, wav, finalAnswer })
      if (!session || session.id !== id) return { state: 'none' }
      return { state: /^没有台词[。]?$/.test(r.text.trim()) ? 'silent' : 'heard', text: r.text, via: 'cloud', usage: r.usage }
    } catch (err) {
      return { state: 'failed', text: '', via: s.hearingMode, usage: err.usage || null, error: err.message }
    }
  }

  async function stop() {
    const id = session && session.id
    session = null
    selected = null
    if (!id) return { ok: true }
    return desk().stop(id).catch((err) => ({ ok: false, error: err.message }))
  }

  /**
   * 观看窗口要屏幕画面时：给它选定的那个来源（别的窗口、没开始时都不给）。
   * 0.5.1：每次现取一遍来源（窗口重开过 id 对得上就行）；页面没要声音就不给回环（截不到时页面会不带声音再试）
   */
  async function displaySource(request) {
    const w = getWindow()
    if (!w || request.frame !== w.webContents.mainFrame || !selected) return null
    const fresh = (await desktopCapturer.getSources({ types: [selected.id.startsWith('screen:') ? 'screen' : 'window'], thumbnailSize: { width: 0, height: 0 } })).find((y) => y.id === selected.id)
    if (!fresh) return null
    // 开了声音：Windows 系统回环（电脑正在播放的声音，不是麦克风）
    return session && session.hearing !== 'off' && request.audioRequested !== false ? { video: fresh, audio: 'loopback' } : { video: fresh }
  }

  return { stop, displaySource }
}

module.exports = { install }
