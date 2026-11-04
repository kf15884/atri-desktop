'use strict'
const $ = (id) => document.getElementById(id)
let cmd = ''
function showState(st) {
  $('badge').textContent = st.ok ? '已连上' : st.phase === 'connecting' ? '连接中' : st.phase === 'setup' ? '没设置' : '没连上'
  $('state').textContent = st.label + (st.error ? '\n' + st.error : '')
}
function fill(s) {
  $('host').value = s.host
  $('port').value = s.port
  $('user').value = s.user
  $('localPort').value = s.localPort
  $('token').placeholder = s.hasToken ? '已保存（要改才填）' : '和服务器 /etc/atri/atri.env 里的 ATRI_DESK_TOKEN 一样'
  cmd = s.setupCommand
  $('cmd').hidden = !cmd
  $('cmd').textContent = cmd ? '在服务器上（root）运行：\n' + cmd : ''
  $('copy').disabled = !cmd
  $('keygen').textContent = s.hasKey ? '重新生成连接钥匙' : '生成连接钥匙'
}
async function init() {
  try { const r = await atri.conn('init'); fill(r.settings); showState(r.state) } catch (e) { $('msg').textContent = e.message || String(e) }
}
$('save').onclick = async () => {
  try {
    const x = { host: $('host').value, port: Number($('port').value || 22), user: $('user').value || 'atri-desk', localPort: Number($('localPort').value || 15160) }
    if ($('token').value) x.token = $('token').value
    fill(await atri.conn('save', x))
    $('token').value = ''
    $('msg').textContent = '保存了，正在连…'
  } catch (e) { $('msg').textContent = e.message || String(e) }
}
$('retry').onclick = async () => showState(await atri.conn('retry'))
$('keygen').onclick = async () => {
  if (cmd && !confirm('重新生成后，旧钥匙就不能用了，要在服务器上再运行一次新命令。确定吗？')) return
  try { fill(await atri.conn('keygen')); $('msg').textContent = '钥匙生成好了：把下面的命令复制到服务器上运行一次' } catch (e) { $('msg').textContent = e.message || String(e) }
}
$('copy').onclick = async () => { await navigator.clipboard.writeText(cmd); $('msg').textContent = '复制了' }
$('forget').onclick = async () => { if (confirm('确定服务器重装过、指纹本来就该变吗？')) { await atri.conn('forget-host'); $('msg').textContent = '忘掉了，下次连接重新记' } }
atri.on('conn-state', showState)
init()
