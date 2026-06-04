// lib/dna-card.mjs — shared card I/O helpers for the DNA library system (Task 1.2 + 1.3).
// Extracted verbatim from distill-techniques.mjs — legacy output is BYTE-IDENTICAL.
//
// Functions accept an optional `{ schema = 'legacy' }` options object:
//   'legacy' — byte-identical to original distill-techniques.mjs output (Task 1.2)
//   'dna'    — award-grade DNA card schema (Task 1.3)

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIMENSIONS, byId } from './dimensions.mjs';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
export const FM_OPEN = '---';

// ---------------------------------------------------------------------------
// sha1 — content-derived deterministic id (no clock, no randomness)
// ---------------------------------------------------------------------------
export function sha1(s) {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// slugify — lowercased, non-alnum -> hyphen, collapsed, trimmed.
// A re-run of the same name is byte-identical; empty/non-latin falls back to
// a content-derived stable suffix (deterministic, no clock/randomness).
// ---------------------------------------------------------------------------
export function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!base) return 'technique-' + sha1(name).slice(0, 8);
  return base;
}

// ---------------------------------------------------------------------------
// categorize — heuristic keyword-based categorizer (deterministic).
// ---------------------------------------------------------------------------
export function categorize(name) {
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
// parseFrontmatter — minimal YAML: scalars + one inline array.
// ---------------------------------------------------------------------------
export function parseFrontmatter(text) {
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

// ---------------------------------------------------------------------------
// fmArray — deterministic: stable, no duplicates, sorted for byte-identical re-runs.
// ---------------------------------------------------------------------------
export function fmArray(s) {
  const uniq = Array.from(new Set(s));
  uniq.sort();
  return '[' + uniq.join(', ') + ']';
}

// ---------------------------------------------------------------------------
// buildFrontmatter — produces the YAML front matter block.
// opts.schema: 'legacy' (default) — byte-identical to original distill-techniques.mjs output.
//              'dna' — 11-key DNA schema (Task 1.3), keys in canonical order.
// ---------------------------------------------------------------------------
export function buildFrontmatter(card, { schema = 'legacy' } = {}) {
  if (schema === 'dna') {
    const { slug, name, category, intent, whenToUse, artifactFit, feasibilityTier,
            dimensions, refExample, seenOnSites, firstSeen, status, source, review } = card;
    // dimensions: numeric array sorted ascending (not quoted)
    const dimsSorted = [...(dimensions || [])].map(Number).sort((a, b) => a - b);
    const dimsYaml = '[' + dimsSorted.join(', ') + ']';
    const lines = [
      FM_OPEN,
      `slug: ${slug}`,
      `name: ${name}`,
      `category: ${category}`,
      `intent: ${intent}`,
      `whenToUse: ${whenToUse}`,
      `artifactFit: ${fmArray(artifactFit || [])}`,
      `feasibilityTier: ${feasibilityTier}`,
      `dimensions: ${dimsYaml}`,
      `refExample: ${refExample}`,
      `seenOnSites: ${fmArray(seenOnSites || [])}`,
      `firstSeen: ${firstSeen}`,
    ];
    // optional pass-throughs
    if (status !== undefined) lines.push(`status: ${status}`);
    if (source !== undefined) lines.push(`source: ${source}`);
    if (review !== undefined) lines.push(`review: ${review}`);
    lines.push(FM_OPEN);
    return lines.join('\n');
  }
  // legacy branch — byte-identical
  const { slug, name, category, seenOnSites, firstSeen } = card;
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

// ---------------------------------------------------------------------------
// newCardBody — the stub body sections for a fresh card.
// opts.schema: 'legacy' (default) — byte-identical.
//              'dna'    — DNA card sections (Task 1.3).
// ---------------------------------------------------------------------------
export function newCardBody(opts, { schema = 'legacy' } = {}) {
  if (schema === 'dna') {
    const { name, artifactFit = [], feasibilityTier = 'green', intent, approximation } = opts;
    const intentText = intent && intent !== 'TODO' ? intent : '<!-- TODO: fill in the why + immersion story -->';
    const reuseBullets = (artifactFit.length ? [...artifactFit].sort() : ['site'])
      .map((f) => `- ${f}`)
      .join('\n');
    const sections = [
      `# ${name}`,
      '',
      '## Intent',
      '',
      intentText,
      '',
      '## Mechanism',
      '',
      '<!-- TODO: describe how it works under the hood -->',
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
    sections.push('## Source', '', '<!-- TODO: add source reference -->', '');
    return sections.join('\n');
  }
  // legacy branch — byte-identical
  const { name, clone } = opts;
  return _legacyCardBody(name, clone);
}

function _legacyCardBody(name, clone) {
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

// ---------------------------------------------------------------------------
// variantNote — the "### Variant seen on <clone>" append block.
// ---------------------------------------------------------------------------
export function variantNote(clone) {
  return [
    '',
    `### Variant seen on ${clone}`,
    '',
    `- [\`clones/${clone}/_recon/effects-inventory.md\`](../../../clones/${clone}/_recon/effects-inventory.md)`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// hasVariantNote — idempotent dedup check (exact heading match, line-anchored).
// ---------------------------------------------------------------------------
export function hasVariantNote(body, clone) {
  const re = new RegExp('^### Variant seen on ' + clone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
  return re.test(body);
}

// ---------------------------------------------------------------------------
// buildIndex — deterministic index.
// opts.schema: 'legacy' (default) — TECHNIQUES.md flat table sorted by slug.
//              'dna'    — grouped-by-dimension DNA_INDEX.md (Task 1.3).
// ---------------------------------------------------------------------------
export function buildIndex(cards, { schema = 'legacy' } = {}) {
  if (schema === 'dna') {
    return _buildDnaIndex(cards);
  }
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

// DNA grouped-by-dimension index (internal helper).
function _buildDnaIndex(cards) {
  // Tier badge helpers
  const badge = (tier) => ({ green: '🟢 green', yellow: '🟡 yellow', red: '🔴 red' }[tier] || tier);

  // Build a map: dimId -> sorted cards
  const byDim = new Map();
  for (const dim of DIMENSIONS) byDim.set(dim.id, []);
  for (const c of cards) {
    const dims = Array.isArray(c.dimensions) ? c.dimensions.map(Number) : [];
    for (const d of dims) {
      if (byDim.has(d)) byDim.get(d).push(c);
    }
  }
  // Sort each bucket by slug
  for (const bucket of byDim.values()) bucket.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const lines = ['# DNA Card Index — by dimension', ''];
  for (const dim of DIMENSIONS) {
    const bucket = byDim.get(dim.id);
    if (!bucket.length) continue;
    lines.push(`## ${dim.id}. ${dim.key}`, '');
    for (const c of bucket) {
      lines.push(`- [${c.name}](cards/${c.slug}.md) — ${badge(c.feasibilityTier)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// readAllCards — read every card in <cardsDir> to rebuild the index from disk.
// opts.schema: 'legacy' (default) — byte-identical.
// ---------------------------------------------------------------------------
export async function readAllCards(cardsDir, { schema = 'legacy' } = {}) {
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
    // Common fields shared by both schemas
    const slug = fm.slug || f.replace(/\.md$/, '');
    const name = fm.name || f.replace(/\.md$/, '');
    const category = fm.category || 'effect';
    const seenOnSites = Array.isArray(fm.seenOnSites) ? fm.seenOnSites : (fm.seenOnSites ? [fm.seenOnSites] : []);
    const firstSeen = fm.firstSeen || '';

    if (schema === 'dna') {
      // Normalize arrays: parseFrontmatter returns string elements for numeric arrays
      const artifactFit = Array.isArray(fm.artifactFit) ? fm.artifactFit : (fm.artifactFit ? [fm.artifactFit] : []);
      const dimensions = Array.isArray(fm.dimensions) ? fm.dimensions.map(Number) : [];
      out.push({
        slug,
        name,
        category,
        intent: fm.intent || '',
        whenToUse: fm.whenToUse || '',
        artifactFit,
        feasibilityTier: fm.feasibilityTier || 'green',
        dimensions,
        refExample: fm.refExample || '',
        seenOnSites,
        firstSeen,
        status: fm.status || '',
        source: fm.source || '',
      });
    } else {
      // legacy branch — byte-identical (5 fields only)
      out.push({ slug, name, category, seenOnSites, firstSeen });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// validateCard — dna schema validator. Returns { ok, errors }.
// ---------------------------------------------------------------------------
const VALID_TIERS = new Set(['green', 'yellow', 'red']);
const VALID_ARTIFACT_FIT = new Set(['site', 'landing', 'dashboard', 'deck', 'pdf']);
const TODO_RE = /^\s*TODO\s*$/i;

export function validateCard(fm, body) {
  const errors = [];

  // intent: required, non-empty, not a TODO placeholder
  if (!fm.intent || !String(fm.intent).trim() || TODO_RE.test(String(fm.intent).trim())) {
    errors.push('intent is missing or still a TODO placeholder');
  }

  // dimensions: non-empty, all in 1..10
  const dims = Array.isArray(fm.dimensions) ? fm.dimensions.map(Number) : [];
  if (dims.length === 0) {
    errors.push('dimensions is empty');
  } else if (dims.some((d) => d < 1 || d > 10 || !Number.isInteger(d))) {
    errors.push('dimensions contains values outside 1..10');
  }

  // feasibilityTier
  if (!VALID_TIERS.has(fm.feasibilityTier)) {
    errors.push(`feasibilityTier must be green|yellow|red, got: ${fm.feasibilityTier}`);
  }

  // artifactFit: non-empty, all valid values
  const fit = Array.isArray(fm.artifactFit) ? fm.artifactFit : [];
  if (fit.length === 0) {
    errors.push('artifactFit is empty');
  } else if (fit.some((v) => !VALID_ARTIFACT_FIT.has(v))) {
    errors.push(`artifactFit contains invalid values (allowed: ${[...VALID_ARTIFACT_FIT].join(', ')})`);
  }

  // ## Code section present and fenced block non-empty
  const codeMatch = body.match(/^## Code\s*\n[\s\S]*?```[a-z]*\n([\s\S]*?)```/m);
  if (!codeMatch) {
    errors.push('## Code section is missing or has no fenced block');
  } else if (!codeMatch[1].trim()) {
    errors.push('## Code fenced block is empty');
  }

  // status === 'stub'
  if (fm.status === 'stub') {
    errors.push('status is stub — card not ready');
  }

  // red tier requires ## Approximation section
  if (fm.feasibilityTier === 'red' && !/^## Approximation\b/m.test(body)) {
    errors.push('feasibilityTier is red but ## Approximation section is missing');
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// flagSuspectCode — IP/verbatim guard on the ## Code fenced block.
// Returns a reason string if suspect, null if clean.
// ---------------------------------------------------------------------------
const STUDIO_DENY = /lusion|activetheory|resn|locomotive|__webpack|_next\/static/i;
// Clean-room technique demos are legitimately detailed (CSS-in-JS string arrays, rAF loops) — 40-110 lines
// is normal. The real verbatim tells are a minified no-space line + studio identifiers (below); line count
// only catches a pathological full-bundle dump, so the threshold is high to avoid false-positives.
const MAX_CODE_LINES = 220;
const MAX_LINE_CHARS = 200;

export function flagSuspectCode(body) {
  // Extract content of first fenced block inside ## Code
  const m = body.match(/^## Code\s*\n[\s\S]*?```[a-z]*\n([\s\S]*?)```/m);
  if (!m) return null; // no code block — not our concern here
  const code = m[1];
  const codeLines = code.split('\n');

  if (codeLines.length > MAX_CODE_LINES) {
    return `code block has ${codeLines.length} lines (>${MAX_CODE_LINES}) — potential verbatim copy`;
  }
  for (const line of codeLines) {
    if (line.length > MAX_LINE_CHARS && !/\s/.test(line)) {
      return `code block has a ${line.length}-char line with no spaces — likely minified`;
    }
  }
  if (STUDIO_DENY.test(code)) {
    return `code block contains a studio-identifier (denylist match)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildDnaJson — serialise cards to dna.json (schema v1).
// Deterministic: cards sorted by slug, arrays sorted+deduped, no clock.
// ---------------------------------------------------------------------------
export function buildDnaJson(cards) {
  const sortArr = (a) => [...new Set(a)].sort();
  const sorted = [...cards].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const out = {
    schema: 1,
    generated: '',
    cards: sorted.map((c) => ({
      slug: c.slug,
      name: c.name,
      category: c.category,
      intent: c.intent,
      whenToUse: c.whenToUse,
      artifactFit: sortArr(c.artifactFit || []),
      feasibilityTier: c.feasibilityTier,
      dimensions: [...new Set((c.dimensions || []).map(Number))].sort((a, b) => a - b),
      refExample: c.refExample,
      seenOnSites: sortArr(c.seenOnSites || []),
      firstSeen: c.firstSeen,
      path: `cards/${c.slug}.md`,
    })),
  };
  return JSON.stringify(out, null, 2) + '\n';
}
