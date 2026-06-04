---
slug: broken
name: Broken Effect
category: effect
intent: A snippet that throws at runtime, never reaching the OK signal.
whenToUse: Use when testing that the harness correctly catches a failing snippet.
artifactFit: [landing]
feasibilityTier: green
dimensions: [1]
seenOnSites: []
firstSeen: 2026-06-02
---

## Intent

A snippet that throws at runtime — the harness must catch this as a failure.

## Code

```js
nope.doesNotExist();
window.__SNIPPET_OK = true;
```

## Notes

This card is a harness fixture for the failure path. The reference to `nope` throws
a ReferenceError before `__SNIPPET_OK` is set.
