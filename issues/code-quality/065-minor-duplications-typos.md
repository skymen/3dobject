# 065: Minor duplications and typos (constructor/release duplicates, dead parameter-null, comment typos)

**Severity:** low
**Fix recommendation:** Optional — cosmetic cleanup
**Area:** code quality
**Files:** as listed

## Problem

- `src/c3runtime/instance.js`: `this.quaternion` initialized twice in the constructor (null at ~47, array at ~74 — later wins); `Release()` nulls `maxBB`/`minBB` twice (~571-572 and ~583-584); comment typo "Source destoryed" (~331).
- `src/c3runtime/actions.js` `SetZElevation0`: `this.updateBbox = true` twice in a row (~15-16).
- `src/c3runtime/type.js` `LoadDynamicTextures` (non-cache path): `if (instanceModel) { gltfData = null }` assigns null to the local *parameter* — zero effect on the caller, immediately before function exit. Dead statement.

## Failure scenario

None — dead code and cosmetics.

## Suggested fix

Delete the duplicates and the dead statement; fix the typo.
