# 051: Dead code in gltfModel / gltfModelW / gltfWorker (grep-verified, zero call sites)

**Severity:** low
**Fix recommendation:** Nice to have — pure deletion pass; do alongside 030/010 decisions
**Area:** dead code
**Files:** as listed

## Problem

- `gltfModelW.js:688 _ExtendQuadsBatch` and `:704 _cullPoint` — defined, never called anywhere in `src/`. (`_cullPoint` also has latent bugs: compares `vec3.angle` radians to `90`, magic `distance > 1000` — see issue 030.)
- `objectBuffer.js:113 _updateShader` — never called; consequently `ObjectBuffer.boundProgram` is never set and the location fields initialized at 89-92 are only ever written through the `|| true` refetch paths (issue 010).
- `gltfWorker.js:6 let id = Math.random()` — never read.
- `gltfWorker.js` `nodeMatsIndex` — set to 0 / nulled, never read.
- `gltfWorker.js` `animationFinished` — only use is the no-op `if (animationFinished) { animationFinished = true }`; the worker never reports animation finish (the main thread duplicates the whole animation pass just to fire triggers). Also module-level and not saved/restored per instance record — if it ever became functional it would leak between shared-worker instances; same for `currentAnimationFrame` (written twice, never read or sent).
- `gltfWorker.js` — `smoothstep` declared twice with identical bodies; the second silently shadows the first.
- `gltfModelW.js:281 this.drawMeshesMin = this.drawMeshes` — written once, nulled in release, never read.
- `gltfModel.js:30` / `gltfModelW.js:83` `locANormalMatrix` — initialized, never used (`locUNormalMatrix` is the live one).
- `gltfModel.js:32 this.viewPos`, `:33 this.boundProgram` — never read (render uses `this.inst.viewPos`).
- `gltfModel.js` release() nulls `buffBones/buffNodesMat/nodesMat/buffLights/boneBufferViews/msgPort/workerReady` — fields that never exist on the CPU model (copy-paste from the worker version).
- `gltfModel.js:737-740` transformNode computes `scale/xScale/yScale/zScale` locals that are never used; `:772 const weights = node.mesh.weights` unused.
- `gltfModelW.js:817 tmpProjection` — created, referenced only in a commented-out line.
- `uniformLocationCache.js:23 getLocations` — no callers.

## Failure scenario

Dead code — no runtime fault, but real maintenance cost and misleading structure.

## Suggested fix

Delete the items above (fold `_cullPoint` into the issue-030 decision).
