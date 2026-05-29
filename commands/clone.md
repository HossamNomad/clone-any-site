---
description: Clone any website to high fidelity, then repurpose it as your own (loopback mirror → fidelity gate → clean-room engine)
argument-hint: <url> [notes]
---

The user wants to clone a website and eventually repurpose it as their own.

**Target:** $ARGUMENTS

Invoke the **`clone-any-site`** skill and follow its workflow exactly. Do not improvise a hand-rebuild of a
3D/WebGL site from guesses — the skill exists precisely because that doesn't work.

Specifically:
1. **Announce + scope**: state you're using `clone-any-site` on the target, and judge whether it's a
   static/simple page or a heavy WebGL/3D scroll site (that changes the depth of work).
2. **Plan first** for anything non-trivial: generate the wave-based cahier des charges from the skill's
   `references/launch-prompt.md` (target = the URL above) and get it approved **before** writing code.
3. Then run the waves: **Recon → Mirror (loopback) → Fidelity gate → [human pause for brand/object/copy/fonts]
   → Engine from scratch → Repurpose → Verify**.
4. Honor the skill's hard constraints: the 1:1 mirror is **loopback-only and gitignored, never deployed under
   the original brand**; only the repurposed version (the user's own content + licensed/substitute fonts)
   ever ships publicly; pause for a human before any public deploy or spending money.

If no URL was provided above, ask the user for the target URL before proceeding.
