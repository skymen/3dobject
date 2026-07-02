# Issues Index

Full-codebase review of the 3DObject addon (`src/`, editor + runtime + worker + Draco + build scripts), performed 2026-07-02 against the working tree at v2.91.0. Every finding was verified against the actual code before being written down. Line numbers are approximate — anchors, not exact references.

Issues are organized into category subfolders. Each issue header carries a **Severity** (impact if unfixed) and a **Fix recommendation** (how strongly fixing it is advised, with a feel for the effort):
**Fix immediately** (crash/corruption with a tiny diff) → **Strongly recommended** → **Recommended** → **Nice to have** → **Optional**.

**Already fixed during this review (in the working tree, not filed):**
- Worker crash when GPU skinning + per-triangle lighting were combined (v2.90 buffLights gating left `drawLights` unallocated) — `updateLight` now guarded with `!gpuSkinning`.
- Shared-worker cross-instance state leak: skinned nodes aliased one module-level scratch quat (`node.rotation = rotationQuat`); now a per-node identity array.

## WebGPU (`webgpu/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [001](webgpu/001-webgpu-tick-gl-crash.md) | critical | Unconditional `renderer._gl` access in Tick crashes WebGPU (and is redundant on WebGL) | Fix immediately |
| [002](webgpu/002-webgpu-shader-infinite-retry.md) | critical | WebGPU — dedicated shader can never be created, Draw self-requeues forever with errors swallowed | Strongly recommended |

## Loading (glTF / GLB / Draco / images) (`loading/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [003](loading/003-createimagebitmap-polyfill-broken.md) | critical | `createImageBitmap` polyfill is broken on every axis (static call, `document` in worker, no revoke, no error handling) | Strongly recommended |
| [004](loading/004-alert-in-runtime-load-paths.md) | critical | `alert()` used in runtime load/error paths — throws in worker mode, blocks the game loop otherwise | Fix immediately |
| [005](loading/005-dracoloader-preload-bypass.md) | critical | DRACOLoader `_getWorker` bypasses the `preload()` cache — re-downloads the WASM per decode task and leaks blob URLs | Fix immediately |
| [014](loading/014-loadgltf-ignores-parse-failures.md) | high | `loadGLTF` ignores the boolean results of its parsing helpers — failed parses report success | Fix immediately |
| [015](loading/015-sparse-accessor-mutates-shared-buffer.md) | high | Sparse accessors patch their values into the shared binary buffer in place | Strongly recommended |
| [016](loading/016-strided-reader-zero-fills-int8-int16.md) | high | Strided (interleaved) accessor reader silently zero-fills Int8/Int16 data | Strongly recommended |
| [017](loading/017-material-name-image-collision.md) | high | Material `name` overwritten with the image name — colliding texture keys and shared-object renaming | Recommended |
| [018](loading/018-glb-parsing-unvalidated.md) | high | GLB parsing — unvalidated header/chunks, single-buffer assumption, hardcoded base64 prefix length | Recommended |
| [042](loading/042-image-loading-edge-cases.md) | medium | Image loading edge cases in `loadGLTF` (bare `return`, crash on unreferenced image, `byteOffset` NaN, buffer-0 assumption) | Recommended |
| [043](loading/043-calculatebones-dead-loops-no-clamp.md) | medium | `_calculateBonesPerModelAsset` — two dead loops, placeholder essays, and no clamp against `SHADER_MAX_BONES` | Recommended |
| [047](loading/047-dracoloader-init-failure-hangs.md) | medium | DRACOLoader — worker init failure hangs all decodes forever; no `worker.onerror`; rejects with plain objects | Strongly recommended |
| [048](loading/048-dracoloader-wasm-sent-twice.md) | medium | DRACOLoader posts the WASM binary to each worker twice (and never revokes the worker-side blob URL) | Nice to have |
| [075](loading/075-draco-taskcache-never-hits.md) | low | DRACOLoader `_taskCache` never hits; "buffer transferred" logic is vestigial | Optional |

## Rendering & lighting (`rendering/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [011](rendering/011-vao-locations-single-program-assumption.md) | high | VAO and cached attribute/uniform locations assume one shader program forever | Recommended |
| [013](rendering/013-cached-light-colors-progressive-darkening.md) | high | Cached per-triangle light colors are multiplied in place — tinted lit models fade to black | Fix immediately |
| [019](rendering/019-drawlights-index-multi-group.md) | medium | CPU light path indexes `drawLights` with a per-group counter that resets across vertex groups | Recommended |
| [020](rendering/020-cpuxform-modelview-not-restored.md) | medium | CPU model with `cpuXform`: ModelView matrix set but never restored — double transform + stale matrix for subsequent objects | Strongly recommended |
| [021](rendering/021-instancetexture-uv-remap-missing-worker.md) | medium | Instance-texture / sprite-texture UV remapping missing from the worker render path | Recommended |
| [022](rendering/022-vertexscale-wrong-axis.md) | medium | Vertex-rounding snaps Y and Z using the X scale — non-uniform scales distort the model | Fix immediately |
| [025](rendering/025-drawlightsenable-null-bufferviews.md) | medium | Worker mode: `drawLightsEnable` set before any light update → render crash on null `drawLightsBufferViews` | Fix immediately |
| [026](rendering/026-specular-math-broken.md) | medium | Specular reflection math is wrong in the CPU light path; the worker's copy is hard-disabled with `&& false` | Nice to have |
| [032](rendering/032-draw-textures-length-always-false.md) | medium | `Draw`'s no-material fallback check `textures.length === 0` is always false (object, not array) | Fix immediately |
| [056](rendering/056-first-draw-skips-color-uniforms.md) | low | First draw of each ObjectBuffer skips the color uniforms (set-before-lookup ordering) | Nice to have |
| [057](rendering/057-blockindex-stale-nonskin.md) | low | `uploadUniformsNonSkin`/`disable` never refresh the UBO block index per shader program | Nice to have |
| [059](rendering/059-quad3d2-arg-inconsistency.md) | low | `Quad3D2` trailing-argument inconsistency between CPU and worker render paths | Nice to have |
| [066](rendering/066-bones-binding-point-zero.md) | low | Bones UBO binding point is 0 while the comment claims "a high number to reduce conflicts" | Nice to have |
| [068](rendering/068-initial-bbox-zero-valid.md) | low | `_updateBoundingBox` treats the initial `[0,0,0]` min/max as a valid dynamic bbox | Nice to have |

## ACEs (actions / conditions / expressions) (`aces/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [006](aces/006-rotate-ace-broken-model3d.md) | high | `Rotate` action throws — references `this.model3D`, which is never assigned anywhere | Fix immediately |
| [007](aces/007-isanimationfinished-always-false.md) | high | `Is animation finished` condition always returns false (reads a nonexistent member) | Fix immediately |
| [009](aces/009-loadmodel-noop-after-first-load.md) | high | `Load model` action is a permanent no-op once any model has loaded | Strongly recommended |
| [030](aces/030-setcameravectorpos-noop.md) | medium | `Set camera vector/pos` action is a silent no-op (fields never read; `_cullPoint` has no callers) | Nice to have |
| [033](aces/033-setmeshmaterial-no-guard.md) | medium | `Set mesh material` throws when called before the model loads (missing guard) | Fix immediately |
| [034](aces/034-animationnames-expression-unguarded.md) | medium | `AnimationNames` expression throws before the model loads | Fix immediately |
| [036](aces/036-loadmodelfromtemplate-leak-and-crash.md) | medium | `Load model from template` leaks the instance's own GltfData and can crash on texture load | Recommended |
| [063](aces/063-setgpuskinning-clobbers-staticgeometry.md) | low | `SetGPUSkinning(false)` clobbers an independently-enabled `staticGeometry` | Nice to have |

## Properties & language file (`properties/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [008](properties/008-property-index-mismatch-cpuxform.md) | high | Property index mismatch — `cpuXform` reads the obsolete z-elevation float; the "cpu-xform" property actually feeds `backFaceCull` | Strongly recommended |
| [035](properties/035-rotation-order-dead.md) | medium | `rotation-order` property and `SetRotationOrdered`'s `order` parameter are dead at runtime (editor honors them, runtime ignores them) | Recommended |
| [064](properties/064-scale-text-property.md) | low | `scale` is a "text" property consumed as a number — `Scale` expression returns a string until `SetScale` runs | Nice to have |
| [071](properties/071-gltfpath-undefined-load.md) | low | Constructor load path runs with `gltfPath === undefined` when properties are absent | Nice to have |
| [072](properties/072-gtlf-path-typo.md) | low | Property id typo `gtlf-path` (transposed "gltf") is baked into projects and already spawned a real bug | Optional |
| [076](properties/076-lang-dead-entries.md) | low | Language file — dead entries from the pre-glTF era and mislabeled properties | Optional |

## Animation & transforms (`animation/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [012](animation/012-localcenter-ignored-worker-mode.md) | high | `Set local center` is ignored in worker mode (and by both `updateModelRotate` variants) | Recommended |
| [038](animation/038-getpolygons-drops-gpuskinning-arg.md) | medium | Tick's renderOnce path drops the `gpuSkinning` flag when calling the CPU model's `getPolygons` | Fix immediately |
| [073](animation/073-animationtime-random-walk.md) | low | Random jitter is permanently accumulated into `animationTime` — playback drifts and is nondeterministic | Recommended |
| [077](animation/077-worker-tick-frame-drop.md) | low | Worker mode drops animation frames when the worker isn't ready, instead of deferring them | Nice to have |

## Worker infrastructure (`worker/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [024](worker/024-worker-errors-swallowed-host-poisoned.md) | medium | Worker errors are invisible — a worker exception freezes animation silently; a failed shared-host init poisons the type forever | Strongly recommended |
| [028](worker/028-gl-matrix-inlined-duplicate.md) | medium | gltfWorker.js embeds a full private copy of gl-matrix (~10,400 lines) | Nice to have |
| [060](worker/060-scannode-ignores-param.md) | low | `scanNode` hardcodes `gpuSkinning = true` and drops its arguments on recursion | Nice to have |
| [062](worker/062-cpu-model-release-msgport-guards.md) | low | CPU model release lacks the boneBuffer sweep; worker node/morph actions lack `msgPort` guards | Recommended |

## Performance (`performance/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [010](performance/010-uniform-caching-disabled-or-true.md) | high | Uniform-location caching deliberately disabled via `(x === null || true)` — 10 sites, `gl.getUniformLocation` per draw | Strongly recommended |
| [027](performance/027-per-frame-allocation-churn.md) | medium | Per-frame / per-triangle allocation churn in hot paths (umbrella) | Recommended |
| [037](performance/037-lightenable-repolygonize-every-tick.md) | medium | Enabling lighting forces full CPU re-polygonization and bbox rebuild every tick, even for static models | Strongly recommended |
| [055](performance/055-default-texcoord-oversized.md) | low | `createDefaultTexcoordData` allocates 3 floats per vertex instead of 2 (plus leftover empty `if`) | Nice to have |

## Lifecycle & memory (`lifecycle/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [023](lifecycle/023-no-context-loss-handling.md) | medium | No WebGL context-loss/restore handling; static dummy bone UBO never freed or recreated | Recommended |
| [029](lifecycle/029-savegame-support-missing.md) | medium | Savegame support entirely missing (`SaveToJson`/`LoadFromJson` are empty) | Recommended |
| [040](lifecycle/040-texture-load-errors-stuck-sentinel.md) | medium | Texture upload failures are swallowed and permanently wedge `dynamicTexturesLoaded` at the in-progress sentinel | Strongly recommended |
| [041](lifecycle/041-cache-reload-refcount-loadmaterial-textures.md) | medium | Cross-type cache — re-`load()` leaks the previous entry's refcount; `LoadMaterial` replacement textures never freed when the type's textures are cache-shared | Recommended |
| [067](lifecycle/067-plugin-release-leaks.md) | low | Runtime plugin `Release()` leaks the shader program, dummy UBO, and event listener; stale globals break restarts | Nice to have |
| [070](lifecycle/070-draw-destroys-mid-render.md) | low | `Draw()` destroys the instance mid-render when the template's model data is gone | Nice to have |

## Editor (`editor/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [044](editor/044-editor-loaddynamictextures-race.md) | medium | Editor `LoadDynamicTextures` — in-progress sentinel set too late (re-entry race), duplicated statement, unguarded `close()` | Recommended |
| [045](editor/045-editor-release-empty-leaks.md) | medium | Editor instance `Release()` is empty — editor leaks textures/model data; failed loads retry with an alert per instance | Recommended |
| [046](editor/046-editor-stale-bits.md) | medium | Editor instance stale/broken bits — `gtlfPath` typo guard, model-path changes never reload, no-op texture branch | Recommended |
| [074](editor/074-editor-draco-stale-messaging.md) | low | Stale editor-Draco messaging claims decoding "will be bypassed" while the editor actually decodes | Optional |

## Build & packaging (`build/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [049](build/049-packaging-stale-zip-entries.md) | medium | Packaging — `zip -r` updates existing archives (stale entries), picks up `.DS_Store`, and never syncs the internal version | Strongly recommended |
| [050](build/050-build-script-polish.md) | low | Build script polish — `numfmt` missing on macOS; dangling `sourceMappingURL` comments in shipped files | Nice to have |

## Dead code (`dead-code/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [051](dead-code/051-dead-code-model-worker.md) | low | Dead code in gltfModel / gltfModelW / gltfWorker (grep-verified, zero call sites) | Nice to have |
| [052](dead-code/052-dead-instance-fields.md) | low | Dead instance fields reallocated every animation tick (`drawVerts`/`drawUVs`/`drawIndices` and friends) | Nice to have |
| [053](dead-code/053-dead-lighting-fields-aces.md) | low | Dead lighting/blend fields and their ACEs (`SetLightDir`, `SetBlendMode`, `EnableSpotLight`, `lightColor`, `EnableLight`'s phantom color param) | Nice to have |
| [054](dead-code/054-processstandardprimitivesonly-dead.md) | low | `_processStandardPrimitivesOnly` is ~200 lines of dead code that would crash if ever called | Nice to have |

## Code quality & maintenance (`code-quality/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [031](code-quality/031-duplicate-property-index-methods.md) | medium | `GetPropertyValueByIndex`/`SetPropertyValueByIndex` defined twice in the instance class | Fix immediately |
| [039](code-quality/039-private-c3-apis-systemic.md) | medium | Systemic reliance on private C3 runtime APIs | Nice to have |
| [058](code-quality/058-console-spam.md) | low | Console spam — per-frame warnings in the runtime and ~25 unconditional 🔥 logs in DRACOLoader | Recommended |
| [061](code-quality/061-magic-numbers-timing-hacks.md) | low | Magic numbers and timing hacks (66ms sleep, ±10000 bbox, `+7` buffer contract, epsilon clamps, misleading comment) | Nice to have |
| [065](code-quality/065-minor-duplications-typos.md) | low | Minor duplications and typos (constructor/release duplicates, dead parameter-null, comment typos) | Optional |
| [069](code-quality/069-sdk-instance-privacy-leak.md) | low | Script interface publishes the internal SDK instance, defeating its own WeakMap encapsulation | Optional |

## Suggested attack order

1. **"Fix immediately" batch** — small diffs, crashes/corruption: 001, 004, 005, 006, 007, 013, 014, 022, 025, 031, 032, 033, 034, 038.
2. **Silent-failure hardening:** 024, 040, 047, 002, 003 — make failures loud before anything else, so later work is debuggable.
3. **Property/ACE debt:** 008 (+035, 072, 076 in the same pass), 009 (+041), 030, 036.
4. **Performance pass:** 010 (+011, 057, 066 as one program-keyed caching change), 037, 027 item 1.
5. **Bigger projects:** 023 (context loss), 029 (savegames), 021 + 012 (worker-mode feature parity), 026, 028, 039, 015-018 (loader conformance), build fixes 049/050.
6. **Cleanup passes:** dead-code folder, code-quality folder, editor folder.
