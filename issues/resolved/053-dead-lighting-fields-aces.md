# 053: Dead lighting/blend fields and their ACEs (`SetLightDir`, `SetBlendMode`, `EnableSpotLight`, `lightColor`, `EnableLight`'s phantom color param)

**Severity:** low
**Fix recommendation:** Nice to have — deletion plus a deprecation decision for the exposed no-ops
**Resolution:** Resolved by deletion in v3.0.0 (trim stages 1/2).
**Area:** dead code / ACEs
**Files:** `src/c3runtime/actions.js` (~225-231 SetBlendMode, ~461-483 lighting actions), `src/c3runtime/instance.js:57, 60-64, 73`

## Problem

Grep-verified: `inst.lightDir`, `inst.blendMode`, `inst.spotEnable/spotDir/spotCutoff/spotEdge`, and `inst.lightColor` are never read by any render or worker code — per-light spot data comes from the `lights` map (`AddLights`) instead. Specifically:

- `SetLightDir` and `SetBlendMode` are exposed (deprecated) no-ops.
- `EnableSpotLight` isn't declared in aces.json at all — pure dead code.
- `Acts.EnableLight(enable, color)` declares a `color` parameter that aces.json (`enable-light`, one param) never supplies; `lightColor` is never written anywhere.

## Failure scenario

Users calling the exposed no-ops see nothing happen; the fields mislead maintenance.

## Suggested fix

Delete `EnableSpotLight` and the dead fields; keep the deprecated no-op entries only if project compatibility requires them (with a comment saying they are intentionally inert); drop the phantom `color` param.
