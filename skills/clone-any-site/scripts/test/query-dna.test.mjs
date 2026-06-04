// query-dna.test.mjs — CLI integration tests for query-dna.mjs (Task 3.1).
// Uses spawnSync subprocess approach (same pattern as distill-market.test.mjs).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname, '..');
const QUERY_DNA = join(SCRIPTS, 'query-dna.mjs');
const FIXTURE_DNA = join(__dirname, 'fixtures', 'dna.json');
const WORK = join(__dirname, '.work', 'query-dna');

// A tmp dir that CONTAINS dna.json (the --lib arg points to the parent dir of dna.json)
let TMP_LIB;
// A tmp dir with NO dna.json (for the missing-file test)
let EMPTY_LIB;

function runQuery(...args) {
  return spawnSync(process.execPath, [QUERY_DNA, ...args], {
    encoding: 'utf8',
    cwd: SCRIPTS,
  });
}

before(async () => {
  await mkdir(WORK, { recursive: true });

  // Build TMP_LIB: a directory that contains dna.json at its root
  TMP_LIB = join(WORK, 'lib-with-dna');
  await mkdir(TMP_LIB, { recursive: true });
  await cp(FIXTURE_DNA, join(TMP_LIB, 'dna.json'));

  // Build EMPTY_LIB: a directory with no dna.json
  EMPTY_LIB = join(WORK, 'lib-empty');
  await mkdir(EMPTY_LIB, { recursive: true });
});

after(async () => {
  try { await rm(WORK, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// --json mode: filter artifact + dimension (key) + tier
// ---------------------------------------------------------------------------

test('--json: artifact+dimension+tier green → exit 0, count=1, all cards match', () => {
  const r = runQuery(
    '--lib', TMP_LIB,
    '--artifact', 'landing',
    '--dimension', 'micro-interactions',
    '--tier', 'green',
    '--json',
  );
  assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.count, 1, `expected count=1; got ${out.count}`);
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].slug, 'a-micro-green');
  assert.equal(out.cards[0].feasibilityTier, 'green');
  assert.ok(out.cards[0].dimensions.includes(6), 'card must include dim 6');
});

// ---------------------------------------------------------------------------
// --dimension numeric id gives same result as key string
// ---------------------------------------------------------------------------

test('--dimension 6 (numeric) same result as --dimension micro-interactions', () => {
  const rKey = runQuery(
    '--lib', TMP_LIB,
    '--artifact', 'landing',
    '--dimension', 'micro-interactions',
    '--tier', 'green',
    '--json',
  );
  const rNum = runQuery(
    '--lib', TMP_LIB,
    '--artifact', 'landing',
    '--dimension', '6',
    '--tier', 'green',
    '--json',
  );
  assert.equal(rKey.status, 0);
  assert.equal(rNum.status, 0);
  const outKey = JSON.parse(rKey.stdout);
  const outNum = JSON.parse(rNum.stdout);
  assert.equal(outKey.count, outNum.count, 'count must match for key vs numeric id');
  assert.deepEqual(
    outKey.cards.map((c) => c.slug),
    outNum.cards.map((c) => c.slug),
    'slugs must match for key vs numeric id',
  );
});

// ---------------------------------------------------------------------------
// --limit
// ---------------------------------------------------------------------------

test('--limit 1 returns exactly 1 card', () => {
  const r = runQuery(
    '--lib', TMP_LIB,
    '--artifact', 'landing',
    '--limit', '1',
    '--json',
  );
  assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.cards.length, 1, `expected 1 card; got ${out.cards.length}`);
});

// ---------------------------------------------------------------------------
// No match → exit 0, count=0, empty array
// ---------------------------------------------------------------------------

test('no-match query (artifact=pdf, no pdf cards) → exit 0, count=0, cards=[]', () => {
  const r = runQuery(
    '--lib', TMP_LIB,
    '--artifact', 'pdf',
    '--json',
  );
  assert.equal(r.status, 0, `expected exit 0 on no match; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.count, 0, `expected count=0; got ${out.count}`);
  assert.deepEqual(out.cards, [], 'expected empty cards array');
});

// ---------------------------------------------------------------------------
// Missing dna.json → exit 2, stderr mentions "seed"
// ---------------------------------------------------------------------------

test('missing dna.json → exit 2, stderr mentions seed', () => {
  const r = runQuery('--lib', EMPTY_LIB, '--json');
  assert.equal(r.status, 2, `expected exit 2; got ${r.status}; stderr=${r.stderr}`);
  assert.ok(
    r.stderr.toLowerCase().includes('seed'),
    `expected "seed" in stderr; got: ${r.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// Default (no --json) → human table printed, known slug present, exit 0
// ---------------------------------------------------------------------------

test('default (no --json) prints table with known slug, exit 0', () => {
  const r = runQuery(
    '--lib', TMP_LIB,
    '--artifact', 'landing',
    '--dimension', 'micro-interactions',
    '--tier', 'green',
  );
  assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  assert.ok(r.stdout.includes('a-micro-green'), `expected slug in table; got: ${r.stdout}`);
  // Footer with count=N
  assert.ok(r.stdout.includes('count='), `expected count= footer in table; got: ${r.stdout}`);
});
