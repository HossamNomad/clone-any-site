import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIMENSIONS, APPLICABILITY, byKey, byId } from '../lib/dimensions.mjs';

test('weights sum to 100', () => {
  assert.equal(DIMENSIONS.reduce((a, d) => a + d.weight, 0), 100);
});

test('byKey / byId resolve correctly', () => {
  assert.equal(byKey('motion').id, 1);
  assert.equal(byId(9).key, 'sound');
  assert.equal(byKey('nope'), undefined);
  assert.equal(byId(99), undefined);
});

test('APPLICABILITY: deck drops immersion/micro-interactions/perf/sound, keeps the rest', () => {
  const deck = APPLICABILITY.deck;
  for (const id of [2, 6, 7, 9]) assert.ok(!deck.includes(id), 'deck excludes ' + id);
  for (const id of [1, 3, 4, 5, 8, 10]) assert.ok(deck.includes(id), 'deck includes ' + id);
  assert.equal(APPLICABILITY.landing.length, 10);
  assert.deepEqual(APPLICABILITY.pdf, [3, 5, 8, 10]);
});
