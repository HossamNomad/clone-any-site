// freeze-spa.test.mjs — proves the build's SPA FREEZE: a hydrating page (framework marker + a script that
// rewrites text on load) would normally REVERT our edits when a browser opens it. With freeze, the build edits
// the settled DOM then strips the framework scripts, so the saved page is a static snapshot that HOLDS.
// Two cases: (1) hydrating page → frozen, edit survives a real browser open; (2) static page → NOT frozen,
// scripts (here a harmless inline) are left intact (freeze auto-off when there's nothing to hydrate).
//
// node --test freeze-spa.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const SERVE = join(SCRIPTS, 'serve.mjs');
const APPLY = join(SCRIPTS, 'apply-swaps.mjs');
const WORK = join(SCRIPTS, 'test', '.work', 'freeze');
const NOW = '2026-06-01T00:00:00.000Z';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip browser assertions */ }

// A "SPA": has the Next.js marker (#__next, __NEXT_DATA__) AND an inline script that, on load, REWRITES the
// headline back to the original — i.e. exactly the hydration-revert behavior that broke naive edits.
const SPA_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>spa</title>
<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></head>
<body><div id="__next"><h1 class="t" data-cl-id="cl-h">ORIGINAL HEADLINE</h1></div>
<script>
// simulate framework hydration: shortly after load, force the headline back to the original
setTimeout(function(){ var h=document.querySelector('.t'); if(h) h.textContent='ORIGINAL HEADLINE'; }, 400);
</script></body></html>`;

function spaManifest() {
  return {
    meta: { target: 'https://spa.test', name: 'freeze', schemaVersion: '1.1', buildFingerprint: 'bf+', crawlLogHash: '', viewports: [390, 1440], structureAuthorization: 'authorized', counts: {} },
    slots: [
      { number: 1, stableId: 'h1', clId: 'cl-h', type: 'text', role: 'content', provenance: 'user', keep: false, mirrorLocator: { clId: 'cl-h', cssPath: '.t', nth: 0 }, currentValue: 'ORIGINAL HEADLINE', flags: [], replacement: { kind: 'text', value: 'PULSIA HEADLINE' } },
    ],
  };
}

async function buildCase(name, page, manifest, extraArgs) {
  const mirror = join(WORK, name, 'mirror');
  const repurpose = join(WORK, name, 'repurpose');
  await mkdir(mirror, { recursive: true }); await writeFile(join(mirror, 'index.html'), page);
  await mkdir(repurpose, { recursive: true });
  await writeFile(join(repurpose, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(repurpose, 'build-fingerprint.json'), JSON.stringify({ buildId: 'bf', crawlLogHash: '' }));
  const r = spawnSync(process.execPath, [APPLY, '--manifest', join(repurpose, 'manifest.json'), '--mirror', mirror,
    '--target', 'build', '--build-mode', 'dom-derivative', '--hydrate-ms', '900', ...extraArgs, '--now', NOW],
    { encoding: 'utf8', timeout: 120000 });
  return { repurpose, mirror, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// open the built file in a real browser, wait past any hydration window, return the rendered headline text
function renderHeadline(buildDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVE, buildDir], { env: { ...process.env, CLONE_SERVE_PORT: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let b = ''; const to = setTimeout(() => { proc.kill(); reject(new Error('serve boot timeout')); }, 15000);
    proc.stdout.on('data', async (d) => {
      b += d.toString(); const m = b.match(/CLONE_PORT=(\d+)/); if (!m) return;
      clearTimeout(to);
      try {
        const browser = await chromium.launch();
        const pg = await browser.newPage();
        await pg.goto('http://127.0.0.1:' + m[1] + '/', { waitUntil: 'load', timeout: 60000 });
        await pg.waitForTimeout(1200);                 // longer than the page's 400ms "hydration" revert
        const txt = await pg.evaluate(() => (document.querySelector('.t') || {}).textContent || '');
        const frozen = await pg.evaluate(() => document.documentElement.getAttribute('data-cl-frozen'));
        const scripts = await pg.evaluate(() => document.querySelectorAll('script').length);
        await browser.close(); proc.kill(); resolve({ txt, frozen, scripts });
      } catch (e) { proc.kill(); reject(e); }
    });
    proc.on('error', reject);
  });
}

before(async () => { await rm(WORK, { recursive: true, force: true }).catch(() => {}); });
after(async () => { await rm(WORK, { recursive: true, force: true }).catch(() => {}); });

test('build reports frozen + scriptsRemoved on a hydrating SPA', async () => {
  const r = await buildCase('spa', SPA_PAGE, spaManifest(), ['--freeze', 'on']);
  assert.equal(r.status, 0, 'build exited 0: ' + r.stderr.slice(-300));
  const summary = JSON.parse(r.stdout.trim().split('\n').slice(-Infinity).join('\n').match(/\{[\s\S]*\}$/)[0]);
  assert.equal(summary.frozen, true, 'summary.frozen true');
  assert.ok(summary.scriptsRemoved >= 1, 'at least one framework script removed: ' + summary.scriptsRemoved);
  const html = await readFile(join(r.repurpose, 'build', 'index.html'), 'utf8');
  assert.match(html, /PULSIA HEADLINE/, 'edit is in the saved HTML');
  assert.doesNotMatch(html, /setTimeout\(function\(\)\{ var h=document/, 'the hydration-revert script was stripped');
});

test('frozen page HOLDS the edit in a real browser (no revert)', { skip: !chromium ? 'playwright not installed' : false }, async () => {
  // (build already ran in the previous test; re-run to be independent)
  const r = await buildCase('spa2', SPA_PAGE, spaManifest(), ['--freeze', 'on']);
  assert.equal(r.status, 0, r.stderr.slice(-300));
  const res = await renderHeadline(join(r.repurpose, 'build'));
  assert.equal(res.frozen, '1', 'page marked frozen');
  assert.equal(res.txt, 'PULSIA HEADLINE', 'headline stays edited after the hydration window (no revert)');
});

// A SPA whose content is gated behind a JS intro LOADER: a full-viewport white overlay (z 9999) that a script
// removes on load. Freeze strips that script, so without de-loader the overlay stays and hides the content.
const LOADER_SPA = `<!doctype html><html><head><meta charset="utf-8"><title>spa-loader</title>
<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
<style>#ld{position:fixed;inset:0;z-index:9999;background:#fff}</style></head>
<body><div id="__next"><h1 class="t" data-cl-id="cl-h">ORIGINAL HEADLINE</h1></div>
<div id="ld">LOADING…</div>
<script>// dismisses only at 5s — LATER than the build's --hydrate-ms wait, so the overlay is still up at freeze time
setTimeout(function(){var l=document.getElementById('ld');if(l)l.remove();},5000);</script>
</body></html>`;

test('de-loader peels a JS intro overlay so the frozen page shows content (not the dead loader)', { skip: !chromium ? 'playwright not installed' : false }, async () => {
  const r = await buildCase('loader', LOADER_SPA, spaManifest(), ['--freeze', 'on']);
  assert.equal(r.status, 0, r.stderr.slice(-300));
  const summary = JSON.parse(r.stdout.trim().match(/\{[\s\S]*\}$/)[0]);
  assert.ok(summary.overlaysPeeled >= 1, 'at least one intro overlay peeled: ' + summary.overlaysPeeled);
  // in a real browser the loader must NOT cover the centre, and the edited headline is what's painted there
  const res = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVE, join(r.repurpose, 'build')], { env: { ...process.env, CLONE_SERVE_PORT: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let b = ''; const to = setTimeout(() => { proc.kill(); reject(new Error('boot timeout')); }, 15000);
    proc.stdout.on('data', async (d) => {
      b += d.toString(); const m = b.match(/CLONE_PORT=(\d+)/); if (!m) return; clearTimeout(to);
      try {
        const browser = await chromium.launch(); const pg = await browser.newPage();
        await pg.goto('http://127.0.0.1:' + m[1] + '/', { waitUntil: 'load', timeout: 60000 });
        await pg.waitForTimeout(1200);
        // the loader must be computed-hidden (de-loader set display:none) and not the element painted at the centre
        const loaderDisplay = await pg.evaluate(() => { const l = document.getElementById('ld'); return l ? getComputedStyle(l).display : 'gone'; });
        const centreIsLoader = await pg.evaluate(() => { const e = document.elementFromPoint(innerWidth >> 1, innerHeight >> 1); return !!(e && e.closest('#ld')); });
        await browser.close(); proc.kill(); resolve({ loaderDisplay, centreIsLoader });
      } catch (e) { proc.kill(); reject(e); }
    });
    proc.on('error', reject);
  });
  assert.equal(res.loaderDisplay, 'none', 'the dead loader is hidden in the frozen page');
  assert.equal(res.centreIsLoader, false, 'the loader no longer covers the viewport centre');
});

test('static page is NOT frozen (freeze auto-off when nothing hydrates)', async () => {
  const STATIC = `<!doctype html><html><head><meta charset="utf-8"><title>s</title></head>
<body><h1 class="t" data-cl-id="cl-h">ORIGINAL HEADLINE</h1></body></html>`;
  const r = await buildCase('static', STATIC, spaManifest(), []);   // freeze=auto
  assert.equal(r.status, 0, r.stderr.slice(-300));
  const summary = JSON.parse(r.stdout.trim().match(/\{[\s\S]*\}$/)[0]);
  assert.ok(!summary.frozen, 'static page not frozen (auto)');
  const html = await readFile(join(r.repurpose, 'build', 'index.html'), 'utf8');
  assert.match(html, /PULSIA HEADLINE/, 'edit still applied on the static page');
  assert.doesNotMatch(html, /data-cl-frozen/, 'no freeze marker on a static page');
});
