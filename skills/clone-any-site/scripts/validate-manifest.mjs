// validate-manifest.mjs — mandatory dry-run before any swap is written. ZERO deps.
// Checks: schema-required fields, unique numbers + stableIds, enum membership, slot-spec sanity,
// breakpointScope/slotSpec viewports are declared, replacement type matches slot type, and no orphan
// replacement.assetRef (file must exist under the repurpose dir). Exit 0 = valid, 1 = errors (or warnings with --strict).
//
//   node validate-manifest.mjs --manifest <path> [--strict]
//
// Never reads wall-clock time / randomness.

import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function args(argv) { const o = {}; for (let i = 2; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) o[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; } return o; }
const A = args(process.argv);
if (!A.manifest) { console.error('validate-manifest: missing --manifest'); process.exit(1); }

const HERE = dirname(fileURLToPath(import.meta.url));
const exists = (p) => access(p).then(() => true).catch(() => false);

const errors = [], warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const TYPE = new Set(['text', 'img', 'bg', 'svg', 'video', 'icon', 'section']);
const ROLE = new Set(['content', 'chrome']);
const PROV = new Set(['original', 'user', 'substitute', 'ai']);
const FLAGS = new Set(['data-driven:not-mirrored', 'text-as-image:review', 'cross-origin:not-mirrored', 'paid-font', 'analytics-id', 'verification-id', 'form-action', 'consent-vendor', 'embed:cross-origin', 'advanced:css-background', 'advanced:pseudo-content', 'grouped', 'volatile-anchor:review']);
const isAdvanced = (s) => (s.flags || []).some((f) => String(f).startsWith('advanced:'));

async function main() {
  let manifest;
  try { manifest = JSON.parse(await readFile(A.manifest, 'utf8')); }
  catch (e) { console.error('validate-manifest: cannot parse manifest:', e.message); process.exit(1); }

  const dir = dirname(A.manifest);
  const meta = manifest.meta || {};
  if (!meta.target) err('meta.target missing');
  if (!meta.name) err('meta.name missing');
  if (!meta.buildFingerprint) warn('meta.buildFingerprint missing (drift guard disabled)');
  if (!['1.0', '1.1'].includes(meta.schemaVersion)) warn('meta.schemaVersion not 1.0/1.1 (got ' + meta.schemaVersion + ')');
  const viewports = Array.isArray(meta.viewports) ? meta.viewports.map(String) : [];
  if (!viewports.length) err('meta.viewports missing/empty');
  if (!['unset', 'authorized', 'unauthorized'].includes(meta.structureAuthorization)) err('meta.structureAuthorization invalid: ' + meta.structureAuthorization);

  if (!Array.isArray(manifest.slots)) { err('slots[] missing'); return finish(); }

  const numbers = new Set(), ids = new Set();
  let blocking = 0;
  for (const s of manifest.slots) {
    const tag = '#' + (s.number != null ? s.number : '?');
    if (s.number == null || !Number.isInteger(s.number)) err(tag + ' number not an integer');
    else if (numbers.has(s.number)) err(tag + ' duplicate number'); else numbers.add(s.number);
    if (!s.stableId) err(tag + ' stableId missing'); else if (ids.has(s.stableId)) err(tag + ' duplicate stableId ' + s.stableId); else ids.add(s.stableId);
    if (!TYPE.has(s.type)) err(tag + ' bad type: ' + s.type);
    if (!ROLE.has(s.role)) err(tag + ' bad role: ' + s.role);
    if (!PROV.has(s.provenance)) err(tag + ' bad provenance: ' + s.provenance);
    if (!s.mirrorLocator || !s.mirrorLocator.cssPath) err(tag + ' mirrorLocator.cssPath missing');
    (s.flags || []).forEach((f) => { if (!FLAGS.has(f)) warn(tag + ' unknown flag: ' + f); });

    // slotSpec / breakpointScope viewports must be declared
    for (const v of Object.keys(s.slotSpec || {})) if (!viewports.includes(String(v))) warn(tag + ' slotSpec viewport ' + v + ' not in meta.viewports');
    for (const v of Object.keys(s.breakpointScope || {})) if (!viewports.includes(String(v))) warn(tag + ' breakpointScope viewport ' + v + ' not in meta.viewports');
    for (const [v, sp] of Object.entries(s.slotSpec || {})) {
      if (sp.w != null && (!Number.isFinite(sp.w) || sp.w <= 0)) err(tag + ' slotSpec[' + v + '].w invalid');
      if (sp.fit && !['cover', 'contain', 'fill'].includes(sp.fit)) err(tag + ' slotSpec[' + v + '].fit invalid: ' + sp.fit);
      if (sp.focal && (!Array.isArray(sp.focal) || sp.focal.length !== 2)) err(tag + ' slotSpec[' + v + '].focal invalid');
    }

    // replacement sanity
    if (s.replacement) {
      const r = s.replacement;
      if (s.type === 'text' && r.kind !== 'text') err(tag + ' replacement.kind must be "text" for a text slot');
      if (s.type !== 'text' && r.kind === 'text') err(tag + ' replacement.kind "text" on non-text slot ' + s.type);
      if (r.kind === 'asset') {
        if (!r.assetRef) err(tag + ' replacement.assetRef missing');
        else { const p = join(dir, r.assetRef); if (!(await exists(p))) err(tag + ' orphan replacement.assetRef (file not found): ' + r.assetRef); }
      }
      if (r.kind === 'text' && r.value == null) err(tag + ' replacement.value missing');
    }
    // keep + replacement is contradictory
    if (s.keep && s.replacement) warn(tag + ' both keep and replacement set (replacement wins)');

    if (s.provenance === 'original' && !s.keep && !s.replacement && s.role === 'content' && !isAdvanced(s)) blocking++;
  }

  // counts cross-check
  if (meta.counts && meta.counts.blocking != null && meta.counts.blocking !== blocking) {
    warn('meta.counts.blocking (' + meta.counts.blocking + ') != recomputed (' + blocking + ')');
  }

  finish();
}

function finish() {
  const strict = !!A.strict;
  const fail = errors.length > 0 || (strict && warnings.length > 0);
  console.log('validate-manifest:', fail ? 'INVALID' : 'OK', '|', errors.length, 'errors,', warnings.length, 'warnings');
  errors.forEach((e) => console.log('  ✗ ' + e));
  warnings.forEach((w) => console.log('  ! ' + w));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('validate-manifest FATAL', e); process.exit(2); });
