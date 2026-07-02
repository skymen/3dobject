# 001: Unconditional `renderer._gl` access in Tick crashes WebGPU (and is redundant on WebGL)

**Severity:** critical
**Fix recommendation:** Fix immediately — one-line guard; unconditional crash on WebGPU renderers
**Resolution:** Fixed in v3.0.0 (trim stage 5): element-buffer restore is WebGL-guarded and only runs after an actual draw.
**Area:** runtime
**Files:** `src/c3runtime/instance.js:298` (approx.)

## Problem

`Tick()` ends with:

```js
this.renderer._gl.bindBuffer(this.renderer._gl.ELEMENT_ARRAY_BUFFER, this.renderer._indexBuffer)
```

This runs every tick for every instance with no `isWebGPU` guard, even though the constructor already computes `this.isWebGPU = this.renderer.IsWebGPU()` and other code paths check it. On a WebGPU renderer `renderer._gl` is undefined → `TypeError` every tick. On WebGL it is a redundant driver call: it runs even before the model is loaded and even for instances that never draw anything this frame.

## Failure scenario

Any project exported or previewed with the WebGPU renderer: the plugin throws each tick and the game breaks. On WebGL, wasted per-tick GL binds scale with instance count.

## Suggested fix

Guard with `if (!this.isWebGPU && this.renderer._gl) ...` and only restore the element array buffer when the instance actually drew this frame (e.g. set a flag in `Draw()` and clear it after the restore).
