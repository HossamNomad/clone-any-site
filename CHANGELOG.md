# Changelog

All notable changes to **clone-any-site** are documented here. Versions track the plugin
version in `.claude-plugin/marketplace.json`.

## [1.3.0] — 2026-06-04

### Added
- **Clone Atlas — folder-drop swap layer.** Drop a numbered file into a clone's `swaps/` folder and it is
  auto-compressed (sharp for images / ffmpeg for video, timing preserved) and swapped into **only** that
  numbered slot — animations untouched. Four npm commands: `clone:map`, `clone:swap`, `clone:watch`,
  `clone:verify` (`clone-map.mjs` / `clone-swap.mjs` / `clone-watch.mjs` / `clone-verify.mjs`).
- **`/clone-watch` and `/clone-verify` slash commands** for command parity with the new scripts.
- **`scripts/lib/` shared modules** — `anim-census`, `compose-rewrite`, `dimensions`, `dna-card`,
  `drop-router`, `encode-recipes`, `query-core`, `slot-infer`.
- **Extra tooling** — `design-quality-score.mjs`, `distill-market.mjs`, `serve-repurpose.mjs`,
  `transcode.mjs`, `query-dna.mjs`, `check-copy-truth.mjs`.
- **40-spec test suite** (`scripts/test/*.test.mjs`, run with `npm test` / `node --test`).
- **`references/lessons-resolved.md`** — durable record of every solved gotcha.
- **`.nvmrc` (20)** and a package `engines` field (`>=18`) — single source of truth for Node version.

### Changed
- **DOM-derivative swap is now the documented default** repurpose path (keep structure + animations,
  swap numbered elements); the clean-room rebuild is the explicit fallback. README corrected accordingly.
- `extract-manifest.mjs` evolved (richer slot extraction); `SKILL.md` expanded.

### Fixed
- **Windows space-path bug** in `fit-slot.mjs`: the ffmpeg subprocess used `shell:true` on Windows, which
  silently truncated input paths containing spaces (e.g. `…\Claude Code\…`) at the first space, failing
  every video swap. Now `shell:false` (matches `transcode.mjs`) — ffmpeg still resolves on PATH and the
  args array is passed verbatim.

## [1.2.0] — 2026-05-30

### Added
- **Visual editor refonte** — sticky, propagating edits via stable `data-cl-id` anchors + MutationObserver;
  srcset-safe media swaps; Cmd/Ctrl-K command palette; searchable CMS panel with find-and-replace; mobile FAB;
  1-click CSS-variable themes (no structure/animation changes).
- **`/clone-list` dashboard** — see, preview, launch, edit, and retire every clone from one loopback page.

## [1.1.0] — earlier

### Added
- **Repurpose Layer** — numbered manifest, visual editor, and a mechanical IP publish-gate.

## [1.0.0] — earlier

### Added
- Initial release as an installable Claude Code plugin + marketplace: pixel-perfect loopback mirror,
  floor-derived fidelity gate (Playwright + pixelmatch + SSIM), zero-dependency crawler/server.

[1.3.0]: https://github.com/HossamNomad/clone-any-site/releases/tag/v1.3.0
