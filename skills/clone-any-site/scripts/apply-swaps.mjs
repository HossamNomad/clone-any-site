// apply-swaps.mjs — idempotent two-target writer for the Repurpose Layer.
// Reads the numbered manifest and materialises (a) the mirror-preview swap layer (zero-dep) and
// (b) the publishable build (DOM-derivative via Playwright, or a clean-room scaffold). Refuses on a
// build-fingerprint drift and runs validate-manifest first. Never mutates the gitignored mirror payload.
//
//   node apply-swaps.mjs --manifest <path> --mirror <mirrorRoot> [--mirror-url <url>] \
//        [--target preview|build|both] [--build-mode dom-derivative|clean-room] [--now <iso>]
//
// Never reads wall-clock time / randomness (stamp via --now).

import { readFile, writeFile, mkdir, readdir, stat, cp, copyFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function args(argv) { const o = {}; for (let i = 2; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) o[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; } return o; }
const A = args(process.argv);
for (const k of ['manifest', 'mirror']) if (!A[k]) { console.error(`apply-swaps: missing --${k}`); process.exit(1); }
const TARGET = A.target || 'both';
const NOW = A.now || '';
const HERE = dirname(fileURLToPath(import.meta.url));
const exists = (p) => stat(p).then(() => true).catch(() => false);

async function main() {
  const manifest = JSON.parse(await readFile(A.manifest, 'utf8'));
  const dir = dirname(A.manifest);

  // 1. drift guard
  const fpPath = join(dir, 'build-fingerprint.json');
  if (await exists(fpPath)) {
    const fp = JSON.parse(await readFile(fpPath, 'utf8'));
    const expect = fp.buildFingerprint || ((fp.buildId || '') + '+' + (fp.crawlLogHash || ''));
    if (manifest.meta.buildFingerprint && expect && manifest.meta.buildFingerprint !== expect) {
      console.error(`apply-swaps: BUILD FINGERPRINT DRIFT — manifest "${manifest.meta.buildFingerprint}" != mirror "${expect}". Re-run extract-manifest against the fresh mirror.`);
      process.exit(1);
    }
  }

  // 2. validate first
  const v = spawnSync(process.execPath, [join(HERE, 'validate-manifest.mjs'), '--manifest', A.manifest], { stdio: 'inherit' });
  if (v.status !== 0) { console.error('apply-swaps: validate-manifest failed — refusing to write.'); process.exit(1); }

  const swaps = manifest.slots
    .filter((s) => s.replacement || s.keep)
    .map((s) => ({ number: s.number, type: s.type, op: s.replacement ? (s.replacement.kind === 'text' ? 'replace-text' : 'replace-asset') : 'keep', value: s.replacement && s.replacement.value, assetRef: s.replacement && s.replacement.assetRef }));

  const summary = { now: NOW, targets: [], swaps: swaps.length };

  if (TARGET === 'preview' || TARGET === 'both') {
    const pdir = join(dir, 'preview'); await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'swaps.json'), JSON.stringify({ now: NOW, meta: manifest.meta, swaps }, null, 2));
    // lock ledger
    const lockPath = join(dir, 'manifest.lock.json');
    let lock = { schema: 1, applied: [] }; if (await exists(lockPath)) lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.applied = swaps.map((s) => ({ number: s.number, op: s.op, ref: s.value != null ? hash(String(s.value)) : (s.assetRef || ''), now: NOW }));
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
    summary.targets.push('preview');
  }

  if (TARGET === 'build' || TARGET === 'both') {
    const mode = A['build-mode'] || (manifest.meta.structureAuthorization === 'unauthorized' ? 'clean-room' : 'dom-derivative');
    const bdir = join(dir, 'build'); await mkdir(bdir, { recursive: true });
    if (mode === 'dom-derivative') await buildDomDerivative(manifest, bdir, dir);
    else await buildCleanRoom(manifest, bdir, dir);
    summary.targets.push('build:' + mode);
    summary.buildMode = mode;
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

// ---------- DOM-derivative: copy mirror, then serialize the swapped DOM over it ----------
async function buildDomDerivative(manifest, bdir, dir) {
  // copy whole mirror payload so all CSS/JS/fonts resolve (authorized structure only — the gate enforces this)
  await cp(A.mirror, bdir, { recursive: true, force: true });
  // copy user assets
  const assetsSrc = join(dir, 'assets');
  if (await exists(assetsSrc)) await cp(assetsSrc, join(bdir, 'assets'), { recursive: true, force: true });

  // bring up a loopback server unless one is supplied
  let serverProc = null, url = A['mirror-url'];
  if (!url) { const started = await startServer(A.mirror); serverProc = started.proc; url = started.url; }

  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { console.error('apply-swaps: playwright absent — dom-derivative needs it. Wrote copied mirror only (swaps NOT applied). npm i -D playwright'); if (serverProc) serverProc.kill(); return; }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    // Stamp the unified anchor (data-cl-id) onto every slot's element, then apply swaps by anchor — so the
    // built HTML carries anchors (preview == build) and resolution is robust to DOM-order churn.
    const stampPayload = manifest.slots.map((s) => ({
      clId: s.clId || (s.mirrorLocator && s.mirrorLocator.clId),
      cssPath: s.mirrorLocator && s.mirrorLocator.cssPath, nth: (s.mirrorLocator && s.mirrorLocator.nth) || 0,
    })).filter((s) => s.clId && s.cssPath);
    await page.evaluate(stampAnchorsInPage, stampPayload);
    const swapPayload = manifest.slots.map((s) => ({
      clId: s.clId || (s.mirrorLocator && s.mirrorLocator.clId),
      cssPath: s.mirrorLocator && s.mirrorLocator.cssPath, nth: (s.mirrorLocator && s.mirrorLocator.nth) || 0,
      type: s.type, directOnly: !!s.directOnly, repl: s.replacement || null,
    })).filter((s) => (s.clId || s.cssPath) && s.repl);
    await page.evaluate(applyInPage, swapPayload);
    // strip analytics / verification
    await page.evaluate(stripAnalytics);
    const html = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
    await writeFile(join(bdir, 'index.html'), html);
  } finally {
    await browser.close();
    if (serverProc) serverProc.kill();
  }
}

// runs in the page — stamp data-cl-id on each slot's element (anchor first, cssPath+nth fallback)
function stampAnchorsInPage(items) {
  for (const it of items) {
    if (document.querySelector('[data-cl-id="' + (window.CSS && CSS.escape ? CSS.escape(it.clId) : it.clId) + '"]')) continue;
    let el = null;
    try { const nodes = document.querySelectorAll(it.cssPath); el = nodes[it.nth] || nodes[0]; } catch (e) {}
    if (el) el.setAttribute('data-cl-id', it.clId);
  }
}
// runs in the page — resolve by anchor, then cssPath+nth; rebuild srcset instead of stripping; edit direct text only.
function applyInPage(swaps) {
  function resolve(s) {
    if (s.clId) { const a = document.querySelector('[data-cl-id="' + (window.CSS && CSS.escape ? CSS.escape(s.clId) : s.clId) + '"]'); if (a) return a; }
    try { const nodes = document.querySelectorAll(s.cssPath); return nodes[s.nth] || nodes[0] || null; } catch (e) { return null; }
  }
  function setDirectText(el, value) {
    // replace the element's FIRST direct text node (preserve child elements); else prepend one.
    for (const n of el.childNodes) { if (n.nodeType === 3 && n.nodeValue.trim()) { n.nodeValue = value; return; } }
    el.insertBefore(document.createTextNode(value), el.firstChild);
  }
  for (const s of swaps) {
    const el = resolve(s); if (!el) continue;
    if (s.type === 'text' && s.repl.kind === 'text') {
      if (s.directOnly) setDirectText(el, s.repl.value); else el.textContent = s.repl.value;
    } else if (s.repl.assetRef) {
      const ref = '/' + String(s.repl.assetRef).replace(/^\//, '');
      if (s.type === 'bg') el.style.backgroundImage = 'url("' + ref + '")';
      else if (s.type === 'video') { el.setAttribute('src', ref); if (s.repl.poster) el.setAttribute('poster', '/' + String(s.repl.poster).replace(/^\//, '')); }
      else {
        el.setAttribute('src', ref);
        // REBUILD srcset from the responsive set fit-slot generated — never blind-strip (that broke mobile).
        if (s.repl.srcset) el.setAttribute('srcset', s.repl.srcset);
        else el.removeAttribute('srcset'); // single upload, no responsive set → src is authoritative
      }
    }
  }
}
function stripAnalytics() {
  document.querySelectorAll('script').forEach((s) => { const t = (s.src || '') + (s.textContent || ''); if (/googletagmanager|google-analytics|gtag\(|fbq\(|hotjar|clarity\.ms|dataLayer/.test(t)) s.remove(); });
  document.querySelectorAll('meta[name*="verification" i], meta[name="google-site-verification"]').forEach((m) => m.remove());
}

// ---------- clean-room: scaffold from sourceAnchors + content ----------
async function buildCleanRoom(manifest, bdir, dir) {
  const assetsSrc = join(dir, 'assets');
  if (await exists(assetsSrc)) await cp(assetsSrc, join(bdir, 'assets'), { recursive: true, force: true });
  const rows = manifest.slots.filter((s) => s.role === 'content').map((s) => {
    const anchor = (s.sourceAnchor || '').replace(/^data-slot="?|"?$/g, '');
    if (s.type === 'text') return `  <p data-slot="${anchor}">${escapeHtml(s.replacement ? s.replacement.value : (s.currentValue || ''))}</p>`;
    const ref = s.replacement && s.replacement.assetRef ? '/' + s.replacement.assetRef.replace(/^\//, '') : '';
    return `  <figure data-slot="${anchor}">${ref ? `<img src="${ref}" alt="">` : `<!-- ${s.type} slot #${s.number}: import your asset -->`}</figure>`;
  }).join('\n');
  const techNote = `<!-- CLEAN-ROOM SCAFFOLD. Structure was NOT authorized for a DOM-derivative.
     Reproduce the original's EFFECT VOCABULARY from the technique cards in design-system/clone-techniques/
     (see ${manifest.meta.name}'s effects-inventory.md). Do NOT copy the original's code/CSS/assets. -->`;
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(manifest.meta.name || 'clean-room')}</title>\n${techNote}\n</head>\n<body>\n${rows}\n</body>\n</html>\n`;
  await writeFile(join(bdir, 'index.html'), html);
}

// ---------- helpers ----------
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }

function startServer(root) {
  // Ephemeral OS-assigned port (CLONE_SERVE_PORT=0) read back from serve's "CLONE_PORT=" stdout line —
  // avoids colliding with a stale/leftover server on a fixed port. Force plain mode (no editor).
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(HERE, 'serve.mjs'), root], {
      env: { ...process.env, CLONE_SERVE_PORT: '0', CLONE_EDIT: '', CLONE_LOOPBACK_OK: '', CLONE_REPURPOSE_DIR: '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '', done = false;
    const to = setTimeout(() => { if (!done) { done = true; proc.kill(); reject(new Error('server did not start')); } }, 15000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/CLONE_PORT=(\d+)/);
      if (m && !done) { done = true; clearTimeout(to); resolve({ proc, url: `http://127.0.0.1:${m[1]}/` }); }
    });
    proc.on('error', (e) => { if (!done) { done = true; clearTimeout(to); reject(e); } });
  });
}

main().catch((e) => { console.error('apply-swaps FATAL', e); process.exit(1); });
