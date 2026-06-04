#!/usr/bin/env node
// map-site.mjs — Rhetorical Cartographer. Loads a served mirror, scrolls it, harvests every slot with its
// rect/text/type/arc-position, then uses lib/slot-infer to assign IDs, group sequences, infer role + constraints.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { groupSequences, assignIds, inferRole, inferConstraints } from './lib/slot-infer.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((a,v,i,arr)=>{ if(v.startsWith('--')) a.push([v.slice(2),arr[i+1]]); return a; },[]));
const URL = A.url, OUT = A.out; if(!URL||!OUT){ console.error('need --url --out'); process.exit(1); }

const harvest = () => {
  const docH = document.body.scrollHeight || 1;
  const out = { texts: [], imgs: [], videos: [] };
  const seen = new Set();
  document.querySelectorAll('h1,h2,h3,h4,p,span,a,li,figcaption').forEach((e) => {
    if (e.children.length) return; const t = (e.textContent||'').replace(/\s+/g,' ').trim(); if (t.length < 2) return;
    const r = e.getBoundingClientRect(); const top = r.top + scrollY; const k = t+'@'+Math.round(top);
    if (seen.has(k)) return; seen.add(k);
    const fontPx = parseFloat(getComputedStyle(e).fontSize)||0;
    const isHeading = /H[1-4]/.test(e.tagName) || fontPx >= 40;
    out.texts.push({ type: isHeading ? 'title':'text', text: t, fontPx, arcRatio: top/docH, isCta: /apply|book|join|candidat|réserver|découvr|explor/i.test(t) && e.tagName==='A', cssPath: cssPathOf(e), nth: 0 });
  });
  // split-text reveal blocks: a sentence split across inline fragment spans (per-line/word reveal animations)
  // is invisible to the leaf pass above. Capture the CONTAINER (full text + cssPath, flagged split) so the
  // Composer can distribute our words across those fragments without removing any element (animation-safe).
  document.querySelectorAll('h1,h2,h3,h4,p,blockquote,figcaption,[class*="title" i],[class*="heading" i],[class*="headline" i],[class*="paragraph" i],[class*="text" i],[class*="copy" i],[class*="lede" i],[class*="intro" i]').forEach((e) => {
    if (!e.children.length) return;                                          // childless = the leaf pass handled it
    if (e.querySelector('img,video,svg,canvas,picture,a[href],input,button')) return; // not a media/interactive block
    let inlineKids = 0, blockTextKids = 0;
    for (const c of e.children) { const d = getComputedStyle(c).display; if (d.indexOf('inline') === 0 || d === 'contents') inlineKids++; if (c.children.length && (c.textContent||'').trim().length > 16 && d.indexOf('inline') !== 0) blockTextKids++; }
    if (blockTextKids > 0 || inlineKids === 0) return;                       // capture the innermost block, needs inline fragments
    const t = (e.textContent||'').replace(/\s+/g,' ').trim();
    if (t.length < 12 || t.length > 600) return;                            // a sentence/paragraph, not a whole section
    const r = e.getBoundingClientRect(); const top = r.top + scrollY; const k = 'ST:'+t.slice(0,24)+'@'+Math.round(top);
    if (seen.has(k)) return; seen.add(k);
    const fontPx = parseFloat(getComputedStyle(e).fontSize)||0;
    out.texts.push({ type: (/H[1-4]/.test(e.tagName)||fontPx>=40)?'title':'text', text: t, fontPx, arcRatio: top/docH, isCta: false, cssPath: cssPathOf(e), split: true });
  });
  document.querySelectorAll('img').forEach((im) => { const r = im.getBoundingClientRect(); out.imgs.push({ url: im.currentSrc||im.src, rect:{width:r.width,height:r.height}, arcRatio:(r.top+scrollY)/docH, cssPath: cssPathOf(im) }); });
  document.querySelectorAll('video').forEach((v) => { const r = v.getBoundingClientRect(); out.videos.push({ url: v.currentSrc||v.src, rect:{width:r.width,height:r.height}, durationSec: v.duration||null, arcRatio:(r.top+scrollY)/docH, cssPath: cssPathOf(v) }); });
  function cssPathOf(el){ const parts=[]; let n=el; while(n&&n.nodeType===1&&parts.length<6){ let s=n.tagName.toLowerCase(); if(n.id){s+='#'+n.id;parts.unshift(s);break;} const sib=[...(n.parentNode?.children||[])].filter(c=>c.tagName===n.tagName); if(sib.length>1)s+=`:nth-of-type(${sib.indexOf(n)+1})`; parts.unshift(s); n=n.parentElement; } return parts.join(' > '); }
  return out;
};

const b = await chromium.launch();
try {
  const ctx = await b.newContext({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); await pg.setViewportSize({ width: 1440, height: 900 });
  await pg.goto(URL, { waitUntil: 'load', timeout: 60000 }); await pg.waitForTimeout(4500);
  for (let y=0; y<=(await pg.evaluate(()=>document.body.scrollHeight)); y+=1100){ await pg.evaluate((yy)=>scrollTo(0,yy),y); await pg.waitForTimeout(120); }
  await pg.evaluate(()=>scrollTo(0,0)); await pg.waitForTimeout(800);
  const raw = await pg.evaluate(harvest);
  const { sequences, singles } = groupSequences(raw.imgs);
  let items = [];
  for (const t of raw.texts) items.push({ ...t, _src:'text' });
  for (const im of singles) items.push({ type:'image', ...im, _src:'img' });
  for (const sq of sequences) items.push({ type:'sequence', url: sq.frames[0], frames: sq.frames, frameCount: sq.frameCount, arcRatio: 0.5, _src:'seq' });
  for (const v of raw.videos) items.push({ type:'video', ...v, _src:'video' });
  items.sort((a,b2)=>(a.arcRatio||0)-(b2.arcRatio||0));
  items = assignIds(items).map((s)=>({ ...s, role: inferRole(s), constraints: inferConstraints(s) }));
  const map = { meta:{ url:URL, generatedFrom:'map-site', count: items.length }, slots: items.map(s=>({ id:s.id, color:s.color, type:s.type, role:s.role, split:s.split||false, constraints:s.constraints, text:s.text, original:s.url, frames:s.frames, frameCount:s.frameCount, where:{ cssPath:s.cssPath, arcRatio:s.arcRatio } })) };
  await mkdir(join(OUT,'repurpose'),{recursive:true});
  await writeFile(join(OUT,'repurpose','MAP.json'), JSON.stringify(map,null,2));
  const md = ['# STORY-MAP — '+URL,'', 'Each slot, in story-arc order, with the job it does.',''];
  for (const s of map.slots){ md.push(`- **${s.id}** \`${s.type}\` — **${(s.role||'').toUpperCase()}** ${s.text?('— "'+s.text.slice(0,60)+'"'):''} ${s.constraints?.aspectRatio?('('+s.constraints.aspectRatio+')'):''} ${s.constraints?.charLen!=null?('('+s.constraints.charLen+' chars)'):''}`); }
  await writeFile(join(OUT,'STORY-MAP.md'), md.join('\n'));
  console.log(JSON.stringify({ ok:true, slots: map.slots.length }));
} finally { await b.close(); }
