---
description: Run the IP publish-gate, then build the publishable target (DOM-derivative or clean-room). Human-pause before deploy.
argument-hint: [clone-name]
---

The user wants to **publish** a repurposed clone. This is the legitimacy checkpoint — treat it as blocking.

**Clone:** $ARGUMENTS

Invoke the **`clone-any-site`** skill, "Repurpose Layer → publish-gate" path:

1. Resolve `clones/<name>/repurpose/manifest.json`. Run the **interactive attestation**:
   `node .claude/skills/clone-any-site/scripts/publish-gate.mjs --manifest <manifest> --build <repurpose>/build --interactive`
   - It enumerates **every retained original** — including hidden chrome (nav/footer/legal/contact), forms,
     analytics/verification IDs, and text baked into images — and asks you to authorize the **structure** itself.
   - It runs mechanical scans: font-leak, brand-string, **byte-hash + perceptual-hash**, JS-dep license, and
     strips analytics IDs. It will **exit 1** while anything is unauthorized or any unmodified original is detected.
2. On the structure verdict: **authorized** → build the **DOM-derivative** (mirror structure/CSS/animations +
   your content from the manifest); **unauthorized** → the gate forces the **clean-room rebuild** (same manifest
   feeds your content into a from-scratch scaffold). Never the raw mirror.
3. Flow the build into **design-symphony Polish + Verify** (voice-gate, truth-gate, impeccable, Lighthouse,
   a11y, SEO) and the **multi-viewport fidelity gate** (mobile 390 + desktop 1440).
4. **HUMAN PAUSE** before any public deploy — confirm with the user, deploy via `deploy-with-verify`, and
   **never under the original brand**. Nothing public ships without a gate PASS.
