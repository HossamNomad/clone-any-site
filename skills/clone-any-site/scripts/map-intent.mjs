#!/usr/bin/env node
// map-intent.mjs — scaffold INTENT-MAP.md: one row per slot (id, type, role, constraints) + an empty BRIEF line
// for Claude to fill from brain/ (personas/offer/expedition/messaging). NOT auto-content; the human gate lives here.
import { readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
const A = Object.fromEntries(process.argv.slice(2).reduce((a,v,i,arr)=>{ if(v.startsWith('--')) a.push([v.slice(2),arr[i+1]]); return a; },[]));
const CLONE=A.clone, USE=A['use-case']||'(use case)';
const map = JSON.parse(readFileSync(join(CLONE,'repurpose','MAP.json'),'utf8'));
const rows = map.slots.map(s=>{ const c=s.constraints||{}; const cons=[c.aspectRatio,c.durationSec&&c.durationSec+'s',c.charLen!=null&&c.charLen+' chars',c.frameCount&&c.frameCount+' frames'].filter(Boolean).join(', '); return `### ${s.id} — \`${s.type}\` — **${(s.role||'').toUpperCase()}**  (${cons})\n- ORIGINAL: ${s.text?('"'+s.text+'"'):(s.original||'')}\n- BRIEF: _<what OUR content must be to do the same job for: ${USE}>_\n- SOURCE: _<brain/ ref or media plan>_\n`; });
const md = `# INTENT-MAP — repurpose for: ${USE}\n\n> For each slot: fill BRIEF (the Pulsia content that does the same rhetorical job) + SOURCE (brain/ truth or media plan). This is the validation gate.\n\n${rows.join('\n')}`;
writeFileSync(join(CLONE,'INTENT-MAP.md'), md);
console.log(JSON.stringify({ ok:true, rows: map.slots.length }));
