# 014: `loadGLTF` ignores the boolean results of its parsing helpers — failed parses report success

**Severity:** high
**Fix recommendation:** Fix immediately — three one-line changes; converts silent corruption into clean failures
**Resolution:** Fixed in v3.0.0 (trim stage 5): parse-helper failures now propagate as load failures.
**Area:** loading
**Files:** `src/c3runtime/gltfData.js` — call sites of `_processMeshes` / `_processAccessors` / `_processStandardPrimitives` (~452-464, ~624)

## Problem

All three helpers return `false` on failure (Draco decode failure, unhandled accessor componentType, missing bufferView), but the call sites discard the result:

```js
await this._processMeshes(gltf)
await this._processAccessors(gltf)
...
await this._processStandardPrimitives(gltf)
```

Load then "succeeds": `dataLoaded = true`, instances initialize, and rendering later crashes or draws garbage from accessors whose `.data` was never populated.

## Failure scenario

A model with a corrupt Draco primitive or an unknown componentType: no load error surfaced; instead delayed TypeErrors or silent visual corruption at render time, far from the root cause.

## Suggested fix

```js
if (!(await this._processMeshes(gltf))) return false
if (!(await this._processAccessors(gltf))) return false
...
if (!(await this._processStandardPrimitives(gltf))) return false
```
