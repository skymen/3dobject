# 076: Language file — dead entries from the pre-glTF era and mislabeled properties

**Severity:** low
**Fix recommendation:** Optional — lang cleanup; annotate rather than rename
**Area:** editor / lang
**Files:** `src/lang/en-US.json`

## Problem

- `"obj-path"` / `"mtl-path"` entries have no corresponding property in plugin.js (grep: no `obj-path` outside the lang file) — dead strings from the OBJ/MTL era.
- `"z-elevation"` is labeled "Obsolete, use zElevation" yet still occupies runtime property slot 1 — which is exactly what `cpuXform` mistakenly reads (issue 008).
- `"cpu-xform"` is labeled "Worker BFC" — the label matches actual behavior (back-face culling), while the id says CPU transform (issue 008).
- `"gtlf-path"` typo id (issue 072).

## Failure scenario

Maintenance confusion; the mislabels feed directly into the property-index landmines.

## Suggested fix

Delete the dead entries; annotate the frozen-but-misnamed ids in the lang file and plugin.js with comments pointing at issue 008/072.
