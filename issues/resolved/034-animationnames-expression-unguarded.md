# 034: `AnimationNames` expression throws before the model loads

**Severity:** medium
**Fix recommendation:** Fix immediately — one-line guard matching BoneNames/NodeNames
**Resolution:** Fixed in v3.0.0 (trim stage 5): AnimationNames guards a missing gltf.
**Area:** runtime / ACEs
**Files:** `src/c3runtime/expressions.js:5` (approx.)

## Problem

```js
AnimationNames() {
  return JSON.stringify(this.gltf.getAnimationNames())
}
```

No `this.gltf` guard, unlike `BoneNames`/`NodeNames` which safely return `"[]"` when the model isn't ready.

## Failure scenario

Evaluating `3DObject.AnimationNames` in an expression before load completes → TypeError inside expression evaluation (breaks the whole event).

## Suggested fix

`if (!this.gltf) return "[]"` — same pattern as `BoneNames`/`NodeNames`.
