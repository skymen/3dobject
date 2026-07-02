# 074: Stale editor-Draco messaging claims decoding "will be bypassed" while the editor actually decodes

**Severity:** low
**Fix recommendation:** Optional — message cleanup, do with 054
**Area:** editor / logging
**Files:** `src/c3runtime/gltfData.js` (~422-424 messaging, ~452-459 actual behavior)

## Problem

Debug output states:

```
⚠️ EDITOR MODE: Draco compression detected but will be bypassed in editor environment to prevent crashes
⚠️ Draco models will display correctly in preview/runtime
```

but the code immediately initializes the editor JS decoder and fully decodes (`_initEditorDracoDecoder` → `_processMeshes`). Together with the orphaned `_processStandardPrimitivesOnly` "EDITOR BYPASS" machinery (issue 054), this is leftover scaffolding from an abandoned approach that will actively mislead anyone debugging editor loads.

## Failure scenario

Developer confusion during editor debugging; no runtime fault.

## Suggested fix

Update the messages to reflect reality and delete the bypass remnants alongside issue 054.
