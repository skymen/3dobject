# 062: CPU model release lacks the boneBuffer sweep; worker node/morph actions lack `msgPort` guards

**Severity:** low
**Fix recommendation:** Recommended — two small guards prevent a real ACE crash window
**Resolution:** Fixed in v3.0.0 (trim stage 5): enableNode guards a missing msgPort (morph senders were deleted); the CPU model boneBuffer sweep became moot (BoneBuffers own no GL objects).
**Area:** lifecycle / worker path
**Files:** `src/c3runtime/gltfModel.js` `release()` (vs `gltfModelW.js`'s sweep), `src/c3runtime/gltfModelW.js` `enableNode`/`setNodeMorphWeight`/`deleteNodeMorphWeight` (~666-676)

## Problem

1. `GltfModelTop.release()` lacks the node/skinnedNode `boneBuffer.release()` sweep that `GltfModelWTop.release()` performs. BoneBuffer owns no GL objects, so this is not a GPU leak, but the bone arrays linger through any surviving `gltfData` references.
2. `enableNode`, `setNodeMorphWeight`, `deleteNodeMorphWeight` call `this.msgPort.postMessage(...)` with no null guard. An action fired while the worker is still being created (before `createWorker` resolves) or after release (where `msgPort` is nulled) throws a TypeError. The ACE wrappers in actions.js guard `this.gltf` existence but not worker readiness.

## Failure scenario

"Enable node" (etc.) called in the same tick the object is created, or racing destruction → TypeError from the ACE.

## Suggested fix

Mirror the release sweep in the CPU model; add `if (!this.msgPort) return` (or queue the message until the worker is ready) in the three senders.
