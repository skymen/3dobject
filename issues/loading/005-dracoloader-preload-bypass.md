# 005: DRACOLoader `_getWorker` bypasses the `preload()` cache — re-downloads the WASM per decode task and leaks blob URLs

**Severity:** critical
**Fix recommendation:** Fix immediately — one-line fix with a large real-world impact on every Draco load
**Area:** loading / Draco
**Files:** `src/c3runtime/DRACOLoader.js:372-373` (vs `preload()` at 352-356)

## Problem

`preload()` caches the decoder init promise in `this.decoderPending`, but `_getWorker` calls the *uncached* initializer directly:

```js
_getWorker( taskID, taskCost ) {
    return this._initDecoder().then( () => {
```

Every `decodePrimitive` therefore re-runs `_initRuntimeDecoder`: two fresh network fetches (`draco_decoder.wasm` + `draco_wasm_wrapper.js`) and a brand-new `URL.createObjectURL` blob assigned to `this.workerSourceURL` — the previous blob URL is never revoked (leak), and concurrent decodes race on `workerSourceURL`/`decoderConfig`.

## Failure scenario

A model with 20 Draco primitives performs ~40 redundant network fetches and leaks ~20 blob URLs during load; load time and memory scale with primitive count instead of being O(1).

## Suggested fix

Change `_getWorker` to `return this.preload().then(...)` so the cached `decoderPending` promise is used. Revoke the old `workerSourceURL` if it is ever regenerated.
