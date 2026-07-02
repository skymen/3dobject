# 030: `Set camera vector/pos` action is a silent no-op (fields never read; `_cullPoint` has no callers)

**Severity:** medium
**Fix recommendation:** Nice to have — decide the feature's fate; either wire up culling or deprecate cleanly
**Area:** runtime / ACEs / dead code
**Files:** `src/c3runtime/actions.js:394-397` (approx. `SetCameraVectorPos`), `src/c3runtime/instance.js:81-82` (`cameraVector`/`cameraPosition`), `src/c3runtime/gltfModelW.js` `_cullPoint` (~704)

## Problem

The action stores `this.cameraVector` and `this.cameraPosition`, but nothing in `src/` ever reads either field (grep-verified). The only plausible consumer, `_cullPoint(cameraPos, cameraDir, point)`, is itself never called — and contains its own latent bugs (compares `vec3.angle` radians against `90`, hardcodes `distance > 1000`). Yet `set-camera-vector-pos` is exposed, non-deprecated, in aces.json.

## Failure scenario

A user calls the action expecting camera-based culling; nothing happens, no warning.

## Suggested fix

Either wire `_cullPoint` up (fixing radians/threshold) or deprecate/remove the action along with the dead `cameraVector`/`cameraPosition` fields and `_cullPoint`.
