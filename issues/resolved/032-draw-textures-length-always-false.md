# 032: `Draw`'s no-material fallback check `textures.length === 0` is always false (object, not array)

**Severity:** medium
**Fix recommendation:** Fix immediately — one-line Object.keys fix
**Resolution:** Fixed in v3.0.0 (trim stage 4): Object.keys() check; simplified by instanceTexture removal.
**Area:** rendering
**Files:** `src/c3runtime/instance.js:340` (approx.)

## Problem

```js
if (textures.length === 0 || this.instanceTexture) {
  renderer.SetTexture(texture)
}
```

`textures` is a plain object (`this.texture = {}`), so `textures.length` is `undefined` and the comparison is never true. The intended "model has no materials → bind the C3 image texture" fallback only fires when `instanceTexture` is set.

## Failure scenario

A texture-less model with "Image texture" unchecked never gets the image texture bound by this path; rendering relies on whatever `gltf.render` happens to bind (usually the white texture), which may differ from the documented behavior.

## Suggested fix

`if (Object.keys(textures).length === 0 || this.instanceTexture)`.
