// clone-verify.test.mjs — unit tests for the PURE evaluateCensus function.
// Fast + reliable; the full browser integration is exercised separately
// against the real eiger clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCensus } from '../clone-verify.mjs';

const axisOf = (res, name) => res.axes.find((x) => x.axis === name);

test('identical census → ok true', () => {
  const c = { cssAnim: 10, waapi: 5, videos: 5, canvas: 0 };
  const res = evaluateCensus(c, { ...c });
  assert.equal(res.ok, true);
});

test('5% loss tolerated → cssAnim axis ok', () => {
  const before = { cssAnim: 100, waapi: 5, videos: 5, canvas: 0 };
  const after = { cssAnim: 95, waapi: 5, videos: 5, canvas: 0 };
  const res = evaluateCensus(before, after);
  assert.equal(axisOf(res, 'cssAnim').ok, true);
  assert.equal(res.ok, true);
});

test('50% loss fails → cssAnim axis ok false, overall false', () => {
  const before = { cssAnim: 10, waapi: 5, videos: 5, canvas: 0 };
  const after = { cssAnim: 5, waapi: 5, videos: 5, canvas: 0 };
  const res = evaluateCensus(before, after);
  assert.equal(axisOf(res, 'cssAnim').ok, false);
  assert.equal(res.ok, false);
});

test('video killed (5→0) → ok false', () => {
  const before = { cssAnim: 10, waapi: 5, videos: 5, canvas: 0 };
  const after = { cssAnim: 10, waapi: 5, videos: 0, canvas: 0 };
  const res = evaluateCensus(before, after);
  assert.equal(axisOf(res, 'videos').ok, false);
  assert.equal(res.ok, false);
});

test('canvas 0→0 → that axis ok true (before 0)', () => {
  const before = { cssAnim: 10, waapi: 5, videos: 5, canvas: 0 };
  const after = { cssAnim: 10, waapi: 5, videos: 5, canvas: 0 };
  const res = evaluateCensus(before, after);
  assert.equal(axisOf(res, 'canvas').ok, true);
});

test('before>0 after 0 (waapi 5→0) → ok false', () => {
  const before = { cssAnim: 10, waapi: 5, videos: 5, canvas: 0 };
  const after = { cssAnim: 10, waapi: 0, videos: 5, canvas: 0 };
  const res = evaluateCensus(before, after);
  assert.equal(axisOf(res, 'waapi').ok, false);
  assert.equal(res.ok, false);
});
