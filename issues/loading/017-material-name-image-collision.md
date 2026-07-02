# 017: Material `name` overwritten with the image name — colliding texture keys and shared-object renaming

**Severity:** high
**Fix recommendation:** Recommended — needs a migration story (existing projects reference the image-derived names)
**Area:** loading / materials
**Files:** `src/c3runtime/gltfData.js` `_processStandardPrimitives` (~1249-1271); consumers `src/c3runtime/gltfModel.js:344` (`textures[material.name]`), `:294` (`materialsModify.get(material?.name)`), same in gltfModelW.js

## Problem

```js
p.material = materials[p.material]           // shared material object
p.material.name = images[imageIndex].name    // renamed to the image's name
```

The renderer keys texture lookups and material modifications by `material.name`. Consequences:

1. Two distinct materials using the same image get identical names — `SetMeshMaterial`/`LoadMaterial`/`OffsetMaterialUV`/`RotateMaterialUV` by name affect both.
2. The author's material name from the glTF file is destroyed, breaking name-based ACEs that reference the original names.
3. A material without a baseColorTexture used by several primitives is renamed repeatedly to `material_${i}_${j}` — last primitive wins, so fallback names are unstable across models/edits.

## Failure scenario

A model where two materials share a texture atlas: UV-offsetting one material shifts both; swapping one swaps both.

## Suggested fix

Keep `material.name` untouched and store the image association separately (e.g. `p.material._imageName`) for the texture-map key, or only assign a name when the material has none. Migration caution: existing projects reference the current (image-derived) names in ACEs.
