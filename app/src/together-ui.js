'use strict'
// 一起看番（0.4）观看窗口：截选定窗口 → 挑帧 → 拼图、字幕条、角色参考图 → 交给主进程去看、交给 Atri
const $ = (id) => document.getElementById(id)
const F = window.AtriFrames
const CELL_W = 480
const CELL_H = 270
const LABEL_H = 24
const CAP_W = 1280
const CAP_H = 720
const STRIP_FROM = 0.78

let sources = []
let run = null // 这一场的状态
let spent = 0
let calls = 0

const err = (e) => { $('error').textContent = e ? (e.message || String(e)) : '' }
const settingIds = ['visionBase', 'visionModel', 'extraBody', 'priceIn', 'priceOut', 'hearingBase', 'hearingModel', 'hearPriceIn', 'hearPriceOut', 'asrBase', 'asrModel']

function lock(on) {
  ;['source', 'refresh', 'title', 'episode', 'startMin', 'mode', 'fps', 'strip', 'castRef', 'hearingMode'].forEach((id) => ($(id).disabled = on))
  $('start').disabled = on
  $('stop').disabled = !on
  $('badge').textContent = on ? '一起看着' : '未开始'
}

async function init() {
  try {
    const r = await atri.together('init')
    const s = r.settings
    for (const id of settingIds) $(id).value = s[id] ?? ''
    $('mode').value = s.mode
    $('fps').value = String(s.fps)
    $('strip').checked = s.strip
    $('castRef').checked = s.castRef
    $('hearingMode').value = s.hearingMode
    $('hearingKey').placeholder = s.hasHearingKey ? '已保存（要改才填）' : '只存在这台电脑上（系统加密）'
    $('key').placeholder = s.hasKey ? '已保存（要改才填）' : '只存在这台电脑上（系统加密）'
  } catch (e) { err(e) }
  refresh()
  hello(true)
}

async function hello(quiet) {
  try {
    const h = await atri.together('hello')
    if (!h.ok) throw new Error(h.error || '连不上')
    $('watchlist').replaceChildren(...(h.watchlist || []).map((t) => new Option(t)))
    if (!quiet) $('saveMsg').textContent = '连上了 Atri'
  } catch (e) { if (!quiet) $('saveMsg').textContent = '连不上 Atri：' + (e.message || e) }
}

async function refresh() {
  try {
    sources = await atri.together('sources')
    $('source').replaceChildren(new Option('请选择窗口', ''), ...sources.map((s) => new Option((s.kind === 'screen' ? '[整个屏幕] ' : '[窗口] ') + s.name, s.id)))
    $('sourcePreview').hidden = true
  } catch (e) { err(e) }
}

/** 窗口标题 → 猜的番名（去掉播放器名、集数、扩展名），只当默认值让你确认 */
function guessTitle(name) {
  return String(name || '')
    .replace(/\.(mp4|mkv|avi|flv|webm)$/i, '')
    .replace(/[-_—|·]\s*(哔哩哔哩|bilibili|腾讯视频|爱奇艺|优酷|PotPlayer|VLC.*|mpv|MPC.*|弹弹play).*$/i, '')
    .replace(/第\s*\d+\s*[集话話].*$/, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim()
    .slice(0, 40)
}

$('refresh').onclick = refresh
$('source').onchange = () => {
  const s = sources.find((x) => x.id === $('source').value)
  $('sourcePreview').hidden = !s
  if (s) $('sourcePreview').src = s.preview
  if (s && !$('title').value.trim()) $('title').value = guessTitle(s.name)
  const ep = s && /第\s*(\d+)\s*[集话話]/.exec(s.name)
  if (ep && !$('episode').value.trim()) $('episode').value = ep[1]
}
$('save').onclick = async () => {
  try {
    const x = { mode: $('mode').value, fps: Number($('fps').value), strip: $('strip').checked, castRef: $('castRef').checked, hearingMode: $('hearingMode').value }
    for (const id of settingIds) x[id] = $(id).value
    if ($('key').value) x.key = $('key').value
    if ($('hearingKey').value) x.hearingKey = $('hearingKey').value
    await atri.together('save', x)
    $('key').value = ''
    $('hearingKey').value = ''
    $('saveMsg').textContent = '保存了'
    await init()
  } catch (e) { $('saveMsg').textContent = e.message || String(e) }
}
$('hello').onclick = () => hello(false)

function drawLabel(ctx, x, y, w, h, text) {
  ctx.fillStyle = '#101010'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 15px system-ui, "Microsoft YaHei UI", sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + 6, y + h / 2)
}

async function jpeg(canvas, q = 0.85) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q))
  return new Uint8Array(await blob.arrayBuffer())
}

/** 拼图：最多 12 格、3 列，每格下面标“#序号 时间” */
function sheet(cells) {
  const cols = Math.min(3, cells.length)
  const rows = Math.ceil(cells.length / cols)
  const c = document.createElement('canvas')
  c.width = cols * CELL_W + (cols - 1) * 4
  c.height = rows * (CELL_H + LABEL_H) + (rows - 1) * 4
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#303030'
  ctx.fillRect(0, 0, c.width, c.height)
  cells.forEach((x, i) => {
    const ox = (i % cols) * (CELL_W + 4)
    const oy = Math.floor(i / cols) * (CELL_H + LABEL_H + 4)
    ctx.drawImage(x.bmp, ox, oy, CELL_W, CELL_H)
    drawLabel(ctx, ox, oy + CELL_H, CELL_W, LABEL_H, `#${x.n}  ${F.clock(x.t)}`)
  })
  return c
}

/** 字幕条：挑最多 6 格（切点、稳定下来的优先），截底部原分辨率 */
function strip(cells) {
  const pick = cells.filter((x) => x.via !== 'motion' && x.via !== 'floor').slice(-6)
  if (pick.length === 0) return null
  const sh = Math.round(CAP_H * (1 - STRIP_FROM))
  const w = 960
  const h = Math.round((sh * w) / CAP_W)
  const c = document.createElement('canvas')
  c.width = w + 48
  c.height = pick.length * (h + 4)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#101010'
  ctx.fillRect(0, 0, c.width, c.height)
  pick.forEach((x, i) => {
    ctx.drawImage(x.bmp, 0, CAP_H * STRIP_FROM, CAP_W, sh, 48, i * (h + 4), w, h)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 15px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText('#' + x.n, 6, i * (h + 4) + h / 2)
  })
  return c
}

/** 角色参考图：头像 4 个一行，下面写“编号 名字” */
async function castSheet(cast) {
  const withImg = cast.filter((m) => m.img).slice(0, 8)
  if (withImg.length === 0) return null
  const S = 150
  const cols = Math.min(4, withImg.length)
  const rows = Math.ceil(withImg.length / cols)
  const c = document.createElement('canvas')
  c.width = cols * S
  c.height = rows * (S + LABEL_H)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#303030'
  ctx.fillRect(0, 0, c.width, c.height)
  for (let i = 0; i < withImg.length; i++) {
    const m = withImg[i]
    try {
      const img = new Image()
      img.src = m.img
      await img.decode()
      const k = Math.min(S / img.naturalWidth, S / img.naturalHeight)
      const w = img.naturalWidth * k
      const h = img.naturalHeight * k
      ctx.drawImage(img, (i % cols) * S + (S - w) / 2, Math.floor(i / cols) * (S + LABEL_H) + (S - h) / 2, w, h)
    } catch {}
    drawLabel(ctx, (i % cols) * S, Math.floor(i / cols) * (S + LABEL_H) + S, S, LABEL_H, `${m.n} ${m.name}`.slice(0, 10))
  }
  return { canvas: c, members: withImg }
}

async function startRun() {
  err()
  const source = sources.find((s) => s.id === $('source').value)
  if (!source) throw new Error('先选一个窗口')
  if (source.kind === 'screen' && !confirm('会一直截整个屏幕，可能包含别的程序和私密内容。确定吗？')) return
  const title = $('title').value.trim()
  if (!title && !confirm('没填番名：Atri 不知道看的是什么，也查不了角色表。照样开始吗？')) return
  const startSec = Math.max(0, Number($('startMin').value) || 0) * 60
  const hearing = $('hearingMode').value
  await atri.together('save', { mode: $('mode').value, fps: Number($('fps').value), strip: $('strip').checked, castRef: $('castRef').checked, hearingMode: hearing })
  const r = await atri.together('start', { sourceId: source.id, title, episode: $('episode').value.trim(), startSec })
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: CAP_W, height: CAP_H, frameRate: 10 }, audio: hearing !== 'off' })
  const video = $('video')
  video.srcObject = stream
  await video.play()
  const cast = $('castRef').checked ? await castSheet(r.cast) : null
  const fps = Number($('fps').value)
  run = {
    id: r.sessionId,
    prompt: r.prompt,
    title,
    episode: $('episode').value.trim(),
    stream,
    cast,
    names: r.cast.map((m) => m.name),
    stripOn: $('strip').checked,
    hearing,
    audio: null,
    sel: new F.Selector(),
    batcher: new F.Batcher({ mode: $('mode').value }),
    small: Object.assign(document.createElement('canvas'), { width: F.SCAN_W, height: F.SCAN_H }),
    prevGrid: null,
    pending: null,
    i: 0,
    n: 0,
    seq: 0,
    playSec: startSec,
    lastTick: performance.now(),
    prev: '',
    timer: setInterval(tick, Math.round(1000 / fps)),
  }
  stream.getVideoTracks()[0].onended = () => { void stopRun('窗口关了或截不到了') }
  if (hearing !== 'off') {
    if (stream.getAudioTracks().length) run.audio = startAudio(stream)
    else err('没录到电脑的声音（只在 Windows 上能录系统声音），这次只看画面')
  }
  lock(true)
  $('reports').replaceChildren()
  $('empty').hidden = false
  $('state').textContent = `开始了：${title ? '《' + title + '》' : ''}${run.episode ? ' 第 ' + run.episode + ' 集' : ''}${cast ? `，角色参考 ${cast.members.length} 个` : ''}`
}

/** 电脑正在播放的声音 → 16kHz 单声道 PCM 片段，最多留 40 秒 */
function startAudio(stream) {
  const ctx = new AudioContext({ sampleRate: 16000 })
  const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const a = { ctx, src, proc, chunks: [] }
  proc.onaudioprocess = (e) => {
    const f = e.inputBuffer.getChannelData(0)
    const out = new Int16Array(f.length)
    for (let i = 0; i < f.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, f[i])) * 32767)
    a.chunks.push(out)
    if (a.chunks.length > 160) a.chunks.shift()
  }
  src.connect(proc)
  // 接到一个静音的出口上（不然不跑），不会把声音再放一遍
  const mute = ctx.createGain()
  mute.gain.value = 0
  proc.connect(mute)
  mute.connect(ctx.destination)
  return a
}

/** 这一段的声音：没录 → none；太安静 → silent；否则 WAV（最多 30 秒） */
function takeAudio(R) {
  if (R.hearing === 'off') return { audio: 'off' }
  if (!R.audio) return { audio: 'none' }
  const chunks = R.audio.chunks.splice(0)
  const keep = chunks.slice(-Math.ceil((30 * 16000) / 4096))
  if (keep.length === 0 || F.rms(keep) < 0.004) return { audio: 'silent' }
  return { audio: 'yes', wav: F.wav16(keep) }
}

async function tick() {
  const R = run
  if (!R || R.ticking) return
  R.ticking = true
  try {
    await frame(R)
  } finally {
    R.ticking = false
  }
}

async function frame(R) {
  const video = $('video')
  if (video.readyState < 2) return
  const now = performance.now()
  const dt = (now - R.lastTick) / 1000
  R.lastTick = now
  if (!R.batcher.paused) R.playSec += dt
  const ctx = R.small.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(video, 0, 0, F.SCAN_W, F.SCAN_H)
  const grid = F.gridHsv(ctx.getImageData(0, 0, F.SCAN_W, F.SCAN_H).data)
  const s = R.prevGrid ? { g: F.scorePair(R.prevGrid, grid), b: F.blockMax(R.prevGrid, grid) } : { g: 0, b: 0 }
  R.prevGrid = grid
  if (R.batcher.frame(now, R.sel.moving(s))) {
    void atri.together('pause', R.batcher.paused).catch(() => {})
    $('state').textContent = R.batcher.paused ? '暂停了（画面十几秒没动）' : '接着看'
  }
  let bmp = null
  try { bmp = await createImageBitmap(video, { resizeWidth: CAP_W, resizeHeight: CAP_H }) } catch { return }
  if (run !== R) { bmp.close(); return }
  // 多看一帧确认是不是切点：决定的是上一帧
  if (R.pending) {
    const p = R.pending
    const pick = R.sel.push(p.i, p.t, p.s, s.g)
    if (pick) R.batcher.add({ t: p.play, via: pick.via, bmp: p.bmp })
    else p.bmp.close()
  }
  R.pending = { i: R.i, t: R.i / Number($('fps').value), s, bmp, play: R.playSec }
  R.i++
  const batch = R.batcher.take(now)
  if (batch) void submit(R, batch)
}

async function submit(R, batch) {
  try {
    const cells = batch.map((x) => ({ ...x, n: ++R.n }))
    const images = [await jpeg(sheet(cells))]
    const st = R.stripOn ? strip(cells) : null
    if (st) images.push(await jpeg(st, 0.9))
    if (R.cast) images.push(await jpeg(R.cast.canvas, 0.85))
    const from = cells[0].t
    const to = Math.max(cells.at(-1).t, from + 1)
    const prompt = F.buildPrompt({ title: R.title, episode: R.episode, from, to, cells, strip: !!st, cast: R.cast ? R.cast.members : null, names: R.names, prev: R.prev, format: R.prompt.format, heardSlot: R.hearing !== 'off' })
    const sound = takeAudio(R)
    const seq = ++R.seq
    const preview = URL.createObjectURL(new Blob([images[0]], { type: 'image/jpeg' }))
    for (const x of batch) x.bmp.close()
    const r = await atri.together('analyse', { sessionId: R.id, seq, from, to, images, prompt, audio: sound.audio, ...(sound.wav ? { wav: sound.wav } : {}) })
    if (run !== R) return
    if (r.usage) { spent += F.cost(r.usage, { in: Number($('priceIn').value), out: Number($('priceOut').value) }); calls++ }
    if (r.hearingUsage) spent += F.cost(r.hearingUsage, { in: Number($('hearPriceIn').value), out: Number($('hearPriceOut').value) })
    $('cost').textContent = `看了 ${calls} 次 · 约 ¥${spent.toFixed(3)}`
    if (r.data) R.prev = F.prevLine(r.data)
    show(preview, from, to, r)
  } catch (e) {
    err(e)
  } finally {
    R.batcher.done()
  }
}

function show(preview, from, to, r) {
  $('empty').hidden = true
  const a = document.createElement('article')
  a.className = 'report'
  const meta = document.createElement('div')
  meta.className = 'meta'
  const tok = r.usage ? ` · ${r.usage.promptTokens}+${r.usage.completionTokens} token` : ''
  meta.textContent = `${F.clock(from)}–${F.clock(to)} · ${r.ok ? (r.delivered ? '交给 Atri 了' + (r.speak ? '，她想说点什么' : '') : '没交成：' + (r.deliveryError || '')) : '没看成：' + (r.error || '')}${tok}`
  const img = document.createElement('img')
  img.src = preview
  img.alt = '这一段的拼图（只在内存里）'
  const p = document.createElement('p')
  const d = r.data
  p.textContent = d ? [d.scene, ...(d.events || []).map((e) => `${e.t || ''} ${e.text || ''}`), (d.subtitles || []).length ? '字幕：' + d.subtitles.join(' / ') : '', d.salience ? `值不值得说：${d.salience.level}${d.salience.note ? '（' + d.salience.note + '）' : ''}` : ''].filter(Boolean).join('\n') : r.text || ''
  const snd = document.createElement('p')
  snd.className = 'meta'
  const sd = r.sound || { state: 'none' }
  snd.textContent = sd.state === 'heard' ? '听到：' + sd.text : sd.state === 'silent' ? '这段没听到台词（或太安静，没去听）' : sd.state === 'failed' ? '声音没听成' + (r.soundError ? '：' + r.soundError : '') : '没有声音'
  a.append(meta, img, p, snd)
  $('reports').prepend(a)
  while ($('reports').children.length > 6) {
    const old = $('reports').lastChild.querySelector('img')
    if (old) URL.revokeObjectURL(old.src)
    $('reports').lastChild.remove()
  }
}

async function stopRun(why) {
  const R = run
  run = null
  if (R) {
    clearInterval(R.timer)
    R.stream.getTracks().forEach((t) => t.stop())
    R.pending?.bmp.close()
    if (R.audio) { try { R.audio.proc.disconnect(); R.audio.src.disconnect(); void R.audio.ctx.close() } catch {} }
    for (const x of R.batcher.pending) x.bmp.close()
    $('video').srcObject = null
  }
  await atri.together('stop').catch(() => {})
  lock(false)
  $('state').textContent = why ? '停了：' + why : '停了。Atri 那边会把这一集整理成她的经历。'
}

$('start').onclick = async () => {
  $('start').disabled = true
  try { await startRun() } catch (e) { err(e); await stopRun('') } finally { if (!run) lock(false) }
}
$('stop').onclick = () => stopRun('')
window.addEventListener('beforeunload', () => { if (run) void stopRun('') })
init()
