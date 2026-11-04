'use strict'
// 新消息卡片（像 Telegram 那样，屏幕右下角）：她的头像、名字、消息开头；点开对话框，× 收起
const card = document.getElementById('card')
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')
atri.on('notify-show', ({ item, image }) => {
  const av = document.getElementById('avatar')
  if (image) { const img = document.createElement('img'); img.id = 'avatar'; img.src = fileUrl(image); img.alt = ''; av.replaceWith(img) }
  const bubbles = item.bubbles && item.bubbles.length ? item.bubbles : [item.text]
  document.getElementById('text').textContent = bubbles.filter(Boolean).join(' ') || (item.sticker ? '[表情包]' : '')
  document.getElementById('via').textContent = item.via === 'qq' ? '在 QQ 上' : '刚刚'
  card.classList.remove('show')
  requestAnimationFrame(() => card.classList.add('show'))
})
card.addEventListener('click', (e) => { if (e.target.id === 'x') atri.hideNotify(); else atri.open('chat') })
