# 056: First draw of each ObjectBuffer skips the color uniforms (set-before-lookup ordering)

**Severity:** low
**Fix recommendation:** Nice to have — reorder two statements
**Area:** rendering
**Files:** `src/c3runtime/objectBuffer.js:275-278`

## Problem

`draw()` calls `this._setColorUniforms(gl, instanceColor)` *before* the lazy `if (this.vao === null) this.vao = this.createVao(renderer)` — but `locUseUniformColor`, `locObjectColor`, `locHasVertexColors`, and `hasVertexColors` are only assigned inside `createVao`. On the very first draw all three `gl.uniform*` calls are silently skipped (locations null/undefined), giving one frame of wrong tint / vertex-color state per buffer.

## Failure scenario

Single-frame color glitch per static-geometry mesh at first appearance (usually invisible, but real).

## Suggested fix

Create the VAO (or at least resolve the uniform locations) before calling `_setColorUniforms`.
