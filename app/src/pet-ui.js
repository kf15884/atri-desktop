const stand = document.getElementById('stand'), bubble = document.getElementById('bubble'), dot = document.getElementById('dot'), empty = document.getElementById('empty')
let cfg = {}, hideTimer
function apply(s) {
  cfg = s
  document.body.style.opacity = s.opacity
  if (s.image) { stand.src = fileUrl(s.image); stand.style.display = ''; empty.style.display = 'none' }
  else { stand.style.display = 'none'; empty.style.display = '' }
}
function show(item) {
  if (item.role !== 'atri') return
  renderParts(item.parts, bubble); bubble.classList.add('show')
  clearTimeout(hideTimer); hideTimer = setTimeout(() => bubble.classList.remove('show'), (cfg.bubbleSeconds || 12) * 1000)
}
atri.init().then(({ settings, conn }) => { apply(settings); setConn(conn) })
function setConn(c) { dot.classList.toggle('on', !!c.online); dot.title = c.label }
atri.on('settings', apply); atri.on('conn', setConn); atri.on('msg', show)
bubble.addEventListener('click', () => atri.openChat())
// 拖动立绘；双击打开对话框
let drag = null, moved = false
stand.addEventListener('mousedown', (e) => { drag = { x: e.screenX, y: e.screenY }; moved = false; stand.style.cursor = 'grabbing' })
window.addEventListener('mousemove', (e) => { if (!drag) return; const dx = e.screenX - drag.x, dy = e.screenY - drag.y; if (dx || dy) { moved = true; atri.drag(dx, dy); drag = { x: e.screenX, y: e.screenY } } })
window.addEventListener('mouseup', () => { drag = null; stand.style.cursor = 'grab' })
stand.addEventListener('dblclick', () => atri.openChat())
