// node:test for distill-techniques.mjs — the technique-absorption ledger.
// Runs the real CLI as a subprocess against the fixture effects-inventory, into a temp lib
// under .work/ (gitignored). Verifies card creation, the TECHNIQUES.md index, and idempotent
// cross-clone dedup of seenOnSites.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEffectTable, inferFeasibilityFromStack, inferDimensions } from '../distill-techniques.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));            // .../scripts/test
const SCRIPTS_DIR = dirname(__dirname);                                // .../scripts
const SCRIPT = join(SCRIPTS_DIR, 'distill-techniques.mjs');
const FIXTURE = join(__dirname, 'fixtures', 'effects-inventory.md');
const FIXTURE_TABLE = join(__dirname, 'fixtures', 'effects-inventory-table.md');

// unique, deterministic-per-file work dir under the gitignored .work/
const WORK = join(__dirname, '.work', 'distill-techniques');
const LIB = join(WORK, 'design-system', 'clone-techniques');
const CARDS = join(LIB, 'cards');
const NOW = '2026-05-30T00:00:00.000Z'; // fixed clock-in; the script must not read the wall clock

function distill(clone) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--clone', clone, '--effects', FIXTURE, '--lib', LIB, '--now', NOW],
    { encoding: 'utf8' },
  );
}

async function listCards() {
  if (!existsSync(CARDS)) return [];
  return (await readdir(CARDS)).filter((f) => f.endsWith('.md')).sort();
}

function seenOnSitesOf(cardText) {
  const m = cardText.match(/^seenOnSites:\s*\[(.*)\]\s*$/m);
  if (!m) return [];
  const inner = m[1].trim();
  return inner.length ? inner.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

before(async () => {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  assert.ok(existsSync(SCRIPT), `script missing: ${SCRIPT}`);
  assert.ok(existsSync(FIXTURE), `fixture missing: ${FIXTURE}`);
});

after(async () => {
  await rm(WORK, { recursive: true, force: true });
});

test('run 1 (fixtureA): creates 3..7 cards + TECHNIQUES.md + seenOnSites includes fixtureA', async () => {
  const r = distill('fixtureA');
  assert.equal(r.status, 0, `exit 0 expected; stderr=${r.stderr}`);

  const cards = await listCards();
  assert.ok(cards.length >= 3 && cards.length <= 7, `expected 3..7 cards, got ${cards.length}: ${cards.join(', ')}`);

  // TECHNIQUES.md index exists
  assert.ok(existsSync(join(LIB, 'TECHNIQUES.md')), 'TECHNIQUES.md index should exist');

  // at least one card lists seenOnSites including 'fixtureA'
  let foundA = false;
  for (const f of cards) {
    const txt = await readFile(join(CARDS, f), 'utf8');
    const seen = seenOnSitesOf(txt);
    if (seen.includes('fixtureA')) foundA = true;
    // each created card carries the required frontmatter + sections
    assert.match(txt, /^slug:\s+/m, `${f} missing slug frontmatter`);
    assert.match(txt, /^firstSeen:\s+/m, `${f} missing firstSeen frontmatter`);
    assert.match(txt, /## Mechanism/, `${f} missing ## Mechanism`);
    assert.match(txt, /## Code sketch/, `${f} missing ## Code sketch`);
    assert.match(txt, /## Where to reuse/, `${f} missing ## Where to reuse`);
    assert.match(txt, /## Source/, `${f} missing ## Source`);
  }
  assert.ok(foundA, "expected a card whose seenOnSites includes 'fixtureA'");

  // stdout is JSON { cards: [...] }
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.cards), 'stdout JSON should have cards[]');
  assert.ok(parsed.cards.length >= 3 && parsed.cards.length <= 7, 'JSON cards 3..7');
});

test('run 2 (fixtureB, SAME lib): NO duplicate cards; seenOnSites now has BOTH fixtureA and fixtureB', async () => {
  const beforeFiles = await listCards();

  const r = distill('fixtureB');
  assert.equal(r.status, 0, `exit 0 expected; stderr=${r.stderr}`);

  const afterFiles = await listCards();
  // no new card files for the same techniques (same fixture => same slugs)
  assert.deepEqual(afterFiles, beforeFiles, `card set must not grow on dedup. before=${beforeFiles} after=${afterFiles}`);

  // every card now lists BOTH clones (the fixture techniques are common to both runs)
  for (const f of afterFiles) {
    const txt = await readFile(join(CARDS, f), 'utf8');
    const seen = seenOnSitesOf(txt);
    assert.ok(seen.includes('fixtureA'), `${f} seenOnSites must include fixtureA (got ${seen})`);
    assert.ok(seen.includes('fixtureB'), `${f} seenOnSites must include fixtureB (got ${seen})`);
    // a variant note for fixtureB was appended
    assert.match(txt, /^### Variant seen on fixtureB\s*$/m, `${f} missing variant note for fixtureB`);
  }
});

test('run 3 (fixtureA again): seenOnSites still lists fixtureA exactly once (idempotent)', async () => {
  const beforeFiles = await listCards();

  const r = distill('fixtureA');
  assert.equal(r.status, 0, `exit 0 expected; stderr=${r.stderr}`);

  const afterFiles = await listCards();
  assert.deepEqual(afterFiles, beforeFiles, 'card set must not grow on idempotent re-run');

  for (const f of afterFiles) {
    const txt = await readFile(join(CARDS, f), 'utf8');
    const seen = seenOnSitesOf(txt);
    const countA = seen.filter((s) => s === 'fixtureA').length;
    assert.equal(countA, 1, `${f} must list fixtureA exactly once (got ${countA}: ${seen})`);
    // and at most one variant note per clone (no duplicate appends)
    const variantA = (txt.match(/^### Variant seen on fixtureA\s*$/gm) || []).length;
    assert.ok(variantA <= 1, `${f} should have at most one fixtureA variant note (got ${variantA})`);
  }
});

test('determinism: a frozen input produces byte-identical card output across two fresh runs', async () => {
  // fresh isolated libs so we compare clean run-vs-run
  const libX = join(WORK, 'detX', 'lib');
  const libY = join(WORK, 'detY', 'lib');
  const runInto = (lib) => spawnSync(
    process.execPath,
    [SCRIPT, '--clone', 'detClone', '--effects', FIXTURE, '--lib', lib, '--now', NOW],
    { encoding: 'utf8' },
  );
  const rx = runInto(libX);
  const ry = runInto(libY);
  assert.equal(rx.status, 0, `det run X exit 0; stderr=${rx.stderr}`);
  assert.equal(ry.status, 0, `det run Y exit 0; stderr=${ry.stderr}`);

  const readAll = async (lib) => {
    const dir = join(lib, 'cards');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    const out = {};
    for (const f of files) out[f] = await readFile(join(dir, f), 'utf8');
    out['__index__'] = await readFile(join(lib, 'TECHNIQUES.md'), 'utf8');
    return out;
  };
  const ax = await readAll(libX);
  const ay = await readAll(libY);
  assert.deepEqual(Object.keys(ax).sort(), Object.keys(ay).sort(), 'same file set across runs');
  for (const k of Object.keys(ax)) {
    assert.equal(ax[k], ay[k], `file ${k} must be byte-identical across deterministic runs`);
  }
});

// ---------------------------------------------------------------------------
// Task 2.1 — DNA mode tests (--schema dna)
// ---------------------------------------------------------------------------

// DNA work dir is isolated from the legacy work dir to avoid cross-contamination.
const DNA_WORK = join(__dirname, '.work', 'distill-techniques-dna');
const DNA_LIB  = join(DNA_WORK, 'design-system', 'design-dna');
const DNA_CARDS = join(DNA_LIB, 'cards');
const DNA_NOW  = '2026-06-02T00:00:00.000Z';

function distillDna(clone, lib, fixture) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--schema', 'dna', '--clone', clone, '--effects', fixture ?? FIXTURE_TABLE,
     '--lib', lib ?? DNA_LIB, '--now', DNA_NOW],
    { encoding: 'utf8' },
  );
}

before(async () => {
  await rm(DNA_WORK, { recursive: true, force: true });
  await mkdir(DNA_WORK, { recursive: true });
  assert.ok(existsSync(FIXTURE_TABLE), `table fixture missing: ${FIXTURE_TABLE}`);
});

after(async () => {
  await rm(DNA_WORK, { recursive: true, force: true });
});

// --- unit: parseEffectTable ---

test('parseEffectTable: extracts candidates from GFM table with Effect+Mechanism columns', async () => {
  const md = await readFile(FIXTURE_TABLE, 'utf8');
  const rows = parseEffectTable(md);
  assert.ok(Array.isArray(rows), 'should return array');
  assert.ok(rows.length >= 2, `expected >= 2 rows, got ${rows.length}`);
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('Hero + typewriter'), `expected 'Hero + typewriter' in ${names}`);
  assert.ok(names.includes('Scroll parallax'), `expected 'Scroll parallax' in ${names}`);
});

test('parseEffectTable: strips markdown bold from names', async () => {
  const md = await readFile(FIXTURE_TABLE, 'utf8');
  const rows = parseEffectTable(md);
  for (const r of rows) {
    assert.ok(!r.name.includes('**'), `name should not contain ** : ${r.name}`);
  }
});

test('parseEffectTable: captures mechanismHint and refId', async () => {
  const md = await readFile(FIXTURE_TABLE, 'utf8');
  const rows = parseEffectTable(md);
  const e1 = rows.find((r) => r.name === 'Hero + typewriter');
  assert.ok(e1, 'E1 row must be found');
  assert.ok(e1.mechanismHint && e1.mechanismHint.length > 0, 'mechanismHint should be non-empty');
  assert.equal(e1.refId, 'E1');
  const e2 = rows.find((r) => r.name === 'Scroll parallax');
  assert.ok(e2, 'E2 row must be found');
  assert.equal(e2.refId, 'E2');
});

test('parseEffectTable: rejects table without Effect/Technique + Mechanism columns', () => {
  const md = `| ID | Name | Note |\n|---|---|---|\n| 1 | foo | bar |`;
  const rows = parseEffectTable(md);
  assert.equal(rows.length, 0, 'should return [] for non-effect-table');
});

test('parseEffectTable: returns [] for heading-only markdown (legacy fixture)', async () => {
  const md = await readFile(FIXTURE, 'utf8');
  const rows = parseEffectTable(md);
  // heading-based fixture has no GFM table with Effect+Mechanism → empty
  assert.equal(rows.length, 0, `expected 0 rows for heading-only fixture, got ${rows.length}`);
});

// --- unit: inferFeasibilityFromStack ---

test('inferFeasibilityFromStack: negated tokens → green', async () => {
  const md = await readFile(FIXTURE_TABLE, 'utf8');
  const tier = inferFeasibilityFromStack(md);
  assert.equal(tier, 'green', `expected green for all-negated stack, got ${tier}`);
});

test('inferFeasibilityFromStack: non-negated three.js → red', () => {
  const tier = inferFeasibilityFromStack('uses three.js for rendering');
  assert.equal(tier, 'red', `expected red for three.js, got ${tier}`);
});

test('inferFeasibilityFromStack: non-negated GSAP → yellow', () => {
  const tier = inferFeasibilityFromStack('uses GSAP for animation');
  assert.equal(tier, 'yellow', `expected yellow for gsap, got ${tier}`);
});

test('inferFeasibilityFromStack: red beats yellow (webgl + gsap)', () => {
  const tier = inferFeasibilityFromStack('built with webgl and gsap');
  assert.equal(tier, 'red');
});

test('inferFeasibilityFromStack: negated webgl → not red', () => {
  const tier = inferFeasibilityFromStack('no webgl, no canvas, uses gsap');
  // webgl negated → not red; gsap non-negated → yellow
  assert.equal(tier, 'yellow');
});

// --- unit: inferDimensions ---

test('inferDimensions: typewriter → includes kinetic-type (id=3)', () => {
  const dims = inferDimensions('Hero + typewriter', 'types the headline letter by letter');
  assert.ok(dims.includes(3), `expected dim 3 (kinetic-type), got [${dims}]`);
});

test('inferDimensions: scroll parallax → includes motion (id=1)', () => {
  const dims = inferDimensions('Scroll parallax', 'translateY on scroll');
  assert.ok(dims.includes(1), `expected dim 1 (motion), got [${dims}]`);
});

test('inferDimensions: returns sorted unique ids in range 1..10', () => {
  const dims = inferDimensions('Scroll parallax', 'translateY');
  assert.ok(dims.length > 0, 'should return at least one dim');
  for (const d of dims) {
    assert.ok(d >= 1 && d <= 10, `dim ${d} out of range`);
  }
  const sorted = [...dims].sort((a, b) => a - b);
  assert.deepEqual(dims, sorted, 'dims must be sorted ascending');
  assert.equal(dims.length, new Set(dims).size, 'dims must be unique');
});

test('inferDimensions: unknown name defaults to [1]', () => {
  const dims = inferDimensions('zzzunknown', 'zzzunknown');
  assert.deepEqual(dims, [1]);
});

// --- integration: --schema dna CLI ---

test('dna mode: exits 0, writes cards with dna frontmatter', async () => {
  const r = distillDna('eiger-extreme');
  assert.equal(r.status, 0, `exit 0 expected; stderr=${r.stderr}`);

  // cards dir must exist with at least 2 cards
  const files = (await readdir(DNA_CARDS)).filter((f) => f.endsWith('.md')).sort();
  assert.ok(files.length >= 2, `expected >= 2 dna cards, got ${files.length}: ${files.join(', ')}`);

  // each card has dna frontmatter fields
  for (const f of files) {
    const txt = await readFile(join(DNA_CARDS, f), 'utf8');
    assert.match(txt, /^feasibilityTier:\s+/m, `${f} missing feasibilityTier`);
    assert.match(txt, /^dimensions:\s+\[/m, `${f} missing dimensions array`);
    assert.match(txt, /^status:\s+stub/m, `${f} missing status: stub`);
    assert.match(txt, /^source:\s+clone/m, `${f} missing source: clone`);
  }
});

test('dna mode: writes TECHNIQUES.md (grouped index)', async () => {
  assert.ok(existsSync(join(DNA_LIB, 'TECHNIQUES.md')), 'TECHNIQUES.md must exist');
  const idx = await readFile(join(DNA_LIB, 'TECHNIQUES.md'), 'utf8');
  assert.ok(idx.length > 0, 'index must be non-empty');
});

test('dna mode: writes dna.json (stubs excluded → may be empty array [])', async () => {
  assert.ok(existsSync(join(DNA_LIB, 'dna.json')), 'dna.json must exist');
  const raw = await readFile(join(DNA_LIB, 'dna.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed.schema, 'number', 'dna.json must have schema field');
  assert.ok(Array.isArray(parsed.cards), 'dna.json must have cards array');
  // stubs have TODO intent → fail validateCard → excluded from dna.json
  assert.equal(parsed.cards.length, 0, 'stub cards must be excluded from dna.json');
});

test('dna mode: stdout JSON has cards array', () => {
  const r = distillDna('eiger-extreme', join(DNA_WORK, 'stdout-check', 'lib'));
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.cards), 'stdout JSON must have cards[]');
});

test('dna mode: legacy mode (no --schema) still uses legacy lib + heading parser', () => {
  // legacy run against heading fixture must still work (byte-identical)
  const legLib = join(DNA_WORK, 'legacy-check', 'lib');
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--clone', 'legacyClone', '--effects', FIXTURE, '--lib', legLib, '--now', NOW],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `legacy mode must still exit 0; stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.cards.length >= 3 && parsed.cards.length <= 7, 'legacy: 3..7 cards');
  // must NOT have dna.json
  assert.ok(!existsSync(join(legLib, 'dna.json')), 'legacy mode must not write dna.json');
});
