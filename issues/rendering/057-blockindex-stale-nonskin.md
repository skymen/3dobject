# 057: `uploadUniformsNonSkin`/`disable` never refresh the UBO block index per shader program

**Severity:** low
**Fix recommendation:** Nice to have — do as part of the 010 caching pass
**Area:** rendering / skinning
**Files:** `src/c3runtime/boneBuffer.js:262-284` (uploadUniformsNonSkin), `:309-317` (disable)

## Problem

Unlike `uploadUniforms` (which calls `_updateShader` and re-resolves per program), `uploadUniformsNonSkin` only does `if (this.blockIndex === -1) { this.blockIndex = gl.getUniformBlockIndex(...) }` — once a valid index is cached from program A it is reused for program B, and `uniformBlockBinding` is never called on B. It only works today because `BONE_UBO_BINDING_POINT = 0` happens to match the GL default uniform block binding.

## Failure scenario

If the binding point ever changes from 0 (see issue 066) or a shader's block index differs, non-skinned draws bind the wrong/no UBO.

## Suggested fix

Call `_updateShader(shaderProgram)` at the top of `uploadUniformsNonSkin` (after fixing issue 010 so `_updateShader` is a real per-program cache).
