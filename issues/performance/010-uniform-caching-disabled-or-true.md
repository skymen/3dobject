# 010: Uniform-location caching deliberately disabled via `(x === null || true)` — 10 sites, `gl.getUniformLocation` per draw

**Severity:** high
**Fix recommendation:** Strongly recommended — medium effort (program-keyed invalidation), the _updateShader mechanism already exists
**Area:** rendering / performance
**Files:** `src/c3runtime/boneBuffer.js:111, 182, 243, 255, 288, 302, 312`, `src/c3runtime/objectBuffer.js:237, 248, 266`

## Problem

Ten sites follow this pattern:

```js
if (this.locURotateMatrix === null || true) {
  this.locURotateMatrix = gl.getUniformLocation(shaderProgram, "uUVRotate")
  ...
}
```

The `|| true` makes the condition unconditional — the "cache" refetches on every call. The 7 boneBuffer sites use **raw** `gl.getUniformLocation` (not `globalThis.uniformCache`), so every skinned draw call issues ~4–8 synchronous driver queries (via `uploadUniforms` → `_updateShader` + the 243 block + `uploadUVXformUniforms`; `uploadUniformsNonSkin` at 288/302; `disable` at 312 runs once per mesh per frame). The 3 objectBuffer sites at least route through `uniformCache`, so there `|| true` is only a wasted map lookup — but the code reads as a caching layer that is silently a no-op. `BoneBufferTop._updateShader`'s `boundProgram` early-out is likewise defeated by its own internal `|| true`.

Git history shows caching was disabled to work around a shader-switch bug ("remove caching of locations for now (was seeing errors)") — the real fix is program-keyed invalidation, which `_updateShader`'s `boundProgram` mechanism already sketches.

## Failure scenario

Measurable per-draw CPU/driver overhead scaling with mesh count — worst for skinned characters with many primitives.

## Suggested fix

Remove the `|| true` escapes and invalidate cached locations when `boundProgram !== shaderProgram` (finish the `_updateShader` mechanism); route all boneBuffer lookups through `globalThis.uniformCache`, which is already program-keyed via WeakMap.
