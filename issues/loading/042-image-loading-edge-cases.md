# 042: Image loading edge cases in `loadGLTF` (bare `return`, crash on unreferenced image, `byteOffset` NaN, buffer-0 assumption)

**Severity:** medium
**Fix recommendation:** Recommended — several independent one-line guards
**Area:** loading
**Files:** `src/c3runtime/gltfData.js` images section (~588-619)

## Problem

1. The image-load `catch` does `alert(...); blob = null; return` — returning `undefined` instead of `false` mid-`loadGLTF`. Callers treat falsy as failure so it limps along, but the user gets two error dialogs and the return contract is broken.
2. After the try, `const texture = textures.find((t) => t.source == i)` — an image not referenced by any texture (legal glTF) leaves `texture` undefined, and `this.imageBitmap[image.name].wrapS = texture.wrapS` throws outside any local handler.
3. `binBuffer.slice(bufview.byteOffset, bufview.byteOffset + bufview.byteLength)` — `byteOffset` omitted (spec default 0) gives `undefined + n = NaN` → `slice(undefined, NaN)` → empty blob → image decode failure.
4. The non-binary bufferView path hardcodes `gltf.buffers[0]`, ignoring `bufview.buffer`.
5. Cosmetic: `blob = await new Blob([imageBuffer])` awaits a non-promise; the editor branch calls `GetProjectFileByExportPath` without `await` while a nearby path awaits the same API.

## Failure scenario

Models with unreferenced images crash the load; models with default-offset image bufferViews or multi-buffer layouts get broken textures.

## Suggested fix

`return false` in the catch; guard the `texture` lookup (default wrap to repeat); use `(bufview.byteOffset || 0)`; index `gltf.buffers[bufview.buffer]`; drop the stray `await`s.
