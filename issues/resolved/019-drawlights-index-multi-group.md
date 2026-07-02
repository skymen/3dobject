# 019: CPU light path indexes `drawLights` with a per-group counter that resets across vertex groups

**Severity:** medium
**Fix recommendation:** Recommended — small running-index fix; latent until multi-group meshes appear
**Resolution:** Resolved by deletion in v3.0.0 (trim stage 2): the lighting subsystem was removed.
**Area:** rendering / lighting (CPU path)
**Files:** `src/c3runtime/gltfModel.js:621` (push), `:624` (read)

## Problem

Light colors are pushed cumulatively across the `for (let ii ...)` vertex-group loop (`drawLights.push(colorSum)`), but read back with the per-group triangle index `const c = drawLights[i]`, where `i` restarts at 0 for each `ii`. With `drawVerts.length > 1` the second group re-reads the first group's colors. It works today only because primitives are pushed as single-entry groups. The worker-mode path does this correctly with a running `lightIndex`.

## Failure scenario

Wrong per-face lighting on any mesh that ever carries multiple vertex arrays per drawMesh.

## Suggested fix

Keep a running index across groups (mirror `gltfModelW.render`'s `lightIndex` bookkeeping).
