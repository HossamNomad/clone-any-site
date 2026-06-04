#!/usr/bin/env node
// clone-verify.mjs — animation-preservation VERIFY gate for clone-any-site.
//
// After assets are swapped, PROVE on a FILE (not stdout) that:
//   1. the clone's animations SURVIVED the swap (census vs PRISTINE baseline),
//   2. the opening intro still MOVES (a frozen page is the failure mode),
//   3. the swap actually TOOK (media now points at /__swap/...),
//   4. zero page/console errors.
//
// Decide PASS/FAIL on the report file + a sentinel (.PASS / .FAIL).
// Deterministic: no Date.now / Math.random. opts.now carries any timestamp.
// Always kills the spawned serve child. Robust: a flaky capture writes a FAIL
// report rather than throwing.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { runCensus } from './lib/anim-census.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// PURE: evaluateCensus — the only thing the unit tests exercise.
// ---------------------------------------------------------------------------

/**
 * Compare a PRISTINE baseline census against the post-swap (after) census.
 * For each axis in [cssAnim, waapi, videos, canvas]:
 *   before === 0 -> ok = true                       (nothing to preserve)
 *   before  >  0 -> ok = (after >= floor(before*floor)) && after > 0
 * overall ok = every axis ok.
 *
 * @param {object} baseline  pristine census ({cssAnim,waapi,videos,canvas,...})
 * @param {object} after     post-swap census
 * @param {number} [floor=0.95]  fraction of baseline that must survive
 * @returns {{axes:Array<{axis:string,before:number,after:number,ok:boolean}>,ok:boolean}}
 */
export function evaluateCensus(baseline, after, floor = 0.95) {
  const b = baseline || {};
  const a = after || {};
  const AXES = ['cssAnim', 'waapi', 'videos', 'canvas'];
  const axes = AXES.map((axis) => {
    const before = Number(b[axis] || 0);
    const now = Number(a[axis] || 0);
    let ok;
    if (before === 0) {
      ok = true;
    } else {
      ok = now >= Math.floor(before * floor) && now > 0;
    }
    return { axis, before, after: now, ok };
  });
  return { axes, ok: axes.every((x) => x.ok) };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const loadJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

// Auto-detect the single mirror subdir (like clone-map): <clone>/mirror/<one>/
function detectMirror(cloneDir) {
  const mDir = join(cloneDir, 'mirror');
  if (!existsSync(mDir)) return null;
  const subs = readdirSync(mDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (subs.length === 1) return join(mDir, subs[0]);
  // multiple subdirs (e.g. "_vendor" + the host): prefer the host-looking one
  // (has a dot, no leading underscore) — matches clone-map's detection.
  const hostish = subs.filter((n) => n.includes('.') && !n.startsWith('_'));
  if (hostish.length === 1) return join(mDir, hostish[0]);
  return mDir; // truly ambiguous
}

// Entry = pathname from MAP.json meta.url, else /index.html.
function entryToFile(p) {
  // a directory-style path ('/fr/' or '/fr') must point at its index.html to be served
  if (!p || p === '/') return '/index.html';
  if (p.endsWith('/')) return p + 'index.html';
  if (!/\.[a-z0-9]+$/i.test(p)) return p.replace(/\/?$/, '/') + 'index.html';
  return p;
}
function detectEntry(cloneDir) {
  const map = loadJson(join(cloneDir, 'repurpose', 'MAP.json'));
  const u = map && map.meta && map.meta.url;
  if (u) {
    try {
      const p = new URL(u).pathname;
      if (p && p !== '/') return entryToFile(p);
    } catch { /* not a URL */ }
  }
  return '/index.html';
}

// Decode a PNG buffer -> {width,height,data} (RGBA). Throws on bad data.
function decodePng(buf) {
  return PNG.sync.read(buf);
}

// Adjacent-frame diff ratio via pixelmatch. Only compares equal-dim frames.
function frameDiffRatio(aPng, bPng) {
  if (aPng.width !== bPng.width || aPng.height !== bPng.height) return null;
  const { width, height } = aPng;
  const diff = new PNG({ width, height });
  const changed = pixelmatch(aPng.data, bPng.data, diff.data, width, height, { threshold: 0.1 });
  const total = width * height;
  return total > 0 ? changed / total : 0;
}

// Spawn serve-repurpose child, resolve { proc, port, base }.
function spawnServe(cloneDir, mirror, entry) {
  return new Promise((resolveP, rejectP) => {
    const serveScript = join(__dirname, 'serve-repurpose.mjs');
    const proc = spawn(
      process.execPath,
      [serveScript, '--clone', cloneDir, '--mirror', mirror, '--entry', entry],
      { env: { ...process.env, CLONE_SERVE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let buf = '';
    let settled = false;
    const onErr = (e) => { if (!settled) { settled = true; rejectP(e); } };
    proc.on('error', onErr);
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { proc.kill(); } catch {} rejectP(new Error('serve-repurpose did not report CLONE_PORT in time')); }
    }, 20000);
    proc.stdout.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/CLONE_PORT=(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        const port = Number(m[1]);
        resolveP({ proc, port, base: `http://127.0.0.1:${port}/` });
      }
    });
    proc.stderr.on('data', () => { /* swallow; surfaced via reject on close if needed */ });
    proc.on('close', () => {
      if (!settled) { settled = true; clearTimeout(timer); rejectP(new Error('serve-repurpose exited before reporting CLONE_PORT')); }
    });
  });
}

function killProc(proc) {
  if (!proc) return;
  try { proc.kill('SIGTERM'); } catch {}
  try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
}

// Capture a top-of-page intro strip into <dir>: N frames every stepMs (no scroll).
// Returns { frames, differingPairs, introMoves } computed via pixelmatch.
async function captureIntroStrip(page, dir, prefix, { frames = 33, stepMs = 150, threshold = 0.002 } = {}) {
  mkdirSync(dir, { recursive: true });
  // ensure top-of-page; do NOT scroll during the strip (intro lives at top).
  try { await page.evaluate(() => scrollTo(0, 0)); } catch {}
  const pngs = [];
  for (let i = 0; i < frames; i++) {
    const fp = join(dir, `${prefix}-${String(i).padStart(3, '0')}.png`);
    const shot = await page.screenshot({ path: fp, fullPage: false });
    try { pngs.push(decodePng(shot)); } catch { pngs.push(null); }
    if (i < frames - 1) await page.waitForTimeout(stepMs);
  }
  let differingPairs = 0;
  for (let i = 1; i < pngs.length; i++) {
    const a = pngs[i - 1], b = pngs[i];
    if (!a || !b) continue;
    const ratio = frameDiffRatio(a, b);
    if (ratio != null && ratio > threshold) differingPairs++;
  }
  return { frames: pngs.length, differingPairs, introMoves: differingPairs >= 3 };
}

// In-page counters: media now pointing at /__swap/, run AFTER the DOM-swap fired.
const countSwapped = () => {
  const isSwap = (el) => /\/__swap\//.test(el.currentSrc || el.src || '');
  const imgs = [...document.querySelectorAll('img')];
  const vids = [...document.querySelectorAll('video')];
  return {
    swappedImgs: imgs.filter(isSwap).length,
    swappedVids: vids.filter(isSwap).length,
  };
};

// ---------------------------------------------------------------------------
// verify — the orchestrator. Writes the report + sentinel, always kills child.
// ---------------------------------------------------------------------------

/**
 * @param {string} cloneDir absolute path to the clone dir
 * @param {object} [opts] { mirror, entry, out, original, now, floor }
 * @returns {Promise<object>} the report object
 */
export async function verify(cloneDir, opts = {}) {
  const floor = opts.floor != null ? opts.floor : 0.95;
  const out = opts.out || join(cloneDir, '_verify');
  mkdirSync(out, { recursive: true });

  // ---- 1. baseline + swaps (fail clearly if baseline missing) ----
  const lockPath = join(cloneDir, 'repurpose', 'ANIM-LOCK.json');
  if (!existsSync(lockPath)) {
    throw new Error(`ANIM-LOCK.json not found at ${lockPath} — run clone-map first to capture the animation baseline`);
  }
  const lock = loadJson(lockPath) || {};
  const baseline = lock.baseline || {};

  const swaps = loadJson(join(cloneDir, 'swaps', 'swaps.json')) || {};
  let mediaSwapCount = 0;
  for (const k of Object.keys(swaps)) {
    const t = swaps[k] && swaps[k].type;
    if (t === 'image' || t === 'video') mediaSwapCount++;
  }

  const mirror = opts.mirror || detectMirror(cloneDir);
  let entry = opts.entry ? entryToFile(opts.entry) : detectEntry(cloneDir);
  // self-heal: a shell (Git-Bash/MSYS) can mangle a leading-slash --entry into e.g.
  // "C:/Program Files/Git/fr/index.html". If it isn't a real file under the mirror,
  // fall back to the MAP-derived entry (no shell involved).
  if (!existsSync(join(mirror, entry))) {
    const auto = detectEntry(cloneDir);
    if (existsSync(join(mirror, auto))) entry = auto;
  }

  // Pre-seed a FAIL report so a crash before the verdict still leaves evidence.
  const baseReport = {
    cloneDir, mirror, entry,
    baseline, after: null,
    censusEval: null,
    counts: { swappedImgs: 0, swappedVids: 0, mediaSwapCount },
    intro: { frames: 0, differingPairs: 0, introMoves: false },
    errors: [],
    verdict: { animationsPreserved: false, introMoves: false, swapsApplied: false, zeroErrors: false },
    PASS: false,
    generatedAtRef: opts.now || '',
  };
  writeReport(out, baseReport);

  let proc = null;
  let browser = null;
  const report = { ...baseReport };
  try {
    if (!mirror) throw new Error(`no mirror dir found under ${join(cloneDir, 'mirror')} — pass --mirror`);

    // ---- 2. serve swapped state ----
    const served = await spawnServe(cloneDir, mirror, entry);
    proc = served.proc;
    const base = served.base;

    // ---- 3. AFTER census ----
    const after = await runCensus(base);
    report.after = after;
    report.censusEval = evaluateCensus(baseline, after, floor);

    // ---- 4. swap counts + errors (fresh page, wait for DOM-swap ~5.2s) ----
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    const errors = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + String(m.text()).slice(0, 200)); });

    await page.goto(base, { waitUntil: 'load', timeout: 60000 });

    // ---- 5. INTRO-MOTION strip FIRST (top-of-page, no scroll) ----
    // Capture immediately after load so the opening intro is in-frame.
    const intro = await captureIntroStrip(page, join(out, 'INTRO'), 'after');
    report.intro = intro;

    // give the DOM-swap time to fire (≈5.2s), then scroll to fire reveals/lazy,
    // then count swapped media. (Strip already consumed ~4.8s.)
    await page.waitForTimeout(7000);
    const h = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y <= h; y += 1000) { await page.evaluate((yy) => scrollTo(0, yy), y); await page.waitForTimeout(80); }
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(800);

    const counts = await page.evaluate(countSwapped);
    report.counts = { ...counts, mediaSwapCount };
    report.errors = errors.slice(0, 20);

    await ctx.close();

    // ---- 7. optional honest comparison against the live original ----
    if (opts.original) {
      try {
        const oCensus = await runCensus(opts.original);
        const oCtx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
        const oPage = await oCtx.newPage();
        await oPage.goto(opts.original, { waitUntil: 'load', timeout: 60000 });
        const oIntro = await captureIntroStrip(oPage, join(out, 'ORIGINAL'), 'orig');
        await oCtx.close();
        report.original = {
          census: oCensus,
          introMoves: oIntro.introMoves,
          note: 'accepted deltas: paid-font substitution, network variance',
        };
      } catch (e) {
        report.original = { error: String(e).slice(0, 200), note: 'original comparison failed (network) — not fatal' };
      }
    }

    // ---- 6. verdict ----
    report.verdict = {
      animationsPreserved: report.censusEval.ok,
      introMoves: intro.introMoves,
      swapsApplied: (counts.swappedImgs + counts.swappedVids) >= Math.max(1, mediaSwapCount),
      zeroErrors: errors.length === 0,
    };
    report.PASS = report.verdict.animationsPreserved && report.verdict.introMoves &&
                  report.verdict.swapsApplied && report.verdict.zeroErrors;
  } catch (e) {
    report.errors = [...(report.errors || []), 'verify: ' + String(e && e.message ? e.message : e).slice(0, 300)];
    report.PASS = false;
    // verdict keeps the safe all-false default unless partially filled above.
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    killProc(proc);
  }

  // ---- 8. write report + sentinel ----
  writeReport(out, report);
  const passPath = join(out, '.PASS');
  const failPath = join(out, '.FAIL');
  if (report.PASS) {
    writeFileSync(passPath, '');
    if (existsSync(failPath)) rmSync(failPath);
  } else {
    writeFileSync(failPath, '');
    if (existsSync(passPath)) rmSync(passPath);
  }

  // ---- 9. one-line verdict + report path ----
  const reportPath = join(out, 'verify-report.json');
  console.log(`${report.PASS ? 'PASS' : 'FAIL'} — ${reportPath}`);
  return report;
}

function writeReport(out, report) {
  writeFileSync(join(out, 'verify-report.json'), JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function resolveCloneDir(arg) {
  if (!arg) return null;
  if (isAbsolute(arg) || arg.includes('/') || arg.includes('\\')) return resolve(arg);
  // bare name -> <repoRoot>/clones/<name>, repoRoot = 4 dirs up from scripts/ (hossam2)
  const repoRoot = resolve(__dirname, '..', '..', '..', '..');
  return join(repoRoot, 'clones', arg);
}

async function main() {
  const A = Object.fromEntries(
    process.argv.slice(2).reduce((a, v, i, arr) => { if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]); return a; }, [])
  );
  const cloneDir = resolveCloneDir(A.clone);
  if (!cloneDir) {
    console.error('usage: node clone-verify.mjs --clone <dir|name> [--mirror <dir>] [--entry </path>] [--out <dir>] [--original <liveURL>]');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await verify(cloneDir, {
      mirror: A.mirror,
      entry: A.entry,
      out: A.out,
      original: A.original,
      now: A.now || new Date().toISOString(),
    });
    process.exitCode = report.PASS ? 0 : 1;
  } catch (e) {
    console.error('FAIL — ' + String(e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

// Run CLI only when invoked directly — importing must NOT spawn anything.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
