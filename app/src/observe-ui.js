'use strict'
const $=id=>document.getElementById(id)
let sources=[],origin=0,current=null,audioStream=null,audioContext=null,audioNode=null,processor=null,audioTimer=null,audioParts=[],running=false,sessionEpoch=0
const err=e=>{$('error').textContent=e?.message||String(e)}
function lock(value){running=value;['source','refresh','base','model','window','audio','sync','asrBase','asrModel'].forEach(id=>$(id).disabled=value);$('start').disabled=value;$('stop').disabled=!value}
async function refresh(){try{sources=await atri.observation('sources');$('source').replaceChildren(new Option('请选择来源',''),...sources.map(s=>new Option((s.kind==='screen'?'[整个屏幕] ':'[窗口] ')+s.name,s.id)));$('sourcePreview').hidden=true}catch(e){err(e)}}
$('refresh').onclick=refresh
$('source').onchange=()=>{const s=sources.find(s=>s.id===$('source').value);$('sourcePreview').hidden=!s?.preview;if(s?.preview)$('sourcePreview').src=s.preview}
$('audio').onchange=()=>{$('audioConfig').hidden=!$('audio').checked}
function audioStop(){sessionEpoch++;clearInterval(audioTimer);audioParts=[];try{processor?.disconnect();audioNode?.disconnect();audioStream?.getTracks().forEach(t=>t.stop());audioContext?.close()}catch{}audioStream=audioContext=audioNode=processor=null}
async function startAudio(sid){
  audioStop();const epoch=sessionEpoch
  const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true})
  if(epoch!==sessionEpoch||!running){stream.getTracks().forEach(t=>t.stop());return}
  if(!stream.getAudioTracks().length){stream.getTracks().forEach(t=>t.stop());throw new Error('没有取得系统声音轨；已退回仅画面')}
  audioStream=stream;audioContext=new AudioContext({sampleRate:16000});await audioContext.resume()
  audioNode=audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));processor=audioContext.createScriptProcessor(4096,1,1)
  const sampleRate=audioContext.sampleRate
  processor.onaudioprocess=e=>{if(epoch!==sessionEpoch||!running)return;const a=e.inputBuffer.getChannelData(0),out=new Int16Array(Math.floor(a.length*16000/sampleRate));for(let i=0;i<out.length;i++)out[i]=Math.round(Math.max(-1,Math.min(1,a[Math.floor(i*sampleRate/16000)]))*32767);audioParts.push(new Uint8Array(out.buffer));if(audioParts.length>16)audioParts.shift()}
  audioNode.connect(processor);processor.connect(audioContext.destination)
  audioTimer=setInterval(()=>{if(!audioParts.length||epoch!==sessionEpoch)return;const len=audioParts.reduce((n,b)=>n+b.length,0),out=new Uint8Array(len);let p=0;for(const b of audioParts){out.set(b,p);p+=b.length}audioParts=[];void atri.observation('audio',{sessionId:sid,pcm:out}).catch(err)},1000)
  stream.getAudioTracks()[0].onended=()=>{audioStop();void atri.observation('audio-error');err('系统声音轨已结束，观察已退回仅画面')}
}
$('start').onclick=async()=>{
  $('error').textContent='';$('start').disabled=true
  try{
    const source=sources.find(s=>s.id===$('source').value);if(!source)throw new Error('先选择一个窗口或屏幕')
    if(source.kind==='screen'&&!confirm('将持续观察整个选定屏幕，可能包含其他应用和私密内容。确认开始？'))return
    const state=await atri.observation('start',{sourceId:source.id,base:$('base').value,model:$('model').value,windowSec:Number($('window').value),audio:$('audio').checked,asrBase:$('asrBase').value,asrModel:$('asrModel').value,sync:$('sync').checked})
    origin=state.started;current=state.sessionId;$('reports').replaceChildren();$('empty').hidden=false;lock(true)
    if($('audio').checked)try{await startAudio(current)}catch(e){audioStop();await atri.observation('audio-error');err(e)}
  }catch(e){lock(false);err(e)}finally{if(!running)$('start').disabled=false}
}
$('stop').onclick=async()=>{audioStop();await atri.observation('stop');lock(false);$('reports').replaceChildren();$('empty').hidden=false}
atri.on('observe-stop-audio',()=>audioStop())
atri.on('observe-state',s=>{lock(s.running);$('badge').textContent=s.running?'观察中':'未开始';$('state').textContent=s.phase+(s.running?` · 缓存 ${s.frames} 帧 · ${s.sync?'文字同步开启':'仅本地'}`:'');if(!s.running){audioStop();$('sourcePreview').hidden=true;$('sourcePreview').removeAttribute('src');sources.forEach(s=>delete s.preview);$('reports').replaceChildren();$('empty').hidden=false}})
atri.on('observe-report',r=>{
  $('empty').hidden=true;const article=document.createElement('article');article.className='report'
  const meta=document.createElement('div');meta.className='meta';meta.textContent=`会话 ${((r.from-origin)/1000).toFixed(1)}–${((r.to-origin)/1000).toFixed(1)} 秒 · ${r.delivery}`
  const image=document.createElement('img');image.src=r.image;image.alt='编号顺序分镜，仅保存在本地内存'
  const text=document.createElement('p');text.textContent=r.text
  const cells=document.createElement('div');cells.className='cells'
  for(const c of r.cells){const b=document.createElement('button');b.className='secondary';b.textContent='回看格 '+c.index;b.onclick=async()=>{try{b.disabled=true;const result=await atri.observation('zoom',{from:c.from,to:Math.max(c.to,c.from+1000)});if(!result)throw new Error('回看未完成，可能缓存过期或模型失败')}catch(e){err(e)}finally{b.disabled=false}};cells.append(b)}
  const audio=document.createElement('p');audio.className='meta';audio.textContent=r.audioStatus
  article.append(meta,image,cells,text,audio)
  if(r.transcript){const t=document.createElement('p');t.className='transcript';t.textContent='ASR参考：'+r.transcript;article.append(t)}
  $('reports').prepend(article);while($('reports').children.length>4)$('reports').lastChild.remove()
})
atri.observation('state').then(s=>{origin=Number(s.started)||0;lock(s.running);$('state').textContent=s.phase}).catch(err)
window.addEventListener('beforeunload',()=>audioStop())
refresh()
