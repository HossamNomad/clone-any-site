# clone-any-site — Lessons & Resolved Issues (don't restart from zero)

> The durable memory of everything we've learned and *already solved* about cloning. Read this BEFORE
> re-debugging a clone problem — most of them are answered here. Companion to `playbook.md`,
> `editor-guide.md`, `repurpose-layer.md`, `manifest-schema.md`. Last updated 2026-05-31.

---

## A. Mental model / pipeline

```
clone → fidelity gate → numbered manifest → edit-map → (on-demand) repurpose → publish-gate → publish
```

1. **Clone** — mirror the *real compiled build* (full DOM + every network asset, Playwright-hydrated),
   run it on **loopback**. You cannot hand-rebuild a modern WebGL/scroll site pixel-perfect from guesses.
2. **Fidelity gate** — prove fidelity by *measurement* against an empirical noise floor, multi-viewport
   (e.g. 390@DPR3 mobile, 1440@DPR2 desktop). Never claim a fidelity you didn't measure.
3. **Numbered manifest** — structured inventory: each editable element gets a `number`, a `stableId`,
   a `data-cl-id` anchor, a `type`/`role`, `flags`, breakpoint-scoped `slotSpec`, and a build fingerprint.
4. **Edit-map / editor** — human-in-the-loop. You **keep or swap by number** — visually.
5. **Repurpose (on demand only)** — `/clone` STOPS at the malleable mirror. It never auto-builds a
   "brand version" (changing everything at once = low quality). Swaps keep 100% of structure/animation.
6. **Publish-gate** — the **single publish exit**. Blocks on retained originals, font-leak, brand-string,
   analytics IDs; requires a structure attestation. Output is loopback-only — never deploy the raw clone.

---

## B. Fidelity ceilings (state the verdict UPFRONT — see §C)

| Ceiling | What it is | Modifiability | Real example |
|---|---|---|---|
| ✅ **Static / DOM+CSS** | HTML+CSS marketing page | 🟢 GREEN — swap any element trivially | most landing pages |
| 🟡 **WebGL/3D + loadable assets** | `.glb`, textures, declarative R3F/GSAP/Lenis | 🟡 YELLOW — mirror is perfect; a *rebuild* keeps the effect vocabulary, content reconstructed | landonorris.com (Webflow + Rive + WebGL hero) |
| 🔴 **Bespoke compiled engine** | minified custom three.js, WASM-rendered text/glyphs, web-worker render, DRACO/procedural geometry, asset-streaming "game" | 🔴 RED — the only version that keeps their exact structure+effects **is their compiled bundle** → study-only, never shippable | igloo.inc (heavy R3F, GPU-crashes capture), messenger.abeto.co (minified + WASM text + paid font) |

**The honest 1:1 limit:** for 🔴 sites a from-scratch rebuild is an *inspired interpretation, NOT pixel-identical*.
When a true 1:1 isn't possible, the honest deliverable is: **byte-complete mirror + identical bundle +
one clean visual render** — and say so plainly. (igloo.inc: chrome-devtools GPU crashes + SwiftShader is
non-deterministic under 4-context capture → don't fake a pass; prove via byte-complete mirror instead.)

---

## C. The UPFRONT verdict rule (mandatory)

After a quick recon and **before building**, give a blunt two-axis verdict: **fidelity ceiling**
(✅/🟡/🔴) + **modifiability** (🟢/🟡/🔴), in one sentence. Why this is a hard rule: Hossam dropped a
build (messenger.abeto.co) because the RED verdict arrived *after* the work, not before. A late verdict
reads as wasted effort. Say it like:
*"bespoke compiled WebGL game — I can mirror it 1:1 for local study, but there's no shippable version
that keeps their exact structure+effects (that version IS their compiled code + paid font)."*

---

## D. Resolved gotchas (problem → fix)

- **★ THE BIG ONE — edits "don't hold" on a cloned React/Next/Nuxt site (the page reverts to the original
  on open).** The framework re-hydrates from embedded data (`__NEXT_DATA__`, `#__next`, etc.) *after* load
  and rebuilds the DOM, overwriting any edit — whether made via the editor, the manifest, or raw HTML
  string-replace. This is **why "nothing held" on eiger AND drinksom**: both are hydrating SPAs, the worst
  case for repurpose. It is NOT a console bug — it's the site's own JS. **Fix (the real answer to "is
  repurpose even possible?" → YES, even on hard React sites):** the build (`apply-swaps.mjs`
  `buildDomDerivative`) now **(1) detects hydration markers, (2) waits `--hydrate-ms` for the framework to
  finish painting, (3) edits the *settled* DOM, (4) FREEZES — strips every framework `<script>` +
  `__NEXT_DATA__`/`__NUXT_DATA__` (keeps JSON-LD) via `freezeSpaInPage`** → the saved page can't re-render,
  so the edits stay. Auto-on for SPAs, auto-off for static sites (no markers → no wait, untouched).
  `--freeze on|off` forces it; `summary.frozen`/`scriptsRemoved` report it. Proven in a real browser on
  drinksom (VERDICT: FREEZE_WORKS) + locked by `test/freeze-spa.test.mjs`. Diagnostic that nails it: load
  the edited page in Chromium, `waitForTimeout(3500)`, read `document.body.innerText` — if the OLD text is
  back, the site hydrates and you must freeze.
- **★ Freeze companion — JS intro LOADER leaves the frozen page stuck on a splash.** A site that gates content
  behind a full-viewport loader/splash (`% counter`, "entering…", white overlay) dismisses it *with a script*.
  Freeze strips that script, so the overlay stays forever and hides the settled page. **Fix:** after freezing,
  `neutralizeIntroOverlaysInPage` peels full-viewport, high-stacking, opaque overlays painted on top at the
  viewport centre (repeat up to 6× until the centre is real content). Default on when freezing; `--deloader off`
  disables; `summary.overlaysPeeled` reports it. Conservative: only `fixed`/`absolute` full-covers match, so a
  normal relative hero section on a content page is never touched. Locked by the loader case in `freeze-spa.test`.
- **★ Premium sites need TWO more freeze companions — blob-image relocalize + pre-scroll (built, tested).** The
  most beautiful clones (Mammut/eiger-class: Next.js + Contentful) hit two JS-runtime traps a naive freeze can't
  capture: **(a) blob: images** — hero images are loaded via JS into `URL.createObjectURL()` blobs that DIE on
  reload (broken/black). `relocalizeBlobImagesInPage` recovers each blob img's real URL from `__NEXT_DATA__`
  (match by alt, then order) and rewrites `src` (`--relocalize off` to disable; `summary.blobImagesRelocalized`).
  **(b) scroll-reveal / lazy content** — everything below the fold sits at `opacity:0` / unloaded until you scroll,
  so a top-of-page snapshot is blank below the hero. The build now **pre-scrolls** top→bottom→top while JS is alive
  so IntersectionObserver/GSAP reveals fire (they persist) and lazy/blob images load, THEN freezes
  (`--prescroll off` to disable). Locked by `test/relocalize-prescroll.test.mjs` (3/3). With both, eiger repurposed
  to a full gorgeous Pulsia "CONTRAST" page (47k px) that holds; without them it was blank below the hero.
- **★ The freeze-PROBE must RELOAD, not screenshot-in-place — in-place gives false positives.** A probe that
  strips scripts and screenshots the SAME live page still shows blob images (blobs alive) + revealed content (JS
  already ran) — so it reports "freezes great" for sites that actually break on reload. Always serve the saved
  HTML in a FRESH page and judge THAT. The clones-list fidelity map (7 sites): **repurposable = eiger, synchronized**
  (HTML/CSS imagery + recoverable assets); **NOT = drinksom, landonorris, falter, igloo, messenger** (WebGL/Rive/
  WASM — content is GPU-painted, freezes blank). 5 of 7 premium clones are study-only; gorgeous ≠ repurposable.
- **★ Honest fidelity limit — a WebGL-EXPERIENCE site freezes to a near-blank page (this is the ceiling, not a
  bug).** drinksom's hero copy is white text *styled to overlay a live 3D bottle scene* that JS (three.js/R3F)
  paints. Freeze proves the text edits HOLD (no revert) and de-loader peels the splash — but the 3D background is
  GPU-rendered by the scripts we stripped, so the snapshot is white-on-white = visually blank. Same class as
  igloo.inc / landonorris / eiger (text in compiled JS). **Repurpose is FOR content sites** (text/media in the
  DOM, not GPU-painted): there freeze → a clean, holding, good-looking static page. For WebGL-experience sites the
  mirror stays study-only (see §B 🟡/🔴). Give this verdict UPFRONT (§C) so a WebGL site isn't picked as a "make it
  pretty" repurpose target — drinksom/eiger are stress-tests for the freeze mechanism, not showcase repurposes.
- **Black screen when importing an image into a `<picture>`** → the swap set only `img.src` and left the
  sibling `<source>` elements pointing at the old/now-missing asset, so the browser kept the stale source.
  **Fix:** rebuild **ALL** `<source>` siblings from fit-slot's `srcsetHtml`, not just `img.src`. Same bug
  class exists in the *ship path* (`apply-swaps.mjs` `applyInPage`) — fix both, and for `<video>` too.
- **Image looks broken / flashes** → **decode-before-swap**: load the new asset in a detached
  `new Image()` and `await img.decode()` *before* mutating the DOM; swap only on success, else keep the
  original and show an error toast. Never leave a black element.
- **srcset/sizes wrong after swap** → rebuild `srcset` from the generated variants and set/clear `sizes`;
  clear stale `data-src`/`data-srcset` (lazyload libs re-assert old assets); force `loading=eager`,
  `decoding=sync` on the swapped node.
- **Edits don't survive a React re-render** → anchor on **`data-cl-id`** stable IDs (survive hydration /
  re-render), not on DOM position. The MutationObserver re-applies swaps when React repaints.
- **"Change everywhere" / same content in N places** → `groupId` ties identical-content slots; one op
  propagates to all members (`/__clone/group`).
- **Loopback only** → bind `127.0.0.1`, **never** `0.0.0.0`, never deploy the raw clone publicly. Every
  edit endpoint is gated on `EDIT && LOOPBACK_OK`. The publish-gate is the only path to a shippable build.
- **Content-only isolation** → never touch the mirror's structure/layout/CSS/animations; only swap
  text/media + recolor via CSS-var themes. Edits are manifest-only and reversible.
- **publish-gate** → blocks if any `role:content` element is still `provenance:original` with no
  replacement and `keep:false` (a "retained original"); also scans font-leak, brand-string, analytics.
  Unauthorized structure → `buildMode:'clean-room'` (DOM-derivative refused).
- **Flaky harness — trust exit codes + file readback, NOT rendered output** → the tool harness has
  (twice now) dropped *and fabricated* tool output, nearly shipping a false "all green". **Decide
  PASS/FAIL on process exit codes + a re-run, write results to a file and Read it back.** A
  filename-encoded sentinel (`touch .SE_EXIT_0__pass_7`) survives even when content rendering is broken.
- **Determinism "flaky" test** → first rule out **fixed-port zombie servers**: use an ephemeral port
  (`CLONE_SERVE_PORT=0`), print `CLONE_PORT=<n>` to stdout, read it back, and HTTP-poll for readiness.
- **Run test suites file-by-file**, never whole-dir — scratch under `test/.work/` double-counts. Under
  high concurrency the heaviest server-spawning suites (`serve-edit`, `fit-slot`) can TIMEOUT/port-collide
  in the *aggregate* gate while passing **green in isolation** — that's a harness artifact, not a regression.

---

## E. Editor capabilities shipped (version log)

- **v1.1 — Repurpose Layer** (2026-05-30): `/clone` stops at a pixel-perfect *malleable* mirror +
  numbered manifest + edit-map; extract/validate/apply-swaps/fit-slot/publish-gate/distill; zero-dep
  browser editor (double-click edit, drag-drop import, manual mode).
- **v1.2 — Editor refonte** (2026-05-30, 39 tests): text edits **stick + propagate**; media swap
  srcset-safe; **Cmd-K palette**; CMS find-replace; 1-click themes; data-cl-id survives React;
  groupId change-all-N. **Published to the public repo at v1.2.0.**
- **v1.3 — in progress (this work, NOT yet pushed — Hossam tests eiger first):**
  - **Asset library** — reuse uploaded images without re-uploading, sha1 content-addressed dedup.
  - **AI copy rewrite** — brand-voice variants, **offline-safe** (CLONE_AI_FAKE deterministic /
    ANTHROPIC_API_KEY real / 503 degrade), **suggestions-only — never writes the manifest itself**.
  - **Section hide/show** — drop a whole section, manifest-only + reversible (`set-section` op,
    `section.hidden`, build emits `display:none`, restore clears it).
  - **SEO head + alt + link editing** — ship YOUR `<title>`/description/canonical (cascades to og/twitter),
    per-image `alt`, and anchor `href` retargeting.
  - **Genuine ship loop proven** (`publish-loop.test`): edit → `apply-swaps` build → publish-gate PASS +
    NOTICE, with BLOCK-on-retained-original backstop intact.
  - Gate: **15 suites**, all green **in isolation** (concurrent gate shows only `serve-edit`/`fit-slot`
    timeout artifacts — see §D).

---

## F. Commands reference

| Command | What it does |
|---|---|
| `/clone <url>` | Mirror on loopback → fidelity gate → numbered manifest → edit-map, then **STOP** (malleable mirror). |
| `/clone-list` | Dashboard of every clone: see, preview, launch editor, edit, retire. |
| `/clone-map` | (Re)build the numbered edit-map for a clone. |
| `/clone-modifier` | Open the interactive visual editor on a clone. |
| `/clone-swap "#N <file\|text>"` | Validate → apply one numbered swap to preview + build (fit-slot resizes media). |
| `/clone-preview` | Watermarked loopback before/after. |
| `/clone-publish` | IP/legitimacy gate → build → multi-viewport gate → deploy (human-confirmed). |

### Underlying scripts (all zero-dep, deterministic — no `Date.now()`/`Math.random()`, IDs are sha1)

| Script | Job |
|---|---|
| `extract-manifest.mjs` | Build the numbered manifest from the hydrated mirror. |
| `validate-manifest.mjs` | Dry-run schema + cross-field validation (run before any swap). |
| `apply-swaps.mjs` | Materialize the preview + the publishable build (dom-derivative / clean-room). |
| `fit-slot.mjs` | Generate responsive asset set (webp/avif/mp4/webm) + ready `srcsetHtml`. |
| `publish-gate.mjs` | BLOCKING legitimacy gate (structure attestation, fonts, brand, analytics). |
| `distill-techniques.mjs` | Cumulative design-system/technique library (recipes only, never asset bytes). |
| `serve.mjs` | Loopback server (plain mirror, or `CLONE_EDIT=1 CLONE_LOOPBACK_OK=1` editor mode). |
| `run-tests-report.mjs` | Runs each test suite in isolation, writes a readback report. |

---

## G. Install / repo facts

- **Public repo:** `github.com/HossamNomad/clone-any-site` (MIT). Currently published at **v1.2.0**;
  **v1.3 is not pushed yet** (Hossam validates on eiger-extreme first; public push = `public-post` →
  needs explicit go).
- **Install:** `/plugin marketplace add HossamNomad/clone-any-site` → `/plugin install clone-any-site@hossam-skills`.
- **Pushing:** done via a GCM-stored token (`gh` is not logged in; the `.env` githubClientId/Secret are
  OAuth, **not** git-usable).
- **Active clones:** `clones/landonorris/` (Phase C, 6/6 routes pass), `clones/igloo-inc/`,
  `clones/eiger-extreme/` (v1.3 editor test bed — Next.js `<picture>`-heavy), `clones/drinksom/`.

---

## H. Folder-Drop Asset-Swap layer (Clone Atlas) — 2026-06-03

The live in-browser editor is **retired** for the asset-swap product (it drifted on hydrating SPAs). The
replacement is a **numbered map + manual + folder-drop**, built ON TOP of the proven live-runtime swap
(`serve-repurpose.mjs` + `lib/compose-rewrite.mjs` — keep the JS runtime alive, swap only asset *bytes* at
`/__swap/<TAG>`; never freeze, never touch DOM/scripts/keyframes). **Proven on `clones/eiger-extreme/`:**
drop a placeholder `VID-1.mp4` + `IMG-1.png` → `clone-swap` compresses + registers → `clone-verify` PASS
(animations preserved: waapi 9→9, videos 5→5; intro still moves: 9 differing frames; per-slot: 1 of 5 videos
swapped, NOT greedy; 0 console errors).

### The 4 commands (under `scripts/`, npm `clone:map|clone:swap|clone:watch|clone:verify`)
| Script | Job |
|---|---|
| `clone-map.mjs` | Serve the clone, place a numbered+colored badge on every slot → `repurpose/VISUAL-MAP.html` + `.png` + `MANUAL.md/.html`; capture pristine animation baseline → `repurpose/ANIM-LOCK.json`. **Run BEFORE swapping.** |
| `clone-swap.mjs` | One-shot: scan `swaps/`, route each `<TAG>.<ext>` via `lib/drop-router`, compress via `lib/encode-recipes` → `swaps/.generated/<TAG>.<ext>` (raw → `<TAG>-raw.<ext>`), upsert `swaps.json` + `COMPRESSION-REPORT.json`. |
| `clone-watch.mjs` | `fs.watch(swaps/)` debounced → `processDrops` on every drop (auto mode). |
| `clone-verify.mjs` | Serve swapped; compare census vs `ANIM-LOCK` (per-axis ≥95% + >0), assert intro still moves (frame-diff), count `/__swap/` hits, 0 new errors → `_verify/verify-report.json` + `.PASS`/`.FAIL` sentinel. Decide on the FILE. |

### Tag scheme (from `lib/slot-infer.mjs`, now exported)
`IMG`🟦 `VID`🟥 `SEQ`🟪 (drop a file named like the tag) · `TITLE`🟧 `TXT`⬜ (edit text in `swaps.json`).
Leading zeros cosmetic (`VID-04` ≡ `VID-4`). SEQ one-shot = advanced (no zip dep in v1).

### Bugs caught ONLY by running the real eiger proof (static gates/unit tests missed all of these)
1. **Bare-name `--clone <name>` resolved to the wrong root** — repoRoot was 5 dirs up (`…/Claude Code/clones`); it's **4 up** (`…/hossam2/clones`). Fixed in all 4 scripts. Unit tests used explicit fixture paths so never hit it.
2. **The Bash/Git-Bash (MSYS) shell mangles a leading-slash arg**: `--entry /fr/index.html` arrives as `C:/Program Files/Git/fr/index.html`. → rely on **auto-detect** (`detectEntry` from `MAP.json meta.url`); never pass `--entry` through bash. Added a **self-heal**: if the given entry isn't a real file under the mirror, fall back to the detected one.
3. **`detectMirror` ambiguity** — `mirror/` holds `_vendor` + the host dir (2 subdirs); clone-verify fell back to the PARENT `mirror/` → `/fr/index.html` 404 → blank census → false FAIL. Fix: prefer the host-looking subdir (has a dot, no leading `_`) in BOTH clone-map and clone-verify.
4. **`detectEntry` returned a directory** (`/fr/`) → `EISDIR`/blank. Fix: `entryToFile()` appends `index.html` to directory-style paths.
5. **`encode-recipes` used `spawnSync(..., { shell: true })` on Windows** → an args array is re-joined and re-split on spaces, so any path with a space (**"Claude Code"**) is **truncated at the space** and ffmpeg fails. Fix: **`shell:false`** (matches `transcode.mjs`). Tests passed only because they ran in the space-free OS tmpdir — **add a space to test fixture paths** to catch this class.
6. **`clone-watch` shadowed the global `process`** with a local `process()` fn → `process.stdin`/`exit` broke. Renamed to `runOnce`.

**Meta-lesson (reinforces §D):** unit tests + agent self-reports were ALL green while the end-to-end pipeline was fully broken (blank render). Only serving the real clone, screenshotting it, and reading `verify-report.json` surfaced the truth. Always run the real proof; trust the report file, not the green checkmarks.
