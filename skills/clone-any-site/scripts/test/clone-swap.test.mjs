// clone-swap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { makeTestVideo } from '../lib/encode-recipes.mjs';
import { processDrops } from '../clone-swap.mjs';

// Deterministic temp work dir (no random names).
const ROOT = join(tmpdir(), 'cl-swap-test');
const CLONE = join(ROOT, 'clone');
const SWAPS = join(CLONE, 'swaps');
const GEN = join(SWAPS, '.generated');

async function readJson(p) { return JSON.parse(await readFile(p, 'utf8')); }

test('setup: build fake clone (MAP.json + dropped assets)', async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(CLONE, 'repurpose'), { recursive: true });
  await mkdir(SWAPS, { recursive: true });

  // MAP.json with one image slot + one video slot.
  await writeFile(join(CLONE, 'repurpose', 'MAP.json'), JSON.stringify({
    meta: { name: 'fake' },
    slots: [
      { id: 'IMG-1', type: 'image', where: { cssPath: '.hero' } },
      { id: 'VID-1', type: 'video', where: { cssPath: '.bg' } },
    ],
  }, null, 2));

  // (a) real PNG named after the image slot.
  await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 60, b: 120 } } })
    .png().toFile(join(SWAPS, 'IMG-1.png'));

  // (b) real test video named after the video slot.
  await makeTestVideo(join(SWAPS, 'VID-1.mp4'), { seconds: 2, w: 320, h: 240, fps: 25 });

  // (c) stray FOO-1.jpg — valid filename pattern but no such slot → skipped with warning.
  await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 10, b: 10 } } })
    .jpeg().toFile(join(SWAPS, 'FOO-1.jpg'));

  // (d) notes.md — ignored entirely.
  await writeFile(join(SWAPS, 'notes.md'), '# ignore me');
});

test('processDrops: compresses, registers, moves raws, warns on stray', async () => {
  const res = await processDrops(CLONE, { now: 'X' });

  // compressed outputs exist
  assert.ok(existsSync(join(GEN, 'IMG-1.webp')), '.generated/IMG-1.webp exists');
  assert.ok(existsSync(join(GEN, 'VID-1.mp4')), '.generated/VID-1.mp4 exists');
  assert.ok(existsSync(join(GEN, 'VID-1.poster.webp')), '.generated/VID-1.poster.webp exists');

  // raws moved into .generated and removed from top-level swaps/
  assert.ok(existsSync(join(GEN, 'IMG-1-raw.png')), '.generated/IMG-1-raw.png exists');
  assert.ok(existsSync(join(GEN, 'VID-1-raw.mp4')), '.generated/VID-1-raw.mp4 exists');
  assert.ok(!existsSync(join(SWAPS, 'IMG-1.png')), 'IMG-1.png removed from top-level');
  assert.ok(!existsSync(join(SWAPS, 'VID-1.mp4')), 'VID-1.mp4 removed from top-level');

  // swaps.json entries point at the right files
  const swaps = await readJson(join(SWAPS, 'swaps.json'));
  assert.deepEqual(swaps['IMG-1'], { type: 'image', file: '.generated/IMG-1.webp' });
  assert.deepEqual(swaps['VID-1'], { type: 'video', file: '.generated/VID-1.mp4', poster: '.generated/VID-1.poster.webp' });

  // FOO-1: warning + NO swaps entry, raw left untouched (not a real slot)
  assert.ok(!('FOO-1' in swaps), 'FOO-1 not registered');
  assert.ok(existsSync(join(SWAPS, 'FOO-1.jpg')), 'FOO-1.jpg left in place (skipped)');
  const fooWarn = res.warnings.find((w) => w.file === 'FOO-1.jpg');
  assert.ok(fooWarn, 'FOO-1.jpg produced a warning');

  // notes.md never touched / never warned
  assert.ok(existsSync(join(SWAPS, 'notes.md')), 'notes.md untouched');
  assert.ok(!res.warnings.some((w) => w.file === 'notes.md'), 'notes.md not warned');

  // COMPRESSION-REPORT.json with 2 processed + stamp
  const report = await readJson(join(SWAPS, 'COMPRESSION-REPORT.json'));
  assert.equal(report.generatedAtRef, 'X', 'report uses opts.now stamp');
  assert.equal(report.processed.length, 2, '2 assets processed');
  const tags = report.processed.map((p) => p.tag).sort();
  assert.deepEqual(tags, ['IMG-1', 'VID-1']);
  assert.ok(report.totals.outBytes > 0, 'report totals populated');
});

test('processDrops: idempotent — second run does not crash and keeps entries', async () => {
  const before = await readJson(join(SWAPS, 'swaps.json'));
  const res = await processDrops(CLONE, { now: 'X' });

  const after = await readJson(join(SWAPS, 'swaps.json'));
  assert.deepEqual(after['IMG-1'], before['IMG-1'], 'IMG-1 entry preserved');
  assert.deepEqual(after['VID-1'], before['VID-1'], 'VID-1 entry preserved');

  // raws already moved → nothing new processed (only the still-present FOO-1 warns)
  assert.equal(res.processed.length, 0, 'second run processes nothing new');
});

test('processDrops: preserves a pre-existing hand-edited text entry', async () => {
  const swaps = await readJson(join(SWAPS, 'swaps.json'));
  swaps['TITLE-1'] = { type: 'text', value: 'Hand edited' };
  await writeFile(join(SWAPS, 'swaps.json'), JSON.stringify(swaps, null, 2) + '\n');

  await processDrops(CLONE, { now: 'X' });

  const after = await readJson(join(SWAPS, 'swaps.json'));
  assert.deepEqual(after['TITLE-1'], { type: 'text', value: 'Hand edited' }, 'text entry preserved');
  assert.ok('IMG-1' in after && 'VID-1' in after, 'media entries still present');
});

test('processDrops: missing MAP.json errors clearly', async () => {
  const empty = join(ROOT, 'no-map');
  await mkdir(join(empty, 'swaps'), { recursive: true });
  await assert.rejects(() => processDrops(empty, { now: 'X' }), /MAP\.json not found/);
});
