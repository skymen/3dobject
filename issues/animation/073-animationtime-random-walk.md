# 073: Random jitter is permanently accumulated into `animationTime` — playback drifts and is nondeterministic

**Severity:** low
**Fix recommendation:** Recommended — small change; removes nondeterministic drift (verify the de-sync intent is preserved)
**Area:** runtime / animation
**Files:** `src/c3runtime/instance.js:236-238` (approx., Tick)

## Problem

```js
this.animationTime +=
  this._runtime.GetDt() * this.animationSpeed +
  (Math.random() * (1 / this.animationRate) - 1 / this.animationRate / 2) * 0.1
```

The ±(0.05/rate) noise term is added to the *persistent* time accumulator every tick, so animation time performs a random walk relative to real time (drift grows with √ticks) and playback is nondeterministic (breaks replay/determinism assumptions, and `Math.random()` runs per instance per tick). If the intent was to de-synchronize the per-frame *update scheduling* across many instances (a reasonable goal), the jitter belongs on the `deltaTime >= 1/rate` gate or a per-instance phase offset — not in the accumulated clock.

## Failure scenario

Long-running looped animations drift out of sync with game time; identical runs produce different poses.

## Suggested fix

Replace with a per-instance constant phase offset (`this._animPhase = Math.random() / rate` once) applied to the frame gate, leaving `animationTime` a clean integral of `dt * speed`.
