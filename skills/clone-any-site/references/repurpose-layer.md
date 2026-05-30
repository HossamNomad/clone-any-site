# The Repurpose Layer (after the fidelity gate passes)

The mirror + fidelity gate prove a **pixel-perfect** local copy. The Repurpose Layer makes it **malleable**: a
numbered manifest + a visual editor + a two-target swap engine + a blocking IP gate. `/clone` stops after
producing the malleable mirror; repurposing is **on demand** and always by **targeted swaps that keep 100% of
the structure/animations/interactivity** — never an auto from-scratch rebuild.

## Pipeline

```
fidelity gate PASS
  → extract-manifest.mjs     numbered, classified, frozen-time, multi-viewport → repurpose/manifest.json
  → distill-techniques.mjs   3–7 generalized technique cards → design-system/clone-techniques/  (§ below)
  ── STOP (default /clone deliverable) ──
  → /clone-map | /clone-modifier   see-#N + edit (badges, double-click, drag-drop, manual mode)
  → /clone-swap "#N <file|text>"   validate-manifest → apply-swaps (2 targets) → fit-slot (responsive set)
  → /clone-preview                 watermarked loopback before/after
  → /clone-publish                 publish-gate → build → design-symphony Polish+Verify → multi-viewport gate → deploy [HUMAN PAUSE]
```

One **numbered manifest** is the single source of truth; it drives **two targets** identically — the internal
**mirror-preview** (max fidelity, watermarked, loopback-only) and the **publishable build**. Edit once, both stay
in sync. See [manifest-schema.md](manifest-schema.md) + [clone-interfaces.md](clone-interfaces.md).

## Legitimacy model — what determines the publishable target

The publishable build is chosen by an **authorization attestation on the STRUCTURE itself** (not just assets),
enforced by `publish-gate.mjs` per public deploy:

- **Authorized structure** (you own it / are the client's vendor / a licensed template — e.g. rebuilding your own
  old site, a client's site, the `cinematic-lounge` template): the publishable target may be the
  **DOM-derivative** — the mirror's structure/CSS/animations with content swapped per the manifest, fonts
  substituted, analytics/brand-strings scrubbed, ship-hygiene added.
- **Unauthorized structure** (studying an arbitrary third-party site): the gate **forces the clean-room rebuild**
  — effect vocabulary reproduced, the original's code/CSS not shipped. The **same manifest** feeds your content
  into the clean-room scaffold.

The gate is **mechanical and blocking**: an interactive per-deploy attestation enumerates every retained original
(including hidden chrome, forms, analytics/verification IDs, and text baked into images); scans run font-leak
grep, brand-string scrub, **byte-hash + perceptual-hash** (re-encode defeats byte-equality), and a JS-dependency
license check; analytics IDs are stripped. Internal/loopback study is unrestricted; **nothing public ships
without a PASS.** The clean-room rebuild is never automatic — it's the gate's fallback or an explicit request.

## Mobile art-direction (v1)

`extract-manifest` captures at **390 / 768 / 1440**; slots carry per-breakpoint bboxes + variants. `fit-slot`
emits real `srcset`/`sizes`/`<picture>` sets from one dropped file. The multi-viewport fidelity gate runs
**mobile 390@DPR3 + desktop 1440@DPR2** in one PASS, plus a touch-interaction survival harness.

## Technique absorption ledger (§11.5)

Every clone targets a best-in-class site, so each run must leave us *better at building*. After the gate,
`distill-techniques.mjs` extracts 3–7 **generalized** technique cards (the *mechanism* of an animation / scroll
choreography / effect / interaction, a minimal original-free code-sketch, and where to reuse it in
Pulsia/Atlas/clients) into the cumulative cross-project library `design-system/clone-techniques/`
(index `TECHNIQUES.md`), deduped (a repeat bumps "seen on N sites"). It stores **metadata + recipes only — no
original assets/code** — and feeds design-symphony + frontend-design so each clone raises our default build
quality.

## design-symphony binding

The publishable build flows into **design-symphony's Polish + Verify** phases (voice-gate-marketing +
pulsia-truth-gate to scrub the original's tone/claims, impeccable, Lighthouse, a11y, SEO) — not a parallel
quality stack. See `.claude/skills/design-symphony/SKILL.md`.

## v1.1 (deferred, hooks documented)

WebGL/3D slot-mapping · asset generation (CC0 / Higgsfield-Kling) + auto-alt-text · measured behavioral-
regression gate · round-trip 3-way reconcile · rich edit-map (contact-sheet, per-origin colors) · live
layout/CSS editing in manual mode · `/clone-variant <brand>`.
```
