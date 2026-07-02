# 039: Systemic reliance on private C3 runtime APIs

**Severity:** medium
**Fix recommendation:** Nice to have — ongoing debt; adopt the wrap-and-localize strategy incrementally as APIs break
**Area:** compatibility / maintenance
**Files:** throughout (worst offenders listed)

## Problem

The addon reaches into a large number of underscore-private C3 internals that Scirra can rename at any release:

- `renderer._gl`, `renderer._indexBuffer`, `renderer._vertexBuffer`, `renderer._texcoordBuffer`, `renderer._vertexData`, `renderer._texcoordData`, `renderer._vertexPtr`, `renderer._texPtr`, `renderer._batchState`, `renderer._batch`, `renderer._batchPtr`, `renderer._topOfBatch`, `renderer._matMV`, `renderer._ExecuteBatch` (objectBuffer.js, gltfModel.js, gltfModelW.js, instance.js)
- `layer._GetViewFrustum()` (instance.js `IsOnScreen`)
- `wi._UpdateZElevation()` (instance.js, actions.js)
- `runtime._iRuntime.createWorker` / `runtime._iRuntime.addEventListener` (gltfModelW.js, plugin.js)
- `C3.Gfx.WebGLShaderProgram.GetDefaultVertexShaderSource_WebGL2` (plugin.js)
- `self.IInstance._GetInitInst()` (instance.js script interface)
- `batchState.currentShader._shaderProgram` (everywhere uniforms are set)

Historically these have broken across C3 updates (the repo's git log shows repeated fixups).

## Failure scenario

Any C3 runtime update that renames or restructures these internals breaks the addon for every user simultaneously.

## Suggested fix

Track as one debt item. Migrate to public equivalents where they exist (official worker creation API, public viewport tests); wrap each remaining private access in a single guarded helper module so breakage is localized, detectable at startup, and fixable in one place.
