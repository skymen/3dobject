# 040: Texture upload failures are swallowed and permanently wedge `dynamicTexturesLoaded` at the in-progress sentinel

**Severity:** medium
**Fix recommendation:** Strongly recommended — small try/catch + sentinel reset; turns a permanent wedge into a retry
**Resolution:** Fixed in v3.0.0 (trim stage 5): uploads wrapped in try/catch, sentinel reset on failure, fire-and-forget call sites .catch.
**Area:** runtime / loading
**Files:** `src/c3runtime/type.js` (`LoadDynamicTextures` sentinel logic), `src/c3runtime/instance.js:169, 337` (fire-and-forget call sites)

## Problem

`doInit` and `Draw` call `this.sdkType.LoadDynamicTextures(...)` without `await` or `.catch`. Inside, the guard flag is set to the in-progress sentinel (`gltfData.dynamicTexturesLoaded = null`) before the awaits; if `CreateDynamicTexture`/`UpdateTexture` throws (context loss, driver error), the sentinel is never rolled back — every future call returns immediately (`=== null` early-out), so textures never load and never retry. The only evidence is an unhandled promise rejection.

## Failure scenario

A transient GPU error during texture upload leaves all instances of the type permanently untextured (white) for the session, silently.

## Suggested fix

Wrap the upload body in try/catch; on failure `console.error` and reset `dynamicTexturesLoaded = false` so the next Draw retries. Add `.catch(...)` to the fire-and-forget call sites.
