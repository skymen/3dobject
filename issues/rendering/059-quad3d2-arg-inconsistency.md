# 059: `Quad3D2` trailing-argument inconsistency between CPU and worker render paths

**Severity:** low
**Fix recommendation:** Nice to have — verify the renderer flag's meaning, then align both call sites
**Area:** rendering
**Files:** `src/c3runtime/gltfModel.js:645` and its `drawWireFrame` (~1381-1428) — pass a trailing `true`; `src/c3runtime/gltfModelW.js` (~1117) and its `drawWireFrame` — omit it

## Problem

The CPU path calls `renderer.Quad3D2(x0, ..., tempQuad, true)` with a 14th argument while the worker path calls the same renderer API without it; likewise the two `drawWireFrame` implementations differ. Whatever the flag controls in the (private) renderer API, the two animation modes will behave differently for identical models.

## Failure scenario

Subtle rendering differences (batching/winding behavior) when switching an object between worker and non-worker animation.

## Suggested fix

Determine the parameter's meaning in the C3 renderer and make both call sites identical.
