# 024: Worker errors are invisible — a worker exception freezes animation silently; a failed shared-host init poisons the type forever

**Severity:** medium
**Fix recommendation:** Strongly recommended — small error handlers with a huge diagnosability payoff
**Resolution:** Fixed in v3.0.0 (trim stage 5): worker/message error handlers added; the shared host resets its port promise on failure.
**Area:** worker infrastructure
**Files:** `src/c3runtime/gltfModelW.js` (`GltfWorkerHostTop.getPort` ~21-41, dedicated-worker `onmessage` assignment ~528), `src/c3runtime/gltfWorker.js` (no `self.onerror` / top-level try/catch)

## Problem

1. Neither the dedicated worker port nor the shared host port installs `onmessageerror` or a worker `error` handler, and the worker has no top-level error handling. Any worker-side throw means no reply message → `workerReady` stays false → `updateAnimationPolygons`/`getPolygons` early-return forever. The model silently freezes with zero diagnostics.
2. `GltfWorkerHostTop.getPort` caches `portPromise` with no `.catch`: if `GetProjectFileUrl` or `createWorker` rejects once, every future instance of that type awaits the same rejected promise — an unhandled rejection per instance and a permanently broken type.

## Failure scenario

Any bug or transient failure inside the worker (see the pre-fix buffLights crash for a concrete example) manifests as "characters stop animating, no errors anywhere". A one-off worker-creation failure at startup bricks the type for the whole session.

## Suggested fix

Install `port.onmessageerror` and (where the Worker object is reachable) `worker.onerror` handlers that `console.error` and mark the model/host failed; add a top-level `self.addEventListener("error", ...)` log in gltfWorker.js; in `getPort`, `.catch` the init promise, log, and reset `this.portPromise = null` so a later instance can retry.
