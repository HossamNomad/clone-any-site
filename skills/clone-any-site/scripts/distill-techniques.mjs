// distill-techniques.mjs — cumulative technique-absorption ledger (design spec §11.5).
// ZERO deps (node built-ins only). Turns a clone's recon effects-inventory into reusable
// technique CARD stubs in a shared design-system library, deduping across clones.
//
// Each card = metadata + a GENERALIZED recipe. NEVER copies original asset bytes or
// original source code — generalized recipes only.
//
// CLI:
//   node distill-techniques.mjs --clone <name> --effects <effectsInventory.md> \
//        [--lib design-system/clone-techniques] [--draft-only] [--now <iso>]
//
// Behavior:
//   - Parse the effects-inventory markdown into candidate techniques (each H2/H3 heading
//     OR top-level bullet = one candidate). Produce 3..7 technique card stubs.
//   - Each card -> <lib>/cards/<slug>.md with frontmatter
//     { slug, name, category, seenOnSites:[<clone>], firstSeen:<clone> } and the sections
//     ## Mechanism / ## Code sketch / ## Where to reuse / ## Source.
//   - DEDUP by slug. Existing card => bump seenOnSites to include <clone> (idempotent) and
//     append a "### Variant seen on <clone>" note. Never duplicate the card file.
//   - Maintain <lib>/TECHNIQUES.md index (sorted by slug), regenerated deterministically.
//   - Create <lib> + <lib>/cards/ if missing.
//
// DETERMINISM: never reads wall-clock time or uses runtime randomness. Any timestamp comes
// from --now (ISO string). Any id is content-derived (sha1 via node:crypto). Two runs on a
// frozen input produce byte-identical output.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// tiny hand-rolled flag parser (no deps)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true; // boolean flag
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const DEFAULT_LIB = 'design-system/clone-techniques';

function sha1(s) {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

// slug from a technique name: lowercased, non-alnum -> hyphen, collapsed, trimmed.
function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  // a re-run of the same name is byte-identical; an empty/non-latin name falls back to a
  // content-derived stable suffix (deterministic, no clock/randomness).
  if (!base) return 'technique-' + sha1(name).slice(0, 8);
  return base;
}

// Heuristic categorizer (deterministic; keyword match only).
function categorize(name) {
  const n = name.toLowerCase();
  const has = (...ws) => ws.some((w) => n.includes(w));
  if (has('scroll-scrub', 'scrub', 'pinned', 'sticky', 'parallax')) return 'scroll';
  if (has('smooth scroll', 'lenis', 'locomotive', 'inertia', 'inertial')) return 'scroll';
  if (has('marquee', 'ticker', 'infinite track', 'loop')) return 'motion';
  if (has('reveal', 'intersectionobserver', 'fade-in', 'fade in', 'on scroll')) return 'reveal';
  if (has('webgl', 'shader', 'three', 'r3f', 'canvas', 'gpu', 'glsl')) return 'webgl';
  if (has('cursor', 'hover', 'magnetic', 'tilt')) return 'interaction';
  if (has('typo', 'font', 'kinetic type', 'split text', 'text')) return 'typography';
  if (has('transition', 'page transition', 'route', 'morph')) return 'transition';
  return 'effect';
}

// ---------------------------------------------------------------------------
// parse the effects-inventory markdown into candidate technique names
//   - each H2 (##) or H3 (###) heading => one candidate
//   - each top-level bullet (- / * at column 0) => one candidate
//   - dedup candidate names by slug (first occurrence wins) so a repeated heading/bullet
//     in the SAME inventory doesn't create two cards.
//   - fenced code blocks are skipped so ```# comments``` aren't mistaken for headings.
// ---------------------------------------------------------------------------
function parseCandidates(md) {
  const lines = md.split(/\r?\n/);
  const seen = new Set();
  const candidates = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw;
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) { inFence = !inFence; continue; }
    if (inFence) continue;

    let name = null;
    const h = line.match(/^(#{2,3})\s+(.+?)\s*$/); // ## or ### heading
    if (h) {
      name = h[2].trim();
    } else {
      const b = line.match(/^([-*])\s+(.+?)\s*$/); // top-level bullet (column 0, no indent)
      if (b) name = b[2].trim();
    }
    if (!name) continue;
    // strip inline markdown emphasis/links for a clean technique name
    name = name
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
      .replace(/[`*_]+/g, '')
      .trim();
    if (!name) continue;
    const slug = slugify(name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    candidates.push({ name, slug });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// card construction / merge
// ---------------------------------------------------------------------------
const FM_OPEN = '---';

// Parse an existing card's frontmatter (minimal YAML: scalars + one inline array).
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: text };
  const fmRaw = m[1];
  const body = text.slice(m[0].length);
  const fm = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      val = inner.length
        ? inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        : [];
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    fm[key] = val;
  }
  return { fm, body };
}

function fmArray(s) {
  // deterministic: stable, no duplicates, sorted for byte-identical re-runs.
  const uniq = Array.from(new Set(s));
  uniq.sort();
  return '[' + uniq.join(', ') + ']';
}

function buildFrontmatter({ slug, name, category, seenOnSites, firstSeen }) {
  return [
    FM_OPEN,
    `slug: ${slug}`,
    `name: ${name}`,
    `category: ${category}`,
    `seenOnSites: ${fmArray(seenOnSites)}`,
    `firstSeen: ${firstSeen}`,
    FM_OPEN,
  ].join('\n');
}

function newCardBody({ name, clone }) {
  return [
    '',
    `# ${name}`,
    '',
    '## Mechanism',
    '',
    '<!-- TODO: describe the conceptual how-it-works. Derived from the recon heading only;',
    '     fill in the precise mechanism once studied in the mirror. -->',
    `*${name}* — conceptual mechanism not yet derived from the heading alone. **TODO:** explain`,
    'the underlying technique (what drives it, what state it reads, how it composes).',
    '',
    '## Code sketch',
    '',
    '```js',
    '// GENERIC, original-free placeholder — a recipe, not the cloned source.',
    '// Replace with a clean-room implementation of the technique.',
    'export function applyTechnique(target, opts = {}) {',
    '  // TODO: implement the generalized recipe here.',
    '  return target;',
    '}',
    '```',
    '',
    '## Where to reuse',
    '',
    '- **Pulsia**: landing heroes, expedition pages, dashboard moments.',
    '- **Atlas**: white-label cinematic-lounge client sites.',
    '- **Clients**: any premium marketing page that needs this effect.',
    '',
    '## Source',
    '',
    `- [\`clones/${clone}/_recon/effects-inventory.md\`](../../../clones/${clone}/_recon/effects-inventory.md)`,
    '',
  ].join('\n');
}

function variantNote(clone) {
  return [
    '',
    `### Variant seen on ${clone}`,
    '',
    `- [\`clones/${clone}/_recon/effects-inventory.md\`](../../../clones/${clone}/_recon/effects-inventory.md)`,
    '',
  ].join('\n');
}

function hasVariantNote(body, clone) {
  // exact heading match, line-anchored, to keep dedup idempotent
  const re = new RegExp('^### Variant seen on ' + clone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
  return re.test(body);
}

// ---------------------------------------------------------------------------
// TECHNIQUES.md index (deterministic, sorted by slug)
// ---------------------------------------------------------------------------
function buildIndex(cards) {
  const sorted = [...cards].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const rows = sorted.map((c) => {
    const n = Array.isArray(c.seenOnSites) ? c.seenOnSites.length : 0;
    return `| ${c.name} | ${c.category} | ${n} | [${c.slug}](cards/${c.slug}.md) |`;
  });
  return [
    '# Clone techniques — absorption ledger',
    '',
    'Cumulative library of reusable front-end techniques distilled from cloned sites.',
    'Metadata + generalized recipes only — no original asset bytes or source code.',
    'Regenerated deterministically by `distill-techniques.mjs` (sorted by slug).',
    '',
    '| Technique | Category | Seen on N sites | Card |',
    '|---|---|--:|---|',
    ...rows,
    '',
  ].join('\n');
}

// Read every card in <lib>/cards to rebuild the index from the source of truth on disk.
async function readAllCards(cardsDir) {
  const out = [];
  let entries = [];
  try {
    entries = await readdir(cardsDir);
  } catch {
    return out;
  }
  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
  for (const f of mdFiles) {
    const text = await readFile(join(cardsDir, f), 'utf8');
    const { fm } = parseFrontmatter(text);
    out.push({
      slug: fm.slug || f.replace(/\.md$/, ''),
      name: fm.name || f.replace(/\.md$/, ''),
      category: fm.category || 'effect',
      seenOnSites: Array.isArray(fm.seenOnSites) ? fm.seenOnSites : (fm.seenOnSites ? [fm.seenOnSites] : []),
      firstSeen: fm.firstSeen || '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function run(argv) {
  const args = parseArgs(argv);
  const clone = args.clone;
  const effects = args.effects;
  const lib = args.lib && args.lib !== true ? args.lib : DEFAULT_LIB;
  const draftOnly = !!args['draft-only'];
  const now = args.now && args.now !== true ? args.now : null;

  if (!clone || clone === true) throw new Error('--clone <name> is required');
  if (!effects || effects === true) throw new Error('--effects <effectsInventory.md> is required');
  if (!existsSync(effects)) throw new Error(`effects inventory not found: ${effects}`);

  const md = await readFile(effects, 'utf8');
  let candidates = parseCandidates(md);

  if (candidates.length < 3) {
    throw new Error(`only ${candidates.length} candidate technique(s) parsed; need at least 3 (each H2/H3 heading or top-level bullet = one candidate)`);
  }
  // Cap at 7 card stubs (3..7). Deterministic: keep document order, take the first 7.
  if (candidates.length > 7) candidates = candidates.slice(0, 7);

  const cardsDir = join(lib, 'cards');
  const touched = [];

  if (!draftOnly) {
    await mkdir(cardsDir, { recursive: true });
  }

  for (const cand of candidates) {
    const { slug, name } = cand;
    const category = categorize(name);
    const cardPath = join(cardsDir, `${slug}.md`);
    let action;
    let card;

    if (existsSync(cardPath)) {
      // DEDUP: bump seenOnSites + append a variant note (idempotent).
      const text = await readFile(cardPath, 'utf8');
      const { fm, body } = parseFrontmatter(text);
      const seen = Array.isArray(fm.seenOnSites)
        ? fm.seenOnSites.slice()
        : (fm.seenOnSites ? [fm.seenOnSites] : []);
      const already = seen.includes(clone);
      if (!already) seen.push(clone);

      const newFm = buildFrontmatter({
        slug: fm.slug || slug,
        name: fm.name || name,
        category: fm.category || category,
        seenOnSites: seen,
        firstSeen: fm.firstSeen || clone,
      });

      let newBody = body;
      if (!hasVariantNote(newBody, clone)) {
        newBody = newBody.replace(/\s*$/, '\n') + variantNote(clone);
      }
      const out = newFm + '\n' + newBody;
      if (!draftOnly && out !== text) {
        await writeFile(cardPath, out, 'utf8');
      }
      action = already ? 'noop' : 'updated';
      card = {
        slug: fm.slug || slug,
        name: fm.name || name,
        category: fm.category || category,
        seenOnSites: seen,
        firstSeen: fm.firstSeen || clone,
        path: cardPath,
        action,
      };
    } else {
      // new card stub
      const fm = buildFrontmatter({
        slug,
        name,
        category,
        seenOnSites: [clone],
        firstSeen: clone,
      });
      const body = newCardBody({ name, clone });
      const out = fm + '\n' + body;
      if (!draftOnly) {
        await writeFile(cardPath, out, 'utf8');
      }
      action = 'created';
      card = {
        slug,
        name,
        category,
        seenOnSites: [clone],
        firstSeen: clone,
        path: cardPath,
        action,
      };
    }
    touched.push(card);
  }

  // Rebuild index from the on-disk source of truth (so re-runs are byte-identical and
  // pre-existing cards from other clones are preserved).
  let indexCards;
  if (draftOnly) {
    indexCards = touched.map((c) => ({
      slug: c.slug, name: c.name, category: c.category, seenOnSites: c.seenOnSites, firstSeen: c.firstSeen,
    }));
  } else {
    indexCards = await readAllCards(cardsDir);
  }
  const indexMd = buildIndex(indexCards);
  const indexPath = join(lib, 'TECHNIQUES.md');
  if (!draftOnly) {
    await writeFile(indexPath, indexMd, 'utf8');
  }

  return {
    clone,
    lib,
    indexPath,
    draftOnly,
    now,
    // content-derived run id (deterministic; no randomness/clock)
    runId: sha1(`${clone}\n${lib}\n${candidates.map((c) => c.slug).join(',')}`).slice(0, 12),
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

// only run when invoked directly (so the test can import run())
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && process.argv[1].endsWith('distill-techniques.mjs'));

if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((res) => {
      process.stdout.write(JSON.stringify({ cards: res.cards, lib: res.lib, runId: res.runId, draftOnly: res.draftOnly }, null, 2) + '\n');
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`distill-techniques: ${err.message}\n`);
      process.exit(1);
    });
}

export { run, parseArgs, parseCandidates, slugify, categorize, buildIndex, parseFrontmatter };
