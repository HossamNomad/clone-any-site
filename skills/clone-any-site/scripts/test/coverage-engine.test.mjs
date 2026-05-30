// Part B — locator + coverage engine tests (schema v1.1).
// Determinism, clId uniqueness, nested-text directOnly, same-content grouping, gradient flagged,
// srcset rebuilt (not stripped) through a build, and --merge / overwrite-refuse safety.
// PASS/FAIL on exit code + manifest readback. Ephemeral port + HTTP readiness poll (anti-zombie).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dirname, '..');
const SERVE = join(scriptsDir, 'serve.mjs');
const EXTRACT = join(scriptsDir, 'extract-manifest.mjs');
const APPLY = join(scriptsDir, 'apply-swaps.mjs');
const FIXTURE_REL = '/test/fixtures/coverage-fixture/index.html';
const FIXTURE_DIR = join(scriptsDir, 'test', 'fixtures', 'coverage-fixture');
const WORK = join(scriptsDir, 'test', '.work', 'coverage');

let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', [SERVE, scriptsDir], { env: { ...process.env, CLONE_SERVE_PORT: '0', CLONE_EDIT: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '', done = false;
    const to = setTimeout(() => { if (!done) { done = true; server.kill(); reject(new Error('serve start timeout')); } }, 15000);
    server.stdout.on('data', async (d) => {
      buf += d.toString();
      const m = buf.match(/CLONE_PORT=(\d+)/);
      if (m && !done) {
        const port = +m[1];
        for (let i = 0; i < 80; i++) {
          try { const r = await fetch(`http://127.0.0.1:${port}${FIXTURE_REL}`); if (r.ok) { done = true; clearTimeout(to); resolve(port); return; } } catch {}
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!done) { done = true; clearTimeout(to); server.kill(); reject(new Error('serve never answered')); }
      }
    });
    server.on('error', (e) => { if (!done) { done = true; clearTimeout(to); reject(e); } });
  });
}
function stopServer() { if (server) { try { server.kill(); } catch {} server = null; } }

function extract(port, outDir, extra = []) {
  const args = [EXTRACT, '--url', `http://127.0.0.1:${port}${FIXTURE_REL}`, '--out', outDir, '--name', 'cov', '--now', '2026-01-01T00:00:00Z', ...extra];
  return spawnSync('node', args, { encoding: 'utf8' });
}
async function readManifest(outDir) { return JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8')); }

test('coverage: deterministic re-run + clId present & unique', async () => {
  await rm(WORK, { recursive: true, force: true }).catch(() => {});
  await mkdir(WORK, { recursive: true });
  const port = await startServer();
  try {
    assert.equal(extract(port, join(WORK, 'a')).status, 0);
    assert.equal(extract(port, join(WORK, 'b')).status, 0);
    const a = await readManifest(join(WORK, 'a'));
    const b = await readManifest(join(WORK, 'b'));
    const sig = (m) => m.slots.map((s) => `${s.number}|${s.clId}|${s.type}|${s.role}|${s.groupId || ''}`);
    assert.deepEqual(sig(a), sig(b), 'slot identity must be byte-stable across runs');
    assert.equal(a.meta.schemaVersion, '1.1');
    // every slot has a clId, all unique
    const clIds = a.slots.map((s) => s.clId);
    assert.ok(clIds.every(Boolean), 'all slots have clId');
    assert.equal(new Set(clIds).size, clIds.length, 'clIds unique');
    // mirrorLocator carries the same clId
    assert.ok(a.slots.every((s) => s.mirrorLocator.clId === s.clId), 'mirrorLocator.clId mirrors slot.clId');
  } finally { stopServer(); }
});

test('coverage: nested inline text → parent directOnly + separate span slot', async () => {
  const port = await startServer();
  try {
    assert.equal(extract(port, join(WORK, 'nest')).status, 0);
    const m = await readManifest(join(WORK, 'nest'));
    const intro = m.slots.find((s) => s.type === 'text' && /Comfort is a slow/.test(s.currentValue || ''));
    assert.ok(intro, 'parent <p> slot captured');
    assert.equal(intro.directOnly, true, 'parent flagged directOnly (has child <span>)');
    assert.equal(intro.subtype, 'text-leaf');
    const span = m.slots.find((s) => s.type === 'text' && (s.currentValue || '').trim() === 'poison.');
    assert.ok(span, 'nested <span> text captured as its own slot');
    assert.notEqual(span.directOnly, true, 'leaf span is not directOnly');
  } finally { stopServer(); }
});

test('coverage: same-content grouping (brand repeated) + stopword excluded', async () => {
  const port = await startServer();
  try {
    assert.equal(extract(port, join(WORK, 'grp')).status, 0);
    const m = await readManifest(join(WORK, 'grp'));
    const brand = m.slots.filter((s) => (s.currentValue || '').trim() === 'Pulsia Protocol');
    assert.ok(brand.length >= 2, 'brand appears 2+ times (header + footer)');
    const gids = new Set(brand.map((s) => s.groupId));
    assert.equal(gids.size, 1, 'all brand instances share ONE groupId');
    assert.ok([...gids][0], 'groupId is set');
    assert.equal(brand.filter((s) => s.groupRole === 'primary').length, 1, 'exactly one primary');
    // "Apply now" is a stopword → not grouped (and only appears once anyway)
    const apply = m.slots.find((s) => (s.currentValue || '').trim() === 'Apply now');
    if (apply) assert.ok(!apply.groupId, 'stopword not grouped');
  } finally { stopServer(); }
});

test('coverage: large gradient flagged advanced + excluded from blocking', async () => {
  const port = await startServer();
  try {
    assert.equal(extract(port, join(WORK, 'grad')).status, 0);
    const m = await readManifest(join(WORK, 'grad'));
    const grad = m.slots.find((s) => s.subtype === 'css-gradient');
    assert.ok(grad, 'gradient hero captured as css-gradient slot');
    assert.ok((grad.flags || []).includes('advanced:css-background'), 'flagged advanced');
    assert.ok(grad.advanced && /gradient/.test(grad.advanced.cssValue), 'cssValue retained');
    // advanced slots must NOT count toward blocking
    const recomputed = m.slots.filter((s) => s.provenance === 'original' && !s.keep && !s.replacement && s.role === 'content' && !(s.flags || []).some((f) => String(f).startsWith('advanced:'))).length;
    assert.equal(m.meta.counts.blocking, recomputed, 'blocking count excludes advanced');
  } finally { stopServer(); }
});

test('coverage: img carries srcsetSpec; build REBUILDS srcset (not stripped)', async () => {
  const port = await startServer();
  try {
    const out = join(WORK, 'srcset');
    assert.equal(extract(port, out).status, 0);
    const m = await readManifest(out);
    const img = m.slots.find((s) => s.type === 'img' && (s.currentValue || '').includes('hero'));
    assert.ok(img, 'hero img captured');
    assert.ok(img.srcsetSpec && img.srcsetSpec.kind === 'img-srcset', 'srcsetSpec captured as img-srcset');
    // give it an asset replacement WITH a rebuilt srcset, then dom-derivative build
    img.replacement = { kind: 'asset', assetRef: 'assets/new.webp', srcset: '/assets/new-390.webp 390w, /assets/new-1440.webp 1440w' };
    img.provenance = 'user';
    m.meta.structureAuthorization = 'authorized';
    await writeFile(join(out, 'manifest.json'), JSON.stringify(m, null, 2));
    // build-fingerprint must match meta to pass the drift guard
    await writeFile(join(out, 'build-fingerprint.json'), JSON.stringify({ buildId: m.meta.buildFingerprint.split('+')[0], crawlLogHash: m.meta.buildFingerprint.split('+')[1] || '' }));
    // a dummy asset so validate doesn't flag orphan assetRef
    await mkdir(join(out, 'assets'), { recursive: true });
    await writeFile(join(out, 'assets', 'new.webp'), 'x');
    const r = spawnSync('node', [APPLY, '--manifest', join(out, 'manifest.json'), '--mirror', FIXTURE_DIR, '--target', 'build', '--build-mode', 'dom-derivative'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const html = await readFile(join(out, 'build', 'index.html'), 'utf8');
    assert.match(html, /srcset="[^"]*new-1440\.webp/, 'built <img> has REBUILT srcset (responsiveness preserved)');
    assert.match(html, /data-cl-id=/, 'build stamped data-cl-id anchors');
  } finally { stopServer(); }
});

test('coverage: re-extract over edits refuses without --merge, carries with --merge', async () => {
  const port = await startServer();
  try {
    const out = join(WORK, 'merge');
    assert.equal(extract(port, out).status, 0);
    const m = await readManifest(out);
    const t = m.slots.find((s) => s.type === 'text' && /sharpest edge/.test(s.currentValue || ''));
    t.replacement = { kind: 'text', value: 'EDITED HEADLINE' }; t.provenance = 'user';
    await writeFile(join(out, 'manifest.json'), JSON.stringify(m, null, 2));
    // refuse without --merge
    const refuse = extract(port, out);
    assert.equal(refuse.status, 2, 'refuses to clobber edits without --merge');
    // carry with --merge
    const merged = extract(port, out, ['--merge']);
    assert.equal(merged.status, 0, merged.stderr);
    const m2 = await readManifest(out);
    const t2 = m2.slots.find((s) => s.replacement && s.replacement.value === 'EDITED HEADLINE');
    assert.ok(t2, 'edit carried forward by clId after --merge');
    assert.equal(t2.provenance, 'user');
  } finally { stopServer(); }
});
