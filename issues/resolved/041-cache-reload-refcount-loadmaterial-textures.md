# 041: Cross-type cache — re-`load()` leaks the previous entry's refcount; `LoadMaterial` replacement textures never freed when the type's textures are cache-shared

**Severity:** medium
**Fix recommendation:** Recommended — small fixes; becomes important the moment 009 (model reload) is fixed
**Resolution:** Resolved by deletion in v3.0.0 (trim stages 3/4): LoadModel and LoadMaterial were removed, eliminating both leak paths.
**Area:** runtime / model cache (v2.91 feature)
**Files:** `src/c3runtime/gltfData.js` `load()` cache paths (~203-232), `src/c3runtime/type.js` `Release()` (texturesShared skip), `src/c3runtime/actions.js` `LoadMaterial`

## Problem

1. **Refcount leak on re-load:** both cache paths do `this._cacheEntry = entry` without checking for (and releasing) an existing `_cacheEntry`. `Release()` decrements once. If `load()` ever runs twice on the same GltfData — e.g. the `LoadModel` action fired again while the first load is still in flight (the `dataLoaded` guard is false until completion) — one refcount is leaked and that model's shared GPU textures are never freed. This also matters if issue 009's guards are removed to enable model swapping.
2. **Replacement textures leak:** `type.js Release()` skips deleting *everything* in `this.texture` when `texturesShared` is true. But `LoadMaterial` stores freshly created non-cache textures into that same map; when the type releases, those replacements are neither deleted by the type (skipped wholesale) nor by the cache entry (it only owns its own set).

## Failure scenario

(1) Double-fired `LoadModel` before completion → model data + GPU textures for that path never freed for the session. (2) A cache-shared type that used `LoadMaterial` leaks the loaded textures at teardown.

## Suggested fix

In `load()`, release/decrement any existing `_cacheEntry` before adopting a new one. In `type.js Release()`, delete textures individually, skipping only entries that are identity-equal to `cacheEntry.textures[name]` instead of skipping the whole map.
