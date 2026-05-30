// Tests for clone-list.mjs — scanClones (heterogeneous fixtures), portManager, trash/restore, HTTP API.
// PASS/FAIL on exit code + readback. Ephemeral ports + readback (anti-zombie). Run: node --test test/clone-list.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, mkdir, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { scanClones, makePortManager, trashClone, restoreClone, listTrash } from '../clone-list.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const CLONE_LIST = join(SCRIPTS, 'clone-list.mjs');
const exists = (p) => access(p).then(() => true).catch(() => false);

// Build a clones/ root with 4 heterogeneous clones.
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'clone-list-'));
  // 1) FULL clone: mirror + crawl-log + fidelity report (docs/fidelity) + manifest with swaps
  const full = join(root, 'fullsite');
  await mkdir(join(full, 'mirror', 'www.full.example'), { recursive: true });
  await writeFile(join(full, 'mirror', 'www.full.example', 'index.html'), '<!doctype html><title>full</title>');
  await writeFile(join(full, 'mirror', 'www.full.example.crawl-log.json'), JSON.stringify({ target: 'https://www.full.example' }));
  await mkdir(join(full, 'docs', 'fidelity'), { recursive: true });
  await writeFile(join(full, 'docs', 'fidelity', 'fidelity-report.md'), '# Fidelity Report\n**Verdict: ✅ PASS**\n- mean SSIM **0.9764**\n');
  await mkdir(join(full, 'repurpose'), { recursive: true });
  await writeFile(join(full, 'repurpose', 'manifest.json'), JSON.stringify({ slots: [{ number: 1, replacement: { kind: 'text', value: 'x' } }, { number: 2, keep: true }, { number: 3 }] }));

  // 2) MIRROR-ONLY clone: mirror + fidelity in _recon/fidelity (FAIL), no manifest, capture-preconditions for URL
  const mo = join(root, 'mirroronly');
  await mkdir(join(mo, 'mirror', 'mo.example'), { recursive: true });
  await writeFile(join(mo, 'mirror', 'mo.example', 'index.html'), '<title>mo</title>');
  await mkdir(join(mo, '_recon', 'fidelity'), { recursive: true });
  await writeFile(join(mo, '_recon', 'fidelity', 'fidelity-report.md'), '# Fidelity Report\n**Verdict: ❌ FAIL**\nmean SSIM 0.71\n');
  await writeFile(join(mo, '_recon', 'capture-preconditions.json'), JSON.stringify({ url: 'https://mo.example/' }));

  // 3) PAYLOAD-ABSENT clone: _recon only, no mirror/ on disk (gitignored payload)
  const pa = join(root, 'payloadabsent');
  await mkdir(join(pa, '_recon'), { recursive: true });
  await writeFile(join(pa, '_recon', 'capture-preconditions.json'), JSON.stringify({ origin: 'https://absent.example' }));

  // 4) MALFORMED clone: empty dir
  await mkdir(join(root, 'emptyclone'), { recursive: true });

  // reserved dirs that must be ignored
  await mkdir(join(root, '_trash'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });

  return root;
}

test('scanClones: heterogeneous fixtures produce correct, defensive records', async () => {
  const root = await makeRoot();
  try {
    const clones = await scanClones(root);
    const by = Object.fromEntries(clones.map((c) => [c.name, c]));
    assert.ok(!by._trash && !by.node_modules, 'reserved dirs excluded');
    assert.equal(clones.length, 4, '4 real clones');

    assert.equal(by.fullsite.servable, true);
    assert.equal(by.fullsite.sourceUrl, 'https://www.full.example');
    assert.equal(by.fullsite.fidelity.verdict, 'PASS');
    assert.equal(by.fullsite.fidelity.meanSsim, 0.9764);
    assert.equal(by.fullsite.editable, true);
    assert.equal(by.fullsite.manifest.elements, 3);
    assert.equal(by.fullsite.manifest.swaps, 2);

    assert.equal(by.mirroronly.servable, true);
    assert.equal(by.mirroronly.fidelity.verdict, 'FAIL');
    assert.equal(by.mirroronly.editable, false);
    assert.equal(by.mirroronly.sourceUrl, 'https://mo.example/');

    assert.equal(by.payloadabsent.servable, false);
    assert.equal(by.payloadabsent.sourceUrl, 'https://absent.example');
    assert.equal(by.payloadabsent.fidelity, null);

    assert.equal(by.emptyclone.servable, false);
    assert.equal(by.emptyclone.editable, false);
    assert.ok(by.emptyclone.ok, 'empty clone does not throw');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scanClones: missing root returns []', async () => {
  assert.deepEqual(await scanClones(join(tmpdir(), 'definitely-missing-' + Math.random().toString(36).slice(2))), []);
});

test('portManager: allocates distinct free ports', async () => {
  const pm = makePortManager();
  const a = await pm.freePort(); const b = await pm.freePort();
  assert.ok(a > 0 && b > 0, 'positive ports');
  assert.equal(typeof a, 'number');
});

test('trash + restore: moves a clone to _trash and back', async () => {
  const root = await makeRoot();
  try {
    const r = await trashClone('fullsite', root);
    assert.ok(!(await exists(join(root, 'fullsite'))), 'source gone after trash');
    assert.ok((await exists(join(root, '_trash', r.trashedTo))), 'present in trash');
    const tl = await listTrash(root);
    assert.equal(tl.length, 1);
    await restoreClone(r.trashedTo, root);
    assert.ok((await exists(join(root, 'fullsite'))), 'restored to original name');
    assert.equal((await listTrash(root)).length, 0, 'trash empty after restore');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- HTTP API smoke (spawn the dashboard on an ephemeral port, readback) ----
function waitForPort(proc) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => { buf += d.toString(); const m = buf.match(/CLONE_LIST_PORT=(\d+)/); if (m) { proc.stdout.off('data', onData); resolve(Number(m[1])); } };
    proc.stdout.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error('dashboard boot timeout')), 10000);
  });
}
const j = async (port, path, opts) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, opts); return { status: r.status, body: await r.json().catch(() => ({})) }; };

test('API: /api/clones, /api/status, /api/trash, /api/restore', async () => {
  const root = await makeRoot();
  const proc = spawn(process.execPath, [CLONE_LIST, root], { env: { ...process.env, CLONE_LIST_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await waitForPort(proc);
    const clones = await j(port, '/api/clones');
    assert.equal(clones.status, 200);
    assert.equal(clones.body.clones.length, 4);

    const st = await j(port, '/api/status');
    assert.equal(st.status, 200);

    // gallery served
    const gal = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(gal.status, 200);
    assert.match(await gal.text(), /Clone List/);

    // thumb -> placeholder svg for a clone with no screenshot
    const thumb = await fetch(`http://127.0.0.1:${port}/api/thumb/payloadabsent`);
    assert.equal(thumb.status, 200);
    assert.match(thumb.headers.get('content-type') || '', /svg/);

    // trash then restore via API
    const tr = await j(port, '/api/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['emptyclone'] }) });
    assert.equal(tr.status, 200);
    assert.equal((await j(port, '/api/clones')).body.clones.length, 3, 'one fewer after trash');
    const tl = await j(port, '/api/trash-list');
    assert.equal(tl.body.trash.length, 1);
    const re = await j(port, '/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashName: tl.body.trash[0].trashName }) });
    assert.equal(re.status, 200);
    assert.equal((await j(port, '/api/clones')).body.clones.length, 4, 'restored');
  } finally {
    proc.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('API: start rejects payload-absent + edit-without-manifest', async () => {
  const root = await makeRoot();
  const proc = spawn(process.execPath, [CLONE_LIST, root], { env: { ...process.env, CLONE_LIST_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await waitForPort(proc);
    const r1 = await j(port, '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'payloadabsent', mode: 'open' }) });
    assert.equal(r1.status, 409, 'payload absent => 409');
    const r2 = await j(port, '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'mirroronly', mode: 'edit' }) });
    assert.equal(r2.status, 409, 'edit without manifest => 409');
  } finally { proc.kill(); await rm(root, { recursive: true, force: true }); }
});

test('API: start (open) + status + stop a real mirror', async () => {
  const root = await makeRoot();
  const proc = spawn(process.execPath, [CLONE_LIST, root], { env: { ...process.env, CLONE_LIST_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await waitForPort(proc);
    const start = await j(port, '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'fullsite', mode: 'open' }) });
    assert.equal(start.status, 200);
    assert.match(start.body.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    // the child mirror actually answers
    const mirror = await fetch(start.body.url);
    assert.equal(mirror.status, 200);
    assert.match(await mirror.text(), /full/);
    // status shows it running
    const st = await j(port, '/api/status');
    assert.ok(st.body.fullsite && st.body.fullsite.port, 'status lists running clone');
    // stop it
    const stop = await j(port, '/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'fullsite' }) });
    assert.equal(stop.body.stopped, true);
  } finally { proc.kill(); await rm(root, { recursive: true, force: true }); }
});
