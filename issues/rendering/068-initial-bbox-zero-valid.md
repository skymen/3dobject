# 068: `_updateBoundingBox` treats the initial `[0,0,0]` min/max as a valid dynamic bbox

**Severity:** low
**Fix recommendation:** Nice to have — init-value change; low impact, easy
**Area:** runtime / bounding box
**Files:** `src/c3runtime/instance.js:35-36` (init to zeros), `~417-423` (`hasValidDynamicBbox`)

## Problem

```js
const hasValidDynamicBbox = maxBB && minBB && maxBB[0] !== -Infinity && minBB[0] !== Infinity
```

only rejects the ±Infinity sentinels, but `minBB`/`maxBB` are initialized to `[0,0,0]` and only get real values after the first polygon pass. `doInit` calls `_updateBoundingBox` before any polygon update, so a non-GPU-skinned model briefly gets a degenerate 1×1 box (the `width == 0 ? 1 : width` fallback) instead of falling back to the model's static `gltfData.boundingBox`.

## Failure scenario

First-frame visibility/picking/overlap tests run against a 1×1 box at the origin offset until the first polygon update lands.

## Suggested fix

Initialize `minBB`/`maxBB` to ±Infinity (matching what `getPolygons` resets them to), or treat the untouched `[0,0,0]/[0,0,0]` pair as invalid too.
