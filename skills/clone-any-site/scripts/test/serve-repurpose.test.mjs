import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
let chromium=null; try{({chromium}=await import('playwright'));}catch{}
const HERE=dirname(fileURLToPath(import.meta.url)); const S=join(HERE,'..'); const WORK=join(S,'test','.work','srv');
after(()=>rm(WORK,{recursive:true,force:true}).catch(()=>{}));

// a tiny "SPA" with a CSS animation + a CDN image + a title, so we can assert anims survive a swap
const PAGE = `<!doctype html><html><head><meta charset=utf-8><style>@keyframes f{from{opacity:.2}to{opacity:1}}.a{animation:f 3s infinite}</style></head>
<body><div class="a"><img src="https://images.ctfassets.net/x/y/hero.jpg" width="600" height="400"></div><h1>BAIKAL</h1></body></html>`;

test('serve-repurpose shows the swapped image + keeps animations', { skip: !chromium?'no playwright':false }, async () => {
  const clone = join(WORK,'clone'); const mirror=join(clone,'mirror'); await mkdir(mirror,{recursive:true}); await writeFile(join(mirror,'index.html'),PAGE);
  await mkdir(join(clone,'repurpose'),{recursive:true});
  await writeFile(join(clone,'repurpose','MAP.json'), JSON.stringify({ slots:[{id:'IMG-1',type:'image',original:'https://images.ctfassets.net/x/y/hero.jpg'},{id:'TITLE-1',type:'text',text:'BAIKAL',where:{}}]}));
  const gen=join(clone,'swaps','.generated'); await mkdir(gen,{recursive:true});
  await sharp({create:{width:600,height:400,channels:3,background:'#ff00aa'}}).webp().toFile(join(gen,'IMG-1.webp'));
  await writeFile(join(clone,'swaps','swaps.json'), JSON.stringify({ 'IMG-1':{type:'image',file:'.generated/IMG-1.webp'}, 'TITLE-1':{type:'text',value:'PULSIA'} }));
  // boot
  const proc=spawn(process.execPath,[join(S,'serve-repurpose.mjs'),'--clone',clone,'--mirror',mirror],{env:{...process.env,CLONE_SERVE_PORT:'0'},stdio:['ignore','pipe','ignore']});
  const port=await new Promise((res,rej)=>{let b='';const to=setTimeout(()=>{proc.kill();rej(new Error('boot'))},15000);proc.stdout.on('data',d=>{b+=d;const m=b.match(/CLONE_PORT=(\d+)/);if(m){clearTimeout(to);res(m[1])}})});
  const b=await chromium.launch(); const ctx=await b.newContext(); const pg=await ctx.newPage(); await pg.setViewportSize({width:1440,height:900});
  await pg.goto('http://127.0.0.1:'+port+'/',{waitUntil:'load',timeout:60000}); await pg.waitForTimeout(6000);
  const imgOk = await pg.evaluate(()=>{ const i=document.querySelector('img'); return i && /\/__swap\/IMG-1/.test(i.src) && i.naturalWidth>0; });
  const h1 = await pg.evaluate(()=>document.querySelector('h1').textContent);
  const anims = await pg.evaluate(()=>{let a=0;for(const e of document.querySelectorAll('*')){const cs=getComputedStyle(e);if(cs.animationName&&cs.animationName!=='none')a++;}return a;});
  await b.close(); proc.kill();
  assert.ok(imgOk, 'swapped image served + decoded');
  assert.equal(h1,'PULSIA','title swapped');
  assert.ok(anims>=1,'CSS animation still present');
});
