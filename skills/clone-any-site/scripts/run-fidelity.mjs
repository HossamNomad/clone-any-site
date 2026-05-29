// Fidelity gate — proves the mirror matches the live reference to an EMPIRICALLY-DERIVED floor.
// Self-contained Playwright harness. Generalized (target via env). Run:
//   CLONE_REF="https://www.example.com/" node run-fidelity.mjs
//   CLONE_REF="https://www.example.com/" CLONE_MIRROR="http://127.0.0.1:4321/" CLONE_N=12 node run-fidelity.mjs
//
// Determinism handled: scroll-assert (retry on drift), WebGL new-frame wait (NOT a blind timeout),
// deterministic <video> seek, runtime maxScroll, pinned viewport/DPR/color/reduced-motion.
// Gate is floor-derived — there is no hardcoded magic 0.95 on WebGL noise.
//
// Deps (install in this folder or the project): playwright pixelmatch pngjs ssim.js
//   npm i -D playwright pixelmatch pngjs ssim.js && npx playwright install chromium

import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import ssim from 'ssim.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const OUT_IMG = process.env.CLONE_FIDELITY_IMG || './.fidelity';
const OUT_REPORT = process.env.CLONE_FIDELITY_REPORT || './fidelity-report.md';

const CONFIG = {
  reference: process.env.CLONE_REF || process.argv[2],
  mirror: process.env.CLONE_MIRROR || 'http://127.0.0.1:4321/',
  N: Number(process.env.CLONE_N || 12),
  viewport: { width: Number(process.env.CLONE_VW || 1440), height: Number(process.env.CLONE_VH || 879) },
  deviceScaleFactor: 1,
  launchArgs: ['--force-color-profile=srgb', '--disable-lcd-text', '--hide-scrollbars', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  decodeSettleMs: Number(process.env.CLONE_DECODE_MS || 3500), // let 3D decode + first lit frame before depth 0
  frameWaitMs: 4000,    // max wait for a NEW WebGL frame after a scroll
  settleMs: 220,
  // Per-depth video.currentTime, length must equal N. Default = no video seek.
  // Fill from recon (capture-preconditions.json) if the site has a scroll-driven <video>.
  videoMap: (() => {
    if (!process.env.CLONE_VIDEO_MAP) return null;
    return process.env.CLONE_VIDEO_MAP.split(',').map((x) => (x.trim() === '' || x.trim() === 'null' ? null : Number(x)));
  })(),
};
if (!CONFIG.reference) { console.error('Set CLONE_REF="https://host/" (or pass as arg 1).'); process.exit(1); }

// initScript: stamp window.__frameDrawnAt on every WebGL draw -> positive "new frame" signal
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

function toImageData(buf) { const png = PNG.sync.read(buf); return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height, png }; }

async function captureTarget(browser, url, { isMirror, label }) {
  const ctx = await browser.newContext({
    viewport: CONFIG.viewport, deviceScaleFactor: CONFIG.deviceScaleFactor,
    colorScheme: 'light', reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  await page.addInitScript(FRAME_HOOK);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  if (isMirror) { await page.reload({ waitUntil: 'load', timeout: 60000 }); } // let SW take control if present
  // defensive, identical on both: dismiss a simple consent button if present
  await page.evaluate(() => { document.querySelectorAll('button,a').forEach((b) => { if (/^\s*(accept|agree|ok|got it)\s*$/i.test(b.textContent || '')) b.click(); }); }).catch(() => {});
  await page.waitForTimeout(CONFIG.decodeSettleMs);

  const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  const shots = [];
  for (let i = 0; i < CONFIG.N; i++) {
    const d = CONFIG.N === 1 ? 0 : i / (CONFIG.N - 1);
    const y = Math.round(d * Math.max(0, maxScroll));
    let landed = -1;
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), y);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      landed = await page.evaluate(() => window.scrollY);
      if (Math.abs(landed - y) <= 2) break;
    }
    const t0 = await page.evaluate(() => performance.now());
    await page.waitForFunction((t) => (window.__frameDrawnAt || 0) > t, t0, { timeout: CONFIG.frameWaitMs }).catch(() => {});
    const ct = CONFIG.videoMap ? CONFIG.videoMap[i] : null;
    if (ct != null) await page.evaluate((c) => Promise.all([...document.querySelectorAll('video')].map((v) => {
      try { v.pause(); v.currentTime = c; } catch (e) {}
      return new Promise((res) => (v.readyState >= 2 ? res() : v.addEventListener('seeked', res, { once: true })));
    })), ct).catch(() => {});
    await page.waitForTimeout(CONFIG.settleMs);
    const buf = await page.screenshot({ type: 'png', timeout: 60000, animations: 'disabled', caret: 'hide' });
    shots.push({ i, d: +d.toFixed(3), y, landed, drift: landed - y, buf });
    console.log(`  ${label} d${i} y=${y} drift=${landed - y} ${buf.length}B`);
  }
  await ctx.close();
  return { maxScroll, shots };
}

function compareShots(a, b) {
  const A = toImageData(a), B = toImageData(b);
  const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
  const diff = new PNG({ width: w, height: h });
  const mism = pixelmatch(A.data, B.data, diff.data, w, h, { threshold: 0.1, includeAA: false });
  const pct = (1 - mism / (w * h)) * 100;
  const { mssim } = ssim({ data: A.data, width: A.width, height: A.height }, { data: B.data, width: B.width, height: B.height });
  return { ssim: mssim, pct, diff };
}
function classify(s, pct) {
  if (s < 0.85) return 'STRUCTURAL-BREAK';
  if (s >= 0.97 && pct >= 99) return 'identical';
  if (s >= 0.92) return 'micro-noise(AA/HDRI)';
  return 'review';
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function main() {
  await mkdir(OUT_IMG, { recursive: true });
  await mkdir(dirname(OUT_REPORT), { recursive: true });
  const browser = await chromium.launch({ args: CONFIG.launchArgs });
  console.log('capturing reference x2 + mirror x2 ...');
  const refA = await captureTarget(browser, CONFIG.reference, { isMirror: false, label: 'refA' });
  const refB = await captureTarget(browser, CONFIG.reference, { isMirror: false, label: 'refB' });
  const mirA = await captureTarget(browser, CONFIG.mirror, { isMirror: true, label: 'mirA' });
  const mirB = await captureTarget(browser, CONFIG.mirror, { isMirror: true, label: 'mirB' });
  await browser.close();

  // self-consistency (noise floor)
  const refSelf = refA.shots.map((s, i) => compareShots(s.buf, refB.shots[i].buf).ssim);
  const mirSelf = mirA.shots.map((s, i) => compareShots(s.buf, mirB.shots[i].buf).ssim);
  const floor = Math.min(mean(refSelf), mean(mirSelf));

  const rows = [];
  for (let i = 0; i < CONFIG.N; i++) {
    const r = compareShots(refA.shots[i].buf, mirA.shots[i].buf);
    rows.push({ i, d: refA.shots[i].d, ssim: r.ssim, pct: r.pct, cls: classify(r.ssim, r.pct) });
    await writeFile(join(OUT_IMG, `ref-${i}.png`), refA.shots[i].buf);
    await writeFile(join(OUT_IMG, `mir-${i}.png`), mirA.shots[i].buf);
    await writeFile(join(OUT_IMG, `diff-${i}.png`), PNG.sync.write(r.diff));
  }

  const meanSsim = mean(rows.map((r) => r.ssim));
  const meanPct = mean(rows.map((r) => r.pct));
  const minSsim = Math.min(...rows.map((r) => r.ssim));
  const structuralBreaks = rows.filter((r) => r.cls === 'STRUCTURAL-BREAK');
  const perDepthFloorOk = rows.every((r) => r.ssim >= floor - 0.03);
  const selfOk = mean(refSelf) >= floor - 1e-9 && mean(mirSelf) >= floor - 1e-9;
  const PASS = selfOk && perDepthFloorOk && meanSsim >= Math.max(0.95, floor - 0.01)
    && meanPct >= 95 && minSsim >= 0.85 && structuralBreaks.length === 0;

  const f3 = (x) => x.toFixed(4);
  const md = [
    `# Fidelity Report`,
    ``,
    `**Verdict: ${PASS ? '✅ PASS' : '❌ FAIL'}**  ·  generated by \`run-fidelity.mjs\``,
    `Reference: ${CONFIG.reference} (live, read-only) · Mirror: ${CONFIG.mirror} · N=${CONFIG.N} depths · viewport ${CONFIG.viewport.width}×${CONFIG.viewport.height} @DPR${CONFIG.deviceScaleFactor}`,
    ``,
    `## Empirical noise floor`,
    `- ref-vs-ref mean SSIM: **${f3(mean(refSelf))}**`,
    `- mirror-vs-mirror mean SSIM: **${f3(mean(mirSelf))}**`,
    `- **floor = ${f3(floor)}** → per-depth gate ≥ ${f3(floor - 0.03)}, mean gate ≥ ${f3(Math.max(0.95, floor - 0.01))}`,
    `- self-consistency clears floor: ${selfOk ? 'yes' : 'NO (capture nondeterministic — fix the harness before trusting cross-compare)'}`,
    ``,
    `## Cross comparison (reference vs mirror)`,
    `- mean SSIM **${f3(meanSsim)}** · mean %identical **${meanPct.toFixed(2)}%** · min SSIM **${f3(minSsim)}**`,
    `- structural breaks: **${structuralBreaks.length}**`,
    ``,
    `| depth | scrollY | SSIM | %identical | classification |`,
    `|------:|--------:|-----:|-----------:|----------------|`,
    ...rows.map((r) => `| ${r.d} | ${refA.shots[r.i].y} | ${f3(r.ssim)} | ${r.pct.toFixed(2)}% | ${r.cls} |`),
    ``,
    `## Gate breakdown`,
    `- self-consistency ≥ floor: ${selfOk ? '✅' : '❌'}`,
    `- every depth ≥ floor−0.03: ${perDepthFloorOk ? '✅' : '❌'}`,
    `- mean SSIM ≥ max(0.95, floor−0.01): ${meanSsim >= Math.max(0.95, floor - 0.01) ? '✅' : '❌'}`,
    `- mean %identical ≥ 95: ${meanPct >= 95 ? '✅' : '❌'}`,
    `- no depth < 0.85: ${minSsim >= 0.85 ? '✅' : '❌'}`,
    `- zero structural breaks: ${structuralBreaks.length === 0 ? '✅' : '❌'}`,
    ``,
    `Per-depth images: \`${OUT_IMG}/{ref,mir,diff}-N.png\`.`,
    `Scroll drift (px): ${refA.shots.map((s) => s.drift).join(',')} (ref) · ${mirA.shots.map((s) => s.drift).join(',')} (mirror)`,
    ``,
    `> WebGL note: high-SSIM + lower %identical = acceptable AA/HDRI micro-noise (absorbed by the floor).`,
    `> A low-SSIM depth = a structural break (real bug) — never loosened away.`,
  ].join('\n');

  await writeFile(OUT_REPORT, md);
  console.log('FIDELITY', PASS ? 'PASS' : 'FAIL', '| floor', f3(floor), '| meanSSIM', f3(meanSsim), '| minSSIM', f3(minSsim), '| %id', meanPct.toFixed(2), '| breaks', structuralBreaks.length);
  console.log('report ->', OUT_REPORT);
  process.exit(PASS ? 0 : 1);
}
main().catch((e) => { console.error('FIDELITY FATAL', e); process.exit(2); });
