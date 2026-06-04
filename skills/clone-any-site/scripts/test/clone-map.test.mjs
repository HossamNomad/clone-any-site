import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {}

const HERE = dirname(fileURLToPath(import.meta.url));
const { buildMap } = await import('../clone-map.mjs');

// deterministic fixture clone in os tmpdir
import os from 'node:os';
const ROOT = join(os.tmpdir(), 'cl-map-test');
const CLONE = join(ROOT, 'clone');
const MIRROR = join(CLONE, 'mirror', 'host');

after(() => rm(ROOT, { recursive: true, force: true }).catch(() => {}));

const PX =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>@keyframes p{to{opacity:.4}} .anim{animation:p 2s infinite}</style></head>
<body>
<h1 class="title">Hello</h1>
<img class="hero" src="${PX}" width="300" height="200">
<video class="bg anim" width="320" height="180"></video>
</body></html>`;

const MAP = {
  meta: { url: '/index.html', count: 3 },
  slots: [
    {
      id: 'TITLE-1',
      type: 'title',
      color: '#ff9500',
      role: 'hook',
      text: 'Hello',
      where: { cssPath: 'h1.title', arcRatio: 0.02 }
    },
    {
      id: 'IMG-1',
      type: 'image',
      color: '#2b6cff',
      role: 'proof',
      where: { cssPath: 'img.hero', arcRatio: 0.3 }
    },
    {
      id: 'VID-1',
      type: 'video',
      color: '#ff3b30',
      role: 'immersion',
      where: { cssPath: 'video.bg', arcRatio: 0.6 }
    }
  ]
};

test(
  'buildMap writes visual map + manual + anim-lock with correct content',
  { skip: !chromium ? 'no playwright' : false, timeout: 120000 },
  async () => {
    await mkdir(MIRROR, { recursive: true });
    await writeFile(join(MIRROR, 'index.html'), PAGE);
    await mkdir(join(CLONE, 'repurpose'), { recursive: true });
    await writeFile(join(CLONE, 'repurpose', 'MAP.json'), JSON.stringify(MAP));

    const r = await buildMap(CLONE, { mirror: MIRROR, entry: '/index.html', now: 'X' });

    // all artifacts exist
    const visualHtml = join(CLONE, 'repurpose', 'VISUAL-MAP.html');
    const visualPng = join(CLONE, 'repurpose', 'VISUAL-MAP.png');
    const manualMd = join(CLONE, 'repurpose', 'MANUAL.md');
    const manualHtml = join(CLONE, 'repurpose', 'MANUAL.html');
    const animLock = join(CLONE, 'repurpose', 'ANIM-LOCK.json');
    assert.ok(existsSync(visualHtml), 'VISUAL-MAP.html exists');
    assert.ok(existsSync(visualPng), 'VISUAL-MAP.png exists');
    assert.ok(existsSync(manualMd), 'MANUAL.md exists');
    assert.ok(existsSync(manualHtml), 'MANUAL.html exists');
    assert.ok(existsSync(animLock), 'ANIM-LOCK.json exists');

    // returned paths line up
    assert.equal(r.visualMap, visualHtml);
    assert.equal(r.manual, manualMd);
    assert.equal(r.animLock, animLock);

    // MANUAL.md mentions tags + a drop instruction
    const md = await readFile(manualMd, 'utf8');
    assert.ok(md.includes('IMG-1'), 'MANUAL mentions IMG-1');
    assert.ok(md.includes('VID-1'), 'MANUAL mentions VID-1');
    assert.ok(
      md.includes('clones/clone/swaps/') && md.includes('drop'),
      'MANUAL has a drop instruction'
    );

    // VISUAL-MAP.html has the IMG-1 badge markup
    const vh = await readFile(visualHtml, 'utf8');
    assert.ok(
      /class="cm-badge"[^>]*data-id="IMG-1"/.test(vh),
      'VISUAL-MAP.html has IMG-1 badge'
    );

    // ANIM-LOCK baseline captured the css animation
    const lock = JSON.parse(await readFile(animLock, 'utf8'));
    assert.ok(lock.baseline, 'baseline present');
    assert.ok(lock.baseline.cssAnim >= 1, 'baseline cssAnim >= 1');
    assert.equal(lock.generatedAtRef, 'X', 'deterministic stamp passed through');

    // sanity on the placement counts
    assert.equal(r.slotsWithRect, 3, 'all 3 slots located');
    assert.equal(r.slotsMissing, 0, 'no missing slots');
  }
);
