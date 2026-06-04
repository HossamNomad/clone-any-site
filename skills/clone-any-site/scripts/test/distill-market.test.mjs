// distill-market.test.mjs — TDD suite for distill-market.mjs (Task 2.2).
// Tests parseMarketNote (pure unit) + CLI integration (IP guard, dedup, determinism).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rm, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = resolve(__dirname, '..');
const DISTILL_MARKET = join(SCRIPTS, 'distill-market.mjs');
const FIXTURE = join(__dirname, 'fixtures', 'market-note.md');
const WORK = join(__dirname, '.work', 'distill-market');

// The fenced code block string from the fixture — must NEVER appear in cards.
const SECRET_CODE_STRING = 'SECRET_VERBATIM';

const NOW = '2026-06-02T00:00:00.000Z';

// ---------------------------------------------------------------------------
// parseMarketNote — pure unit tests (import directly)
// ---------------------------------------------------------------------------
let parseMarketNote;
before(async () => {
  const mod = await import(pathToFileURL(DISTILL_MARKET).href);
  parseMarketNote = mod.parseMarketNote;
});

test('parseMarketNote — returns 2 technique blocks from fixture', async () => {
  const md = await readFile(FIXTURE, 'utf8');
  const blocks = parseMarketNote(md);
  assert.equal(blocks.length, 2, `expected 2 blocks, got ${blocks.length}`);
});

test('parseMarketNote — "Magnetic cursor" block has correct fields', async () => {
  const md = await readFile(FIXTURE, 'utf8');
  const blocks = parseMarketNote(md);
  const mc = blocks.find((b) => b.name === 'Magnetic cursor');
  assert.ok(mc, 'expected a block named "Magnetic cursor"');
  assert.equal(mc.tier, 'green');
  // dimensions must include the id for micro-interactions (6) and motion (1)
  assert.ok(mc.dimensions.includes(6), `expected dim 6 (micro-interactions), got: ${mc.dimensions}`);
  assert.ok(mc.dimensions.includes(1), `expected dim 1 (motion), got: ${mc.dimensions}`);
  // artifactFit order per note: site, landing
  assert.deepEqual(mc.artifactFit, ['site', 'landing']);
  // intent non-empty
  assert.ok(mc.intent && mc.intent.length > 10, 'intent should be non-empty');
  // mechanism non-empty
  assert.ok(mc.mechanism && mc.mechanism.length > 5, 'mechanism should be non-empty');
  // no approximation for green
  assert.ok(!mc.approximation, 'green card should have no approximation');
});

test('parseMarketNote — "WebGL fluid hero" block has tier=red + approximation', async () => {
  const md = await readFile(FIXTURE, 'utf8');
  const blocks = parseMarketNote(md);
  const wh = blocks.find((b) => b.name === 'WebGL fluid hero');
  assert.ok(wh, 'expected a block named "WebGL fluid hero"');
  assert.equal(wh.tier, 'red');
  assert.ok(wh.dimensions.includes(2), `expected dim 2 (immersion), got: ${wh.dimensions}`);
  assert.ok(wh.approximation && wh.approximation.length > 5, 'red card must have approximation');
  // artifactFit
  assert.deepEqual(wh.artifactFit, ['site']);
});

test('parseMarketNote — unknown dimension keys are dropped', async () => {
  const md = `## Test technique\n- dimension: motion, totally-unknown-xyz\n- tier: green\n- artifactFit: site\n- intent: test intent\n- mechanism: test mech\n`;
  const blocks = parseMarketNote(md);
  assert.equal(blocks.length, 1);
  // only motion (id=1) should survive
  assert.deepEqual(blocks[0].dimensions, [1]);
});

// ---------------------------------------------------------------------------
// CLI integration tests
// ---------------------------------------------------------------------------

function runMarket(studio, notePath, lib, now = NOW, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [DISTILL_MARKET,
     '--studio', studio, '--note', notePath, '--lib', lib, '--now', now,
     ...extraArgs],
    { encoding: 'utf8', cwd: SCRIPTS },
  );
}

let TMP_LIB;

before(async () => {
  await mkdir(WORK, { recursive: true });
  TMP_LIB = await mkdtemp(join(WORK, 'lib-'));
});

after(async () => {
  try { await rm(WORK, { recursive: true, force: true }); } catch {}
});

test('CLI — exits 0 and writes magnetic-cursor.md with dna frontmatter', async () => {
  const r = runMarket('Active Theory', FIXTURE, TMP_LIB);
  assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);

  const cardPath = join(TMP_LIB, 'cards', 'magnetic-cursor.md');
  assert.ok(existsSync(cardPath), `expected card at ${cardPath}`);

  const txt = await readFile(cardPath, 'utf8');
  // source: market
  assert.match(txt, /^source: market$/m, 'expected source: market in frontmatter');
  // seenOnSites includes Active Theory
  assert.match(txt, /seenOnSites:.*Active Theory/m, 'expected seenOnSites to include Active Theory');
  // feasibilityTier: green
  assert.match(txt, /^feasibilityTier: green$/m, 'expected feasibilityTier: green');
  // dimensions array
  assert.match(txt, /^dimensions: \[/m, 'expected dimensions array');
  // status: stub
  assert.match(txt, /^status: stub$/m, 'expected status: stub');
  // firstSeen from --now
  assert.match(txt, new RegExp(NOW.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'expected firstSeen = --now value');
});

test('CLI — red card body contains ## Approximation section', async () => {
  const cardPath = join(TMP_LIB, 'cards', 'webgl-fluid-hero.md');
  assert.ok(existsSync(cardPath), `expected webgl-fluid-hero.md`);
  const txt = await readFile(cardPath, 'utf8');
  assert.match(txt, /^## Approximation$/m, 'red card must have ## Approximation');
});

test('CLI — fenced code from note is NOT copied into any card', async () => {
  const cardsDir = join(TMP_LIB, 'cards');
  const files = (await readFile(join(cardsDir, 'magnetic-cursor.md'), 'utf8') +
                 await readFile(join(cardsDir, 'webgl-fluid-hero.md'), 'utf8'));
  assert.ok(!files.includes(SECRET_CODE_STRING),
    `SECRET_CODE_STRING "${SECRET_CODE_STRING}" must not appear in any card`);
  // The ## Code section should be the TODO placeholder only
  const mcTxt = await readFile(join(cardsDir, 'magnetic-cursor.md'), 'utf8');
  assert.match(mcTxt, /GENERIC, original-free recipe/, '## Code must be the TODO placeholder');
});

test('CLI — dedup: second studio with same technique bumps seenOnSites + appends variant note', async () => {
  // Note with the same technique name
  const sameNote = join(WORK, 'resn-note.md');
  await writeFile(sameNote,
    `## Magnetic cursor\n- dimension: motion\n- tier: green\n- artifactFit: landing\n- intent: Same technique seen at Resn too.\n- mechanism: Same core rAF loop.\n`,
    'utf8');

  const r = runMarket('Resn', sameNote, TMP_LIB);
  assert.equal(r.status, 0, `expected exit 0 on dedup run; stderr=${r.stderr}`);

  const cardPath = join(TMP_LIB, 'cards', 'magnetic-cursor.md');
  const txt = await readFile(cardPath, 'utf8');

  // seenOnSites includes both studios
  assert.match(txt, /seenOnSites:.*Active Theory/m, 'seenOnSites must retain Active Theory');
  assert.match(txt, /seenOnSites:.*Resn/m, 'seenOnSites must include Resn');

  // variant note appended
  assert.match(txt, /^### Variant seen on Resn$/m, 'variant note for Resn must be appended');
});

test('CLI — dedup is idempotent: re-running same studio+technique does not duplicate variant note or seenOnSites entry', async () => {
  // Run "Resn" again on the same note
  const sameNote = join(WORK, 'resn-note.md');
  const r = runMarket('Resn', sameNote, TMP_LIB);
  assert.equal(r.status, 0, `expected exit 0 on idempotent re-run; stderr=${r.stderr}`);

  const cardPath = join(TMP_LIB, 'cards', 'magnetic-cursor.md');
  const txt = await readFile(cardPath, 'utf8');

  // seenOnSites: Resn appears exactly once
  const seenLine = txt.match(/^seenOnSites:\s*\[(.*)\]$/m)?.[1] || '';
  const sites = seenLine.split(',').map((s) => s.trim()).filter(Boolean);
  const resnCount = sites.filter((s) => s === 'Resn').length;
  assert.equal(resnCount, 1, `Resn must appear exactly once in seenOnSites (got ${resnCount})`);

  // variant note for Resn appears exactly once
  const variantMatches = (txt.match(/^### Variant seen on Resn$/gm) || []).length;
  assert.equal(variantMatches, 1, `variant note for Resn must appear exactly once (got ${variantMatches})`);
});

// ---------------------------------------------------------------------------
// flagSuspectCode unit tests (delegated — already tested in dna-card.test.mjs,
// but we add a direct sanity here for the market path)
// ---------------------------------------------------------------------------
test('flagSuspectCode — flags a pathological >220-line block', async () => {
  const { flagSuspectCode } = await import(pathToFileURL(join(SCRIPTS, 'lib', 'dna-card.mjs')).href);
  const lines = Array.from({ length: 230 }, (_, i) => `const x${i} = ${i};`).join('\n');
  const body = `## Code\n\n\`\`\`js\n${lines}\n\`\`\`\n`;
  assert.ok(flagSuspectCode(body) !== null, 'expected flagged reason for >220-line block');
});

test('flagSuspectCode — flags >200-char no-space line', async () => {
  const { flagSuspectCode } = await import(pathToFileURL(join(SCRIPTS, 'lib', 'dna-card.mjs')).href);
  const minified = 'x'.repeat(201);
  const body = `## Code\n\n\`\`\`js\n${minified}\n\`\`\`\n`;
  assert.ok(flagSuspectCode(body) !== null, 'expected flagged reason for minified line');
});

// ---------------------------------------------------------------------------
// Determinism: two fresh runs with same --now → byte-identical card files
// ---------------------------------------------------------------------------
test('determinism — two runs with same --now produce byte-identical cards', async () => {
  const libX = join(WORK, 'det-x');
  const libY = join(WORK, 'det-y');
  await mkdir(libX, { recursive: true });
  await mkdir(libY, { recursive: true });

  const rX = runMarket('Active Theory', FIXTURE, libX);
  const rY = runMarket('Active Theory', FIXTURE, libY);

  assert.equal(rX.status, 0, `run X failed; stderr=${rX.stderr}`);
  assert.equal(rY.status, 0, `run Y failed; stderr=${rY.stderr}`);

  const cardSlug = 'magnetic-cursor.md';
  const textX = await readFile(join(libX, 'cards', cardSlug), 'utf8');
  const textY = await readFile(join(libY, 'cards', cardSlug), 'utf8');
  assert.equal(textX, textY, 'card files must be byte-identical across two fresh runs');
});
