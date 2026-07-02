# 075: DRACOLoader `_taskCache` never hits; "buffer transferred" logic is vestigial

**Severity:** low
**Fix recommendation:** Optional — delete the dead cache complexity
**Area:** loading / Draco
**Files:** `src/c3runtime/DRACOLoader.js:4` (WeakMap), `:84-93` (lookup), `:138-141` (byteLength===0 check); `src/c3runtime/gltfData.js` (~865, fresh Uint8Array per call)

## Problem

The task cache is keyed on the exact typed-array object passed in, but `gltfData._processDracoPrimitive` constructs a *fresh* `new Uint8Array(buffer, byteOffset, byteLength)` per call, so lookups can never hit — dead caching plus a WeakMap entry per primitive. The `if (buffer.byteLength === 0) → "already been transferred"` check is vestigial from upstream three.js: this port always copies into `transferableBuffer` and never transfers the caller's buffer.

## Failure scenario

None functional — dead complexity inherited from the three.js port.

## Suggested fix

Delete the cache and the transfer check, or key the cache on `(ArrayBuffer, byteOffset, byteLength)` if repeated decodes of the same primitive are actually expected.
