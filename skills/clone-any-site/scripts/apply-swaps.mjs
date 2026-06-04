// apply-swaps.mjs — idempotent two-target writer for the Repurpose Layer.
// Reads the numbered manifest and materialises (a) the mirror-preview swap layer (zero-dep) and
// (b) the publishable build (DOM-derivative via Playwright, or a clean-room scaffold). Refuses on a
// build-fingerprint drift and runs validate-manifest first. Never mutates the gitignored mirror payload.
//
//   node apply-swaps.mjs --manifest <path> --mirror <mirrorRoot> [--mirror-url <url>] \
//        [--target preview|build|both] [--build-mode dom-derivative|clean-room] [--now <iso>] \
//        [--freeze on|off] [--hydrate-ms <n>]
//
// FREEZE (auto on hydrating SPAs): React/Next/Nuxt sites rebuild the DOM from embedded data on load, so any
// edit gets REVERTED when a browser opens the page. The build lets the framework hydrate first, edits the
// settled DOM, then strips the framework scripts → the saved page is a faithful static snapshot that holds.
// Static sites have no hydration markers, so they're left exactly as before (no wait, no freeze).
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

  const opOf = (r) => r ? (r.kind === 'text' ? 'replace-text' : r.kind === 'link' ? 'set-href' : 'replace-asset') : null;
  const swaps = manifest.slots
    .filter((s) => s.replacement || s.keep || s.altReplacement != null)
    .map((s) => ({ number: s.number, type: s.type,
      op: s.replacement ? opOf(s.replacement) : (s.keep ? 'keep' : 'set-alt'),
      value: s.replacement && s.replacement.value, href: s.replacement && s.replacement.href,
      assetRef: s.replacement && s.replacement.assetRef, alt: s.altReplacement }));

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
    if (mode === 'dom-derivative') { const r = await buildDomDerivative(manifest, bdir, dir); if (r && r.frozen) { summary.frozen = true; summary.scriptsRemoved = r.scriptsRemoved; if (r.overlaysPeeled) summary.overlaysPeeled = r.overlaysPeeled; } }
    else await buildCleanRoom(manifest, bdir, dir);
    summary.targets.push('build:' + mode);
    summary.buildMode = mode;
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

// ---------- DOM-derivative: copy mirror, then serialize the swapped DOM over it ----------
// Returns { frozen, scriptsRemoved } so the caller can report whether the SPA-freeze ran.
async function buildDomDerivative(manifest, bdir, dir) {
  const out = { frozen: false, scriptsRemoved: 0, overlaysPeeled: 0 };
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

    // ---- HYDRATION GATE: on a SPA (React/Next/Nuxt/Vue/Svelte), the framework rebuilds the DOM from embedded
    // data AFTER load. If we edit before that, our changes are overwritten; if we DON'T freeze, a browser opening
    // the saved page re-hydrates and reverts them. So: detect hydration, let it settle, then edit, then FREEZE. ----
    const freezeArg = (A.freeze || 'auto');                       // 'auto' | 'on' | 'off'
    const hydrateMs = Number(A['hydrate-ms'] || 3500);
    const hydrates = await page.evaluate(() => {
      const has = (sel) => !!document.querySelector(sel);
      return !!(document.getElementById('__NEXT_DATA__') || window.__NEXT_DATA__ || window.__NUXT__ ||
        window.__remixContext || has('[data-reactroot]') || has('#__next') || has('#__nuxt') ||
        Array.prototype.some.call(document.scripts, (s) => /_next\/static|_nuxt\/|\/@vite\/|framework-|webpack-/.test(s.src || '')));
    });
    const doFreeze = freezeArg === 'on' || (freezeArg !== 'off' && hydrates);
    if (hydrates) { await page.waitForTimeout(hydrateMs); }       // let the framework finish painting before we edit
    // PRE-SCROLL: premium sites reveal content on scroll (IntersectionObserver/GSAP) + lazy-load images. A static
    // snapshot taken at the top leaves everything below the fold hidden/blank. Drive top→bottom→top while JS is
    // alive so reveals fire (they stay revealed) and lazy/blob images load, then freeze the fully-painted page.
    if ((A.prescroll || 'auto') !== 'off') {
      await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const h = document.body.scrollHeight, step = Math.max(200, Math.round(innerHeight * 0.6));
        for (let y = 0; y <= h; y += step) { window.scrollTo(0, y); await sleep(150); }
        window.scrollTo(0, h); await sleep(400); window.scrollTo(0, 0); await sleep(600);
      });
      await page.waitForTimeout(400);
    }

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
      type: s.type, subtype: s.subtype || '', directOnly: !!s.directOnly, repl: s.replacement || null,
      alt: (s.altReplacement != null ? s.altReplacement : undefined),   // alt edit applies even without a media swap
      sectionHidden: (s.section && s.section.hidden) ? true : undefined, // hidden section dropped from the build
    })).filter((s) => (s.clId || s.cssPath) && (s.repl || s.alt !== undefined || s.sectionHidden !== undefined));
    await page.evaluate(applyInPage, swapPayload);
    // section reorder — permute sibling <section>s by their section.order (manifest-only, never edits internals).
    // Needs the FULL section set (not just reordered ones) so unordered siblings keep their slots.
    const sectionPayload = manifest.slots.filter((s) => s.type === 'section').map((s) => ({
      clId: s.clId || (s.mirrorLocator && s.mirrorLocator.clId),
      cssPath: s.mirrorLocator && s.mirrorLocator.cssPath, nth: (s.mirrorLocator && s.mirrorLocator.nth) || 0,
      order: (s.section && typeof s.section.order === 'number') ? s.section.order : undefined,
    }));
    if (sectionPayload.some((s) => s.order !== undefined)) await page.evaluate(reorderSectionsInPage, sectionPayload);
    // emit YOUR SEO head. The user's title/description/canonical CASCADE into og:/twitter: and og:url follows
    // the canonical — so changing the title doesn't leave the cloned site's og:title behind. An explicit ''
    // override clears a field; a missing override falls back to the user's base field, then the original.
    const seoMeta = (manifest.meta && manifest.meta.seo) || null;
    if (seoMeta) {
      const rep = seoMeta.replacement || {}, org = seoMeta.original || {};
      const base = (k) => (rep[k] !== undefined ? rep[k] : (org[k] || ''));      // explicit '' clears
      const title = base('title'), desc = base('description'), canonical = base('canonical');
      const seo = {
        title, description: desc, canonical, lang: base('lang'),
        ogTitle: rep.ogTitle !== undefined ? rep.ogTitle : (rep.title !== undefined ? rep.title : (org.ogTitle || org.title || '')),
        ogDescription: rep.ogDescription !== undefined ? rep.ogDescription : (rep.description !== undefined ? rep.description : (org.ogDescription || org.description || '')),
        ogImage: rep.ogImage !== undefined ? rep.ogImage : (org.ogImage || ''),
        ogUrl: rep.ogUrl !== undefined ? rep.ogUrl : (rep.canonical !== undefined ? rep.canonical : (org.ogUrl || org.canonical || '')),
        twitterTitle: rep.twitterTitle !== undefined ? rep.twitterTitle : (rep.title !== undefined ? rep.title : (org.twitterTitle || org.title || '')),
        twitterDescription: rep.twitterDescription !== undefined ? rep.twitterDescription : (rep.description !== undefined ? rep.description : (org.twitterDescription || org.description || '')),
        twitterImage: rep.twitterImage !== undefined ? rep.twitterImage : (rep.ogImage !== undefined ? rep.ogImage : (org.twitterImage || org.ogImage || '')),
        _hasReplacement: Object.keys(rep).length > 0,
      };
      await page.evaluate(applySeoInPage, seo);
    }
    // RELOCALIZE blob: images — premium sites (Contentful blur-up, etc.) load hero images via JS into ephemeral
    // blob: URLs that DIE on reload (broken/black in the saved page). Recover each blob img's real source URL from
    // __NEXT_DATA__/data-src (match by alt, then order) and rewrite src. MUST run before freeze removes __NEXT_DATA__.
    if ((A.relocalize || 'auto') !== 'off') {
      const r = await page.evaluate(relocalizeBlobImagesInPage);
      if (r && r.fixed) out.blobImagesRelocalized = r.fixed;
    }
    // strip analytics / verification
    await page.evaluate(stripAnalytics);
    // FREEZE: remove framework scripts + hydration data so the saved page can't re-render and revert our edits.
    // Only on SPAs (or forced). Keeps JSON-LD (SEO) and any non-module inline non-framework script untouched is
    // not worth the risk — for a faithful static snapshot we drop all <script> + the __NEXT_DATA__/__NUXT__ blobs.
    if (doFreeze) {
      out.scriptsRemoved = await page.evaluate(freezeSpaInPage);
      out.frozen = true;
      // A JS-driven INTRO LOADER (full-viewport overlay the framework dismisses on load) would, once we strip its
      // script, stay forever and hide the real content. Peel those covering overlays so the snapshot shows the
      // settled page. Default on when freezing; --deloader off disables. (Content under a dead loader, not chrome.)
      const deloaderArg = (A.deloader || 'auto');
      if (deloaderArg !== 'off') out.overlaysPeeled = await page.evaluate(neutralizeIntroOverlaysInPage);
    }
    const html = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
    await writeFile(join(bdir, 'index.html'), html);
  } finally {
    await browser.close();
    if (serverProc) serverProc.kill();
  }
  return out;
}

// runs in the page — FREEZE a hydrated SPA into a static snapshot: drop every <script> (framework runtime +
// inline hydration) and the framework data blobs, so opening the saved file can't re-render and revert edits.
// We keep <link>/<style>/<noscript> and JSON-LD (type="application/ld+json") for SEO. Returns scripts removed.
function freezeSpaInPage() {
  let n = 0;
  document.querySelectorAll('script').forEach((s) => {
    const t = (s.getAttribute('type') || '').toLowerCase();
    if (t === 'application/ld+json') return;        // keep structured data
    s.remove(); n++;
  });
  ['__NEXT_DATA__', '__NUXT_DATA__'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
  // mark the page as a frozen static snapshot (debug breadcrumb; harmless)
  document.documentElement.setAttribute('data-cl-frozen', '1');
  return n;
}

// runs in the page — RELOCALIZE blob: image srcs to their real source URL. Premium sites load hero images via JS
// into URL.createObjectURL() blobs; those die on reload → broken images in the frozen snapshot. We recover the real
// URL from __NEXT_DATA__ (Contentful & co. embed absolute image URLs there) + any data-src, match to each blob img
// by alt text (then by order), and rewrite src (clearing the stale srcset). Returns how many were relocalized.
function relocalizeBlobImagesInPage() {
  const blobImgs = Array.prototype.filter.call(document.querySelectorAll('img'), (i) => /^blob:/.test(i.src || ''));
  if (!blobImgs.length) return { fixed: 0 };
  // 1) harvest {url, title} candidates from __NEXT_DATA__ (parsed if possible, else regex) + data-src attributes
  const assets = [];
  const pushAsset = (url, title) => { if (typeof url === 'string' && url) assets.push({ url: url.indexOf('//') === 0 ? 'https:' + url : url, title: String(title || '').toLowerCase() }); };
  const nd = document.getElementById('__NEXT_DATA__');
  const raw = nd ? nd.textContent : '';
  const isImg = (u) => typeof u === 'string' && /\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(u);
  if (raw) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        const url = isImg(o.url) ? o.url : (o.file && isImg(o.file.url) ? o.file.url : null);
        if (url) pushAsset(url, o.title || o.description || o.alt || (o.fields && (o.fields.title || o.fields.description)) || '');
        for (const k in o) { if (k !== 'url' && k !== 'file') walk(o[k]); }
      };
      walk(JSON.parse(raw));
    } catch (e) {
      for (const mm of raw.matchAll(/(?:https?:)?\/\/[^\s"']+?\.(?:jpe?g|png|webp|avif)/gi)) pushAsset(mm[0], '');
    }
  }
  // de-dup, keep order
  const seen = new Set(); const pool = assets.filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)));
  // 2) assign: prefer a pool entry whose title matches the img alt; else next unused in order
  const used = new Set(); let fixed = 0;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const img of blobImgs) {
    const alt = norm(img.getAttribute('alt'));
    let pick = null;
    if (alt) pick = pool.find((a) => !used.has(a.url) && a.title && (norm(a.title).includes(alt) || alt.includes(norm(a.title)) && norm(a.title).length > 4));
    if (!pick) pick = pool.find((a) => !used.has(a.url));
    if (!pick) break;
    used.add(pick.url);
    img.setAttribute('src', pick.url);
    img.removeAttribute('srcset'); img.removeAttribute('data-src'); img.removeAttribute('data-srcset');
    img.setAttribute('loading', 'eager'); img.setAttribute('decoding', 'sync');
    const pic = img.closest('picture'); if (pic) pic.querySelectorAll('source').forEach((s) => s.remove());
    fixed++;
  }
  return { fixed, pool: pool.length, blobs: blobImgs.length };
}

// runs in the page — peel JS-driven INTRO/LOADER overlays. After freeze removes scripts, an overlay the framework
// would have dismissed (splash, % counter, "entering" gate) stays forever and hides the settled content. We hide
// the full-viewport, high-stacking, opaque element painted ON TOP at the viewport centre, repeat a few times until
// the centre shows real content. Conservative: only fixed/absolute full-covers (loaders) — a normal relative hero
// section never matches, so content pages are untouched. Returns how many overlay layers were peeled.
function neutralizeIntroOverlaysInPage() {
  const vw = innerWidth, vh = innerHeight, cx = vw >> 1, cy = vh >> 1;
  const isFullCover = (e) => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return (s.position === 'fixed' || s.position === 'absolute')
      && r.width >= vw * 0.9 && r.height >= vh * 0.9 && r.top <= vh * 0.05 && r.left <= vw * 0.05
      && s.display !== 'none' && +s.opacity > 0.5;
  };
  let peeled = 0;
  for (let i = 0; i < 6; i++) {
    const top = document.elementFromPoint(cx, cy);
    if (!top) break;
    let node = top, cover = null;                       // climb to the OUTERMOST full-cover ancestor on the path
    while (node && node !== document.body && node !== document.documentElement) {
      if (isFullCover(node)) cover = node;
      node = node.parentElement;
    }
    if (!cover) break;                                  // centre is real content now → done
    cover.setAttribute('data-cl-deloader', '1');
    cover.style.setProperty('display', 'none', 'important');
    peeled++;
  }
  return peeled;
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
// runs in the page — resolve by anchor, then cssPath+nth; SHAPE-AWARE media rebuild so the BUILD matches the
// editor preview exactly (a <picture>'s sibling <source>s are rebuilt from srcsetHtml — setting only <img src>
// leaves a stale <source> that wins → black image in the shipped page). Mirrors editor/editor.js applyAsset.
function applyInPage(swaps) {
  function resolve(s) {
    if (s.clId) { const a = document.querySelector('[data-cl-id="' + (window.CSS && CSS.escape ? CSS.escape(s.clId) : s.clId) + '"]'); if (a) return a; }
    try { const nodes = document.querySelectorAll(s.cssPath); return nodes[s.nth] || nodes[0] || null; } catch (e) { return null; }
  }
  function setDirectText(el, value) {
    for (const n of el.childNodes) { if (n.nodeType === 3 && n.nodeValue.trim()) { n.nodeValue = value; return; } }
    el.insertBefore(document.createTextNode(value), el.firstChild);
  }
  function parseHtml(html) { if (!html) return null; const t = document.createElement('template'); t.innerHTML = String(html); return t.content.firstElementChild; }
  function norm(r) { return '/' + String(r == null ? '' : r).replace(/^\//, ''); }
  function clearStale(img) { img.removeAttribute('data-src'); img.removeAttribute('data-srcset'); }

  for (const s of swaps) {
    const el = resolve(s); if (!el) continue;
    if (s.sectionHidden) { el.style.display = 'none'; }   // drop a hidden section from the shipped page (reversible: re-show in the editor)
    const repl = s.repl;
    if (!repl) continue;                                  // alt-only / section-only slot: nothing more to do here (alt pass runs below)
    if (s.type === 'text' && (repl.kind === 'text' || repl.kind === 'link')) {
      if (repl.value != null) { if (s.directOnly) setDirectText(el, repl.value); else el.textContent = repl.value; }
      if (repl.href != null) { const ht = (el.tagName === 'A') ? el : ((el.closest && (el.closest('a[href]') || el.closest('a'))) || el); ht.setAttribute('href', repl.href); }  // ship YOUR link on the href-bearing anchor (matches extract's closest('a[href]'))
      continue;
    }
    if (!repl.assetRef && !repl.srcsetHtml) continue;
    const ref = norm(repl.assetRef);
    const node = parseHtml(repl.srcsetHtml);
    const sub = s.subtype || '';

    if (s.type === 'bg') { el.style.backgroundImage = 'url("' + ref + '")'; continue; }

    if (s.type === 'video') {
      Array.prototype.slice.call(el.querySelectorAll('source')).forEach((x) => x.remove());
      el.removeAttribute('src');
      if (node && node.tagName === 'VIDEO') {
        Array.prototype.forEach.call(node.querySelectorAll('source'), (x) => el.appendChild(x.cloneNode(true)));
        const p = node.getAttribute('poster'); if (p) el.setAttribute('poster', norm(p));
      } else { el.setAttribute('src', ref); }
      if (repl.poster) el.setAttribute('poster', norm(repl.poster));
      continue;
    }

    const pic = el.parentElement;
    if (sub === 'picture' || (pic && pic.tagName === 'PICTURE')) {
      // remove EVERY stale <source> (the black-image cause), then transplant fit-slot's <source>s
      if (pic && pic.tagName === 'PICTURE') {
        Array.prototype.slice.call(pic.querySelectorAll('source')).forEach((x) => x.remove());
        if (node && node.tagName === 'PICTURE') {
          Array.prototype.forEach.call(node.querySelectorAll('source'), (x) => pic.insertBefore(x.cloneNode(true), el));
          const fImg = node.querySelector('img');
          el.removeAttribute('srcset'); el.removeAttribute('sizes');
          el.setAttribute('src', fImg ? norm(fImg.getAttribute('src')) : ref);
        } else { el.removeAttribute('srcset'); el.removeAttribute('sizes'); el.setAttribute('src', ref); }
        clearStale(el); continue;
      }
    }
    if (s.type === 'svg' || sub === 'inline-svg' || (el.tagName && el.tagName.toLowerCase() === 'svg')) {
      const img = (node && node.tagName === 'IMG') ? node.cloneNode(true) : (function () { const i = document.createElement('img'); i.setAttribute('src', ref); i.setAttribute('alt', ''); return i; })();
      if (!img.getAttribute('src')) img.setAttribute('src', ref);
      const cls = el.getAttribute('class'); if (cls) img.setAttribute('class', cls);
      const st = el.getAttribute('style'); if (st) img.setAttribute('style', st);
      const id = el.getAttribute('data-cl-id'); if (id) img.setAttribute('data-cl-id', id);
      el.replaceWith(img); continue;
    }
    // plain <img>
    clearStale(el); el.removeAttribute('srcset');
    const ss = (node && node.tagName === 'IMG' && node.getAttribute('srcset')) || repl.srcset || '';
    if (ss) { el.setAttribute('srcset', ss); el.setAttribute('sizes', (node && node.getAttribute('sizes')) || '100vw'); }
    else el.removeAttribute('sizes');
    el.setAttribute('src', ref);
  }
  // alt pass — runs for any image slot with an alt override (even when there's no media swap)
  for (const s of swaps) {
    if (s.alt === undefined) continue;
    const el = resolve(s); if (!el) continue;
    const img = (el.tagName === 'IMG') ? el : el.querySelector && el.querySelector('img');
    if (img) img.setAttribute('alt', s.alt);
  }
}
// runs in the page — reorder sibling <section>s by section.order. Placeholder-permute keeps each section in
// the EXACT DOM slots the sections already occupied (even if interleaved with other content) and only swaps
// which section sits where. Per-parent, so sections in different parents don't interfere. Never edits CSS.
function reorderSectionsInPage(sections) {
  if (!sections || !sections.length) return;
  function resolve(s) {
    if (s.clId) { const a = document.querySelector('[data-cl-id="' + (window.CSS && CSS.escape ? CSS.escape(s.clId) : s.clId) + '"]'); if (a) return a; }
    try { const n = document.querySelectorAll(s.cssPath); return n[s.nth] || n[0] || null; } catch (e) { return null; }
  }
  const groups = new Map();
  for (const s of sections) {
    const el = resolve(s); if (!el || !el.parentElement) continue;
    const p = el.parentElement;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push({ el, order: (typeof s.order === 'number') ? s.order : null });
  }
  groups.forEach((group, parent) => {
    if (!group.some((g) => g.order != null)) return;
    const dom = group.slice().sort((a, b) => { const p = a.el.compareDocumentPosition(b.el); return (p & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1; });
    const sorted = dom.map((g, i) => ({ el: g.el, eff: (g.order != null ? g.order : i), i })).sort((a, b) => a.eff - b.eff || a.i - b.i).map((x) => x.el);
    const orig = dom.map((g) => g.el);
    let same = true; for (let i = 0; i < orig.length; i++) { if (orig[i] !== sorted[i]) { same = false; break; } }
    if (same) return;
    const phs = orig.map((el) => { const c = document.createComment('cl-sec'); parent.insertBefore(c, el); el.remove(); return c; });
    phs.forEach((ph, i) => parent.replaceChild(sorted[i], ph));
  });
}
// runs in the page — write YOUR resolved SEO head. Values are already cascaded in apply-swaps (caller), so
// this just applies them: a non-empty value is set; an empty value CLEARS that tag (removes content / the
// element) — but only when the user actually touched SEO (_hasReplacement), so an untouched clone is left
// alone. Twitter selectors accept BOTH name= and property= and DEDUPE (some sites use property="twitter:*").
function applySeoInPage(seo) {
  const touched = !!seo._hasReplacement;
  function setMeta(selectors, attr, key, content) {
    const all = [];
    for (const sel of selectors) Array.prototype.forEach.call(document.querySelectorAll(sel), (m) => { if (all.indexOf(m) === -1) all.push(m); });
    if (content == null || content === '') {                 // clear: drop all matching metas (only if user touched SEO)
      if (touched) all.forEach((m) => m.remove());
      return;
    }
    let m = all[0];
    if (!m) { m = document.createElement('meta'); m.setAttribute(attr, key); document.head.appendChild(m); }
    m.setAttribute('content', content);
    for (let i = 1; i < all.length; i++) all[i].remove();    // collapse duplicates
  }
  if (seo.title) document.title = seo.title;
  if (seo.lang) document.documentElement.setAttribute('lang', seo.lang);
  setMeta(['meta[name="description" i]'], 'name', 'description', seo.description);
  setMeta(['meta[property="og:title" i]'], 'property', 'og:title', seo.ogTitle);
  setMeta(['meta[property="og:description" i]'], 'property', 'og:description', seo.ogDescription);
  setMeta(['meta[property="og:image" i]'], 'property', 'og:image', seo.ogImage);
  setMeta(['meta[property="og:url" i]'], 'property', 'og:url', seo.ogUrl);
  setMeta(['meta[name="twitter:title" i]', 'meta[property="twitter:title" i]'], 'name', 'twitter:title', seo.twitterTitle);
  setMeta(['meta[name="twitter:description" i]', 'meta[property="twitter:description" i]'], 'name', 'twitter:description', seo.twitterDescription);
  setMeta(['meta[name="twitter:image" i]', 'meta[property="twitter:image" i]'], 'name', 'twitter:image', seo.twitterImage);
  if (seo.canonical) {
    let l = document.querySelector('link[rel="canonical" i]');
    if (!l) { l = document.createElement('link'); l.setAttribute('rel', 'canonical'); document.head.appendChild(l); }
    l.setAttribute('href', seo.canonical);
  } else if (touched && seo.canonical === '') {
    const l = document.querySelector('link[rel="canonical" i]'); if (l) l.remove();
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
