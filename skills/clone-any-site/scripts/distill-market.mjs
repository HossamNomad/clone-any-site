// distill-market.mjs — market-shortlist path: turns a per-studio analysis NOTE
// (generalized, IP-clean) into DNA cards via the shared lib, with a verbatim/IP guard.
//
// CLI:
//   node distill-market.mjs --studio "Active Theory" --note <path> \
//        [--lib design-system/design-dna] [--now <iso>]
//
// IP rule (non-negotiable):
//   NEVER copy a fenced code block from the note into a card.
//   The ## Code section in every card is always the clean-room TODO placeholder.
//   ## Source cites the note path, never original site bytes.
//
// Exports: parseMarketNote (pure, testable).
// DETERMINISM: zero clock reads; all timestamps from --now.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slugify,
  parseFrontmatter,
  buildFrontmatter,
  newCardBody,
  variantNote,
  hasVariantNote,
  buildIndex,
  readAllCards,
  validateCard,
  flagSuspectCode,
  buildDnaJson,
} from './lib/dna-card.mjs';
import { byKey } from './lib/dimensions.mjs';

// ---------------------------------------------------------------------------
// tiny hand-rolled flag parser (no deps)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// parseMarketNote — pure parser. Exported for testing.
//
// Input: markdown string with one `## <Technique Name>` heading per technique,
//   each followed by `- key: value` bullets (until next `## `).
//   Fenced code blocks inside a technique block are IGNORED (IP guard).
//
// Returns: Array<{
//   name: string,
//   dimensions: number[],    // ids only, unknown keys dropped
//   tier: string,
//   artifactFit: string[],   // comma-separated, order preserved from note
//   intent: string,
//   mechanism: string,
//   approximation: string|undefined,
// }>
// ---------------------------------------------------------------------------
export function parseMarketNote(md) {
  // Split into blocks at each ## heading (H2 only, not H1/H3+)
  // We split on lines that start with exactly "## "
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let current = null;
  let inFencedCode = false;

  for (const line of lines) {
    // Track fenced code blocks — content inside is silently discarded
    if (/^```/.test(line)) {
      inFencedCode = !inFencedCode;
      continue;
    }
    if (inFencedCode) continue;

    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      // Save previous block
      if (current) blocks.push(current);
      current = { name: h2[1].trim(), _bullets: [] };
      continue;
    }
    if (!current) continue;

    // Collect bullet lines: `- key: value`
    const bullet = line.match(/^-\s+([a-zA-Z]+):\s*(.*)/);
    if (bullet) {
      current._bullets.push({ key: bullet[1].toLowerCase(), val: bullet[2].trim() });
    }
  }
  if (current) blocks.push(current);

  return blocks.map(({ name, _bullets }) => {
    const get = (k) => (_bullets.find((b) => b.key === k) || {}).val || '';

    // dimensions: comma-separated KEYS → ids via byKey, drop unknowns
    const dimRaw = get('dimension');
    const dimensions = dimRaw
      ? dimRaw.split(',').map((k) => k.trim()).map((k) => byKey(k)).filter(Boolean).map((d) => d.id)
      : [];

    // artifactFit: comma-separated, preserve order
    const fitRaw = get('artifactfit');
    const artifactFit = fitRaw ? fitRaw.split(',').map((v) => v.trim()).filter(Boolean) : [];

    const tier = get('tier') || 'green';
    const intent = get('intent');
    const mechanism = get('mechanism');
    const approximation = get('approximation') || undefined;

    return { name, dimensions, tier, artifactFit, intent, mechanism, approximation };
  });
}

// ---------------------------------------------------------------------------
// variantNote for market source (overrides clone path's recon link)
// ---------------------------------------------------------------------------
function marketVariantNote(studio) {
  return [
    '',
    `### Variant seen on ${studio}`,
    '',
    `- Market analysis note for ${studio}`,
    '',
  ].join('\n');
}

function marketHasVariantNote(body, studio) {
  const re = new RegExp('^### Variant seen on ' + studio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
  return re.test(body);
}

// ---------------------------------------------------------------------------
// buildMarketCardBody — like newCardBody({schema:'dna'}) but:
//   • ## Mechanism section filled from note (IP-clean text, no code)
//   • ## Code is ALWAYS the clean-room TODO placeholder (never note code)
//   • ## Source cites the note path, not original site bytes
//   • ## Approximation present for red tier
// ---------------------------------------------------------------------------
function buildMarketCardBody({ name, intent, mechanism, artifactFit, feasibilityTier, approximation, notePath, studio }) {
  const reuseBullets = (artifactFit.length ? [...artifactFit].sort() : ['site'])
    .map((f) => `- ${f}`)
    .join('\n');

  const sections = [
    `# ${name}`,
    '',
    '## Intent',
    '',
    intent || '<!-- TODO: fill in the why + immersion story -->',
    '',
    '## Mechanism',
    '',
    mechanism || '<!-- TODO: describe how it works under the hood -->',
    '',
    '## Code',
    '',
    '```js',
    '// GENERIC, original-free recipe — not the cloned source.',
    '// Replace with a clean-room implementation.',
    'export function applyTechnique(target, opts = {}) {',
    '  // TODO: implement the generalized recipe here.',
    '  return target;',
    '}',
    '```',
    '',
    '## Where to reuse',
    '',
    reuseBullets,
    '',
  ];

  if (feasibilityTier === 'red') {
    const approxText = approximation || '<!-- TODO: describe the cheaper green/yellow substitute -->';
    sections.push('## Approximation', '', approxText, '');
  }

  // ## Source cites the note path, never original site bytes
  sections.push('## Source', '', `- Market analysis note: \`${notePath}\``, '');

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// runMarket — main async logic
// ---------------------------------------------------------------------------
async function runMarket({ studio, note, lib, now }) {
  const firstSeen = now || new Date(0).toISOString();
  const notePath = resolve(note);
  const md = await readFile(notePath, 'utf8');
  const techniques = parseMarketNote(md);

  const cardsDir = join(lib, 'cards');
  await mkdir(cardsDir, { recursive: true });

  const touched = [];

  for (const tech of techniques) {
    const { name, dimensions, tier, artifactFit, intent, mechanism, approximation } = tech;
    const slug = slugify(name);
    const cardPath = join(cardsDir, `${slug}.md`);

    // category = primary dimension key (first in list, by note order)
    const category = dimensions.length ? _dimKey(dimensions[0]) : 'effect';

    let card;

    if (existsSync(cardPath)) {
      // DEDUP: bump seenOnSites, append variant note (idempotent).
      const text = await readFile(cardPath, 'utf8');
      const { fm, body } = parseFrontmatter(text);
      const seenSites = Array.isArray(fm.seenOnSites)
        ? fm.seenOnSites.slice()
        : (fm.seenOnSites ? [fm.seenOnSites] : []);
      const already = seenSites.includes(studio);
      if (!already) seenSites.push(studio);

      const newFm = buildFrontmatter({
        slug: fm.slug || slug,
        name: fm.name || name,
        category: fm.category || category,
        intent: fm.intent || intent || '',
        whenToUse: fm.whenToUse || '',
        artifactFit: Array.isArray(fm.artifactFit)
          ? fm.artifactFit
          : (fm.artifactFit ? [fm.artifactFit] : artifactFit),
        feasibilityTier: fm.feasibilityTier || tier,
        dimensions: Array.isArray(fm.dimensions)
          ? fm.dimensions.map(Number)
          : dimensions,
        refExample: fm.refExample || `${studio} — ${name}`,
        seenOnSites: seenSites,
        firstSeen: fm.firstSeen || firstSeen,
        status: fm.status || 'stub',
        source: fm.source || 'market',
      }, { schema: 'dna' });

      let newBody = body;
      if (!marketHasVariantNote(newBody, studio)) {
        newBody = newBody.replace(/\s*$/, '\n') + marketVariantNote(studio);
      }

      const out = newFm + '\n' + newBody;
      if (out !== text) {
        await writeFile(cardPath, out, 'utf8');
      }

      card = {
        slug: fm.slug || slug,
        name: fm.name || name,
        category: fm.category || category,
        intent: fm.intent || intent || '',
        whenToUse: fm.whenToUse || '',
        artifactFit: Array.isArray(fm.artifactFit) ? fm.artifactFit : artifactFit,
        feasibilityTier: fm.feasibilityTier || tier,
        dimensions: Array.isArray(fm.dimensions) ? fm.dimensions.map(Number) : dimensions,
        refExample: fm.refExample || `${studio} — ${name}`,
        seenOnSites: seenSites,
        firstSeen: fm.firstSeen || firstSeen,
        status: fm.status || 'stub',
        source: fm.source || 'market',
        path: cardPath,
        action: already ? 'noop' : 'updated',
      };
    } else {
      // New card stub.
      const fmStr = buildFrontmatter({
        slug,
        name,
        category,
        intent: intent || '',
        whenToUse: '',
        artifactFit,
        feasibilityTier: tier,
        dimensions,
        refExample: `${studio} — ${name}`,
        seenOnSites: [studio],
        firstSeen,
        status: 'stub',
        source: 'market',
      }, { schema: 'dna' });

      const body = buildMarketCardBody({
        name, intent, mechanism, artifactFit, feasibilityTier: tier,
        approximation, notePath, studio,
      });

      const out = fmStr + '\n' + body;
      await writeFile(cardPath, out, 'utf8');

      card = {
        slug, name, category,
        intent: intent || '',
        whenToUse: '',
        artifactFit,
        feasibilityTier: tier,
        dimensions,
        refExample: `${studio} — ${name}`,
        seenOnSites: [studio],
        firstSeen,
        status: 'stub',
        source: 'market',
        path: cardPath,
        action: 'created',
      };
    }

    touched.push(card);
  }

  // Rebuild index from on-disk source of truth.
  const indexCards = await readAllCards(cardsDir, { schema: 'dna' });
  const indexMd = buildIndex(indexCards, { schema: 'dna' });
  await writeFile(join(lib, 'TECHNIQUES.md'), indexMd, 'utf8');

  // Write dna.json — only validated, non-flagged cards (stubs/incomplete excluded).
  const validCards = indexCards.filter((c) => {
    const { ok } = validateCard(c, '');
    if (!ok) return false;
    const bodyCheck = flagSuspectCode(`## Approximation\n${c.refExample || ''}\n## Source\n`);
    return bodyCheck === null;
  });
  const dnaJsonStr = buildDnaJson(validCards);
  await writeFile(join(lib, 'dna.json'), dnaJsonStr, 'utf8');

  return {
    cards: touched.map((c) => ({
      slug: c.slug,
      name: c.name,
      category: c.category,
      seenOnSites: c.seenOnSites,
      firstSeen: c.firstSeen,
      action: c.action,
      path: c.path,
    })),
  };
}

// ---------------------------------------------------------------------------
// _dimKey — reverse lookup: dimension id -> key string
// ---------------------------------------------------------------------------
function _dimKey(id) {
  const MAP = {
    1: 'motion', 2: 'immersion', 3: 'kinetic-type', 4: 'narrative',
    5: 'color', 6: 'micro-interactions', 7: 'perf', 8: 'composition',
    9: 'sound', 10: 'finish',
  };
  return MAP[id] || 'effect';
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const studio = args.studio;
  const note = args.note;
  const lib = args.lib || 'design-system/design-dna';
  const now = args.now || null;

  if (!studio || !note) {
    process.stderr.write('Usage: node distill-market.mjs --studio <name> --note <path> [--lib <dir>] [--now <iso>]\n');
    process.exit(1);
  }

  runMarket({ studio, note, lib, now })
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write('ERROR: ' + err.message + '\n' + (err.stack || '') + '\n');
      process.exit(1);
    });
}
