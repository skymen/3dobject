# 052: Dead instance fields reallocated every animation tick (`drawVerts`/`drawUVs`/`drawIndices` and friends)

**Severity:** low
**Fix recommendation:** Nice to have — pure deletion; removes per-tick churn as a bonus
**Area:** dead code / performance
**Files:** `src/c3runtime/instance.js:15-17, 33-34, 42, 173-175, 242-244, 258-260` (approx.)

## Problem

Grep confirms no code anywhere reads the *instance-level* `drawVerts`, `drawUVs`, `drawIndices`, `drawVertsCache`, `drawUVsCache`, or `drawMeshes` — both model classes keep their own `drawMeshes`. Yet `Tick()` reassigns three of them to fresh empty arrays on **every animation update**, and `doInit` does it again:

```js
this.drawVerts = []
this.drawUVs = []
this.drawIndices = []
```

## Failure scenario

None functional — pointless per-tick allocations and misleading state on the instance.

## Suggested fix

Delete the fields, their reassignments in `Tick`/`doInit`, and their entries in `Release()`.
