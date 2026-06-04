#!/usr/bin/env node
// design-quality-score.mjs — 10-dimension Design Quality Score (re-normalized per artifact type)
// + pattern recommender. Pure `score()` export + CLI.

import { DIMENSIONS, APPLICABILITY, byKey, byId } from './lib/dimensions.mjs';
import { rankCards } from './lib/query-core.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── core ──────────────────────────────────────────────────────────────────────

/**
 * score({ artifactType, dimensions }, cards) → result
 *
 * @param {object} input
 * @param {string} input.artifactType — must be a key of APPLICABILITY
 * @param {Record<string,number>} input.dimensions — { <dimensionKey>: 0-10, ... }
 * @param {object[]} cards — dna.json cards array (may be empty)
 * @returns {object} deterministic result (no clock, no random)
 */
export function score({ artifactType, dimensions = {} }, cards = []) {
  // Validate artifactType
  const validTypes = Object.keys(APPLICABILITY);
  if (!validTypes.includes(artifactType)) {
    throw new Error(
      `Invalid artifactType "${artifactType}". Valid types: ${validTypes.join(', ')}`,
    );
  }

  const warnings = [];

  // Resolve applicable dimension ids → objects
  const applicableIds = APPLICABILITY[artifactType]; // e.g. [1,3,4,5,8,10] for deck
  const applicableDims = applicableIds.map((id) => byId(id)); // [{id,key,weight}, ...]

  // Σ weights of applicable dims
  const applicableWeights = applicableDims.reduce((acc, d) => acc + d.weight, 0);

  // Detect provided keys that are NOT applicable → warn
  for (const key of Object.keys(dimensions)) {
    const dim = byKey(key);
    if (!dim) {
      warnings.push(`Unknown dimension key "${key}" — ignored`);
      continue;
    }
    if (!applicableIds.includes(dim.id)) {
      warnings.push(
        `Dimension "${key}" (id=${dim.id}) is not applicable to artifact type "${artifactType}" — ignored`,
      );
    }
  }

  // Compute per-dimension contributions
  let totalContribution = 0;
  const perDimension = applicableDims.map((dim) => {
    const raw = dimensions[dim.key];
    let s;
    if (raw === undefined || raw === null) {
      s = 0;
      warnings.push(`Missing score for applicable dimension "${dim.key}" — defaulting to 0`);
    } else {
      s = Math.max(0, Math.min(10, raw)); // clamp
    }
    const contribution = (s / 10) * dim.weight;
    totalContribution += contribution;
    return {
      id: dim.id,
      key: dim.key,
      weight: dim.weight,
      score: s,
      contribution: Number(contribution.toFixed(4)),
    };
  });

  // Final score
  const scoreVal = Math.round((100 * totalContribution) / applicableWeights);

  // Weakest: sort applicable dims by (score asc, weight desc, id asc), take top 3
  const weakest = perDimension
    .slice() // copy — don't mutate
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;   // asc
      if (a.weight !== b.weight) return b.weight - a.weight; // desc
      return a.id - b.id;                                    // asc
    })
    .slice(0, 3)
    .map(({ id, key, score: s }) => ({ id, key, score: s }));

  // Recommended patterns: for each weakest dim, rankCards(artifact + dimension, limit 2)
  let recommendedPatterns = [];
  if (cards.length === 0) {
    warnings.push('No cards provided (dna.json not loaded) — recommendedPatterns is empty');
  } else {
    const seen = new Set();
    for (const w of weakest) {
      const ranked = rankCards(cards, { artifact: artifactType, dimension: w.id, limit: 2 });
      for (const card of ranked) {
        if (!seen.has(card.slug)) {
          seen.add(card.slug);
          recommendedPatterns.push({
            slug: card.slug,
            name: card.name,
            feasibilityTier: card.feasibilityTier,
            dimensions: card.dimensions,
            path: card.path,
          });
        }
      }
    }
  }

  return {
    artifactType,
    applicableWeights,
    perDimension,
    score: scoreVal,
    weakest,
    recommendedPatterns,
    warnings,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // Returns { artifact, inFile, libDir, dims: {key: value} }
  const args = argv.slice(2);
  const result = { artifact: null, inFile: null, libDir: null, dims: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--artifact' && args[i + 1]) { result.artifact = args[++i]; continue; }
    if (a === '--in' && args[i + 1]) { result.inFile = args[++i]; continue; }
    if (a === '--lib' && args[i + 1]) { result.libDir = args[++i]; continue; }
    if (a === '--dim' && args[i + 1]) {
      const [k, v] = args[++i].split('=');
      if (k && v !== undefined) result.dims[k] = Number(v);
      continue;
    }
  }
  return result;
}

async function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf.trim() || null));
    // If stdin is a TTY (interactive), resolve immediately with null
    if (process.stdin.isTTY) resolve(null);
  });
}

// Run CLI only when this file is the entry point
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  (async () => {
    const opts = parseArgs(process.argv);

    // Validate artifact type early
    const validTypes = Object.keys(APPLICABILITY);
    if (!opts.artifact || !validTypes.includes(opts.artifact)) {
      process.stderr.write(
        `Error: invalid or missing --artifact. Valid types: ${validTypes.join(', ')}\n`,
      );
      process.exit(1);
    }

    // Resolve input dimensions
    let dims = { ...opts.dims };
    if (opts.inFile) {
      const raw = readFileSync(opts.inFile, 'utf8');
      const parsed = JSON.parse(raw);
      dims = { ...(parsed.dimensions || parsed), ...dims }; // CLI --dim overrides file
    } else if (!process.stdin.isTTY) {
      // Try to read from stdin
      const stdinData = await readStdin();
      if (stdinData) {
        try {
          const parsed = JSON.parse(stdinData);
          dims = { ...(parsed.dimensions || parsed), ...dims };
        } catch {
          // treat as empty
        }
      }
    }

    // Load dna.json if available
    const libDir = opts.libDir
      ? path.resolve(opts.libDir)
      : path.resolve(__dirname, '..', '..', '..', '..', 'design-system', 'design-dna');
    const dnaPath = path.join(libDir, 'dna.json');
    let cards = [];
    if (existsSync(dnaPath)) {
      try {
        const dna = JSON.parse(readFileSync(dnaPath, 'utf8'));
        cards = dna.cards || [];
      } catch {
        // leave cards empty — score() will add warning
      }
    }

    // Score
    let result;
    try {
      result = score({ artifactType: opts.artifact, dimensions: dims }, cards);
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  })();
}
