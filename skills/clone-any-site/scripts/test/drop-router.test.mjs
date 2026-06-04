// test/drop-router.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeDrop, validateAgainstMap, colorFor } from '../lib/drop-router.mjs';

test('VID-04.mp4 -> video slot VID-4', () => {
  const r = routeDrop('VID-04.mp4');
  assert.equal(r.ok, true);
  assert.equal(r.id, 'VID-4');
  assert.equal(r.prefix, 'VID');
  assert.equal(r.type, 'video');
  assert.equal(r.num, 4);
  assert.equal(r.ext, 'mp4');
});

test('IMG-12.jpg -> image slot IMG-12', () => {
  const r = routeDrop('IMG-12.jpg');
  assert.equal(r.ok, true);
  assert.equal(r.id, 'IMG-12');
  assert.equal(r.type, 'image');
  assert.equal(r.num, 12);
});

test('SEQ-01.zip -> sequence slot SEQ-1', () => {
  const r = routeDrop('SEQ-01.zip');
  assert.equal(r.ok, true);
  assert.equal(r.id, 'SEQ-1');
  assert.equal(r.type, 'sequence');
  assert.equal(r.num, 1);
});

test('IMG-1.mp4 -> ext/prefix conflict', () => {
  const r = routeDrop('IMG-1.mp4');
  assert.equal(r.ok, false);
  assert.match(r.error, /conflict/i);
  assert.match(r.error, /video/i);
  assert.match(r.error, /image/i);
});

test('VID-1.png -> ext/prefix conflict', () => {
  const r = routeDrop('VID-1.png');
  assert.equal(r.ok, false);
  assert.match(r.error, /conflict/i);
});

test('FOO-1.jpg -> unknown prefix, error mentions IMG/VID/SEQ', () => {
  const r = routeDrop('FOO-1.jpg');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown prefix/i);
  assert.match(r.error, /IMG/);
  assert.match(r.error, /VID/);
  assert.match(r.error, /SEQ/);
});

test('TITLE-1.txt -> text not dropped (swaps.json)', () => {
  const r = routeDrop('TITLE-1.txt');
  assert.equal(r.ok, false);
  assert.match(r.error, /swaps\.json/i);
  assert.match(r.error, /text/i);
});

test('TXT-1.txt -> text not dropped (swaps.json)', () => {
  const r = routeDrop('TXT-1.txt');
  assert.equal(r.ok, false);
  assert.match(r.error, /swaps\.json/i);
});

test('garbage.png -> pattern error', () => {
  const r = routeDrop('garbage.png');
  assert.equal(r.ok, false);
  assert.match(r.error, /pattern/i);
});

test('leading-zero normalization VID-007 -> VID-7', () => {
  const r = routeDrop('VID-007.mp4');
  assert.equal(r.ok, true);
  assert.equal(r.id, 'VID-7');
  assert.equal(r.num, 7);
});

const mapSlots = [
  { id: 'VID-1', type: 'video' },
  { id: 'IMG-1', type: 'image' },
];

test('validateAgainstMap: VID-1 ok', () => {
  const route = routeDrop('VID-1.mp4');
  const v = validateAgainstMap(route, mapSlots);
  assert.equal(v.ok, true);
  assert.deepEqual(v.slot, { id: 'VID-1', type: 'video' });
});

test('validateAgainstMap: VID-9 missing -> error lists VID-1', () => {
  const route = routeDrop('VID-9.mp4');
  const v = validateAgainstMap(route, mapSlots);
  assert.equal(v.ok, false);
  assert.match(v.error, /no slot VID-9/);
  assert.match(v.error, /VID-1/);
  assert.match(v.error, /video/);
});

test('validateAgainstMap: type mismatch (id exists, wrong type)', () => {
  // Drop an image named to collide with an id that is video-typed in the map.
  const route = routeDrop('IMG-1.png'); // route.id IMG-1, type image
  const mismatchMap = [{ id: 'IMG-1', type: 'video' }];
  const v = validateAgainstMap(route, mismatchMap);
  assert.equal(v.ok, false);
  assert.match(v.error, /IMG-1/);
  assert.match(v.error, /video/);
  assert.match(v.error, /image/);
});

test('colorFor returns hex from COLORS', () => {
  assert.equal(colorFor('video'), '#ff3b30');
  assert.equal(colorFor('image'), '#2b6cff');
  assert.equal(colorFor('sequence'), '#9b51e0');
});
