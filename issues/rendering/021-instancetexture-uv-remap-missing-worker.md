# 021: Instance-texture / sprite-texture UV remapping missing from the worker render path

**Severity:** medium
**Fix recommendation:** Recommended — feature parity port, medium effort; or explicitly deny the combination
**Area:** rendering (worker path)
**Files:** `src/c3runtime/gltfModel.js:303-318, 345-359, 494-503` (implemented) vs `src/c3runtime/gltfModelW.js:913-928` (absent)

## Problem

`gltfModel.render` computes `rWidth/rHeight/rOffsetX/rOffsetY` from `GetImageInfo().GetTexRect()` (image-texture mode) and from `spriteTextures` (Load material from sprite) and remaps every tempQuad UV into the sub-rectangle:

```js
tempQuad.setTlx(tempQuad.getTlx() * rWidth + rOffsetX) ...
```

`gltfModelW.render` has none of this — `instanceTexture` is only used to skip `SetTexture`, and `spriteTextures` isn't consulted at all.

## Failure scenario

Worker-animation mode combined with "Image texture" or "Load material from sprite": UVs address the whole spritesheet/atlas instead of the sub-rect — visibly wrong texturing.

## Suggested fix

Port the rect-remap block into `gltfModelW.render` (both the dynamic-quad path and, for static geometry, via the UV-transform uniforms), or explicitly document/deny the combination in the editor.
