---
description: Clone any website to high fidelity, then (on demand) repurpose it as your own — loopback mirror → fidelity gate → numbered manifest → edit-map
argument-hint: <url> [notes]
---

The user wants to clone a website and (later, on demand) repurpose it as their own.

**Target:** $ARGUMENTS

Invoke the **`clone-any-site`** skill and follow its workflow exactly. Do not improvise a hand-rebuild of a
3D/WebGL site from guesses — the skill exists precisely because that doesn't work.

Specifically:
1. **Announce + scope**: state you're using `clone-any-site` on the target, and judge whether it's a
   static/simple page or a heavy WebGL/3D scroll site. Give the **two-axis clonability + modifiability verdict
   upfront** (before building).
2. **Plan first** for anything non-trivial: generate the wave-based cahier des charges from the skill's
   `references/launch-prompt.md` and get it approved **before** writing code.
3. Run the default waves: **Recon → Mirror (loopback) → Fidelity gate → extract numbered manifest +
   distill techniques — then STOP.** The default `/clone` deliverable is a **pixel-perfect, ultra-malleable
   mirror + a numbered manifest + a ready edit-map**. Do **NOT** auto-build a brand/Pulsia version.
4. **Repurposing is on demand only** (never automatic), via the companion commands — and always by **targeted
   swaps that keep 100% of the structure/animations/interactivity**, not a from-scratch rebuild:
   - `/clone-map <name>` — numbered edit-map overlay (badges + slot table + "N block publish" counter)
   - `/clone-modifier <name>` — interactive visual editor (double-click to edit text/images, drag-drop import, manual mode)
   - `/clone-swap "#N <file|text>"` — swap by number (validate → fit-slot → apply to both targets)
   - `/clone-preview <name>` — watermarked loopback preview (before/after)
   - `/clone-publish <name>` — IP publish-gate → publishable build → design-symphony → multi-viewport gate
5. Honor the hard constraints: the 1:1 mirror is **loopback-only and gitignored, never deployed under the
   original brand**; only an authorized, gate-passed repurpose ships publicly; **pause for a human** before any
   public deploy or spending money.

If no URL was provided above, ask the user for the target URL before proceeding.
