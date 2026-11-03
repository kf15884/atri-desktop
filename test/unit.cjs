'use strict'
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), assert = require('node:assert/strict')
const ENV=path.resolve(__dirname,'../env/node_modules')+'/'
const { h }=require(ENV+'koishi')
const { makeInliner, toParts, History }=require(ENV+'koishi-plugin-atri-desktop')._internal
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'atri-desktop-unit-')), external=fs.mkdtempSync(path.join(os.tmpdir(),'atri-desktop-out-'))
try {
 const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489','hex')
 const file=path.join(dir,'开心 1.png');fs.writeFileSync(file,png)
 const outside=path.join(external,'outside.png');fs.writeFileSync(outside,png)
 fs.symlinkSync(outside,path.join(dir,'linked.png'))
 const inline=makeInliner(dir,1), img=src=>inline(h('img',{src}))
 const {pathToFileURL}=require('node:url')
 assert.ok(img(pathToFileURL(file).href).startsWith('data:image/png;base64,'))
 assert.equal(img(pathToFileURL(outside).href),null)
 assert.equal(img(pathToFileURL(path.join(dir,'linked.png')).href),null,'symlink escape denied')
 assert.equal(img('file:///etc/passwd'),null)
 assert.equal(img('base64://'+Buffer.alloc(2048).toString('base64')),null)
 assert.equal(makeInliner(dir,0)(h.image(png,'image/png')),null)
 assert.equal(toParts([h.image(png,'image/png')],inline)[0].t,'image')
 assert.equal(toParts([h('img',{src:'file:///etc/passwd'})],inline)[0].v,'[图片]')
 const fileHist=path.join(dir,'history.jsonl'), hist=new History(fileHist,20)
 for(let i=0;i<60;i++)hist.add({id:'u'+i,role:'user',parts:[{t:'text',v:''+i}]})
 assert.equal(hist.items.length,20);assert.equal(hist.since(59).length,1)
 const reload=new History(fileHist,20);assert.equal(reload.seq,60);assert.equal(reload.items.length,20)
 assert.equal(fs.statSync(fileHist).mode&0o777,0o600)
 console.log('UNIT OK: inline images, size limits, path/symlink isolation, history persistence')
} finally { fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(external,{recursive:true,force:true}) }
