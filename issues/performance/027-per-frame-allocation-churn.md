# 027: Per-frame / per-triangle allocation churn in hot paths (umbrella)

**Severity:** medium
**Fix recommendation:** Recommended — incremental; take the CPU lit path (item 1) first, it dwarfs the rest
**Area:** performance
**Files:** multiple (itemized below)

## Problem

Remaining allocation churn after the v2.90 cleanup, roughly in order of impact:

1. **CPU lit path** `gltfModel.js:546-611`: per *triangle* — `vec3.create()` ×4, `vec3.fromValues` ×4, `vec3.clone` ×2, `vec4.create()`, plus `Object.values(this.inst.lights)` per triangle. Thousands of allocations per frame on a lit model. (The worker version already hoists these into module scratch vars; the CPU version was never updated.)
2. **Worker light path** `gltfWorker.js` `typedVertsToDrawVerts` (~1131): `new Array(bufferView.length)` per bufferView per light tick; `updateLight` (~962, 972): `vec3.fromValues`/`vec3.clone` per light per triangle.
3. **`buffLights` sizing** `gltfWorker.js` (~644): sized `buffLength * 4` bytes = one uint32 per vertex-*float* — ~9× larger than the one-per-triangle actually needed.
4. **`transformDrawVerts`** (`gltfModel.js:1195-1215`, `gltfModelW.js:303-326`): fresh nested plain arrays every frame when `fragLight && isWebGPU`.
5. **UV transform quads** (`gltfModel.js:429-433`, `gltfModelW.js:994-998`): `uvQuad` triple-nested array per triangle plus `[rotateMaterial.x, rotateMaterial.y]` literals ×6 per triangle when a material offset/rotate is active.
6. **Animation blend snapshots**: `this._lastTarget[idx] = []` plus per-channel `{}`/`vec3.clone`/`quat.clone` per animation tick (gltfModel.js:1539+, same in gltfModelW.js and gltfWorker.js) — only when `animationBlend != 0`.
7. **Instance Tick/Draw** `instance.js`: `const tempQuad = C3.New(C3.Quad)` every `Draw` (~344); `_updateBoundingBox` allocates a fresh 8×3 `cube` array-of-arrays plus per-corner `vec3.fromValues` — and runs every tick for any moving object because the position-change detector always sets `updateBbox`.

## Failure scenario

Constant GC pressure scaling with model complexity and instance count; frame spikes during minor GCs on lit/animated scenes.

## Suggested fix

Hoist scratch vectors/quads/cubes to instance- or module-lifetime reusables (the worker's `calculateLight` shows the pattern); size `buffLights` from the triangle count; reuse the uvQuad arrays; snapshot blend targets into preallocated buffers.
