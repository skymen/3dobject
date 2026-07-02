# 033: `Set mesh material` throws when called before the model loads (missing guard)

**Severity:** medium
**Fix recommendation:** Fix immediately — one-line guard matching the sibling actions
**Area:** runtime / ACEs
**Files:** `src/c3runtime/actions.js:185` (approx., first line of `SetMeshMaterial`)

## Problem

```js
SetMeshMaterial(nodeName, materialName) {
  const meshName = this.gltf.nodeMeshMap[nodeName]
```

`this.gltf` is only assigned in `doInit()`; every neighboring node action (`EnableNode`, morph actions, `OffsetNodeUV`) starts with `if (!this.gltf) return / if (!this.gltf.gltfData) return`, but this one doesn't.

## Failure scenario

Calling "Set mesh material" on start-of-layout (before "On model loaded") → `TypeError: Cannot read properties of undefined (reading 'nodeMeshMap')`.

## Suggested fix

Add the same guard as the sibling actions: `if (!this.gltf || !this.gltf.gltfData) return`.
