// publish-loop.test.mjs — the END-TO-END "tested et shippé" proof: a repurposed clone goes edit → manifest
// → apply-swaps (DOM-derivative publishable build) → publish-gate (the single IP exit) → PASS + NOTICE.
// Proves the CONNECTED pipeline, not just each unit. Real Chromium via apply-swaps; deterministic --now.
// Skips cleanly without chromium.
//
// node --test publish-loop.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const APPLY = join(SCRIPTS, 'apply-swaps.mjs');
const GATE = join(SCRIPTS, 'publish-gate.mjs');
const WORK = join(SCRIPTS, 'test', '.work', 'publish-loop');
const MIRROR = join(WORK, 'mirror');
const REPURPOSE = join(WORK, 'repurpose');
const MANIFEST = join(REPURPOSE, 'manifest.json');
const BUILD = join(REPURPOSE, 'build');
const NOW = '2026-05-31T00:00:00.000Z';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip */ }

// a small but realistic page: brand link, headline, a CTA link, a hero <img srcset>. No analytics, no paid
// fonts → the gate's mechanical scans stay clean once every content slot is yours.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Original Brand</title>
<meta name="description" content="original description"><link rel="canonical" href="https://original.example/"></head>
<body>
<header><a class="brand" data-cl-id="cl-brand" href="https://original.example/">Original</a></header>
<h1 class="hl" data-cl-id="cl-hl">Original Headline</h1>
<a class="cta" data-cl-id="cl-cta" href="https://original.example/buy">Buy on Original</a>
<img class="hero" data-cl-id="cl-hero" src="/img/hero.png" srcset="/img/hero-390.png 390w, /img/hero-1440.png 1440w" sizes="100vw" width="1200" height="600" alt="original hero">
</body></html>`;

// every content slot is REPLACED → zero retained originals → the gate has nothing to block on (with an
// authorized structure attestation). This is what a finished repurpose looks like.
function manifest() {
  return {
    meta: { target: 'https://original.example', name: 'loop', schemaVersion: '1.1', buildFingerprint: 'bf-loop+', crawlLogHash: '', viewports: [390, 1440], structureAuthorization: 'unset',
      seo: { original: { title: 'Original Brand', description: 'original description', canonical: 'https://original.example/' },
             replacement: { title: 'Pulsia — Reset Protocol', description: 'Contrast performance architecture.', canonical: 'https://pulsia.example/' } }, counts: {} },
    slots: [
      { number: 1, stableId: 'b1', clId: 'cl-brand', type: 'text', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-brand', cssPath: '.brand', nth: 0 }, currentValue: 'Original', href: 'https://original.example/', flags: [], replacement: { kind: 'link', value: 'Pulsia', href: 'https://pulsia.example/' } },
      { number: 2, stableId: 'h2', clId: 'cl-hl', type: 'text', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-hl', cssPath: '.hl', nth: 0 }, currentValue: 'Original Headline', flags: [], replacement: { kind: 'text', value: 'The ultimate luxury is silence' } },
      { number: 3, stableId: 'c3', clId: 'cl-cta', type: 'text', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-cta', cssPath: '.cta', nth: 0 }, currentValue: 'Buy on Original', href: 'https://original.example/buy', flags: [], replacement: { kind: 'link', value: 'Apply now', href: 'https://pulsia.example/apply' } },
      { number: 4, stableId: 'i4', clId: 'cl-hero', type: 'img', subtype: 'srcset', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-hero', cssPath: '.hero', nth: 0 }, currentValue: 'hero', srcsetSpec: { kind: 'img-srcset', sizes: '100vw' }, flags: [], altReplacement: 'Pulsia — sunrise freedive', replacement: { kind: 'asset', assetRef: 'assets/slot-4/fill.webp', srcset: '/assets/slot-4/fill.390.webp 390w, /assets/slot-4/fill.1440.webp 1440w' } },
    ],
  };
}

before(async () => {
  if (!chromium) return;
  await rm(WORK, { recursive: true, force: true }).catch(() => {});
  await mkdir(MIRROR, { recursive: true });
  await writeFile(join(MIRROR, 'index.html'), PAGE);
  await mkdir(REPURPOSE, { recursive: true });
  await writeFile(MANIFEST, JSON.stringify(manifest(), null, 2));
  // build-fingerprint.json: the gate composes "<buildId>+<crawlLogHash>" and compares to meta.buildFingerprint.
  await writeFile(join(REPURPOSE, 'build-fingerprint.json'), JSON.stringify({ buildId: 'bf-loop', crawlLogHash: '' }));
  const PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/1eRAAAAAElFTkSuQmCC', 'base64');
  const p = join(REPURPOSE, 'assets/slot-4/fill.webp'); await mkdir(dirname(p), { recursive: true }); await writeFile(p, PX);
});
after(async () => { await rm(WORK, { recursive: true, force: true }).catch(() => {}); });

test('publish loop: edit → apply-swaps build → publish-gate PASS (shipped page is YOURS)', { skip: !chromium ? 'playwright not installed' : false }, async () => {
  // 1) BUILD the publishable DOM-derivative
  const b = spawnSync(process.execPath, [APPLY, '--manifest', MANIFEST, '--mirror', MIRROR, '--target', 'build', '--build-mode', 'dom-derivative', '--now', NOW], { encoding: 'utf8', timeout: 120000 });
  assert.equal(b.status, 0, 'apply-swaps build exited 0: ' + (b.stderr || '').slice(-300));
  const html = await readFile(join(BUILD, 'index.html'), 'utf8');
  // the shipped page carries YOUR content end-to-end
  assert.match(html, /The ultimate luxury is silence/, 'headline shipped');
  assert.match(html, /<title>Pulsia — Reset Protocol<\/title>/, 'your title shipped');
  assert.match(html, /pulsia\.example\/apply/, 'your CTA link shipped');
  assert.ok(!/original\.example/.test(html), 'NO original-domain link/canonical remains in the shipped HTML');
  assert.match(html, /alt="Pulsia — sunrise freedive"/, 'your alt shipped');

  // 2) GATE it. Structure authorized; zero retained originals (all slots replaced) → expect PASS.
  const attest = JSON.stringify({ structureAuthorization: 'authorized', by: 'test', slots: {} });
  const g = spawnSync(process.execPath, [GATE, '--manifest', MANIFEST, '--build', BUILD, '--interactive', '--now', NOW], { input: attest, encoding: 'utf8', timeout: 60000 });
  const gOut = (g.stdout || '') + (g.stderr || '');
  assert.equal(g.status, 0, 'publish-gate PASS (exit 0). Got ' + g.status + ' :: ' + gOut.slice(-500));

  // 3) the gate wrote a NOTICE into the build → it is publishable
  const noticeOk = await stat(join(BUILD, 'NOTICE')).then(() => true).catch(() => false);
  assert.ok(noticeOk, 'publish-gate wrote a NOTICE (build is publishable)');
});

test('publish loop: gate BLOCKS a retained original (safety backstop intact)', { skip: !chromium ? 'playwright not installed' : false }, async () => {
  // strip one slot's replacement → it becomes a retained original; without per-slot authorization the gate must BLOCK.
  const m = manifest();
  m.slots[1].replacement = null; m.slots[1].provenance = 'original';   // headline reverts to original
  await writeFile(MANIFEST, JSON.stringify(m, null, 2));
  const attest = JSON.stringify({ structureAuthorization: 'authorized', by: 'test', slots: {} });   // no #2 authorization
  const g = spawnSync(process.execPath, [GATE, '--manifest', MANIFEST, '--build', BUILD, '--interactive', '--now', NOW], { input: attest, encoding: 'utf8', timeout: 60000 });
  const gOut = (g.stdout || '') + (g.stderr || '');
  assert.notEqual(g.status, 0, 'gate must BLOCK a retained original');
  assert.match(gOut, /BLOCK|retained/i, 'gate reports the retained original');
  await writeFile(MANIFEST, JSON.stringify(manifest(), null, 2));   // restore for any later runs
});
