# 011: VAO and cached attribute/uniform locations assume one shader program forever

**Severity:** high
**Fix recommendation:** Recommended — latent today (dedicated shader), but cheap insurance to key VAO/locations per program alongside 010
**Area:** rendering
**Files:** `src/c3runtime/objectBuffer.js:276-278` (lazy VAO), `124-206` (createVao), `367-391` (`_setColorUniforms` + swallowing try/catch)

## Problem

`draw()` builds the VAO once (`if (this.vao === null) this.vao = this.createVao(renderer)`) using attribute locations (`locAPos/locATex/locAColor/...`) and color-uniform locations fetched from whatever `batchState.currentShader._shaderProgram` was current at first draw. Those locations are then reused on every subsequent draw. If the object is later drawn under a *different* program (effects, shader switches):

- attribute indices can differ → wrong/garbage vertex streams bound in the VAO;
- `gl.uniform*` with a location from another program raises `INVALID_OPERATION` — which is swallowed by the `try/catch` in `_setColorUniforms`, so it fails silently (see also issue 010 for the disabled caching that partially papers over this).

Today the addon mostly renders through its single cached 3D shader, which is why this works — but nothing enforces that.

## Failure scenario

Corrupted geometry or silently missing tint whenever a different shader program is current at draw time (e.g. C3 effects on the object or engine changes to batching).

## Suggested fix

Key the VAO and all cached locations by shader program (small `Map<program, {vao, locations}>`), mirroring what `_updateShader` was meant to do; then remove the `try/catch` in `_setColorUniforms` so real GL misuse is visible again.
