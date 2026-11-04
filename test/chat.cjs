'use strict'
// 桌面聊天（0.5）：拉历史、长轮询收新的、探测马上应答、发送（不自动重发、同一编号重试不重复）、本地存 500 条
const assert = require('node:assert/strict')
const { ChatService, merge, KEEP } = require('../app/src/chat-service')
const tick = () => new Promise((r) => setImmediate(r))

;(async () => {
  // 合并：按 seq 去重排序；本地待发的放最后
  const m = merge([{ seq: 2, text: 'b' }, { clientId: 'c-1', text: '待发' }], [{ seq: 1, text: 'a' }, { seq: 2, text: 'b2' }])
  assert.deepEqual(m.map((x) => x.text), ['a', 'b2', '待发'])
  assert.equal(merge(Array.from({ length: 600 }, (_, i) => ({ seq: i + 1 })), []).length, KEEP)

  let saved = null
  const queue = []
  let connected = true
  const acks = []
  const says = []
  let sayResult = { ok: true, seq: 10 }
  const desk = {
    history: async () => ({ ok: true, items: [{ seq: 5, who: 'me', via: 'qq', text: '早', at: 1 }, { seq: 6, who: 'atri', via: 'qq', text: '嗯', bubbles: ['嗯'], at: 2 }] }),
    events: async (after) => {
      while (!queue.length) { if (!connected) return { ok: false }; await tick() }
      const r = queue.shift()
      return { ok: true, items: (r.items || []).filter((x) => x.seq > after), thinking: !!r.thinking, ping: r.ping || null }
    },
    ack: async (p) => acks.push(p),
    say: async (x) => { says.push(x); if (sayResult instanceof Error) throw sayResult; return sayResult },
  }
  const s = new ChatService({ desk: () => desk, ready: () => connected, load: () => [{ clientId: 'c-old', who: 'me', text: '上次没确认的', state: 'sending' }], save: (x) => (saved = x), sleep: tick })
  assert.equal(s.items[0].state, 'failed', '上次程序关了没确认送到的：标没送到，不重发')
  const atri = []
  const thinking = []
  s.on('atri', (x) => atri.push(x.text))
  s.on('thinking', (t) => thinking.push(t))
  const loop = s.start()
  await tick(); await tick()
  assert.deepEqual(s.items.filter((x) => x.seq).map((x) => x.seq), [5, 6], '先拉历史')
  assert.deepEqual(atri, [], '历史里的不弹提示')
  queue.push({ thinking: true })
  queue.push({ ping: 'p-1', items: [{ seq: 7, who: 'atri', via: 'desk', text: '在呢', bubbles: ['在呢'], mood: 'happy', at: 3 }] })
  for (let i = 0; i < 10; i++) await tick()
  assert.deepEqual(thinking, [true, false])
  assert.deepEqual(acks, ['p-1'], '探测马上应答')
  assert.deepEqual(atri, ['在呢'], '她的新消息弹提示')

  // 发送：送到了有 seq；结果不明只标“没送到”，不自动重发；手动重发用同一个编号
  const ok = await s.say('看这个', [{ mime: 'image/jpeg', data: 'AAAA', thumb: 'data:image/jpeg;base64,AA' }])
  assert.deepEqual([ok.state, ok.seq, ok.thumbs.length], ['sent', 10, 1])
  assert.deepEqual(says[0].images, [{ mime: 'image/jpeg', data: 'AAAA' }], '交给 Atri 的没有缩略图')
  sayResult = new Error('超时')
  const bad = await s.say('第二句')
  assert.equal(bad.state, 'failed')
  assert.equal(says.length, 2, '失败不自动重发')
  sayResult = { ok: true, seq: 11 }
  const again = await s.say('第二句', [], bad.clientId)
  assert.equal(again, bad, '同一条')
  assert.equal(says.at(-1).clientId, bad.clientId, '用同一个编号，服务器那边不会重复')
  assert.equal(again.state, 'sent')
  // 没连上不发
  connected = false
  const off = await s.say('断了')
  assert.match(off.error, /没连上/)
  await new Promise((r) => setTimeout(r, 400))
  assert.ok(saved && saved.some((x) => x.text === '在呢'), '本地存了')
  s.stop()
  queue.push({})
  await loop
  console.log('CHAT OK: history, long-poll, ping ack, notify only new, send/no auto-resend/same id, local store')
})().catch((e) => { console.error(e); process.exit(1) })
