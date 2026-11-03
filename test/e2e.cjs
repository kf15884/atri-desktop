// 端到端：真实 Koishi4.18.11 + 服务器同版 HDS 1.0.1-rc58.atri.1 + atri-core 0.2.29 + SQLite + 假OneBot + 替身叙事器
process.chdir(__dirname)
const path = require('node:path'), fs = require('node:fs'), os = require('node:os')
const ENV = require('node:path').resolve(__dirname, '../env/node_modules') + '/'
const { App, Bot, MessageEncoder, Universal, h } = require(ENV + 'koishi')
const WebSocket = require(ENV + 'ws')
const assert = require('node:assert/strict')

const OWNER = '20002', SELF = '10001', OTHER = '30003'
const sent = []
class FakeEncoder extends MessageEncoder {
  async prepare() { this.buf = [] }
  async visit(el) { this.buf.push(el) }
  async flush() {
    if (!this.buf.length) return
    if (this.bot.failNext) { this.bot.failNext = false; throw new Error('fake-transport-failure') }
    const id = 'qqmsg-' + (sent.length + 1)
    sent.push({ channelId: this.channelId, elements: this.buf.map(String).join('') })
    const s = this.bot.session(); s.messageId = id; s.userId = this.bot.selfId; s.channelId = this.channelId
    this.results.push({ id }); this.buf = []
  }
}
class FakeOneBot extends Bot {
  static MessageEncoder = FakeEncoder
  constructor(ctx, config) { super(ctx, config, 'onebot'); this.selfId = SELF; this.user = { id: SELF, name: 'Atri' } }
  async start() { this.online() }
}

const qqIncoming = (bot, userId, text, id) => bot.dispatch(bot.session({
  type: 'message', timestamp: Date.now(),
  channel: { id: 'private:' + userId, type: Universal.Channel.Type.DIRECT },
  user: { id: userId, name: userId }, message: { id, content: text, elements: h.parse(text) },
}))
const wait = (ms) => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 8000, label = '') {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(50) }
  throw new Error('timeout ' + label)
}

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adesk-'))
  const app = new App({ baseDir: dir })
  app.plugin((m => m.default || m)(require(ENV + '@koishijs/plugin-http')))
  app.plugin((m => m.default || m)(require(ENV + '@koishijs/plugin-database-sqlite')), { path: path.join(dir, 'koishi.db') })
  app.plugin(require(ENV + 'koishi-plugin-hds-interlude'), {
    onebot: { enabled: true, botAccounts: [{ qq: SELF }], userAccounts: [{ qq: OWNER }, { qq: OTHER }] },
    runtime: { autoCreate: true, captureDirectMessages: true },
    sharedStory: { enabled: true, autoEnrollParticipants: true },
  })
  const TOKEN = 'x'.repeat(32)
  let bot
  app.plugin((ctx) => { bot = new FakeOneBot(ctx, {}) })
  // 模拟相册/Bili 的 before-send：照片标记→图片Buffer；〔取消〕整条取消
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082', 'hex')
  app.on('before-send', (s) => {
    const t = s.elements.map(String).join('')
    if (t.includes('〔取消〕')) return true
    if (t.includes('〔照片#1〕')) s.elements = [h.image(PNG, 'image/png')]
  })
  await app.start()
  await until(() => app.interlude, 15000, 'hds service')
  const svc = app.interlude
  const requests = []
  svc.setNarrator({
    available: () => true, visionAvailable: () => false,
    async decide(req) {
      requests.push(req)
      return { script: 'Atri看了一眼消息，笑着回复。', interaction: { seen: true, reply: { mode: 'immediate', content: '收到啦，' + requests.length } } }
    },
  })
  // 与服务器一致：core 挂接 HDS，桌面插件依赖 core
  app.plugin(require(ENV + 'koishi-plugin-atri-core'), { targetUserId: OWNER, selfId: SELF })
  const deskFork = app.plugin(require(ENV + 'koishi-plugin-atri-desktop'), { token: TOKEN, port: 15150 })
  await until(() => app.atriCore && app.atriCore.bridge && app.atriCore.bridge.installed, 5000, 'core attached')
  await until(() => app.atriCore.runtime.owners.has('atri-desktop'), 5000, 'desktop registered in core')
  await wait(300)

  // 1) 本人从QQ发一条 → 建故事+参与者
  qqIncoming(bot, OWNER, '在吗', 'qq-1')
  await until(() => sent.length >= 1, 15000, 'reply to qq message')
  const entriesQQ = await app.database.get('interlude_script_entry', { kind: 'user-message' })
  assert.equal(entriesQQ.length, 1)
  const pid = entriesQQ[0].participantId, sid = entriesQQ[0].storyId

  // 2) 桌面连接
  const ws = new WebSocket('ws://127.0.0.1:15150')
  const inbox = []
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))))
  await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN, since: 0 }))
  const hist = await until(() => inbox.find(m => m.type === 'history'), 3000, 'history')
  assert.ok(hist.items.some(i => i.role === 'user' && i.source === 'qq'), '历史含QQ来的本人消息')
  assert.ok(hist.items.some(i => i.role === 'atri'), '历史含Atri回复')

  // 3) 桌面说话 → 同一故事、同一参与者；回复发到QQ并镜像
  ws.send(JSON.stringify({ type: 'say', text: '我在桌面上 <img src="x">', cid: 'c1' }))
  const ack = await until(() => inbox.find(m => m.type === 'ack' && m.cid === 'c1'), 3000, 'ack')
  assert.equal(ack.ok, true)
  await until(() => sent.length >= 2, 15000, 'reply to desk message')
  const entries = await app.database.get('interlude_script_entry', { kind: 'user-message' })
  assert.equal(entries.length, 2)
  const desk = entries.find(e => String(e.metadata.messageId).startsWith('atridesk-'))
  assert.ok(desk, '桌面消息写入剧本')
  assert.equal(desk.participantId, pid, '同一参与者')
  assert.equal(desk.storyId, sid, '同一故事')
  assert.ok(desk.content.includes('<img src="x">') || desk.content.includes('我在桌面上'), '文字按原样，不被解析成图片')
  assert.equal((await app.database.get('interlude_participant', {})).length, 1, '没有新建参与者')
  assert.equal((await app.database.get('interlude_story', { status: 'active' })).length, 1, '只有一个活动故事')
  assert.equal(sent[1].channelId, 'private:' + OWNER, '回复发到本人QQ私聊')
  const mirrored = await until(() => inbox.filter(m => m.type === 'msg' && m.item.role === 'atri').length >= 1, 3000, 'mirror')
  const deskEcho = inbox.find(m => m.type === 'msg' && m.item.source === 'desk')
  assert.ok(deskEcho, '桌面消息也进入镜像')
  const note = (r) => (r.recentEntries || []).find(e => e.actor === 'atri-core-extension' && String(e.content).includes('atri-desktop'))
  assert.ok(!note(requests[0]), 'QQ消息不带桌面来源资料')
  assert.ok(note(requests[1]) && note(requests[1]).content.includes('桌面窗口'), '桌面消息经core扩展带来源资料')
  assert.ok(app.atriCore.runtime.extensions.status().some(p => p.owner === 'atri-desktop' && p.notesOffered === 1), 'core扩展状态登记')

  // 3b) before-send 之后取最终内容：照片标记→图片内联；被取消的不镜像
  const k0 = inbox.length
  await bot.sendMessage('private:' + OWNER, '〔照片#1〕')
  const photo = await until(() => inbox.slice(k0).find(m => m.type === 'msg' && m.item.role === 'atri'), 3000, 'photo mirror')
  assert.equal(photo.item.parts[0].t, 'image'); assert.ok(photo.item.parts[0].src.startsWith('data:image/png;base64,'), '相册图片内联')
  assert.ok(!JSON.stringify(photo.item).includes('〔照片'), '不显示照片标记')
  const k1 = inbox.length, s0 = sent.length
  const rc = await bot.sendMessage('private:' + OWNER, '〔取消〕')
  await wait(200)
  assert.equal(rc.length, 0); assert.equal(sent.length, s0)
  assert.ok(!inbox.slice(k1).some(m => m.type === 'msg'), '被 before-send 取消的不镜像')

  // 3c) /adesk 本人私聊状态（前置中间件，不进HDS）
  const r0 = requests.length
  qqIncoming(bot, OWNER, '/adesk', 'qq-adesk')
  await until(() => sent.some(x => x.elements.includes('atri-desktop 0.3.0')), 3000, 'adesk')
  assert.ok(sent.find(x => x.elements.includes('atri-desktop 0.3.0')).elements.includes('core扩展：已登记'))
  await wait(300); assert.equal(requests.length, r0, '/adesk 不交给HDS')

  // Observation protocol: only text, no story writes or synthetic user speech.
  const control = async(payload, cid) => {
    ws.send(JSON.stringify({...payload,cid}))
    return until(()=>inbox.find(m=>m.type==='ack'&&m.cid===cid),3000,'observation ack')
  }
  const obsSession='12345678-abcd-1234-5678-123456789abc'
  assert.equal((await control({type:'observation-start',sessionId:obsSession},'os1')).ok,true)
  assert.equal((await control({type:'observe',sessionId:obsSession,seq:1,text:'OBS-ONLY-1：格1有一扇门，字幕不清。',coverage:'会话0–15秒；抽样6格；无声音'},'ob1')).ok,true)
  assert.equal((await control({type:'observe',sessionId:obsSession,seq:1,text:'duplicate',coverage:'x'},'ob2')).error,'duplicate-or-stale')
  const q0=requests.length, sObs=sent.length
  qqIncoming(bot,OWNER,'刚才你看清楚了吗','qq-observe')
  await until(()=>requests.length>q0 && sent.length>sObs,15000,'HDS reads observation')
  assert.ok(requests[q0].recentEntries.some(e=>e.actor==='atri-core-extension' && e.content.includes('OBS-ONLY-1')), 'observation through core context')
  assert.equal((await control({type:'observation-stop'},'os2')).ok,true)
  const q1=requests.length, sStop=sent.length
  qqIncoming(bot,OWNER,'现在停止观察了','qq-observe-stop')
  await until(()=>requests.length>q1 && sent.length>sStop,15000,'stop observation')
  assert.ok(!requests[q1].recentEntries.some(e=>e.actor==='atri-core-extension' && e.content.includes('OBS-ONLY-1')), 'stopped evidence absent')
  assert.ok(!inbox.some(m=>m.type==='msg' && JSON.stringify(m.item).includes('OBS-ONLY-1')), 'observation not in chat mirror history')

  // 4) 指向桌面消息的引用在发QQ前被去掉
  await bot.sendMessage('private:' + OWNER, [h('quote', { id: desk.metadata.messageId }), '嗯嗯'])
  assert.ok(!sent[sent.length - 1].elements.includes('quote'), '去掉了桌面引用')
  const before = sent.length
  const r = await bot.sendMessage('private:' + OWNER, [h('quote', { id: desk.metadata.messageId }), '\u200b'])
  assert.equal(r.length, 0); assert.equal(sent.length, before, '只剩桌面引用的空消息不发')
  // 真实QQ引用保留
  await bot.sendMessage('private:' + OWNER, [h('quote', { id: 'qq-1' }), '好'])
  assert.ok(sent[sent.length - 1].elements.includes('quote'), 'QQ引用保留')

  // 5) 别人的私聊不镜像；发给别人的不镜像
  const n = inbox.length
  qqIncoming(bot, OTHER, '我是别人', 'qq-o1')
  await bot.sendMessage('private:' + OTHER, '给别人')
  await wait(500)
  assert.ok(!inbox.slice(n).some(m => m.type === 'msg' && JSON.stringify(m.item).includes('别人')), '不镜像他人')

  // 6) 发送失败不镜像为成功
  const n2 = inbox.length
  bot.failNext = true
  await assert.rejects(bot.sendMessage('private:' + OWNER, '失败的消息'))
  await wait(200)
  assert.ok(!inbox.slice(n2).some(m => m.type === 'msg' && JSON.stringify(m.item).includes('失败的消息')))

  // 7) 认证失败、过快、过长
  const bad = new WebSocket('ws://127.0.0.1:15150')
  const closeCode = await new Promise(r => { bad.on('open', () => bad.send(JSON.stringify({ type: 'hello', token: 'wrong' }))); bad.on('close', (c) => r(c)) })
  assert.equal(closeCode, 4003)
  const malformed = new WebSocket('ws://127.0.0.1:15150')
  const malformedCode = await new Promise(r => { malformed.on('open', () => malformed.send('null')); malformed.on('close', c => r(c)) })
  assert.equal(malformedCode, 4002, 'JSON null rejected without crashing')
  ws.send(JSON.stringify({ type: 'say', text: 'a', cid: 'c2' })); ws.send(JSON.stringify({ type: 'say', text: 'b', cid: 'c3' }))
  const a3 = await until(() => inbox.find(m => m.type === 'ack' && m.cid === 'c3'), 3000, 'ack3')
  assert.equal(a3.error, 'too-fast')
  await wait(900)
  ws.send(JSON.stringify({ type: 'say', text: 'x'.repeat(3000), cid: 'c4' }))
  assert.equal((await until(() => inbox.find(m => m.type === 'ack' && m.cid === 'c4'), 3000)).error, 'too-long')

  // 8) 重连补齐：since=上次序号只拿新消息
  const lastSeq = Math.max(...inbox.filter(m => m.type === 'msg').map(m => m.item.seq))
  ws.close(); await wait(200)
  const ws2 = new WebSocket('ws://127.0.0.1:15150'); const in2 = []
  ws2.on('message', d => in2.push(JSON.parse(String(d)))); await new Promise(r => ws2.on('open', r))
  ws2.send(JSON.stringify({ type: 'hello', token: TOKEN, since: lastSeq - 1 }))
  const h2 = await until(() => in2.find(m => m.type === 'history'), 3000)
  assert.equal(h2.items.length, 1)
  ws2.close()

  // 9) 卸载后恢复原 createMessage
  const histFile = fs.readFileSync(path.join(app.baseDir || process.cwd(), 'data/atri-desktop/history.jsonl'), 'utf8')
  assert.ok(histFile.includes('我在桌面上'))
  assert.equal((fs.statSync(path.join(app.baseDir || process.cwd(), 'data/atri-desktop/history.jsonl')).mode & 0o777), 0o600)
  deskFork.dispose(); assert.ok(!Object.prototype.hasOwnProperty.call(bot, 'createMessage'), '卸载后恢复原发送函数')
  assert.ok(!app.atriCore.runtime.owners.has('atri-desktop'), '卸载后从core注销')
  await app.stop()
  console.log('E2E OK: requests=%d sent=%d', requests.length, sent.length)
  process.exit(0)
})().catch(e => { console.error('E2E FAIL', e); process.exit(1) })
process.on('exit',()=>require('fs').rmSync(require('path').join(__dirname,'data'),{recursive:true,force:true}))
