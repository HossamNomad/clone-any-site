// section.test.mjs — section hide/show: the set-section op stores reversible visibility on a section slot
// (manifest-only, never touches replacement/provenance), clear drops it, validate accepts it, and the
// DOM-derivative BUILD emits display:none for a hidden section so it's dropped from the shipped page.
// HTTP for the op (fast), apply-swaps' own Chromium for the build (skips without playwright).
//
// node --test section.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const SERVE = join(SCRIPTS, 'serve.mjs');
const VALIDATE = join(SCRIPTS, 'validate-manifest.mjs');
const APPLY = join(SCRIPTS, 'apply-swaps.mjs');
const WORK = join(SCRIPTS, 'test', '.work', 'section');
const MIRROR = join(WORK, 'mirror');
const REPURPOSE = join(WORK, 'repurpose');
const MANIFEST = join(REPURPOSE, 'manifest.json');
const BUILD = join(REPURPOSE, 'build');
const NOW = '2026-05-31T00:00:00.000Z';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip the build test */ }

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>sec</title></head>
<body>
<section class="keep" data-cl-id="cl-keep"><h1 class="t" data-cl-id="cl-t">Keep me</h1></section>
<section class="drop" data-cl-id="cl-drop"><p data-cl-id="cl-p">Drop this whole section</p></section>
</body></html>`;

function manifest() {
  return {
    meta: { target: 'https://x.test', name: 'sec', schemaVersion: '1.1', buildFingerprint: 'bf+', crawlLogHash: '', viewports: [390, 1440], structureAuthorization: 'authorized', counts: {} },
    slots: [
      { number: 1, stableId: 's1', clId: 'cl-keep', type: 'section', role: 'content', provenance: 'original', keep: true, replacement: null, mirrorLocator: { clId: 'cl-keep', cssPath: '.keep', nth: 0 }, currentValue: 'section', flags: [] },
      { number: 2, stableId: 's2', clId: 'cl-drop', type: 'section', role: 'content', provenance: 'original', keep: true, replacement: null, mirrorLocator: { clId: 'cl-drop', cssPath: '.drop', nth: 0 }, currentValue: 'section', flags: [] },
      { number: 3, stableId: 't3', clId: 'cl-t', type: 'text', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-t', cssPath: '.t', nth: 0 }, currentValue: 'Keep me', flags: [], replacement: { kind: 'text', value: 'Kept + edited' } },
    ],
  };
}

function req(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = { _raw: buf }; } resolve({ code: res.statusCode, json: j }); });
    });
    r.on('error', reject); r.write(data); r.end();
  });
}
let port, proc;
before(async () => {
  await rm(WORK, { recursive: true, force: true }).catch(() => {});
  await mkdir(MIRROR, { recursive: true }); await writeFile(join(MIRROR, 'index.html'), PAGE);
  await mkdir(REPURPOSE, { recursive: true }); await writeFile(MANIFEST, JSON.stringify(manifest(), null, 2));
  await writeFile(join(REPURPOSE, 'build-fingerprint.json'), JSON.stringify({ buildId: 'bf', crawlLogHash: '' }));
  port = await new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [SERVE, MIRROR], { env: { ...process.env, CLONE_SERVE_PORT: '0', CLONE_EDIT: '1', CLONE_LOOPBACK_OK: '1', CLONE_REPURPOSE_DIR: REPURPOSE }, stdio: ['ignore', 'pipe', 'ignore'] });
    let b = ''; const to = setTimeout(() => reject(new Error('boot timeout')), 15000);
    proc.stdout.on('data', (d) => { b += d.toString(); const m = b.match(/CLONE_PORT=(\d+)/); if (m) { clearTimeout(to); resolve(+m[1]); } });
    proc.on('error', reject);
  });
});
after(() => { if (proc) try { proc.kill(); } catch {} });

test('set-section hides a section slot (manifest-only, no provenance flip, no replacement touched)', async () => {
  const r = await req(port, '/__clone/slot', { number: 2, op: 'set-section', section: { hidden: true } });
  assert.equal(r.code, 200, JSON.stringify(r.json));
  const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const s2 = m.slots.find((s) => s.number === 2);
  assert.equal(s2.section.hidden, true, 'section.hidden persisted');
  assert.equal(s2.provenance, 'original', 'provenance NOT flipped (layout metadata, not content)');
  assert.equal(s2.replacement, null, 'replacement untouched');
});

test('set-section rejected on a non-section slot', async () => {
  const r = await req(port, '/__clone/slot', { number: 3, op: 'set-section', section: { hidden: true } });
  assert.equal(r.code, 400, 'text slot → unknown op (applySlotOp returns false)');
});

test('clear drops the section override', async () => {
  await req(port, '/__clone/slot', { number: 2, op: 'set-section', section: { hidden: true } });
  const r = await req(port, '/__clone/slot', { number: 2, op: 'clear' });
  assert.equal(r.code, 200);
  const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
  assert.ok(!m.slots.find((s) => s.number === 2).section, 'section override removed on clear');
});

test('validate accepts a hidden section', async () => {
  const m = manifest(); m.slots[1].section = { hidden: true };
  await writeFile(MANIFEST, JSON.stringify(m, null, 2));
  const v = spawnSync(process.execPath, [VALIDATE, '--manifest', MANIFEST], { encoding: 'utf8' });
  assert.equal(v.status, 0, 'validate OK with section.hidden: ' + (v.stdout || '') + (v.stderr || ''));
});

test('build: a hidden section is display:none in the shipped HTML (dropped), kept section + its edit survive', { skip: !chromium ? 'playwright not installed' : false }, async () => {
  const m = manifest(); m.slots[1].section = { hidden: true };   // hide section #2
  await writeFile(MANIFEST, JSON.stringify(m, null, 2));
  const b = spawnSync(process.execPath, [APPLY, '--manifest', MANIFEST, '--mirror', MIRROR, '--target', 'build', '--build-mode', 'dom-derivative', '--now', NOW], { encoding: 'utf8', timeout: 120000 });
  assert.equal(b.status, 0, 'build exited 0: ' + (b.stderr || '').slice(-300));
  const html = await readFile(join(BUILD, 'index.html'), 'utf8');
  const drop = (html.match(/<section class="drop"[^>]*>/i) || [''])[0];
  assert.match(drop, /display:\s*none/i, 'hidden section carries display:none in the build: ' + drop);
  assert.match(html, /class="keep"/, 'kept section still present');
  assert.match(html, /Kept \+ edited/, 'edit inside the kept section survived');
});
