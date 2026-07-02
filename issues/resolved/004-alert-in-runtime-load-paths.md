# 004: `alert()` used in runtime load/error paths — throws in worker mode, blocks the game loop otherwise

**Severity:** critical
**Fix recommendation:** Fix immediately — mechanical console.error replacement; prevents masked errors in worker-mode exports
**Resolution:** Fixed in v3.0.0 (trim stage 5): all runtime alert()s replaced with console.error + return false.
**Area:** runtime / loading
**Files:** `src/c3runtime/gltfData.js:273, 282, 297, 307, 604, 1146` (approx.)

## Problem

Six `alert(...)` calls sit in code executed at game runtime, e.g.:

```js
alert("gltfPath not found: " + gltfPath)
alert("Error loading GLTF:" + err)
alert("error: gltf, unhandled bufferView for non-sparse accessor. Accessor index: " + i)
```

In C3 worker-mode runtime `alert` does not exist → a `ReferenceError` is thrown *from inside the error-reporting path itself*, masking the real failure. Since `actions.js` `LoadModel` calls `gltfData.load(...)` fire-and-forget (no await/catch), this becomes an unhandled promise rejection instead of the intended graceful `return false`. In DOM mode the alert is a modal that freezes the game loop mid-frame; the editor retry behavior (see issue 044) can fire it once per instance.

## Failure scenario

A bad model path (or corrupt file) in a worker-mode export: secondary ReferenceError, no useful diagnostics, possible unhandled rejection loop. In DOM exports: game-freezing modal dialogs shipped to players.

## Suggested fix

Replace every runtime `alert` with an unconditional `console.error` (not gated on `debug`) and keep the `return false` contract. If a user-facing notification is desired in the editor, guard with `typeof alert === "function"` and edit-time detection.
