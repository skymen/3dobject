# Issues Index

Full-codebase review performed 2026-07-02 (v2.91.0). The **v3.0.0 trim-fork** subsequently deleted the unused ~76% of the addon (lighting, wireframe, material modification, morph/quaternion/cannon ACEs, instanceModel, cpuXform, model swapping) and fixed the hardening batch — **43 of the 77 issues are now resolved** and live in [resolved/](resolved/) with resolution notes. Remaining open issues below; several carry a "Status (v3.0.0)" partial-resolution note.

## WebGPU (`webgpu/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [002](webgpu/002-webgpu-shader-infinite-retry.md) | critical | WebGPU — dedicated shader can never be created, Draw self-requeues forever with errors swallowed | Strongly recommended |

## Loading (glTF / GLB / Draco / images) (`loading/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [003](loading/003-createimagebitmap-polyfill-broken.md) | critical | `createImageBitmap` polyfill is broken on every axis (static call, `document` in worker, no revoke, no error handling) | Strongly recommended |
| [015](loading/015-sparse-accessor-mutates-shared-buffer.md) | high | Sparse accessors patch their values into the shared binary buffer in place | Strongly recommended |
| [016](loading/016-strided-reader-zero-fills-int8-int16.md) | high | Strided (interleaved) accessor reader silently zero-fills Int8/Int16 data | Strongly recommended |
| [017](loading/017-material-name-image-collision.md) | high | Material `name` overwritten with the image name — colliding texture keys and shared-object renaming | Recommended |
| [018](loading/018-glb-parsing-unvalidated.md) | high | GLB parsing — unvalidated header/chunks, single-buffer assumption, hardcoded base64 prefix length | Recommended |
| [042](loading/042-image-loading-edge-cases.md) | medium | Image loading edge cases in `loadGLTF` (bare `return`, crash on unreferenced image, `byteOffset` NaN, buffer-0 assumption) | Recommended |
| [075](loading/075-draco-taskcache-never-hits.md) | low | DRACOLoader `_taskCache` never hits; "buffer transferred" logic is vestigial | Optional |

## Rendering (`rendering/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [011](rendering/011-vao-locations-single-program-assumption.md) | high | VAO and cached attribute/uniform locations assume one shader program forever | Recommended |
| [057](rendering/057-blockindex-stale-nonskin.md) | low | `uploadUniformsNonSkin`/`disable` never refresh the UBO block index per shader program | Nice to have |
| [059](rendering/059-quad3d2-arg-inconsistency.md) | low | `Quad3D2` trailing-argument inconsistency between CPU and worker render paths | Nice to have |
| [066](rendering/066-bones-binding-point-zero.md) | low | Bones UBO binding point is 0 while the comment claims "a high number to reduce conflicts" | Nice to have |
| [068](rendering/068-initial-bbox-zero-valid.md) | low | `_updateBoundingBox` treats the initial `[0,0,0]` min/max as a valid dynamic bbox | Nice to have |

## ACEs (`aces/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [063](aces/063-setgpuskinning-clobbers-staticgeometry.md) | low | `SetGPUSkinning(false)` clobbers an independently-enabled `staticGeometry` | Nice to have |

## Properties & language file (`properties/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [035](properties/035-rotation-order-dead.md) | medium | `rotation-order` property and `SetRotationOrdered`'s `order` parameter are dead at runtime (editor honors them, runtime ignores them) | Recommended |
| [076](properties/076-lang-dead-entries.md) | low | Language file — dead entries from the pre-glTF era and mislabeled properties | Optional |

## Animation & transforms (`animation/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [012](animation/012-localcenter-ignored-worker-mode.md) | high | `Set local center` is ignored in worker mode (and by both `updateModelRotate` variants) | Recommended |
| [073](animation/073-animationtime-random-walk.md) | low | Random jitter is permanently accumulated into `animationTime` — playback drifts and is nondeterministic | Recommended |
| [077](animation/077-worker-tick-frame-drop.md) | low | Worker mode drops animation frames when the worker isn't ready, instead of deferring them | Nice to have |

## Worker infrastructure (`worker/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [028](worker/028-gl-matrix-inlined-duplicate.md) | medium | gltfWorker.js embeds a full private copy of gl-matrix (~10,400 lines) | Nice to have |
| [060](worker/060-scannode-ignores-param.md) | low | `scanNode` hardcodes `gpuSkinning = true` and drops its arguments on recursion | Nice to have |

## Performance (`performance/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [010](performance/010-uniform-caching-disabled-or-true.md) | high | Uniform-location caching deliberately disabled via `(x === null || true)` — 10 sites, `gl.getUniformLocation` per draw | Strongly recommended |
| [027](performance/027-per-frame-allocation-churn.md) | medium | Per-frame / per-triangle allocation churn in hot paths (umbrella) | Recommended |

## Lifecycle & memory (`lifecycle/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [023](lifecycle/023-no-context-loss-handling.md) | medium | No WebGL context-loss/restore handling; static dummy bone UBO never freed or recreated | Recommended |
| [029](lifecycle/029-savegame-support-missing.md) | medium | Savegame support entirely missing (`SaveToJson`/`LoadFromJson` are empty) | Recommended |
| [067](lifecycle/067-plugin-release-leaks.md) | low | Runtime plugin `Release()` leaks the shader program, dummy UBO, and event listener; stale globals break restarts | Nice to have |

## Editor (`editor/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [044](editor/044-editor-loaddynamictextures-race.md) | medium | Editor `LoadDynamicTextures` — in-progress sentinel set too late (re-entry race), duplicated statement, unguarded `close()` | Recommended |
| [045](editor/045-editor-release-empty-leaks.md) | medium | Editor instance `Release()` is empty — editor leaks textures/model data; failed loads retry with an alert per instance | Recommended |
| [046](editor/046-editor-stale-bits.md) | medium | Editor instance stale/broken bits — `gtlfPath` typo guard, model-path changes never reload, no-op texture branch | Recommended |

## Code quality & maintenance (`code-quality/`)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| [039](code-quality/039-private-c3-apis-systemic.md) | medium | Systemic reliance on private C3 runtime APIs | Nice to have |
| [061](code-quality/061-magic-numbers-timing-hacks.md) | low | Magic numbers and timing hacks (66ms sleep, ±10000 bbox, `+7` buffer contract, epsilon clamps, misleading comment) | Nice to have |
| [065](code-quality/065-minor-duplications-typos.md) | low | Minor duplications and typos (constructor/release duplicates, dead parameter-null, comment typos) | Optional |
| [069](code-quality/069-sdk-instance-privacy-leak.md) | low | Script interface publishes the internal SDK instance, defeating its own WeakMap encapsulation | Optional |

## Resolved in v3.0.0 (`resolved/`)

| # | Issue | Resolution |
|---|-------|------------|
| [001](resolved/001-webgpu-tick-gl-crash.md) | Unconditional `renderer._gl` access in Tick crashes WebGPU (and is redundant on WebGL) | fixed |
| [004](resolved/004-alert-in-runtime-load-paths.md) | `alert()` used in runtime load/error paths — throws in worker mode, blocks the game loop otherwise | fixed |
| [005](resolved/005-dracoloader-preload-bypass.md) | DRACOLoader `_getWorker` bypasses the `preload()` cache — re-downloads the WASM per decode task and leaks blob URLs | fixed |
| [006](resolved/006-rotate-ace-broken-model3d.md) | `Rotate` action throws — references `this.model3D`, which is never assigned anywhere | deleted with its subsystem |
| [007](resolved/007-isanimationfinished-always-false.md) | `Is animation finished` condition always returns false (reads a nonexistent member) | deleted with its subsystem |
| [008](resolved/008-property-index-mismatch-cpuxform.md) | Property index mismatch — `cpuXform` reads the obsolete z-elevation float; the "cpu-xform" property actually feeds `backFaceCull` | fixed |
| [009](resolved/009-loadmodel-noop-after-first-load.md) | `Load model` action is a permanent no-op once any model has loaded | deleted with its subsystem |
| [013](resolved/013-cached-light-colors-progressive-darkening.md) | Cached per-triangle light colors are multiplied in place — tinted lit models fade to black | deleted with its subsystem |
| [014](resolved/014-loadgltf-ignores-parse-failures.md) | `loadGLTF` ignores the boolean results of its parsing helpers — failed parses report success | fixed |
| [019](resolved/019-drawlights-index-multi-group.md) | CPU light path indexes `drawLights` with a per-group counter that resets across vertex groups | deleted with its subsystem |
| [020](resolved/020-cpuxform-modelview-not-restored.md) | CPU model with `cpuXform`: ModelView matrix set but never restored — double transform + stale matrix for subsequent objects | deleted with its subsystem |
| [021](resolved/021-instancetexture-uv-remap-missing-worker.md) | Instance-texture / sprite-texture UV remapping missing from the worker render path | deleted with its subsystem |
| [022](resolved/022-vertexscale-wrong-axis.md) | Vertex-rounding snaps Y and Z using the X scale — non-uniform scales distort the model | deleted with its subsystem |
| [024](resolved/024-worker-errors-swallowed-host-poisoned.md) | Worker errors are invisible — a worker exception freezes animation silently; a failed shared-host init poisons the type forever | fixed |
| [025](resolved/025-drawlightsenable-null-bufferviews.md) | Worker mode: `drawLightsEnable` set before any light update → render crash on null `drawLightsBufferViews` | deleted with its subsystem |
| [026](resolved/026-specular-math-broken.md) | Specular reflection math is wrong in the CPU light path; the worker's copy is hard-disabled with `&& false` | deleted with its subsystem |
| [030](resolved/030-setcameravectorpos-noop.md) | `Set camera vector/pos` action is a silent no-op (fields never read; `_cullPoint` has no callers) | deleted with its subsystem |
| [031](resolved/031-duplicate-property-index-methods.md) | `GetPropertyValueByIndex`/`SetPropertyValueByIndex` defined twice in the instance class | fixed |
| [032](resolved/032-draw-textures-length-always-false.md) | `Draw`'s no-material fallback check `textures.length === 0` is always false (object, not array) | fixed |
| [033](resolved/033-setmeshmaterial-no-guard.md) | `Set mesh material` throws when called before the model loads (missing guard) | deleted with its subsystem |
| [034](resolved/034-animationnames-expression-unguarded.md) | `AnimationNames` expression throws before the model loads | fixed |
| [036](resolved/036-loadmodelfromtemplate-leak-and-crash.md) | `Load model from template` leaks the instance's own GltfData and can crash on texture load | deleted with its subsystem |
| [037](resolved/037-lightenable-repolygonize-every-tick.md) | Enabling lighting forces full CPU re-polygonization and bbox rebuild every tick, even for static models | deleted with its subsystem |
| [038](resolved/038-getpolygons-drops-gpuskinning-arg.md) | Tick's renderOnce path drops the `gpuSkinning` flag when calling the CPU model's `getPolygons` | fixed |
| [040](resolved/040-texture-load-errors-stuck-sentinel.md) | Texture upload failures are swallowed and permanently wedge `dynamicTexturesLoaded` at the in-progress sentinel | fixed |
| [041](resolved/041-cache-reload-refcount-loadmaterial-textures.md) | Cross-type cache — re-`load()` leaks the previous entry's refcount; `LoadMaterial` replacement textures never freed when the type's textures are cache-shared | deleted with its subsystem |
| [043](resolved/043-calculatebones-dead-loops-no-clamp.md) | `_calculateBonesPerModelAsset` — two dead loops, placeholder essays, and no clamp against `SHADER_MAX_BONES` | fixed |
| [047](resolved/047-dracoloader-init-failure-hangs.md) | DRACOLoader — worker init failure hangs all decodes forever; no `worker.onerror`; rejects with plain objects | fixed |
| [048](resolved/048-dracoloader-wasm-sent-twice.md) | DRACOLoader posts the WASM binary to each worker twice (and never revokes the worker-side blob URL) | fixed |
| [049](resolved/049-packaging-stale-zip-entries.md) | Packaging — `zip -r` updates existing archives (stale entries), picks up `.DS_Store`, and never syncs the internal version | fixed |
| [050](resolved/050-build-script-polish.md) | Build script polish — `numfmt` missing on macOS; dangling `sourceMappingURL` comments in shipped files | fixed |
| [051](resolved/051-dead-code-model-worker.md) | Dead code in gltfModel / gltfModelW / gltfWorker (grep-verified, zero call sites) | deleted with its subsystem |
| [052](resolved/052-dead-instance-fields.md) | Dead instance fields reallocated every animation tick (`drawVerts`/`drawUVs`/`drawIndices` and friends) | deleted with its subsystem |
| [053](resolved/053-dead-lighting-fields-aces.md) | Dead lighting/blend fields and their ACEs (`SetLightDir`, `SetBlendMode`, `EnableSpotLight`, `lightColor`, `EnableLight`'s phantom color param) | deleted with its subsystem |
| [054](resolved/054-processstandardprimitivesonly-dead.md) | `_processStandardPrimitivesOnly` is ~200 lines of dead code that would crash if ever called | deleted with its subsystem |
| [055](resolved/055-default-texcoord-oversized.md) | `createDefaultTexcoordData` allocates 3 floats per vertex instead of 2 (plus leftover empty `if`) | fixed |
| [056](resolved/056-first-draw-skips-color-uniforms.md) | First draw of each ObjectBuffer skips the color uniforms (set-before-lookup ordering) | fixed |
| [062](resolved/062-cpu-model-release-msgport-guards.md) | CPU model release lacks the boneBuffer sweep; worker node/morph actions lack `msgPort` guards | fixed |
| [064](resolved/064-scale-text-property.md) | `scale` is a "text" property consumed as a number — `Scale` expression returns a string until `SetScale` runs | fixed |
| [070](resolved/070-draw-destroys-mid-render.md) | `Draw()` destroys the instance mid-render when the template's model data is gone | deleted with its subsystem |
| [071](resolved/071-gltfpath-undefined-load.md) | Constructor load path runs with `gltfPath === undefined` when properties are absent | fixed |
| [072](resolved/072-gtlf-path-typo.md) | Property id typo `gtlf-path` (transposed "gltf") is baked into projects and already spawned a real bug | documented |
| [074](resolved/074-editor-draco-stale-messaging.md) | Stale editor-Draco messaging claims decoding "will be bypassed" while the editor actually decodes | fixed |
