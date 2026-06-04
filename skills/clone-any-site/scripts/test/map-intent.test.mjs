import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE=dirname(fileURLToPath(import.meta.url)); const S=join(HERE,'..'); const WORK=join(S,'test','.work','intent');
after(()=>rm(WORK,{recursive:true,force:true}).catch(()=>{}));
test('map-intent emits one INTENT-MAP row per slot with an empty brief to fill', async () => {
  const clone=join(WORK,'clone'); await mkdir(join(clone,'repurpose'),{recursive:true});
  await writeFile(join(clone,'repurpose','MAP.json'), JSON.stringify({ slots:[{id:'TITLE-1',type:'title',role:'hook',constraints:{charLen:6}},{id:'VID-1',type:'video',role:'immersion',constraints:{aspectRatio:'16:9'}}]}));
  const r = spawnSync(process.execPath,[join(S,'map-intent.mjs'),'--clone',clone,'--use-case','Lock-in expedition activities'],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const md = await readFile(join(clone,'INTENT-MAP.md'),'utf8');
  assert.match(md,/Lock-in expedition activities/); assert.match(md,/TITLE-1/); assert.match(md,/VID-1/); assert.match(md,/BRIEF:/);
});
