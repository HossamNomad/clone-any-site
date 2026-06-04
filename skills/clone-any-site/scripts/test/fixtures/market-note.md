# Active Theory — Market Analysis Note

Analysis of design techniques observed across Active Theory's portfolio.
This is a generalized IP-clean note — no original source code included.

## Magnetic cursor

- dimension: micro-interactions, motion
- tier: green
- artifactFit: site, landing
- intent: The cursor becomes a physical actor — it lags, snaps to targets, and swells over interactives, so the page feels alive and tactile before a single click.
- mechanism: track pointer in a rAF loop; lerp a follower element toward it; on hover of [data-magnetic], translate the target a fraction toward the cursor and scale the follower.

## WebGL fluid hero

- dimension: immersion
- tier: red
- artifactFit: site
- intent: A full-viewport fluid simulation reacts to mouse movement, creating the sense of touching a living surface rather than viewing a static image.
- mechanism: render a two-texture ping-pong FBO in WebGL; each frame splat pointer velocity into the advection field; distort the background layer by the velocity gradient.
- approximation: CSS backdrop-filter blur + a CSS radial-gradient that tracks the pointer via custom property; achieves the "liveness" feeling at 1/100th the GPU cost.

```js
// This fenced code block must NEVER appear in any output card.
// It is here to prove the IP guard works.
const SECRET_VERBATIM = "activetheory_proprietary_shader_code_v7";
function fluidSim(canvas, opts) {
  const gl = canvas.getContext('webgl2');
  // ... 200 more lines of studio-specific implementation ...
  return gl;
}
export default fluidSim;
```
