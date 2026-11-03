const $ = (id) => document.getElementById(id)
atri.init().then(({ settings: s }) => {
  $('url').value = s.url; $('image').value = s.image || ''; $('opacity').value = Math.round(s.opacity * 100); $('ov').textContent = $('opacity').value + '%'
  $('bubble').value = s.bubbleSeconds; if (s.hasToken) $('token').placeholder = '已保存（留空不改）'
})
$('opacity').oninput = () => { $('ov').textContent = $('opacity').value + '%'; atri.preview({ opacity: $('opacity').value / 100 }) }
$('pick').onclick = async () => { const p = await atri.pickImage(); if (p) { $('image').value = p; atri.preview({ image: p }) } }
$('save').onclick = async () => {
  await atri.saveSettings({ url: $('url').value, token: $('token').value, image: $('image').value, opacity: $('opacity').value / 100, bubbleSeconds: Number($('bubble').value) })
  $('token').value = ''; $('msg').textContent = '已保存'
}
