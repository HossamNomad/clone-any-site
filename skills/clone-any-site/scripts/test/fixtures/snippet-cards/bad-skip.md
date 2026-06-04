---
slug: bad-skip
name: Bad Skip Effect
category: effect
intent: A card marked harness:skip but missing the required Approximation section.
whenToUse: Use when testing that the harness rejects a skip without ## Approximation.
artifactFit: [landing]
feasibilityTier: green
dimensions: [1]
harness: skip
seenOnSites: []
firstSeen: 2026-06-02
---

## Intent

This card is marked `harness: skip` but deliberately omits the `## Approximation` section.
The harness must treat this as a failure.

## Notes

Fixture for the bad-skip failure path in verify-snippets tests.
