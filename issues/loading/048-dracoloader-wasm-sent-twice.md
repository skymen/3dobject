# 048: DRACOLoader posts the WASM binary to each worker twice (and never revokes the worker-side blob URL)

**Severity:** medium
**Fix recommendation:** Nice to have — small memory/copy win; do together with 005
**Area:** loading / Draco
**Files:** `src/c3runtime/DRACOLoader.js:393-402`

## Problem

```js
configToSend.wasmBinary = this.decoderBinary.slice();
worker.postMessage({ type: 'init', decoderConfig: configToSend, decoderBinary: this.decoderBinary })
```

The explicit `.slice()` copy is structured-cloned into the worker, *and* `this.decoderBinary` itself is structured-cloned as a second field the worker never reads (`DRACOWorker` only uses `decoderConfig.wasmBinary`). With the default worker pool of 4 that is up to 8 copies of the ~190 KB WASM binary in flight. The worker also creates a `wasmBlobURL` per init that is never revoked.

## Failure scenario

Wasted memory/copy time on every Draco model load, worse with the per-decode re-init bug (issue 005).

## Suggested fix

Drop the redundant `decoderBinary` field from the postMessage; optionally transfer the sliced buffer (`worker.postMessage(msg, [configToSend.wasmBinary])`); revoke `wasmBlobURL` after module init.
