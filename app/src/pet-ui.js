'use strict'
// 立绘（普通图片）：她说话时冒气泡；在想的时候气泡里是“……”；双击或点气泡打开对话框；拖动挪位置
const stand = document.getElementById('stand')
const bubble = document.getElementById('bubble')
const dot = document.getElementById('dot')
const empty = document.getElementById('empty')
let cfg = { bubbleSeconds: 12 }
let hideTimer = null
const fileUrl = (p) => (p ? 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:') : '')
function apply(s) {
  cfg = s
  document.body.style.opacity = s.opacity
  if (s.image) { stand.src = fileUrl(s.image); stand.style.display = ''; empty.style.display = 'none' }
  else { stand.style.display = 'none'; empty.style.display = '' }
}
function say(text, seconds) {
  bubble.textContent = text
  bubble.classList.add('show')
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => bubble.classList.remove('show'), seconds * 1000)
}
atri.on('pet-say', (it) => {
  const bubbles = it.bubbles && it.bubbles.length ? it.bubbles : [it.text]
  say(bubbles.filter(Boolean).join('\n') || (it.sticker ? '[表情包]' : ''), cfg.bubbleSeconds || 12)
})
atri.on('chat-thinking', (t) => { if (t) say('……', 30); else if (bubble.textContent === '……') bubble.classList.remove('show') })
atri.on('settings', apply)
atri.on('conn-state', (c) => { dot.classList.toggle('on', !!(c && c.ok)); dot.title = c ? c.label : '' })
atri.init().then(({ settings, conn }) => { apply(settings); if (conn) { dot.classList.toggle('on', !!conn.ok); dot.title = conn.label } })
bubble.addEventListener('click', () => atri.open('chat'))
empty.addEventListener('click', () => atri.open('chat'))
let drag = null
stand.addEventListener('mousedown', (e) => { drag = { x: e.screenX, y: e.screenY }; stand.style.cursor = 'grabbing' })
window.addEventListener('mousemove', (e) => { if (!drag) return; const dx = e.screenX - drag.x; const dy = e.screenY - drag.y; if (dx || dy) { atri.drag(dx, dy); drag = { x: e.screenX, y: e.screenY } } })
window.addEventListener('mouseup', () => { drag = null; stand.style.cursor = 'grab' })
stand.addEventListener('dblclick', () => atri.open('chat'))
