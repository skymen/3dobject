# 044: Editor `LoadDynamicTextures` — in-progress sentinel set too late (re-entry race), duplicated statement, unguarded `close()`

**Severity:** medium
**Fix recommendation:** Recommended — small reorder; editor-only leak/race
**Area:** editor
**Files:** `src/type.js:23-37` (editor-side type)

## Problem

The guard is `if (dynamicTexturesLoaded === true || === null) return`, but the `null` in-progress sentinel is only set *after* the white texture has been created and awaited — so two overlapping editor `Draw` calls both pass the guard, creating duplicate white textures (one leaked) and double-closing the white ImageBitmap. Additionally: the white bitmap `close()` lacks the `typeof === "function"` guard used everywhere else, and the sentinel assignment is duplicated verbatim on two consecutive lines (`gltfData.dynamicTexturesLoaded = null;` twice). The runtime version sets the sentinel immediately — the editor copy predates that fix.

## Failure scenario

Editor with several instances triggering initial draws concurrently: leaked GPU textures per race, and a closed-bitmap `close()` call.

## Suggested fix

Set `dynamicTexturesLoaded = null` as the first statement after the guard (mirroring the runtime version), delete the duplicate line, and guard the `close()` call.
