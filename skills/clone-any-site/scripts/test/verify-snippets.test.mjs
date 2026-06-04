// verify-snippets.test.mjs — TDD harness for verify-snippets.mjs (Task 5.1)
// Run: node --test test/verify-snippets.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const WORK = join(HERE, '.work', 'verify-snippets');
const FIXTURES = join(HERE, 'fixtures', 'snippet-cards');

// Try to load playwright — if absent, browser tests are skipped.
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip browser assertions */ }

// Import the module under test (use pathToFileURL for Windows compatibility)
const { extractCodeBlock, shouldSkip, verifyCards } = await import(
  pathToFileURL(join(SCRIPTS, 'verify-snippets.mjs')).href
);

// ---------------------------------------------------------------------------
// Fixture card bodies (read once)
// ---------------------------------------------------------------------------
const greenPassBody = await readFile(join(FIXTURES, 'green-pass.md'), 'utf8');
const redSkipBody  = await readFile(join(FIXTURES, 'red-skip.md'), 'utf8');
const brokenBody   = await readFile(join(FIXTURES, 'broken.md'), 'utf8');

// Parse bodies (strip frontmatter)
function stripFm(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

const greenPassMd = stripFm(greenPassBody);
const redSkipMd   = stripFm(redSkipBody);
const brokenMd    = stripFm(brokenBody);

// Card with no ## Code section at all
const NO_CODE_MD = `## Intent\nSome intent.\n\n## Notes\nNo code here.\n`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
before(async () => {
  await mkdir(WORK, { recursive: true });
});

after(async () => {
  await rm(WORK, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helper tests (always run — no browser)
// ---------------------------------------------------------------------------

test('extractCodeBlock returns snippet for green-pass card', () => {
  const snippet = extractCodeBlock(greenPassMd);
  assert.ok(snippet !== null, 'should not be null');
  assert.match(snippet, /window\.__SNIPPET_OK\s*=\s*true/, 'should contain __SNIPPET_OK assignment');
  assert.doesNotMatch(snippet, /```/, 'should not include fence markers');
});

test('extractCodeBlock returns null when no ## Code section', () => {
  assert.strictEqual(extractCodeBlock(NO_CODE_MD), null);
});

test('extractCodeBlock returns null for red-skip card (has ## Approximation but no ## Code)', () => {
  // red-skip has no ## Code section — only ## Approximation
  assert.strictEqual(extractCodeBlock(redSkipMd), null);
});

test('extractCodeBlock returns null for body with ## Code but no fenced block', () => {
  const body = `## Code\n\nSome prose but no fences.\n`;
  assert.strictEqual(extractCodeBlock(body), null);
});

test('extractCodeBlock strips language tag from fence', () => {
  const body = `## Code\n\n\`\`\`js\nconsole.log('hi');\n\`\`\`\n`;
  const snippet = extractCodeBlock(body);
  assert.ok(snippet !== null);
  assert.doesNotMatch(snippet, /^js\b/, 'language tag must be stripped');
  assert.match(snippet, /console\.log/);
});

test('extractCodeBlock captures a snippet containing a capital Z (regression: \\Z bug)', () => {
  // A previous regex used `\Z` (literal "Z" in JS), truncating at the first capital Z.
  const body = `## Code\n\n\`\`\`js\nel.style.transform = 'translateZ(0)';\nwindow.__SNIPPET_OK = true;\n\`\`\`\n\n## Where to reuse\n\n- landing\n`;
  const snippet = extractCodeBlock(body);
  assert.ok(snippet !== null, 'must find the code block despite the capital Z');
  assert.match(snippet, /translateZ\(0\)/);
  assert.match(snippet, /__SNIPPET_OK = true/, 'must capture through to the closing fence');
});

test('shouldSkip returns true for harness:skip', () => {
  assert.strictEqual(shouldSkip({ harness: 'skip' }), true);
});

test('shouldSkip returns false for absent harness field', () => {
  assert.strictEqual(shouldSkip({}), false);
});

test('shouldSkip returns false for other harness values', () => {
  assert.strictEqual(shouldSkip({ harness: 'browser' }), false);
  assert.strictEqual(shouldSkip({ harness: '' }), false);
});

// ---------------------------------------------------------------------------
// Browser integration test
// ---------------------------------------------------------------------------

test('verifyCards: green=pass, red-skip=skipped, broken=failed, bad-skip=failed',
  { skip: !chromium ? 'playwright not installed — skipping browser checks' : false },
  async () => {
    const report = await verifyCards(FIXTURES, { chromium, timeout: 6000 });

    // Structure
    assert.ok(typeof report.checked  === 'number', 'checked is a number');
    assert.ok(typeof report.passed   === 'number', 'passed is a number');
    assert.ok(typeof report.skipped  === 'number', 'skipped is a number');
    assert.ok(Array.isArray(report.failed), 'failed is an array');

    // green-pass → passed
    assert.ok(report.passed >= 1, `expected at least 1 passed, got ${report.passed}`);

    // red-skip → skipped (has ## Approximation)
    assert.ok(report.skipped >= 1, `expected at least 1 skipped, got ${report.skipped}`);

    // broken → failed
    const brokenEntry = report.failed.find(f => f.slug === 'broken');
    assert.ok(brokenEntry, `"broken" card should be in failed; failed=${JSON.stringify(report.failed)}`);
    assert.ok(brokenEntry.reason, 'broken entry must have a reason');

    // bad-skip → failed (harness:skip without ## Approximation)
    const badSkipEntry = report.failed.find(f => f.slug === 'bad-skip');
    assert.ok(badSkipEntry, `"bad-skip" card should be in failed; failed=${JSON.stringify(report.failed)}`);
    assert.match(badSkipEntry.reason, /Approximation/i, 'reason must mention Approximation');

    // checked = passed + skipped + failed
    assert.strictEqual(
      report.checked,
      report.passed + report.skipped + report.failed.length,
      'checked must equal passed + skipped + failed'
    );

    // Report file written and readable
    const reportPath = join(FIXTURES, '..', '..', 'verify-snippets.report.json');
    // verifyCards writes report to process.cwd() or a known location — check it exists
    // (exact path determined by implementation; test reads it back from the return value)
    assert.ok(report._reportPath, 'verifyCards must return _reportPath');
    const raw = await readFile(report._reportPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.checked,  report.checked,  'report file checked matches');
    assert.strictEqual(parsed.passed,   report.passed,   'report file passed matches');
    assert.strictEqual(parsed.skipped,  report.skipped,  'report file skipped matches');
    assert.strictEqual(parsed.failed.length, report.failed.length, 'report file failed count matches');
  }
);
