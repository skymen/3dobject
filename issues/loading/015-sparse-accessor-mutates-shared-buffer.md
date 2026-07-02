# 015: Sparse accessors patch their values into the shared binary buffer in place

**Severity:** high
**Fix recommendation:** Strongly recommended — small copy-before-patch fix; spec-conformant models corrupt today
**Area:** loading / glTF conformance
**Files:** `src/c3runtime/gltfData.js` sparse path (~1080, 1121-1126)

## Problem

When a sparse accessor has a base `bufferView`, the code creates a *view* over the shared GLB buffer and then patches sparse values through it:

```js
a.data = new buftype(gltf.buffers[bufview.buffer], byteOffset, length)
...
a.data[targetIndex * compcount + k] = values[j * compcount + k]
```

This mutates the underlying ArrayBuffer that other accessors also view — commonly the base POSITION accessor or sibling morph targets, since the glTF spec's standard pattern is sparse accessors sharing a base bufferView. The spec explicitly forbids modifying the base buffer. The later accessor compaction (`a.data.slice()`) happens after parsing, too late — the corruption has already been written. The base read also ignores `byteStride`.

## Failure scenario

A model using sparse morph-target accessors renders with corrupted base geometry and/or cross-contaminated morph targets.

## Suggested fix

Copy before patching: `a.data = new buftype(...).slice()` (or build the array element-wise honoring `byteStride`), then apply the sparse substitutions to the private copy.
