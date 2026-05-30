# Repurpose Layer — internal interface contract (the linchpin)

> Every script + the editor overlay conform to THIS. Producers and consumers are built in parallel; this is
> what keeps them coherent. If a signature changes, change it here first. Not user-facing — engineering contract.

## 0. Layout (per clone)

```
clones/<name>/
  mirror/<host>/…            # EXISTING loopback payload (gitignored)
  _recon/effects-inventory.md# EXISTING recon output (technique distill reads this)
  repurpose/                 # NEW
    manifest.json            # tracked — single source of truth (manifest.schema.json)
    manifest.lock.json       # tracked — apply-swaps lock-ledger (what was applied, hashes)
    build-fingerprint.json   # tracked — { buildId, crawlLogHash } drift guard
    assets/                  # gitignored+vercelignored — user-imported + fit-slot outputs
      incoming/<n>__<file>   #   raw dropped files
      slot-<n>/…             #   responsive sets
    preview/                 # gitignored+vercelignored — apply-swaps overlay layer for the mirror
    build/                   # gitignored+vercelignored — publishable target (DOM-derivative OR clean-room)
```

`manifest.json` / `.lock.json` / `build-fingerprint.json` are **tracked**. Everything else under `repurpose/`
is **ignored** (mirror IP + binary clutter), like the mirror payload.

## 1. CLI signatures (all `node <script> [flags]`, all ESM, node ≥ 20)

| Script | Invocation | Exit | Stdout |
|---|---|---|---|
| `extract-manifest.mjs` | `--url <mirrorUrl> --out <repurposeDir> --name <name> [--viewports 390,768,1440] [--crawl-log <path>] [--now <iso>]` | 0 ok / 1 fail | JSON summary |
| `validate-manifest.mjs` | `--manifest <path> [--mirror-url <url>] [--strict]` | 0 valid / 1 invalid | report |
| `apply-swaps.mjs` | `--manifest <path> --mirror <mirrorRoot> [--target preview\|build\|both] [--build-mode dom-derivative\|clean-room] [--now <iso>]` | 0 / 1 | JSON summary |
| `fit-slot.mjs` | `--slot <n> --in <rawFile> --manifest <path> --out <assetsDir> [--now <iso>]` | 0 / 1 | JSON `{ assetRef, generated[], srcsetHtml }` |
| `publish-gate.mjs` | `--manifest <path> --build <dir> [--attest <attestation.json>] [--interactive] [--now <iso>]` | 0 PASS / 1 BLOCK / 2 error | report + writes NOTICE |
| `distill-techniques.mjs` | `--clone <name> --effects <effectsInventory.md> [--lib design-system/clone-techniques] [--draft-only]` | 0 / 1 | JSON `{ cards[] }` |
| `clone-deps-check.mjs` | `[--json]` | 0 / 1 | table or JSON |
| `serve.mjs` | `<mirrorRoot>` (+ env below) | — | — |
| `run-fidelity.mjs` | env (existing) `+ CLONE_VIEWPORTS=390x3,1440x2` | 0 PASS / 1 FAIL | report |

**Determinism rule:** scripts NEVER call `Date.now()`/`new Date()`/`Math.random()` internally — any timestamp
comes from `--now`/`generatedAtRef`; any id is content-derived (sha). This keeps two runs byte-identical.

## 2. `serve.mjs` editor mode (extends the existing zero-dep server)

Enable with `CLONE_EDIT=1` (or `--edit`). Requires `CLONE_LOOPBACK_OK=1` to arm write-back. Binds 127.0.0.1
ONLY (existing). Needs `CLONE_REPURPOSE_DIR=clones/<name>/repurpose`.

When armed, on every HTML response inject (after the existing SW snippet):
- `<link rel="stylesheet" href="/__clone/editor/edit-map.css">`
- `<script>window.__CLONE_EDIT=JSON.parse('…config…')</script>` — `{ repurposeDir, blockingCount, viewports, mode:"map"|"edit" }`
- `<script src="/__clone/editor/edit-map.js" defer></script>`
- a fixed watermark element: **"LOOPBACK PREVIEW — NOT SHIPPABLE"** (cannot be removed by the page).

### Endpoints (all under `/__clone/`, JSON, loopback-armed only; else `403`)
| Method · path | Body | Returns |
|---|---|---|
| `GET /__clone/manifest` | — | full manifest.json |
| `GET /__clone/state` | — | `{ blockingCount, structureAuthorization, slots:[{number,type,role,provenance,keep,hasReplacement,flags}] }` |
| `POST /__clone/slot` | `{ number, op, value?, assetRef? }` | updated slot. `op ∈ replace-text \| replace-asset \| keep \| unkeep \| clear` |
| `POST /__clone/upload` | `{ number, filename, mime, dataBase64 }` | `{ assetRef, generated[], srcsetHtml }` (writes `assets/incoming/`, calls fit-slot) |
| `GET /__clone/editor/*` | — | static overlay files from `scripts/editor/` |

Server mutates `manifest.json` atomically (write temp + rename) and updates `manifest.lock.json`. The overlay
never writes the manifest directly — always via these endpoints.

## 3. Editor overlay ↔ page contract

- The overlay locates each slot's live element by `mirrorLocator.cssPath` + `nth`; falls back to bbox hit-test.
- Badges render numbered chips anchored top-left of each element bbox. **Chrome-role slots are NOT badged**
  (hidden from view) but appear in the table fallback + counter.
- `text` slot: double-click → `contentEditable`; blur/Enter → `POST /slot {op:replace-text}`.
- `img|bg|svg|video` slot: double-click → opens a drop-zone popover (file input + drag-drop) →
  `POST /upload` → on success `POST /slot {op:replace-asset, assetRef}` → swap the live `src`/`srcset`/bg.
- Manual-mode toggle: `map` (badges + inspect only) ↔ `edit` (interactions live). Content-only — the overlay
  NEVER edits structure/layout/CSS (isolation contract).
- Header shows **"N slots block publish"** = `state.blockingCount`. Before/after toggle swaps replacement↔original.
- Perf: badge positions recomputed via `ResizeObserver` + scroll `rAF`-debounce; only on-screen badges drawn
  (`IntersectionObserver`); overlay JS budget < ~30KB; no synchronous layout in scroll handlers.

## 4. fit-slot output

For slot `#n` with `slotSpec` per viewport, emit into `assets/slot-<n>/`:
`<base>.<vp>.<format>` for each viewport (+ avif sibling if enabled), a poster for video, optimized svg as-is.
Return `srcsetHtml` = a ready `<picture>`/`srcset`+`sizes` string keyed to the viewports. Respect `maxBytes`.
If `sharp` absent → copy source at native size + warn (degraded, still functional). If `ffmpeg` absent → copy
video + warn. `clone-deps-check.mjs` is the single source of presence detection.

## 5. publish-gate verdict

1. **Drift guard:** `build-fingerprint.json` vs the build's fingerprint — mismatch ⇒ exit 1.
2. **Structure attestation:** sets `meta.structureAuthorization`. `authorized` ⇒ DOM-derivative allowed;
   `unauthorized` ⇒ clean-room forced (caller must pass `--build-mode clean-room`).
3. **Retained-originals enumeration (interactive or `--attest`):** every `provenance==original` slot incl.
   chrome, forms, analytics/verification IDs, text-as-image — each needs explicit `authorized`. Any `pending`
   or `unauthorized` ⇒ exit 1.
4. **Scans (mechanical):** font-leak grep (no paid-font names), brand-string scrub, **byte-hash AND pHash** for
   each original image (pHash defeats re-encode), JS-dep license check (gated plugins), analytics/verification
   ID strip. Verdict framed "no unmodified original detected" — the human attestation is the real backstop.
5. On PASS: write `NOTICE` (licensing/manifest) into the build. Else exit 1 with the blocking list.
