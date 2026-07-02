# 038: Tick's renderOnce path drops the `gpuSkinning` flag when calling the CPU model's `getPolygons`

**Severity:** medium
**Fix recommendation:** Fix immediately — one-line argument fix
**Resolution:** Fixed in v3.0.0 (trim stage 5): gpuSkinning is passed through the renderOnce path.
**Area:** runtime (CPU path + GPU skinning)
**Files:** `src/c3runtime/instance.js:261` (approx.), `src/c3runtime/gltfModel.js` `getPolygons(staticGeometry = false, gpuSkinning = false)` (~931)

## Problem

```js
this.gltf.getPolygons(this.staticGeometry || this.gpuSkinning)
```

`GltfModel.getPolygons` takes `(staticGeometry, gpuSkinning)`; the single-argument call leaves `gpuSkinning = false`, skipping the bone-buffer update branch (`if (gpuSkinning) { ...node.boneBuffer... }`) on this path. The animation path (`updateAnimationPolygons(..., this.staticGeometry, this.gpuSkinning)`) passes both correctly, and `GltfModelW.getPolygons` reads `this.inst.gpuSkinning` internally — only the non-worker renderOnce/light path is affected.

## Failure scenario

A non-worker GPU-skinned model whose redraws are driven by `renderOnce`/`lightEnable` (e.g. animation paused) renders with stale or never-initialized bone data.

## Suggested fix

`this.gltf.getPolygons(this.staticGeometry || this.gpuSkinning, this.gpuSkinning)`.
