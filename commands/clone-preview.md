---
description: Watermarked loopback preview of a clone's current swaps (before/after) — never shippable
argument-hint: [clone-name]
---

The user wants to **preview current swaps** on a mirrored clone.

**Clone:** $ARGUMENTS

Invoke the **`clone-any-site`** skill, "Repurpose Layer → mirror-preview" path:

1. Resolve `clones/<name>/`. Ensure swaps exist in `repurpose/manifest.json` (else point to `/clone-swap` / `/clone-modifier`).
2. Serve the preview (loopback only, hard watermark **"LOOPBACK PREVIEW — NOT SHIPPABLE"**):
   `CLONE_EDIT=1 CLONE_LOOPBACK_OK=1 CLONE_REPURPOSE_DIR=clones/<name>/repurpose node .claude/skills/clone-any-site/scripts/serve.mjs clones/<name>/mirror/<host>`
3. Open `http://127.0.0.1:4321/` and use the **Before/After** toggle to compare your content against the
   original, in the original's exact choreography. The mirror payload is untouched; this preview can never be
   exposed publicly (it refuses non-loopback binds and is gitignored). To ship: `/clone-publish`.
