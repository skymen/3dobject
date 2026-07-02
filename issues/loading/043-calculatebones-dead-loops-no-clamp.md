# 043: `_calculateBonesPerModelAsset` — two dead loops, placeholder essays, and no clamp against `SHADER_MAX_BONES`

**Severity:** medium
**Fix recommendation:** Recommended — mostly deletion plus a clamp with a clear error
**Area:** loading / skinning
**Files:** `src/c3runtime/gltfData.js` (~709-802), `getOrCreateModelBoneUbo` (~1609)

## Problem

1. The first loop iterates every joint of every skin with a body that is entirely comments — pure O(total joints) waste per load.
2. The second block computes `jointCountForThisSkin` and compares it inside an empty placeholder `if` — also dead; `maxJointIndex` is declared and never meaningfully used.
3. Only the JOINTS_0 scan does real work — but the result `bonesPerModelAsset = modelMaxJointIndex + 1` is never validated against `SHADER_MAX_BONES` (256), even though the shared UBO is allocated at a fixed 256 matrices. A model with more than 256 joints will silently write past the UBO's logical range at upload time (bufferSubData size mismatch / truncated skeleton).

## Failure scenario

Load-time waste on every model; a >256-joint model breaks skinning silently instead of failing with a clear message.

## Suggested fix

Delete the two dead blocks; keep the JOINTS_0 scan; add `if (this.bonesPerModelAsset > SHADER_MAX_BONES) { console.error(...); this.bonesPerModelAsset = SHADER_MAX_BONES }`.
