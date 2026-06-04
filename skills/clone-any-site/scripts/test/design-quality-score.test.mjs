import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { score } from '../design-quality-score.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── fixture cards (inline, zero-dep) ────────────────────────────────────────
const FINISH_CARD = {
  slug: 'glass-surface',
  name: 'Glass Surface',
  intent: 'Polished glass finish on surfaces',
  artifactFit: ['landing', 'site'],
  feasibilityTier: 'green',
  dimensions: [10, 5], // finish + color
  seenOnSites: ['site-a', 'site-b'],
  path: 'cards/glass-surface.md',
};
const MOTION_CARD = {
  slug: 'scroll-fade',
  name: 'Scroll Fade',
  intent: 'Elements fade in on scroll',
  artifactFit: ['landing', 'site', 'deck'],
  feasibilityTier: 'green',
  dimensions: [1, 8], // motion + composition
  seenOnSites: ['site-c'],
  path: 'cards/scroll-fade.md',
};
const FIXTURE_CARDS = [FINISH_CARD, MOTION_CARD];

// ── deck worked example ──────────────────────────────────────────────────────
// deck applicable ids: [1,3,4,5,8,10]  weights: 12+12+10+10+12+12 = 68
// inputs:  motion=7, kinetic-type=9, narrative=6, color=8, composition=7, finish=5
// contribs: 7/10*12 + 9/10*12 + 6/10*10 + 8/10*10 + 7/10*12 + 5/10*12
//         = 8.4 + 10.8 + 6 + 8 + 8.4 + 6 = 47.6
// score   = round(100 * 47.6 / 68) = round(70.0) = 70
test('deck worked example — applicableWeights=68, score=70, perDimension length=6', () => {
  const result = score(
    {
      artifactType: 'deck',
      dimensions: {
        motion: 7,
        'kinetic-type': 9,
        narrative: 6,
        color: 8,
        composition: 7,
        finish: 5,
      },
    },
    [],
  );
  assert.equal(result.applicableWeights, 68);
  assert.equal(result.score, 70);
  assert.equal(result.perDimension.length, 6);
  // excluded dims must not appear in perDimension
  const keys = result.perDimension.map((d) => d.key);
  for (const banned of ['immersion', 'micro-interactions', 'perf', 'sound']) {
    assert.ok(!keys.includes(banned), `perDimension must not include ${banned}`);
  }
  assert.equal(result.artifactType, 'deck');
});

// ── landing all-7s ───────────────────────────────────────────────────────────
// landing applicable = all 10, weights sum = 100
// all dims = 7 → score = round(100 * (7/10 * 100) / 100) = 70
test('landing all-7s — applicableWeights=100, score=70', () => {
  const dims = {};
  for (const k of ['motion','immersion','kinetic-type','narrative','color','micro-interactions','perf','composition','sound','finish']) {
    dims[k] = 7;
  }
  const result = score({ artifactType: 'landing', dimensions: dims }, []);
  assert.equal(result.applicableWeights, 100);
  assert.equal(result.score, 70);
  assert.equal(result.perDimension.length, 10);
});

// ── all-10 → 100; all-0 → 0 ─────────────────────────────────────────────────
test('all-10 → score 100; all-0 → score 0', () => {
  const all10 = {};
  const all0 = {};
  for (const k of ['motion','immersion','kinetic-type','narrative','color','micro-interactions','perf','composition','sound','finish']) {
    all10[k] = 10;
    all0[k] = 0;
  }
  assert.equal(score({ artifactType: 'site', dimensions: all10 }, []).score, 100);
  assert.equal(score({ artifactType: 'site', dimensions: all0 }, []).score, 0);
});

// ── weakest picks lowest-scoring applicable dim ──────────────────────────────
// landing with finish=1, rest=9 → weakest[0].key === 'finish'
// recommendedPatterns: every entry has dimensions.includes(10) (finish id)
test('landing finish=1 rest=9 → weakest[0]=finish, patterns reference dim 10', () => {
  const dims = {};
  for (const k of ['motion','immersion','kinetic-type','narrative','color','micro-interactions','perf','composition','sound','finish']) {
    dims[k] = k === 'finish' ? 1 : 9;
  }
  const result = score({ artifactType: 'landing', dimensions: dims }, FIXTURE_CARDS);
  assert.equal(result.weakest[0].key, 'finish');
  assert.ok(result.weakest[0].score === 1);
  // at least one recommended pattern must reference finish (dim 10)
  assert.ok(
    result.recommendedPatterns.some((p) => p.dimensions.includes(10)),
    'at least one recommended pattern should include dim 10 (finish)',
  );
});

// ── non-applicable key on deck → warning, not in perDimension, score unchanged ──
test('non-applicable key on deck (immersion:9) → warning, absent from perDimension, score unchanged', () => {
  const baseDims = { motion: 7, 'kinetic-type': 9, narrative: 6, color: 8, composition: 7, finish: 5 };
  const withExtra = { ...baseDims, immersion: 9 };
  const base = score({ artifactType: 'deck', dimensions: baseDims }, []);
  const extra = score({ artifactType: 'deck', dimensions: withExtra }, []);
  // score must be same
  assert.equal(extra.score, base.score);
  // immersion must not appear in perDimension
  const keys = extra.perDimension.map((d) => d.key);
  assert.ok(!keys.includes('immersion'));
  // warnings must mention immersion
  assert.ok(extra.warnings.some((w) => w.includes('immersion')), 'warnings must mention immersion');
});

// ── cards=[] → recommendedPatterns=[], a warning ─────────────────────────────
test('cards=[] → recommendedPatterns=[], warning present', () => {
  const result = score({ artifactType: 'site', dimensions: { motion: 1 } }, []);
  assert.deepEqual(result.recommendedPatterns, []);
  assert.ok(result.warnings.some((w) => /card|pattern|dna/i.test(w)));
});

// ── missing applicable key → s=0, warning ────────────────────────────────────
test('missing applicable key → treated as s=0, warning added', () => {
  // pdf applicable: [3,5,8,10] — only provide color(5)
  const result = score({ artifactType: 'pdf', dimensions: { color: 8 } }, []);
  // missing: kinetic-type(3), composition(8), finish(10) → s=0 for each
  assert.ok(result.warnings.length > 0);
  // score must be less than perfect (missing dims drag it down)
  assert.ok(result.score < 100);
  // perDimension must have 4 entries (all 4 pdf dims)
  assert.equal(result.perDimension.length, 4);
  const colorEntry = result.perDimension.find((d) => d.key === 'color');
  assert.ok(colorEntry);
  assert.equal(colorEntry.score, 8);
});

// ── byte-identical (deterministic) ──────────────────────────────────────────
test('score is deterministic — identical JSON across two calls', () => {
  const input = { artifactType: 'dashboard', dimensions: { motion: 5, 'kinetic-type': 7, color: 3, 'micro-interactions': 9, perf: 6, composition: 4, finish: 8 } };
  const r1 = JSON.stringify(score(input, FIXTURE_CARDS));
  const r2 = JSON.stringify(score(input, FIXTURE_CARDS));
  assert.equal(r1, r2);
});

// ── invalid artifactType → throws ────────────────────────────────────────────
test('invalid artifactType throws', () => {
  assert.throws(
    () => score({ artifactType: 'poster', dimensions: {} }, []),
    /invalid.*artifact|unknown.*artifact|artifactType/i,
  );
});

// ── CLI subprocess: unknown artifactType → exit 1 ────────────────────────────
test('CLI: unknown artifactType exits 1', () => {
  const scriptPath = path.resolve(__dirname, '..', 'design-quality-score.mjs');
  const r = spawnSync(process.execPath, [scriptPath, '--artifact', 'poster'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
});

// ── perDimension values are correct for deck worked example ──────────────────
test('deck perDimension contributions correct (toFixed(4))', () => {
  const result = score(
    {
      artifactType: 'deck',
      dimensions: { motion: 7, 'kinetic-type': 9, narrative: 6, color: 8, composition: 7, finish: 5 },
    },
    [],
  );
  const byKey = Object.fromEntries(result.perDimension.map((d) => [d.key, d]));
  // motion: 7/10 * 12 = 8.4
  assert.equal(byKey['motion'].contribution, 8.4);
  // kinetic-type: 9/10 * 12 = 10.8
  assert.equal(byKey['kinetic-type'].contribution, 10.8);
  // narrative: 6/10 * 10 = 6
  assert.equal(byKey['narrative'].contribution, 6);
  // color: 8/10 * 10 = 8
  assert.equal(byKey['color'].contribution, 8);
  // composition: 7/10 * 12 = 8.4
  assert.equal(byKey['composition'].contribution, 8.4);
  // finish: 5/10 * 12 = 6
  assert.equal(byKey['finish'].contribution, 6);
});

// ── weakest has max 3 entries, sorted by score asc ───────────────────────────
test('weakest has max 3 entries', () => {
  const dims = { motion: 1, 'kinetic-type': 2, narrative: 3, color: 4, composition: 5, finish: 6 };
  const result = score({ artifactType: 'deck', dimensions: dims }, []);
  assert.ok(result.weakest.length <= 3);
  // sorted asc by score
  for (let i = 0; i < result.weakest.length - 1; i++) {
    assert.ok(result.weakest[i].score <= result.weakest[i + 1].score);
  }
});
