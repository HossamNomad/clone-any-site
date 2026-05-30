---
description: Open the interactive visual editor on a clone (double-click text/images to edit, drag-drop import, manual mode)
argument-hint: [clone-name]
---

The user wants to **visually edit** an already-mirrored clone — the headline interactive editor.

**Clone:** $ARGUMENTS

Invoke the **`clone-any-site`** skill, "Repurpose Layer → interactive editor" path:

1. Resolve the clone dir `clones/<name>/` (ask if ambiguous). Require an existing proven mirror +
   `clones/<name>/repurpose/manifest.json` (if missing, run `extract-manifest.mjs` first — it needs the
   loopback mirror serving and a passing fidelity gate).
2. Serve the mirror in **editor mode** (loopback only):
   `CLONE_EDIT=1 CLONE_LOOPBACK_OK=1 CLONE_REPURPOSE_DIR=clones/<name>/repurpose node .claude/skills/clone-any-site/scripts/serve.mjs clones/<name>/mirror/<host>`
3. Tell the user to open `http://127.0.0.1:4321/` in **VS Code's Simple Browser** (Cmd/Ctrl-Shift-P →
   "Simple Browser: Show") or any browser. Numbered badges appear on every editable element.
   - **double-click text** → edit inline; Enter saves.
   - **double-click an image/illustration/photo/video** → drop a file (or click to choose) → it's fit to the
     slot and swapped live.
   - **"Manual"** toggle keeps the page fully interactive while editing; **"Before/After"** compares.
   - the header shows **"N slots block publish"**.
4. Every edit writes back to the numbered manifest (single source of truth). Structure/animations are never
   touched (content-only isolation contract). The preview is watermarked and loopback-locked — it never ships.
5. When done, `/clone-publish <name>` runs the IP gate before any build/deploy.

Honor the skill's hard constraints (mirror loopback-only & gitignored; nothing public without the gate).
