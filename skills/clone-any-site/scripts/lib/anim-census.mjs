// anim-census.mjs — animation census for clone fidelity.
// Enumerates every animation on a page so an asset swap that silently kills
// motion is caught. Shared by the visual-map builder and the verifier.
//
// Two exports:
//   pageCensus()  — pure-DOM, runs INSIDE the browser via page.evaluate.
//                   MUST NOT reference any outside variable/import (it is
//                   serialized and shipped to the page).
//   runCensus(url, opts) — launches chromium, samples the census over time,
//                   merges (element-wise MAX for numbers, UNION for arrays).

import { chromium } from 'playwright';

/**
 * Census of a page's animations. Runs in the browser (page.evaluate).
 * Pure DOM only — no node APIs, no closures over module scope.
 * @returns {object} census
 */
export function pageCensus() {
  var SCAN_CAP = 4000; // cap reveal heuristic for perf on huge DOMs
  var SEL_CAP = 40;    // max locked selectors returned

  var all = document.querySelectorAll('*');

  var cssAnim = 0;
  var cssTransition = 0;
  var reveals = 0;

  // selectors of animated elements (CSS-animated or WAAPI-animated), de-duped
  var seen = {};
  var lockedSelectors = [];

  function shortSelector(el) {
    if (!el || !el.tagName) return '';
    var tag = el.tagName.toLowerCase();
    var sel = tag;
    if (el.id) {
      // CSS.escape may be missing in very old engines — guard it.
      var id = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(el.id) : el.id;
      sel += '#' + id;
      return sel;
    }
    if (el.classList && el.classList.length) {
      var c = el.classList[0];
      if (c) {
        var cls = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(c) : c;
        sel += '.' + cls;
      }
    }
    return sel;
  }

  function pushSelector(el) {
    if (lockedSelectors.length >= SEL_CAP) return;
    var s = shortSelector(el);
    if (!s || seen[s]) return;
    seen[s] = 1;
    lockedSelectors.push(s);
  }

  // ---- CSS animations / transitions + reveal heuristic ----
  var scanLen = Math.min(all.length, SCAN_CAP);
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      continue;
    }
    if (!cs) continue;

    var animated = cs.animationName && cs.animationName !== 'none';
    if (animated) {
      cssAnim++;
      pushSelector(el);
    }

    var hasTransition = cs.transitionDuration && cs.transitionDuration !== '0s';
    if (hasTransition) cssTransition++;

    // reveal heuristic — only over the first SCAN_CAP elements for perf
    if (i < scanLen && hasTransition) {
      var isHidden = parseFloat(cs.opacity) === 0;
      var transformed = cs.transform && cs.transform !== 'none';
      if (isHidden || transformed) reveals++;
    }
  }

  // ---- WAAPI ----
  var waapi = document.getAnimations ? document.getAnimations().length : 0;

  // lock WAAPI-animated elements too
  if (document.getAnimations) {
    var anims = document.getAnimations();
    for (var a = 0; a < anims.length; a++) {
      if (lockedSelectors.length >= SEL_CAP) break;
      var tgt = anims[a] && anims[a].effect && anims[a].effect.target;
      if (tgt && tgt.tagName) pushSelector(tgt);
    }
  }

  // ---- videos ----
  var vids = document.querySelectorAll('video');
  var videos = vids.length;
  var videosPlaying = 0;
  for (var v = 0; v < vids.length; v++) {
    var vid = vids[v];
    if (!vid.paused && !vid.ended && vid.readyState > 2) videosPlaying++;
  }

  // ---- canvas ----
  var canvas = document.querySelectorAll('canvas').length;

  // ---- library sniffing ----
  var libraries = [];
  if (window.gsap) libraries.push('gsap');
  if (window.ScrollTrigger) libraries.push('ScrollTrigger');
  // framer: any window key starting with __framer
  var framer = false;
  try {
    var keys = Object.keys(window);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].indexOf('__framer') === 0) { framer = true; break; }
    }
  } catch (e) {}
  if (framer) libraries.push('framer');
  if (window.Lenis || window.__lenis) libraries.push('lenis');
  if (window.THREE) libraries.push('three');
  if (window.Webflow) libraries.push('webflow-ix2');

  return {
    cssAnim: cssAnim,
    cssTransition: cssTransition,
    waapi: waapi,
    videos: videos,
    videosPlaying: videosPlaying,
    canvas: canvas,
    reveals: reveals,
    libraries: libraries,
    lockedSelectors: lockedSelectors
  };
}

// Numeric fields we merge by MAX across samples.
const NUMERIC_FIELDS = [
  'cssAnim', 'cssTransition', 'waapi',
  'videos', 'videosPlaying', 'canvas', 'reveals'
];

function mergeCensus(acc, next) {
  if (!acc) {
    return {
      cssAnim: next.cssAnim, cssTransition: next.cssTransition, waapi: next.waapi,
      videos: next.videos, videosPlaying: next.videosPlaying, canvas: next.canvas,
      reveals: next.reveals,
      libraries: [...new Set(next.libraries || [])],
      lockedSelectors: [...new Set(next.lockedSelectors || [])]
    };
  }
  for (const f of NUMERIC_FIELDS) {
    acc[f] = Math.max(acc[f] || 0, next[f] || 0);
  }
  acc.libraries = [...new Set([...acc.libraries, ...(next.libraries || [])])];
  acc.lockedSelectors = [...new Set([...acc.lockedSelectors, ...(next.lockedSelectors || [])])];
  return acc;
}

/**
 * Run the census against a live URL, sampling over time and merging.
 * @param {string} url
 * @param {{waitMs?:number, samples?:number[]}} [opts]
 * @returns {Promise<object>} merged census
 */
export async function runCensus(url, opts = {}) {
  const samples = opts.samples || [0, 1000, 3000, 5000];
  // waitMs kept for API compatibility / as an upper-bound expectation.
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  let merged = null;
  try {
    const ctx = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 900 }
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });

    // samples are cumulative offsets from page load; wait the delta each step.
    let prev = 0;
    for (const offset of samples) {
      const delta = offset - prev;
      if (delta > 0) await page.waitForTimeout(delta);
      prev = offset;
      const c = await page.evaluate(pageCensus);
      merged = mergeCensus(merged, c);
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
  return merged;
}
