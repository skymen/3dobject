# 022: Vertex-rounding snaps Y and Z using the X scale — non-uniform scales distort the model

**Severity:** medium
**Fix recommendation:** Fix immediately — mechanical six-line fix in two files
**Area:** rendering
**Files:** `src/c3runtime/gltfModel.js:635-643`, `src/c3runtime/gltfModelW.js:1081-1089` (same bug in both)

## Problem

```js
x0 = Math.round(x0 * xScale) / xScale
y0 = Math.round(y0 * xScale) / yScale   // multiplies by xScale, divides by yScale
z0 = Math.round(z0 * xScale) / zScale   // multiplies by xScale, divides by zScale
```

(and identically for the other two triangle vertices). Multiplying by `xScale` but dividing by `yScale`/`zScale` both snaps to the wrong grid and *rescales* the coordinate by `xScale/yScale` whenever the per-axis scales differ.

## Failure scenario

Enable vertex rounding (`SetVertexRounding` ≠ 0) on a non-uniformly scaled model: it visibly squashes/stretches along Y/Z.

## Suggested fix

`y = Math.round(y * yScale) / yScale`, `z = Math.round(z * zScale) / zScale` in all six vertex statements in both files.
