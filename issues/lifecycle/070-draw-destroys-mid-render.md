# 070: `Draw()` destroys the instance mid-render when the template's model data is gone

**Severity:** low
**Fix recommendation:** Nice to have — defer the destroy to Tick; cheap insurance
**Area:** lifecycle
**Files:** `src/c3runtime/instance.js:330-334` (approx.)

## Problem

```js
if (!gltfData) {
  // Source destoryed, destroy this instance
  this.runtime.DestroyInstance(this.GetInstance())
  return
}
```

Destroying instances during the render pass (rather than deferring to `Tick`) risks mutating the instance lists the renderer is iterating, and it silently kills objects with no "On destroyed" context that event sheets can reason about.

## Failure scenario

Destroy a `LoadModelFromTemplate` template while dependent instances are on-screen: dependents vanish via mid-draw destroys, with engine-internal iteration invariants at the mercy of C3's tolerance.

## Suggested fix

Set a flag in `Draw` and perform the destroy at the top of the next `Tick()`.
