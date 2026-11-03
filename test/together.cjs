'use strict'
// 一起看番（0.4）：挑帧、交图节奏、提示词、网络部分（本机假服务，不连真的看图线路和 Atri）
const assert = require('node:assert/strict')
const http = require('node:http')
const F = require('../app/src/frames-core')
const { atriBase, visionBase, DeskClient, askVision, fetchPortrait } = require('../app/src/together-net')

function solid(r, g, b) {
  const a = new Uint8ClampedArray(F.SCAN_W * F.SCAN_H * 4)
  for (let i = 0; i < F.SCAN_W * F.SCAN_H; i++) a.set([r, g, b, 255], i * 4)
  return a
}

;(async () => {
  // 分块：底部一块变了（像换了一句字幕），整屏平均被冲淡，分块看得出来
  const base = solid(30, 60, 90)
  const sub = new Uint8ClampedArray(base)
  for (let y = 32; y < 34; y++) for (let x = 20; x < 44; x++) sub.set([255, 255, 255, 255], (y * F.SCAN_W + x) * 4)
  const a = F.gridHsv(base)
  const b = F.gridHsv(sub)
  assert.equal(F.blockMax(a, a), 0)
  assert.ok(F.scorePair(a, b) < F.DEFAULT_SELECT.cutAbs, '整屏平均不到切点：' + F.scorePair(a, b))
  assert.ok(F.blockMax(a, b) > 24, 'block ' + F.blockMax(a, b))

  // 挑帧：和服务器同一套（切点、稳定帧、一直在动、兜底；底噪不触发）
  const sc = (g, bb = g) => ({ g, b: bb })
  const fps = 2
  const series = [sc(0), ...Array(19).fill(sc(0.2, 0.5)), sc(50, 80), ...Array(9).fill(sc(0.2, 0.5)), sc(1, 40), ...Array(10).fill(sc(0.2, 0.5)), ...Array(20).fill(sc(4, 30)), ...Array(140).fill(sc(0.1, 0.5))]
  const sel = new F.Selector()
  const picked = []
  series.forEach((s, i) => { const p = sel.push(i, i / fps, s, (series[i + 1] || { g: 0 }).g); if (p) picked.push(p.via + '@' + p.t) })
  assert.equal(picked[0], 'first@0')
  assert.ok(picked.includes('cut@10'), picked.join(' '))
  assert.ok(picked.includes('settle@15.5') && !picked.includes('settle@15'))
  assert.ok(picked.filter((x) => x.startsWith('motion')).length >= 2)
  assert.ok(picked.some((x) => x.startsWith('floor')))
  const quiet = new F.Selector()
  const qv = []
  for (let i = 0; i < 100; i++) { const p = quiet.push(i, i / fps, sc(0.3, 1.2), 0.3); if (p) qv.push(p.via) }
  assert.deepEqual([...new Set(qv)].sort(), ['first', 'floor'], '只有底噪就只有兜底')
  assert.equal(quiet.moving(sc(0.3, 1.2)), false)
  assert.equal(quiet.moving(sc(30, 40)), true)
  assert.equal(F.capPicked([...Array(5)].map((_, i) => ({ via: 'cut', t: i })).concat([...Array(20)].map((_, i) => ({ via: 'motion', t: i + 0.5 }))), 8).filter((x) => x.via === 'cut').length, 5)

  // 交图节奏
  const iv = new F.Batcher({ mode: 'interval' })
  iv.frame(0, true)
  iv.add({ t: 1 })
  assert.equal(iv.take(1000), null, '10 秒没到不交')
  assert.equal(iv.take(10000).length, 1)
  iv.add({ t: 2 })
  assert.equal(iv.take(25000).length, 1)
  iv.add({ t: 3 })
  assert.equal(iv.take(40000), null, '已经两个在路上，等一个回来')
  iv.done()
  assert.equal(iv.take(40000).length, 1)
  const rt = new F.Batcher({ mode: 'realtime' })
  rt.frame(0, true)
  rt.add({ t: 1 }); rt.add({ t: 2 })
  assert.equal(rt.take(6000), null, '实时：两个新画面还不够')
  rt.add({ t: 3 })
  assert.equal(rt.take(6000).length, 3)
  rt.add({ t: 4 }); rt.add({ t: 5 }); rt.add({ t: 6 })
  assert.equal(rt.take(8000), null, '实时：最快 5 秒一次')
  assert.equal(rt.take(11000).length, 3)
  // 暂停：12 秒没动；暂停前攒下的先交掉，之后没东西就不交
  const ps = new F.Batcher({ mode: 'interval' })
  assert.equal(ps.frame(0, true), false)
  ps.add({ t: 1 })
  assert.equal(ps.frame(12500, false), true)
  assert.equal(ps.paused, true)
  assert.equal(ps.take(12500).length, 1)
  assert.equal(ps.take(30000), null)
  assert.equal(ps.frame(31000, true), true)
  assert.equal(ps.paused, false)
  const many = new F.Batcher({ mode: 'interval', maxCells: 12 })
  many.frame(0, true)
  for (let i = 0; i < 30; i++) many.add({ t: i, via: i % 3 ? 'motion' : 'settle' })
  assert.equal(many.take(10000).length, 12, '一次最多 12 格')

  // 提示词
  const prompt = F.buildPrompt({ title: '夏日重现', episode: '3', from: 61, to: 75, cells: [{ n: 4, t: 61 }, { n: 5, t: 70 }], strip: true, cast: [{ n: 1, name: '网代慎平', looks: '黑发' }], prev: '慎平跑出门', format: 'FORMAT' })
  assert.match(prompt, /《夏日重现》第 3 集，这是 01:01–01:15/)
  assert.match(prompt, /#4 01:01、#5 01:10/)
  assert.match(prompt, /图 2：.*字幕条/)
  assert.match(prompt, /图 3：角色参考图，编号对应：1=网代慎平（黑发）/)
  assert.match(prompt, /上一段（接着它写）：慎平跑出门\nFORMAT$/)
  assert.doesNotMatch(F.buildPrompt({ title: '', from: 0, to: 1, cells: [], format: 'F' }), /图 2/)
  assert.deepEqual(F.parseJson('好的：\n{"scene":"教室"}\n'), { scene: '教室' })
  assert.equal(F.parseJson('[1,2]'), null)
  assert.equal(F.parseJson('没有'), null)
  assert.equal(F.prevLine({ scene: '教室', events: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }), '教室；b；c')
  assert.equal(F.cost({ promptTokens: 1e6, completionTokens: 5e5 }, { in: 2, out: 8 }), 6)

  // 地址只认本机隧道口 / https
  for (const u of ['https://127.0.0.1:15160', 'http://localhost:15160', 'http://192.168.1.2:15160', 'http://127.0.0.1:15160/x', 'http://u:p@127.0.0.1:1']) assert.throws(() => atriBase(u), u)
  assert.equal(atriBase('http://127.0.0.1:15160/'), 'http://127.0.0.1:15160')
  for (const u of ['http://api.deepseek.com', 'ftp://x', 'https://u:p@x.com', 'https://x.com/?a=1']) assert.throws(() => visionBase(u), u)
  assert.equal(visionBase('https://api.deepseek.com/'), 'https://api.deepseek.com')
  assert.equal(visionBase('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1')
  await assert.rejects(fetchPortrait('https://evil.example/a.jpg'), /Bangumi/)
  await assert.rejects(fetchPortrait('http://lain.bgm.tv/a.jpg'), /Bangumi/)

  // 本机假服务：Atri 桌面入口 + 看图线路
  const seen = []
  let visionMode = 'fail-once'
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      seen.push({ url: req.url, auth: req.headers.authorization, body })
      res.setHeader('content-type', 'application/json')
      if (req.url.startsWith('/desk/')) {
        if (req.headers.authorization !== 'Bearer ' + 't'.repeat(32)) { res.statusCode = 401; return res.end('{"ok":false,"error":"口令不对"}') }
        if (req.url === '/desk/hello') return res.end(JSON.stringify({ ok: true, prompt: { system: 'S', format: 'F' }, watchlist: ['夏日重现'] }))
        if (req.url === '/desk/segment') return res.end(JSON.stringify({ ok: true, speak: true }))
        return res.end('{"ok":true}')
      }
      if (req.url === '/v1/chat/completions') {
        if (visionMode === 'fail-once') { visionMode = 'ok'; res.statusCode = 502; return res.end('{"error":"busy"}') }
        if (visionMode === 'empty') return res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }))
        return res.end(JSON.stringify({ choices: [{ message: { content: '{"scene":"教室"}' } }], usage: { prompt_tokens: 900, completion_tokens: 80 } }))
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const desk = new DeskClient({ base: 'http://127.0.0.1:' + port, token: 't'.repeat(32) })
    const h = await desk.hello()
    assert.deepEqual(h.watchlist, ['夏日重现'])
    const seg = await desk.segment({ sessionId: 's', seq: 1, from: 0, to: 10, data: { scene: '教室' } })
    assert.equal(seg.speak, true)
    assert.ok(!seen.at(-1).body.includes('base64'), '交给 Atri 的没有图')
    await assert.rejects(new DeskClient({ base: 'http://127.0.0.1:' + port, token: 'wrong' }).hello(), /口令不对/)

    const v = await askVision({ base: 'http://127.0.0.1:' + port + '/v1', model: 'm', key: 'k', system: 'S', prompt: 'P', images: [Buffer.from('jpeg')] })
    assert.equal(v.text, '{"scene":"教室"}')
    assert.deepEqual([v.usage.promptTokens, v.usage.completionTokens, v.usage.ok], [900, 80, true])
    const call = JSON.parse(seen.filter((x) => x.url === '/v1/chat/completions').at(-1).body)
    assert.equal(call.messages[0].content, 'S')
    assert.equal(call.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,' + Buffer.from('jpeg').toString('base64'))
    assert.equal(seen.filter((x) => x.url === '/v1/chat/completions').length, 2, '502 再试一次')
    assert.equal(seen.filter((x) => x.url === '/v1/chat/completions').at(-1).auth, 'Bearer k')
    visionMode = 'empty'
    await assert.rejects(askVision({ base: 'http://127.0.0.1:' + port + '/v1', model: 'm', key: 'k', system: 'S', prompt: 'P', images: [] }), /空的/)
    await assert.rejects(askVision({ base: 'http://127.0.0.1:' + port + '/v1', model: 'm', key: '', system: 'S', prompt: 'P', images: [] }), /密钥/)
  } finally {
    await new Promise((r) => server.close(r))
  }
  console.log('TOGETHER OK: frame selection, batching/pause, prompt, endpoints, vision/desk contracts')
})().catch((e) => { console.error(e); process.exit(1) })
