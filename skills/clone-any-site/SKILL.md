---
name: clone-any-site
description: >-
  Clone any website to a genuinely high fidelity bar (pixel-perfect against an empirical noise floor), then
  repurpose it as your OWN site by keep-or-swapping numbered elements — visually. Use this WHENEVER the user
  wants to clone, copy, replicate, mirror, rebuild, "make a site like", or repurpose another website — including
  via /clone, /clone-map, /clone-modifier, /clone-swap, /clone-preview, /clone-publish, or when they paste a URL
  and say "clone this", "copy this site", "rebuild this landing page", "I want a site like this one", "mirror
  drinksom.eu", "recreate this WebGL/3D scroll experience", or "let me edit the clone / change the text and
  images". Also triggers for "pixel-perfect copy", "fidelity test a clone", "edit-map", "numbered manifest", or
  building white-label templates from a reference design. Handles static marketing pages AND hard WebGL /
  React-Three-Fiber / GSAP / Lenis / Next.js scroll sites. Default /clone delivers a pixel-perfect, ULTRA-
  MALLEABLE loopback mirror + a numbered edit-map and STOPS — repurposing is on demand, by targeted swaps that
  keep 100% of the structure/animations/interactivity. Do not hand-rebuild a 3D site from guesses — use this skill.
---

# Clone Any Site → then make it your own (numbered, visual, ship-grade)

A portable, battle-tested recipe for cloning *any* website to ≥95% **measured** fidelity, then turning it into
**your own** shippable site by **keeping or swapping numbered elements** — visually, on both mobile and PC.

**Two core insights:**
1. Modern marketing sites are often WebGL/3D scroll experiences. You **cannot** hand-rebuild those pixel-perfect
   from guesses. The only faithful 1:1 is to **mirror the real compiled build and run it on loopback**, prove
   fidelity by measurement, then repurpose.
2. The repurpose must be **malleable, not a from-scratch guess**. The default deliverable is a **pixel-perfect
   mirror + a numbered manifest + a visual editor** — then you change *only* the words/images/videos you choose,
   keeping 100% of the structure/animation/interactivity. (Auto-rebuilding a whole "brand version" changes too
   much at once → low quality. We don't do that.)

## Announce + scope first

Tell the user: *"Using clone-any-site to mirror `<url>` on loopback, prove fidelity, and hand you a numbered,
editable copy."* Then size the job (static DOM ≪ WebGL scroll site) and default to **PLAN MODE** for anything
non-trivial (use `references/launch-prompt.md`) before writing code.

## ★ Clonability & Modifiability Verdict — STATE THIS UPFRONT, before any building

After a quick recon, give the user a blunt **two-axis verdict BEFORE they invest** — do NOT let them discover the
ceiling after you've built. Mandatory.

- **Fidelity ceiling** (how close a *shippable* version can get):
  - **Static / DOM+CSS** → near pixel-perfect, fully rebuildable. ✅
  - **WebGL/3D with loadable assets** (`.glb`, textures, declarative R3F/GSAP) → mirror is perfect; a clean
    rebuild reaches high fidelity with real effort. 🟡
  - **Bespoke compiled engine** (minified custom three.js, WASM-rendered text/glyphs, web-worker rendering,
    DRACO/procedural geometry, asset-streaming "game") → the mirror is perfect (it's their code), but a
    from-scratch rebuild is an **inspired interpretation, NOT pixel-identical**. 🔴
- **Modifiability ceiling** (can you keep the exact structure/effects AND tweak content cleanly?):
  - 🟢 **GREEN** — DOM/static or authorized structure → swap any numbered element trivially (this is the sweet
    spot for the Repurpose Layer).
  - 🟡 **YELLOW** — you keep the *effect vocabulary* via a rebuild, content reconstructed; fully editable, just
    not their exact meshes/shaders.
  - 🔴 **RED** — the only version that keeps their exact structure+effects+visuals **is their minified/WASM
    bundle** → **study-only, never shippable**; the editable path is a from-scratch rebuild that won't be 1:1.

Say it in one sentence (e.g. *"bespoke compiled WebGL game — I can mirror it 1:1 for local study, but there's no
shippable version that keeps their exact structure+effects (that version IS their compiled code + paid font)."*).

## The shape

```
DEFAULT /clone (always):                         ON-DEMAND repurpose (explicit commands only):
  Recon → Crawl → Mirror (loopback)               /clone-map | /clone-modifier  → numbered edit-map + visual editor
  → Fidelity gate PASS                             /clone-swap "#N <file|text>"  → validate → apply (2 targets) → fit-slot
  → extract numbered manifest                      /clone-preview                → watermarked loopback before/after
  → distill technique cards                        /clone-publish                → IP gate → build → design-symphony
  ── STOP: pixel-perfect malleable mirror ──                                       → multi-viewport gate → deploy [HUMAN]
```

`/clone` **stops at the malleable mirror**. It never auto-builds a brand version. Repurposing keeps the structure
and swaps content **by number**.

## Workflow (waves) — create a todo per wave

### Wave 1 — Recon (verify live; trust nothing assumed)
chrome-devtools MCP + Firecrawl. Detect the stack (`window.__NEXT_DATA__`, R3F/`three`, `gsap`, `lenis`, scroll
model); enumerate every network asset (`firecrawl_map` + network panel); read tokens via `firecrawl_scrape`
`branding`; map scroll choreography, form-submit shape, seekable `<video>`, frameloop mode. Write
`capture-preconditions.json` + `asset-manifest.json` + `effects-inventory.md`.

### Wave 2 — Mirror the compiled build (loopback)
- Crawl with **`scripts/crawl.mjs`** (zero-dep): `CLONE_TARGET="https://www.example.com" CLONE_OUT="./clones/<name>/mirror" node scripts/crawl.mjs`
- Vendor runtime-only third-party assets (decoder, HDRI) into `_vendor/`. Stub the form via **`scripts/sw.template.js`** → `<mirror-root>/sw.js`.
- Serve loopback: `node scripts/serve.mjs ./clones/<name>/mirror/www.example.com` (127.0.0.1 only; Range + SW auto-registration).

### Wave 3 — Fidelity gate (prove it — don't claim it)
`npm i -D playwright pixelmatch pngjs ssim.js && npx playwright install chromium` (once), then
`CLONE_REF="https://www.example.com/" node scripts/run-fidelity.mjs`. **Floor-derived**: captures ref×2 + mirror×2,
`floor = min(mean ref-vs-ref, mean mirror-vs-mirror)`, **PASSES** only when every depth ≥ `floor−0.03`, mean ≥
`max(0.95, floor−0.01)`, no depth < 0.85, **zero structural breaks**. Multi-viewport: set
`CLONE_VIEWPORTS=390x3,1440x2` to gate mobile + desktop in one PASS. Never loosen the gate to pass a structural break.

### Wave 4 — Extract the numbered manifest + distill techniques  ← the malleability layer
```bash
node scripts/extract-manifest.mjs --url http://127.0.0.1:4321/ --out clones/<name>/repurpose --name <name>
node scripts/distill-techniques.mjs --clone <name> --effects clones/<name>/_recon/effects-inventory.md
```
`extract-manifest` freezes time, walks the hydrated DOM at **390/768/1440**, classifies content vs chrome, folds
repeats, and gives every editable element a **stable number** with a dual locator + provenance + flags + per-bp
slot-spec → `repurpose/manifest.json` (+ `.lock.json` + `build-fingerprint.json`). `distill-techniques` writes 3–7
generalized, original-free technique cards into `design-system/clone-techniques/`. **This is the default `/clone`
finish line.** See `references/repurpose-layer.md` + `references/manifest-schema.md`.

### Wave 5 — Edit it (on demand): the visual editor
```bash
CLONE_EDIT=1 CLONE_LOOPBACK_OK=1 CLONE_REPURPOSE_DIR=clones/<name>/repurpose \
  node scripts/serve.mjs clones/<name>/mirror/www.example.com
```
Open `http://127.0.0.1:4321/` in **VS Code's Simple Browser** or any browser. Numbered badges on every element;
**double-click text** to edit inline, **double-click an image/video** to drag-drop a replacement (auto-fit to the
slot's responsive set via `fit-slot`), **Manual** mode keeps the page usable, **Before/After** compares, and a
live **"N slots block publish"** counter tracks retained originals. Or do it from the CLI: `/clone-swap "#3
hero.jpg" "#7 New headline" "keep #12"`. See `references/editor-guide.md`. Content-only — structure/animation are
never touched (isolation contract).

### Wave 6 — Publish (on demand): the IP gate, then build + verify
```bash
node scripts/publish-gate.mjs --manifest clones/<name>/repurpose/manifest.json --build clones/<name>/repurpose/build --interactive
```
The gate is **mechanical + blocking** (see Hard constraints). On the structure verdict: **authorized** → build the
**DOM-derivative** (`apply-swaps.mjs --target build --build-mode dom-derivative`: mirror structure/CSS/animations +
your content, analytics/brand scrubbed); **unauthorized** → the gate forces the **clean-room rebuild**. Then flow
the build through **design-symphony Polish + Verify** + the **multi-viewport fidelity gate**, and **pause for a
human** before any deploy (`deploy-with-verify`, never under the original brand).

## Hard constraints (the guardrails that keep this legitimate)

For **studying a reference and building your OWN site** (white-label templates, design study, authorized rebuilds)
— not impersonation. Enforce all:

1. **The 1:1 mirror + every preview/build payload is INTERNAL / loopback only.** Never bind `0.0.0.0`; never
   deploy under the original brand. **Gitignore** the mirror payload + `repurpose/{assets,preview,build}/` **and**
   exclude them from deploy ignore-files. `manifest.json`/`.lock.json`/`build-fingerprint.json` stay tracked.
2. **Nothing public ships without `publish-gate` PASS.** It runs an **interactive per-deploy attestation**
   enumerating every retained original — *including hidden chrome (nav/footer/legal/contact), forms, analytics &
   verification IDs, and text baked into images* — and a **structure-authorization** that decides DOM-derivative
   vs clean-room. Scans: font-leak grep, brand-string scrub, **byte-hash + perceptual-hash** (re-encode defeats
   byte-equality), JS-dep license check, analytics-ID strip. Verdict is *"no unmodified original detected"* — the
   human attestation is the real backstop. Chrome is hidden from the edit-map VIEW but **never** from the scan.
3. **Repurpose by targeted swaps that keep the structure** — never an auto from-scratch "brand version". The
   clean-room rebuild is a *fallback* (unauthorized structure) or an explicit request, never automatic.
4. **Never edit minified chunks** — redirect at the network layer via the service worker.
5. **Never hang on an interactive installer.** The bundled crawler/server/editor need no install.
6. **Pause for a human** at: any public deploy, spending money (font licenses), force-pushing, or anything
   irreversible.

If asked to deploy the raw mirror under the original brand, or to pass a clone off as someone else's property,
decline and steer to the gated repurpose — that's what this skill is for.

## Command surface

| Command | Does |
|---|---|
| `/clone <url>` | recon → mirror → fidelity gate → extract manifest + distill techniques, then **STOP** (no auto-repurpose) |
| `/clone-map [name]` | numbered edit-map overlay (badges + slot table + counter) |
| `/clone-modifier [name]` | interactive visual editor (double-click edit, drag-drop import, manual mode) |
| `/clone-swap "#N <file\|text>" …` | swap by number (validate → apply 2 targets → fit-slot) |
| `/clone-preview [name]` | watermarked loopback preview (before/after) |
| `/clone-publish [name]` | IP gate → publishable build → design-symphony → multi-viewport gate → deploy [HUMAN] |

## Bundled resources

- `scripts/crawl.mjs` — zero-dep recursive crawler. · `scripts/serve.mjs` — zero-dep loopback server (+ `--edit` editor mode + `/__clone/*`).
- `scripts/run-fidelity.mjs` — Playwright fidelity gate (floor-derived, multi-viewport). · `scripts/sw.template.js` — offline shim.
- `scripts/extract-manifest.mjs` — numbered manifest (Playwright). · `scripts/manifest.schema.json` — the data contract.
- `scripts/validate-manifest.mjs` — dry-run (zero-dep). · `scripts/apply-swaps.mjs` — two-target writer.
- `scripts/fit-slot.mjs` — dropped file → responsive set (sharp/ffmpeg, degrades). · `scripts/publish-gate.mjs` — blocking IP gate.
- `scripts/distill-techniques.mjs` — technique ledger → `design-system/clone-techniques/`. · `scripts/clone-deps-check.mjs` — runtime probe.
- `scripts/editor/` — zero-dep edit-map + interactive editor overlay (served).
- `references/playbook.md` (method + fidelity rationale + traps) · `references/repurpose-layer.md` · `references/manifest-schema.md` · `references/editor-guide.md` · `references/clone-interfaces.md` (engineering contract) · `references/launch-prompt.md` · `INSTALL.md`.

## v1.1 (deferred — hooks documented, not built)
WebGL/3D slot-mapping (gated on a real heavy-3D target) · asset generation (CC0 / Higgsfield-Kling) + auto-alt-text
· measured behavioral-regression gate · round-trip 3-way reconcile · rich edit-map (contact-sheet, per-origin
colors) · live layout/CSS editing in manual mode · `/clone-variant <brand>`.
