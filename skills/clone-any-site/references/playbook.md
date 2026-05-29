# Clone-Any-Site Playbook — pixel-perfect, then repurpose

The full method behind the `clone-any-site` skill. Battle-tested on a real WebGL / React-Three-Fiber +
drei + Lenis + Next.js landing page: recon → pixel-perfect local mirror → fidelity gate → reusable engine.
Adapt the wave depth to the site's complexity (a static marketing page is far simpler than a WebGL scroll experience).

> **Honest framing:** modern marketing sites are often WebGL/3D scroll experiences (React Three Fiber,
> GSAP, Lenis, WebGL shaders). Those **cannot be hand-rebuilt "pixel-perfect"** in reasonable time — the
> only faithful 1:1 is to **mirror the site's real compiled build and run it locally**. Then you build a
> clean reusable engine and swap in *your own* content. Two phases, in this order.

---

## 0. Setup — what to install

**MCP servers / tools (the engine of the recon):**
- **chrome-devtools MCP** — drive a real browser: screenshots, DOM snapshots, `evaluate_script` (read exact
  computed CSS, detect the stack), network capture, scroll, hover. This is how you *recon* and *verify*.
- **Firecrawl** (MCP or CLI) — `firecrawl_map` (enumerate every URL), `firecrawl_scrape` with the
  **`branding`** format (extracts exact colors / fonts / spacing automatically).
- **Playwright** — committed, repeatable captures + the fidelity harness. Needed only for the gate.
  `npm i -D playwright pixelmatch pngjs ssim.js && npx playwright install chromium`

**Bundled scripts (in this skill's `scripts/`):**
- `crawl.mjs` — pure-Node recursive crawler, **zero deps** (works where wget is unavailable; never hangs on an installer).
- `serve.mjs` — zero-dep loopback static server with Range support + auto SW registration.
- `run-fidelity.mjs` — the Playwright + pixelmatch + ssim.js fidelity gate.
- `sw.template.js` — the offline-shim template (form stub + optional 3D/decoder/HDRI/image redirects).

**Agent skills/plugins (quality multipliers, optional):**
- **superpowers** — brainstorm → plan → execute → verify. Forces a design + plan before code.
- **ultra-plan** — deep cloud plan for the cahier des charges.
- **frontend-design** + **impeccable** — production-grade rebuild + pixel-polish for the repurpose phase.

**External mirror tools (alternatives to the bundled crawler):**
- `wget --mirror --convert-links --page-requisites --adjust-extension` — robust, no quota (cleanest when present; **not on Windows by default**).
- `monolith` (single-file inline) — great for simple static pages; **breaks** WebGL/module sites.

---

## 1. Method

### Phase C — faithful 1:1 mirror (INTERNAL reference)
1. **Recon (don't trust assumptions — verify live).** With chrome-devtools: detect the framework
   (`window.__NEXT_DATA__`, R3F/`three`, `gsap`, `lenis`, etc.), enumerate every network asset, read computed
   tokens, map the scroll choreography by stepping through scroll depths, capture any 3D model URL (`.glb`),
   HDRI, decoder (DRACO), and **the exact behavior of forms/video/animations**. Write it to
   `capture-preconditions.json` + `asset-manifest.json` + `effects-inventory.md`.
2. **Mirror the compiled build.** `crawl.mjs` grabs HTML + JS chunks + CSS + fonts + images + the `.glb`.
   Vendor runtime-only third-party assets (decoder, HDRI) locally. Absolute→relative is rewritten for you.
   **Stub** any backend form via the service worker (`sw.template.js` returns 200 JSON).
3. **Serve on loopback only** (`serve.mjs`, `127.0.0.1`), never publicly. The mirror runs *their* compiled
   bundle → the 3D + animations are byte-identical because it is literally their code.
4. **Prove it with the fidelity gate** (§2).

### Phase B — reusable engine + your repurpose (the shippable)
5. **Write a clean engine from scratch** against a fresh, version-matched stack (you usually *cannot* extract
   usable code from minified chunks). Reproduce the effect vocabulary (pinned canvas, scroll-progress store,
   `useFrame` scrub, smooth-scroll).
6. **Swap your content:** your 3D object, copy, branding, images, **licensed/substitute fonts**.
7. Verify, then this — and only this — is what you deploy publicly.

---

## 2. The fidelity gate (how to *prove* "pixel-perfect")

100% pixel identity is **unreachable** on WebGL (anti-aliasing dithering, GPU float rounding, HDRI specular
variance, async render timing). So measure **delta from the empirical noise floor**, not a magic number. The
bundled `run-fidelity.mjs` implements all of this:

1. Pin capture conditions **identically** for reference and mirror: fixed `viewport` + `deviceScaleFactor:1`
   + `colorScheme:light` + `reducedMotion:reduce` + sRGB color profile + hidden scrollbars.
2. **Determinism per scroll depth** — the three traps:
   - **Scroll:** set position with `behavior:'instant'`, then **assert** `window.scrollY` landed (retry on drift).
     Don't assume a `window.lenis` handle exists.
   - **3D demand-frameloop:** after scrolling, **wait for a *new rendered frame*** (hook WebGL draw calls to
     stamp `window.__frameDrawnAt`), never a blind `setTimeout` (you'll screenshot the stale pose).
   - **Seekable `<video>`:** pause every video and set `currentTime` deterministically (await `seeked`) on **both** targets.
3. **Compute `maxScroll` at runtime** on both targets (don't hardcode — viewport/DPR changes reflow it). Mask scrollbar/video regions before scoring.
4. **Two metrics per depth:** `pixelmatch {threshold:0.1}` (% identical) **and** `ssim.js` (structural).
   Classify: high-SSIM + low-%identical = acceptable AA/HDRI **micro-noise**; **low-SSIM = structural break = FAIL**.
5. **Gate = floor-derived:** capture reference twice and mirror twice → `floor = min(mean ref-vs-ref, mean
   mirror-vs-mirror)`. **PASS** = every depth ≥ `floor − 0.03`, mean ≥ `max(0.95, floor − 0.01)`, **no depth
   < 0.85**, **zero structural breaks**. Self-consistency (ref-vs-ref and mirror-vs-mirror must clear the
   floor) proves your capture is deterministic before you trust the cross-comparison.

---

## 3. Hard-won lessons (the traps that cost time)

- **Recon prose lies — re-verify against the live DOM.** Assumed handles (`window.lenis`), "cookie gates", canvas counts are often wrong.
- **A service worker cannot intercept a blob-created Web Worker's cross-origin fetches.** Decoders (e.g. DRACO)
  running in workers will still hit their CDN. Pure-SW "offline" is therefore partial unless you set the
  decoder path locally (which means touching minified code). Usually fine to leave — CDN assets are
  deterministic and open-licensed.
- **The `_next/image` (or any image optimizer) is an SSIM trap.** Live transcodes webp→jpeg@q75; a dumb static
  server serves raw webp → guaranteed pixel diff. Either pre-bake the exact optimizer bytes with a **pinned
  `Accept` header** (used for both reference and mirror) or map to the canonical source and accept it as micro-noise.
- **Fonts are the real legal liability.** Display/body fonts are usually **paid**; trial files are forbidden on
  any reachable server. Internal mirror = study OK; **public repurpose = license or substitute** (OFL stacks:
  condensed-heavy display → *Archivo Black* / *Anton*; neutral grotesque → *Inter*; mono → *Space Mono*).
- **IP posture (do this or regret it):** the 1:1 mirror is **internal/loopback only, never deployed under the
  original brand**. Keep the mirror payload **gitignored** *and* excluded from any deploy ignore-file (a
  catch-all static host will serve any committed file). Only the **repurposed** Phase B artifact — your copy,
  your branding, your 3D object, licensed fonts — ever goes public.

---

## 4. Workflow sequencing (don't wrap — sequence)

`brainstorm/design → ultra-plan (deep cahier des charges) → wave-based execution (recon → mirror → fidelity
gate → engine → repurpose → verify) → adversarial review before any public deploy.`

Run autonomously, but **pause for a human** at: the C→B boundary (you must supply brand + object + copy + 3D
source), any public deploy, spending money (font licenses), and anything irreversible.

---

## 5. Launch Prompt

See `launch-prompt.md` in this folder — paste it into the agent's PLAN mode with `<TARGET_URL>` replaced, to
generate the full wave-based cahier des charges before any code is written.
