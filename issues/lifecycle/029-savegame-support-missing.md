# 029: Savegame support entirely missing (`SaveToJson`/`LoadFromJson` are empty)

**Severity:** medium
**Fix recommendation:** Recommended — real feature gap; scope it to core state (animation/transform/model path) first
**Area:** runtime / persistence
**Files:** `src/c3runtime/instance.js:478-486` (approx.)

## Problem

`SaveToJson()` returns `{}` and `LoadFromJson(o)` does nothing. None of the runtime state survives a C3 save/load round trip: current animation name/index/time/play/loop/speed/rate, `scale`/`xScale`/`yScale`/`zScale`, `xAngle`/`yAngle`/`zAngle`, quaternion + `enableQuaternion`, a model loaded at runtime via `LoadModel`, loaded materials, node enable/disable state, morph weights, lights and ambient color, `bboxScale`, `gpuSkinning`/`staticGeometry` toggles.

## Failure scenario

Any project using the system Save/Load actions: 3DObject instances resume with constructor defaults — wrong pose, wrong animation, missing runtime-loaded models — while all other plugins restore correctly.

## Suggested fix

Serialize at least: angles/scales, quaternion + flag, animation state (name/time/speed/loop/play), gltfPath if it was changed by `LoadModel`, node disabled set, morph weights, and lights; in `LoadFromJson`, re-drive the same code paths the ACEs use (`LoadModel`, `PlayAnimation`, `EnableNode`, ...) after the model finishes loading.
