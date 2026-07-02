# 013: Cached per-triangle light colors are multiplied in place — tinted lit models fade to black

**Severity:** high
**Fix recommendation:** Fix immediately — two-line scratch-vector fix; user-visible darkening bug
**Area:** rendering / lighting (CPU path)
**Files:** `src/c3runtime/gltfModel.js:623-626`

## Problem

```js
const c = drawLights[i]
if (baseColorChanged) vec4.mul(c, c, currentColor)
renderer.SetColorRgba(c[0], c[1], c[2], 1)
```

`drawLights` is only recomputed when `lightUpdate` is true (`if (lightUpdate) drawLights.length = 0`); otherwise the cached vec4 entries persist across frames. `vec4.mul(c, c, currentColor)` writes back into the cached entry, so with any tint (instance color ≠ white, or a material `baseColorFactor` ≠ white) and `lightUpdate` off, each cached color is multiplied by the tint **again every frame**, converging to black.

## Failure scenario

A tinted, statically-lit model (lighting enabled, light update off) visibly darkens over a few dozen frames until it renders black.

## Suggested fix

Multiply into a scratch vec4 instead of mutating the cache:

```js
vec4.mul(tmpColor, c, currentColor)
renderer.SetColorRgba(tmpColor[0], tmpColor[1], tmpColor[2], 1)
```
