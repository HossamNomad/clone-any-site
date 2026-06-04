// relocalize-prescroll.test.mjs — locks two freeze companions for premium sites:
//  (1) RELOCALIZE: a hero <img> whose src is a JS-created blob: URL (Contentful blur-up pattern) would be DEAD on
//      reload. The build recovers the real URL from __NEXT_DATA__ and rewrites src so the saved page shows the image.
//  (2) PRE-SCROLL: a below-the-fold element revealed on scroll (IntersectionObserver) is hidden (opacity:0) in a
//      naive top-of-page snapshot. The build drives the page top→bottom→top first, so the reveal fires and persists.
//
// node --test relocalize-prescroll.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const APPLY = join(SCRIPTS, 'apply-swaps.mjs');
const WORK = join(SCRIPTS, 'test', '.work', 'relo');
const NOW = '2026-06-01T00:00:00.000Z';

// a hydrating page with: a hero img set to a blob: URL by JS (real URL only in __NEXT_DATA__), and a below-fold
// element revealed by IntersectionObserver. Exactly the two failure modes premium clones hit on a static freeze.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>relo</title>
<script id="__NEXT_DATA__" type="application/json">{"props":{"assets":[{"url":"//cdn.example.com/hero-real.jpg","title":"hero shot"}]}}</script>
</head><body><div id="__next">
<img id="hero" alt="hero shot" data-cl-id="cl-hero" />
<div style="height:1600px"></div>
<div id="below" data-cl-id="cl-below" style="opacity:0">BELOW FOLD</div>
</div>
<script>
fetch('${PNG}').then(function(r){return r.blob();}).then(function(b){document.getElementById('hero').src=URL.createObjectURL(b);});
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.style.opacity='1';e.target.setAttribute('data-revealed','1');}});});
io.observe(document.getElementById('below'));
</script></body></html>`;

function manifest() {
  return {
    meta: { target: 'https://relo.test', name: 'relo', schemaVersion: '1.1', buildFingerprint: 'bf+', crawlLogHash: '', viewports: [390, 1440], structureAuthorization: 'authorized', counts: {} },
    slots: [{ number: 1, stableId: 'h', clId: 'cl-below', type: 'text', role: 'content', keep: true, provenance: 'original', mirrorLocator: { clId: 'cl-below', cssPath: '#below', nth: 0 }, currentValue: 'BELOW FOLD', flags: [] }],
  };
}

async function build(name, args) {
  const mirror = join(WORK, name, 'mirror'); const rep = join(WORK, name, 'rep');
  await mkdir(mirror, { recursive: true }); await writeFile(join(mirror, 'index.html'), PAGE);
  await mkdir(rep, { recursive: true });
  await writeFile(join(rep, 'manifest.json'), JSON.stringify(manifest(), null, 2));
  await writeFile(join(rep, 'build-fingerprint.json'), JSON.stringify({ buildId: 'bf', crawlLogHash: '' }));
  const r = spawnSync(process.execPath, [APPLY, '--manifest', join(rep, 'manifest.json'), '--mirror', mirror,
    '--target', 'build', '--build-mode', 'dom-derivative', '--freeze', 'on', '--hydrate-ms', '1200', ...args, '--now', NOW],
    { encoding: 'utf8', timeout: 120000 });
  const html = await readFile(join(rep, 'build', 'index.html'), 'utf8').catch(() => '');
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '', html };
}

before(async () => { await rm(WORK, { recursive: true, force: true }).catch(() => {}); });
after(async () => { await rm(WORK, { recursive: true, force: true }).catch(() => {}); });

test('relocalize rewrites a blob: hero src to the real URL from __NEXT_DATA__', async () => {
  const r = await build('on', []);   // relocalize + prescroll default on
  assert.equal(r.status, 0, r.stderr.slice(-300));
  assert.doesNotMatch(r.html, /src="blob:/, 'no dead blob: src remains in the saved page');
  assert.match(r.html, /cdn\.example\.com\/hero-real\.jpg/, 'hero img points at the recovered real URL');
});

test('pre-scroll fires a below-the-fold reveal so it is visible (not opacity:0) in the snapshot', async () => {
  const r = await build('on2', []);
  assert.equal(r.status, 0, r.stderr.slice(-300));
  assert.match(r.html, /id="below"[^>]*data-revealed="1"/, 'the reveal fired during pre-scroll and persisted');
});

test('--relocalize off --prescroll off leaves the blob dead and the reveal hidden (proves the steps did the work)', async () => {
  const r = await build('off', ['--relocalize', 'off', '--prescroll', 'off']);
  assert.equal(r.status, 0, r.stderr.slice(-300));
  // with relocalize off the src is still the blob (or empty) — definitely NOT the recovered URL
  assert.doesNotMatch(r.html, /cdn\.example\.com\/hero-real\.jpg/, 'no relocalization happened');
  assert.doesNotMatch(r.html, /data-revealed="1"/, 'no reveal fired without pre-scroll');
});
