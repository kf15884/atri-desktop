'use strict'
// 本机日语识别（asr/ 便携包，OpenAI 兼容 /audio/transcriptions）：只认本机地址，不跟随重定向（0.3 的本地观察里搬过来，一起看番“本地日语识别”用）
function localBase(s) {
  const u = new URL(String(s).trim())
  if (u.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new Error('模型地址只允许 http://127.0.0.1 或 http://[::1]，不允许云端/重定向')
  return u.href.replace(/\/$/,'')
}
async function boundedJSON(res) {
  if (!res.ok) throw new Error('本地模型 HTTP '+res.status)
  const reader=res.body.getReader();let bytes=0,parts=[]
  try { for (;;) { const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>512*1024)throw new Error('本地模型返回过大');parts.push(Buffer.from(value)) } }
  finally { await reader.cancel().catch(()=>{}) }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}
async function transcribe({base,model,wav,signal}) {
  if (!model)throw new Error('请填写本地ASR模型名')
  const form=new FormData();form.append('model',String(model).slice(0,120));form.append('response_format','verbose_json');form.append('file',new Blob([wav],{type:'audio/wav'}),'observation.wav')
  const res=await fetch(localBase(base)+'/audio/transcriptions',{method:'POST',redirect:'error',body:form,signal})
  const data=await boundedJSON(res)
  if(typeof data.text!=='string'||!data.text.trim())return {text:'',segments:[]}
  return {text:data.text.trim().slice(0,2400),segments:Array.isArray(data.segments)?data.segments.slice(0,100).map(s=>({start:Number(s.start),end:Number(s.end),text:String(s.text||'').slice(0,200)})).filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>=s.start):[]}
}
module.exports = { localBase, transcribe }
