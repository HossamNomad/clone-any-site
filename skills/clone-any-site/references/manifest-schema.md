# The numbered manifest (`repurpose/manifest.json`)

The manifest is the **single source of truth** for the Repurpose Layer. `extract-manifest.mjs` produces it from
the proven loopback mirror; the edit-map/editor, swap engine, and publish-gate all read & write it; one manifest
drives **two targets** (the internal mirror-preview and the publishable build). Validated by
[`manifest.schema.json`](../scripts/manifest.schema.json).

## Why numbers
Every editable element gets a **stable number** (`#1`, `#2`, …) that survives re-runs of a frozen mirror. You
keep-or-swap by number — `replace #3 hero.jpg`, `keep #7` — in the CLI or by double-clicking `#3` in the editor.
Numbering is **section-scoped + content-anchored**: it doesn't shuffle when an unrelated element changes.

## Slot fields (the ones you touch)
| Field | Meaning |
|---|---|
| `number` | The stable handle. |
| `type` | `text · img · bg · svg · video · icon · section`. |
| `role` | `content` (editable, badged) or `chrome` (nav/footer/legal — hidden from the edit view but always scanned + counted). |
| `provenance` | `original` (still theirs — blocks publish until authorized or swapped) · `user` · `substitute` · `ai`. |
| `currentValue` / `currentValueRef` | the present text / asset. |
| `replacement` | what you swapped in (text or asset + generated responsive set). |
| `keep` | you reviewed `#N` and consciously kept the original content. |
| `slotSpec` | per-viewport target dims/fit/focal/format/weight — how `fit-slot` shapes a dropped file. |
| `breakpointScope` | per-viewport variants merged under one number (e.g. a different hero at 390 vs 1440). |
| `flags` | `data-driven:not-mirrored` · `text-as-image:review` · `cross-origin:not-mirrored` · `paid-font` · `analytics-id` · `form-action` · `consent-vendor` · `embed:cross-origin`. |

## The "blocks publish" counter
`meta.counts.blocking` = retained originals not yet authorized or swapped. The editor header shows it live as
**"N slots block publish"**. The publish-gate refuses while it's > 0 (or anything unattested remains). Chrome,
forms, analytics IDs and text-baked-into-images all count — they can't be skipped.

## Locators (how a number finds its element)
Each slot carries a **dual locator**: `mirrorLocator` (cssPath + nth + contentHash + per-viewport bbox) for the
loopback mirror, and `sourceAnchor` (a clean-room marker like `data-slot="s003"`) so the SAME manifest can feed
the clean-room rebuild when the structure isn't authorized for a DOM-derivative.

## Drift guard
`build-fingerprint.json` records the mirror's build-id + crawl-log hash. If the reference moved under you, a
stale manifest applied to a fresh mirror is **refused** — no silent mismatches.
