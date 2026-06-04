// anim-census.test.mjs — proves the animation census detects CSS animation,
// video elements, and WAAPI animations on a real page in a real browser.
// Deterministic: no Date.now()/Math.random(); fixed fixture; fixed tmp folder.
//
// node --test anim-census.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCensus } from '../lib/anim-census.mjs';

// Deterministic fixture location.
const FIX_DIR = join(tmpdir(), 'cl-census-test');
const FIX_PATH = join(FIX_DIR, 'fixture.html');

// Fixture: a CSS @keyframes animation (.a), a <video> element (counted even
// with no src — we count elements), and a WAAPI animate() so getAnimations()>0.
const FIXTURE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>census fixture</title>
<style>
  @keyframes spin { to { transform: rotate(360deg); } }
  .a { animation: spin 2s linear infinite; }
</style>
</head>
<body>
  <div class="a">x</div>
  <video autoplay muted loop playsinline></video>
  <script>
    document.querySelector('.a').animate(
      [{ opacity: 1 }, { opacity: 0.3 }],
      { duration: 1000, iterations: Infinity }
    );
  </script>
</body>
</html>`;

test('census detects CSS anim, video element, and WAAPI', { timeout: 90000 }, async () => {
  mkdirSync(FIX_DIR, { recursive: true });
  writeFileSync(FIX_PATH, FIXTURE, 'utf8');

  const url = pathToFileURL(FIX_PATH).href;
  const census = await runCensus(url);

  // shape sanity
  assert.ok(census && typeof census === 'object', 'census is an object');
  assert.ok(Array.isArray(census.libraries), 'libraries is an array');
  assert.ok(Array.isArray(census.lockedSelectors), 'lockedSelectors is an array');

  // core assertions
  assert.ok(census.cssAnim >= 1, `cssAnim >= 1 (got ${census.cssAnim})`);
  assert.ok(census.videos >= 1, `videos >= 1 (got ${census.videos})`);
  assert.ok(census.waapi >= 1, `waapi >= 1 (got ${census.waapi})`);
});
