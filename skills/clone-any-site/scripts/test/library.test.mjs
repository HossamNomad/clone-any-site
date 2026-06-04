// library.test.mjs — asset library round-trip: upload an image to slot A → it appears in GET /__clone/library
// → library-apply that same asset to slot B WITHOUT re-uploading, re-fit to B's slot dir. Content-addressed id
// dedupes re-uploads. Zero-dep over HTTP; works even when sharp is absent (fit-slot degrades but still returns
// an assetRef + the library index still populates). Ephemeral port read back from stdout (anti-zombie).
//
// node --test library.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const SERVE = join(SCRIPTS, 'serve.mjs');
const MIRROR = join(SCRIPTS, 'test', '.work', 'library', 'mirror');
const REPURPOSE = join(SCRIPTS, 'test', '.work', 'library', 'repurpose');
const MANIFEST = join(REPURPOSE, 'manifest.json');
const LIB = join(REPURPOSE, 'assets', '_library', 'index.json');

// 1x1 PNG (valid; fit-slot can copy it even without sharp)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/1eRAAAAAElFTkSuQmCC';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>lib</title></head>
<body><img class="a" data-cl-id="cl-a" src="/img/a.png" width="100" height="100" alt="a">
<img class="b" data-cl-id="cl-b" src="/img/b.png" width="100" height="100" alt="b"></body></html>`;

function manifest() {
  return {
    meta: { target: 'https://x.test', name: 'lib', schemaVersion: '1.1', buildFingerprint: 'bf', viewports: [390, 1440], structureAuthorization: 'unset', counts: {} },
    slots: [
      { number: 1, stableId: 'a1', clId: 'cl-a', type: 'img', subtype: 'plain', role: 'content', provenance: 'original', keep: false, replacement: null, mirrorLocator: { clId: 'cl-a', cssPath: '.a', nth: 0 }, currentValue: 'a', srcsetSpec: { kind: 'plain' }, slotSpec: { '390': { w: 100, h: 100, fit: 'cover', focal: [0.5, 0.5], format: 'webp' } }, flags: [] },
      { number: 2, stableId: 'b2', clId: 'cl-b', type: 'img', subtype: 'plain', role: 'content', provenance: 'original', keep: false, replacement: null, mirrorLocator: { clId: 'cl-b', cssPath: '.b', nth: 0 }, currentValue: 'b', srcsetSpec: { kind: 'plain' }, slotSpec: { '390': { w: 100, h: 100, fit: 'cover', focal: [0.5, 0.5], format: 'webp' } }, flags: [] },
    ],
  };
}

function req(method, port, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = { _raw: buf }; } resolve({ code: res.statusCode, json: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

let port, proc;
before(async () => {
  await rm(join(SCRIPTS, 'test', '.work', 'library'), { recursive: true, force: true }).catch(() => {});
  await mkdir(MIRROR, { recursive: true }); await writeFile(join(MIRROR, 'index.html'), PAGE);
  await mkdir(REPURPOSE, { recursive: true }); await writeFile(MANIFEST, JSON.stringify(manifest(), null, 2));
  port = await new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [SERVE, MIRROR], { env: { ...process.env, CLONE_SERVE_PORT: '0', CLONE_EDIT: '1', CLONE_LOOPBACK_OK: '1', CLONE_REPURPOSE_DIR: REPURPOSE }, stdio: ['ignore', 'pipe', 'ignore'] });
    let b = ''; const to = setTimeout(() => reject(new Error('boot timeout')), 15000);
    proc.stdout.on('data', (d) => { b += d.toString(); const m = b.match(/CLONE_PORT=(\d+)/); if (m) { clearTimeout(to); resolve(+m[1]); } });
    proc.on('error', reject);
  });
});
after(() => { if (proc) try { proc.kill(); } catch {} });

test('library: upload → appears in /library → library-apply reuses it on another slot (no re-upload)', async () => {
  // 1) upload to slot #1
  const up = await req('POST', port, '/__clone/upload', { number: 1, filename: 'logo.png', mime: 'image/png', dataBase64: PNG_B64 });
  assert.equal(up.code, 200, 'upload ok: ' + JSON.stringify(up.json));
  assert.ok(up.json.assetRef && /slot-1\b/.test(up.json.assetRef), 'slot-1 asset: ' + up.json.assetRef);

  // 2) the library index now has exactly one content-addressed item with a preview
  const lib = await req('GET', port, '/__clone/library');
  assert.equal(lib.code, 200);
  assert.equal(lib.json.items.length, 1, 'one library item');
  const item = lib.json.items[0];
  assert.ok(item.id && item.id.length >= 8, 'has content id');
  assert.ok(item.previewRef && /slot-1\b/.test(item.previewRef), 'preview points at the first fit');

  // 3) re-apply the SAME asset to slot #2 — no bytes re-sent — and it re-fits into slot-2's dir
  const ap = await req('POST', port, '/__clone/library-apply', { number: 2, libraryId: item.id });
  assert.equal(ap.code, 200, 'library-apply ok: ' + JSON.stringify(ap.json));
  assert.ok(ap.json.assetRef && /slot-2\b/.test(ap.json.assetRef), 're-fit into slot-2: ' + ap.json.assetRef);

  // 4) the raw bytes were stored content-addressed under the library id (so reuse never re-uploads)
  const idx = JSON.parse(await readFile(LIB, 'utf8'));
  assert.ok(idx.items[0].raw.includes(item.id), 'raw stored under content id: ' + idx.items[0].raw);
});

test('library: same bytes uploaded twice dedupe to ONE item', async () => {
  await req('POST', port, '/__clone/upload', { number: 1, filename: 'again.png', mime: 'image/png', dataBase64: PNG_B64 });
  const lib = await req('GET', port, '/__clone/library');
  assert.equal(lib.json.items.length, 1, 'identical bytes → still one library item (content-addressed dedup)');
});

test('library-apply needs the loopback arm (403 without CLONE_LOOPBACK_OK is covered by serve-edit; here just bad input)', async () => {
  const bad = await req('POST', port, '/__clone/library-apply', { number: 2 });   // missing libraryId
  assert.equal(bad.code, 400, 'missing libraryId → 400');
});
