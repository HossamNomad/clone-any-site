// node:test suite for publish-gate.mjs — the blocking legitimacy gate.
// Run ONLY this file (other agents write to test/ concurrently):
//   node --test .claude/skills/clone-any-site/scripts/test/publish-gate.test.mjs
//
// Determinism: every PNG is generated with sharp at FIXED pixel values; every timestamp passed via --now.
// All temp output lives under .work/<unique>/ (gitignored) and is cleaned up in teardown.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, '..');
const GATE = join(SCRIPTS_DIR, 'publish-gate.mjs');
const WORK_ROOT = join(__dirname, '.work', 'publish-gate-' + Date.now().toString(36)); // dir name only; never read by the gate

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const NOW = '2026-05-30T00:00:00.000Z'; // frozen timestamp for the gate (determinism)

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

// ── deterministic PNG factory ───────────────────────────────────────────────
// Build a gradient/structured RGB image at fixed pixel values so dHash is stable.
async function makePng(w, h, seed) {
  const channels = 3;
  const raw = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      // deterministic structured pattern (no randomness): smooth gradient + seed offset
      raw[i] = (x * 7 + seed * 11) & 0xff;        // R
      raw[i + 1] = (y * 5 + seed * 3) & 0xff;     // G
      raw[i + 2] = ((x + y) * 2 + seed) & 0xff;   // B
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels } }).png({ compressionLevel: 9 }).toBuffer();
}

// dHash exactly as the gate computes it (kept in sync to verify the pHash guardrail intent).
async function dHash(buf) {
  const raw = await sharp(buf).greyscale().resize(9, 8, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
  let bits = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      bits += raw[row * 9 + col] < raw[row * 9 + col + 1] ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
function hammingHex(a, b) { let d = 0; for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } } return d; }

// ── run the gate as a child process; capture stdout/stderr + exit code ───────
function runGate(args, { stdin } = {}) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [GATE, ...args], { cwd: SCRIPTS_DIR });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (stdin != null) { p.stdin.write(stdin); p.stdin.end(); } else { p.stdin.end(); }
    p.on('close', (code) => res({ code, out, err }));
  });
}

// ── scaffold a case dir: writes manifest.json + build-fingerprint.json + build/ ─
let caseSeq = 0;
async function scaffold({ manifest, fingerprint, buildFiles }) {
  const dir = join(WORK_ROOT, 'case-' + (++caseSeq));
  const repurposeDir = join(dir, 'repurpose');
  const buildDir = join(repurposeDir, 'build');
  await mkdir(buildDir, { recursive: true });
  await writeFile(join(repurposeDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(repurposeDir, 'build-fingerprint.json'), JSON.stringify(fingerprint, null, 2));
  for (const [rel, content] of Object.entries(buildFiles || {})) {
    const fp = join(buildDir, rel);
    await mkdir(dirname(fp), { recursive: true });
    await writeFile(fp, content);
  }
  return { dir, manifestPath: join(repurposeDir, 'manifest.json'), buildDir, repurposeDir };
}

const FP_STR = 'build-7+crawl-abc';
const baseFingerprint = { buildId: 'build-7', crawlLogHash: 'crawl-abc', buildFingerprint: FP_STR };
function baseMeta(extra = {}) {
  return {
    target: 'https://www.acmebrand.com/',
    name: 'acme-clone',
    schemaVersion: '1.0',
    buildFingerprint: FP_STR,
    viewports: [390, 768, 1440],
    structureAuthorization: 'unset',
    mirrorRoot: 'mirror/www.acmebrand.com',
    ...extra,
  };
}
function imgSlot(number, { provenance = 'original', byteSha = null, dHash = null, keep = false, role = 'content', type = 'img' } = {}) {
  return {
    number, stableId: `img-${number}`, type, role, provenance, keep,
    mirrorLocator: { cssPath: `img.s${number}`, nth: 0 },
    currentValue: `image ${number}`,
    computed: { ...(byteSha ? { byteSha } : {}), ...(dHash ? { dHash } : {}) },
  };
}

before(async () => { await mkdir(WORK_ROOT, { recursive: true }); });
after(async () => { await rm(WORK_ROOT, { recursive: true, force: true }); });

// ─────────────────────────────────────────────────────────────────────────────
// GUARDRAIL exit-1: original image (provenance original, unauthorized) in the build => exit 1
// ─────────────────────────────────────────────────────────────────────────────
test('GUARDRAIL: original image byte-present + unauthorized => BLOCK (exit 1)', async () => {
  const png = await makePng(64, 48, 1);
  const byteSha = sha1(png);
  const dh = await dHash(png);
  const manifest = {
    meta: baseMeta(),
    slots: [imgSlot(1, { byteSha, dHash: dh })],
  };
  const { manifestPath, buildDir, repurposeDir } = await scaffold({
    manifest, fingerprint: baseFingerprint, buildFiles: { 'assets/hero.png': png },
  });
  // attest structure authorized but DO NOT authorize slot #1
  const attestPath = join(repurposeDir, 'attest.json');
  await writeFile(attestPath, JSON.stringify({ structureAuthorization: 'authorized', slots: {} }));

  const r = await runGate(['--manifest', manifestPath, '--build', buildDir, '--attest', attestPath, '--now', NOW]);
  assert.equal(r.code, 1, `expected BLOCK exit 1\n${r.out}\n${r.err}`);
  assert.match(r.out, /original-image|retained-originals/, 'should report original image / retained-original block');
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARDRAIL pHash: re-encoded original (different quality/size) still matches => exit 1
// (byte-equality alone is NOT enough — the dHash must catch it)
// ─────────────────────────────────────────────────────────────────────────────
test('GUARDRAIL: RE-ENCODED original (byte-different but dHash-match) => BLOCK (exit 1)', async () => {
  const png = await makePng(128, 96, 2);
  const originalByteSha = sha1(png);
  const originalDHash = await dHash(png);

  // Re-encode: shrink + jpeg-roundtrip-ish via webp at different size, then back to png at a different size.
  const reencoded = await sharp(png).resize(96, 72, { fit: 'fill' }).png({ compressionLevel: 6, quality: 80 }).toBuffer();
  const reencodedByteSha = sha1(reencoded);
  const reencodedDHash = await dHash(reencoded);

  // sanity: bytes differ, but the perceptual hash is close
  assert.notEqual(reencodedByteSha, originalByteSha, 'precondition: re-encode must change the bytes');
  assert.ok(hammingHex(originalDHash, reencodedDHash) <= 10, `precondition: dHash must stay within threshold (got ${hammingHex(originalDHash, reencodedDHash)})`);

  const manifest = {
    meta: baseMeta(),
    // manifest only knows the ORIGINAL hashes; the build ships a re-encoded copy
    slots: [imgSlot(1, { byteSha: originalByteSha, dHash: originalDHash })],
  };
  const { manifestPath, buildDir, repurposeDir } = await scaffold({
    manifest, fingerprint: baseFingerprint, buildFiles: { 'img/hero-optimized.png': reencoded },
  });
  // authorize structure AND slot #1 — so the ONLY thing that can block is the pHash scan
  const attestPath = join(repurposeDir, 'attest.json');
  await writeFile(attestPath, JSON.stringify({ structureAuthorization: 'authorized', slots: { '1': 'authorized' } }));

  const r = await runGate(['--manifest', manifestPath, '--build', buildDir, '--attest', attestPath, '--now', NOW]);
  assert.equal(r.code, 1, `expected BLOCK exit 1 on re-encoded original\n${r.out}\n${r.err}`);
  assert.match(r.out, /original-image/, 'must block via pHash original-image scan');
  assert.match(r.out, /dHash distance/, 'must report a dHash distance match (not byte-identical)');
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARDRAIL clean-room: structureAuthorization 'unauthorized' => buildMode clean-room + DOM-derivative refused
// ─────────────────────────────────────────────────────────────────────────────
test('GUARDRAIL: structureAuthorization unauthorized => clean-room buildMode + DOM-derivative refused', async () => {
  const manifest = {
    meta: baseMeta(),
    slots: [
      // own content only (no retained originals) so the ONLY interesting axis is the clean-room verdict
      { number: 1, stableId: 'txt-1', type: 'text', role: 'content', provenance: 'user',
        mirrorLocator: { cssPath: 'h1', nth: 0 }, currentValue: 'Our headline',
        replacement: { kind: 'text', value: 'Our headline' } },
    ],
  };
  const { manifestPath, buildDir, repurposeDir } = await scaffold({
    manifest, fingerprint: baseFingerprint,
    buildFiles: { 'index.html': '<!doctype html><h1>Our headline</h1>' },
  });
  const attestPath = join(repurposeDir, 'attest.json');
  await writeFile(attestPath, JSON.stringify({ structureAuthorization: 'unauthorized', slots: {} }));

  const r = await runGate(['--manifest', manifestPath, '--build', buildDir, '--attest', attestPath, '--now', NOW]);
  assert.match(r.out, /buildMode: clean-room/, 'verdict.buildMode must be clean-room');
  assert.match(r.out, /DOM-derivative REFUSED/i, 'DOM-derivative must be refused and reported');
  // structure 'unauthorized' is a deliberate clean-room choice; with no retained originals + clean build it PASSES.
  assert.equal(r.code, 0, `clean-room with clean build should PASS\n${r.out}\n${r.err}`);
  // manifest write-back recorded the attestation
  const persisted = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(persisted.meta.structureAuthorization, 'unauthorized');
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARDRAIL analytics: GA4 'G-FIXTURE12' or google-site-verification in a build file => exit 1
// ─────────────────────────────────────────────────────────────────────────────
test('GUARDRAIL: GA4 id present => BLOCK (exit 1)', async () => {
  const manifest = { meta: baseMeta(), slots: [] };
  const { manifestPath, buildDir, repurposeDir } = await scaffold({
    manifest, fingerprint: baseFingerprint,
    buildFiles: { 'app.js': "gtag('config','G-FIXTURE12');" },
  });
  const attestPath = join(repurposeDir, 'attest.json');
  await writeFile(attestPath, JSON.stringify({ structureAuthorization: 'authorized', slots: {} }));

  const r = await runGate(['--manifest', manifestPath, '--build', buildDir, '--attest', attestPath, '--now', NOW]);
  assert.equal(r.code, 1, `expected BLOCK on GA4 id\n${r.out}\n${r.err}`);
  assert.match(r.out, /analytics-id/, 'must flag analytics-id block');
});

test('GUARDRAIL: google-site-verification present => BLOCK (exit 1)', async () => {
  const manifest = { meta: baseMeta(), slots: [] };
  const { manifestPath, buildDir, repurposeDir } = await scaffold({
    manifest, fingerprint: baseFingerprint,
    buildFiles: { 'index.html': '<!doctype html><meta name="google-site-verification" content="xyz">' },
  });
  const attestPath = join(repurposeDir, 'attest.json');
  await writeFile(attestPath, JSON.stringify({ structureAuthorization: 'authorized', slots: {} }));

  const r = await runGate(['--manifest', manifestPath, '--build', buildDir, '--attest', attestPath, '--now', NOW]);
  assert.equal(r.code, 1, `expected BLOCK on google-site-verification\n${r.out}\n${r.err}`);
  assert.match(r.out, /analytics-id/, 'must flag analytics-id block for verification meta');
});

// ─────────────────────────────────────────────────────────────────────────────
// HAPPY PATH: attested authorized, own/swapped assets only, no analytics, no original images => exit 0 + NOTICE
// ─────────────────────────────────────────────────────────────────────────────
test('HAPPY PATH: clean authorized build => PASS (exit 0) + NOTICE written', async () => {
  // own image (not an original), swapped text, no paid fonts, no analytics, no brand string
  const ownPng = await makePng(40, 40, 99);
  const manifest = {
    meta: baseMeta(),
    slots: [
      // a retained original that the user explicitly KEEPS (clears blocking without per-slot auth need? — no:
      // keep clears it from retained-originals entirely)
      { number: 1, stableId: 'txt-1', type: 'text', role: 'content', provenance: 'user',
        mirrorLocator: { cssPath: 'h1', nth: 0 }, currentValue: 'Brand new headline',
        replacement: { kind: 'text', value: 'Brand new headline' } },
      // an original image that the user SWAPPED (has a replacement) — not retained, not in build
      imgSlot(2, { byteSha: 'deadbeef', dHash: 'ffffffffffffffff' }),
    ],
  };
  // give slot 2 a replacement so it isn't a retained original
  manifest.slots[1].replacement = { kind: 'asset', assetRef: 'repurpose/assets/slot-2/own.png', generated: ['own.png'] };

  const { manifestPath, buildDir, repurposeDir } = await scaffold({
    manifest, fingerprint: baseFingerprint,
    buildFiles: {
      'index.html': '<!doctype html><html><head><title>Fresh Site</title></head><body><h1>Brand new headline</h1><img src="/assets/own.png"></body></html>',
      'assets/own.png': ownPng,
      'styles.css': 'body{font-family:Inter,system-ui,sans-serif}',
    },
  });
  const attestPath = join(repurposeDir, 'attest.json');
  await writeFile(attestPath, JSON.stringify({ structureAuthorization: 'authorized', slots: {} }));

  const r = await runGate(['--manifest', manifestPath, '--build', buildDir, '--attest', attestPath, '--now', NOW]);
  assert.equal(r.code, 0, `expected PASS exit 0\n${r.out}\n${r.err}`);
  assert.match(r.out, /VERDICT  : PASS/, 'verdict should be PASS');

  // NOTICE written into the build
  const noticePath = join(buildDir, 'NOTICE');
  await access(noticePath); // throws if missing
  const notice = await readFile(noticePath, 'utf8');
  assert.match(notice, /publish-gate/, 'NOTICE has the gate header');
  assert.match(notice, /no unmodified original detected/, 'NOTICE asserts no unmodified original detected');
  assert.match(notice, /NOTICE-id: [0-9a-f]{12}/, 'NOTICE carries a content-derived id');
});

// ─────────────────────────────────────────────────────────────────────────────
// DRIFT GUARD: fingerprint mismatch => BLOCK (exit 1)
// ─────────────────────────────────────────────────────────────────────────────
test('DRIFT GUARD: stale manifest fingerprint => BLOCK (exit 1)', async () => {
  const manifest = { meta: baseMeta({ buildFingerprint: 'STALE+xxx' }), slots: [] };
  const { manifestPath, buildDir, repurposeDir } = await scaffold({
    manifest, fingerprint: baseFingerprint, // fingerprint file says build-7+crawl-abc
    buildFiles: { 'index.html': '<!doctype html><h1>x</h1>' },
  });
  const attestPath = join(repurposeDir, 'attest.json');
  await writeFile(attestPath, JSON.stringify({ structureAuthorization: 'authorized', slots: {} }));

  const r = await runGate(['--manifest', manifestPath, '--build', buildDir, '--attest', attestPath, '--now', NOW]);
  assert.equal(r.code, 1, `expected BLOCK on drift\n${r.out}\n${r.err}`);
  assert.match(r.out, /drift/, 'must report a drift block');
});

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISM: two runs over a frozen build + frozen --now => byte-identical NOTICE
// ─────────────────────────────────────────────────────────────────────────────
test('DETERMINISM: NOTICE is byte-identical across two runs (frozen --now)', async () => {
  const manifest = { meta: baseMeta(), slots: [] };
  const { manifestPath, buildDir, repurposeDir } = await scaffold({
    manifest, fingerprint: baseFingerprint,
    buildFiles: { 'index.html': '<!doctype html><h1>fresh</h1>' },
  });
  const attestPath = join(repurposeDir, 'attest.json');
  await writeFile(attestPath, JSON.stringify({ structureAuthorization: 'authorized', slots: {} }));

  const r1 = await runGate(['--manifest', manifestPath, '--build', buildDir, '--attest', attestPath, '--now', NOW]);
  assert.equal(r1.code, 0, `run1 should PASS\n${r1.out}\n${r1.err}`);
  const notice1 = await readFile(join(buildDir, 'NOTICE'), 'utf8');
  const r2 = await runGate(['--manifest', manifestPath, '--build', buildDir, '--attest', attestPath, '--now', NOW]);
  assert.equal(r2.code, 0, 'run2 should PASS');
  const notice2 = await readFile(join(buildDir, 'NOTICE'), 'utf8');
  assert.equal(notice1, notice2, 'NOTICE must be byte-identical across runs');
});
