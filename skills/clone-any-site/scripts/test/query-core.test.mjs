import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCards } from '../lib/query-core.mjs';

const CARDS = [
  { slug: 'b-yellow', artifactFit: ['landing'], feasibilityTier: 'yellow', dimensions: [6], seenOnSites: ['x'] },
  { slug: 'a-green',  artifactFit: ['landing'], feasibilityTier: 'green',  dimensions: [6], seenOnSites: ['x', 'y'] },
  { slug: 'c-green',  artifactFit: ['landing'], feasibilityTier: 'green',  dimensions: [6], seenOnSites: ['x'] },
  { slug: 'd-deck',   artifactFit: ['deck'],    feasibilityTier: 'green',  dimensions: [6], seenOnSites: ['x'] },
  { slug: 'e-red',    artifactFit: ['landing'], feasibilityTier: 'red',    dimensions: [2], seenOnSites: ['x'] },
];

test('filters by artifact + dimension + tier', () => {
  const r = rankCards(CARDS, { artifact: 'landing', dimension: 6, tier: 'green' });
  assert.deepEqual(r.map((c) => c.slug), ['a-green', 'c-green']); // both green, a has 2 seenOnSites so first
});

test('dimension accepts a key string (micro-interactions === id 6)', () => {
  const r = rankCards(CARDS, { artifact: 'landing', dimension: 'micro-interactions' });
  assert.ok(r.every((c) => c.dimensions.includes(6)));
  assert.equal(r[0].slug, 'a-green'); // green + most seenOnSites
});

test('ranks tier green<yellow<red, then seenOnSites desc, then slug asc', () => {
  const r = rankCards(CARDS, { artifact: 'landing' });
  assert.deepEqual(r.map((c) => c.slug), ['a-green', 'c-green', 'b-yellow', 'e-red']);
});

test('limit slices after ranking; input not mutated', () => {
  const copy = CARDS.slice();
  const r = rankCards(CARDS, { artifact: 'landing', limit: 2 });
  assert.equal(r.length, 2);
  assert.deepEqual(CARDS, copy); // not mutated (same order/refs)
});

test('empty result is valid', () => {
  assert.deepEqual(rankCards(CARDS, { artifact: 'pdf' }), []);
});
