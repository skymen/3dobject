# 071: Constructor load path runs with `gltfPath === undefined` when properties are absent

**Severity:** low
**Fix recommendation:** Nice to have — truthiness guard on two lines
**Resolution:** Fixed in v3.0.0 (trim stage 4): constructor load guard is now truthiness-based.
**Area:** runtime / loading
**Files:** `src/c3runtime/instance.js:93` (`if (properties)`), `:127, 134` (load guards)

## Problem

The constructor guards property reads with `if (properties)`, implying they can be absent — but then:

```js
if (this.gltfPath != "path" && this.gltfPath != "") {
  sdkType.gltfData.load(this.gltfPath, true, this.debug)
}
```

`undefined` is neither `"path"` nor `""`, so the guard passes and `load(undefined, ...)` proceeds to `GetProjectFileUrl(undefined)` → the alert/error path (issue 004).

## Failure scenario

Any code path that constructs the instance without properties triggers a bogus load attempt and error dialog instead of a clean no-op.

## Suggested fix

`if (this.gltfPath && this.gltfPath != "path")` at both load guards (constructor and the type-owner branch).
