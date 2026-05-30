import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dirname, '..');
const SERVE = join(scriptsDir, 'serve.mjs');
const EXTRACT = join(scriptsDir, 'extract-manifest.mjs');
const FIXTURE_REL = '/test/fixtures/static-fixture/index.html';
const WORK = join(scriptsDir, 'test', '.work', 'extract-manifest');

let server;
// Ephemeral OS-assigned port read back from serve's "CLONE_PORT=" stdout line, THEN an HTTP readiness
// poll — eliminates fixed-port collisions/zombies and the old "resolve on 2s timeout before bound" race
// that made the determinism test flaky (a not-yet-ready/stale server yields a partial DOM capture).
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
        // confirm it actually answers before resolving
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

async function runExtract(port, outDir, extraArgs = []) {
  const args = [EXTRACT, '--url', `http://127.0.0.1:${port}${FIXTURE_REL}`, '--out', outDir, '--name', 'fixture', '--now', '2026-01-01T00:00:00Z', ...extraArgs];
  const r = spawnSync('node', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('extract failed: ' + r.stderr);
  return JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
}

test('extract-manifest: deterministic numbering + stableIds across two runs', async () => {
  await rm(WORK, { recursive: true, force: true }).catch(() => {});
  await mkdir(WORK, { recursive: true });
  const port = await startServer();
  try {
    const a = await runExtract(port, join(WORK, 'a'));
    const b = await runExtract(port, join(WORK, 'b'));
    const idA = a.slots.map((s) => `${s.number}|${s.stableId}|${s.type}|${s.role}`);
    const idB = b.slots.map((s) => `${s.number}|${s.stableId}|${s.type}|${s.role}`);
    assert.deepEqual(idA, idB, 'numbering + identity must be byte-stable across runs');
    assert.equal(a.meta.buildFingerprint, b.meta.buildFingerprint);
  } finally {
    stopServer();
  }
});

test('extract-manifest: classifier — chrome vs content, folding, flags, mobile bbox', async () => {
  const port = await startServer();
  try {
    const m = await runExtract(port, join(WORK, 'cls'));
    const slots = m.slots;
    assert.ok(slots.some((s) => s.role === 'chrome'), 'has chrome slots');
    const folded = slots.filter((s) => s.repeat && s.repeat.count === 3);
    assert.ok(folded.length >= 1, 'cards folded with count 3');
    assert.ok(slots.some((s) => (s.flags || []).includes('text-as-image:review')), 'text-as-image flagged');
    assert.ok(slots.some((s) => (s.flags || []).includes('cross-origin:not-mirrored')), 'cross-origin flagged');
    assert.ok(slots.some((s) => (s.flags || []).includes('form-action')), 'form-action flagged');
    assert.ok((m.meta && m.meta.counts), 'counts present');
    const partner = slots.find((s) => (s.flags || []).includes('cross-origin:not-mirrored'));
    assert.ok(partner, 'partner slot exists');
  } finally { stopServer(); }
});

test('extract-manifest: mobile bbox — element display:none at 390 omitted, present at 1440', async () => {
  const port = await startServer();
  try {
    const m = await runExtract(port, join(WORK, 'mob'));
    const partner = m.slots.find((s) => (s.flags || []).includes('cross-origin:not-mirrored'));
    assert.ok(partner, 'partner slot exists');
    const bb = partner.mirrorLocator.bbox || {};
    assert.ok(bb['1440'] && !bb['390'], 'partner bbox present @1440 absent @390');
  } finally { stopServer(); }
});
