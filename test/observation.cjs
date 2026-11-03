'use strict'
const assert=require('node:assert/strict'),http=require('node:http')
const {localBase,vision,transcribe,signals,change,selectCells,compose,wav16,Observer}=require('../app/src/observe-core')
const {ObservationStore}=require('../plugin/lib/observations')
const wait=ms=>new Promise(r=>setTimeout(r,ms))
function frame(at=0,color=120){const bitmap=Buffer.alloc(8*8*4);for(let i=0;i<bitmap.length;i+=4){bitmap[i]=color;bitmap[i+1]=color;bitmap[i+2]=color;bitmap[i+3]=255}return {bitmap,width:8,height:8,at,sharp:1,delta:0,small:{bitmap,width:8,height:8}}}
;(async()=>{
 for(const url of ['https://127.0.0.1/v1','http://localhost/v1','http://192.168.1.2/v1','http://127.0.0.1.evil/v1','http://user:pass@127.0.0.1/v1','http://example.com/v1','file:///tmp/a'])assert.throws(()=>localBase(url))
 assert.equal(localBase('http://127.0.0.1:8000/v1/'),'http://127.0.0.1:8000/v1')
 assert.equal(localBase('http://[::1]:8000/v1'),'http://[::1]:8000/v1')
 const f=frame(),sig=signals(f.bitmap,8,8);assert.equal(change(sig.hsv,sig.hsv),0);assert.equal(sig.sharp,0)
 const frames=Array.from({length:30},(_,i)=>({...frame(i*1000),sharp:i%3===1?10:1,delta:i>10&&i<15?.8:0}))
 const cells=selectCells(frames,6);assert.equal(cells.length,6);assert.equal(cells[0].from,0);assert.equal(cells.at(-1).to,29000)
 assert.ok(cells.every((c,i)=>c.at>=c.from&&c.at<=c.to&&c.index===i+1));assert.ok(cells.every((c,i)=>i===0||c.from>=cells[i-1].to))
 assert.equal(compose(cells).bitmap.length,1152*432*4)
 const wav=wav16([{pcm:Buffer.alloc(32000)}]);assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000)
 let time=100000,uploaded=[],phase=[];const o=new Observer({capture:async()=>frame(),encode:async()=>Buffer.from('jpeg'),analyse:async()=> '格1出现人物，字幕读不清。',upload:async d=>{uploaded.push(d);return {ok:true}},now:()=>time})
 o.on('state',s=>phase.push(s.phase));o.start({sourceId:'window:1',model:'local',base:'http://127.0.0.1/v1',windowSec:10,sync:true})
 await o.tick();time+=1000;await o.tick();const r=await o.process(100000,101000)
 assert.equal(r.text,'格1出现人物，字幕读不清。');assert.equal(uploaded.length,1);assert.deepEqual(Object.keys(uploaded[0]).sort(),['coverage','seq','sessionId','text']);assert.ok(!JSON.stringify(uploaded).includes('jpeg'))
 time+=1000;await o.zoom(100000,101000);assert.equal(uploaded.length,1,'zoom is local only')
 assert.throws(()=>o.zoom(0,999999),'future denied')
 o.stop();assert.equal(o.frames.length,0);assert.equal(o.reports.length,0);assert.equal(o.audio.length,0)
 let release;const o2=new Observer({capture:async()=>frame(),encode:async()=>Buffer.from('jpeg'),analyse:()=>new Promise(r=>release=r),upload:async()=>{throw new Error('must-not-upload')},now:()=>time})
 o2.start({sourceId:'window:1',model:'local',base:'http://127.0.0.1/v1',windowSec:10,sync:true});await o2.tick();time+=1000;await o2.tick();const late=o2.process(time-1000,time);await wait(0);o2.stop();release('old observation');assert.equal(await late,null);assert.equal(o2.reports.length,0)
 // Capture completing after stop cannot repopulate buffers.
 let captureRelease;const o3=new Observer({capture:()=>new Promise(r=>captureRelease=r),now:()=>time});o3.start({sourceId:'window:1',model:'local',base:'http://127.0.0.1/v1'});const pending=o3.tick();o3.stop();captureRelease(frame());await pending;assert.equal(o3.frames.length,0)
 const failed=new Observer({capture:async()=>null,now:()=>time});failed.start({sourceId:'window:gone',model:'local',base:'http://127.0.0.1/v1'});await failed.tick();assert.equal(failed.running,false,'missing source stops capture');assert.equal(failed.frames.length,0)
 const store=new ObservationStore({now:()=>time}),socket={},other={};const view={storyId:'story-a',participantId:'owner',userMessage:'看到了吗'}
 store.start(socket,'1234567890abcdef');assert.throws(()=>store.put(socket,{sessionId:store.sessionId,seq:1,text:'x',coverage:'x'}),/talk-to/)
 store.note(view);store.put(socket,{sessionId:store.sessionId,seq:1,text:'片段观察',coverage:'抽样2格'});assert.ok(store.note(view).text.includes('片段观察'))
 assert.throws(()=>store.put(other,{sessionId:store.sessionId,seq:2,text:'wrong',coverage:'x'}),/session-not/)
 assert.throws(()=>store.put(socket,{sessionId:store.sessionId,seq:1,text:'stale',coverage:'x'}),/duplicate/)
 time+=120001;assert.equal(store.note(view),null)
 store.put(socket,{sessionId:store.sessionId,seq:2,text:'fresh',coverage:'x'});assert.equal(store.note({...view,storyId:'story-b'}),null,'reset invalidates observations')
 store.stop(other);assert.equal(store.socket,socket);store.stop(socket);assert.equal(store.item,null)
 // Local HTTP integration: real requests, fake model only; no production provider.
 let requests=[];const server=http.createServer((req,res)=>{let body=[];req.on('data',c=>body.push(c));req.on('end',()=>{requests.push({path:req.url,body:Buffer.concat(body).toString()});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('/audio/transcriptions')?{text:'听到了这句话',segments:[{start:0,end:1,text:'这句话'}]}:{choices:[{message:{content:'本地识别成功'}}]}))})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+'/v1'
 try{assert.equal(await vision({base,model:'fake',image:Buffer.from('jpeg'),prompt:'read',signal:AbortSignal.timeout(5000)}),'本地识别成功');assert.equal((await transcribe({base,model:'fake',wav,signal:AbortSignal.timeout(5000)})).text,'听到了这句话');assert.ok(requests[1].body.includes('audio/wav'))}finally{await new Promise(r=>server.close(r))}
 console.log('OBSERVATION OK: sampling, local endpoints, HTTP/ASR contract, pause/stale/epoch isolation, privacy, scopes and TTL')
})().catch(e=>{console.error(e);process.exit(1)})
