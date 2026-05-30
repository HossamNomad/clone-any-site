import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../validate-manifest.mjs', import.meta.url));
const work = fileURLToPath(new URL('./.work/validate-test/', import.meta.url));

function base() {
  return {
    meta: { target: 'https://x.test', name: 't', schemaVersion: '1.0', buildFingerprint: 'b+c', viewports: [390, 1440], structureAuthorization: 'unset' },
    slots: [
      { number: 1, stableId: 'a', type: 'img', role: 'content', provenance: 'original', mirrorLocator: { cssPath: 'img', nth: 0 }, flags: [] },
      { number: 2, stableId: 'b', type: 'text', role: 'content', provenance: 'original', mirrorLocator: { cssPath: 'h1', nth: 0 }, currentValue: 'hi', flags: [] },
    ],
  };
}
async function run(obj) {
  await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });
  const p = work + 'manifest.json'; await writeFile(p, JSON.stringify(obj));
  const r = spawnSync(process.execPath, [script, '--manifest', p], { encoding: 'utf8' });
  return r;
}

test('valid manifest -> exit 0', async () => {
  const r = await run(base());
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('type mismatch (asset replacement on text slot) -> exit 1', async () => {
  const m = base(); m.slots[1].replacement = { kind: 'asset', assetRef: 'assets/x.webp' };
  const r = await run(m);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /replacement\.kind "text"|non-text|text slot/i);
});

test('orphan replacement.assetRef (missing file) -> exit 1', async () => {
  const m = base(); m.slots[0].replacement = { kind: 'asset', assetRef: 'assets/does-not-exist.webp' };
  const r = await run(m);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /orphan/i);
});

test('duplicate number -> exit 1', async () => {
  const m = base(); m.slots[1].number = 1;
  const r = await run(m);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /duplicate number/i);
});

test('bad enum (type) -> exit 1', async () => {
  const m = base(); m.slots[0].type = 'banana';
  const r = await run(m);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /bad type/i);
});

test.after(async () => { await rm(work, { recursive: true, force: true }); });
