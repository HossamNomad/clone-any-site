// ai-rewrite.test.mjs — AI copy rewrite is OFFLINE-SAFE: 503 when no key, deterministic variants under
// CLONE_AI_FAKE=1, never writes the manifest (it only returns suggestions; the editor applies via the text op).
// Zero network. Ephemeral port read back from stdout.
//
// node --test ai-rewrite.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const SERVE = join(SCRIPTS, 'serve.mjs');
const MIRROR = join(SCRIPTS, 'test', '.work', 'ai', 'mirror');
const REPURPOSE = join(SCRIPTS, 'test', '.work', 'ai', 'repurpose');
const MANIFEST = join(REPURPOSE, 'manifest.json');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ai</title></head><body><h1 class="t" data-cl-id="cl-t">Comfort is a slow poison.</h1></body></html>`;
function manifest() {
  return { meta: { target: 'https://x.test', name: 'ai', schemaVersion: '1.1', buildFingerprint: 'bf', viewports: [390], structureAuthorization: 'unset', counts: {} },
    slots: [{ number: 1, stableId: 't1', clId: 'cl-t', type: 'text', role: 'content', provenance: 'original', keep: false, replacement: null, mirrorLocator: { clId: 'cl-t', cssPath: '.t', nth: 0 }, currentValue: 'Comfort is a slow poison.', flags: [] }] };
}
function req(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = { _raw: buf }; } resolve({ code: res.statusCode, json: j }); });
    });
    r.on('error', reject); r.write(data); r.end();
  });
}
function boot(extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVE, MIRROR], { env: { ...process.env, CLONE_SERVE_PORT: '0', CLONE_EDIT: '1', CLONE_LOOPBACK_OK: '1', CLONE_REPURPOSE_DIR: REPURPOSE, ...extraEnv }, stdio: ['ignore', 'pipe', 'ignore'] });
    let b = ''; const to = setTimeout(() => reject(new Error('boot timeout')), 15000);
    proc.stdout.on('data', (d) => { b += d.toString(); const m = b.match(/CLONE_PORT=(\d+)/); if (m) { clearTimeout(to); resolve({ proc, port: +m[1] }); } });
    proc.on('error', reject);
  });
}

before(async () => {
  await rm(join(SCRIPTS, 'test', '.work', 'ai'), { recursive: true, force: true }).catch(() => {});
  await mkdir(MIRROR, { recursive: true }); await writeFile(join(MIRROR, 'index.html'), PAGE);
  await mkdir(REPURPOSE, { recursive: true }); await writeFile(MANIFEST, JSON.stringify(manifest(), null, 2));
});
after(() => {});

test('ai-rewrite: 503 with a clear message when no key + no fake (offline-safe degrade)', async () => {
  const { proc, port } = await boot({ ANTHROPIC_API_KEY: '', CLONE_AI_FAKE: '' });
  try {
    const r = await req(port, '/__clone/ai-rewrite', { text: 'Comfort is a slow poison.', n: 3 });
    assert.equal(r.code, 503, 'no key → 503');
    assert.match(JSON.stringify(r.json), /ANTHROPIC_API_KEY/, 'message names the env var');
  } finally { proc.kill(); }
});

test('ai-rewrite: CLONE_AI_FAKE=1 returns deterministic variants, no network', async () => {
  const { proc, port } = await boot({ CLONE_AI_FAKE: '1' });
  try {
    const r = await req(port, '/__clone/ai-rewrite', { text: 'Comfort is a slow poison.', n: 3 });
    assert.equal(r.code, 200);
    assert.equal(r.json.source, 'fake');
    assert.equal(r.json.variants.length, 3, 'n=3 variants');
    assert.ok(r.json.variants.every((v) => typeof v === 'string' && v.length), 'all strings');
    // deterministic: same input → same output
    const r2 = await req(port, '/__clone/ai-rewrite', { text: 'Comfort is a slow poison.', n: 3 });
    assert.deepEqual(r2.json.variants, r.json.variants, 'deterministic');
  } finally { proc.kill(); }
});

test('ai-rewrite: never writes the manifest (suggestions only)', async () => {
  const before = await readFile(MANIFEST, 'utf8');
  const { proc, port } = await boot({ CLONE_AI_FAKE: '1' });
  try {
    await req(port, '/__clone/ai-rewrite', { text: 'x', n: 2 });
    const after = await readFile(MANIFEST, 'utf8');
    assert.equal(after, before, 'manifest untouched by ai-rewrite');
  } finally { proc.kill(); }
});

test('ai-rewrite: empty text → 400', async () => {
  const { proc, port } = await boot({ CLONE_AI_FAKE: '1' });
  try {
    const r = await req(port, '/__clone/ai-rewrite', { text: '   ', n: 2 });
    assert.equal(r.code, 400);
  } finally { proc.kill(); }
});
