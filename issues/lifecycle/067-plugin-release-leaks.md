# 067: Runtime plugin `Release()` leaks the shader program, dummy UBO, and event listener; stale globals break restarts

**Severity:** low
**Fix recommendation:** Nice to have — teardown hygiene; matters mainly for in-page runtime restarts
**Area:** lifecycle
**Files:** `src/c3runtime/plugin.js:8, 22-32, 218-230` (approx.)

## Problem

1. `Release()` nulls `globalThis.cached3DObjectShader` but never destroys the GPU shader program or the `dummyBonesUboBuffer`, and the `"afterprojectstart"` listener added on `runtime._iRuntime` is never removed.
2. `vertexShaderGPUSkinningEnabledXYZ` stays true after release, so a runtime restart within the same JS context skips re-registering the listener, leaving `dummyBonesUboBuffer` pointing at a dead GL context — GPU skinning's dummy UBO is never re-bound until a full page reload.
3. Comment drift: the code comments say "listen for the `afterfirstlayoutstart` event" but listen to `afterprojectstart`, and "A single mat4 is enough" while allocating all 256 matrices (64 KB).
4. Leftover `console.log("opts", opts)` (also listed in issue 058).

## Failure scenario

Runtime restart in the same page (some preview flows): GPU skinning broken until reload; minor GPU leaks at teardown.

## Suggested fix

In `Release()`: delete the shader program and dummy UBO, remove the listener, and reset all the module globals (`cached3DObjectShaderPromise`, `vertexShaderGPUSkinningEnabledXYZ`, `dummyBonesUboBuffer`). Fix the comments.
