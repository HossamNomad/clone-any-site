#!/usr/bin/env node
// query-dna.mjs — Ranked technique retrieval CLI (Task 3.1).
// Usage: node query-dna.mjs [--artifact landing] [--dimension micro-interactions|6]
//          [--tier green] [--limit 5] [--lib design-system/design-dna] [--json]
//
// Exit codes:
//   0 — OK (including empty result set)
//   2 — dna.json not found at resolved path

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankCards } from './lib/query-core.mjs';

// ---------------------------------------------------------------------------
// Arg parse (repo-standard idiom)
// ---------------------------------------------------------------------------
const A = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith('--'))
      a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return a;
  }, []),
);

// ---------------------------------------------------------------------------
// Resolve dna.json path
// ---------------------------------------------------------------------------
const libDir = A.lib || 'design-system/design-dna';
const dnaPath = resolve(process.cwd(), libDir, 'dna.json');

if (!existsSync(dnaPath)) {
  process.stderr.write(
    `no dna.json at ${dnaPath} — seed the corpus first (distill-techniques --schema dna / distill-market)\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Load + rank
// ---------------------------------------------------------------------------
const data = JSON.parse(readFileSync(dnaPath, 'utf8'));
const query = {
  artifact:  A.artifact  || undefined,
  dimension: A.dimension || undefined,
  tier:      A.tier      || undefined,
  limit:     A.limit     ? Number(A.limit) : undefined,
};

const ranked = rankCards(data.cards, query);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const TIER_BADGE = { green: '[green]', yellow: '[yellow]', red: '[red]' };

if (A.json) {
  const out = {
    query,
    count: ranked.length,
    cards: ranked.map((c) => ({
      slug:           c.slug,
      name:           c.name,
      intent:         c.intent,
      feasibilityTier: c.feasibilityTier,
      dimensions:     c.dimensions,
      artifactFit:    c.artifactFit,
      path:           c.path,
    })),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  // Human table
  process.stdout.write(`${'tier'.padEnd(8)}  ${'slug'.padEnd(26)}  ${'dims'.padEnd(16)}  name\n`);
  for (const c of ranked) {
    const badge = TIER_BADGE[c.feasibilityTier] || `[${c.feasibilityTier}]`;
    const dims  = `[${c.dimensions.join(',')}]`;
    process.stdout.write(`${badge.padEnd(8)}  ${c.slug.padEnd(26)}  ${dims.padEnd(16)}  ${c.name}\n`);
  }
  process.stdout.write(`count=${ranked.length}\n`);
}
