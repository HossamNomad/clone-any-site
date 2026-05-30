import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright';

const scriptsDir = fileURLToPath(new URL('../', import.meta.url));
const serve = scriptsDir + 'serve.mjs';
const work = fileURLToPath(new URL('./.work/serve-edit/', import.meta.url));
const repurpose = work + 'repurpose/';
const rmwork = () => rm(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });

const manifest = {
  meta: { target: 'https://x.test', name: 'serve-edit', schemaVersion: '1.0', buildFingerprint: 'b+c', viewports: [390, 1440], structureAuthorization: 'unset', counts: { total: 2, content: 2, chrome: 0, blocking: 2 } },
  slots: [
    { number: 1, stableId: 't1', type: 'text', role: 'content', provenance: 'original', mirrorLocator: { cssPath: '.hero-title', nth: 0 }, currentValue: 'The deepest calm, the sharpest edge.', flags: [] },
    { number: 2, stableId: 'i2', type: 'img', role: 'content', provenance: 'original', mirrorLocator: { cssPath: '.hero-img', nth: 0 }, currentValueRef: 'mirror://hero.png',
      slotSpec: { '390': { w: 390, h: 220, fit: 'cover', focal: [0.5, 0.5], format: 'webp', maxBytes: 80000 }, '1440': { w: 1200, h: 600, fit: 'cover', focal: [0.5, 0.5], format: 'webp', maxBytes: 250000 } }, flags: [] },
  ],
};

// Ephemeral OS-assigned port read back from serve's "CLONE_PORT=" stdout — no fixed-port collisions/zombies.
function startServe(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serve, scriptsDir], { env: { ...process.env, CLONE_EDIT: '1', CLONE_REPURPOSE_DIR: repurpose, CLONE_SERVE_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '', done = false;
    const to = setTimeout(() => { if (!done) { done = true; proc.kill(); reject(new Error('serve start timeout')); } }, 15000);
    proc.stdout.on('data', (d) => { buf += d.toString(); const m = buf.match(/CLONE_PORT=(\d+)/); if (m && !done) { done = true; clearTimeout(to); resolve({ proc, port: +m[1] }); } });
    proc.on('error', (e) => { if (!done) { done = true; clearTimeout(to); reject(e); } });
  });
}

test('serve --edit: loopback endpoints + browser double-click text edit writes manifest', async (t) => {
  await rmwork();
  await mkdir(repurpose, { recursive: true });
  await writeFile(repurpose + 'manifest.json', JSON.stringify(manifest, null, 2));
  await writeFile(repurpose + 'build-fingerprint.json', JSON.stringify({ buildId: 'b', crawlLogHash: 'c' }));

  const { proc: srv, port } = await startServe({ CLONE_LOOPBACK_OK: '1' });
  const base = `http://127.0.0.1:${port}`;
  const fixtureUrl = `${base}/test/fixtures/static-fixture/index.html`;
  t.after(async () => { srv.kill(); await rmwork(); });

  // --- endpoints ---
  const m0 = await (await fetch(base + '/__clone/manifest')).json();
  assert.equal(m0.slots.length, 2);
  let state = await (await fetch(base + '/__clone/state')).json();
  assert.equal(state.blockingCount, 2);
  const js = await (await fetch(base + '/__clone/editor/edit-map.js')).text();
  assert.match(js, /__CloneEditor/);

  const r1 = await fetch(base + '/__clone/slot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 1, op: 'replace-text', value: 'Endpoint headline' }) });
  assert.equal(r1.status, 200);
  state = await (await fetch(base + '/__clone/state')).json();
  assert.equal(state.blockingCount, 1);

  const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer();
  const up = await (await fetch(base + '/__clone/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 2, filename: 'hero.png', mime: 'image/png', dataBase64: png.toString('base64') }) })).json();
  assert.ok(up.assetRef && up.generated && up.generated.length >= 1, 'upload returns a fit-slot asset set');
  assert.match(up.srcsetHtml, /<picture|<img/);

  // reset slot 1 so the browser starts from the original (clean dblclick assertion)
  await fetch(base + '/__clone/slot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 1, op: 'clear' }) });

  // --- browser: page served + badges render + double-click edits ---
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(fixtureUrl, { waitUntil: 'load' });
    // page actually served (not a 404) + editor injected
    assert.equal(await page.$$eval('.hero-title', (n) => n.length), 1, 'fixture served');
    await page.waitForFunction(() => window.__CloneEditor && window.__CloneEditor.manifest, { timeout: 10000 });
    const badges = await page.$$eval('.cl-badge', (n) => n.length);
    assert.ok(badges >= 1, 'numbered badges rendered, got ' + badges);

    const h = await page.$('.hero-title');
    await h.dblclick();
    await page.waitForFunction(() => document.querySelector('.hero-title').getAttribute('contenteditable') === 'true', { timeout: 4000 });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('DOUBLE CLICK SWAP');
    await page.keyboard.press('Enter');
    let got = '';
    for (let i = 0; i < 40; i++) {
      const mm = await (await fetch(base + '/__clone/manifest')).json();
      const s = mm.slots.find((x) => x.number === 1);
      if (s.replacement && s.replacement.value) { got = s.replacement.value; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(got, 'DOUBLE CLICK SWAP', 'double-click edit persisted to the manifest');
  } finally { await browser.close(); }
});

test('serve --edit: write-back refused unless CLONE_LOOPBACK_OK=1 (403)', async (t) => {
  await rmwork();
  await mkdir(repurpose, { recursive: true });
  await writeFile(repurpose + 'manifest.json', JSON.stringify(manifest, null, 2));
  const { proc: srv, port } = await startServe({ /* no CLONE_LOOPBACK_OK */ });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { srv.kill(); await rmwork(); });
  assert.equal((await fetch(base + '/__clone/manifest')).status, 200);
  const r = await fetch(base + '/__clone/slot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 1, op: 'keep' }) });
  assert.equal(r.status, 403, 'unarmed write returns 403');
});
