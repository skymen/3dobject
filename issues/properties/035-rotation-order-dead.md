# 035: `rotation-order` property and `SetRotationOrdered`'s `order` parameter are dead at runtime (editor honors them, runtime ignores them)

**Severity:** medium
**Fix recommendation:** Recommended — implement per-order euler at runtime or remove the option; editor/runtime divergence is confusing
**Area:** runtime / transforms
**Files:** `src/c3runtime/instance.js:102` (`this.rotationOrder = properties[5]`, never read at runtime), `src/c3runtime/actions.js:38-45` (`SetRotationOrdered(x, y, z, order)` ignores `order`), `src/plugin.js:60-64` (combo property), editor `src/instance.js:65` (reads it for edit-time preview)

## Problem

Runtime rotation always uses `quat.fromEuler(rotate, xAngle, yAngle, zAngle)` — glMatrix's fixed euler order — in every render/updateModelRotate path. The `rotation-order` combo property is stored but never consumed at runtime, and the `order` parameter of the "Set rotation (ordered)" action is discarded. The editor preview *does* honor the order, so edit-time and runtime poses diverge for any non-default order.

## Failure scenario

Pick "zxy" (etc.) in the property or action: the editor shows one orientation, the exported game shows another.

## Suggested fix

Implement per-order euler→quat composition at runtime (compose three axis quats in the requested order) and use it wherever `quat.fromEuler` is called with the instance angles — or remove the property/parameter if the feature is abandoned.
