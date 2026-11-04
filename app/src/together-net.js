'use strict'
/**
 * 一起看番（0.4）的网络部分，在主进程里跑（node 可测）：
 * - 看图：用你自己填的线路（OpenAI 兼容 /chat/completions），密钥只在这台电脑上，不交给 Atri
 * - Atri：只连本机隧道口（http://127.0.0.1:端口），只发文字和用量
 * - 角色头像：只从 Bangumi 图床（https://lain.bgm.tv/）取，最大 1MB
 * 都不跟随重定向；回答大小有上限。
 */

/** Atri 的地址：只能是本机（经 SSH 隧道） */
function atriBase(s) {
  const u = new URL(String(s || '').trim())
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
    throw new Error('Atri 地址只能是本机隧道口，例如 http://127.0.0.1:15160')
  return u.origin
}

/** 看图线路：https 的任意站点，或者本机 http（本地模型） */
function visionBase(s) {
  const u = new URL(String(s || '').trim())
  const local = u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)
  if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash) throw new Error('看图地址要是 https://…（或本机的 http://127.0.0.1…）')
  return u.href.replace(/\/+$/, '')
}

async function boundedText(res, max) {
  const reader = res.body.getReader()
  const parts = []
  let n = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      n += value.length
      if (n > max) throw new Error('回答太大')
      parts.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(parts).toString('utf8')
}

class DeskClient {
  constructor({ base, token, fetch: f }) {
    this.base = atriBase(base)
    this.token = String(token || '')
    this.fetch = f || fetch
  }
  async req(method, path, body) {
    const r = await this.fetch(this.base + path, {
      method,
      redirect: 'error',
      headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(path === '/desk/session/start' ? 45000 : 15000),
    })
    const text = await boundedText(r, 256 * 1024)
    let v = {}
    try {
      v = JSON.parse(text)
    } catch {
      v = { ok: false, error: 'Atri 回的不是 JSON' }
    }
    if (r.status === 401) throw new Error('Atri 口令不对')
    if (!r.ok && !v.error) v.error = 'HTTP ' + r.status
    return { status: r.status, ...v }
  }
  hello() { return this.req('GET', '/desk/hello') }
  start(x) { return this.req('POST', '/desk/session/start', x) }
  cast(sessionId) { return this.req('GET', '/desk/cast?session=' + encodeURIComponent(sessionId)) }
  segment(x) { return this.req('POST', '/desk/segment', x) }
  pause(sessionId, paused) { return this.req('POST', paused ? '/desk/session/pause' : '/desk/session/resume', { sessionId }) }
  stop(sessionId) { return this.req('POST', '/desk/session/stop', { sessionId }) }
}

/**
 * 问一次看图模型。images 是 JPEG 的 Buffer（拼图、字幕条、角色参考图）。
 * DeepSeek 官方默认关掉思考（思考会把 token 用完）；接口不认就去掉再试；5xx / 超时再试一次。
 */
async function askVision({ base, model, key, extraBody, system, prompt, images, fetch: f, timeoutMs = 90000, maxTokens = 1200 }) {
  const fetchFn = f || fetch
  if (!model) throw new Error('先填看图模型')
  if (!key) throw new Error('先填看图密钥')
  const url = visionBase(base) + '/chat/completions'
  let extra = { ...(extraBody || {}) }
  if (!('thinking' in extra) && /deepseek\.com/.test(url)) extra = { ...extra, thinking: { type: 'disabled' } }
  const content = [{ type: 'text', text: prompt }, ...images.map((b) => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64') } }))]
  const once = async (ex) => {
    const started = Date.now()
    let r
    try {
      r = await fetchFn(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ ...ex, model, temperature: 0.2, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      return { status: 0, raw: e && e.message ? e.message : String(e), ms: Date.now() - started }
    }
    const raw = await boundedText(r, 512 * 1024).catch((e) => String(e.message))
    let j = {}
    try {
      j = JSON.parse(raw)
    } catch {}
    const msg = j.choices && j.choices[0] && j.choices[0].message
    return { status: r.status, ok: r.ok, text: String((msg && msg.content) || '').trim(), reasoning: Boolean(msg && msg.reasoning_content), usage: j.usage || {}, raw: raw.slice(0, 200), ms: Date.now() - started }
  }
  let r = await once(extra)
  if (!r.ok && r.status === 400 && 'thinking' in extra && !(extraBody && 'thinking' in extraBody)) {
    const { thinking, ...rest } = extra
    void thinking
    extra = rest
    r = await once(extra)
  }
  if (!r.ok && (r.status === 0 || r.status >= 500)) r = await once(extra)
  const usage = { model, promptTokens: Number(r.usage && r.usage.prompt_tokens) || 0, completionTokens: Number(r.usage && r.usage.completion_tokens) || 0, ms: r.ms || 0, ok: Boolean(r.ok && r.text) }
  if (!r.ok) throw Object.assign(new Error('看图模型出错：' + (r.status ? 'HTTP ' + r.status + ' ' : '') + r.raw), { usage })
  if (!r.text) throw Object.assign(new Error('看图模型的回答是空的' + (r.reasoning ? '（思考把 token 用完了）' : '')), { usage })
  return { text: r.text, usage }
}

/**
 * 听一段声音（16kHz WAV）：用你自己填的“听”线路（OpenAI 兼容，input_audio），和服务器“听”同一套提示词。
 * 超时、5xx 再试一次；回答里只取 <结果>…</结果>。
 */
async function askHearing({ base, model, key, extraBody, prompt, wav, fetch: f, timeoutMs = 60000, finalAnswer }) {
  const fetchFn = f || fetch
  if (!model) throw new Error('先填听的模型')
  if (!key) throw new Error('先填听的密钥')
  const url = visionBase(base) + '/chat/completions'
  const once = async () => {
    const started = Date.now()
    let r
    try {
      r = await fetchFn(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ ...(extraBody || {}), model, temperature: 0.2, max_tokens: 800, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' } }] }] }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      return { status: 0, raw: e && e.message ? e.message : String(e), ms: Date.now() - started }
    }
    const raw = await boundedText(r, 512 * 1024).catch((e) => String(e.message))
    let j = {}
    try { j = JSON.parse(raw) } catch {}
    const msg = j.choices && j.choices[0] && j.choices[0].message
    return { status: r.status, ok: r.ok, text: String((msg && msg.content) || '').trim(), usage: j.usage || {}, raw: raw.slice(0, 200), ms: Date.now() - started }
  }
  let r = await once()
  if (!r.ok && (r.status === 0 || r.status >= 500)) r = await once()
  const usage = { tier: 'hearing', model, promptTokens: Number(r.usage && r.usage.prompt_tokens) || 0, completionTokens: Number(r.usage && r.usage.completion_tokens) || 0, ms: r.ms || 0, ok: Boolean(r.ok && r.text) }
  if (!r.ok) throw Object.assign(new Error('听的模型出错：' + (r.status ? 'HTTP ' + r.status + ' ' : '') + r.raw), { usage })
  const text = (finalAnswer ? finalAnswer(r.text) : r.text).slice(0, 400)
  if (!text) throw Object.assign(new Error('听的模型回答是空的'), { usage })
  return { text, usage }
}

/** 角色头像：只认 Bangumi 图床 */
async function fetchPortrait(url, f) {
  const u = new URL(String(url))
  if (u.protocol !== 'https:' || u.hostname !== 'lain.bgm.tv' || u.username || u.password) throw new Error('不是 Bangumi 的头像')
  const r = await (f || fetch)(u.href, { redirect: 'error', signal: AbortSignal.timeout(10000) })
  if (!r.ok) throw new Error('头像 HTTP ' + r.status)
  const type = String(r.headers.get('content-type') || '')
  if (!/^image\/(jpeg|png|webp|gif)/.test(type)) throw new Error('不是图片')
  const reader = r.body.getReader()
  const parts = []
  let n = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      n += value.length
      if (n > 1024 * 1024) throw new Error('头像太大')
      parts.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { type: type.split(';')[0], data: Buffer.concat(parts) }
}

module.exports = { atriBase, visionBase, DeskClient, askVision, askHearing, fetchPortrait }
