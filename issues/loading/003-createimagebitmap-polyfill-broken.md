# 003: `createImageBitmap` polyfill is broken on every axis (static call, `document` in worker, no revoke, no error handling)

**Severity:** critical
**Fix recommendation:** Strongly recommended — a handful of small fixes; the fallback is broken exactly where it is needed
**Status (v3.0.0):** Partially resolved in v3.0.0: the broken static call site went away with LoadMaterial's deletion; the polyfill itself (document/no-revoke/no-error) still backs gltfData's internal fallback.
**Area:** runtime / loading
**Files:** `src/c3runtime/gltfData.js:694-702` (polyfill), `src/c3runtime/actions.js:146` (static call), `src/c3runtime/gltfData.js:613,663` (internal calls)

## Problem

The Safari/legacy fallback for `createImageBitmap` has four independent defects:

1. **Broken static call:** the polyfill is an *instance* method (`async createImageBitmap(blob)` on the `GltfData` class), but `actions.js` `LoadMaterial` calls it as a static: `await globalThis.GltfData.createImageBitmap(blob)`. That expression is `undefined` → `TypeError: ... is not a function` exactly on the environments that need the fallback.
2. **`document` in worker mode:** the polyfill does `document.createElement("img")`. gltfData.js is an external-runtime-script that runs inside the C3 runtime, which may be a dedicated Web Worker (addon.json does not opt out of worker mode). In a worker `document` is undefined → ReferenceError.
3. **Object URL leak:** `img.src = URL.createObjectURL(blob)` is never revoked.
4. **No error handling:** the promise declares no `reject` path and installs no `error` listener — a corrupt image blob hangs the model load forever. The resolved value is also an `HTMLImageElement`, not an `ImageBitmap`.

## Failure scenario

Any browser without native `createImageBitmap` (the only case where this code runs): `LoadMaterial` throws; model loads in worker mode crash; corrupt images hang loading with no error.

## Suggested fix

Make the polyfill a `static` method (and update internal `this.createImageBitmap(blob)` call sites), add `URL.revokeObjectURL` in the load handler, add an `error` listener that rejects, and guard `typeof document === "undefined"` with a clear rejection (all worker-capable browsers ship native `createImageBitmap` anyway).
