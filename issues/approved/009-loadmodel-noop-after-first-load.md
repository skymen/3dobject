# 009: `Load model` action is a permanent no-op once any model has loaded

**Severity:** high
**Fix recommendation:** Strongly recommended — unlocks a documented feature; needs care around reload + model-cache interplay (see 041)
**Area:** runtime / ACEs
**Files:** `src/c3runtime/actions.js:104-105`, `src/c3runtime/gltfData.js` (`dataLoaded` set, never reset)

## Problem

```js
LoadModel(gltfPath) {
  if (!gltfPath || gltfPath == "" || gltfPath == "path") return
  if (this.instanceModel && this.dataLoaded) return
  if (!this.instanceModel && this.sdkType.dataLoaded) return
  ...
```

`dataLoaded` is set to true on load success and **never reset to false anywhere** (grep confirms only constructor initializations). The code below the guards even releases "the previous per-instance model data before replacing it" — but that replacement path is unreachable except while the very first load is still in flight.

## Failure scenario

Load model A (or set it via the property), then later call "Load model" with model B: silently does nothing. Model swapping at runtime — the apparent purpose of the action — is impossible.

## Suggested fix

Remove the early-return guards (or reset `dataLoaded = false` as the first step of the reload sequence) so the existing release-and-reload logic actually runs. Take care to also reset `loaded`/`doingInit` on affected instances (the code below already does) and to release the previous cache entry (see issue 041).
