// encode-recipes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { probeMedia, encodeImage, encodeVideo, makeTestVideo } from '../lib/encode-recipes.mjs';

// Deterministic temp work dir (no random names).
const WORK = join(tmpdir(), 'cl-encode-test');

test('setup: clean deterministic work dir', async () => {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
});

test('encodeVideo preserves timing (sync) + writes mp4 + poster', async () => {
  const srcMp4 = join(WORK, 'src.mp4');
  const outMp4 = join(WORK, 'out.mp4');
  const poster = join(WORK, 'poster.webp');

  await makeTestVideo(srcMp4, { seconds: 3, fps: 25 });
  const result = await encodeVideo(srcMp4, outMp4, poster);

  assert.ok(existsSync(outMp4), 'output mp4 exists');
  assert.ok(existsSync(poster), 'poster exists');
  assert.equal(result.syncOk, true, 'timing preserved (syncOk)');
  assert.ok(Math.abs(result.durOut - 3) < 0.2, `durOut ~3s (got ${result.durOut})`);
  assert.equal(result.fpsOut, 25, `fpsOut === 25 (got ${result.fpsOut})`);
  assert.ok(result.bytes > 0, 'output has bytes');
});

test('encodeImage encodes static png -> resized webp', async () => {
  const srcPng = join(WORK, 'solid.png');
  const outWebp = join(WORK, 'solid.webp');

  await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 20, g: 40, b: 80 } } })
    .png()
    .toFile(srcPng);

  const result = await encodeImage(srcPng, outWebp, { maxWidth: 400 });

  assert.ok(existsSync(outWebp), 'output webp exists');
  assert.ok(result.width <= 400, `width <= 400 (got ${result.width})`);
  assert.equal(result.animated, false, 'not animated');
  assert.ok(result.bytes > 0, 'output has bytes');
});

test('probeMedia parses fps/duration/dims from r_frame_rate', async () => {
  const srcMp4 = join(WORK, 'probe.mp4');
  await makeTestVideo(srcMp4, { seconds: 2, w: 320, h: 240, fps: 30 });
  const m = await probeMedia(srcMp4);
  assert.equal(Math.round(m.fps), 30, `fps ~30 (got ${m.fps})`);
  assert.ok(Math.abs(m.duration - 2) < 0.2, `duration ~2s (got ${m.duration})`);
  assert.equal(m.width, 320);
  assert.equal(m.height, 240);
});
