#!/usr/bin/env node
// repurpose-chat.mjs — apply one swap by id: --text "..." (text) or --file path (media, transcoded to constraints).
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'; import { join, extname } from 'node:path';
import { transcodeImage, transcodeVideo } from './transcode.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((a,v,i,arr)=>{ if(v.startsWith('--')) a.push([v.slice(2),arr[i+1]]); return a; },[]));
const CLONE=A.clone, ID=A.slot; const sp=join(CLONE,'swaps','swaps.json');
const swaps = existsSync(sp)?JSON.parse(readFileSync(sp,'utf8')):{};
if (A.text != null) { swaps[ID] = { type:'text', value:A.text }; }
else if (A.file) {
  const map = existsSync(join(CLONE,'repurpose','MAP.json'))?JSON.parse(readFileSync(join(CLONE,'repurpose','MAP.json'),'utf8')):{slots:[]};
  const slot = map.slots.find(s=>s.id===ID)||{}; const c=slot.constraints||{};
  const gen=join(CLONE,'swaps','.generated'); mkdirSync(gen,{recursive:true});
  const isVid = /\.(mp4|webm|mov)$/i.test(A.file); const out=join(gen, ID + (isVid?'.mp4':'.webp'));
  await (isVid ? transcodeVideo(A.file,out,{w:c.w,h:c.h}) : transcodeImage(A.file,out,{w:c.w,h:c.h}));
  swaps[ID] = { type: isVid?'video':'image', file: '.generated/' + ID + (isVid?'.mp4':'.webp') };
}
writeFileSync(sp, JSON.stringify(swaps,null,2)); console.log(JSON.stringify({ ok:true, slot:ID }));
