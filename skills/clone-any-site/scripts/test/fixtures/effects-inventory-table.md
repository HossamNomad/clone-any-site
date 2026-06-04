# Effects Inventory — Table fixture (Task 2.1 test)

## Stack snapshot

DOM/CSS only — no webgl, no gsap, no three.js, no lenis, no canvas, no r3f.

## Effect table

| ID | Effect | Mechanism | Fidelity note |
|----|--------|-----------|---------------|
| E1 | **Hero + typewriter** | types the headline letter by letter | Settle before capture |
| E2 | **Scroll parallax** | translateY on scroll | Assert scroll landed |
| E3 | **Lazy image reveal** | fade + translate on IntersectionObserver enter | Wait for decode |
| E4 | **Background video loop** | video loop muted playsinline | Pause + currentTime=0 |
