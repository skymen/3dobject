# 037: Enabling lighting forces full CPU re-polygonization and bbox rebuild every tick, even for static models

**Severity:** medium
**Fix recommendation:** Strongly recommended — big win for lit scenes; small change, verify lighting still updates when intended
**Area:** performance
**Files:** `src/c3runtime/instance.js:256-264` (approx., Tick)

## Problem

```js
} else if (this.renderOnce || this.lightEnable) {
  this.renderOnce = false
  ...
  this.gltf.getPolygons(this.staticGeometry || this.gpuSkinning)
  this.runtime.UpdateRender()
  this.updateBbox = true
}
```

Once `EnableLight(true)` is called, even a completely static, non-animated model re-runs `getPolygons` (full scene-graph transform + vertex pass) and re-fits its bounding box **every tick, forever**, plus forces a redraw every frame.

## Failure scenario

A static lit scene burns CPU proportional to total vertex count every frame, and never idles (UpdateRender each tick).

## Suggested fix

Only re-polygonize when something actually changed: honor the existing `lightUpdate` flag (recompute while `lightUpdate` is on, or when transforms/lights changed) instead of keying on `lightEnable`.
