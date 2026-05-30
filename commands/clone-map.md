---
description: Generate/serve the numbered edit-map on a clone's loopback mirror (badges + slot table + counter)
argument-hint: [clone-name]
---

The user wants the **numbered edit-map** for an already-mirrored clone (the see-#N overview before swapping).

**Clone:** $ARGUMENTS

Invoke the **`clone-any-site`** skill, "Repurpose Layer → edit-map" path:

1. Resolve `clones/<name>/`. Require the proven mirror + `repurpose/manifest.json`
   (run `extract-manifest.mjs` first if absent).
2. Serve in editor mode (loopback only):
   `CLONE_EDIT=1 CLONE_LOOPBACK_OK=1 CLONE_REPURPOSE_DIR=clones/<name>/repurpose node .claude/skills/clone-any-site/scripts/serve.mjs clones/<name>/mirror/<host>`
3. Open `http://127.0.0.1:4321/` — numbered color-coded badges (amber = still original, green = yours),
   the **"Slots"** table (incl. hidden chrome), per-breakpoint toggle, and the **"N slots block publish"** counter.
4. From here the user can `keep #N` / `replace #N <file|text>` (`/clone-swap`) or double-click to edit
   (`/clone-modifier`). The map is read-only-safe; nothing ships without `/clone-publish`.
