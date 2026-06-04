import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE=dirname(fileURLToPath(import.meta.url)); const S=join(HERE,'..'); const WORK=join(S,'test','.work','chat');
after(()=>rm(WORK,{recursive:true,force:true}).catch(()=>{}));
test('repurpose-chat sets a text swap in swaps.json', async () => {
  const clone=join(WORK,'clone'); await mkdir(join(clone,'swaps'),{recursive:true}); await writeFile(join(clone,'swaps','swaps.json'),'{}');
  const r=spawnSync(process.execPath,[join(S,'repurpose-chat.mjs'),'--clone',clone,'--slot','TITLE-1','--text','PULSIA'],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const j=JSON.parse(await readFile(join(clone,'swaps','swaps.json'),'utf8'));
  assert.equal(j['TITLE-1'].value,'PULSIA');
});
