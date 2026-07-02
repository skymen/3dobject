# 054: `_processStandardPrimitivesOnly` is ~200 lines of dead code that would crash if ever called

**Severity:** low
**Fix recommendation:** Nice to have — delete ~200 lines; zero risk
**Area:** dead code / loading
**Files:** `src/c3runtime/gltfData.js` (~1280-1476)

## Problem

Grep confirms the only occurrence of `_processStandardPrimitivesOnly` in the repo is its definition — it is never called (leftover from the abandoned "editor Draco bypass" approach, see also issue 074). It references bare identifiers copied from `_processAccessors` without their local declarations — `bufferViews[...]` and `buffers[...]` — which would throw `ReferenceError` immediately if invoked. It is also the *third* copy of the sparse/strided accessor logic, guaranteed to rot out of sync with the live version (it already lacks the strided-type else branch).

## Failure scenario

Dead code today; instant crash if anyone "re-enables" it.

## Suggested fix

Delete the method.
