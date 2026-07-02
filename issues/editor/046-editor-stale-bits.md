# 046: Editor instance stale/broken bits — `gtlfPath` typo guard, model-path changes never reload, no-op texture branch

**Severity:** medium
**Fix recommendation:** Recommended — small fixes; the path-reload gap is the user-visible win
**Area:** editor
**Files:** `src/instance.js:185, 285-295, 118-122, 174`

## Problem

1. **Typo'd guard:** `if (this.loaded && this.gtlfPath != "path")` — the field is `this.gltfPath`; `this.gtlfPath` is always undefined, so the condition is effectively `this.loaded` and the `else { return }` never applies. Currently harmless but the guard does nothing it appears to do.
2. **Path property changes don't reload:** `OnPropertyChanged("gtlf-path")` only clears `loadFailed`; the reload code is commented out, and since `sdkType.initOwner`/`dataLoaded` remain set, editing the model path in the editor never loads the new model until the project is reopened.
3. **No-op texture branch:** `if (this.sdkType.texture && !this.instanceTexture) { /* commented out */ } else { iRenderer.SetTexture(texture) }` — `sdkType.texture` is `{}` (always truthy), so the common branch deliberately sets no texture, and the later `textures.length === 0` check at line 174 is `undefined === 0` for the shared-model object map (same class of bug as issue 032); it only behaves by accident of `!this.instanceTexture`.

## Failure scenario

Editing "GLTF path" in the editor appears to do nothing (must reload the project); the dead guards/branches mislead maintenance.

## Suggested fix

Fix the field-name typo; implement the property-change reload (reset `sdkType.initOwner/dataLoaded`, release old data, trigger a reload); replace the object `.length` check with `Object.keys(...).length` and simplify the texture branch.
