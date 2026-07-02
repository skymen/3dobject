# 036: `Load model from template` leaks the instance's own GltfData and can crash on texture load

**Severity:** medium
**Fix recommendation:** Recommended — two small fixes; niche ACE but both a leak and a crash path
**Resolution:** Resolved by deletion in v3.0.0 (trim stage 4): LoadModelFromTemplate and the instanceModel path were removed.
**Area:** runtime / ACEs
**Files:** `src/c3runtime/actions.js:399-427` (approx.), `src/c3runtime/instance.js` (`Release` instanceModel branch, `LoadDynamicTextures` call sites ~169/337)

## Problem

1. **Leak:** the instance was created with `instanceModel = true`, so its constructor allocated `this.gltfData = new GltfData(...)`. The action then sets `this.instanceModel = false` without releasing that GltfData — and `Release()` only frees it `if (this.instanceModel && ...)`, which is now false. The parsed model data (and any decoded buffers) leak.
2. **Crash path:** it sets `this.sdkType = templateInst` — an *instance*, not a type. `doInit`/`Draw` later call `this.sdkType.LoadDynamicTextures(...)`; instances have no such method. If the template's `dynamicTexturesLoaded !== true` at that moment, the call throws (caught in doInit's catch, so the object just never loads).

## Failure scenario

Repeated template swaps leak a full parsed model each time; a swap performed before the template's textures finished uploading leaves the dependent instance permanently unloaded.

## Suggested fix

Release `this.gltfData` before adopting the template; keep `this.sdkType` pointing at the real type and store the template's SDK instance in a dedicated field, routing `LoadDynamicTextures` through `this.GetSdkType()`.
