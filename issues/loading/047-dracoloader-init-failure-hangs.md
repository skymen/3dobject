# 047: DRACOLoader — worker init failure hangs all decodes forever; no `worker.onerror`; rejects with plain objects

**Severity:** medium
**Fix recommendation:** Strongly recommended — small; converts a silent forever-hang into a clear error
**Area:** loading / Draco
**Files:** `src/c3runtime/DRACOLoader.js:405-417` (worker creation/messaging), `:472-509` (DRACOWorker init)

## Problem

Inside the embedded `DRACOWorker`, `decoderPending` only ever *resolves* (`decoderConfig.onModuleLoaded = resolve...`). If `DracoDecoderModule(...)` throws or WASM instantiation fails, nothing rejects and no error message is posted — every pending `decodePrimitive` promise hangs, so `gltfData.load` never resolves and the model silently never appears. On the main side, `worker.onmessage` handles only `decode`/`error` message types, `worker.onerror` is never installed (a top-level script error in the worker → the same silent hang), and the error path rejects with the raw message object (`reject(message)`) rather than an `Error`, producing useless logs upstream.

## Failure scenario

Draco WASM blocked by CSP, corrupted download, or an unsupported browser: models never load, no error anywhere, `load()` promise pends forever (with the cross-type cache, all types sharing the path pend too).

## Suggested fix

Wrap the module init in try/catch and post an `init-error` message that rejects all pending tasks; set `worker.onerror` similarly; reject with `new Error(message.error)`.
