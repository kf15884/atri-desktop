'use strict'
/**
 * 桌面聊天（0.5，P11-04 / P11-05），主进程这边：
 * - 连上 Atri 后先拉最近 100 条，再一直长轮询收新的（她在想、她的探测也从这里来，探测马上应答）
 * - 本地存最近 500 条，系统加密（换电脑打不开）；离线也能翻
 * - 发消息：先在本地显示“发送中”；服务器回“收到了”才算送到；没收到只标“没送到”，不自动重发（手动“再发一次”用同一个编号，不会让她回两遍）
 * - 她发的新消息：交给对话框、立绘气泡、消息卡片
 * 这里不碰 Electron 窗口，存储、加密、计时都可以换成假的来测。
 */
const { EventEmitter } = require('node:events')
const { randomUUID } = require('node:crypto')

const KEEP = 500

/** 合并：按 seq 去重排序；本地待发的（没有 seq）放最后 */
function merge(list, items) {
  const bySeq = new Map(list.filter((x) => x.seq).map((x) => [x.seq, x]))
  for (const it of items) if (it && Number.isInteger(it.seq)) bySeq.set(it.seq, { ...(bySeq.get(it.seq) || {}), ...it })
  const pending = list.filter((x) => !x.seq && !items.some((it) => it.clientId && it.clientId === x.clientId))
  return [...[...bySeq.values()].sort((a, b) => a.seq - b.seq), ...pending].slice(-KEEP)
}

class ChatService extends EventEmitter {
  /**
   * @param {object} d
   *   desk(): DeskClient（history / events / say / ack）
   *   ready(): 现在连着、口令对
   *   load(): 本地存的（数组）；save(items)：存（调用方负责加密）
   *   sleep(ms)
   */
  constructor(d) {
    super()
    this.d = d
    this.items = []
    try { this.items = Array.isArray(d.load()) ? d.load().slice(-KEEP) : [] } catch { this.items = [] }
    this.items = this.items.map((x) => (x.state === 'sending' ? { ...x, state: 'failed', error: '程序关了，没确认送到' } : x))
    this.thinking = false
    this.running = false
    this.synced = false
    this.gen = 0
    this.saveTimer = null
  }

  maxSeq() {
    return this.items.reduce((m, x) => (x.seq && x.seq > m ? x.seq : m), 0)
  }

  persist() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { try { this.d.save(this.items) } catch {} }, 300)
    if (this.saveTimer.unref) this.saveTimer.unref()
  }

  apply(items) {
    if (!items || items.length === 0) return []
    const before = new Set(this.items.filter((x) => x.seq).map((x) => x.seq))
    this.items = merge(this.items, items)
    this.persist()
    const fresh = items.filter((x) => x.seq && !before.has(x.seq))
    this.emit('items', this.items, fresh)
    return fresh
  }

  /** 连上了：拉历史，然后一直收（同一时间只有一个循环；断了就停，等下次连上再开） */
  async start() {
    if (this.running) return
    this.running = true
    const gen = ++this.gen
    try {
      const h = await this.d.desk().history(100)
      if (gen !== this.gen) return
      if (h.ok) { this.apply(h.items || []); this.synced = true }
      while (this.running && gen === this.gen && this.d.ready()) {
        let r
        try {
          r = await this.d.desk().events(this.maxSeq())
        } catch (e) {
          await this.d.sleep(3000)
          continue
        }
        if (gen !== this.gen) return
        if (!r.ok) { await this.d.sleep(3000); continue }
        if (r.ping) void this.d.desk().ack(r.ping).catch(() => {})
        if (typeof r.thinking === 'boolean' && r.thinking !== this.thinking) { this.thinking = r.thinking; this.emit('thinking', r.thinking) }
        const fresh = this.apply(r.items || [])
        for (const x of fresh) if (x.who === 'atri') this.emit('atri', x)
      }
    } finally {
      if (gen === this.gen) this.running = false
    }
  }

  stop() {
    this.running = false
    this.gen++
    if (this.thinking) { this.thinking = false; this.emit('thinking', false) }
  }

  /** 他说一句（可带图）；返回本地这条 */
  async say(text, images = [], clientId = null) {
    const id = clientId || 'c-' + randomUUID()
    const existing = this.items.find((x) => x.clientId === id && !x.seq)
    const local = existing || { clientId: id, who: 'me', via: 'desk', at: Date.now(), text: String(text || ''), thumbs: images.map((im) => im.thumb).filter(Boolean), state: 'sending' }
    local.state = 'sending'
    delete local.error
    if (!existing) this.items = [...this.items, local].slice(-KEEP)
    this.emit('items', this.items, [])
    try {
      if (!this.d.ready()) throw new Error('没连上 Atri')
      const r = await this.d.desk().say({ text: local.text, images: images.map((im) => ({ mime: im.mime, data: im.data, ...(im.sticker ? { sticker: true } : {}) })), clientId: id })
      if (!r.ok) throw new Error(r.error || '没送到')
      local.state = 'sent'
      if (r.seq) {
        // 服务器那条到了就合成一条（本地这条留着缩略图）
        local.seq = r.seq
        const dup = this.items.filter((x) => x.seq === r.seq)
        if (dup.length > 1) this.items = this.items.filter((x) => !(x.seq === r.seq && x !== local))
      }
    } catch (e) {
      // 结果不明：只标出来，不自动重发
      local.state = 'failed'
      local.error = e && e.message ? e.message : String(e)
    }
    this.items = merge(this.items, [])
    this.persist()
    this.emit('items', this.items, [])
    return local
  }
}

module.exports = { ChatService, merge, KEEP }
