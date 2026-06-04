#!/usr/bin/env node
// clone-swap.mjs — folder-drop asset-swap one-shot.
//
// A user drops a replacement file named after a slot tag (e.g. VID-04.mp4, IMG-7.jpg)
// into <clone>/swaps/. This scans that folder, compresses each dropped asset, and
// registers it in <clone>/swaps/swaps.json so serve-repurpose.mjs serves the new bytes
// at /__swap/<ID> — WITHOUT touching animations.
//
// Convention (mirrors the existing eiger swaps/.generated layout):
//   - compressed output:  swaps/.generated/<ID>.<ext>   (e.g. .generated/IMG-1.webp)
//   - kept raw original:   swaps/.generated/<ID>-raw.<ext>
//   - swaps.json[ID].file is a path RELATIVE to swaps/  (serve resolves join(CLONE,'swaps',file))
//
// Deterministic (no Date.now/Math.random; opts.now stamps the report).
// Idempotent: re-running after the raw was moved is a safe no-op.
// Robust: per-file try/catch so one bad asset never aborts the batch.

import { readFile, writeFile, mkdir, readdir, stat, rename, copyFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeDrop, validateAgainstMap } from './lib/drop-router.mjs';
import { encodeImage, encodeVideo } from './lib/encode-recipes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── helpers ───────────────────────────────────────────────────────────────

async function readJson(p, dflt) {
  if (!existsSync(p)) return dflt;
  return JSON.parse(await readFile(p, 'utf8'));
}

// Move a file; fall back to copy+unlink across devices (EXDEV).
async function moveFile(src, dst) {
  try {
    await rename(src, dst);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      await copyFile(src, dst);
      await unlink(src);
    } else {
      throw e;
    }
  }
}

// Should this top-level swaps/ entry be ignored entirely?
function isIgnoredName(name) {
  if (name.startsWith('.') || name.startsWith('_')) return true;       // .generated, _anything, dotfiles
  if (name === 'swaps.json' || name === 'COMPRESSION-REPORT.json') return true;
  if (name.toLowerCase().endsWith('.md')) return true;
  if (name.endsWith('~')) return true;                                 // editor backups
  if (name.endsWith('.tmp')) return true;
  if (name.endsWith('.crdownload')) return true;                       // partial downloads
  if (name.startsWith('~$')) return true;                              // office lock files
  return false;
}

// ── core ──────────────────────────────────────────────────────────────────

/**
 * Process every dropped replacement asset in <cloneDir>/swaps/.
 * @param {string} cloneDir absolute (or already-resolved) clone directory
 * @param {{now?:string}} opts now = report stamp (deterministic)
 * @returns {Promise<{processed:Array, warnings:Array, swapsPath:string}>}
 */
export async function processDrops(cloneDir, opts = {}) {
  const swapsDir = join(cloneDir, 'swaps');
  const genDir = join(swapsDir, '.generated');
  const mapPath = join(cloneDir, 'repurpose', 'MAP.json');
  const swapsPath = join(swapsDir, 'swaps.json');

  const map = await readJson(mapPath, null);
  if (!map) {
    throw new Error(`MAP.json not found at ${mapPath} — is "${cloneDir}" a clone dir? (expected <clone>/repurpose/MAP.json)`);
  }
  const mapSlots = Array.isArray(map.slots) ? map.slots : [];

  // swaps.json may not exist yet → default {}. PRESERVE existing entries.
  const swaps = await readJson(swapsPath, {});

  await mkdir(genDir, { recursive: true });

  const processed = [];
  const warnings = [];

  // Scan top-level entries only (NOT recursing into .generated/).
  let entries = [];
  if (existsSync(swapsDir)) {
    entries = await readdir(swapsDir, { withFileTypes: true });
  }
  // Stable order = deterministic report.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const ent of entries) {
    const name = ent.name;
    if (isIgnoredName(name)) continue;
    if (ent.isDirectory()) continue; // skips .generated/ and any stray dirs

    const dropPath = join(swapsDir, name);

    try {
      const route = routeDrop(name);
      if (!route.ok) {
        warnings.push({ file: name, reason: route.error });
        continue;
      }

      const check = validateAgainstMap(route, mapSlots);
      if (!check.ok) {
        warnings.push({ file: name, reason: check.error });
        continue;
      }

      const id = route.id;
      const srcBytes = (await stat(dropPath)).size;
      const rawDst = join(genDir, `${id}-raw.${route.ext}`);

      if (route.type === 'image') {
        const outRel = join('.generated', `${id}.webp`);
        const outAbs = join(swapsDir, outRel);
        const r = await encodeImage(dropPath, outAbs, { maxWidth: 2048, quality: 80 });
        await moveFile(dropPath, rawDst);
        swaps[id] = { type: 'image', file: relPosix(outRel) };
        processed.push({
          tag: id, type: 'image', srcBytes, outBytes: r.bytes,
          ratio: srcBytes ? r.bytes / srcBytes : 0,
          width: r.width, height: r.height, animated: r.animated,
        });
      } else if (route.type === 'video') {
        const outRel = join('.generated', `${id}.mp4`);
        const posterRel = join('.generated', `${id}.poster.webp`);
        const outAbs = join(swapsDir, outRel);
        const posterAbs = join(swapsDir, posterRel);
        const r = await encodeVideo(dropPath, outAbs, posterAbs, { maxWidth: 1920, crf: 21 });
        await moveFile(dropPath, rawDst);
        swaps[id] = { type: 'video', file: relPosix(outRel), poster: relPosix(posterRel) };
        const rec = {
          tag: id, type: 'video', srcBytes, outBytes: r.bytes,
          ratio: srcBytes ? r.bytes / srcBytes : 0,
          durIn: r.durIn, durOut: r.durOut, fpsIn: r.fpsIn, fpsOut: r.fpsOut, syncOk: r.syncOk,
        };
        processed.push(rec);
        if (r.syncOk === false) {
          warnings.push({ file: name, reason: 'timing drift — animation may desync; match the original duration/fps' });
        }
      } else if (route.type === 'sequence') {
        warnings.push({ file: name, reason: 'sequence swap is advanced — not handled by clone-swap v1; see MANUAL' });
        continue;
      } else {
        warnings.push({ file: name, reason: `unsupported slot type "${route.type}"` });
        continue;
      }
    } catch (e) {
      warnings.push({ file: name, reason: `processing failed: ${e && e.message ? e.message : String(e)}` });
    }
  }

  // Always (re)write swaps.json pretty, preserving untouched entries.
  await writeFile(swapsPath, JSON.stringify(swaps, null, 2) + '\n', 'utf8');

  // Write compression report.
  const totals = processed.reduce(
    (acc, p) => ({ srcBytes: acc.srcBytes + (p.srcBytes || 0), outBytes: acc.outBytes + (p.outBytes || 0) }),
    { srcBytes: 0, outBytes: 0 },
  );
  const report = {
    generatedAtRef: opts.now || '',
    processed,
    warnings,
    totals,
  };
  await writeFile(join(swapsDir, 'COMPRESSION-REPORT.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  return { processed, warnings, swapsPath };
}

// swaps.json paths are served via join() so OS sep works, but keep them POSIX
// for portability/readability (matches the eiger ".generated/IMG-1.webp" convention).
function relPosix(p) {
  return p.split(sep).join('/');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function kb(bytes) {
  return Math.round(bytes / 1024) + 'KB';
}

function printSummary({ processed, warnings }) {
  for (const p of processed) {
    const pct = p.srcBytes ? Math.round((1 - p.outBytes / p.srcBytes) * 100) : 0;
    const sign = pct >= 0 ? '-' : '+';
    let line = `✓ ${p.tag} ${kb(p.srcBytes)}→${kb(p.outBytes)} (${sign}${Math.abs(pct)}%)`;
    if (p.type === 'video' && p.syncOk === false) line += '  [timing drift]';
    console.log(line);
  }
  for (const w of warnings) {
    // a video timing-drift warning is also a successful process; show it once here
    console.log(`⚠ ${w.file} — ${w.reason}`);
  }
  if (!processed.length && !warnings.length) {
    console.log('(nothing to do — no dropped assets in swaps/)');
  }
}

// Resolve a --clone argument to an absolute clone dir.
// Bare name (no path separator) → <repoRoot>/clones/<name>; repoRoot = 4 levels up
// from this script dir (scripts → clone-any-site → skills → .claude → hossam2).
function resolveCloneArg(arg) {
  if (!arg) return null;
  const hasSep = arg.includes('/') || arg.includes('\\') || isAbsolute(arg);
  if (hasSep) return arg; // absolute or relative path that already points at a clone dir
  const repoRoot = join(__dirname, '..', '..', '..', '..');
  return join(repoRoot, 'clones', arg);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    }
  }
  const cloneArg = flags.clone;
  if (!cloneArg || cloneArg === true) {
    console.error('usage: node clone-swap.mjs --clone <dir|name> [--now <stamp>]');
    process.exitCode = 2;
    return;
  }
  const cloneDir = resolveCloneArg(cloneArg);
  try {
    const res = await processDrops(cloneDir, { now: typeof flags.now === 'string' ? flags.now : '' });
    printSummary(res);
    console.log(`→ ${res.swapsPath}`);
  } catch (e) {
    console.error('clone-swap failed: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  }
}

// run as CLI only when invoked directly (not when imported by tests)
const invokedDirect = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();
if (invokedDirect) main();
