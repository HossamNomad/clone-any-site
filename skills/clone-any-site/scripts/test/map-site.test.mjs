// map-site.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const S = join(HERE, '..');
const WORK = join(S, 'test', '.work', 'mapsite');
const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>t</title></head><body>
<h1 style="font-size:400px">BAIKAL</h1>
<p>Un endroit extreme</p>
<img src="/hero/solo.jpg" width="800" height="1200">
<video src="/v/a.mp4"></video>
<img src="/seq/f-0.jpg"><img src="/seq/f-1.jpg"><img src="/seq/f-2.jpg">
<p class="intro-copy"><span>Fourteen</span> <span>days</span> <span>one</span> <span>protocol</span> <span>reveal</span></p>
</body></html>`;
function serve(dir){return new Promise((res,rej)=>{const p=spawn(process.execPath,[join(S,'serve.mjs'),dir],{env:{...process.env,CLONE_SERVE_PORT:'0'},stdio:['ignore','pipe','ignore']});let b='';const to=setTimeout(()=>{p.kill();rej(new Error('boot'))},15000);p.stdout.on('data',d=>{b+=d;const m=b.match(/CLONE_PORT=(\d+)/);if(m){clearTimeout(to);res({port:m[1],proc:p})}})});}
after(()=>rm(WORK,{recursive:true,force:true}).catch(()=>{}));

test('map-site emits MAP.json with typed, numbered, role-tagged slots + STORY-MAP.md', async () => {
  const mirror = join(WORK,'mirror'); await mkdir(mirror,{recursive:true}); await writeFile(join(mirror,'index.html'),PAGE);
  const out = join(WORK,'clone');
  const s = await serve(mirror);
  const r = spawnSync(process.execPath,[join(S,'map-site.mjs'),'--url','http://127.0.0.1:'+s.port+'/','--out',out],{encoding:'utf8',timeout:120000});
  s.proc.kill();
  assert.equal(r.status,0,r.stderr.slice(-300));
  const map = JSON.parse(await readFile(join(out,'repurpose','MAP.json'),'utf8'));
  const types = map.slots.map(x=>x.type);
  assert.ok(types.includes('title') && types.includes('video') && types.includes('sequence') && types.includes('text'));
  const seq = map.slots.find(x=>x.type==='sequence'); assert.equal(seq.frameCount,3); assert.ok(seq.id.startsWith('SEQ-'));
  const hook = map.slots.find(x=>x.role==='hook'); assert.ok(hook);
  const story = await readFile(join(out,'STORY-MAP.md'),'utf8'); assert.match(story,/HOOK|hook/);
  const split = map.slots.find(x=>x.split===true); assert.ok(split, 'split-text container captured');
  assert.match(split.text, /Fourteen days one protocol/);
});
