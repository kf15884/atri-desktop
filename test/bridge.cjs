const ENV = require('node:path').resolve(__dirname, '../env/node_modules') + '/'
const { App, Bot, MessageEncoder, Universal, h } = require(ENV + 'koishi')
const { Bridge } = require('../app/src/bridge.js')
const assert = require('node:assert/strict')
const sent = []
class Enc extends MessageEncoder { async prepare() { this.b = [] } async visit(e) { this.b.push(e) } async flush() { if (!this.b.length) return; sent.push(this.b.join('')); this.results.push({ id: 'm' + sent.length }); this.b = [] } }
class FB extends Bot { static MessageEncoder = Enc; constructor(c, o) { super(c, o, 'onebot'); this.selfId = '1' } async start() { this.online() } }
;(async () => {
  const app = new App({}); let bot
  app.plugin(require(ENV + 'koishi-plugin-atri-core'), { targetUserId: '2', selfId: '1' })
  app.plugin(require(ENV + 'koishi-plugin-atri-desktop'), { token: 't'.repeat(30), port: 15151, persistHistory: false })
  app.plugin((ctx) => { bot = new FB(ctx, {}) })
  // 模拟HDS：收到本人私聊就回复
  app.middleware((s, next) => { if (s.isDirect && s.userId === '2') return s.send('回复：' + s.content); return next() })
  await app.start()
  const states = [], msgs = []
  let token = 'bad-token-xxxxxxxxxxxxxxxxxxxxxx'
  const b = new Bridge(() => ({ url: 'ws://127.0.0.1:15151', token, since: 0 }))
  b.on('state', s => states.push(s.label)); b.on('msg', m => msgs.push(m)); b.on('history', () => {})
  b.start(); await new Promise(r => setTimeout(r, 800))
  assert.ok(states.some(s => s.includes('令牌错误')), states.join('|'))
  token = 't'.repeat(30); b.restart(); await new Promise(r => setTimeout(r, 800))
  assert.equal(b.state.online, true)
  const r = await b.say('你好 &<b>')
  assert.equal(r.ok, true)
  await new Promise(r => setTimeout(r, 500))
  assert.ok(msgs.some(m => m.role === 'user' && m.source === 'desk'))
  const reply = msgs.find(m => m.role === 'atri'); assert.ok(reply, 'mirror reply')
  assert.equal(reply.parts[0].v, '回复：你好 &<b>', '文字原样往返')
  b.stop(); await app.stop(); console.log('BRIDGE OK', states.join(' → ')); process.exit(0)
})().catch(e => { console.error('BRIDGE FAIL', e); process.exit(1) })
