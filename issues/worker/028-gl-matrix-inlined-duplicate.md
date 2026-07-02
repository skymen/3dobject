# 028: gltfWorker.js embeds a full private copy of gl-matrix (~10,400 lines)

**Severity:** medium
**Fix recommendation:** Nice to have — build-system change; pays off in maintenance and shipped size
**Area:** maintainability / size
**Files:** `src/c3runtime/gltfWorker.js` (~lines 1145-11536), `src/gl-matrix.js` (main-thread copy)

## Problem

The worker inlines gl-matrix 3.3.0 verbatim while the main thread ships its own copy (`globalThis.glMatrix3D`). This doubles the shipped math-library bytes, makes the worker file unreviewable/undiffable, and the two copies can drift — the worker also calls `glMatrix.setMatrixArrayType(Array)` while the main-thread copy uses the default Float32Array, so identical math produces different array types on each side.

## Failure scenario

Maintenance: any gl-matrix fix/upgrade must be applied twice; subtle behavior differences between main-thread and worker math (array types, future version skew).

## Suggested fix

Generate `gltfWorker.js` at build time by concatenating a small worker-logic source file with the shared `gl-matrix.js` (the build script already post-processes files), or `importScripts`/fetch-eval the same gl-matrix asset at worker startup.
