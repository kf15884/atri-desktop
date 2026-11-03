'use strict'
// 共用：把消息片段渲染成安全的 DOM（不使用 innerHTML 插入消息内容）
window.renderParts = function (parts, el) {
  el.textContent = ''
  for (const p of parts || []) {
    if (p.t === 'text') el.append(document.createTextNode(p.v))
    else if (p.t === 'image' && /^(https?:|data:image\/(png|jpeg|gif|webp);base64,)/i.test(String(p.src || ''))) { const img = document.createElement('img'); img.src = p.src; img.className = 'msg-img'; img.referrerPolicy = 'no-referrer'; el.append(img) }
    else { const s = document.createElement('span'); s.className = 'note'; s.textContent = p.t === 'card' ? '[卡片] ' + p.v : p.v; el.append(s) }
  }
}
window.plainText = (parts) => (parts || []).map(p => p.t === 'text' ? p.v : p.t === 'card' ? '[卡片]' : p.v || '').join('')
window.fileUrl = (p) => p ? 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:') : ''
