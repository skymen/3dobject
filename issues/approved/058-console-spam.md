# 058: Console spam — per-frame warnings in the runtime and ~25 unconditional 🔥 logs in DRACOLoader

**Severity:** low
**Fix recommendation:** Recommended — quick log gating; directly user-visible polish (every Draco user sees the spam)
**Area:** logging
**Files:** as listed

## Problem

Per-frame/per-item warnings that can flood the console in production:

- `gltfModel.js` (~706): `console.warn("[GltfModel Cleanup] 'Bones' block not found...")` runs **every frame** for every instance whose current shader lacks the Bones block (the surrounding code deliberately "assumes always true").
- `gltfModelW.js` (~783): `console.warn("gltfModelW: No drawMeshes")` per frame if render is reached before init completes.
- `boneBuffer.js:138`: per-joint warn in `setBone` can fire hundreds of times per frame for a mismatched skeleton; `:228` "Binding dummy" warn per draw; `:14, 28` logs on dummy-UBO creation.
- `objectBuffer.js:141-146, 162-167`: warns/errors on every VAO creation when optional attributes/uniforms are absent.
- `DRACOLoader.js` (~205-505): ~25 emoji-prefixed `console.log`s (`'🔥 Worker: Initializing...'`, `'🔥 Worker: Creating blob URL for WASM binary'`, …) run unconditionally per decoder init and per decode — visible in every end user's console for any Draco model. Error branding still says `THREE.DRACOLoader`.
- `plugin.js:8` (runtime): leftover `console.log("opts", opts)` runs in every export.

## Failure scenario

Console noise in production; per-frame warns have measurable cost when they fire.

## Suggested fix

Gate everything on the existing debug flags (gltfData already carries `this._debug`); for legitimate warnings, log once per condition via a flag; remove the leftover `opts` log and the emoji logs.
