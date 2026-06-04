---
slug: red-skip
name: Red Skip Effect
category: effect
intent: A WebGL-dependent effect that cannot run in a plain browser context.
whenToUse: Use when testing that harness:skip cards with ## Approximation are accepted.
artifactFit: [landing]
feasibilityTier: red
dimensions: [2]
harness: skip
seenOnSites: []
firstSeen: 2026-06-02
---

## Intent

A WebGL-dependent effect that cannot be tested in a headless browser without a GPU pipeline.

## Approximation

Simulate with a CSS gradient animation that cycles hue over 3 seconds:

```css
@keyframes hue-cycle { from { filter: hue-rotate(0deg); } to { filter: hue-rotate(360deg); } }
#stage { animation: hue-cycle 3s linear infinite; background: #3af; width: 100px; height: 100px; }
```

## Notes

This card is skipped by the harness because `harness: skip` is set. It includes
a `## Approximation` section as required.
