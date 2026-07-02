# 023: No WebGL context-loss/restore handling; static dummy bone UBO never freed or recreated

**Severity:** medium
**Fix recommendation:** Recommended — bigger project, but real on mobile/long sessions; start by wiring C3 context events to invalidation flags
**Area:** rendering / lifecycle
**Files:** `src/c3runtime/boneBuffer.js:8, 12-46` (static dummyUBO, `releaseSharedResources` never called — grep confirms definition only), `src/c3runtime/objectBuffer.js:44-86, 168` (VBOs/VAO), `src/c3runtime/gltfData.js` (shared model bone UBO), `src/c3runtime/uniformLocationCache.js`

## Problem

The addon owns many GL objects (per-mesh VBOs/index buffers/VAOs, the per-model shared bone UBO, the static `BoneBufferTop.dummyUBO`, dynamic textures, the cached 3D shader program) but has no context-lost/context-restored handling anywhere. The only nod is `if (renderer.IsContextLost()) return` in `_ExecuteBatch`. `BoneBufferTop.releaseSharedResources` exists precisely for this and is never called from anywhere. After a context restore, `_getOrCreateDummyUBO` keeps returning the dead handle because `if (!BoneBufferTop.dummyUBO)` never re-trips; ObjectBuffers keep dead VAOs; cached uniform locations belong to dead programs.

## Failure scenario

GPU reset / tab context loss (common on long sessions and mobile): after C3 restores its own resources, all 3DObject content renders nothing (or spams GL errors) until a full page reload.

## Suggested fix

Subscribe to C3's context-lost/restored events once (plugin.js already hooks `afterprojectstart`); on loss, null the static dummyUBO, per-object `vao`/buffers (set flags so they lazily recreate on next draw), the shared bone UBOs, `cached3DObjectShader`, and clear `uniformCache`.
