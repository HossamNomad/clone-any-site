# Launch Prompt — paste into the agent's PLAN mode

Replace `<TARGET_URL>`. Keep it in PLAN mode first so the generated cahier des charges can be reviewed
before any code is written.

```
ROLE
You are a senior creative-engineering lead. Operate in PLAN MODE: produce a complete, wave-based cahier des charges for human validation BEFORE writing code. Where the live site must be re-checked, say so as a plan task.

OBJECTIVE
Clone <TARGET_URL> to a genuinely high fidelity bar, then repurpose it as my own, in TWO phases:
- Phase C — a faithful 1:1 INTERNAL replica produced by MIRRORING the site's real compiled build (run their actual bundle + assets locally, loopback only, never deployed publicly). This is the reference + the proof of fidelity.
- Phase B — a clean reusable engine WRITTEN FROM SCRATCH against a fresh, version-matched stack, then my own content swapped in (3D object/copy/branding/licensed fonts). This is the ONLY public-shippable artifact.
Sequence: C first, then B.

RECON FIRST (verify live; trust nothing assumed)
Use a real browser (chrome-devtools MCP) + Firecrawl to: detect the framework + animation stack (React Three Fiber / three / GSAP / Lenis / WebGL / Next.js, etc.); enumerate EVERY network asset (HTML, JS chunks, CSS, fonts, images, any .glb/HDRI/decoder, video); read exact design tokens (colors/fonts/spacing) via Firecrawl `branding`; map the scroll choreography by stepping through scroll depths; capture the EXACT shape of any form submit, any seekable <video> (scroll->currentTime), and the frameloop mode. Write capture-preconditions.json + asset-manifest.json + effects-inventory.md. Correct any stale assumptions against the live DOM.

MIRROR (Phase C)
Crawl the full static graph with the bundled crawl.mjs (or wget --mirror if available — never hang on an interactive installer). Vendor runtime-only third-party assets (decoder, HDRI) locally. Absolute->relative is rewritten by the crawler. Stub backend form POSTs via the service worker (sw.template.js -> 200 JSON). Serve on 127.0.0.1 only (serve.mjs) and verify it renders identically.

FIDELITY GATE (prove it)
Run the bundled run-fidelity.mjs (Playwright + pixelmatch + ssim.js). Pin viewport + deviceScaleFactor:1 + light + reduced-motion + sRGB for BOTH targets. Per depth: set scroll instant + ASSERT scrollY; wait for a NEW rendered WebGL frame (hook draw calls -> window.__frameDrawnAt), not a timeout; pause+seek every <video> deterministically. Compute maxScroll at runtime on both; mask scrollbar/video. Score pixelmatch{threshold:0.1} AND ssim per depth; classify micro-noise vs structural-break. Gate = floor-derived: measure ref-vs-ref and mirror-vs-mirror, floor=min(means); PASS = every depth >= floor-0.03, mean >= max(0.95, floor-0.01), no depth < 0.85, zero structural breaks. Emit the fidelity report + per-depth images.

PHASE B (after a HARD human pause for: brand + hero object + copy + 3D source)
Write the engine fresh (you usually cannot reuse minified code): resolve the 3D stack versions at execution time and verify the R3F major matches the React major; build a fixed full-viewport canvas behind scrolling DOM; one rAF owner feeding a scroll-progress store (never React state); imperative useFrame scrub; match the original frameloop mode. Swap MY 3D object/copy/branding; vendor the decoder + a CC0 HDRI locally; use OFL/licensed fonts only. Lighthouse + a font-leak grep gate (no original paid-font names in the public bundle) must pass.

HARD CONSTRAINTS
- The 1:1 mirror is INTERNAL/loopback only; NEVER deploy it publicly under the original brand. Gitignore the mirror payload AND exclude it from deploy ignore-files.
- Public Phase B requires licensed or substitute fonts + my own copy/branding/3D object. Zero original-paid-font leakage.
- Never edit minified chunks (use a service worker). Never hang on interactive installers.
- Run autonomously EXCEPT pause for a human at: the C->B boundary, any public deploy, spending money, force-pushing, or anything irreversible.

PLAN FORMAT
Wave-based (Recon -> Mirror -> Fidelity-Gate -> Engine -> Repurpose -> Verify). Each task: id, deps, concrete deliverable, explicit verify step, owner (AUTO or HUMAN-PAUSE). Tooling decision table. Risks + mitigations. Acceptance gate per phase. Ask clarifying questions only if truly blocking; otherwise state assumptions and produce the full plan.
```
