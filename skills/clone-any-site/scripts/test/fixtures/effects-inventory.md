# Effects inventory — static test fixture

Recon output enumerating the notable interaction/render techniques observed on the
reference site. Each H2/H3 heading (or top-level bullet) is a distillable candidate
technique. Metadata + generalized recipes only — no original asset bytes or source code.

## Pinned canvas scroll-scrub

A `position: sticky` / pinned `<canvas>` whose frame is driven by scroll progress
(image-sequence or WebGL draw keyed to `scrollY`). Gives the "video scrubs as you
scroll" feel without an actual playing `<video>`.

## Lenis smooth scroll

Inertial smooth-scroll layer (Lenis / Locomotive style) that intercepts native wheel
events and lerps `scrollY` toward a target for a weighted, momentum feel.

## Marquee infinite track

A horizontally translating track duplicated end-to-end so the loop is seamless;
`transform: translateX` animated on `requestAnimationFrame` or CSS keyframes, paused
on hover.

## Reveal on scroll (IntersectionObserver)

Elements start hidden/offset and animate in (fade + translate) the first time they
cross the viewport, observed via `IntersectionObserver` with a one-shot unobserve.
