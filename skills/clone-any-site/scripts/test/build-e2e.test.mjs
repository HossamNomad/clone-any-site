// build-e2e.test.mjs — proves the SHIP path (apply-swaps --target build --build-mode dom-derivative) produces
// a publishable index.html that matches the editor preview: a <picture> swap rebuilds EVERY sibling <source>
// (no stale original wins → no black image in the shipped page), srcset is preserved on a plain <img>, and
// text edits land. Real Chromium via apply-swaps' own Playwright path. Skips cleanly without chromium.
//
// node --test build-e2e.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const APPLY = join(SCRIPTS, 'apply-swaps.mjs');
const WORK = join(SCRIPTS, 'test', '.work', 'build');
const MIRROR = join(WORK, 'mirror');
const REPURPOSE = join(WORK, 'repurpose');
const MANIFEST = join(REPURPOSE, 'manifest.json');
const BUILD = join(REPURPOSE, 'build');

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip */ }

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Original Brand — Shop</title><meta name="description" content="the original site description"><link rel="canonical" href="https://original.example/fr"></head>
<body>
<a class="cta" data-cl-id="cl-cta" href="/fr/shop">Shop Now</a>
<h1 class="title" data-cl-id="cl-title">Old Headline</h1>
<main><img class="hero" data-cl-id="cl-hero" src="/img/hero-1440.png" srcset="/img/hero-390.png 390w, /img/hero-1440.png 1440w" sizes="100vw" width="1200" height="600" alt="hero"></main>
<section class="pwrap"><picture>
<source srcset="/img/pic-390.avif 390w" type="image/avif">
<source srcset="/img/pic-1440.webp 1440w" type="image/webp">
<img class="pic" data-cl-id="cl-pic" src="/img/pic-1440.jpg" width="800" height="400" alt="pic">
</picture></section>
</body></html>`;

function manifest() {
  return {
    meta: { target: 'https://ship.test', name: 'ship', schemaVersion: '1.1', buildFingerprint: 'bf-ship', viewports: [390, 1440], structureAuthorization: 'authorized', seo: { original: { title: 'Original Brand — Shop', description: 'the original site description', canonical: 'https://original.example/fr' }, replacement: { title: 'Pulsia — Reset Protocol', description: 'Contrast performance architecture.', canonical: 'https://pulsia.example/' } }, counts: {} },
    slots: [
      { number: 1, stableId: 't1', clId: 'cl-title', type: 'text', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-title', cssPath: '.title', nth: 0 }, currentValue: 'Old Headline', flags: [], replacement: { kind: 'text', value: 'Shipped Headline' } },
      { number: 4, stableId: 'c4', clId: 'cl-cta', type: 'text', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-cta', cssPath: '.cta', nth: 0 }, currentValue: 'Shop Now', href: '/fr/shop', flags: [], replacement: { kind: 'link', value: 'Apply Now', href: 'https://pulsia.example/apply' } },
      { number: 2, stableId: 'h2', clId: 'cl-hero', type: 'img', subtype: 'srcset', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-hero', cssPath: '.hero', nth: 0 }, currentValue: 'hero', srcsetSpec: { kind: 'img-srcset', sizes: '100vw' }, flags: [], altReplacement: 'Pulsia hero — sunrise freedive', replacement: { kind: 'asset', assetRef: 'assets/slot-2/fill.webp', srcset: '/assets/slot-2/fill.390.webp 390w, /assets/slot-2/fill.1440.webp 1440w' } },
      { number: 3, stableId: 'p3', clId: 'cl-pic', type: 'img', subtype: 'picture', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-pic', cssPath: '.pic', nth: 0 }, currentValue: 'pic', srcsetSpec: { kind: 'picture', sizes: '100vw' }, flags: [], replacement: { kind: 'asset', assetRef: 'assets/slot-3/fill.jpg', srcsetHtml: '<picture><source srcset="/assets/slot-3/fill.768.avif 768w" type="image/avif"><source srcset="/assets/slot-3/fill.768.webp 768w" type="image/webp"><img src="/assets/slot-3/fill.jpg" alt=""></picture>' } },
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
  await writeFile(join(REPURPOSE, 'build-fingerprint.json'), JSON.stringify({ buildFingerprint: 'bf-ship' }));
  // validate-manifest (run by apply-swaps) rejects an orphan replacement.assetRef — so the referenced
  // asset files must exist under repurpose/assets/. A 1x1 PNG is enough; the gate only checks presence.
  const PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/1eRAAAAAElFTkSuQmCC', 'base64');
  for (const ref of ['assets/slot-2/fill.webp', 'assets/slot-3/fill.jpg']) {
    const p = join(REPURPOSE, ref); await mkdir(dirname(p), { recursive: true }); await writeFile(p, PX);
  }
});
after(async () => { await rm(WORK, { recursive: true, force: true }).catch(() => {}); });

test('ship build: DOM-derivative rebuilds <picture> sources + keeps srcset + lands text (matches preview, no black)', { skip: !chromium ? 'playwright not installed' : false }, async () => {
  const r = spawnSync(process.execPath, [APPLY, '--manifest', MANIFEST, '--mirror', MIRROR, '--target', 'build', '--build-mode', 'dom-derivative', '--now', '2026-05-31T00:00:00.000Z'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, 'apply-swaps build exited 0: ' + (r.stderr || '').slice(-300));
  const html = await readFile(join(BUILD, 'index.html'), 'utf8');

  // 1) text edit landed
  assert.match(html, /Shipped Headline/, 'text replacement is in the built HTML');

  // 1b) LINK retargeted: the shipped <a> points at YOUR destination, not the original site's path
  const ctaBlock = (html.match(/<a[^>]*class="cta"[^>]*>[^<]*<\/a>/i) || [html.match(/<a[^>]*data-cl-id="cl-cta"[^>]*>[\s\S]*?<\/a>/i)] || [''])[0] || (html.match(/<a[^>]*cl-cta[\s\S]*?<\/a>/i) || [''])[0];
  assert.ok(/pulsia\.example\/apply/.test(html), 'built CTA href retargeted to your destination');
  assert.ok(!/href="\/fr\/shop"/.test(html), 'NO original link path remains in the build');
  assert.match(html, /Apply Now/, 'CTA text also updated');

  // 2) plain <img> srcset preserved (responsive not stripped)
  assert.match(html, /slot-2\/fill\.1440\.webp/, 'hero <img> carries the rebuilt srcset in the build');

  // 3) THE ship guarantee: <picture> sources rebuilt to the new asset, NO stale original source survives
  const picBlock = (html.match(/<picture>[\s\S]*?<\/picture>/i) || [''])[0];
  assert.ok(/slot-3\/fill\.768\.(avif|webp)/.test(picBlock), 'built <picture> has the NEW <source>s: ' + picBlock.slice(0, 240));
  assert.ok(!/pic-390\.avif|pic-1440\.webp/.test(picBlock), 'NO stale original <source> remains in the build (the black-image cause): ' + picBlock.slice(0, 240));
  assert.match(picBlock, /<img[^>]*src="\/assets\/slot-3\/fill\.jpg"/, 'fallback <img> points at the new asset');

  // 4) SEO head emitted as YOURS, not the original's
  assert.match(html, /<title>Pulsia — Reset Protocol<\/title>/, 'shipped <title> is yours');
  assert.ok(!/Original Brand — Shop/.test(html), 'original title is gone');
  assert.match(html, /<meta name="description" content="Contrast performance architecture\."/, 'meta description rewritten');
  assert.match(html, /<link rel="canonical" href="https:\/\/pulsia\.example\/"/, 'canonical points at your domain');
  assert.ok(!/original\.example/.test(html), 'no original-domain canonical remains');

  // 5) alt text written onto the hero image (a11y + SEO)
  assert.match(html, /<img[^>]*class="hero"[^>]*alt="Pulsia hero — sunrise freedive"|<img[^>]*alt="Pulsia hero — sunrise freedive"[^>]*class="hero"/, 'hero img carries the edited alt');
});
