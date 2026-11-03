'use strict'
const { EventEmitter } = require('node:events')
const { randomUUID } = require('node:crypto')

/** 与主机 atri-desktop 插件的 WebSocket 连接：认证、补齐、心跳、断线重连。 */
class Bridge extends EventEmitter {
  constructor(getConfig) { super(); this.getConfig = getConfig; this.state = { label: '未连接', online: false }; this.pending = new Map(); this.retry = 0 }
  setState(s) { this.state = s; this.emit('state', s) }
  start() { this.stopped = false; this.connect() }
  stop() { this.stopped = true; clearTimeout(this.timer); clearInterval(this.ping); if (this.ws) try { this.ws.close() } catch { } }
  restart() { this.stop(); this.retry = 0; this.start() }
  connect() {
    const { url, token, since } = this.getConfig()
    if (!token) return this.setState({ label: '未设置令牌', online: false })
    this.setState({ label: '连接中…', online: false })
    let ws
    try { ws = new WebSocket(url) } catch (e) { return this.schedule('地址无效') }
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, since }))
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data) } catch { return }
      if (m.type === 'ready') { this.retry = 0; this.setState({ label: m.botOnline ? '已连接' : '已连接（QQ机器人离线）', online: true, version: m.version }); this.heartbeat() }
      else if (m.type === 'history') this.emit('history', m.items || [])
      else if (m.type === 'msg') this.emit('msg', m.item)
      else if (m.type === 'ack') { const p = this.pending.get(m.cid); if (p) { this.pending.delete(m.cid); p(m) } }
      else if (m.type === 'pong') this.lastPong = Date.now()
    }
    ws.onclose = (ev) => {
      clearInterval(this.ping)
      for (const [, p] of this.pending) p({ ok: false, error: 'disconnected' })
      this.pending.clear()
      if (this.stopped) return
      this.schedule(ev.code === 4003 ? '令牌错误' : '已断开')
    }
    ws.onerror = () => { }
  }
  heartbeat() {
    clearInterval(this.ping); this.lastPong = Date.now()
    this.ping = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return
      if (Date.now() - this.lastPong > 45000) return this.ws.close()
      this.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }))
    }, 15000)
  }
  schedule(reason) {
    if (reason === '令牌错误') return this.setState({ label: '令牌错误，请在设置中修改', online: false })
    const delay = Math.min(30000, 1000 * 2 ** this.retry++)
    this.setState({ label: `${reason}，${Math.round(delay / 1000)}秒后重连`, online: false })
    clearTimeout(this.timer); this.timer = setTimeout(() => this.connect(), delay)
  }
  say(text) { return this.request({type:'say',text}) }
  request(payload) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1 || !this.state.online) return resolve({ ok: false, error: 'not-connected' })
      const cid = randomUUID()
      const t = setTimeout(() => { this.pending.delete(cid); resolve({ ok: false, error: 'timeout' }) }, 10000)
      this.pending.set(cid, (m) => { clearTimeout(t); resolve(m) })
      this.ws.send(JSON.stringify({ ...payload, cid }))
    })
  }
}
module.exports = { Bridge }
