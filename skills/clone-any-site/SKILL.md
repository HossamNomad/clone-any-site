---
name: clone-any-site
description: >-
  Clone any website to a genuinely high fidelity bar (pixel-perfect against an empirical noise floor),
  then repurpose it as your own site. Use this WHENEVER the user wants to clone, copy, replicate, mirror,
  rebuild, or "make a site like" another website — including via the /clone slash command, or when they
  paste a URL and say things like "clone this", "copy this site", "rebuild this landing page", "I want a
  site like this one", "mirror drinksom.eu", or "recreate this WebGL/3D scroll experience". Also triggers
  for "pixel-perfect copy", "fidelity test a clone", or building white-label templates from a reference
  design. Handles static marketing pages AND hard WebGL / React-Three-Fiber / GSAP / Lenis / Next.js
  scroll sites. Drives recon (chrome-devtools + Firecrawl), a loopback-only 1:1 mirror, a measured
  fidelity gate, then a clean-room engine + your-own-content repurpose. Do not hand-rebuild a 3D site from
  guesses — use this skill.
---

# Clone Any Site → then repurpose it as your own

A portable, battle-tested recipe for cloning *any* website to ≥95% measured fidelity, then turning it into
**your own** shippable site. Proven on a live React-Three-Fiber + drei + Lenis + Next.js landing page.

**The core insight:** modern marketing sites are often WebGL/3D scroll experiences. You **cannot**
hand-rebuild those pixel-perfect from guesses. The only faithful 1:1 is to **mirror the real compiled build
and run it on loopback** as a reference, prove fidelity by measurement, then **write a clean engine from
scratch** and swap in your content. Two phases, in this order: **C (mirror) → B (repurpose)**.

## Announce + scope first

Tell the user: *"Using clone-any-site to mirror `<url>` on loopback, prove fidelity, then build your own
version."* Then size the job — a static marketing page is far simpler than a WebGL scroll site:
- **Static / simple** (no canvas, mostly DOM + CSS): mirror + a light fidelity check is often enough; the
  repurpose can be a clean hand-build.
- **WebGL / 3D / heavy-scroll**: full pipeline, mirror their bundle, run the floor-derived fidelity gate.

Default to **PLAN MODE** for anything non-trivial: produce the wave-based cahier des charges (use
`references/launch-prompt.md`) and get it approved before writing code.

## The two phases (never skip the order)

```
Phase C — faithful 1:1 MIRROR (internal, loopback only)   ──►   Phase B — clean engine + YOUR content (the only public artifact)
   Recon → Crawl → Vendor → Stub → Serve → Fidelity gate          Engine from scratch → swap object/copy/brand/fonts → Verify → Deploy
```

## Workflow (waves)

Create a todo per wave. Run autonomously **except** the human-pause points in Hard Constraints.

### Wave 1 — Recon (verify live; trust nothing assumed)
Use **chrome-devtools MCP** + **Firecrawl**. Do not write recon from memory — read the live DOM.
- Detect the stack: `window.__NEXT_DATA__`, `window.React`, R3F/`three`, `gsap`, `lenis`, scroll model.
- Enumerate **every** network asset (HTML, JS chunks, CSS, fonts, images, `.glb`/HDRI/decoder, video) — `firecrawl_map` for URLs, network panel for runtime assets.
- Read exact tokens via `firecrawl_scrape` **`branding`** format (colors / fonts / spacing).
- Map scroll choreography by stepping through depths; capture the exact form-submit shape, any seekable `<video>` (scrollY→currentTime), and the frameloop mode (`always` vs `demand`).
- **Write three recon files** next to the mirror: `capture-preconditions.json`, `asset-manifest.json`, `effects-inventory.md`. Correct any stale assumption against the live DOM.

### Wave 2 — Mirror the compiled build (Phase C)
- Crawl the full static graph with the bundled **`scripts/crawl.mjs`** (zero-dep; works where wget is absent and never hangs on an installer). Prefer `wget --mirror --convert-links --page-requisites --adjust-extension` only if it's actually installed.
  ```bash
  CLONE_TARGET="https://www.example.com" CLONE_OUT="./clones/<name>/mirror" node scripts/crawl.mjs
  ```
- Vendor runtime-only third-party assets (decoder, HDRI) into `_vendor/` locally. Verify the `.glb` byte size matches live.
- Stub the backend form: copy **`scripts/sw.template.js`** → `<mirror-root>/sw.js`, fill the per-site bits (decoder version, HDRI filename, image optimizer) from recon. The server auto-registers it.
- Serve on loopback with **`scripts/serve.mjs`** (`127.0.0.1`, Range support for video, injects SW registration):
  ```bash
  node scripts/serve.mjs ./clones/<name>/mirror/www.example.com
  ```
- Eyeball it against live — it runs **their** bundle, so 3D + animations are byte-identical.

### Wave 3 — Fidelity gate (prove it — don't claim it)
Run the bundled **`scripts/run-fidelity.mjs`** (Playwright + pixelmatch + ssim.js):
```bash
npm i -D playwright pixelmatch pngjs ssim.js && npx playwright install chromium   # once
CLONE_REF="https://www.example.com/" CLONE_MIRROR="http://127.0.0.1:4321/" node scripts/run-fidelity.mjs
```
The gate is **floor-derived**, not a magic number: it captures reference×2 and mirror×2, sets
`floor = min(mean ref-vs-ref, mean mirror-vs-mirror)`, and **PASSES** only when every depth ≥ `floor−0.03`,
mean SSIM ≥ `max(0.95, floor−0.01)`, no depth < 0.85, and **zero structural breaks**. It handles the three
determinism traps (scroll-assert, new-WebGL-frame wait, video seek). If a site has a scroll-driven video,
fill `CLONE_VIDEO_MAP` from recon. See `references/playbook.md` §2 for the full rationale and §3 for the traps
(image-optimizer SSIM trap, blob-worker decoder fetches, etc.). **Never loosen the gate to pass a structural break** — that's a real bug.

### Wave 4 — HUMAN PAUSE → collect repurpose inputs
The mirror is done and proven. Before Phase B, get from the user: **brand**, **hero/3D object** (their own
`.glb` or substitute), **copy**, and **fonts** (licensed or OFL substitutes). Do not invent these.

### Wave 5 — Engine from scratch (Phase B)
You usually **cannot** reuse minified chunks — write a clean engine against a fresh, version-matched stack:
- Resolve the 3D stack versions at execution time; verify the R3F major matches the React major.
- Fixed full-viewport canvas behind scrolling DOM; **one rAF owner** feeding a scroll-progress store (never React state); imperative `useFrame` scrub; match the original frameloop mode.
- Reproduce the **effect vocabulary** (pinned canvas, scroll progress, scrub, smooth-scroll) — not the exact code.

### Wave 6 — Repurpose + Verify + (optional) Deploy
- Swap in the user's 3D object, copy, branding, images. Vendor the decoder + a **CC0** HDRI locally. Use **OFL/licensed fonts only**.
- Verify: Lighthouse + a **font-leak grep gate** (no original paid-font names anywhere in the public bundle).
- Only the Phase B artifact ships. Public deploy is a **human-pause** point.

## Hard constraints (the guardrails that keep this legitimate)

This skill is for **studying a reference and building your OWN site** (white-label templates, design study,
rebuilds you're authorized to make) — not impersonation. Enforce all of these:

1. **The 1:1 mirror is INTERNAL / loopback only.** Never bind to `0.0.0.0`; never deploy it publicly under the
   original brand. **Gitignore the mirror payload** (`*/mirror/<host>/`, `_vendor/`, `_recon/fidelity/`) **and**
   exclude it from deploy ignore-files (a catch-all static host serves any committed file).
2. **Only the repurposed Phase B artifact goes public** — with the user's own copy/branding/3D object and
   **licensed or substitute fonts**. Zero original-paid-font leakage (grep the bundle to confirm).
3. **Never edit minified chunks** — redirect at the network layer via the service worker.
4. **Never hang on an interactive installer.** The bundled crawler/server need no install.
5. **Pause for a human** at: the C→B boundary, any public deploy, spending money (font licenses), force-pushing, or anything irreversible.

If the user asks to deploy the raw mirror under the original brand, or to pass off a clone as someone else's
property, decline and steer to the repurpose phase — that's what this skill is for.

## Bundled resources

- `scripts/crawl.mjs` — zero-dep recursive crawler (target via `CLONE_TARGET`).
- `scripts/serve.mjs` — zero-dep loopback static server (Range + SW auto-registration).
- `scripts/run-fidelity.mjs` — Playwright fidelity gate (floor-derived PASS/FAIL + report + diff images).
- `scripts/sw.template.js` — offline-shim template (form stub + optional decoder/HDRI/image redirects).
- `references/playbook.md` — the complete method (§2 fidelity rationale, §3 hard-won traps).
- `references/launch-prompt.md` — paste-into-PLAN-mode cahier-des-charges generator (`<TARGET_URL>`).
- `INSTALL.md` — how to install + activate this skill on another machine (the handoff guide).
