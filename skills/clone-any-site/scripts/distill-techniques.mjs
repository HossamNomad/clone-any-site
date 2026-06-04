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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  sha1,
  slugify,
  categorize,
  parseFrontmatter,
  fmArray,
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
const DEFAULT_LIB     = 'design-system/clone-techniques';
const DEFAULT_LIB_DNA = 'design-system/design-dna';

// ---------------------------------------------------------------------------
// stripMarkdown — remove bold, links, backticks from a cell string.
// ---------------------------------------------------------------------------
function stripMarkdown(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/\*\*/g, '')                      // bold
    .replace(/[`*_]+/g, '')                    // emphasis / backtick
    .trim();
}

// ---------------------------------------------------------------------------
// parseEffectTable — parse a GFM table that has an Effect/Technique column
// AND a Mechanism column. Returns [{ name, mechanismHint, refId }].
// Skips fenced-code-block content and non-qualifying tables.
// ---------------------------------------------------------------------------
export function parseEffectTable(md) {
  const lines = md.split(/\r?\n/);
  let inFence = false;
  const result = [];

  // We scan for blocks that look like a GFM table: header | delimiter | body rows
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];

    // fence tracking
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; i++; continue; }
    if (inFence) { i++; continue; }

    // look for a pipe-table header row
    if (!raw.trim().startsWith('|')) { i++; continue; }

    // parse header cells
    const headerCells = raw.split('|').map((c) => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
    if (headerCells.length < 2) { i++; continue; }

    // next non-empty line must be a delimiter row (|---|)
    let di = i + 1;
    while (di < lines.length && lines[di].trim() === '') di++;
    if (di >= lines.length) { i++; continue; }
    if (!/^\|[-| :]+\|/.test(lines[di].trim())) { i++; continue; }

    // identify Effect/Technique and Mechanism column indices (case-insensitive)
    const effectIdx = headerCells.findIndex((h) => /^effect$|^technique$/i.test(h));
    const mechIdx   = headerCells.findIndex((h) => /^mechanism/i.test(h));
    if (effectIdx === -1 || mechIdx === -1) { i = di + 1; continue; } // not an effect table

    // identify optional ID/ref column
    const idIdx = headerCells.findIndex((h) => /^id$/i.test(h));

    // parse body rows
    let ri = di + 1;
    while (ri < lines.length) {
      const row = lines[ri];
      if (!row.trim().startsWith('|')) break;
      if (/^\s*(```|~~~)/.test(row)) { inFence = true; break; }

      const cells = row.split('|').map((c) => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (cells.length <= Math.max(effectIdx, mechIdx)) { ri++; continue; }

      const name = stripMarkdown(cells[effectIdx] || '');
      const mechanismHint = stripMarkdown(cells[mechIdx] || '');
      const refIdRaw = idIdx !== -1 ? (cells[idIdx] || '') : '';
      const refIdMatch = refIdRaw.match(/^E\d+/i);
      const refId = refIdMatch ? refIdMatch[0].toUpperCase() : '';

      if (name) result.push({ name, mechanismHint, refId });
      ri++;
    }
    i = ri;
  }
  return result;
}

// ---------------------------------------------------------------------------
// inferFeasibilityFromStack — negation-aware token scanner.
// red:    any NON-negated token in { three, r3f, react-three, webgl, wasm, draco, glb, shader, glsl }
// yellow: any NON-negated token in { gsap, canvas, lenis, locomotive, lottie, framer-motion }
// green:  otherwise
//
// "No X" / "without X" / "no X," count as negated — the token X does NOT raise the tier.
// ---------------------------------------------------------------------------
const RED_TOKENS    = ['three', 'r3f', 'react-three', 'webgl', 'wasm', 'draco', 'glb', 'shader', 'glsl'];
const YELLOW_TOKENS = ['gsap', 'canvas', 'lenis', 'locomotive', 'lottie', 'framer-motion'];

export function inferFeasibilityFromStack(md) {
  // Focus on Stack snapshot section if present, else scan whole text.
  let text = md;
  const snapMatch = md.match(/##\s+Stack snapshot([\s\S]*?)(?=\n##\s|\s*$)/i);
  if (snapMatch) text = snapMatch[1];

  // Tokenize: build list of {token, negated}
  // A token preceded (anywhere in the same short window) by "no " or "without " is negated.
  const lc = text.toLowerCase();

  const isNegated = (tok, pos) => {
    // look back up to 20 chars for "no " or "without "
    const window = lc.slice(Math.max(0, pos - 20), pos);
    return /\bno\s+$/.test(window) || /\bwithout\s+$/.test(window);
  };

  let hasRed = false;
  let hasYellow = false;

  for (const tok of RED_TOKENS) {
    let idx = lc.indexOf(tok);
    while (idx !== -1) {
      if (!isNegated(tok, idx)) { hasRed = true; break; }
      idx = lc.indexOf(tok, idx + 1);
    }
    if (hasRed) break;
  }

  if (!hasRed) {
    for (const tok of YELLOW_TOKENS) {
      let idx = lc.indexOf(tok);
      while (idx !== -1) {
        if (!isNegated(tok, idx)) { hasYellow = true; break; }
        idx = lc.indexOf(tok, idx + 1);
      }
      if (hasYellow) break;
    }
  }

  return hasRed ? 'red' : hasYellow ? 'yellow' : 'green';
}

// ---------------------------------------------------------------------------
// inferDimensions — map name + mechanismHint to sorted unique dimension ids.
// Uses byKey() from dimensions.mjs to stay consistent with the dimension table.
// ---------------------------------------------------------------------------
export function inferDimensions(name, hint = '') {
  const n = (name + ' ' + hint).toLowerCase();
  const has = (...ws) => ws.some((w) => n.includes(w));
  const ids = new Set();

  const add = (key) => { const d = byKey(key); if (d) ids.add(d.id); };

  // motion (1)
  if (has('scroll', 'parallax', 'scrub', 'translate', 'sticky', 'pin', 'marquee', 'reveal', 'fade', 'loop', 'animate', 'animation', 'transform', 'transition', 'move', 'slide', 'reel')) add('motion');

  // immersion (2) — 3d/depth signals
  if (has('3d', 'depth', 'webgl', 'three', 'r3f', 'canvas', 'perspective', 'camera')) add('immersion');

  // kinetic-type (3)
  if (has('typewriter', 'type ', 'typing', 'split-text', 'splittext', 'letter', 'character', 'word', 'font', 'text reveal', 'text anim')) add('kinetic-type');

  // narrative (4)
  if (has('chapter', 'story', 'progress', 'route', 'section', 'meter', 'indicator', 'pin')) add('narrative');

  // color (5)
  if (has('gradient', 'color', 'colour', 'grade', 'blur', 'opacity', 'crossfade', 'blend', 'filter', 'hue')) add('color');

  // micro-interactions (6)
  if (has('cursor', 'magnetic', 'hover', 'click', 'button', 'focus', 'micro', 'interaction', 'drag')) add('micro-interactions');

  // perf (7)
  if (has('lazy', 'lazy-load', 'lazyload', 'preload', 'will-change', 'gpu', 'offscreen', 'decode', 'perf', 'performance')) add('perf');

  // composition (8)
  if (has('grid', 'collage', 'column', 'slider', 'gallery', 'layout', 'masonry', 'strip', 'tile', 'block')) add('composition');

  // sound (9)
  if (has('audio', 'sound', 'music', 'narration', 'mp3', 'wav', 'sfx')) add('sound');

  // finish (10)
  if (has('finish', 'polish', 'cohesion', 'detail', 'micro-detail', 'spacing', 'refined')) add('finish');

  const sorted = [...ids].sort((a, b) => a - b);
  return sorted.length > 0 ? sorted : [1]; // default motion
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
// main
// ---------------------------------------------------------------------------
async function run(argv) {
  const args = parseArgs(argv);
  const clone = args.clone;
  const effects = args.effects;
  const schema = args.schema && args.schema !== true ? args.schema : 'legacy';
  const isDna = schema === 'dna';
  const lib = args.lib && args.lib !== true ? args.lib : (isDna ? DEFAULT_LIB_DNA : DEFAULT_LIB);
  const draftOnly = !!args['draft-only'];
  const now = args.now && args.now !== true ? args.now : null;

  if (!clone || clone === true) throw new Error('--clone <name> is required');
  if (!effects || effects === true) throw new Error('--effects <effectsInventory.md> is required');
  if (!existsSync(effects)) throw new Error(`effects inventory not found: ${effects}`);

  const md = await readFile(effects, 'utf8');

  // --- DNA mode ---
  if (isDna) {
    return runDna({ clone, md, lib, draftOnly, now });
  }

  // --- Legacy mode (unchanged) ---
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

// ---------------------------------------------------------------------------
// runDna — DNA mode: parse recon effect table + heading candidates, emit
// DNA card stubs, dna.json (validated-only), and grouped TECHNIQUES.md.
// ---------------------------------------------------------------------------
async function runDna({ clone, md, lib, draftOnly, now }) {
  const firstSeen = now || clone;
  const feasibility = inferFeasibilityFromStack(md);

  // Gather candidates: effect-table rows first, then heading/bullet fallback.
  const tableRows = parseEffectTable(md);
  const headingCands = parseCandidates(md);

  // Build unified candidate list, dedup by slug (table rows take precedence).
  const seen = new Set();
  const candidates = [];

  for (const row of tableRows) {
    const slug = slugify(row.name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    candidates.push({
      name: row.name,
      slug,
      mechanismHint: row.mechanismHint,
      refId: row.refId,
      fromTable: true,
    });
  }
  for (const hc of headingCands) {
    if (seen.has(hc.slug)) continue;
    seen.add(hc.slug);
    candidates.push({ name: hc.name, slug: hc.slug, mechanismHint: '', refId: '', fromTable: false });
  }

  if (candidates.length < 1) {
    throw new Error('no candidate techniques parsed; need at least 1 (effect table row, H2/H3 heading, or bullet)');
  }

  const cardsDir = join(lib, 'cards');
  if (!draftOnly) {
    await mkdir(cardsDir, { recursive: true });
  }

  const touched = [];

  for (const cand of candidates) {
    const { slug, name, mechanismHint, refId } = cand;
    const category = categorize(name);
    const cardPath = join(cardsDir, `${slug}.md`);
    let action;
    let card;

    // Per-card feasibility: raise if mechanism itself names a non-negated red/yellow token.
    let cardFeasibility = feasibility;
    if (mechanismHint) {
      const hintTier = inferFeasibilityFromStack(mechanismHint);
      // red > yellow > green
      if (hintTier === 'red') cardFeasibility = 'red';
      else if (hintTier === 'yellow' && cardFeasibility === 'green') cardFeasibility = 'yellow';
    }

    const dimensions = inferDimensions(name, mechanismHint);
    const refExample = `${clone} — ${name}`;

    if (existsSync(cardPath)) {
      // DEDUP: read existing, bump seenOnSites, leave all DNA fields intact.
      const text = await readFile(cardPath, 'utf8');
      const { fm, body } = parseFrontmatter(text);
      const seenSites = Array.isArray(fm.seenOnSites)
        ? fm.seenOnSites.slice()
        : (fm.seenOnSites ? [fm.seenOnSites] : []);
      const already = seenSites.includes(clone);
      if (!already) seenSites.push(clone);

      const newFm = buildFrontmatter({
        slug: fm.slug || slug,
        name: fm.name || name,
        category: fm.category || category,
        intent: fm.intent || 'TODO',
        whenToUse: fm.whenToUse || 'TODO',
        artifactFit: fm.artifactFit || ['landing', 'site'],
        feasibilityTier: fm.feasibilityTier || cardFeasibility,
        dimensions: fm.dimensions || dimensions,
        refExample: fm.refExample || refExample,
        seenOnSites: seenSites,
        firstSeen: fm.firstSeen || firstSeen,
        status: fm.status || 'stub',
        source: fm.source || 'clone',
      }, { schema: 'dna' });

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
        intent: fm.intent || 'TODO',
        whenToUse: fm.whenToUse || 'TODO',
        artifactFit: Array.isArray(fm.artifactFit) ? fm.artifactFit : ['landing', 'site'],
        feasibilityTier: fm.feasibilityTier || cardFeasibility,
        dimensions: fm.dimensions || dimensions,
        refExample: fm.refExample || refExample,
        seenOnSites: seenSites,
        firstSeen: fm.firstSeen || firstSeen,
        status: fm.status || 'stub',
        source: fm.source || 'clone',
        path: cardPath,
        action,
      };
    } else {
      // New DNA stub card.
      const fmStr = buildFrontmatter({
        slug,
        name,
        category,
        intent: 'TODO',
        whenToUse: 'TODO',
        artifactFit: ['landing', 'site'],
        feasibilityTier: cardFeasibility,
        dimensions,
        refExample,
        seenOnSites: [clone],
        firstSeen,
        status: 'stub',
        source: 'clone',
      }, { schema: 'dna' });
      const body = newCardBody({ name, clone, feasibilityTier: cardFeasibility, artifactFit: ['landing', 'site'] }, { schema: 'dna' });
      const out = fmStr + '\n' + body;
      if (!draftOnly) {
        await writeFile(cardPath, out, 'utf8');
      }
      action = 'created';
      card = {
        slug, name, category,
        intent: 'TODO',
        whenToUse: 'TODO',
        artifactFit: ['landing', 'site'],
        feasibilityTier: cardFeasibility,
        dimensions,
        refExample,
        seenOnSites: [clone],
        firstSeen,
        status: 'stub',
        source: 'clone',
        path: cardPath,
        action,
      };
    }
    touched.push(card);
  }

  // Rebuild index (grouped by dimension) from on-disk source of truth.
  let indexCards;
  if (draftOnly) {
    indexCards = touched.map((c) => ({ ...c }));
  } else {
    indexCards = await readAllCards(cardsDir, { schema: 'dna' });
  }
  const indexMd = buildIndex(indexCards, { schema: 'dna' });
  const indexPath = join(lib, 'TECHNIQUES.md');
  if (!draftOnly) {
    await writeFile(indexPath, indexMd, 'utf8');
  }

  // Write dna.json — only validated, non-flagged cards.
  const validCards = indexCards.filter((c) => {
    const { ok } = validateCard(c, '');
    if (!ok) return false;
    // also check for suspect code via a minimal body representation
    const bodyCheck = flagSuspectCode(`## Approximation\n${c.refExample || ''}\n## Source\n`);
    return bodyCheck === null;
  });
  const dnaJsonStr = buildDnaJson(validCards);
  const dnaJsonPath = join(lib, 'dna.json');
  if (!draftOnly) {
    await writeFile(dnaJsonPath, dnaJsonStr, 'utf8');
  }

  return {
    clone,
    lib,
    indexPath,
    draftOnly,
    now,
    runId: sha1(`dna:${clone}\n${lib}\n${candidates.map((c) => c.slug).join(',')}`).slice(0, 12),
    cards: touched.map((c) => ({
      slug: c.slug,
      name: c.name,
      category: c.category,
      feasibilityTier: c.feasibilityTier,
      dimensions: c.dimensions,
      seenOnSites: c.seenOnSites,
      firstSeen: c.firstSeen,
      status: c.status,
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
// parseEffectTable, inferFeasibilityFromStack, inferDimensions are exported as named exports above.
