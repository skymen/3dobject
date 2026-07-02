# 031: `GetPropertyValueByIndex`/`SetPropertyValueByIndex` defined twice in the instance class

**Severity:** medium
**Fix recommendation:** Fix immediately — delete the dead pair, add one guard; removes a maintenance landmine
**Resolution:** Fixed in v3.0.0 (trim stage 1): stub pair deleted.
**Area:** runtime / dead code
**Files:** `src/c3runtime/instance.js` (~500-506 stub pair, ~672-721 functional pair)

## Problem

The class body defines both methods twice. The first pair are stubs (`return 0` / empty body); the second pair are the real timeline implementations. In a JS class body the later definition silently wins, so the stubs are dead — but they're a landmine: edits made to the first pair are silently ignored. Also, the live `SetPropertyValueByIndex` calls `this.runtime.UpdateRender()` unconditionally — `runtime` is nulled in `Release()`, so a timeline callback landing after release throws.

## Failure scenario

Maintenance trap (editing the shadowed pair); possible post-release timeline crash.

## Suggested fix

Delete the stub pair; add a `if (!this.runtime) return` guard (or check `this._released`) in the live setter.
