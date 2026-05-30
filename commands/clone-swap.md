---
description: Apply content swaps to a clone by slot number (replace #N <file|text>, keep #N) — validate then write 2 targets
argument-hint: "#N <file|text> ..."
---

The user wants to **swap content by slot number** on a mirrored clone.

**Swaps:** $ARGUMENTS

Invoke the **`clone-any-site`** skill, "Repurpose Layer → swap engine" path:

1. Resolve `clones/<name>/repurpose/manifest.json`. Parse each `#N <file|text>` / `keep #N` instruction.
2. For each media file: `node .claude/skills/clone-any-site/scripts/fit-slot.mjs --slot N --in <file> --manifest <manifest> --out <repurpose>/assets` (responsive set per slotSpec). For text: set the replacement directly.
3. **Always dry-run first:** `node .claude/skills/clone-any-site/scripts/validate-manifest.mjs --manifest <manifest>` — fix any errors before writing.
4. Apply to both targets: `node .claude/skills/clone-any-site/scripts/apply-swaps.mjs --manifest <manifest> --mirror clones/<name>/mirror/<host> --target both` (idempotent; never mutates the gitignored mirror payload).
5. Report the updated **"N slots block publish"** count. Preview with `/clone-preview`; ship only via `/clone-publish`.
