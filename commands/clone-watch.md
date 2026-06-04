---
description: Watch a clone's swaps/ folder and auto-process numbered files as they're dropped (Clone Atlas)
argument-hint: [clone-name]
---

The user wants **folder-drop watch mode** — drop a numbered file into a clone's `swaps/` folder and have it
auto-compressed and swapped into that slot, animations untouched.

**Clone:** $ARGUMENTS

Invoke the **`clone-any-site`** skill, "Clone Atlas → watch" path:

1. Resolve `clones/<name>/`. Require the proven mirror + `repurpose/manifest.json` and a `swaps/` folder
   (run `/clone-map <name>` first to learn the numbered slots).
2. Start the watcher (loopback only):
   `node .claude/skills/clone-any-site/scripts/clone-watch.mjs --clone clones/<name>`
   (or `npm run clone:watch` from `skills/clone-any-site/scripts`).
3. Drop files named by slot number (e.g. `VID-04.mp4`, `IMG-07.jpg`) into `clones/<name>/swaps/`. Each is
   auto-compressed (sharp for images / ffmpeg for video, timing preserved) and applied to **only** that slot.
4. After each drop, confirm with `/clone-verify <name>` — the swap must survive with animations intact and
   zero console errors. Nothing ships without `/clone-publish`.
