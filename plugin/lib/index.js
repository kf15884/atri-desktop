'use strict'
/**
 * koishi-plugin-atri-desktop 0.2.0（Atri15884 结构：依赖 atri-core，作为 core 扩展登记）
 * 桌面窗口 = 本人QQ私聊的镜像。桌面输入被包装成本人在同一QQ私聊里发的消息交给Koishi，
 * HDS按原链路处理（同一故事、同一参与者、同一记忆），Atri的回复照常发到QQ并同步到桌面。
 * 本人/机器人账号取自 atri-core 的 targetUserId/selfId；镜像在 before-send（相册、Bili 等）处理之后取最终内容。
 * 不改HDS，不改core，不代替HDS发言，不保存凭据。
 */
const { Schema, h, Universal, Logger } = require('koishi')
const { randomUUID, timingSafeEqual } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { ObservationStore } = require('./observations')
const name = 'atri-desktop'
const VERSION = require('../package.json').version
const DESK_PREFIX = 'atridesk-'
const PROTOCOL = 1
const logger = new Logger(name)

const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  ownerName: Schema.string().default('').description('桌面消息使用的昵称；留空用QQ号。本人/机器人QQ号取自 atri-core 配置。'),
  host: Schema.string().default('127.0.0.1').description('监听地址。保持127.0.0.1，经SSH隧道访问；不要开放公网。'),
  port: Schema.natural().default(5150).description('WebSocket端口。'),
  token: Schema.string().role('secret').required().description('桌面程序连接令牌（至少24位随机字符）。'),
  historyLimit: Schema.natural().min(20).max(2000).default(300).description('保留最近多少条镜像消息，供桌面重连补齐。'),
  persistHistory: Schema.boolean().default(true).description('把镜像记录保存到 data/atri-desktop/history.jsonl（0600），重启后仍可补齐。'),
  maxTextLength: Schema.natural().default(2000).description('桌面单条输入最大字数。'),
  minSendIntervalMs: Schema.natural().default(800).description('桌面两次输入的最小间隔。'),
  deskContextNote: Schema.boolean().default(true).description('本人刚从桌面窗口说话时，经 core 扩展接口给HDS一条临时资料（“这条是在电脑桌面窗口打的，回复照常发QQ”）。不改人设、不写长期记忆。'),
  inlineImageKB: Schema.natural().max(2048).default(300).description('相册/表情包等非网址图片不超过此大小时内联显示到桌面；超过只显示[图片]。0=不内联。'),
})

function isOneBot(platform) {
  const v = String(platform || '').toLowerCase()
  return v === 'onebot' || v.startsWith('onebot:') || v === 'napcat' || v.startsWith('napcat:') || v.startsWith('qq:onebot')
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 元素 → 桌面可显示的片段。不把服务器本地文件路径或超大base64发给桌面。 */
function toParts(elements, inline) {
  const parts = []
  const push = (p) => {
    const last = parts[parts.length - 1]
    if (p.t === 'text' && last && last.t === 'text') last.v += p.v
    else parts.push(p)
  }
  const walk = (els) => {
    for (const el of els || []) {
      const type = el.type
      if (type === 'text') { if (el.attrs.content) push({ t: 'text', v: String(el.attrs.content).replace(/\u200b/g, '') }) }
      else if (type === 'img' || type === 'image') {
        const src = String(el.attrs.src || el.attrs.url || '')
        const data = /^https?:\/\//i.test(src) ? null : inline && inline(el)
        push(/^https?:\/\//i.test(src) ? { t: 'image', src } : data ? { t: 'image', src: data } : { t: 'note', v: '[图片]' })
      } else if (type === 'face' || type === 'mface') push({ t: 'note', v: '[表情]' })
      else if (type === 'at') push({ t: 'text', v: '@' + (el.attrs.name || el.attrs.id || '') + ' ' })
      else if (type === 'quote') { /* 引用不显示 */ }
      else if (type === 'audio' || type === 'record') push({ t: 'note', v: '[语音]' })
      else if (type === 'video') push({ t: 'note', v: '[视频]' })
      else if (type === 'file') push({ t: 'note', v: '[文件]' })
      else if (type === 'br') push({ t: 'text', v: '\n' })
      else if (type === 'p' || type === 'message') { walk(el.children); if (type === 'p') push({ t: 'text', v: '\n' }) }
      else if (type === 'json' || type === 'xml' || type === 'onebot:json' || type === 'ark') push({ t: 'card', v: cardTitle(el) })
      else if (el.children && el.children.length) walk(el.children)
      else push({ t: 'note', v: '[' + type + ']' })
    }
  }
  walk(elements)
  return parts.filter(p => !(p.t === 'text' && !p.v.trim()))
}

function cardTitle(el) {
  try {
    const data = JSON.parse(el.attrs.data || '{}')
    const meta = data.meta && (data.meta.detail_1 || data.meta.news || Object.values(data.meta)[0])
    return String((meta && (meta.desc || meta.title)) || data.prompt || '卡片').slice(0, 120)
  } catch { return '卡片' }
}

/** 去掉指向桌面消息的引用（QQ里不存在该消息）。返回 [elements, changed]。 */
function stripDeskQuotes(elements) {
  let changed = false
  const out = elements.filter(el => {
    if (el.type === 'quote' && String(el.attrs.id || '').startsWith(DESK_PREFIX)) { changed = true; return false }
    return true
  })
  return [out, changed]
}

function onlyBlank(elements) {
  return elements.every(el => el.type === 'text' && !String(el.attrs.content || '').replace(/[\s\u200b]/g, ''))
}

class History {
  constructor(file, limit) {
    this.file = file; this.limit = limit; this.items = []; this.seq = 0
    if (file && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { const it = JSON.parse(line); this.items.push(it); this.seq = Math.max(this.seq, it.seq) } catch { }
      }
      this.items = this.items.slice(-limit)
    }
    this.lines = this.items.length
  }
  add(item) {
    item.seq = ++this.seq
    this.items.push(item)
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.appendFileSync(this.file, JSON.stringify(item) + '\n', { mode: 0o600 })
      if (++this.lines > this.limit * 2) {
        const tmp = this.file + '.tmp'
        fs.writeFileSync(tmp, this.items.map(i => JSON.stringify(i)).join('\n') + '\n', { mode: 0o600 })
        fs.renameSync(tmp, this.file); this.lines = this.items.length
      }
    }
    return item
  }
  since(seq) { return this.items.filter(i => i.seq > seq) }
}

const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const sniff = (b) => b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg'
  : b[0] === 0x47 && b[1] === 0x49 ? 'image/gif' : b[8] === 0x57 && b[9] === 0x45 ? 'image/webp' : null

/** 相册Buffer、HDS表情包file://（限Koishi目录内）、base64:// → 小图内联；其他不读。 */
function makeInliner(baseDir, maxKB) {
  const max = maxKB * 1024
  const root = fs.realpathSync(baseDir) + path.sep
  return (el) => {
    if (!max) return null
    try {
      const src = el.attrs.src ?? el.attrs.url
      let buf, mime
      if (Buffer.isBuffer(src) || src instanceof Uint8Array) buf = Buffer.from(src)
      else if (src instanceof ArrayBuffer) buf = Buffer.from(src)
      else if (typeof src === 'string' && src.startsWith('data:image/')) return src.length <= max * 1.37 + 64 ? src : null
      else if (typeof src === 'string' && src.startsWith('base64://')) buf = Buffer.from(src.slice(9), 'base64')
      else if (typeof src === 'string' && src.startsWith('file://')) {
        const { fileURLToPath } = require('node:url')
        const file = fs.realpathSync(fileURLToPath(src))
        if (!file.startsWith(root)) return null
        mime = IMG_MIME[path.extname(file).toLowerCase()]
        if (!mime || fs.statSync(file).size > max) return null
        buf = fs.readFileSync(file)
      } else return null
      if (!buf || !buf.length || buf.length > max) return null
      mime = sniff(buf) || mime
      return mime ? `data:${mime};base64,${buf.toString('base64')}` : null
    } catch { return null }
  }
}

/** 本人私聊判定：与 atri-core 的 ownerSession 一致。 */
function ownerDirect(s, id) {
  return isOneBot(s.platform) && String(s.selfId) === id.selfId && String(s.userId) === id.targetUserId && s.isDirect === true && !s.guildId
}

function apply(ctx, config) {
  if (config.enabled === false) return
  let WebSocketServer
  try { ({ WebSocketServer } = require('ws')) } catch (e) { logger.error('缺少 ws 依赖：%s', e.message); return }
  if (!config.token || String(config.token).length < 24) {
    logger.error('token 未设置或少于24位，桌面桥接不启动'); return
  }
  const kernel = ctx.atriCore && ctx.atriCore.runtime
  if (!kernel || kernel.apiVersion !== 1 || !kernel.features || kernel.features.extensions !== 1) {
    logger.warn('需要 atri-core（API 1，含扩展接口）；未启动，不退回独立账号配置'); return
  }
  const id = { targetUserId: String(kernel.config.targetUserId || ''), selfId: String(kernel.config.selfId || '') }
  if (!id.targetUserId || !id.selfId) { logger.warn('atri-core 未填写本人/机器人账号；未启动'); return }
  let owner
  try { owner = kernel.registerOwner(name, { apiVersion: 1 }) }
  catch (e) { logger.warn('core 登记失败 [%s]；可能重复实例，未启动', e.code || 'error'); return }

  const ownerChannel = 'private:' + id.targetUserId
  const baseDir = ctx.baseDir || process.cwd()
  const history = new History(config.persistHistory ? path.join(baseDir, 'data', name, 'history.jsonl') : null, config.historyLimit)
  const inline = makeInliner(baseDir, config.inlineImageKB ?? 300)
  const clients = new Set()
  const wrapped = new Map() // bot -> own createMessage (null=原型方法)
  const observations = new ObservationStore()
  const recentDesk = [] // {text, at}
  const stats = { deskIn: 0, mirrored: 0, cancelled: 0, failed: 0, notes: 0 }
  let lastDeskSend = 0

  const broadcast = (msg) => {
    const data = JSON.stringify(msg)
    for (const ws of clients) if (ws.readyState === 1) ws.send(data)
  }
  const record = (item) => { history.add(item); broadcast({ type: 'msg', item }); return item }
  const pickBot = () => ctx.bots.find(b => isOneBot(b.platform) && String(b.selfId) === id.selfId)
  const online = (bot) => !!bot && bot.status === Universal.Status.ONLINE

  // ---- core 扩展：桌面来源临时资料（P1 识屏观察也走这里） ----
  let offExt = null
  { // Always register volatile observation context; desk-source note stays optional.
    try {
      offExt = owner.extension({
        apiVersion: 1, version: VERSION, timeoutMs: 30, priority: 500,
        contextNotes: (view) => {
          const visual = observations.note(view)
          const offered = visual ? [visual] : []
          if (config.deskContextNote === false) return offered
          const now = Date.now()
          while (recentDesk.length && now - recentDesk[0].at > 10 * 60000) recentDesk.shift()
          const msg = String(view.userMessage || '')
          if (!msg || !recentDesk.some(d => msg.includes(d.text.slice(0, 200)) || msg.includes(d.esc.slice(0, 200)))) return offered
          stats.notes++
          return [...offered, { text: '本人这轮消息是在电脑上的Atri桌面窗口里打的（桌面窗口与QQ私聊是同一段对话）；回复照常发到QQ私聊，桌面会同步显示。', coverage: 'atri-desktop：仅说明输入来源，不含屏幕内容', sourceId: 'atri-desktop:desk-input' }]
        },
      })
    } catch (e) { logger.warn('core 扩展登记失败 [%s]；桌面聊天照常，不提供来源资料', e.code || 'error') }
  }

  // ---- Atri → 本人私聊：在 before-send（相册/Bili等）之后取最终内容，有回执才镜像 ----
  const wrapBot = (bot) => {
    if (!isOneBot(bot.platform) || wrapped.has(bot) || String(bot.selfId) !== id.selfId) return
    const own = Object.prototype.hasOwnProperty.call(bot, 'createMessage') ? bot.createMessage : null
    const original = own || Object.getPrototypeOf(bot).createMessage
    wrapped.set(bot, own)
    bot.createMessage = async function (channelId, content, referrer, options) {
      const Encoder = this.constructor && this.constructor.MessageEncoder
      if (String(channelId) !== ownerChannel) return original.call(this, channelId, content, referrer, options)
      let elements = h.normalize(content)
      const [stripped, changed] = stripDeskQuotes(elements)
      if (changed) {
        elements = stripped
        if (onlyBlank(elements)) { logger.info('跳过只含桌面引用的空消息（QQ中不存在被引用的桌面消息）'); return [] }
      }
      let result, finalEls = elements
      try {
        if (!own && Encoder) {
          const enc = new Encoder(this, channelId, referrer, options)
          result = await enc.send(changed ? elements : content)
          if (enc.session && Array.isArray(enc.session.elements)) finalEls = enc.session.elements
        } else result = await original.call(this, channelId, changed ? elements : content, referrer, options)
      } catch (e) { stats.failed++; throw e }
      const ids = (result || []).map(m => m && m.id).filter(Boolean)
      if (!result || !result.length) { stats.cancelled++; return result } // before-send 取消或无回执：不镜像
      const parts = toParts(finalEls, inline)
      if (parts.length) { stats.mirrored++; record({ id: 'out-' + randomUUID(), role: 'atri', source: 'qq', at: Date.now(), parts, messageIds: ids }) }
      return result
    }
  }
  const unwrapAll = () => {
    for (const [bot, own] of wrapped) { if (own) bot.createMessage = own; else delete bot.createMessage }
    wrapped.clear()
  }
  for (const bot of ctx.bots) wrapBot(bot)
  ctx.on('bot-added', wrapBot)
  ctx.on('bot-status-updated', wrapBot)

  // ---- 本人在QQ里发的私聊：镜像到桌面 ----
  ctx.on('message', (session) => {
    if (!ownerDirect(session, id)) return
    if (String(session.messageId || '').startsWith(DESK_PREFIX)) return
    const parts = toParts(session.elements, inline)
    if (parts.length) record({ id: 'qq-' + (session.messageId || randomUUID()), role: 'user', source: 'qq', at: session.timestamp || Date.now(), parts })
  })

  // ---- 桌面输入 → 合成本人私聊消息交给 Koishi（HDS / core / 手册按原链路处理） ----
  const deskSay = (text) => {
    const bot = pickBot()
    if (!bot) throw new Error('no-onebot-bot')
    if (!online(bot)) throw new Error('bot-offline')
    const mid = DESK_PREFIX + randomUUID()
    const escaped = h.escape(text)
    const session = bot.session({
      type: 'message',
      timestamp: Date.now(),
      channel: { id: ownerChannel, type: Universal.Channel.Type.DIRECT },
      user: { id: id.targetUserId, name: config.ownerName || id.targetUserId },
      message: { id: mid, content: escaped, elements: h.parse(escaped) },
    })
    const item = record({ id: mid, role: 'user', source: 'desk', at: session.timestamp, parts: [{ t: 'text', v: text }] })
    recentDesk.push({ text, esc: escaped, at: Date.now() }); if (recentDesk.length > 20) recentDesk.shift()
    stats.deskIn++
    bot.dispatch(session)
    return item
  }

  // ---- WebSocket ----
  let wss
  ctx.on('ready', () => {
    wss = new WebSocketServer({ host: config.host, port: config.port, maxPayload: 64 * 1024 })
    wss.on('error', (e) => logger.error('WebSocket 启动失败：%s', e.message))
    wss.on('listening', () => logger.info('桌面桥接已监听 %s:%d', config.host, config.port))
    wss.on('connection', (ws, req) => {
      let authed = false
      const timer = setTimeout(() => { if (!authed) ws.close(4001, 'auth-timeout') }, 5000)
      ws.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(String(raw)) } catch { return ws.close(4002, 'bad-json') }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return ws.close(4002, 'bad-json')
        if (!authed) {
          if (msg.type !== 'hello' || !safeEqual(msg.token || '', config.token)) {
            logger.warn('桌面连接认证失败 来源=%s', req.socket.remoteAddress)
            return ws.close(4003, 'auth-failed')
          }
          authed = true; clearTimeout(timer); clients.add(ws)
          ws.send(JSON.stringify({ type: 'ready', protocol: PROTOCOL, version: VERSION, seq: history.seq, botOnline: online(pickBot()) }))
          const since = Number.isFinite(msg.since) ? msg.since : 0
          ws.send(JSON.stringify({ type: 'history', items: since > history.seq ? history.items : history.since(since) }))
          return
        }
        if (['observation-start','observe','observation-stop'].includes(msg.type)) {
          const reply = (value) => ws.send(JSON.stringify({type:'ack',cid:msg.cid,...value}))
          try {
            if(msg.type==='observation-start') observations.start(ws,msg.sessionId)
            else if(msg.type==='observation-stop') observations.stop(ws)
            else observations.put(ws,msg)
            return reply({ok:true,stage:'cached-not-consumed'})
          } catch(e) { return reply({ok:false,error:e.message}) }
        }
        if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: msg.t }))
        if (msg.type === 'say') {
          const text = String(msg.text || '').replace(/\r\n/g, '\n').trim()
          const reply = (o) => ws.send(JSON.stringify({ type: 'ack', cid: msg.cid, ...o }))
          if (!text) return reply({ ok: false, error: 'empty' })
          if (text.length > config.maxTextLength) return reply({ ok: false, error: 'too-long' })
          const now = Date.now()
          if (now - lastDeskSend < config.minSendIntervalMs) return reply({ ok: false, error: 'too-fast' })
          lastDeskSend = now
          try { const item = deskSay(text); reply({ ok: true, seq: item.seq, id: item.id }) }
          catch (e) { reply({ ok: false, error: e.message }) }
        }
      })
      ws.on('close', () => { clearTimeout(timer); clients.delete(ws); observations.stop(ws) })
    })
  })

  // ---- /adesk：与 /acore 相同方式（本人私聊、前置中间件） ----
  ctx.middleware((s, next) => {
    if (!ownerDirect(s, id) || !/^\/adesk\s*$/i.test(String(s.content || '').trim())) return next()
    const bot = pickBot()
    return h.escape([
      `atri-desktop ${VERSION}（core扩展：${offExt ? '已登记' : '未登记'}；HDS：${kernel.hostReady() ? '就绪' : '未就绪/暂停'}）`,
      `监听：${config.host}:${config.port}；桌面连接：${clients.size}`,
      `机器人：${bot ? bot.selfId + (online(bot) ? ' 在线' : ' 离线') : '未找到'}；发送包装：${wrapped.size ? '已挂接' : '未挂接'}`,
      `镜像记录：${history.items.length}（序号${history.seq}）`,
      `本进程：桌面输入${stats.deskIn}｜镜像回复${stats.mirrored}｜取消/无回执${stats.cancelled}｜发送失败${stats.failed}｜来源资料${stats.notes}`,
      `观察资料：${observations.item ? '临时缓存（不等于HDS使用）' : '无'}；暂停/断线清除，120秒过期`,
      '只说明桥接状态，不证明QQ客户端已展示。',
    ].join('\n'))
  }, true)

  ctx.on('dispose', () => {
    unwrapAll()
    observations.clear()
    try { offExt && offExt() } catch { }
    try { owner.dispose() } catch { }
    for (const ws of clients) ws.close(1001, 'plugin-dispose')
    clients.clear()
    if (wss) wss.close()
  })
}

module.exports = { name, Config, apply, inject: { required: ['atriCore'], optional: ['interlude'] }, DESK_PREFIX, _internal: { toParts, stripDeskQuotes, History, makeInliner } }
