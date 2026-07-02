# 045: Editor instance `Release()` is empty — editor leaks textures/model data; failed loads retry with an alert per instance

**Severity:** medium
**Fix recommendation:** Recommended — medium; improves long editor sessions and failure UX
**Area:** editor
**Files:** `src/instance.js:59` (empty Release), `:141-161` (load failure handling)

## Problem

1. `Release() {}` — editor instances (especially instance-model ones) create `GltfData`, image bitmaps, and `CreateDynamicTexture` GPU textures (`this.texture`, `this.whiteTexture`) that are never freed when the instance is deleted from the layout. The editor type has no release either, so `sdkType.gltfData` also lingers per project session.
2. On shared-model load failure, `sdkType.initOwner` is reset to `-1` while only the failing instance sets its local `loadFailed` flag — every *other* instance of the type retries the load on its next Draw. With `alert()` in the load path (issue 004), that's one modal per instance, and the loop re-arms whenever `OnPropertyChanged("gtlf-path")` clears `loadFailed`.

## Failure scenario

Long editor sessions accumulate leaked textures/model copies; a bad model path produces a cascade of editor alerts.

## Suggested fix

Implement editor `Release()` (release gltfData, delete created textures, close bitmaps); track load failure on the sdkType instead of per-instance so a failed path is attempted once until the property changes.
