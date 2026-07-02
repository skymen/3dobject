# 063: `SetGPUSkinning(false)` clobbers an independently-enabled `staticGeometry`

**Severity:** low
**Fix recommendation:** Nice to have — small logic fix to stop clobbering user intent
**Area:** runtime / ACEs
**Files:** `src/c3runtime/actions.js` `SetGPUSkinning` (~565-571)

## Problem

```js
SetGPUSkinning(enable) {
  this.staticGeometry = enable
  this.gpuSkinning = enable
  ...
}
```

Turning GPU skinning *off* also forces `staticGeometry = false`, even if the user separately enabled it via `SetStaticGeometry(true)`.

## Failure scenario

"Set static geometry: on" followed later by "Set GPU skinning: off" silently loses the static-geometry optimization.

## Suggested fix

Only couple them when enabling (`if (enable) this.staticGeometry = true`), or track the user's explicit static-geometry choice separately and restore it.
