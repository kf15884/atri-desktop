'use strict'
const {desktopCapturer,nativeImage,systemPreferences,session}=require('electron')
const {Observer}=require('./observe-core')
function install({ipcMain,openWindow,getWindow,bridge,onState}) {
  let selected=null,selectedName=null,timer=null
  const publicSources=async()=> (await desktopCapturer.getSources({types:['window','screen'],thumbnailSize:{width:320,height:180}})).filter(s=>!s.name.startsWith('Atri')).map(s=>({id:s.id,name:s.name,kind:s.id.startsWith('screen:')?'screen':'window',preview:s.thumbnail.toDataURL()}))
  const observer=new Observer({
    capture:async(id)=>{const source=(await desktopCapturer.getSources({types:[id.startsWith('screen:')?'screen':'window'],thumbnailSize:{width:768,height:432}})).find(s=>s.id===id);if(!source||source.name!==selectedName||source.thumbnail.isEmpty())return null;let image=source.thumbnail.resize({width:768});if(image.getSize().height>432)image=image.resize({height:432});const size=image.getSize(),small=image.resize({width:64,height:36});return {bitmap:image.toBitmap(),...size,small:{bitmap:small.toBitmap(),width:64,height:36}}},
    encode:async(mosaic,cells)=>{
      // Draw addressable cell numbers with a tiny bitmap font: no runtime font dependency.
      const digits=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111']
      const put=(x,y,b,g,r)=>{const i=(y*mosaic.width+x)*4;mosaic.bitmap[i]=b;mosaic.bitmap[i+1]=g;mosaic.bitmap[i+2]=r;mosaic.bitmap[i+3]=255}
      cells.forEach((c,i)=>{const x0=i%3*384,y0=Math.floor(i/3)*216;for(let y=0;y<38;y++)for(let x=0;x<38;x++)put(x0+x,y0+y,24,24,24);const glyph=digits[c.index];for(let y=0;y<5;y++)for(let x=0;x<3;x++)if(glyph[y*3+x]==='1')for(let dy=0;dy<5;dy++)for(let dx=0;dx<5;dx++)put(x0+10+x*5+dx,y0+6+y*5+dy,255,255,255)})
      return nativeImage.createFromBitmap(mosaic.bitmap,{width:mosaic.width,height:mosaic.height}).toJPEG(83)
    },
    upload:payload=>bridge().request({type:'observe',...payload}),
    clear:()=>{if(bridge())void bridge().request({type:'observation-stop'})},
  })
  observer.on('state',s=>{getWindow()?.webContents.send('observe-state',s);onState?.(s)})
  observer.on('report',r=>getWindow()?.webContents.send('observe-report',r))
  // Only the explicit observation window can request desktop media, only while its session is active.
  session.defaultSession.setDisplayMediaRequestHandler(async(request,callback)=>{
    try{
      const win=getWindow();if(!win||request.frame!==win.webContents.mainFrame||!observer.running||!observer.options.audio||!selected)return callback({})
      const source=(await desktopCapturer.getSources({types:[selected.startsWith('screen:')?'screen':'window'],thumbnailSize:{width:0,height:0}})).find(s=>s.id===selected)
      callback(source?{video:source,audio:'loopback'}:{})
    }catch{callback({})}
  })
  function trusted(e){if(!getWindow()||e.sender!==getWindow().webContents)throw new Error('untrusted-window')}
  async function stop(){clearInterval(timer);timer=null;selected=null;selectedName=null;observer.stop();getWindow()?.webContents.send('observe-stop-audio');return observer.state()}
  ipcMain.handle('observe-sources',async(e)=>{trusted(e);return publicSources()})
  ipcMain.handle('observe-start',async(e,raw)=>{
    trusted(e);if(!raw||typeof raw!=='object')throw new Error('invalid-options');await stop()
    const sources=await publicSources(),source=sources.find(s=>s.id===raw.sourceId);if(!source)throw new Error('请选择当前可捕获的来源')
    selected=source.id;selectedName=source.name
    const state=observer.start({sourceId:source.id,sourceKind:source.kind,base:raw.base,model:String(raw.model||'').slice(0,120),audio:raw.audio===true,asrBase:raw.asrBase,asrModel:String(raw.asrModel||'').slice(0,120),windowSec:raw.windowSec,sync:raw.sync===true})
    if(raw.sync){const r=await bridge().request({type:'observation-start',sessionId:state.sessionId});if(!r.ok){await stop();throw new Error('服务器观察通道未就绪：'+r.error)}}
    if(!observer.running || observer.sessionId!==state.sessionId) return observer.state()
    timer=setInterval(()=>void observer.tick(),1000);void observer.tick()
    return state
  })
  ipcMain.handle('observe-stop',async(e)=>{trusted(e);return stop()})
  ipcMain.handle('observe-clear',async(e)=>{trusted(e);return stop()})
  ipcMain.handle('observe-state',async(e)=>{trusted(e);return observer.state()})
  ipcMain.handle('observe-zoom',async(e,range)=>{trusted(e);return observer.zoom(Number(range.from),Number(range.to))})
  ipcMain.handle('observe-audio',async(e,chunk)=>{trusted(e);if(chunk?.sessionId!==observer.sessionId)return false;observer.addAudio(Buffer.from(chunk.pcm));return true})
  ipcMain.handle('observe-audio-error',async(e)=>{trusted(e);if(observer.running){observer.options.audio=false;observer.status('系统声音不可用，已退回仅画面；请停止后重试音频')}return true})
  return {stop,observer,connectionLost:()=>{if(observer.running&&observer.options.sync)void stop()}}
}
module.exports={install}
