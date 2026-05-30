import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { rm as _rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const script = fileURLToPath(new URL('../fit-slot.mjs', import.meta.url));
const work = fileURLToPath(new URL('./.work/fit-slot-test/', import.meta.url));
// Windows: sharp may briefly hold a handle on a just-written file → EBUSY on immediate unlink. Retry.
const rm = (p) => _rm(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });

function manifestObj() {
  return {
    meta: { target: 'https://x.test', name: 't', schemaVersion: '1.0', buildFingerprint: 'b+c', viewports: [390, 1440], structureAuthorization: 'unset' },
    slots: [{
      number: 1, stableId: 'i1', type: 'img', role: 'content', provenance: 'original', mirrorLocator: { cssPath: 'img', nth: 0 },
      slotSpec: {
        '390': { w: 390, h: 260, fit: 'cover', focal: [0.5, 0.4], format: 'webp', maxBytes: 90000 },
        '1440': { w: 1440, h: 810, fit: 'cover', focal: [0.5, 0.4], format: 'webp', maxBytes: 320000 },
      }, flags: [],
    }],
  };
}

test('fit-slot emits a responsive webp/avif set with exact per-viewport dims', async () => {
  await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });
  const png = work + 'src.png';
  await sharp({ create: { width: 2000, height: 1200, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toFile(png);
  const manifest = work + 'manifest.json'; await writeFile(manifest, JSON.stringify(manifestObj()));
  const r = spawnSync(process.execPath, [script, '--slot', '1', '--in', png, '--manifest', manifest, '--out', work + 'assets'], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'fit-slot exit: ' + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.degraded, false);
  assert.match(out.srcsetHtml, /<picture/);
  assert.match(out.srcsetHtml, /image\/avif/);
  const m1440 = await sharp(work + 'assets/slot-1/fill.1440.webp').metadata();
  assert.equal(m1440.width, 1440); assert.equal(m1440.height, 810); assert.equal(m1440.format, 'webp');
  const m390 = await sharp(work + 'assets/slot-1/fill.390.webp').metadata();
  assert.equal(m390.width, 390); assert.equal(m390.height, 260);
  // weight budget respected
  const fs = await import('node:fs/promises');
  const sz = (await fs.stat(work + 'assets/slot-1/fill.1440.webp')).size;
  assert.ok(sz <= 320000, 'within maxBytes, got ' + sz);
  await rm(work, { recursive: true, force: true });
});

test('fit-slot passes an svg through losslessly (no raster)', async () => {
  await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });
  const svg = work + 'logo.svg';
  await writeFile(svg, '<!-- c --><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  const m = manifestObj(); m.slots[0].type = 'svg';
  const manifest = work + 'manifest.json'; await writeFile(manifest, JSON.stringify(m));
  const r = spawnSync(process.execPath, [script, '--slot', '1', '--in', svg, '--manifest', manifest, '--out', work + 'assets'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.assetRef, /\.svg$/);
  await rm(work, { recursive: true, force: true });
});
