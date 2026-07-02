# 020: CPU model with `cpuXform`: ModelView matrix set but never restored — double transform + stale matrix for subsequent objects

**Severity:** medium
**Fix recommendation:** Strongly recommended — one-line guard change; real corruption for cpuXform users
**Resolution:** Resolved by deletion in v3.0.0 (trim stage 4): the cpuXform path was removed.
**Area:** rendering (CPU path)
**Files:** `src/c3runtime/gltfModel.js:229` (setup guard), `:652` (restore guard)

## Problem

The matrix setup runs under `if (!this.inst.isEditor)` — it computes `modelRotate` and calls `renderer.SetModelViewMatrix(modelRotate)` even when `cpuXform` is true, where the vertices were **already** transformed on the CPU by `modelScaleRotate` in `getPolygons` (applied when `isEditor || cpuXform`). The restore runs under the different guard `if (!(this.inst.isEditor || this.inst.cpuXform) && ...)`. So with `cpuXform && !isEditor`:

- the transform is applied twice (CPU verts × MV matrix), and
- the modelview matrix is never restored, leaving every later object in the frame rendered with this object's matrix.

`gltfModelW.js` gets it right — its setup guard `!(isEditor || cpuXform)` matches its restore guard.

## Failure scenario

Any non-worker instance with `cpuXform` enabled: the model renders doubly-transformed and other objects drawn after it are misplaced for the rest of the frame.

## Suggested fix

Change the setup guard at gltfModel.js:229 to `!(this.inst.isEditor || this.inst.cpuXform)` to match the restore.
