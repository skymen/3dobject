# 012: `Set local center` is ignored in worker mode (and by both `updateModelRotate` variants)

**Severity:** high
**Fix recommendation:** Recommended — real feature gap in worker mode; small, well-localized matrix calls
**Area:** runtime / transforms
**Files:** `src/c3runtime/gltfModelW.js` render (~841) and `updateModelRotate` (~1689), `src/c3runtime/gltfModel.js:251-257` (correct) and its `updateModelRotate` (~1474), `src/c3runtime/gltfModelW.js` `getEditorData` (localCenter only in isEditor branch), `src/c3runtime/gltfWorker.js` `updateLight` (falls back to [0,0,0])

## Problem

The CPU render path honors the user-set pivot:

```js
mat4.fromRotationTranslationScaleOrigin(modelRotate, rotate, [x, y, z], [xScale, -yScale, zScale], this.inst.localCenter)
```

The worker render path does not:

```js
mat4.fromRotationTranslationScale(modelRotate, rotate, [x, y, z], [xScale, -yScale, zScale])
```

`getEditorData` only includes `localCenter` in the editor payload branch, so the worker's `updateLight` also falls back to `[0,0,0]` at runtime. Additionally, *both* `updateModelRotate` implementations (used for bbox updates and `getNodeWorldPosition`/`getBoneWorldPosition`) omit the origin, so even in CPU mode node/bone world positions disagree with the rendered transform whenever `localCenter ≠ 0`. `SetLocalCenter` is a public ACE (`actions.js:19-23`).

## Failure scenario

Set a local center and rotate: in worker-animation mode the model rotates around the wrong pivot; in any mode, bone/node position expressions and the bounding box are offset from what is rendered.

## Suggested fix

Use `fromRotationTranslationScaleOrigin(..., this.inst.localCenter)` in `gltfModelW.render` and in both `updateModelRotate` variants, and add `localCenter` to the lightEnable editorData payload.
