#!/usr/bin/env node
// run-tests-report.mjs — run each clone-any-site test suite IN ISOLATION (explicit files,
// never whole-dir, so scratch under test/.work/ is not double-counted), capture per-suite
// pass/fail + exit code, write a clean summary file we can read back even if stdout is dropped.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'test/clone-list.test.mjs',
  'test/coverage-engine.test.mjs',
  'test/serve-edit.test.mjs',
  'test/editor-e2e.test.mjs',
  'test/build-e2e.test.mjs',
  'test/publish-loop.test.mjs',
  'test/library.test.mjs',
  'test/ai-rewrite.test.mjs',
  'test/section.test.mjs',
  'test/section-order.test.mjs',
  'test/freeze-spa.test.mjs',
  'test/relocalize-prescroll.test.mjs',
  'test/extract-manifest.test.mjs',
  'test/apply-swaps.test.mjs',
  'test/validate-manifest.test.mjs',
  'test/fit-slot.test.mjs',
  'test/distill-techniques.test.mjs',
  'test/dna-card.test.mjs',
  'test/publish-gate.test.mjs',
  'test/slot-infer.test.mjs',
  'test/map-site.test.mjs',
  'test/compose-rewrite.test.mjs',
  'test/transcode.test.mjs',
  'test/serve-repurpose.test.mjs',
  'test/map-intent.test.mjs',
  'test/check-copy-truth.test.mjs',
  'test/repurpose-chat.test.mjs',
  'test/dimensions.test.mjs',
  'test/query-core.test.mjs',
  'test/distill-market.test.mjs',
  'test/query-dna.test.mjs',
  'test/design-quality-score.test.mjs',
  'test/verify-snippets.test.mjs',
];

const results = [];
for (const s of SUITES) {
  const r = spawnSync(process.execPath, ['--test', s], { cwd: __dirname, encoding: 'utf8', timeout: 360000 });
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  // node:test default reporter prints "ℹ pass N"; the TAP reporter prints "# pass N" — accept either.
  const pass = (out.match(/(?:^#|ℹ) pass (\d+)/m) || [])[1];
  const fail = (out.match(/(?:^#|ℹ) fail (\d+)/m) || [])[1];
  const tests = (out.match(/(?:^#|ℹ) tests (\d+)/m) || [])[1];
  results.push({
    suite: s.replace('test/', ''),
    exit: r.status,
    tests: tests ? +tests : null,
    pass: pass ? +pass : null,
    fail: fail ? +fail : null,
    skipped: r.error ? String(r.error.message || r.error) : null,
  });
}

const totalPass = results.reduce((a, b) => a + (b.pass || 0), 0);
const totalFail = results.reduce((a, b) => a + (b.fail || 0), 0);
const allGreen = results.every((r) => r.exit === 0);

const summary = {
  when: 'fresh-run',
  allGreen,
  totalPass,
  totalFail,
  suites: results,
};

const outPath = path.join(__dirname, '.test-report.json');
writeFileSync(outPath, JSON.stringify(summary, null, 2));

console.log('=== clone-any-site test report ===');
for (const r of results) {
  console.log(`${r.exit === 0 ? 'PASS' : 'FAIL'}  ${r.suite.padEnd(28)} exit=${r.exit} pass=${r.pass} fail=${r.fail}${r.skipped ? '  ERR=' + r.skipped : ''}`);
}
console.log(`TOTAL pass=${totalPass} fail=${totalFail} allGreen=${allGreen}`);
console.log('REPORT_FILE ' + outPath);
