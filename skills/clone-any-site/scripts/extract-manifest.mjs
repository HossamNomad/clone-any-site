// extract-manifest.mjs — emits the numbered Repurpose manifest from a hydrated loopback mirror DOM.
// Conforms to manifest.schema.json + references/clone-interfaces.md (§1 CLI, determinism rule, §4/§5).
//
// CLI:
//   node extract-manifest.mjs --url <mirrorUrl> --out <repurposeDir> --name <name> \
//        [--viewports 390,768,1440] [--crawl-log <path>] [--now <iso>]
//
// Determinism: this script NEVER calls Date.now()/new Date()/Math.random(). Every timestamp comes from
// --now; every id is content-derived (sha1 via node:crypto). Two runs on a frozen mirror are byte-identical.
//
// Reuses run-fidelity.mjs patterns: identical chromium launch args, the WebGL frame-draw initScript hook,
// the scroll-assert-with-retry loop, and deterministic <video> seek (currentTime=0 freeze before walking).
//
// Deps: playwright (resolved from the host project) + node:crypto/fs/path built-ins. No new deps.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION = 'extract-manifest.mjs@1.0';

// ----------------------------------------------------------------------------------------------------
// Tiny hand-rolled flag parser (no deps). Supports "--flag value" and "--flag=value".
// ----------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------
// Determinism helpers — all ids/hashes are content-derived.
// ----------------------------------------------------------------------------------------------------
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const shortSha = (s, n = 8) => sha1(s).slice(0, n);
const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const exists = (p) => access(p).then(() => true).catch(() => false);

// run-fidelity launch args (verbatim) + the WebGL frame-draw hook (verbatim pattern).
const LAUNCH_ARGS = ['--force-color-profile=srgb', '--disable-lcd-text', '--hide-scrollbars', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];
const FRAME_HOOK = `
(() => {
  const stamp = () => { try { window.__frameDrawnAt = performance.now(); } catch(e){} };
  for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    for (const m of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']) {
      const orig = Ctx.prototype[m];
      if (orig) Ctx.prototype[m] = function(...a){ stamp(); return orig.apply(this, a); };
    }
  }
})();`;

// ----------------------------------------------------------------------------------------------------
// In-page extractor. Runs inside the hydrated DOM after freeze. Returns serializable atom records.
// Kept fully self-contained (no closure refs) because page.evaluate serializes the function.
// ----------------------------------------------------------------------------------------------------
// NOTE: passed to page.evaluate as a real FUNCTION (not a string). Playwright ignores the arg when the
// first param is a string expression, so we MUST pass a function for `mirrorOrigin` to arrive.
function pageExtract(mirrorOrigin) {
  // ---- helpers (in-page) ----------------------------------------------------------------------------
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const TEXT_TAGS = new Set(['H1','H2','H3','H4','H5','H6','P','SPAN','A','LI','BUTTON','FIGCAPTION','BLOCKQUOTE','STRONG','EM']);
  const LANDMARK_TAGS = new Set(['SECTION','HEADER','FOOTER','NAV']);

  function isAnimationClone(el) {
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute && el.hasAttribute('data-swiper-slide-duplicate')) return true;
    const cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (el.className || '');
    if (/(^|\s)(swiper-slide-duplicate|marquee__copy|marquee-clone|js-clone|is-clone)(\s|$)/.test(cls)) return true;
    return false;
  }

  // deterministic unique css path: tag + #id (if id) + :nth-of-type chain to root.
  function cssPath(el) {
    if (el.id) return el.tagName.toLowerCase() + '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
      let sel = node.tagName.toLowerCase();
      if (node.id) { sel = node.tagName.toLowerCase() + '#' + CSS.escape(node.id); parts.unshift(sel); break; }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sameTag.length > 1) { const idx = sameTag.indexOf(node) + 1; sel += ':nth-of-type(' + idx + ')'; }
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function nthAmong(el, path) {
    let matches = [];
    try { matches = Array.prototype.slice.call(document.querySelectorAll(path)); } catch (e) { matches = []; }
    const i = matches.indexOf(el);
    return i < 0 ? 0 : i;
  }
  function bbox(el) {
    const r = el.getBoundingClientRect();
    const sx = Math.round(window.scrollX || window.pageXOffset || 0);
    const sy = Math.round(window.scrollY || window.pageYOffset || 0);
    // [x, y, w, h] in document space (rect + current scroll offsets), rounded ints.
    return [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)];
  }
  function isDisplayNone(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    const r = el.getBoundingClientRect();
    return (r.width === 0 && r.height === 0);
  }
  function classSig(el) {
    const cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (el.className || '');
    return el.tagName + '|' + String(cls).split(/\s+/).filter(Boolean).sort().join('.');
  }

  const mirrorHost = (() => { try { return new URL(mirrorOrigin).host; } catch (e) { return location.host; } })();
  function assetHost(url) { try { return new URL(url, location.href).host; } catch (e) { return mirrorHost; } }
  function isCrossOrigin(url) { if (!url) return false; if (url.startsWith('data:')) return false; return assetHost(url) !== mirrorHost; }

  // section anchor: nearest landmark/[id] ancestor's stable key, for section-scoped numbering + stableId.
  function sectionAnchorOf(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.id) return '#' + node.id;
      if (LANDMARK_TAGS.has(node.tagName)) {
        const cls = (node.className && node.className.baseVal !== undefined) ? node.className.baseVal : (node.className || '');
        return node.tagName.toLowerCase() + '.' + String(cls).split(/\s+/).filter(Boolean).sort().join('.');
      }
      node = node.parentElement;
    }
    return 'doc';
  }

  // chrome classifier (interfaces §3): inside nav/footer, [data-chrome], or legal/cookie heuristics.
  const LEGAL_RE = /(©|©|copyright|privacy|terms|cookie|\bGDPR\b|mentions? l[ée]gales?)/i;
  const ADDR_RE = /\b\d{1,4}\s+(rue|avenue|av\.|street|st\.|blvd|boulevard|road|rd\.)\b/i;
  const PHONE_RE = /(\+\d[\d \-().]{6,}\d)/;
  function classifyRole(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.tagName === 'NAV' || node.tagName === 'FOOTER') return 'chrome';
      if (node.hasAttribute && node.hasAttribute('data-chrome')) return 'chrome';
      node = node.parentElement;
    }
    const t = norm(el.textContent || '');
    if (LEGAL_RE.test(t) || ADDR_RE.test(t) || PHONE_RE.test(t)) return 'chrome';
    // links pointing at privacy/terms
    if (el.tagName === 'A') { const href = el.getAttribute('href') || ''; if (/privacy|terms|cookie|legal/i.test(href)) return 'chrome'; }
    return 'content';
  }

  // Has meaningful DIRECT text (not just whitespace, not solely from child elements).
  function directText(el) {
    let s = '';
    for (const n of el.childNodes) { if (n.nodeType === 3) s += n.nodeValue; }
    return norm(s);
  }

  // ---- FREEZE: dedupe animation clones already handled per-node; walk in document order --------------
  const all = Array.prototype.slice.call(document.querySelectorAll('*'));
  const atoms = [];
  let order = 0;

  // Pre-compute repeat groups: for each parent, sibling groups of >=3 structurally identical children.
  // Map element -> { sig, index, count } for the representative-folding step.
  const repeatOf = new Map();      // child element -> {sig, index, count}
  const repeatRep = new Set();     // representative (index 0) elements
  (function detectRepeats() {
    const parents = new Set();
    for (const el of all) { if (el.parentElement) parents.add(el.parentElement); }
    for (const parent of parents) {
      const kids = Array.prototype.filter.call(parent.children, (c) => c.nodeType === 1 && !isAnimationClone(c));
      // group siblings by class signature
      const bySig = new Map();
      for (const k of kids) { const sig = classSig(k); if (!bySig.has(sig)) bySig.set(sig, []); bySig.get(sig).push(k); }
      for (const [sig, group] of bySig) {
        if (group.length >= 3) {
          group.forEach((k, idx) => { repeatOf.set(k, { sig, index: idx, count: group.length }); });
          repeatRep.add(group[0]);
        }
      }
    }
  })();

  // Determine, for any element, whether it lives inside a NON-representative repeat instance (=> skip).
  function inSkippedRepeatInstance(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const info = repeatOf.get(node);
      if (info) return info.index !== 0; // inside a repeat group member; skip unless representative (index 0)
      node = node.parentElement;
    }
    return false;
  }
  // The repeat-group info an atom belongs to (the representative ancestor), if any.
  function repeatHeadInfo(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const info = repeatOf.get(node);
      if (info) return info; // representative path (index 0) — caller only invokes for non-skipped atoms
      node = node.parentElement;
    }
    return null;
  }

  function pushAtom(rec) { rec.docOrder = order++; atoms.push(rec); }

  // walk every element in document order
  for (const el of all) {
    if (isAnimationClone(el)) continue;
    if (inSkippedRepeatInstance(el)) continue; // fold: only representative instance emits atoms

    const tag = el.tagName;

    // section landmark overview
    if (LANDMARK_TAGS.has(tag)) {
      // a large gradient ON a landmark (very common: hero <header>/<section>) — landmarks continue below,
      // so detect it here too or it'd be missed. Flagged advanced (a color value, no third-party asset).
      const csL = getComputedStyle(el);
      const bgiL = csL.backgroundImage || '';
      if (bgiL && bgiL !== 'none' && /gradient/i.test(bgiL) && !/url\(/i.test(bgiL) && !isDisplayNone(el)) {
        const rL = el.getBoundingClientRect();
        if (rL.width * rL.height >= innerWidth * innerHeight * 0.15) {
          pushAtom({
            kind: 'bg', tag, subtype: 'css-gradient',
            sectionAnchor: sectionAnchorOf(el), role: classifyRole(el),
            cssPath: cssPath(el), nth: nthAmong(el, cssPath(el)), bbox: bbox(el),
            currentValue: 'gradient', advanced: { kind: 'css-background', cssValue: bgiL },
            contentSig: 'grad|' + cssPath(el), flags: ['advanced:css-background'], repeat: repeatHeadInfo(el),
          });
        }
      }
      pushAtom({
        kind: 'section', tag,
        sectionAnchor: sectionAnchorOf(el),
        role: classifyRole(el),
        cssPath: cssPath(el), nth: nthAmong(el, cssPath(el)),
        bbox: isDisplayNone(el) ? null : bbox(el),
        currentValue: tag.toLowerCase(),
        contentSig: tag.toLowerCase() + '|' + sectionAnchorOf(el),
        repeat: null,
      });
      continue;
    }

    // images
    if (tag === 'IMG') {
      const src = el.getAttribute('src') || el.currentSrc || '';
      const srcset = el.getAttribute('srcset') || '';
      const alt = el.getAttribute('alt') || '';
      const inPicture = !!(el.parentElement && el.parentElement.tagName === 'PICTURE');
      const isSvg = /\.svg(\?|$)/i.test(src);
      let subtype = '';
      if (isSvg) subtype = ''; // svg image handled in the svg branch below
      else if (inPicture) subtype = 'picture';
      else if (srcset) subtype = 'srcset';
      const flags = [];
      const altWords = norm(alt).split(/\s+/).filter(Boolean).length;
      const textAsImage = el.hasAttribute('data-text-as-image') || altWords > 12;
      if (textAsImage) { subtype = 'text-as-image'; flags.push('text-as-image:review'); }
      if (isCrossOrigin(src)) flags.push('cross-origin:not-mirrored');
      const r = el.getBoundingClientRect();
      // Capture the responsive shape so a swap REBUILDS srcset/<picture> instead of stripping it.
      const sizesAttr = el.getAttribute('sizes') || '';
      let srcsetSpec = null;
      if (!isSvg) {
        if (inPicture && el.parentElement) {
          const sources = Array.prototype.map.call(el.parentElement.querySelectorAll('source'), (s) => ({
            type: s.getAttribute('type') || '', media: s.getAttribute('media') || '',
            srcset: s.getAttribute('srcset') || '', sizes: s.getAttribute('sizes') || '',
          }));
          srcsetSpec = { kind: 'picture', sources, sizes: sizesAttr, imgSrcset: srcset };
        } else if (srcset) srcsetSpec = { kind: 'img-srcset', sizes: sizesAttr, imgSrcset: srcset };
        else srcsetSpec = { kind: 'plain', sizes: sizesAttr };
      }
      pushAtom({
        kind: isSvg ? 'svg' : 'img',
        svgImg: isSvg,
        tag, subtype: isSvg ? '' : subtype,
        sectionAnchor: sectionAnchorOf(el),
        role: classifyRole(el),
        cssPath: cssPath(el), nth: nthAmong(el, cssPath(el)),
        bbox: isDisplayNone(el) ? null : bbox(el),
        src, srcset, alt, srcsetSpec,
        naturalDims: [el.naturalWidth || Math.round(r.width) || 0, el.naturalHeight || Math.round(r.height) || 0],
        currentValue: norm(alt) || (src.split('/').pop() || 'image'),
        contentSig: 'img|' + src,
        flags,
        repeat: repeatHeadInfo(el),
      });
      continue;
    }

    // inline svg
    if (tag === 'SVG' || tag === 'svg') {
      pushAtom({
        kind: 'svg', svgImg: false, tag: 'SVG', subtype: 'inline-svg',
        sectionAnchor: sectionAnchorOf(el),
        role: classifyRole(el),
        cssPath: cssPath(el), nth: nthAmong(el, cssPath(el)),
        bbox: isDisplayNone(el) ? null : bbox(el),
        currentValue: 'inline-svg',
        contentSig: 'svg|' + cssPath(el),
        flags: [],
        repeat: repeatHeadInfo(el),
      });
      continue;
    }

    // video
    if (tag === 'VIDEO') {
      const poster = el.getAttribute('poster') || '';
      const sources = Array.prototype.map.call(el.querySelectorAll('source'), (s) => ({ src: s.getAttribute('src') || '', type: s.getAttribute('type') || '' }));
      const r = el.getBoundingClientRect();
      const flags = [];
      if (isCrossOrigin(poster)) flags.push('cross-origin:not-mirrored');
      pushAtom({
        kind: 'video', tag, subtype: '',
        sectionAnchor: sectionAnchorOf(el),
        role: classifyRole(el),
        cssPath: cssPath(el), nth: nthAmong(el, cssPath(el)),
        bbox: isDisplayNone(el) ? null : bbox(el),
        poster, sources,
        posterRef: poster || null,
        sourcesSpec: sources.length ? sources : (el.getAttribute('src') ? [{ src: el.getAttribute('src'), type: '' }] : []),
        naturalDims: [el.videoWidth || Math.round(r.width) || 0, el.videoHeight || Math.round(r.height) || 0],
        currentValue: (sources[0] && sources[0].src.split('/').pop()) || poster.split('/').pop() || 'video',
        contentSig: 'video|' + ((sources[0] && sources[0].src) || poster || cssPath(el)),
        flags,
        repeat: repeatHeadInfo(el),
      });
      continue;
    }

    // background-image (url, not gradient)
    const cs = getComputedStyle(el);
    const bgi = cs.backgroundImage || '';
    if (bgi && bgi !== 'none' && /url\(/i.test(bgi) && !/gradient/i.test(bgi)) {
      const m = /url\((['"]?)(.*?)\1\)/i.exec(bgi);
      const url = m ? m[2] : '';
      const flags = [];
      if (isCrossOrigin(url)) flags.push('cross-origin:not-mirrored');
      pushAtom({
        kind: 'bg', tag, subtype: 'css-bg',
        sectionAnchor: sectionAnchorOf(el),
        role: classifyRole(el),
        cssPath: cssPath(el), nth: nthAmong(el, cssPath(el)),
        bbox: isDisplayNone(el) ? null : bbox(el),
        bgUrl: url,
        currentValue: url.split('/').pop() || 'background',
        contentSig: 'bg|' + url,
        flags,
        computed: { fontFamily: cs.fontFamily, color: cs.color, fontSize: cs.fontSize },
        repeat: repeatHeadInfo(el),
      });
      // bg element may also carry direct text — fall through to the text check below.
    }
    // gradient/pattern background — flagged ADVANCED (a color value, no third-party asset). Only large
    // surfaces (>=15% of viewport) so we don't flood with every small button gradient.
    else if (bgi && bgi !== 'none' && /gradient/i.test(bgi) && !isDisplayNone(el)) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= innerWidth * innerHeight * 0.15) {
        pushAtom({
          kind: 'bg', tag, subtype: 'css-gradient',
          sectionAnchor: sectionAnchorOf(el),
          role: classifyRole(el),
          cssPath: cssPath(el), nth: nthAmong(el, cssPath(el)),
          bbox: bbox(el),
          currentValue: 'gradient',
          advanced: { kind: 'css-background', cssValue: bgi },
          contentSig: 'grad|' + cssPath(el),
          flags: ['advanced:css-background'],
          repeat: repeatHeadInfo(el),
        });
        continue;
      }
    }

    // text leaves
    if (TEXT_TAGS.has(tag)) {
      const dt = directText(el);
      if (dt) {
        const cs2 = getComputedStyle(el);
        // If this element ALSO has element children (e.g. <p>Hi <span>there</span></p>), it owns only its
        // DIRECT text nodes ("Hi"). Mark directOnly so an edit replaces those nodes — never textContent,
        // which would delete the nested <span> (captured as its own slot). Simple text stays unflagged.
        const directOnly = el.children && el.children.length > 0;
        // capture an editable link target so the shipped page doesn't keep pointing at the ORIGINAL site
        // (a clone ships with the source's hrefs → sends your visitors to the competitor). Real sites wrap
        // the visible label as <a><span>Label</span></a>, so a text slot inherits its NEAREST ancestor
        // anchor's href; editing retargets that anchor. Own href wins for a direct <a>; <button> uses formaction.
        const anc = (tag === 'A') ? el : (el.closest ? el.closest('a[href]') : null);
        const href = (tag === 'A') ? el.getAttribute('href')
          : (tag === 'BUTTON') ? (el.getAttribute('formaction') || null)
          : (anc ? anc.getAttribute('href') : null);
        pushAtom({
          kind: 'text', tag, subtype: directOnly ? 'text-leaf' : '',
          directOnly,
          sectionAnchor: sectionAnchorOf(el),
          role: classifyRole(el),
          cssPath: cssPath(el), nth: nthAmong(el, cssPath(el)),
          bbox: isDisplayNone(el) ? null : bbox(el),
          currentValue: dt,
          href: href || null,
          contentSig: 'text|' + dt,
          flags: [],
          computed: { fontFamily: cs2.fontFamily, color: cs2.color, fontSize: cs2.fontSize },
          repeat: repeatHeadInfo(el),
        });
      }
    }
  }

  // ---- SEO head capture: a clone ships with the ORIGINAL site's title/description/OG/canonical — wrong
  // brand, wrong domain, an SEO + IP liability. Capture them so the editor can rewrite + the build emits YOURS.
  function metaContent(sel) { const m = document.querySelector(sel); return m ? (m.getAttribute('content') || '') : ''; }
  const seo = {
    title: document.title || '',
    description: metaContent('meta[name="description" i]'),
    canonical: (function () { const l = document.querySelector('link[rel="canonical" i]'); return l ? (l.getAttribute('href') || '') : ''; })(),
    ogTitle: metaContent('meta[property="og:title" i]'),
    ogDescription: metaContent('meta[property="og:description" i]'),
    ogImage: metaContent('meta[property="og:image" i]'),
    ogUrl: metaContent('meta[property="og:url" i]'),
    // twitter cards appear as BOTH name="twitter:*" and property="twitter:*" in the wild — accept either
    twitterTitle: metaContent('meta[name="twitter:title" i]') || metaContent('meta[property="twitter:title" i]'),
    twitterDescription: metaContent('meta[name="twitter:description" i]') || metaContent('meta[property="twitter:description" i]'),
    twitterImage: metaContent('meta[name="twitter:image" i]') || metaContent('meta[property="twitter:image" i]'),
    lang: document.documentElement.getAttribute('lang') || '',
  };

  // ---- meta-level signal scan -----------------------------------------------------------------------
  const metaFlags = [];
  const html = document.documentElement.outerHTML;
  const analyticsHit = /\bG-[A-Z0-9]{6,}\b|gtag\(|googletagmanager|GTM-[A-Z0-9]+|fbq\(|connect\.facebook\.net|hotjar|hjid|__GA_ID/.test(html);
  const verifyMetas = Array.prototype.map.call(
    document.querySelectorAll('meta[name*="site-verification" i], meta[name*="verification" i]'),
    (m) => ({ name: m.getAttribute('name'), content: m.getAttribute('content') })
  );
  if (analyticsHit) metaFlags.push('analytics-id');
  if (verifyMetas.length) metaFlags.push('verification-id');

  // forms
  const forms = Array.prototype.map.call(document.querySelectorAll('form[action]'), (f) => ({
    cssPath: cssPath(f), nth: nthAmong(f, cssPath(f)),
    action: f.getAttribute('action') || '',
    sectionAnchor: sectionAnchorOf(f),
    role: classifyRole(f),
    bbox: isDisplayNone(f) ? null : bbox(f),
    crossOrigin: isCrossOrigin(f.getAttribute('action') || ''),
  }));

  // cross-origin iframes (embeds)
  const embeds = Array.prototype.map.call(document.querySelectorAll('iframe[src]'), (f) => ({
    cssPath: cssPath(f), nth: nthAmong(f, cssPath(f)),
    src: f.getAttribute('src') || '',
    sectionAnchor: sectionAnchorOf(f),
    role: classifyRole(f),
    bbox: isDisplayNone(f) ? null : bbox(f),
    crossOrigin: isCrossOrigin(f.getAttribute('src') || ''),
  }));

  // data-driven-but-empty content elements (framework data markers, no text/children)
  const dataDriven = [];
  for (const el of document.querySelectorAll('[data-bind],[v-for],[ng-repeat],[data-component],[data-react-root],[data-server-rendered]')) {
    if (!norm(el.textContent || '') && el.children.length === 0) {
      dataDriven.push({ cssPath: cssPath(el), nth: nthAmong(el, cssPath(el)), sectionAnchor: sectionAnchorOf(el), role: classifyRole(el) });
    }
  }

  return { atoms, metaFlags, verifyMetas, forms, embeds, dataDriven, title: document.title, seo };
}

// ----------------------------------------------------------------------------------------------------
// Capture one viewport: launch context, freeze, walk. Returns the page-extract payload.
// Reuses run-fidelity scroll-assert-with-retry + WebGL new-frame wait + deterministic video seek.
// ----------------------------------------------------------------------------------------------------
async function captureViewport(browser, url, width, mirrorOrigin) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 }, deviceScaleFactor: 1,
    colorScheme: 'light', reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  await page.addInitScript(FRAME_HOOK);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  // reload once if a service worker is present (let SW take control), like run-fidelity does.
  const hasSW = await page.evaluate(() => 'serviceWorker' in navigator && !!navigator.serviceWorker.controller).catch(() => false);
  const swRegistered = await page.evaluate(() => /serviceWorker\.register/.test(document.documentElement.outerHTML)).catch(() => false);
  if (hasSW || swRegistered) { await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {}); }

  // FREEZE: pause every <video> + currentTime=0; pause gsap global timeline; settle ~300ms.
  await page.evaluate(() => {
    document.querySelectorAll('video').forEach((v) => { try { v.pause(); v.currentTime = 0; } catch (e) {} });
    try { if (window.gsap && window.gsap.globalTimeline) window.gsap.globalTimeline.pause(); } catch (e) {}
  }).catch(() => {});

  // scroll-assert-with-retry to top (deterministic landing), then wait a new WebGL frame if any.
  const targetY = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), targetY);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const landed = await page.evaluate(() => window.scrollY);
    if (Math.abs(landed - targetY) <= 2) break;
  }
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForFunction((t) => (window.__frameDrawnAt || 0) > t, t0, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300); // settle

  const payload = await page.evaluate(pageExtract, mirrorOrigin);
  await ctx.close();
  return payload;
}

// ----------------------------------------------------------------------------------------------------
// area-based byte budget for a media slot (deterministic from w*h).
// ----------------------------------------------------------------------------------------------------
function areaBudget(w, h, format) {
  const area = Math.max(1, (w || 0) * (h || 0));
  if (format === 'svg') return 64 * 1024;
  if (format === 'mp4' || format === 'webm') return Math.round(area * 4); // video heavier
  // webp images: ~0.6 bytes/px, floor 8KB
  return Math.max(8 * 1024, Math.round(area * 0.6));
}

// ----------------------------------------------------------------------------------------------------
// Same-content grouping — slots sharing a logical value (normalized text, or media basename) get a shared
// groupId so the editor can "change all N at once". Deterministic (id from sorted member clIds).
// ----------------------------------------------------------------------------------------------------
const GROUP_STOPWORDS = new Set(['menu', 'home', 'close', 'more', 'next', 'prev', 'previous', 'read more', 'learn more', 'submit', 'search', 'back', 'open', 'login', 'log in', 'sign in', 'sign up', 'contact', 'about', 'yes', 'no', 'ok', 'apply', 'apply now']);
function groupKeyOf(s) {
  if (s.type === 'text') {
    const t = normText(s.currentValue || '').toLowerCase();
    if (t.length < 3 || GROUP_STOPWORDS.has(t) || /^[\d\s\W]+$/.test(t)) return null;
    return 'text|' + t;
  }
  if (s.type === 'img' || s.type === 'bg' || s.type === 'video' || s.type === 'icon') {
    const ref = s.currentValueRef || s.currentValue || '';
    const base = String(ref).split(/[?#]/)[0].split('/').pop();
    if (!base || base.length < 2) return null;
    return s.type + '|' + base;
  }
  return null;
}
function assignGroups(slots) {
  const groups = new Map();
  for (const s of slots) { const k = groupKeyOf(s); if (!k) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const gid = 'g-' + shortSha('group|' + members.map((m) => m.clId).sort().join(','), 8);
    members.forEach((m, i) => { m.groupId = gid; m.groupRole = i === 0 ? 'primary' : 'member'; (m.flags = m.flags || []).push('grouped'); });
  }
}
// A content original is "blocking" until kept or replaced; advanced (gradient/pseudo) slots never block.
const isBlockingSlot = (s) => s.provenance === 'original' && !s.keep && !s.replacement && s.role === 'content' && !(s.flags || []).some((f) => String(f).startsWith('advanced:'));

// Carry forward user edits from a prior manifest by clId (then stableId). Returns {carried, unmatched}.
function mergeEdits(slots, prior) {
  const byCl = new Map(), bySid = new Map();
  for (const s of (prior.slots || [])) { if (s.clId) byCl.set(s.clId, s); if (s.stableId) bySid.set(s.stableId, s); }
  let carried = 0, unmatched = 0; const matched = new Set();
  for (const s of slots) {
    const old = (s.clId && byCl.get(s.clId)) || (s.stableId && bySid.get(s.stableId));
    if (old && (old.replacement || old.keep || old.provenance === 'user')) {
      s.replacement = old.replacement || null; s.keep = !!old.keep;
      s.provenance = old.provenance || (s.replacement ? 'user' : 'original');
      carried++; matched.add(old);
    }
  }
  for (const s of (prior.slots || [])) { if ((s.replacement || s.keep || s.provenance === 'user') && !matched.has(s)) unmatched++; }
  return { carried, unmatched };
}

// ----------------------------------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  const outDir = args.out;
  const name = args.name;
  if (!url || !outDir || !name) {
    console.error('usage: node extract-manifest.mjs --url <mirrorUrl> --out <repurposeDir> --name <name> [--viewports 390,768,1440] [--crawl-log <path>] [--now <iso>]');
    process.exit(1);
  }
  const viewports = (typeof args.viewports === 'string' ? args.viewports : '390,768,1440')
    .split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n));
  if (!viewports.length) { console.error('no valid --viewports'); process.exit(1); }
  const now = typeof args.now === 'string' ? args.now : null; // determinism: only from --now
  const crawlLogPath = typeof args['crawl-log'] === 'string' ? args['crawl-log'] : null;

  const mirrorOrigin = (() => { try { return new URL(url).origin; } catch (e) { return url; } })();

  // ---- capture each viewport ----
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const perVp = {}; // width -> payload
  for (const w of viewports) {
    perVp[w] = await captureViewport(browser, url, w, mirrorOrigin);
  }
  await browser.close();

  // Use the widest viewport as the canonical document-order spine (most elements present).
  const widest = Math.max(...viewports);
  const spine = perVp[widest];

  // ---- build a merge key per atom so the SAME element across viewports => ONE slot ----
  // Key = kind + sectionAnchor + cssPath + nth + contentSig (stable on a frozen mirror).
  function atomKey(a) { return [a.kind, a.sectionAnchor, a.cssPath, a.nth, a.contentSig].join('||'); }

  // index every viewport's atoms by key
  const vpIndex = {}; // width -> Map(key -> atom)
  for (const w of viewports) {
    const m = new Map();
    for (const a of perVp[w].atoms) m.set(atomKey(a), a);
    vpIndex[w] = m;
  }

  // canonical atom list: spine order, but include any atom that appears in ANY viewport (e.g. mobile-only).
  const seen = new Set();
  const canonical = [];
  for (const a of spine.atoms) { const k = atomKey(a); if (!seen.has(k)) { seen.add(k); canonical.push(a); } }
  for (const w of viewports) {
    if (w === widest) continue;
    for (const a of perVp[w].atoms) { const k = atomKey(a); if (!seen.has(k)) { seen.add(k); canonical.push(a); } }
  }

  // ---- repeat group sha: derive a stable group id from the representative's contentSig + parent path ----
  // The in-page detector tagged repeat={sig,index,count}; we only kept index 0 (representative) atoms,
  // so fold to a single template instance per group with repeat={group,index:0,count}.
  function groupShaFor(a) {
    if (!a.repeat) return null;
    // group anchored by section + class signature => stable across runs
    return shortSha('group|' + a.sectionAnchor + '|' + a.repeat.sig + '|' + a.repeat.count);
  }

  // ---- assign numbers + build slots ----
  const slots = [];
  let number = 0;
  const usedStableIds = new Map();
  for (const a of canonical) {
    number += 1;
    const sa = a.sectionAnchor;
    let stableId = a.kind + '-' + shortSha(sa + '|' + a.kind + '|' + normText(a.currentValue));
    // Disambiguate identical-content siblings (e.g. per-letter logo spans, repeated inline-svg) so stableId
    // stays UNIQUE (validate-manifest requires it). canonical order is deterministic → the occurrence suffix
    // is stable across runs. clId (below) is already document-wide unique and is the editor's real locator.
    { const seen = (usedStableIds.get(stableId) || 0) + 1; usedStableIds.set(stableId, seen); if (seen > 1) stableId += '-' + seen; }
    // clId — document-wide stable anchor (12 hex). Primary locator for runtime + build; stamped as
    // data-cl-id so edits survive DOM-order churn / React re-render. Content+path+order derived (deterministic).
    const clId = shortSha('cl|' + sa + '|' + a.kind + '|' + a.contentSig + '|' + a.cssPath + '|' + (a.nth || 0) + '|' + a.docOrder, 12);
    const sourceAnchor = 'data-slot="s' + String(number).padStart(3, '0') + '"';

    // type mapping
    let type = a.kind;
    if (a.kind === 'svg') type = 'svg';
    // subtype
    let subtype = a.subtype || '';

    // tri-locator bbox keyed per viewport (omit a viewport when display:none there)
    const bboxByVp = {};
    for (const w of viewports) {
      const m = vpIndex[w];
      const hit = m.get(atomKey(a));
      if (hit && Array.isArray(hit.bbox)) bboxByVp[String(w)] = hit.bbox;
    }

    // breakpointScope: src differs per viewport (media)
    const breakpointScope = {};
    if (a.kind === 'img' || a.kind === 'bg' || a.kind === 'video') {
      let lastKey = null, varies = false;
      const srcOf = (x) => x ? (x.src || x.bgUrl || (x.sources && x.sources[0] && x.sources[0].src) || '') : '';
      for (const w of viewports) {
        const hit = vpIndex[w].get(atomKey(a));
        if (!hit) continue;
        const sv = srcOf(hit);
        breakpointScope[String(w)] = sv;
        if (lastKey !== null && sv !== lastKey) varies = true;
        lastKey = sv;
      }
      if (!varies) { for (const k of Object.keys(breakpointScope)) delete breakpointScope[k]; }
    }

    // contentHash for locator
    const contentHash = shortSha(a.contentSig);

    const slot = {
      number,
      stableId,
      clId,
      type,
      subtype,
      alt: (a.kind === 'img' && a.alt != null) ? String(a.alt) : undefined,   // editable alt text (a11y + SEO)
      role: a.role,
      mirrorLocator: {
        clId,
        cssPath: a.cssPath,
        nth: a.nth || 0,
        contentHash,
        bbox: bboxByVp,
      },
      sourceAnchor,
      provenance: 'original',
      authorization: null,
      currentValue: a.currentValue != null ? String(a.currentValue) : null,
      currentValueRef: null,
      href: a.href || null,                 // editable link target (anchor/button) — null for non-links
      replacement: null,
      keep: false,
      repeat: null,
      flags: Array.isArray(a.flags) ? a.flags.slice() : [],
    };

    // currentValueRef for media (mirror:// path)
    if (a.kind === 'img' && a.src) slot.currentValueRef = 'mirror://' + a.src.replace(/^https?:\/\/[^/]+/, '');
    else if (a.kind === 'bg' && a.bgUrl) slot.currentValueRef = 'mirror://' + a.bgUrl.replace(/^https?:\/\/[^/]+/, '');
    else if (a.kind === 'video' && a.sources && a.sources[0]) slot.currentValueRef = 'mirror://' + a.sources[0].src.replace(/^https?:\/\/[^/]+/, '');
    else if (a.kind === 'svg' && a.svgImg && a.src) slot.currentValueRef = 'mirror://' + a.src.replace(/^https?:\/\/[^/]+/, '');

    // repeat fold
    if (a.repeat) {
      slot.repeat = { group: groupShaFor(a), index: 0, count: a.repeat.count };
    }

    // computed
    if (a.kind === 'text' && a.computed) {
      slot.computed = { fontFamily: a.computed.fontFamily, color: a.computed.color, fontSize: a.computed.fontSize };
    } else if ((a.kind === 'img' || (a.kind === 'svg' && a.svgImg)) && Array.isArray(a.naturalDims)) {
      slot.computed = { naturalDims: a.naturalDims.map((n) => Math.round(n || 0)) };
    }

    // slotSpec per media slot per viewport (w/h from bbox; cover; focal center; format by type; area budget)
    if (a.kind === 'img' || a.kind === 'bg' || a.kind === 'svg' || a.kind === 'video') {
      const format = a.kind === 'svg' ? 'svg' : (a.kind === 'video' ? 'mp4' : 'webp');
      const spec = {};
      for (const w of viewports) {
        const bb = bboxByVp[String(w)];
        if (!bb) continue;
        const ww = Math.round(bb[2]); const hh = Math.round(bb[3]);
        spec[String(w)] = { w: ww, h: hh, fit: 'cover', focal: [0.5, 0.5], format, maxBytes: areaBudget(ww, hh, format) };
      }
      if (Object.keys(spec).length) slot.slotSpec = spec;
    }

    if (Object.keys(breakpointScope).length) slot.breakpointScope = breakpointScope;

    // text with element children: edit DIRECT text nodes only (don't nuke nested <span> etc.)
    if (a.kind === 'text' && a.directOnly) slot.directOnly = true;
    // media: carry srcset / picture / poster / sources so swaps REBUILD instead of stripping responsiveness
    if (a.srcsetSpec) slot.srcsetSpec = a.srcsetSpec;
    if (a.posterRef) slot.posterRef = a.posterRef;
    if (a.sourcesSpec) slot.sourcesSpec = a.sourcesSpec;
    if (a.advanced) slot.advanced = a.advanced;

    slots.push(slot);
  }

  // ---- meta-level flag slots: forms (form-action), analytics/verification (meta), embeds, data-driven ----
  // Forms: emit a section-typed slot per form carrying form-action (and embed/cross-origin where relevant).
  const metaFlagsAgg = new Set();
  for (const w of viewports) for (const f of (perVp[w].metaFlags || [])) metaFlagsAgg.add(f);

  // forms (dedupe by cssPath across viewports)
  const formSeen = new Set();
  for (const w of viewports) {
    for (const f of (perVp[w].forms || [])) {
      const fk = 'form|' + f.cssPath + '|' + f.nth;
      if (formSeen.has(fk)) continue;
      formSeen.add(fk);
      number += 1;
      const flags = ['form-action'];
      if (f.crossOrigin) flags.push('cross-origin:not-mirrored');
      const bboxByVp = {};
      for (const vw of viewports) {
        const hit = (perVp[vw].forms || []).find((x) => x.cssPath === f.cssPath && x.nth === f.nth);
        if (hit && Array.isArray(hit.bbox)) bboxByVp[String(vw)] = hit.bbox;
      }
      slots.push({
        number,
        stableId: 'form-' + shortSha(f.sectionAnchor + '|form|' + f.action),
        type: 'section',
        subtype: '',
        role: f.role,
        mirrorLocator: { cssPath: f.cssPath, nth: f.nth || 0, contentHash: shortSha('form|' + f.action), bbox: bboxByVp },
        sourceAnchor: 'data-slot="s' + String(number).padStart(3, '0') + '"',
        provenance: 'original',
        authorization: null,
        currentValue: f.action,
        currentValueRef: null,
        replacement: null,
        keep: false,
        repeat: null,
        flags,
        notes: 'form[action] — re-point on repurpose',
      });
    }
  }

  // embeds (cross-origin iframes)
  const embedSeen = new Set();
  for (const w of viewports) {
    for (const e of (perVp[w].embeds || [])) {
      const ek = 'embed|' + e.cssPath + '|' + e.nth;
      if (embedSeen.has(ek)) continue;
      embedSeen.add(ek);
      if (!e.crossOrigin) continue;
      number += 1;
      slots.push({
        number,
        stableId: 'embed-' + shortSha(e.sectionAnchor + '|embed|' + e.src),
        type: 'section',
        subtype: '',
        role: e.role,
        mirrorLocator: { cssPath: e.cssPath, nth: e.nth || 0, contentHash: shortSha('embed|' + e.src), bbox: {} },
        sourceAnchor: 'data-slot="s' + String(number).padStart(3, '0') + '"',
        provenance: 'original',
        authorization: null,
        currentValue: e.src,
        currentValueRef: null,
        replacement: null,
        keep: false,
        repeat: null,
        flags: ['embed:cross-origin'],
      });
    }
  }

  // data-driven empties
  const ddSeen = new Set();
  for (const w of viewports) {
    for (const d of (perVp[w].dataDriven || [])) {
      const dk = 'dd|' + d.cssPath + '|' + d.nth;
      if (ddSeen.has(dk)) continue;
      ddSeen.add(dk);
      number += 1;
      slots.push({
        number,
        stableId: 'data-' + shortSha(d.sectionAnchor + '|data|' + d.cssPath),
        type: 'section',
        subtype: '',
        role: d.role,
        mirrorLocator: { cssPath: d.cssPath, nth: d.nth || 0, contentHash: shortSha('data|' + d.cssPath), bbox: {} },
        sourceAnchor: 'data-slot="s' + String(number).padStart(3, '0') + '"',
        provenance: 'original',
        authorization: null,
        currentValue: null,
        currentValueRef: null,
        replacement: null,
        keep: false,
        repeat: null,
        flags: ['data-driven:not-mirrored'],
      });
    }
  }

  // ---- build fingerprint -----------------------------------------------------------------------------
  // buildId = sha of crawl-log if provided, else sha of the mirror index.html.
  let crawlLogHash = '';
  let buildId = '';
  if (crawlLogPath && await exists(crawlLogPath)) {
    const cl = await readFile(crawlLogPath, 'utf8');
    crawlLogHash = sha1(cl);
    buildId = shortSha('crawl|' + crawlLogHash, 12);
  } else {
    // fetch the served index.html for a content-derived build id (deterministic on a frozen mirror)
    let indexHtml = '';
    try {
      const res = await fetch(url);
      indexHtml = await res.text();
    } catch (e) { indexHtml = url; }
    buildId = shortSha('index|' + sha1(indexHtml), 12);
    crawlLogHash = ''; // none
  }
  const buildFingerprint = buildId + '+' + crawlLogHash;

  // ---- same-content grouping (change-all-N) ----------------------------------------------------------
  assignGroups(slots);

  // ---- overwrite/merge safety: never silently clobber a manifest that has user edits ----------------
  const manifestPath = join(outDir, 'manifest.json');
  let prior = null;
  try { prior = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
  const priorEdits = prior && Array.isArray(prior.slots) ? prior.slots.filter((s) => s.replacement || s.keep || s.provenance === 'user') : [];
  if (priorEdits.length && !args.merge && !args.force) {
    console.error(`extract-manifest: ${manifestPath} has ${priorEdits.length} user edit(s). Re-run with --merge to carry them forward, or --force to overwrite.`);
    process.exit(2);
  }
  if (priorEdits.length && args.merge) { const mr = mergeEdits(slots, prior); console.error(`extract-manifest --merge: carried ${mr.carried} edit(s) forward, ${mr.unmatched} unmatched.`); }

  // ---- counts ----------------------------------------------------------------------------------------
  const content = slots.filter((s) => s.role === 'content').length;
  const chrome = slots.filter((s) => s.role === 'chrome').length;
  const grouped = slots.filter((s) => s.groupId).length;
  const blocking = slots.filter(isBlockingSlot).length;
  const counts = { total: slots.length, content, chrome, grouped, blocking };

  // ---- SEO: original head captured from the spine viewport; `replacement` holds the user's overrides ----
  const seoOriginal = (spine && spine.seo) || {};

  // ---- assemble manifest -----------------------------------------------------------------------------
  const manifest = {
    meta: {
      target: url,
      name,
      schemaVersion: '1.1',
      generatedBy: VERSION,
      generatedAtRef: now,
      mirrorRoot: mirrorOrigin,
      buildFingerprint,
      crawlLogHash,
      viewports,
      structureAuthorization: 'unset',
      seo: { original: seoOriginal, replacement: {} },   // editor writes overrides into replacement; build emits merged
      counts,
    },
    slots,
  };

  // ---- write outputs ---------------------------------------------------------------------------------
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(outDir, 'manifest.lock.json'), JSON.stringify({ schema: 1, applied: [] }, null, 2) + '\n');
  await writeFile(join(outDir, 'build-fingerprint.json'), JSON.stringify({ buildId, crawlLogHash }, null, 2) + '\n');

  // ---- stdout JSON summary ---------------------------------------------------------------------------
  const summary = {
    ok: true,
    name,
    out: outDir,
    viewports,
    buildFingerprint,
    counts,
    metaFlags: Array.from(metaFlagsAgg),
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exit(0);
}

main().catch((e) => { console.error('EXTRACT FATAL', e && e.stack || e); process.exit(1); });
