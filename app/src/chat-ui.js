'use strict'
const $ = (id) => document.getElementById(id)
const MOOD = { calm: '平静', happy: '开心', curious: '好奇', focused: '专注', proud: '得意', stubborn: '嘴硬', annoyed: '烦躁', sulk: '生闷气', hurt: '委屈', shy: '害羞', tired: '疲惫', lonely: '孤单', hyper: '上头', coy: '撒娇' }
const VIA = { qq: 'QQ', desk: '桌面', test: '控制台' }
let items = []
let attachments = [] // {mime, data, thumb, sticker}
const stickerUrl = new Map()

const time = (t) => { const d = new Date(t); const now = new Date(); const hm = d.toTimeString().slice(0, 5); return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}` }

/** 文字里的网址变成能点的链接（系统浏览器打开）；其余都是纯文字 */
function textNode(el, text) {
  const parts = String(text).split(/(https?:\/\/[^\s<>"'，。！？）]+)/g)
  for (const p of parts) {
    if (/^https?:\/\//.test(p)) { const a = document.createElement('a'); a.href = p; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = p; el.append(a) }
    else if (p) el.append(document.createTextNode(p))
  }
}

async function stickerImg(id, desc) {
  const img = document.createElement('img')
  img.className = 'sticker'
  img.alt = desc ? `[表情包：${desc}]` : '[表情包]'
  img.title = desc || ''
  if (!stickerUrl.has(id)) stickerUrl.set(id, atri.chat('sticker', id).catch(() => null))
  const url = await stickerUrl.get(id)
  if (url) img.src = url
  else { const s = document.createElement('span'); s.className = 'meta'; s.textContent = img.alt; return s }
  return img
}

function render() {
  const list = $('list')
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80
  list.replaceChildren()
  for (const it of items) {
    const row = document.createElement('div')
    row.className = 'row ' + (it.who === 'me' ? 'me' : 'her')
    const col = document.createElement('div')
    col.className = 'col'
    if (it.who === 'atri') {
      const bubbles = it.bubbles && it.bubbles.length ? it.bubbles : it.text ? [it.text] : []
      const after = it.sticker ? Math.min(it.sticker.after ?? bubbles.length, bubbles.length) : -1
      const slot = () => { const ph = document.createElement('span'); ph.className = 'meta'; ph.textContent = '[表情包]'; void stickerImg(it.sticker.id, it.sticker.desc).then((n) => ph.replaceWith(n)); return ph }
      bubbles.forEach((b, i) => {
        if (i === after) col.append(slot())
        const m = document.createElement('div')
        m.className = 'msg'
        textNode(m, b)
        col.append(m)
      })
      if (it.sticker && after >= bubbles.length) col.append(slot())
    } else {
      for (const t of it.thumbs || []) { const im = document.createElement('img'); im.className = 'thumb'; im.src = t; col.append(im) }
      if (it.text) { const m = document.createElement('div'); m.className = 'msg'; textNode(m, it.text); col.append(m) }
    }
    const meta = document.createElement('div')
    meta.className = 'meta' + (it.state === 'failed' ? ' failed' : '')
    meta.textContent = it.state === 'sending' ? '发送中…' : it.state === 'failed' ? '没送到：' + (it.error || '') : time(it.at)
    if (it.state === 'failed') { const b = document.createElement('button'); b.className = 'tb'; b.textContent = '再发一次'; b.onclick = () => atri.chat('resend', it.clientId); meta.append(b) }
    if (it.via && it.via !== 'desk' && VIA[it.via]) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = VIA[it.via]; meta.append(t) }
    if (it.who === 'atri' && it.mood && MOOD[it.mood]) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = MOOD[it.mood]; meta.append(t) }
    if (it.who === 'atri' && it.initiative) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = it.initiative === 'together' ? '一起看时' : '她主动的'; meta.append(t) }
    col.append(meta)
    row.append(col)
    list.append(row)
  }
  if (atBottom) list.scrollTop = list.scrollHeight
}

function showConn(st) {
  const ok = st && st.ok
  $('conn').classList.toggle('on', !!ok)
  $('conn').textContent = st ? st.label + (st.error && !ok ? '：' + st.error : '') : '…'
  $('send').disabled = !ok
}

// ---------- 发图：长边缩到 1600、压成 JPEG（动图原样当表情包）；本地留 320 的缩略图 ----------
async function toImage(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('只收 jpg / png / gif / webp')
  const buf = new Uint8Array(await file.arrayBuffer())
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s) }
  const bmp = await createImageBitmap(file)
  const scaled = async (max, q) => {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k))
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', q)
  }
  const thumb = await scaled(320, 0.7)
  if (file.type === 'image/gif') {
    if (buf.length > 5 * 1024 * 1024) throw new Error('动图太大（最大 5MB）')
    return { mime: 'image/gif', data: b64(buf), thumb, sticker: true }
  }
  const big = await scaled(1600, 0.85)
  const data = big.slice(big.indexOf(',') + 1)
  if (data.length * 0.75 > 5 * 1024 * 1024) throw new Error('图片太大（最大 5MB）')
  return { mime: 'image/jpeg', data, thumb, sticker: false }
}
async function addFiles(files) {
  $('err').textContent = ''
  for (const f of files) {
    if (attachments.length >= 4) { $('err').textContent = '一次最多 4 张'; break }
    try { attachments.push(await toImage(f)) } catch (e) { $('err').textContent = e.message || String(e) }
  }
  drawChips()
}
function drawChips() {
  $('chips').replaceChildren(...attachments.map((a, i) => { const im = document.createElement('img'); im.src = a.thumb; im.title = '点一下去掉'; im.onclick = () => { attachments.splice(i, 1); drawChips() }; return im }))
}

async function send() {
  const text = $('input').value
  if (!text.trim() && attachments.length === 0) return
  const imgs = attachments
  $('input').value = ''
  attachments = []
  drawChips()
  $('err').textContent = ''
  try { await atri.chat('say', { text, images: imgs }) } catch (e) { $('err').textContent = e.message || String(e) }
}

$('send').onclick = send
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send() } })
$('input').addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); void addFiles(fs) } })
$('attach').onclick = () => $('file').click()
$('file').onchange = () => { void addFiles([...$('file').files]); $('file').value = '' }
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag') })
document.addEventListener('dragleave', () => document.body.classList.remove('drag'))
document.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); void addFiles([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))) })
$('conn').onclick = () => atri.open('connect')
$('together').onclick = () => atri.open('together')

// ---------- 设置 ----------
function fillSettings(s) {
  $('scale').value = s.scale; $('opacity').value = s.opacity; $('bubbleSeconds').value = s.bubbleSeconds
  $('showPet').checked = s.showPet; $('notify').checked = s.notify; $('autostart').checked = s.autostart
  $('imgName').textContent = s.image ? s.image.split(/[\\/]/).pop() : '（没设）'
}
$('gear').onclick = () => { $('settings').hidden = !$('settings').hidden }
const save = (x) => atri.saveSettings(x).then(fillSettings).catch((e) => ($('err').textContent = e.message || String(e)))
$('pick').onclick = async () => { const p = await atri.pickImage(); if (p) save({ image: p }) }
$('clearImg').onclick = () => save({ image: '' })
for (const id of ['scale', 'opacity']) $(id).onchange = () => save({ [id]: Number($(id).value) })
$('bubbleSeconds').onchange = () => save({ bubbleSeconds: Number($('bubbleSeconds').value) })
for (const id of ['showPet', 'notify', 'autostart']) $(id).onchange = () => save({ [id]: $(id).checked })

atri.on('chat-items', (x) => { items = x; render() })
atri.on('chat-thinking', (t) => { $('thinking').textContent = t ? 'Atri 在想……' : '' })
atri.on('conn-state', showConn)
atri.on('settings', fillSettings)
atri.init().then((r) => fillSettings(r.settings))
atri.chat('init').then((r) => { items = r.items; render(); showConn(r.conn); $('thinking').textContent = r.thinking ? 'Atri 在想……' : ''; $('list').scrollTop = $('list').scrollHeight })
