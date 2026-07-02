# 055: `createDefaultTexcoordData` allocates 3 floats per vertex instead of 2 (plus leftover empty `if`)

**Severity:** low
**Fix recommendation:** Nice to have — one-line size fix
**Area:** rendering / memory
**Files:** `src/c3runtime/objectBuffer.js:21-22, 64-65, 394-400`

## Problem

```js
texcoordData = this.createDefaultTexcoordData(vertexData.length)
```

`vertexData.length` is `3 × numVerts`, but texcoords are 2 floats per vertex — the fallback UV buffer is 50% oversized. Safe direction (no out-of-bounds reads), just wasted GPU/CPU memory and a misleading contract. The adjacent `if (!this.texcoordData || this.texcoordData.length == 0) { }` (empty body) is dead scaffolding.

## Failure scenario

None functional; wasted memory on models lacking UVs.

## Suggested fix

`createDefaultTexcoordData((vertexData.length / 3) * 2)`; delete the empty `if`.
