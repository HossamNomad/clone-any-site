---
slug: green-pass
name: Green Pass Effect
category: effect
intent: A minimal DOM effect that mounts cleanly and signals success.
whenToUse: Use when testing that the harness correctly identifies a passing snippet.
artifactFit: [landing, dashboard]
feasibilityTier: green
dimensions: [1]
seenOnSites: []
firstSeen: 2026-06-02
---

## Intent

A minimal DOM effect that mounts cleanly and signals harness success.

## Code

```js
const el = document.getElementById('stage');
el.textContent = 'hi';
el.style.color = 'green';
window.__SNIPPET_OK = true;
```

## Notes

This card is a harness fixture. It mounts immediately and sets the OK signal.
