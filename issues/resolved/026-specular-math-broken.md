# 026: Specular reflection math is wrong in the CPU light path; the worker's copy is hard-disabled with `&& false`

**Severity:** medium
**Fix recommendation:** Nice to have — specular is rarely used; fix when next touching the lighting code
**Resolution:** Resolved by deletion in v3.0.0 (trim stage 2): the lighting subsystem was removed.
**Area:** rendering / lighting
**Files:** `src/c3runtime/gltfModel.js:594-607`, `src/c3runtime/gltfWorker.js` `calculateLight` (~981-995)

## Problem

```js
const dotNI = vec3.create()
vec3.dot(dotNI, normal, lightDir)     // vec3.dot(a,b) RETURNS a scalar; out-param misuse
vec3.scale(dotNI, dotNI, 2.0)
vec3.mul(dotNI, dotNI, normal)
vec3.sub(reflectDir, dotNI, lightDir)
vec3.sub(reflectDir, lightDir, normal) // immediately overwrites the previous result
```

`vec3.dot` takes two vectors and returns a number — passing `dotNI` as a fake out-param computes `dot(dotNI, normal)` (= 0 for a fresh vec) and discards `lightDir`. The next line then overwrites `reflectDir` anyway, so the "reflection" degenerates to `lightDir − normal`. The worker contains the identical block but gated `if (enableSpecular && false)`, so CPU and worker modes disagree whenever specular is enabled on a light.

## Failure scenario

Lights with `enableSpecular`: physically wrong highlights in CPU mode, no highlights at all in worker mode.

## Suggested fix

Compute the reflection properly with the scalar dot: `reflect = 2·dot(N,L)·N − L` (or use a half-vector Blinn-Phong), apply the same code in both paths, and remove the `&& false`.
