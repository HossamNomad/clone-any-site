// dna-card.test.mjs — golden-snapshot regression suite for lib/dna-card.mjs (Task 1.2 + 1.3).
// Asserts BYTE-IDENTICAL legacy output so the extraction from distill-techniques.mjs
// cannot silently drift the card format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrontmatter, newCardBody, buildIndex, parseFrontmatter, fmArray, slugify,
  validateCard, flagSuspectCode, buildDnaJson,
} from '../lib/dna-card.mjs';

// ---------------------------------------------------------------------------
// GOLDEN constants — captured from distill-techniques.mjs BEFORE the refactor.
// Any change here = a byte-drift → regression.
// ---------------------------------------------------------------------------
const EXPECTED_FRONTMATTER =
  '---\n' +
  'slug: lenis-smooth-scroll\n' +
  'name: Lenis smooth scroll\n' +
  'category: scroll\n' +
  'seenOnSites: [a, b]\n' +
  'firstSeen: 2026-05-30T00:00:00.000Z\n' +
  '---';

const EXPECTED_BODY =
  '\n' +
  '# Lenis smooth scroll\n' +
  '\n' +
  '## Mechanism\n' +
  '\n' +
  '<!-- TODO: describe the conceptual how-it-works. Derived from the recon heading only;\n' +
  '     fill in the precise mechanism once studied in the mirror. -->\n' +
  '*Lenis smooth scroll* — conceptual mechanism not yet derived from the heading alone. **TODO:** explain\n' +
  'the underlying technique (what drives it, what state it reads, how it composes).\n' +
  '\n' +
  '## Code sketch\n' +
  '\n' +
  '```js\n' +
  '// GENERIC, original-free placeholder — a recipe, not the cloned source.\n' +
  '// Replace with a clean-room implementation of the technique.\n' +
  'export function applyTechnique(target, opts = {}) {\n' +
  '  // TODO: implement the generalized recipe here.\n' +
  '  return target;\n' +
  '}\n' +
  '```\n' +
  '\n' +
  '## Where to reuse\n' +
  '\n' +
  '- **Pulsia**: landing heroes, expedition pages, dashboard moments.\n' +
  '- **Atlas**: white-label cinematic-lounge client sites.\n' +
  '- **Clients**: any premium marketing page that needs this effect.\n' +
  '\n' +
  '## Source\n' +
  '\n' +
  '- [`clones/drinksom/_recon/effects-inventory.md`](../../../clones/drinksom/_recon/effects-inventory.md)\n';

const EXPECTED_INDEX =
  '# Clone techniques — absorption ledger\n' +
  '\n' +
  'Cumulative library of reusable front-end techniques distilled from cloned sites.\n' +
  'Metadata + generalized recipes only — no original asset bytes or source code.\n' +
  'Regenerated deterministically by `distill-techniques.mjs` (sorted by slug).\n' +
  '\n' +
  '| Technique | Category | Seen on N sites | Card |\n' +
  '|---|---|--:|---|\n' +
  '| A scroll | scroll | 2 | [a-scroll](cards/a-scroll.md) |\n' +
  '| B effect | effect | 1 | [b-effect](cards/b-effect.md) |\n';

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
test('legacy buildFrontmatter is byte-stable', () => {
  const out = buildFrontmatter({
    slug: 'lenis-smooth-scroll',
    name: 'Lenis smooth scroll',
    category: 'scroll',
    seenOnSites: ['b', 'a', 'a'],
    firstSeen: '2026-05-30T00:00:00.000Z',
  });
  assert.equal(out, EXPECTED_FRONTMATTER);
});

test('legacy buildFrontmatter with explicit schema=legacy is byte-stable', () => {
  const out = buildFrontmatter(
    { slug: 'lenis-smooth-scroll', name: 'Lenis smooth scroll', category: 'scroll', seenOnSites: ['b', 'a', 'a'], firstSeen: '2026-05-30T00:00:00.000Z' },
    { schema: 'legacy' },
  );
  assert.equal(out, EXPECTED_FRONTMATTER);
});

test('legacy newCardBody is byte-stable', () => {
  const out = newCardBody({ name: 'Lenis smooth scroll', clone: 'drinksom' });
  assert.equal(out, EXPECTED_BODY);
});

test('legacy buildIndex is byte-stable', () => {
  const out = buildIndex([
    { slug: 'b-effect', name: 'B effect', category: 'effect', seenOnSites: ['x'] },
    { slug: 'a-scroll', name: 'A scroll', category: 'scroll', seenOnSites: ['x', 'y'] },
  ]);
  assert.equal(out, EXPECTED_INDEX);
});

test('parseFrontmatter round-trips arrays + scalars', () => {
  const { fm } = parseFrontmatter('---\nslug: x\nseenOnSites: [a, b]\nname: Foo\n---\nbody');
  assert.equal(fm.slug, 'x');
  assert.deepEqual(fm.seenOnSites, ['a', 'b']);
  assert.equal(fm.name, 'Foo');
});

test('parseFrontmatter returns body remainder correctly', () => {
  const { fm, body } = parseFrontmatter('---\nslug: y\n---\nhello world');
  assert.equal(fm.slug, 'y');
  assert.equal(body, 'hello world');
});

test('parseFrontmatter with no frontmatter returns empty fm + full text as body', () => {
  const { fm, body } = parseFrontmatter('no frontmatter here');
  assert.deepEqual(fm, {});
  assert.equal(body, 'no frontmatter here');
});

test('fmArray sorts + dedups', () => {
  assert.equal(fmArray(['b', 'a', 'a']), '[a, b]');
  assert.equal(fmArray(['z', 'z', 'z']), '[z]');
  assert.equal(fmArray(['c', 'a', 'b']), '[a, b, c]');
});

test('slugify parity with legacy output', () => {
  assert.equal(slugify('Hero + Typewriter!'), 'hero-typewriter');
  assert.equal(slugify('Lenis smooth scroll'), 'lenis-smooth-scroll');
  assert.equal(slugify('WebGL Shader & Canvas'), 'webgl-shader-and-canvas');
  // empty / non-latin falls back to sha1-derived prefix
  const result = slugify('');
  assert.ok(result.startsWith('technique-'), `expected technique- prefix, got: ${result}`);
});

// ---------------------------------------------------------------------------
// Task 1.3 — dna schema tests
// ---------------------------------------------------------------------------

// Minimal valid DNA card fixture (used across multiple tests)
const DNA_CARD = {
  slug: 'x',
  name: 'X',
  category: 'motion',
  intent: 'why',
  whenToUse: 'w',
  artifactFit: ['landing', 'site'],
  feasibilityTier: 'green',
  dimensions: [3, 1],
  refExample: 'eiger',
  seenOnSites: ['a'],
  firstSeen: '2026-06-02T00:00:00.000Z',
};

test('dna buildFrontmatter — 11 keys in order, dimensions sorted numeric, artifactFit sorted deduped', () => {
  const out = buildFrontmatter(DNA_CARD, { schema: 'dna' });
  const lines = out.split('\n');
  // Must open and close with ---
  assert.equal(lines[0], '---');
  assert.equal(lines[lines.length - 1], '---');
  // Check key order: slug, name, category, intent, whenToUse, artifactFit, feasibilityTier, dimensions, refExample, seenOnSites, firstSeen
  const keys = lines.slice(1, -1).map((l) => l.split(':')[0].trim());
  assert.deepEqual(keys, ['slug', 'name', 'category', 'intent', 'whenToUse', 'artifactFit', 'feasibilityTier', 'dimensions', 'refExample', 'seenOnSites', 'firstSeen']);
  // dimensions sorted ascending numeric
  assert.ok(out.includes('dimensions: [1, 3]'), `expected 'dimensions: [1, 3]', got: ${out}`);
  // artifactFit sorted
  assert.ok(out.includes('artifactFit: [landing, site]'), `expected 'artifactFit: [landing, site]', got: ${out}`);
  // all 11 required keys present
  assert.equal(keys.length, 11);
});

test('dna buildFrontmatter — optional pass-throughs (status, source, review)', () => {
  const out = buildFrontmatter({ ...DNA_CARD, status: 'stub', source: 'eiger', review: 'verbatim-suspect' }, { schema: 'dna' });
  assert.ok(out.includes('status: stub'));
  assert.ok(out.includes('source: eiger'));
  assert.ok(out.includes('review: verbatim-suspect'));
});

test('dna newCardBody — has # name, ## Intent, ## Code sections', () => {
  const body = newCardBody({ name: 'X', artifactFit: ['landing'] }, { schema: 'dna' });
  assert.ok(body.includes('# X\n'));
  assert.ok(body.includes('## Intent\n'));
  assert.ok(body.includes('## Mechanism\n'));
  assert.ok(body.includes('## Code\n'));
  assert.ok(body.includes('## Where to reuse\n'));
  assert.ok(body.includes('## Source\n'));
  // No Approximation for green
  assert.ok(!body.includes('## Approximation\n'));
});

test('dna newCardBody — red card includes ## Approximation before ## Source', () => {
  const body = newCardBody({ name: 'Y', artifactFit: ['site'], feasibilityTier: 'red' }, { schema: 'dna' });
  assert.ok(body.includes('## Approximation\n'));
  // Approximation must appear before Source
  const approxIdx = body.indexOf('## Approximation');
  const sourceIdx = body.indexOf('## Source');
  assert.ok(approxIdx < sourceIdx, 'Approximation must precede Source');
});

// ---------------------------------------------------------------------------
// validateCard tests
// ---------------------------------------------------------------------------

const VALID_BODY_GREEN =
  '# X\n\n## Intent\nwhy\n\n## Mechanism\nmech\n\n## Code\n\n```js\nconst x = 1;\n```\n\n## Where to reuse\n- landing\n\n## Source\n- eiger\n';

test('validateCard — accepts a complete green card', () => {
  const fm = { ...DNA_CARD };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.equal(errors.join('\n'), '');
  assert.ok(ok);
});

test('validateCard — rejects missing intent', () => {
  const fm = { ...DNA_CARD, intent: '' };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /intent/i.test(e)));
});

test('validateCard — rejects TODO placeholder intent', () => {
  const fm = { ...DNA_CARD, intent: 'TODO' };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /intent/i.test(e)));
});

test('validateCard — rejects empty dimensions', () => {
  const fm = { ...DNA_CARD, dimensions: [] };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /dimension/i.test(e)));
});

test('validateCard — rejects out-of-range dimension (0)', () => {
  const fm = { ...DNA_CARD, dimensions: [0, 3] };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /dimension/i.test(e)));
});

test('validateCard — rejects out-of-range dimension (11)', () => {
  const fm = { ...DNA_CARD, dimensions: [1, 11] };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /dimension/i.test(e)));
});

test('validateCard — rejects bad feasibilityTier', () => {
  const fm = { ...DNA_CARD, feasibilityTier: 'blue' };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /feasibilityTier/i.test(e)));
});

test('validateCard — rejects empty artifactFit', () => {
  const fm = { ...DNA_CARD, artifactFit: [] };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /artifactFit/i.test(e)));
});

test('validateCard — rejects invalid artifactFit value', () => {
  const fm = { ...DNA_CARD, artifactFit: ['landing', 'slide'] };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /artifactFit/i.test(e)));
});

test('validateCard — rejects missing ## Code section', () => {
  const body = '# X\n\n## Intent\nwhy\n\n## Where to reuse\n- landing\n\n## Source\n- e\n';
  const { ok, errors } = validateCard(DNA_CARD, body);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /code/i.test(e)));
});

test('validateCard — rejects empty code fenced block', () => {
  const body = '# X\n\n## Intent\nwhy\n\n## Code\n\n```js\n```\n\n## Where to reuse\n- landing\n\n## Source\n- e\n';
  const { ok, errors } = validateCard(DNA_CARD, body);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /code/i.test(e)));
});

test('validateCard — rejects status=stub', () => {
  const fm = { ...DNA_CARD, status: 'stub' };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN);
  assert.ok(!ok);
  assert.ok(errors.some((e) => /stub/i.test(e)));
});

test('validateCard — rejects red tier without ## Approximation', () => {
  const fm = { ...DNA_CARD, feasibilityTier: 'red' };
  const { ok, errors } = validateCard(fm, VALID_BODY_GREEN); // no Approximation section
  assert.ok(!ok);
  assert.ok(errors.some((e) => /approximation/i.test(e)));
});

test('validateCard — accepts red tier WITH ## Approximation', () => {
  const fm = { ...DNA_CARD, feasibilityTier: 'red' };
  const redBody = VALID_BODY_GREEN.replace('## Source', '## Approximation\nuse gsap\n\n## Source');
  const { ok } = validateCard(fm, redBody);
  assert.ok(ok);
});

// ---------------------------------------------------------------------------
// buildDnaJson tests
// ---------------------------------------------------------------------------

const CARD_A = {
  slug: 'a-motion',
  name: 'A Motion',
  category: 'motion',
  intent: 'draw eye',
  whenToUse: 'hero',
  artifactFit: ['site', 'landing'],
  feasibilityTier: 'green',
  dimensions: [1, 3],
  refExample: 'eiger',
  seenOnSites: ['x'],
  firstSeen: '2026-06-01T00:00:00.000Z',
};

const CARD_B = {
  slug: 'b-color',
  name: 'B Color',
  category: 'color',
  intent: 'brand contrast',
  whenToUse: 'all',
  artifactFit: ['dashboard'],
  feasibilityTier: 'yellow',
  dimensions: [5],
  refExample: 'drinksom',
  seenOnSites: ['y'],
  firstSeen: '2026-06-02T00:00:00.000Z',
};

test('buildDnaJson — sorted by slug, ends with newline, deterministic', () => {
  // Pass in reverse order; output must be sorted
  const json1 = buildDnaJson([CARD_B, CARD_A]);
  const json2 = buildDnaJson([CARD_A, CARD_B]);
  // byte-identical
  assert.equal(json1, json2);
  // ends with newline
  assert.ok(json1.endsWith('\n'));
  // parses as valid JSON
  const parsed = JSON.parse(json1);
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.generated, '');
  assert.equal(parsed.cards.length, 2);
  // sorted by slug
  assert.equal(parsed.cards[0].slug, 'a-motion');
  assert.equal(parsed.cards[1].slug, 'b-color');
  // includes path
  assert.equal(parsed.cards[0].path, 'cards/a-motion.md');
});

test('buildDnaJson — arrays are sorted+deduped in output', () => {
  const card = { ...CARD_A, artifactFit: ['site', 'landing', 'site'], seenOnSites: ['z', 'a', 'a'] };
  const parsed = JSON.parse(buildDnaJson([card]));
  assert.deepEqual(parsed.cards[0].artifactFit, ['landing', 'site']);
  assert.deepEqual(parsed.cards[0].seenOnSites, ['a', 'z']);
});

// ---------------------------------------------------------------------------
// flagSuspectCode tests
// ---------------------------------------------------------------------------

test('flagSuspectCode — flags a pathological >220-line code block', () => {
  const lines = Array.from({ length: 230 }, (_, i) => `const x${i} = ${i};`).join('\n');
  const body = `## Code\n\n\`\`\`js\n${lines}\n\`\`\`\n`;
  const result = flagSuspectCode(body);
  assert.ok(result !== null, 'expected a reason string, got null');
});

test('flagSuspectCode — does NOT flag a legit ~80-line clean-room demo (regression)', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `  el.style.transform = 'translateY(' + ${i} + 'px)';`).join('\n');
  const body = `## Code\n\n\`\`\`js\n${lines}\n\`\`\`\n\n## Where to reuse\n\n- landing\n`;
  assert.equal(flagSuspectCode(body), null, 'a detailed clean-room demo must not be flagged as verbatim');
});

test('flagSuspectCode — flags a line >200 chars with no spaces (minified)', () => {
  const minified = 'a'.repeat(201); // no spaces
  const body = `## Code\n\n\`\`\`js\n${minified}\n\`\`\`\n`;
  const result = flagSuspectCode(body);
  assert.ok(result !== null, 'expected a reason string for minified line');
});

test('flagSuspectCode — flags studio identifier (__webpack)', () => {
  const body = `## Code\n\n\`\`\`js\nconst m = __webpack_require__(1);\n\`\`\`\n`;
  const result = flagSuspectCode(body);
  assert.ok(result !== null, 'expected a reason string for __webpack');
});

test('flagSuspectCode — flags studio identifier (lusion)', () => {
  const body = `## Code\n\n\`\`\`js\nimport lusion from 'lusion-core';\n\`\`\`\n`;
  const result = flagSuspectCode(body);
  assert.ok(result !== null, 'expected a reason string for lusion');
});

test('flagSuspectCode — returns null for clean small block', () => {
  const body = `## Code\n\n\`\`\`js\nconst x = 1;\nreturn x;\n\`\`\`\n`;
  const result = flagSuspectCode(body);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// dna buildIndex — grouped by dimension
// ---------------------------------------------------------------------------

test('dna buildIndex — groups by dimension in id order, card in dims [1,3] appears under both', () => {
  const cards = [
    { ...CARD_A, slug: 'a-motion', name: 'A Motion', dimensions: [1, 3], feasibilityTier: 'green' },
    { slug: 'b-color', name: 'B Color', category: 'color', intent: 'x', dimensions: [3], feasibilityTier: 'yellow', artifactFit: ['site'], seenOnSites: ['y'], firstSeen: '2026-06-01T00:00:00.000Z' },
  ];
  const out = buildIndex(cards, { schema: 'dna' });
  // Should have headings for dim 1 (motion) and dim 3 (kinetic-type)
  assert.ok(out.includes('motion'), 'missing motion heading');
  assert.ok(out.includes('kinetic-type'), 'missing kinetic-type heading');
  // a-motion appears under both dim 1 and dim 3
  const dim1Idx = out.indexOf('motion');
  const dim3Idx = out.indexOf('kinetic-type');
  // count occurrences of a-motion link
  const matches = [...out.matchAll(/a-motion/g)];
  assert.ok(matches.length >= 2, `a-motion should appear under 2 dimensions, found ${matches.length}`);
  // b-color only under dim 3
  assert.ok(out.includes('b-color'));
  // headings in id order: dim 1 before dim 3
  assert.ok(dim1Idx < dim3Idx, 'motion heading should precede kinetic-type heading');
});

test('dna buildIndex — tier badge present', () => {
  const cards = [
    { ...CARD_A, feasibilityTier: 'green' },
    { slug: 'r-card', name: 'R Card', category: 'effect', intent: 'x', dimensions: [1], feasibilityTier: 'red', artifactFit: ['site'], seenOnSites: [], firstSeen: '' },
  ];
  const out = buildIndex(cards, { schema: 'dna' });
  assert.ok(out.includes('green') || out.includes('🟢'), 'green tier badge missing');
  assert.ok(out.includes('red') || out.includes('🔴'), 'red tier badge missing');
});

// ---------------------------------------------------------------------------
// readAllCards — schema threading (Task 1.3 bug fix)
// ---------------------------------------------------------------------------

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readAllCards } from '../lib/dna-card.mjs';

// Complete DNA card content written to disk for round-trip tests
const DNA_CARD_FRONTMATTER =
  '---\n' +
  'slug: eiger-contrast\n' +
  'name: Eiger Contrast\n' +
  'category: motion\n' +
  'intent: draw the eye to the hero immediately\n' +
  'whenToUse: hero sections with kinetic type\n' +
  'artifactFit: [landing]\n' +
  'feasibilityTier: green\n' +
  'dimensions: [1, 3]\n' +
  'refExample: eiger\n' +
  'seenOnSites: [eiger]\n' +
  'firstSeen: 2026-06-01T00:00:00.000Z\n' +
  'status: ready\n' +
  '---\n';

const DNA_CARD_BODY =
  '# Eiger Contrast\n\n' +
  '## Intent\ndraw the eye to the hero immediately\n\n' +
  '## Mechanism\ncontrast between light and dark panels drives focus\n\n' +
  '## Code\n\n```js\nexport function applyTechnique(target, opts = {}) {\n  return target;\n}\n```\n\n' +
  '## Where to reuse\n- landing heroes\n\n' +
  '## Source\n- eiger\n';

const DNA_CARD_FULL = DNA_CARD_FRONTMATTER + DNA_CARD_BODY;

// Helper: create a fresh temp dir, write the card, return { dir, cleanup }
async function makeTmpCard() {
  const dir = await mkdtemp(tmpdir() + '/dna-card-test-');
  await writeFile(dir + '/eiger-contrast.md', DNA_CARD_FULL, 'utf8');
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('readAllCards schema=dna returns all dna fields (not just 5 legacy)', async (t) => {
  const { dir, cleanup } = await makeTmpCard();
  t.after(cleanup);

  const cards = await readAllCards(dir, { schema: 'dna' });
  assert.equal(cards.length, 1);
  const card = cards[0];

  // DNA fields must be present and correct
  assert.ok(card.intent && card.intent.length > 0, 'intent must be non-empty');
  assert.deepEqual(card.dimensions, [1, 3], 'dimensions must be numbers [1,3]');
  assert.deepEqual(card.artifactFit, ['landing'], 'artifactFit must be ["landing"]');
  assert.equal(card.feasibilityTier, 'green', 'feasibilityTier must be "green"');
  assert.equal(card.status, 'ready', 'status must be "ready"');

  // Validation round-trip: a completed card read back from disk must pass validateCard
  const { ok } = validateCard(card, DNA_CARD_BODY);
  assert.ok(ok, 'validateCard must return ok=true for a completed card read from disk');
});

test('readAllCards default (no opts) returns only 5 legacy fields — dna fields must NOT leak', async (t) => {
  const { dir, cleanup } = await makeTmpCard();
  t.after(cleanup);

  const cards = await readAllCards(dir);
  assert.equal(cards.length, 1);
  const card = cards[0];

  // Exactly the 5 legacy fields
  const keys = Object.keys(card);
  assert.deepEqual(keys.sort(), ['category', 'firstSeen', 'name', 'seenOnSites', 'slug'].sort(),
    `legacy mode must return exactly 5 fields; got: ${keys.sort().join(', ')}`);

  // DNA fields must NOT be present
  assert.equal(card.intent, undefined, 'intent must not leak into legacy mode');
  assert.equal(card.dimensions, undefined, 'dimensions must not leak into legacy mode');
  assert.equal(card.artifactFit, undefined, 'artifactFit must not leak into legacy mode');
  assert.equal(card.feasibilityTier, undefined, 'feasibilityTier must not leak into legacy mode');
  assert.equal(card.status, undefined, 'status must not leak into legacy mode');
});

test('readAllCards schema=legacy explicit also returns only 5 legacy fields', async (t) => {
  const { dir, cleanup } = await makeTmpCard();
  t.after(cleanup);

  const cards = await readAllCards(dir, { schema: 'legacy' });
  const keys = Object.keys(cards[0]);
  assert.deepEqual(keys.sort(), ['category', 'firstSeen', 'name', 'seenOnSites', 'slug'].sort(),
    `explicit legacy schema must return exactly 5 fields; got: ${keys.sort().join(', ')}`);
});
