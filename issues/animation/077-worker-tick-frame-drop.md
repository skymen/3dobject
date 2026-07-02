# 077: Worker mode drops animation frames when the worker isn't ready, instead of deferring them

**Severity:** low
**Fix recommendation:** Nice to have — timing polish; return-a-boolean approach is a small diff
**Area:** worker path / animation timing
**Files:** `src/c3runtime/instance.js` Tick (animation gate ~229-243), `src/c3runtime/gltfModelW.js` `updateAnimationPolygons` (early `if (!this.workerReady) return`)

## Problem

Tick advances the gate before knowing whether the work will happen:

```js
if (deltaTime >= 1 / this.animationRate) {
  this.animationLastTime = this.animationTime   // gate consumed here
  ...
  this.gltf.updateAnimationPolygons(...)        // silently early-returns if !workerReady
}
```

When the worker hasn't replied yet (heavy scene, slow tick), `updateAnimationPolygons` returns without posting — but `animationLastTime` was already advanced, so that animation step is *dropped* rather than deferred; visible pose time skips under load. (The worker's own `needAttributes`/removed-instance replies return the buffer and set `workerReady`, so this is purely about the main-thread gate.)

## Failure scenario

Characters animate at a reduced effective rate (skipping steps) whenever worker round-trips exceed a tick, instead of catching up smoothly.

## Suggested fix

Only advance `animationLastTime` when the model actually accepted the update (e.g. have `updateAnimationPolygons` return a boolean), or move the readiness check before consuming the gate.
