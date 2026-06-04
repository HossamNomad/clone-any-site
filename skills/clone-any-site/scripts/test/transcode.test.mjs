import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { transcodeImage, transcodeVideo } from '../transcode.mjs';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const HERE = dirname(fileURLToPath(import.meta.url)); const WORK = join(HERE, '.work', 'transcode');
after(()=>rm(WORK,{recursive:true,force:true}).catch(()=>{}));

test('transcodeImage outputs webp at the target width', async () => {
  await mkdir(WORK,{recursive:true});
  const src = join(WORK,'src.png'); await sharp({create:{width:1000,height:500,channels:3,background:'#f00'}}).png().toFile(src);
  const dst = join(WORK,'out.webp'); await transcodeImage(src, dst, { w: 400, h: 200 });
  const meta = await sharp(dst).metadata(); assert.equal(meta.format,'webp'); assert.equal(meta.width,400);
});

test('transcodeVideo writes a faststart mp4 (moov before mdat)', async () => {
  await mkdir(WORK,{recursive:true});
  const dst = join(WORK,'out.mp4'); await transcodeVideo('testsrc2', dst, { w: 320, h: 240, lavfi: true });
  const buf = await readFile(dst); const head = buf.slice(0, 200000).toString('latin1');
  assert.ok(head.indexOf('moov') > -1 && head.indexOf('moov') < head.indexOf('mdat'), 'moov before mdat');
});
