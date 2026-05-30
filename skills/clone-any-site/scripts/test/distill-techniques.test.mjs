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

const __dirname = dirname(fileURLToPath(import.meta.url));            // .../scripts/test
const SCRIPTS_DIR = dirname(__dirname);                                // .../scripts
const SCRIPT = join(SCRIPTS_DIR, 'distill-techniques.mjs');
const FIXTURE = join(__dirname, 'fixtures', 'effects-inventory.md');

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
