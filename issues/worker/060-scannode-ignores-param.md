# 060: `scanNode` hardcodes `gpuSkinning = true` and drops its arguments on recursion

**Severity:** low
**Fix recommendation:** Nice to have — small cleanup; honor or remove the parameter
**Area:** worker path / memory
**Files:** `src/c3runtime/gltfModelW.js` `scanNode` (~328-329 hardcode, ~404-408 recursion)

## Problem

```js
scanNode(node, scanSkin, gpuSkinning) {
  gpuSkinning = true
  ...
  this.scanNode(node.children[ii])   // scanSkin/gpuSkinning silently undefined
```

The parameter is overwritten to `true`, so JOINTS/WEIGHTS/original-position arrays are always retained on drawMeshes even for CPU-skinned worker instances (wasted memory — mitigated since v2.90 by attribute sharing, but the copies are still made when type conversion is needed). The recursive call passes only `node`, so `scanSkin` becomes undefined for children; also, if a `scanSkin` node ever lacked a mesh, `node.mesh.primitives` at the top would throw (currently unreachable because callers pass mesh-bearing skinned nodes).

## Failure scenario

Memory waste on CPU-skinned worker models; latent crash/logic trap for future callers.

## Suggested fix

Either remove the parameter (and the pretense) or honor it from `this.inst.gpuSkinning`; forward the arguments in the recursive call; guard `node.mesh`.
