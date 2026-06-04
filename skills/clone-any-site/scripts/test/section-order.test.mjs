// section-order.test.mjs — section REORDER: the set-section op stores a reversible `order` index on a section
// slot (manifest-only, no provenance/replacement touch), validate accepts it, and the DOM-derivative BUILD
// permutes the sibling <section>s into the requested order while keeping non-section content in place.
// HTTP for the op (fast); apply-swaps' own Chromium for the build (skips without playwright).
//
// node --test section-order.test.mjs

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
const WORK = join(SCRIPTS, 'test', '.work', 'section-order');
const MIRROR = join(WORK, 'mirror');
const REPURPOSE = join(WORK, 'repurpose');
const MANIFEST = join(REPURPOSE, 'manifest.json');
const BUILD = join(REPURPOSE, 'build');
const NOW = '2026-06-01T00:00:00.000Z';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip the build test */ }

// three sibling sections A,B,C + a footer that must stay last
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ord</title></head>
<body>
<section class="a" data-cl-id="cl-a"><p data-cl-id="cl-pa">Alpha</p></section>
<section class="b" data-cl-id="cl-b"><p data-cl-id="cl-pb">Bravo</p></section>
<section class="c" data-cl-id="cl-c"><p data-cl-id="cl-pc">Charlie</p></section>
<footer class="f">footer stays last</footer>
</body></html>`;

function manifest() {
  return {
    meta: { target: 'https://x.test', name: 'ord', schemaVersion: '1.1', buildFingerprint: 'bf+', crawlLogHash: '', viewports: [390, 1440], structureAuthorization: 'authorized', counts: {} },
    slots: [
      { number: 1, stableId: 's1', clId: 'cl-a', type: 'section', role: 'content', provenance: 'original', keep: true, replacement: null, mirrorLocator: { clId: 'cl-a', cssPath: '.a', nth: 0 }, currentValue: 'A', flags: [] },
      { number: 2, stableId: 's2', clId: 'cl-b', type: 'section', role: 'content', provenance: 'original', keep: true, replacement: null, mirrorLocator: { clId: 'cl-b', cssPath: '.b', nth: 0 }, currentValue: 'B', flags: [] },
      { number: 3, stableId: 's3', clId: 'cl-c', type: 'section', role: 'content', provenance: 'original', keep: true, replacement: null, mirrorLocator: { clId: 'cl-c', cssPath: '.c', nth: 0 }, currentValue: 'C', flags: [] },
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

test('set-section stores order (manifest-only, no provenance flip, no replacement touched)', async () => {
  const r = await req(port, '/__clone/slot', { number: 3, op: 'set-section', section: { order: 0 } });
  assert.equal(r.code, 200, JSON.stringify(r.json));
  const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const s3 = m.slots.find((s) => s.number === 3);
  assert.equal(s3.section.order, 0, 'section.order persisted');
  assert.equal(s3.provenance, 'original', 'provenance NOT flipped (layout metadata)');
  assert.equal(s3.replacement, null, 'replacement untouched');
});

test('validate accepts integer order, rejects a non-integer order', async () => {
  const ok = manifest(); ok.slots[0].section = { order: 2 };
  await writeFile(MANIFEST, JSON.stringify(ok, null, 2));
  const v = spawnSync(process.execPath, [VALIDATE, '--manifest', MANIFEST], { encoding: 'utf8' });
  assert.equal(v.status, 0, 'integer order OK: ' + (v.stdout || '') + (v.stderr || ''));

  const bad = manifest(); bad.slots[0].section = { order: 'first' };
  await writeFile(MANIFEST, JSON.stringify(bad, null, 2));
  const v2 = spawnSync(process.execPath, [VALIDATE, '--manifest', MANIFEST], { encoding: 'utf8' });
  assert.equal(v2.status, 1, 'non-integer order rejected');
  assert.match((v2.stdout || '') + (v2.stderr || ''), /order must be an integer/);
  // restore a clean manifest for the build test
  await writeFile(MANIFEST, JSON.stringify(manifest(), null, 2));
});

test('build: sibling sections are permuted into order C,A,B; footer stays last; content survives', { skip: !chromium ? 'playwright not installed' : false }, async () => {
  // request order C(0), A(1), B(2)
  const m = manifest();
  m.slots[2].section = { order: 0 }; // C first
  m.slots[0].section = { order: 1 }; // A second
  m.slots[1].section = { order: 2 }; // B third
  await writeFile(MANIFEST, JSON.stringify(m, null, 2));
  const b = spawnSync(process.execPath, [APPLY, '--manifest', MANIFEST, '--mirror', MIRROR, '--target', 'build', '--build-mode', 'dom-derivative', '--now', NOW], { encoding: 'utf8', timeout: 120000 });
  assert.equal(b.status, 0, 'build exited 0: ' + (b.stderr || '').slice(-300));
  const html = await readFile(join(BUILD, 'index.html'), 'utf8');
  const order = ['a', 'b', 'c'].map((k) => html.indexOf('class="' + k + '"'));
  const [a, bb, c] = order;
  assert.ok(c < a && a < bb, `sections reordered to C,A,B (idx c=${c} a=${a} b=${bb})`);
  assert.ok(html.indexOf('class="f"') > Math.max(a, bb, c), 'footer (non-section) stays after the sections');
  assert.match(html, /Alpha/); assert.match(html, /Bravo/); assert.match(html, /Charlie/);
});
