---
description: Open the Clone List dashboard — see, preview, launch, edit, and retire every clone you've made
argument-hint: "[clones-root]"
---

The user wants to see and manage all their clones in one place (preview thumbnails, open/close loopback
mirrors, decide what to keep or delete).

**Clones root:** $ARGUMENTS  (default: `clones/` in the current repo)

Invoke the **`clone-any-site`** skill's dashboard:

1. Launch the live dashboard on loopback:
   ```bash
   node .claude/skills/clone-any-site/scripts/clone-list.mjs <clones-root-or-omit>
   ```
   It prints `CLONE_LIST_PORT=<n>` and serves `http://127.0.0.1:<n>/`.
2. Open that URL (browser / VS Code Simple Browser). The gallery shows every clone as a card: thumbnail
   (reused from the fidelity screenshot when present, else a placeholder), source URL, fidelity badge,
   "N elements · M swaps", disk size, last-modified, and a live dot.
3. Per card: **Open** (loopback mirror), **Edit** (visual editor — needs an edit-map), **Stop** (closes that
   clone's server). The user can close clone tabs and reopen later from here.
4. Keep/delete: tick **delete** on cards → **Move to trash…** → confirm. Clones move to
   `clones/_trash/<name>-<timestamp>/` (recoverable — never a real delete on a click). The **Trash** drawer
   restores them. Emptying the trash for good is a separate, explicit manual step the user does themselves.

Hard rules: loopback only (127.0.0.1), never deploy; never permanently delete on a click. If the clones root
has no clones, say so and offer to `/clone <url>` a first one.
