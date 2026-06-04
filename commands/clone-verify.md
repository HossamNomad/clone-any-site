---
description: Verify a clone swap survived — element census, animation/frame-diff, console-error scan (Clone Atlas)
argument-hint: [clone-name]
---

The user wants to **verify a swap** held: the new content is in the right slot, the surrounding structure and
animations are intact, and nothing broke.

**Clone:** $ARGUMENTS

Invoke the **`clone-any-site`** skill, "Clone Atlas → verify" path:

1. Resolve `clones/<name>/`. Require the proven mirror + `repurpose/manifest.json` and at least one applied swap.
2. Run the verifier:
   `node .claude/skills/clone-any-site/scripts/clone-verify.mjs --clone clones/<name>`
   (or `npm run clone:verify` from `skills/clone-any-site/scripts`).
3. It checks: the swapped slot resolves to the new asset; the animation census is unchanged (same number of
   moving/animated nodes as the proven mirror); a before/after frame-diff on the touched region; and a
   console-error scan. **Trust the `verify-report.json`, not green checkmarks** — a pipeline can report
   success while serving a blank.
4. If verify fails, fix the swap (or re-`/clone-map`) and re-run. Ship only via `/clone-publish`.
