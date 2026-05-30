import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('../', import.meta.url));
const applySwaps = scriptsDir + 'apply-swaps.mjs';
const mirror = scriptsDir + 'test/fixtures/static-fixture';
const work = fileURLToPath(new URL('./.work/apply-swaps/', import.meta.url));
const repurpose = work + 'repurpose/';
const rmwork = () => rm(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });

function manifest(extra = {}) {
  return {
    meta: { target: 'https://x.test', name: 'as', schemaVersion: '1.0', buildFingerprint: 'b+c', viewports: [390, 1440], structureAuthorization: 'unset', ...extra },
    slots: [
      { number: 1, stableId: 't1', type: 'text', role: 'content', provenance: 'original', mirrorLocator: { cssPath: '.hero-title', nth: 0 }, sourceAnchor: 'data-slot="s001"', currentValue: 'orig', replacement: { kind: 'text', value: 'SWAPPED BUILD TEXT' }, flags: [] },
      { number: 2, stableId: 't2', type: 'text', role: 'content', provenance: 'original', mirrorLocator: { cssPath: '.hero-sub', nth: 0 }, sourceAnchor: 'data-slot="s002"', currentValue: 'sub', keep: true, flags: [] },
    ],
  };
}
async function setup(m) {
  await rmwork(); await mkdir(repurpose, { recursive: true });
  await writeFile(repurpose + 'manifest.json', JSON.stringify(m, null, 2));
  await writeFile(repurpose + 'build-fingerprint.json', JSON.stringify({ buildId: 'b', crawlLogHash: 'c' }));
}
function run(args) { return spawnSync(process.execPath, [applySwaps, '--manifest', repurpose + 'manifest.json', '--mirror', mirror, ...args], { encoding: 'utf8' }); }

test('apply-swaps preview writes swaps.json + lock ledger', async (t) => {
  t.after(rmwork);
  await setup(manifest());
  const r = run(['--target', 'preview']);
  assert.equal(r.status, 0, r.stderr);
  const swaps = JSON.parse(await readFile(repurpose + 'preview/swaps.json', 'utf8'));
  assert.ok(swaps.swaps.find((s) => s.number === 1 && s.op === 'replace-text'));
  assert.ok(swaps.swaps.find((s) => s.number === 2 && s.op === 'keep'));
  const lock = JSON.parse(await readFile(repurpose + 'manifest.lock.json', 'utf8'));
  assert.ok(Array.isArray(lock.applied) && lock.applied.length === 2);
});

test('apply-swaps dom-derivative builds index.html with swapped text + stripped analytics', async (t) => {
  t.after(rmwork);
  await setup(manifest());
  const r = run(['--target', 'build', '--build-mode', 'dom-derivative']);
  assert.equal(r.status, 0, r.stderr);
  const html = await readFile(repurpose + 'build/index.html', 'utf8');
  assert.match(html, /SWAPPED BUILD TEXT/, 'swapped text present');
  assert.doesNotMatch(html, /G-FIXTURE12/, 'analytics id stripped');
  assert.doesNotMatch(html, /google-site-verification/, 'verification meta stripped');
});

test('apply-swaps clean-room builds a scaffold from sourceAnchors', async (t) => {
  t.after(rmwork);
  await setup(manifest({ structureAuthorization: 'unauthorized' }));
  const r = run(['--target', 'build']); // build-mode auto -> clean-room because unauthorized
  assert.equal(r.status, 0, r.stderr);
  const html = await readFile(repurpose + 'build/index.html', 'utf8');
  assert.match(html, /data-slot="s001"/, 'source anchor present');
  assert.match(html, /SWAPPED BUILD TEXT/, 'user content present');
  assert.match(html, /CLEAN-ROOM SCAFFOLD/, 'clean-room note present');
});

test('apply-swaps refuses on build-fingerprint drift', async (t) => {
  t.after(rmwork);
  await setup(manifest({ buildFingerprint: 'DIFFERENT+hash' }));
  const r = run(['--target', 'preview']);
  assert.equal(r.status, 1, 'drift must block');
  assert.match((r.stderr || '') + (r.stdout || ''), /DRIFT/i);
});
