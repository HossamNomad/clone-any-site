#!/usr/bin/env node
// regen-dna-index.mjs — rebuild design-system/design-dna/{dna.json, TECHNIQUES.md} from the cards on disk,
// WITHOUT re-parsing any recon inventory (so it never re-introduces heading-noise stubs). Includes only cards
// that pass validateCard + are not verbatim-flagged + are not status:stub. Composes the tested lib fns.
//   node regen-dna-index.mjs [lib=design-system/design-dna]
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, validateCard, flagSuspectCode, buildDnaJson, buildIndex } from './lib/dna-card.mjs';
import { DIMENSIONS } from './lib/dimensions.mjs';

const lib = process.argv[2] || 'design-system/design-dna';
const cardsDir = join(lib, 'cards');
if (!existsSync(cardsDir)) { console.error('no cards dir at ' + cardsDir); process.exit(1); }

const files = readdirSync(cardsDir).filter((f) => f.endsWith('.md')).sort();
const ready = [];
const skipped = [];
for (const f of files) {
  const text = readFileSync(join(cardsDir, f), 'utf8');
  const { fm, body } = parseFrontmatter(text);
  fm.dimensions = Array.isArray(fm.dimensions) ? fm.dimensions.map(Number) : [];
  fm.artifactFit = Array.isArray(fm.artifactFit) ? fm.artifactFit : (fm.artifactFit ? [fm.artifactFit] : []);
  fm.seenOnSites = Array.isArray(fm.seenOnSites) ? fm.seenOnSites : (fm.seenOnSites ? [fm.seenOnSites] : []);
  const v = validateCard(fm, body);
  const flag = flagSuspectCode(body);
  if (v.ok && !flag) ready.push({ ...fm, path: 'cards/' + f });
  else skipped.push({ slug: fm.slug || f, reason: flag || v.errors.join('; ') });
}

writeFileSync(join(lib, 'dna.json'), buildDnaJson(ready));
writeFileSync(join(lib, 'TECHNIQUES.md'), buildIndex(ready, { schema: 'dna' }));

// coverage: which of the 10 dimensions have >=1 ready card
const covered = new Set();
for (const c of ready) for (const d of c.dimensions) covered.add(Number(d));
const missing = DIMENSIONS.filter((d) => !covered.has(d.id)).map((d) => d.id + ':' + d.key);

console.log(JSON.stringify({
  lib, readyCount: ready.length, excluded: skipped.length,
  dimensionsCovered: [...covered].sort((a, b) => a - b), missingDimensions: missing,
  excludedDetail: skipped,
}, null, 2));
