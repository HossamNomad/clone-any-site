// Part C — editor end-to-end in a REAL browser (Playwright). Proves the user's core complaints are fixed:
// text edits STICK across reload + PROPAGATE to every same-content instance, media swap keeps srcset,
// theme applies via CSS vars. Decides PASS/FAIL on DOM observation + manifest readback, not screenshots.
//
// Skips cleanly if Playwright/chromium isn't installed (so the zero-dep suites still pass on a bare box).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const SERVE = join(SCRIPTS, 'serve.mjs');
const MIRROR = join(SCRIPTS, 'test', 'fixtures', 'e2e-mirror');
const REPURPOSE = join(SCRIPTS, 'test', '.work', 'e2e', 'repurpose');
const MANIFEST = join(REPURPOSE, 'manifest.json');

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip */ }

// minimal mirror page: brand repeated (header+footer) → grouped; a hero img with srcset; a heading.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>e2e</title>
<style>:root{--brand-accent:#111}.brand{color:var(--brand-accent)}</style></head>
<body>
<header><a class="brand" href="/" data-cl-id="cl-brand-1">Acme</a><h1 class="title" data-cl-id="cl-title">Old Headline</h1></header>
<main><img class="hero" data-cl-id="cl-hero" src="/img/hero-1440.png" srcset="/img/hero-390.png 390w, /img/hero-1440.png 1440w" sizes="100vw" width="1200" height="600" alt="hero"></main>
<footer><a class="brand" href="/" data-cl-id="cl-brand-2">Acme</a></footer>
</body></html>`;

function manifest() {
  return {
    meta: { target: 'https://e2e.test', name: 'e2e', schemaVersion: '1.1', buildFingerprint: 'b+c', viewports: [390, 1440], structureAuthorization: 'unset', counts: {} },
    slots: [
      { number: 1, stableId: 'b1', clId: 'cl-brand-1', type: 'text', role: 'content', provenance: 'original', keep: false, replacement: null, groupId: 'g-brand', groupRole: 'primary', mirrorLocator: { clId: 'cl-brand-1', cssPath: '.brand', nth: 0 }, currentValue: 'Acme', flags: ['grouped'] },
      { number: 2, stableId: 'b2', clId: 'cl-brand-2', type: 'text', role: 'content', provenance: 'original', keep: false, replacement: null, groupId: 'g-brand', groupRole: 'member', mirrorLocator: { clId: 'cl-brand-2', cssPath: '.brand', nth: 1 }, currentValue: 'Acme', flags: ['grouped'] },
      { number: 3, stableId: 't3', clId: 'cl-title', type: 'text', role: 'content', provenance: 'original', keep: false, replacement: null, mirrorLocator: { clId: 'cl-title', cssPath: '.title', nth: 0 }, currentValue: 'Old Headline', flags: [] },
      { number: 4, stableId: 'h4', clId: 'cl-hero', type: 'img', role: 'content', provenance: 'original', keep: false, replacement: null, mirrorLocator: { clId: 'cl-hero', cssPath: '.hero', nth: 0 }, currentValue: 'hero', srcsetSpec: { kind: 'img-srcset', sizes: '100vw', imgSrcset: '/img/hero-390.png 390w, /img/hero-1440.png 1440w' }, flags: [] },
    ],
  };
}

let proc, port;
function boot() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [SERVE, MIRROR], { env: { ...process.env, CLONE_SERVE_PORT: '0', CLONE_EDIT: '1', CLONE_LOOPBACK_OK: '1', CLONE_REPURPOSE_DIR: REPURPOSE }, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = ''; const to = setTimeout(() => reject(new Error('boot timeout')), 15000);
    proc.stdout.on('data', (d) => { buf += d.toString(); const m = buf.match(/CLONE_PORT=(\d+)/); if (m) { clearTimeout(to); resolve(+m[1]); } });
    proc.on('error', reject);
  });
}

before(async () => {
  if (!chromium) return;
  await rm(join(SCRIPTS, 'test', '.work', 'e2e'), { recursive: true, force: true }).catch(() => {});
  await mkdir(MIRROR, { recursive: true });
  await writeFile(join(MIRROR, 'index.html'), PAGE);
  await mkdir(REPURPOSE, { recursive: true });
  await writeFile(MANIFEST, JSON.stringify(manifest(), null, 2));
  port = await boot();
});
after(() => { if (proc) try { proc.kill(); } catch {} });

test('editor e2e: text sticks across reload + propagates to all group members; theme applies', { skip: !chromium ? 'playwright not installed' : false }, async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__CloneEditor && window.__CloneEditor.manifest, { timeout: 15000 });

    // ---- 1. edit the title via the API the editor uses, then re-apply + assert DOM ----
    await page.evaluate(async () => {
      await window.__CloneEditor.api.slot({ number: 3, op: 'replace-text', value: 'New Pulsia Headline' });
      await window.__CloneEditor.refreshManifest();
      window.__CloneEditor.reapplyAll();
    });
    await page.waitForFunction(() => document.querySelector('.title').textContent === 'New Pulsia Headline', { timeout: 8000 });
    assert.equal(await page.textContent('.title'), 'New Pulsia Headline', 'title updated in DOM');

    // ---- 2. propagate brand across BOTH instances via the group op ----
    await page.evaluate(async () => {
      await window.__CloneEditor.api.group({ groupId: 'g-brand', op: 'replace-text', value: 'Pulsia' });
      await window.__CloneEditor.refreshManifest();
      window.__CloneEditor.reapplyAll();
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.brand')].every((e) => e.textContent === 'Pulsia'), { timeout: 8000 });
    const brands = await page.$$eval('.brand', (els) => els.map((e) => e.textContent));
    assert.deepEqual(brands, ['Pulsia', 'Pulsia'], 'both brand instances updated (propagation)');

    // ---- 3. RELOAD → edits must STICK (reapplyAll on load from the served manifest) ----
    await page.reload({ waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__CloneEditor && window.__CloneEditor.manifest, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('.title') && document.querySelector('.title').textContent === 'New Pulsia Headline', { timeout: 8000 });
    assert.equal(await page.textContent('.title'), 'New Pulsia Headline', 'title edit STUCK across reload');
    const brands2 = await page.$$eval('.brand', (els) => els.map((e) => e.textContent));
    assert.deepEqual(brands2, ['Pulsia', 'Pulsia'], 'brand edits STUCK across reload');

    // ---- 4. theme applies a CSS variable ----
    await page.evaluate(async () => { await window.__CloneEditor.themes.apply('pulsia-noir'); });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--cl-accent').trim() === '#c8a24b', { timeout: 8000 });
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cl-accent').trim());
    assert.equal(accent, '#c8a24b', 'theme set --cl-accent var');

    // ---- 5. manifest readback confirms persistence ----
    const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
    assert.equal(m.slots.find((s) => s.number === 3).replacement.value, 'New Pulsia Headline');
    assert.equal(m.slots.filter((s) => s.groupId === 'g-brand').every((s) => s.replacement && s.replacement.value === 'Pulsia'), true);
    assert.equal(m.meta.theme.id, 'pulsia-noir');
  } finally { await browser.close(); }
});

test('editor e2e: media swap keeps srcset (no responsive strip)', { skip: !chromium ? 'playwright not installed' : false }, async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__CloneEditor && window.__CloneEditor.manifest, { timeout: 15000 });
    // simulate the editor's post-upload slot write (with a rebuilt srcset) + live apply
    await page.evaluate(async () => {
      await window.__CloneEditor.api.slot({ number: 4, op: 'replace-asset', assetRef: 'assets/new.webp', srcset: '/assets/new-390.webp 390w, /assets/new-1440.webp 1440w' });
      await window.__CloneEditor.refreshManifest();
      window.__CloneEditor.reapplyAll();
    });
    await page.waitForFunction(() => { const s = document.querySelector('.hero').getAttribute('srcset'); return s && /new-1440\.webp/.test(s); }, { timeout: 8000 });
    const srcset = await page.getAttribute('.hero', 'srcset');
    assert.ok(srcset && /new-1440\.webp/.test(srcset), 'swapped <img> keeps a REBUILT srcset (responsive preserved): ' + srcset);
    const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
    assert.ok(m.slots.find((s) => s.number === 4).replacement.srcset, 'manifest persisted replacement.srcset');
  } finally { await browser.close(); }
});
