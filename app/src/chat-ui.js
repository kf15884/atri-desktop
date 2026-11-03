const list = document.getElementById('list'), input = document.getElementById('input'), sendBtn = document.getElementById('send'), conn = document.getElementById('conn'), err = document.getElementById('err')
const ERR = { 'not-connected': '还没连上服务器', 'too-fast': '发得太快了', 'too-long': '太长了（最多2000字）', 'bot-offline': 'QQ 机器人离线，消息没有送出', timeout: '服务器没有回应', disconnected: '连接断开了', empty: '' }
const seen = new Set()
function fmt(t) { const d = new Date(t); return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') }
function add(item) {
  if (seen.has(item.id)) return; seen.add(item.id)
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80
  const row = document.createElement('div'); row.className = 'row ' + item.role
  const msg = document.createElement('div'); msg.className = 'msg'; renderParts(item.parts, msg)
  const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = fmt(item.at) + (item.role === 'user' ? (item.source === 'qq' ? ' · QQ' : ' · 桌面') : '')
  if (item.role === 'user') row.append(meta, msg); else row.append(msg, meta)
  list.append(row)
  if (nearBottom) list.scrollTop = list.scrollHeight
}
function setConn(c) { conn.textContent = c.label; conn.classList.toggle('on', !!c.online) }
atri.init().then(({ history, conn }) => { history.forEach(add); list.scrollTop = list.scrollHeight; setConn(conn) })
atri.on('msg', add); atri.on('history', (h) => h.forEach(add)); atri.on('conn', setConn)
async function send() {
  const text = input.value.trim(); if (!text) return
  sendBtn.disabled = true; err.textContent = ''
  const r = await atri.say(text)
  sendBtn.disabled = false
  if (r.ok) input.value = ''
  else err.textContent = '没有发出去：' + (ERR[r.error] ?? r.error)
  input.focus()
}
document.getElementById('observe').onclick=()=>atri.openObserve()
sendBtn.onclick = send
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() } })
