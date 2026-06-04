import { test } from 'node:test'; import assert from 'node:assert/strict';
import { findStalePrices } from '../check-copy-truth.mjs';
test('flags prices not in the canon set', () => {
  const canon = ['4 997','5 997','6 997','2 997','997','697'];
  const hits = findStalePrices('Lock-in at €2 947 and weekend €497', canon);
  assert.deepEqual(hits.sort(), ['2 947','497']);
});
