// slot-infer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSequences, assignIds } from '../lib/slot-infer.mjs';
import { inferRole, inferConstraints } from '../lib/slot-infer.mjs';

test('groupSequences collapses name-0..name-K into one SEQ', () => {
  const imgs = [
    { url: '/gore-tex/desktop/gore-tex-0.jpg' }, { url: '/gore-tex/desktop/gore-tex-1.jpg' },
    { url: '/gore-tex/desktop/gore-tex-2.jpg' }, { url: '/hero/solo.jpg' },
  ];
  const seqs = groupSequences(imgs);
  assert.equal(seqs.sequences.length, 1);
  assert.equal(seqs.sequences[0].frameCount, 3);
  assert.equal(seqs.singles.length, 1);
});

test('assignIds is deterministic by type + document order', () => {
  const items = [{ type: 'image' }, { type: 'video' }, { type: 'image' }, { type: 'text' }];
  const ids = assignIds(items).map((x) => x.id);
  assert.deepEqual(ids, ['IMG-1', 'VID-1', 'IMG-2', 'TXT-1']);
});

test('inferRole maps arc position + type to a rhetorical role', () => {
  assert.equal(inferRole({ type: 'title', arcRatio: 0.02, fontPx: 400 }), 'hook');
  assert.equal(inferRole({ type: 'video', arcRatio: 0.5 }), 'immersion');
  assert.equal(inferRole({ type: 'text', arcRatio: 0.95, isCta: true }), 'cta');
});

test('inferConstraints captures aspect + length budget', () => {
  const c = inferConstraints({ type: 'image', rect: { width: 800, height: 1200 } });
  assert.equal(c.aspectRatio, '2:3');
  const t = inferConstraints({ type: 'text', text: 'BAIKAL' });
  assert.equal(t.charLen, 6);
});
