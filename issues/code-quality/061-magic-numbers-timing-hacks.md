# 061: Magic numbers and timing hacks (66ms sleep, ±10000 bbox, `+7` buffer contract, epsilon clamps, misleading comment)

**Severity:** low
**Fix recommendation:** Nice to have — naming/constants pass; the 66ms sleep deserves a real readiness condition
**Area:** code quality
**Files:** as listed

## Problem

- `await new Promise((resolve) => setTimeout(resolve, 66)) // Allow time for texture initialization` (`gltfModel.js:44`, `gltfModelW.js` init) — a race-condition workaround, not synchronization; if textures take longer, the race remains.
- GPU-skinning bounding box hardcodes ±10000 around the instance position (`gltfModelW.js` onWorkerMessage), defeating culling precision (mitigated by the static-bbox fallback in `_updateBoundingBox`, but the sentinel values still flow through `minBB/maxBB`).
- `new ArrayBuffer((buffLength + 7) * 4)` — the undocumented `7` is a contract (6 bbox floats + 1 tick float) shared with `setBBInVerts`/`setBBFromVerts` across three files; one named constant would prevent drift.
- `time = timeValues.max[0] - 0.01` end-clamp epsilon in three copies of `updateAnimation` — frame-rate/keyframe-density dependent.
- `maxBonesForBuffer = globalThis.BoneBuffer?.MAX_BONES || 256` (`gltfModel.js` two sites) duplicates the constant, and `MAX_BONES` isn't actually a static on the class (only module-level in boneBuffer.js), so the `?? 256` fallback is what always runs.
- `gltfWorker.js` `transformNode`: the comment `// XXX unused?` sits above `if (node.skin != undefined) mat4.invert(node.invMatrix, node.matrix)` — which is load-bearing (used every tick by `getPolygonsPrep` for `joint.boneMatrix`). Deleting per the comment would break skinning.

## Failure scenario

Mostly maintenance hazards; the 66ms sleep is a real (if rare) race.

## Suggested fix

Name the constants (`BB_EXTRA_FLOATS`, `ANIM_END_EPSILON`), replace the 66ms sleep with an actual readiness condition, export `MAX_BONES` properly, and delete the misleading comment.
