// @ts-check
"use strict"

// The MessagePort for communicating with the runtime
let msgPort = null
let buff = null
let buffBones = null
let drawVerts = null
let drawBones = null
let index = 0
let gltf = null
let minBB = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
let maxBB = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
let buffLength = 0
let buffBonesLength = 0
let disabledNodes = new Map()
let activeNodes = []
let nodeIndex = 0
let bonesIndex = 0
let drawMeshes = null
// Whether vertex attribute data (positions/weights/joints/morph targets) is present.
// GPU-skinning instances send length stubs instead; real data arrives on demand
// via an "attributes" message if a CPU-skinning request comes in.
let attributesLoaded = true

// Per-instance state. A worker either serves a single instance (legacy mode: one
// record under DEFAULT_IID referencing the received graph directly) or is shared by
// all instances of an object type (records created per "addInstance", each with its
// own mutable node graph over the shared immutable data).
const DEFAULT_IID = "__default"
const instances = new Map()
let sharedGltf = null
let currentRecord = null
let replyIid = undefined

function freshInstanceState() {
  return {
    blendState: "init",
    lastTarget: [[], []],
    lastTargetIndex: 0,
    blendTarget: [],
    blendTime: 0,
    lastIndex: 0,
    disabledNodes: new Map(),
  }
}

// Clone the mutable scene-graph state (node transforms, joint matrices, morph
// weights) from the shared graph; meshes, attribute data and keyframes are shared
function createRecordFromShared() {
  const src = sharedGltf
  const nodeMap = new Map()
  const nodes = (src.nodes || []).map((n) => {
    const c = { ...n }
    if (n.translation) c.translation = n.translation.slice()
    if (n.rotation) c.rotation = n.rotation.slice()
    if (n.scale) c.scale = n.scale.slice()
    if (n.matrix) c.matrix = n.matrix.slice()
    if (n.invMatrix) c.invMatrix = n.invMatrix.slice()
    if (n.weights) c.weights = new Float32Array(n.weights)
    if (n.boneMatrix) c.boneMatrix = n.boneMatrix.slice()
    nodeMap.set(n, c)
    return c
  })
  for (const n of src.nodes || []) {
    const c = nodeMap.get(n)
    if (n.children) c.children = n.children.map((x) => nodeMap.get(x) || x)
    if (n.skin) c.skin = { joints: n.skin.joints.map((j) => nodeMap.get(j) || j) }
  }
  const animations = (src.animations || []).map((a) => ({
    name: a.name,
    channels: a.channels.map((ch) => ({
      sampler: ch.sampler,
      target: { path: ch.target.path, node: nodeMap.get(ch.target.node) || ch.target.node },
    })),
  }))
  const record = freshInstanceState()
  record.gltf = {
    nodes,
    meshes: src.meshes,
    animations,
    scene: { nodes: ((src.scene && src.scene.nodes) || []).map((n) => nodeMap.get(n) || n) },
    skinnedNodes: (src.skinnedNodes || []).map((n) => nodeMap.get(n) || n),
  }
  return record
}

// Point the module-level state at a record so the processing functions below can
// stay unchanged; message handling is synchronous, so this never interleaves
function activateInstance(iid) {
  const record = instances.get(iid === undefined ? DEFAULT_IID : iid)
  if (!record) return false
  currentRecord = record
  gltf = record.gltf
  blendState = record.blendState
  lastTarget[0] = record.lastTarget[0]
  lastTarget[1] = record.lastTarget[1]
  lastTargetIndex = record.lastTargetIndex
  blendTarget = record.blendTarget
  blendTime = record.blendTime
  lastIndex = record.lastIndex
  disabledNodes = record.disabledNodes
  return true
}

function deactivateInstance() {
  const record = currentRecord
  if (!record) return
  record.blendState = blendState
  record.lastTarget[0] = lastTarget[0]
  record.lastTarget[1] = lastTarget[1]
  record.lastTargetIndex = lastTargetIndex
  record.blendTarget = blendTarget
  record.blendTime = blendTime
  record.lastIndex = lastIndex
  currentRecord = null
}

// Replace attribute length stubs ({dataLength}) with objects exposing .length so
// bookkeeping code (index += posData.length, loop bounds) works without the data
function normalizeAttributeStubs() {
  if (!sharedGltf || !sharedGltf.meshes) return
  attributesLoaded = true
  for (const mesh of sharedGltf.meshes) {
    if (!mesh || !mesh.primitives) continue
    for (const p of mesh.primitives) {
      const attrs = p.attributes || {}
      for (const key of ["POSITION", "WEIGHTS_0", "JOINTS_0"]) {
        const attr = attrs[key]
        if (attr && attr.data == null) {
          attr.data = { length: attr.dataLength }
          if (key === "POSITION") attributesLoaded = false
        }
      }
    }
  }
}

function patchAttributes(meshes) {
  if (!sharedGltf || !sharedGltf.meshes) return
  for (let k = 0; k < meshes.length; k++) {
    const target = sharedGltf.meshes[k]
    if (!target) continue
    for (let j = 0; j < meshes[k].primitives.length; j++) {
      const src = meshes[k].primitives[j]
      const dst = target.primitives[j]
      if (!dst) continue
      dst.attributes = dst.attributes || {}
      for (const key of ["POSITION", "WEIGHTS_0", "JOINTS_0"]) {
        if (src[key]) dst.attributes[key] = { data: src[key] }
      }
      if (src.targets) {
        dst.targets = src.targets.map((data) => ({ POSITION: { data } }))
      }
    }
  }
  attributesLoaded = true
}

// =============================================================================
// Batched GPU-skinning protocol
//
// One "batch" message per worker per frame carries every on-screen instance's
// request; one "batchResult" carries every instance's pose. Before this the
// main thread sent two messages per instance per frame (each transferring a
// 260 KB vertex buffer that GPU skinning never reads), so 100 characters meant
// 200 postMessages a frame - the per-message overhead, not the maths, is what
// made the worker "lag" past ~100 instances.
//
// Request slot (Float64, REQ_STRIDE per instance):
//   [0] iid  [1] animation index, -1 = pose only  [2] time  [3] deltaTime
//   [4] animation blend  [5] loop (0/1)  [6..7] reserved
// Optional `offs` (Float32Array): per slot, in slot order,
//   [nOff, (nodeIndex, x, y, z, w) * nOff, nMix, (animIndex, weight, phase (NaN: the playing clip's)) * nMix]
//   = the instance's bone rotation offsets (applyBoneOffsets) and blend weights (mixChannel)
// Optional side buffer `offs`, per slot: [nOff, (node, x, y, z, w) * nOff, nMix, (animIndex, weight, phase (NaN: the playing clip's)) * nMix,
// nIK, (IK_STRIDE floats) * nIK, nJig, jiggle, nRB, drawn node indices] (bone offsets, blend weights, IK chains
// in model space, jiggle bones, the nodes whose drawn matrices go back after the bounds: setDrawnNodes).
// Reply: `out` holds graph.floats floats per slot, laid out by buildGraph
// (unskinned mesh node matrices, then per skin GROUP joints + root transform,
// then posed bounds). The main thread builds the identical layout from the
// same model graph (buildPoseLayout in gltfModelW.js - KEEP IN SYNC).
//
// Per-instance state is three flat typed arrays (TRS, world matrices, group
// inverses) plus sampler cursors: about 12 KB per character. Every node,
// mesh, skin and animation object is shared. The previous design cloned the
// whole node graph AND the animation list per instance - ~350 KB per
// character - which is what ran a 6,000-instance test out of memory.
//
// Skin groups: every skinned mesh node with the same parent, translation, scale
// and joint list yields identical bone matrices, so they are computed and sent
// once. A typical character exported as 20+ mesh parts under one armature is a
// single group - 23x less bone maths and transfer than one set per part.
//
// ---- Keyframe sampler: KEEP IN SYNC with runtime/animSampler.js ----
//
// KEEP IN SYNC with the copy in files/gltfWorker.js (the worker is a plain
// script that the build copies verbatim, so it cannot import this module).
//
// Design goals, in order:
//   1. No per-instance copy of the animation data. Targets are NODE INDICES
//      and the sampled transforms go into a flat per-instance Float32Array
//      (TRS_STRIDE floats per node: translation, rotation, scale), so every
//      instance shares one animation list. Cloning the channels per instance
//      was ~2,900 objects per character per thread.
//   2. No allocation per call. The old sampler minted four typed-array views
//      per channel per frame plus an object and a clone per channel for the
//      blend snapshot.
//   3. No linear scan. A per-channel cursor steps forward from where it was
//      last frame and only falls back to a binary search on a seek.
//
// The blend snapshot is stored per channel index as a path code plus four
// floats, matching the old behaviour where a blend compared channel i of the
// new animation with channel i of the previous one.

const TRS_STRIDE = 10 // t(3) r(4) s(3)
// Exact copies of V8's Math.hypot (max-scaled, Kahan-summed: bit-identical results) that allocate nothing: the
// builtin allocates a scratch array per call wherever it isn't inlined (it showed up as ~18 MB/s of garbage with 50
// animated players). KEEP IN SYNC: gltfWorker.js / gltfModelW.js
function hypot3(a, b, c) {
  a = +a; b = +b; c = +c
  let max = 0, nan = false
  if (a !== a) nan = true; else { a = Math.abs(a); if (a > max) max = a }
  if (b !== b) nan = true; else { b = Math.abs(b); if (b > max) max = b }
  if (c !== c) nan = true; else { c = Math.abs(c); if (c > max) max = c }
  if (max === Infinity) return Infinity
  if (nan) return NaN
  if (max === 0) return 0
  let sum = 0, comp = 0, n, s, p
  n = a / max; s = n * n - comp; p = sum + s; comp = p - sum - s; sum = p
  n = b / max; s = n * n - comp; p = sum + s; comp = p - sum - s; sum = p
  n = c / max; s = n * n - comp; p = sum + s; comp = p - sum - s; sum = p
  return Math.sqrt(sum) * max
}
function hypot4(a, b, c, d) {
  a = +a; b = +b; c = +c; d = +d
  let max = 0, nan = false
  if (a !== a) nan = true; else { a = Math.abs(a); if (a > max) max = a }
  if (b !== b) nan = true; else { b = Math.abs(b); if (b > max) max = b }
  if (c !== c) nan = true; else { c = Math.abs(c); if (c > max) max = c }
  if (d !== d) nan = true; else { d = Math.abs(d); if (d > max) max = d }
  if (max === Infinity) return Infinity
  if (nan) return NaN
  if (max === 0) return 0
  let sum = 0, comp = 0, n, s, p
  n = a / max; s = n * n - comp; p = sum + s; comp = p - sum - s; sum = p
  n = b / max; s = n * n - comp; p = sum + s; comp = p - sum - s; sum = p
  n = c / max; s = n * n - comp; p = sum + s; comp = p - sum - s; sum = p
  n = d / max; s = n * n - comp; p = sum + s; comp = p - sum - s; sum = p
  return Math.sqrt(sum) * max
}
const PATH_NONE = 0
const PATH_TRANSLATION = 1
const PATH_ROTATION = 2
const PATH_SCALE = 3
const PATH_WEIGHTS = 4

function pathCode(path) {
  if (path === "translation") return PATH_TRANSLATION
  if (path === "rotation") return PATH_ROTATION
  if (path === "scale") return PATH_SCALE
  if (path === "weights") return PATH_WEIGHTS
  return PATH_NONE
}

/**
 * Per-animation target table, cached on the (shared) animation object:
 * node index and path code per channel. `nodeIndexOf` maps the node objects
 * the channels reference to their index in the node list.
 */
function prepareAnimation(anim, nodeIndexOf) {
  if (anim._targetIdx) return anim
  const n = anim.channels.length
  const idx = new Int32Array(n)
  const codes = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const c = anim.channels[i]
    const node = c.target.node
    const k = node ? nodeIndexOf.get(node) : undefined
    idx[i] = k === undefined ? -1 : k
    codes[i] = idx[i] < 0 ? PATH_NONE : pathCode(c.target.path)
  }
  anim._targetIdx = idx
  anim._pathCodes = codes
  return anim
}

/** Fill `trs` from a node list (skinned nodes get identity rotation). */
function initTRS(trs, nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const o = i * TRS_STRIDE
    const t = n.translation || [0, 0, 0]
    const r = n.skin ? [0, 0, 0, 1] : n.rotation || [0, 0, 0, 1]
    const s = n.scale || [1, 1, 1]
    trs[o] = t[0]; trs[o + 1] = t[1]; trs[o + 2] = t[2]
    trs[o + 3] = r[0]; trs[o + 4] = r[1]; trs[o + 5] = r[2]; trs[o + 6] = r[3]
    trs[o + 7] = s[0]; trs[o + 8] = s[1]; trs[o + 9] = s[2]
  }
  return trs
}

/** Per-instance sampler state. `animations` is the shared animation list. */
function createSamplerState(animations) {
  let maxChannels = 0
  for (const a of animations || []) if (a.channels.length > maxChannels) maxChannels = a.channels.length
  const mkSnap = () => ({ count: 0, path: new Uint8Array(maxChannels), vals: new Float32Array(maxChannels * 4) })
  return {
    blendState: "init",
    blendTime: 0,
    lastIndex: 0,
    lastTargetIndex: 0,
    snaps: [mkSnap(), mkSnap()],
    blendSnap: null,
    cursors: new Map(),
  }
}

function lerp3(out, o, arr, i0, i1, t) {
  out[o] = arr[i0] + t * (arr[i1] - arr[i0])
  out[o + 1] = arr[i0 + 1] + t * (arr[i1 + 1] - arr[i0 + 1])
  out[o + 2] = arr[i0 + 2] + t * (arr[i1 + 2] - arr[i0 + 2])
}

// glMatrix quat.slerp, reading both endpoints straight out of the flat array.
function slerp4(out, o, arr, i0, i1, t) {
  const ax = arr[i0], ay = arr[i0 + 1], az = arr[i0 + 2], aw = arr[i0 + 3]
  let bx = arr[i1], by = arr[i1 + 1], bz = arr[i1 + 2], bw = arr[i1 + 3]
  let cosom = ax * bx + ay * by + az * bz + aw * bw
  if (cosom < 0) {
    cosom = -cosom
    bx = -bx; by = -by; bz = -bz; bw = -bw
  }
  let scale0, scale1
  if (1 - cosom > 0.000001) {
    const omega = Math.acos(cosom)
    const sinom = Math.sin(omega)
    scale0 = Math.sin((1 - t) * omega) / sinom
    scale1 = Math.sin(t * omega) / sinom
  } else {
    scale0 = 1 - t
    scale1 = t
  }
  out[o] = scale0 * ax + scale1 * bx
  out[o + 1] = scale0 * ay + scale1 * by
  out[o + 2] = scale0 * az + scale1 * bz
  out[o + 3] = scale0 * aw + scale1 * bw
}

// Same shapes, blending the value already in out[o..] FROM a snapshot value.
function lerp3From(out, o, snap, s, t) {
  out[o] = snap[s] + t * (out[o] - snap[s])
  out[o + 1] = snap[s + 1] + t * (out[o + 1] - snap[s + 1])
  out[o + 2] = snap[s + 2] + t * (out[o + 2] - snap[s + 2])
}
function slerp4From(out, o, snap, s, t) {
  const ax = snap[s], ay = snap[s + 1], az = snap[s + 2], aw = snap[s + 3]
  let bx = out[o], by = out[o + 1], bz = out[o + 2], bw = out[o + 3]
  let cosom = ax * bx + ay * by + az * bz + aw * bw
  if (cosom < 0) {
    cosom = -cosom
    bx = -bx; by = -by; bz = -bz; bw = -bw
  }
  let scale0, scale1
  if (1 - cosom > 0.000001) {
    const omega = Math.acos(cosom)
    const sinom = Math.sin(omega)
    scale0 = Math.sin((1 - t) * omega) / sinom
    scale1 = Math.sin(t * omega) / sinom
  } else {
    scale0 = 1 - t
    scale1 = t
  }
  out[o] = scale0 * ax + scale1 * bx
  out[o + 1] = scale0 * ay + scale1 * by
  out[o + 2] = scale0 * az + scale1 * bz
  out[o + 3] = scale0 * aw + scale1 * bw
}

function findKeyframe(times, t, cursor) {
  const last = times.length - 2
  let t0 = cursor
  if (t0 < 0) t0 = 0
  if (t0 > last) t0 = last
  if (t < times[t0]) {
    // Seek backwards (loop wrap, animation change): binary search.
    let lo = 0
    let hi = t0
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (times[mid] <= t) lo = mid
      else hi = mid - 1
    }
    t0 = lo
  } else {
    while (t0 < last && t > times[t0 + 1]) t0++
  }
  return t0
}

// ---- Blend weights (script API setAnimationBlendWeights). KEEP IN SYNC: gltfWorker.js / gltfModelW.js ----
// Blend tree support: several clips with the SAME channel layout are sampled at the playing clip's phase
// (normalized time) and mixed by weight, replacing the playing clip's value; the crossfade between animations
// and the snapshot for the next crossfade then see the mixed pose. mix = { count, anims, idx, w } (w normalized).
const MIX_TMP = new Float32Array(4)
const MIX_ACC = new Float64Array(4)
// Returns true when the mix wrote the channel (some clip has it), false when it left the playing clip's value.
function mixChannel(state, mix, i, code, nodeIdx, phase, trs, o) {
  const acc = MIX_ACC
  acc[0] = acc[1] = acc[2] = acc[3] = 0
  let wsum = 0, refSet = false, rx = 0, ry = 0, rz = 0, rw = 1
  for (let k = 0; k < mix.count; k++) {
    const a = mix.anims[k], w = mix.w[k]
    if (!a || !(w > 0)) continue
    const ch = a.channels[i]
    if (!ch || !a._targetIdx || a._targetIdx[i] !== nodeIdx || a._pathCodes[i] !== code) continue
    const input = ch.sampler.input, kMin = input.min[0], kMax = input.max[0], times = input.data
    const out = ch.sampler.output.data
    let k0 = 0, k1 = 0, f = 0
    if (kMax > kMin && times.length > 1) {
      const tk = kMin + (mix.ph && mix.ph[k] === mix.ph[k] ? mix.ph[k] : phase) * (kMax - kMin)
      const cur = mix.cur[k] // (state.cursors' array for this clip, looked up once per sample: sampleAnimation)
      k0 = findKeyframe(times, tk, cur[i])
      cur[i] = k0
      k1 = k0 + 1
      const span = times[k1] - times[k0]
      f = span > 0 ? (tk - times[k0]) / span : 0
    }
    if (code === PATH_ROTATION) {
      slerp4(MIX_TMP, 0, out, k0 * 4, k1 * 4, f)
      if (!refSet) { rx = MIX_TMP[0]; ry = MIX_TMP[1]; rz = MIX_TMP[2]; rw = MIX_TMP[3]; refSet = true }
      const s = rx * MIX_TMP[0] + ry * MIX_TMP[1] + rz * MIX_TMP[2] + rw * MIX_TMP[3] < 0 ? -w : w
      acc[0] += MIX_TMP[0] * s; acc[1] += MIX_TMP[1] * s; acc[2] += MIX_TMP[2] * s; acc[3] += MIX_TMP[3] * s
    } else {
      lerp3(MIX_TMP, 0, out, k0 * 3, k1 * 3, f)
      acc[0] += MIX_TMP[0] * w; acc[1] += MIX_TMP[1] * w; acc[2] += MIX_TMP[2] * w
    }
    wsum += w
  }
  if (!(wsum > 0)) return false
  if (code === PATH_ROTATION) {
    const l = hypot4(acc[0], acc[1], acc[2], acc[3]) || 1
    trs[o] = acc[0] / l; trs[o + 1] = acc[1] / l; trs[o + 2] = acc[2] / l; trs[o + 3] = acc[3] / l
  } else {
    trs[o] = acc[0] / wsum; trs[o + 1] = acc[1] / wsum; trs[o + 2] = acc[2] / wsum
  }
  return true
}

/**
 * Sample `anim` (prepared with prepareAnimation) at `time` into `trs`, with
 * the blend state machine and cross-animation blending of the original
 * implementation. Morph-target weight channels are ignored: the worker path
 * never rendered morphs.
 */
// mask (optional, main thread only): channels with mask[i] 0 are left alone (bones nothing reads there; the worker
// samples every channel for drawing)
function sampleAnimation(state, anim, index, time, deltaTime, animationBlend, animationLoop, trs, mix, mask) {
  // Blend state machine
  switch (state.blendState) {
    case "init":
      if (animationBlend != 0 && state.lastIndex != index) {
        state.blendState = "blend"
        state.blendTime = 0
        state.blendSnap = state.snaps[state.lastTargetIndex]
        state.lastTargetIndex = state.lastTargetIndex == 0 ? 1 : 0
        state.lastIndex = index
      }
      break
    case "blend":
      if (state.lastIndex != index) {
        state.blendTime = 0
        state.blendSnap = state.snaps[state.lastTargetIndex]
        state.lastTargetIndex = state.lastTargetIndex == 0 ? 1 : 0
        state.lastIndex = index
        break
      }
      if (state.blendTime > animationBlend) {
        state.blendState = "idle"
        break
      }
      state.blendTime += deltaTime
      break
    case "idle":
      if (state.lastIndex != index) {
        state.blendState = "blend"
        state.blendTime = 0
        state.blendSnap = state.snaps[state.lastTargetIndex]
        state.lastTargetIndex = state.lastTargetIndex == 0 ? 1 : 0
        state.lastIndex = index
      }
      break
    default:
      state.blendState = "init"
  }

  const channels = anim.channels
  const n = channels.length
  const targetIdx = anim._targetIdx
  const codes = anim._pathCodes
  let cursors = state.cursors.get(index)
  if (!cursors) {
    cursors = new Int32Array(n)
    state.cursors.set(index, cursors)
  }

  // the mix clips' cursor arrays (shared with the clip's own when it plays: one per animation index)
  const mixing = !!(mix && mix.count)
  if (mixing) {
    const cur = mix.cur || (mix.cur = [])
    for (let k = 0; k < mix.count; k++) {
      const a = mix.anims[k]
      if (!a || !(mix.w[k] > 0)) { cur[k] = null; continue }
      let c = state.cursors.get(mix.idx[k])
      if (!c) { c = new Int32Array(a.channels.length); state.cursors.set(mix.idx[k], c) }
      cur[k] = c
    }
  }

  const blending = state.blendState === "blend" && state.blendSnap
  const blendSnap = blending ? state.blendSnap : null
  let blend = 0
  if (blending) {
    blend = state.blendTime == 0 ? 0 : state.blendTime / animationBlend
    if (blend > 1) blend = 1
    // eased in and out: no sudden start or stop of the transition
    blend = blend * blend * (3 - 2 * blend)
  }
  const snapshot = animationBlend != 0 ? state.snaps[state.lastTargetIndex] : null
  if (snapshot) snapshot.count = n

  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue
    const code = codes[i]
    const c = channels[i]
    const input = c.sampler.input
    const tMin = input.min[0]
    const tMax = input.max[0]
    if (tMax == tMin || code === PATH_NONE || code === PATH_WEIGHTS) {
      if (snapshot) snapshot.path[i] = PATH_NONE
      continue
    }
    let t = time
    if (animationLoop) t = ((t - tMin) % (tMax - tMin)) + tMin
    else if (t > tMax) t = tMax - 0.01

    const times = input.data
    const t0 = findKeyframe(times, t, cursors[i])
    cursors[i] = t0
    const t1 = t0 + 1
    const base = targetIdx[i] * TRS_STRIDE
    const o = code === PATH_TRANSLATION ? base : code === PATH_ROTATION ? base + 3 : base + 7

    // the mix replaces the playing clip's value wherever one of its clips has the channel: the playing clip is
    // only interpolated where it doesn't (same result, a slerp less per channel)
    if (!(mixing && mixChannel(state, mix, i, code, targetIdx[i], (t - tMin) / (tMax - tMin), trs, o))) {
      const span = times[t1] - times[t0]
      const f = span > 0 ? (t - times[t0]) / span : 0
      const out = c.sampler.output.data
      if (code === PATH_ROTATION) slerp4(trs, o, out, t0 * 4, t1 * 4, f)
      else lerp3(trs, o, out, t0 * 3, t1 * 3, f)
    }

    if (blendSnap && i < blendSnap.count && blendSnap.path[i] === code) {
      const s = i * 4
      if (code === PATH_ROTATION) slerp4From(trs, o, blendSnap.vals, s, blend)
      else lerp3From(trs, o, blendSnap.vals, s, blend)
    }

    if (snapshot) {
      snapshot.path[i] = code
      const s = i * 4
      snapshot.vals[s] = trs[o]
      snapshot.vals[s + 1] = trs[o + 1]
      snapshot.vals[s + 2] = trs[o + 2]
      snapshot.vals[s + 3] = code === PATH_ROTATION ? trs[o + 3] : 0
    }
  }
}

/** Overall [min, max] time of an animation, cached on it. */
function animationTimeRange(anim) {
  if (anim._tRange) return anim._tRange
  let tMin = Infinity
  let tMax = -Infinity
  for (const c of anim.channels) {
    const input = c.sampler.input
    if (input.min[0] < tMin) tMin = input.min[0]
    if (input.max[0] > tMax) tMax = input.max[0]
  }
  anim._tRange = [tMin, tMax]
  return anim._tRange
}


const REQ_STRIDE = 8
const RB_MAX = 6 // drawn nodes per instance (setDrawnNodes): their model-space matrices go back with the pose

// ---- IK (script API setIKChain). KEEP IN SYNC: gltfWorker.js / gltfModelW.js ----
// Two-bone IK on the flat TRS array, after sampling and bone offsets: an upper, lower and end bone (thigh, shin,
// ankle), a target for the end, a bend pole, a weight, and an optional end alignment (a bone-local axis turned
// onto a direction: the sole onto the ground normal, the palm onto a wall). Model space throughout. Packed
// IK_STRIDE floats per chain: upper, lower, end, target xyz, pole xyz (NaN = keep the animated bend side),
// weight, end axis xyz (all 0 = no alignment), end direction xyz, end weight, second end axis xyz (all 0 = none),
// its direction xyz (the end twists about the first direction toward it), hinge axis xyz (a lower-bone-local axis
// the middle joint bends about, all 0 = none: the upper twists so the hinge lies across the solved bend),
// then the follow fields (>= 3.0.64; a chain set less often than every frame, e.g. spread over frames): anchor xyz
// (where the end's animated position was when the target was worked out), horizontal and vertical follow (0..1:
// how much of the animated end's move since then the target takes, split along up), up xyz (world up, model
// space), pole anchor xyz (the upper joint's animated position when the pole was worked out, NaN = none: the pole
// then keeps its offset from the upper joint).
const IK_STRIDE = 37
const IK_TRS = 10
const ikV = () => new Float64Array(3)
const ikQ = () => new Float64Array([0, 0, 0, 1])
const IK_TMP = { a2: [0, 0, 0], d2: [0, 0, 0], qt: [0, 0, 0, 1], pp: ikV(), rp: ikQ(), sp: ikV(), pa: ikV(), ra: ikQ(), sa: ikV(), pb: ikV(), rb: ikQ(), sb: ikV(),
  pc: ikV(), rc: ikQ(), sc: ikV(), q1: ikQ(), q2: ikQ(), q3: ikQ(), qi: ikQ(), u: ikV(), v: ikV(), w: ikV(), x: ikV(), h: ikV(), n: ikV(),
  lu: ikQ(), ll: ikQ(), le: ikQ(), su: ikQ(), sl: ikQ(), se: ikQ(), path: new Int32Array(64) }
function ikQuatMul(out, a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3]
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}
function ikQuatConj(out, q) { out[0] = -q[0]; out[1] = -q[1]; out[2] = -q[2]; out[3] = q[3]; return out }
function ikRotate(out, q, v) {
  const x = v[0], y = v[1], z = v[2], qx = q[0], qy = q[1], qz = q[2], qw = q[3]
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x)
  out[0] = x + qw * tx + qy * tz - qz * ty
  out[1] = y + qw * ty + qz * tx - qx * tz
  out[2] = z + qw * tz + qx * ty - qy * tx
  return out
}
function ikNorm(v) { const l = hypot3(v[0], v[1], v[2]); if (l > 1e-12) { v[0] /= l; v[1] /= l; v[2] /= l } return l }
function ikNormQ(q) { const l = hypot4(q[0], q[1], q[2], q[3]) || 1; q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l; return q }
// shortest rotation taking unit vector a onto unit vector b
function ikFromTo(out, a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  if (d < -0.999999) {
    // opposite: any perpendicular axis
    let x = 0, y = -a[2], z = a[1]
    if (Math.abs(a[0]) < 0.5) { x = 0; y = -a[2]; z = a[1] } else { x = -a[1]; y = a[0]; z = 0 }
    const l = hypot3(x, y, z) || 1
    out[0] = x / l; out[1] = y / l; out[2] = z / l; out[3] = 0
    return out
  }
  out[0] = a[1] * b[2] - a[2] * b[1]
  out[1] = a[2] * b[0] - a[0] * b[2]
  out[2] = a[0] * b[1] - a[1] * b[0]
  out[3] = 1 + d
  return ikNormQ(out)
}
function ikSlerp(out, a, b, t) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3]
  let c = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw
  if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw }
  let s0 = 1 - t, s1 = t
  if (1 - c > 1e-6) { const o = Math.acos(c), so = Math.sin(o); s0 = Math.sin((1 - t) * o) / so; s1 = Math.sin(t * o) / so }
  out[0] = s0 * a[0] + s1 * bx; out[1] = s0 * a[1] + s1 * by; out[2] = s0 * a[2] + s1 * bz; out[3] = s0 * a[3] + s1 * bw
  return ikNormQ(out)
}
// World (model space) position / rotation / scale of node i, composed from the root (no shear, like the rig).
function ikWorld(trs, parentIdx, i, pos, rot, scl) {
  pos[0] = pos[1] = pos[2] = 0; rot[0] = rot[1] = rot[2] = 0; rot[3] = 1; scl[0] = scl[1] = scl[2] = 1
  if (i < 0) return
  const path = IK_TMP.path
  let n = 0
  for (let k = i; k >= 0 && n < path.length; k = parentIdx[k]) path[n++] = k
  const t = IK_TMP.x, q = IK_TMP.qi
  for (let j = n - 1; j >= 0; j--) {
    const o = path[j] * IK_TRS
    t[0] = trs[o] * scl[0]; t[1] = trs[o + 1] * scl[1]; t[2] = trs[o + 2] * scl[2]
    ikRotate(t, rot, t)
    pos[0] += t[0]; pos[1] += t[1]; pos[2] += t[2]
    q[0] = trs[o + 3]; q[1] = trs[o + 4]; q[2] = trs[o + 5]; q[3] = trs[o + 6]
    ikQuatMul(rot, rot, q)
    scl[0] *= trs[o + 7]; scl[1] *= trs[o + 8]; scl[2] *= trs[o + 9]
  }
  ikNormQ(rot)
}
const ikGetQ = (trs, i, q) => { const o = i * IK_TRS + 3; q[0] = trs[o]; q[1] = trs[o + 1]; q[2] = trs[o + 2]; q[3] = trs[o + 3]; return q }
const ikSetQ = (trs, i, q) => { const o = i * IK_TRS + 3; trs[o] = q[0]; trs[o + 1] = q[1]; trs[o + 2] = q[2]; trs[o + 3] = q[3] }
// local rotation that gives `world` under a parent whose world rotation is `parentRot`: inv(parentRot) * world
function ikLocal(out, parentRot, world) { return ikNormQ(ikQuatMul(out, ikQuatConj(IK_TMP.q3, parentRot), world)) }

/**
 * Solve `count` chains packed at data[at..] into trs. `saved` (Map node -> [x, y, z, w]) keeps the rotations it
 * overwrote, so a pose that isn't resampled (paused model) can be restored first (ikRestore). `info` (optional,
 * 4 floats per chain): the animated end position before IK (model space) and how far the target was (1 = at
 * full reach).
 */
function applyIK(trs, parentIdx, data, at, count, saved, info) {
  const T = IK_TMP
  for (let c = 0; c < count; c++) {
    const o = at + c * IK_STRIDE
    const iu = data[o], il = data[o + 1], ie = data[o + 2], weight = data[o + 9]
    ikWorld(trs, parentIdx, ie, T.pc, T.rc, T.sc)
    // info (main thread): the end and the middle joint where the animation puts them, and the reach
    if (info) {
      info[c * 7] = T.pc[0]; info[c * 7 + 1] = T.pc[1]; info[c * 7 + 2] = T.pc[2]; info[c * 7 + 3] = 0
      if (il >= 0) { ikWorld(trs, parentIdx, il, T.pb, T.rb, T.sb); info[c * 7 + 4] = T.pb[0]; info[c * 7 + 5] = T.pb[1]; info[c * 7 + 6] = T.pb[2] }
    }
    if (!(weight > 0) || iu < 0 || il < 0 || ie < 0) continue
    if (saved) { ikSave(saved, trs, iu); ikSave(saved, trs, il); ikSave(saved, trs, ie) }
    ikGetQ(trs, iu, T.lu); ikGetQ(trs, il, T.ll); ikGetQ(trs, ie, T.le)
    ikWorld(trs, parentIdx, parentIdx[iu], T.pp, T.rp, T.sp)
    ikWorld(trs, parentIdx, iu, T.pa, T.ra, T.sa)
    ikWorld(trs, parentIdx, il, T.pb, T.rb, T.sb)
    const A = T.pa, B = T.pb, C = T.pc
    const l1 = hypot3(B[0] - A[0], B[1] - A[1], B[2] - A[2]), l2 = hypot3(C[0] - B[0], C[1] - B[1], C[2] - B[2])
    const u = T.u
    // the target, moved by the follow share of how far the animated end (C) went since the anchor
    let tx = data[o + 3], ty = data[o + 4], tz = data[o + 5]
    const fh = data[o + 29], fv = data[o + 30]
    if (fh || fv) {
      const dx = C[0] - data[o + 26], dy = C[1] - data[o + 27], dz = C[2] - data[o + 28]
      const ux = data[o + 31], uy = data[o + 32], uz = data[o + 33]
      const dv = dx * ux + dy * uy + dz * uz
      tx += fh * (dx - dv * ux) + fv * dv * ux
      ty += fh * (dy - dv * uy) + fv * dv * uy
      tz += fh * (dz - dv * uz) + fv * dv * uz
    }
    u[0] = tx - A[0]; u[1] = ty - A[1]; u[2] = tz - A[2]
    let d = ikNorm(u)
    if (info) info[c * 7 + 3] = d / (l1 + l2 || 1)
    if (d < 1e-9 || l1 < 1e-9 || l2 < 1e-9) continue
    d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-6), (l1 + l2) * 0.9999)
    // bend side: toward the pole, else where the animated knee already points
    const v = T.v
    if (Number.isNaN(data[o + 6])) { v[0] = B[0] - A[0]; v[1] = B[1] - A[1]; v[2] = B[2] - A[2] }
    else if (data[o + 34] === data[o + 34]) { v[0] = data[o + 6] - data[o + 34]; v[1] = data[o + 7] - data[o + 35]; v[2] = data[o + 8] - data[o + 36] } // (pole - anchor: as far from the upper joint as it was)
    else { v[0] = data[o + 6] - A[0]; v[1] = data[o + 7] - A[1]; v[2] = data[o + 8] - A[2] }
    let k = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]
    v[0] -= u[0] * k; v[1] -= u[1] * k; v[2] -= u[2] * k
    if (ikNorm(v) < 1e-6) { ikRotate(v, T.ra, [1, 0, 0]); k = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]; v[0] -= u[0] * k; v[1] -= u[1] * k; v[2] -= u[2] * k; ikNorm(v) }
    const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))), sinA = Math.sqrt(1 - cosA * cosA)
    // upper: its child (the lower bone) moves to the new knee
    const from = T.w, to = T.x
    from[0] = B[0] - A[0]; from[1] = B[1] - A[1]; from[2] = B[2] - A[2]; ikNorm(from)
    to[0] = u[0] * cosA + v[0] * sinA; to[1] = u[1] * cosA + v[1] * sinA; to[2] = u[2] * cosA + v[2] * sinA; ikNorm(to)
    ikFromTo(T.q1, from, to)
    // a hinge (elbow, knee): the swing above carries the ANIMATED hinge along, so a bend plane far from the
    // animation's made the lower bone turn sideways about the joint (an elbow bent the wrong way, a twisted
    // forearm, flipping when the animation's arm changed). Twist the upper about its new direction so the hinge
    // lies across the solved bend: the lower then only turns about it
    if (data[o + 23] || data[o + 24] || data[o + 25]) {
      const h = T.h, n = T.n
      h[0] = data[o + 23]; h[1] = data[o + 24]; h[2] = data[o + 25]
      ikRotate(h, T.rb, h)
      ikRotate(h, T.q1, h)
      // the solved bend's axis: upper direction x lower direction (from the new joint to the target)
      const jx = A[0] + to[0] * l1, jy = A[1] + to[1] * l1, jz = A[2] + to[2] * l1
      const lx = A[0] + u[0] * d - jx, ly = A[1] + u[1] * d - jy, lz = A[2] + u[2] * d - jz
      n[0] = to[1] * lz - to[2] * ly; n[1] = to[2] * lx - to[0] * lz; n[2] = to[0] * ly - to[1] * lx
      const kh = h[0] * to[0] + h[1] * to[1] + h[2] * to[2]
      h[0] -= to[0] * kh; h[1] -= to[1] * kh; h[2] -= to[2] * kh
      if (ikNorm(n) > 1e-6 && ikNorm(h) > 1e-6) {
        if (h[0] * n[0] + h[1] * n[1] + h[2] * n[2] < -0.9999) {
          T.qt[0] = to[0]; T.qt[1] = to[1]; T.qt[2] = to[2]; T.qt[3] = 0 // half a turn about the upper
        } else ikFromTo(T.qt, h, n)
        ikQuatMul(T.q1, T.qt, T.q1)
      }
    }
    ikQuatMul(T.q2, T.q1, T.ra)                      // new upper world rotation
    ikLocal(T.su, T.rp, T.q2)
    ikSetQ(trs, iu, T.su)
    // lower: the end moves onto the target
    ikWorld(trs, parentIdx, il, T.pb, T.rb, T.sb)
    ikWorld(trs, parentIdx, ie, T.pc, T.rc, T.sc)
    from[0] = T.pc[0] - T.pb[0]; from[1] = T.pc[1] - T.pb[1]; from[2] = T.pc[2] - T.pb[2]; ikNorm(from)
    to[0] = A[0] + u[0] * d - T.pb[0]; to[1] = A[1] + u[1] * d - T.pb[1]; to[2] = A[2] + u[2] * d - T.pb[2]; ikNorm(to)
    ikFromTo(T.q1, from, to)
    ikQuatMul(T.q2, T.q1, T.rb)
    ikWorld(trs, parentIdx, iu, T.pa, T.ra, T.sa)
    ikLocal(T.sl, T.ra, T.q2)
    ikSetQ(trs, il, T.sl)
    // end: turn a bone-local axis onto a direction
    const ew = data[o + 16]
    T.se[0] = T.le[0]; T.se[1] = T.le[1]; T.se[2] = T.le[2]; T.se[3] = T.le[3]
    if (ew > 0 && (data[o + 10] || data[o + 11] || data[o + 12])) {
      ikWorld(trs, parentIdx, il, T.pb, T.rb, T.sb)
      ikWorld(trs, parentIdx, ie, T.pc, T.rc, T.sc)
      from[0] = data[o + 10]; from[1] = data[o + 11]; from[2] = data[o + 12]; ikNorm(from)
      ikRotate(from, T.rc, from)
      to[0] = data[o + 13]; to[1] = data[o + 14]; to[2] = data[o + 15]
      if (ikNorm(to) > 1e-9) {
        ikFromTo(T.q1, from, to)
        ikQuatMul(T.q2, T.q1, T.rc)
        // a second axis: twist about the first direction so it points as close as it can to its own direction
        // (the palm on a wall, the fingers up: the animation can't spin the hand about the palm any more)
        if (data[o + 17] || data[o + 18] || data[o + 19]) {
          const a2 = T.a2, d2 = T.d2
          a2[0] = data[o + 17]; a2[1] = data[o + 18]; a2[2] = data[o + 19]; ikNorm(a2)
          ikRotate(a2, T.q2, a2)
          d2[0] = data[o + 20]; d2[1] = data[o + 21]; d2[2] = data[o + 22]
          let k2 = a2[0] * to[0] + a2[1] * to[1] + a2[2] * to[2]
          a2[0] -= to[0] * k2; a2[1] -= to[1] * k2; a2[2] -= to[2] * k2
          k2 = d2[0] * to[0] + d2[1] * to[1] + d2[2] * to[2]
          d2[0] -= to[0] * k2; d2[1] -= to[1] * k2; d2[2] -= to[2] * k2
          if (ikNorm(a2) > 1e-6 && ikNorm(d2) > 1e-6) {
            if (a2[0] * d2[0] + a2[1] * d2[1] + a2[2] * d2[2] < -0.9999) {
              T.qt[0] = to[0]; T.qt[1] = to[1]; T.qt[2] = to[2]; T.qt[3] = 0 // half a turn about the first direction
            } else ikFromTo(T.qt, a2, d2)
            ikQuatMul(T.q2, T.qt, T.q2)
          }
        }
        ikLocal(T.q1, T.rb, T.q2)
        ikSlerp(T.se, T.le, T.q1, Math.min(1, ew))
      }
    }
    // weight: between the animated and the solved pose
    if (weight < 1) {
      ikSlerp(T.su, T.lu, T.su, weight); ikSlerp(T.sl, T.ll, T.sl, weight); ikSlerp(T.se, T.le, T.se, weight)
      ikSetQ(trs, iu, T.su); ikSetQ(trs, il, T.sl)
    }
    ikSetQ(trs, ie, T.se)
  }
}
function ikSave(saved, trs, n) {
  if (saved.has(n)) return
  const q = ikGetQ(trs, n, IK_TMP.qi)
  saved.set(n, [q[0], q[1], q[2], q[3]])
}
/** Put back the rotations applyIK overwrote (before solving again on a pose that wasn't resampled). */
function ikRestore(trs, saved) {
  for (const [n, q] of saved) ikSetQ(trs, n, q)
  saved.clear()
}

// ---- Jiggle bones (script API setJiggleBone). KEEP IN SYNC: v1 / v2 workers ----
// A spring per bone: its tip (`length` model units out along `axis`, bone-local, default +Y: the way the part it
// moves points) is pulled toward where the animation puts it (`stiffness`, `damping` against the tip's speed relative
// to it, `drag` against its speed in the world), simulated in world space so the model's moves and turns swing it;
// the bone then turns to point at the simulated tip, at most `maxAngle` away from its animated direction. `gravity`
// (px/s^2, 0 = none) pulls the tip down in the world. `anchor` (a node, -1 = none): the rest direction follows that
// node instead of the bone's parent, keeping a fixed rotation to it: `anchorPose` (the bone's model-space rotation
// relative to the anchor's, x y z w; NaN = the bind pose's) turned by `anchorTilt` (rad, about the bone's own axes,
// gl-matrix fromEuler order), `anchorWeight` of the way (0..1): a sword on the thigh that should hang from the hips.
// `limitAxis` (parent-local, all 0 = none) + `limitAngle` (rad): the tip goes at most that far toward the axis from
// its rest direction without the animation (the bind pose under the parent, or the anchored one): the body under a
// cape; clips that swing the bone further in are held too: 0 = never closer to the body than that, < 0 = held off
// it, > 0 = allowed in. Packed per slot: [n, then if n: dt, model matrix (16, model -> world), (node, stiffness,
// damping, max angle (rad), length, gravity, axis xyz, anchor, anchor weight, anchor pose xyzw, anchor tilt xyz (rad),
// limit axis xyz, limit angle (rad), drag) * n].
const JIG_STRIDE = 23
const JIG_TMP = { p: ikV(), r: ikQ(), s: ikV(), pp: ikV(), pr: ikQ(), ps: ikV(), a: [0, 0, 0], q: [0, 0, 0, 1], q2: [0, 0, 0, 1], l: [0, 0, 0, 1], inv: new Float64Array(16), f: [0, 0, 0], t: [0, 0, 0],
  ap: ikV(), ar: ikQ(), as: ikV(), ra: ikQ(), rel: ikQ(), tilt: ikQ(), ax: [0, 1, 0], vt: [0, 0, 0], n: [0, 0, 0], m: [0, 0, 0] }
function jigXf(m, x, y, z, out) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12]
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13]
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14]
  return out
}
// inverse of an affine 4x4 (column-major); false when singular
function jigInvert(out, m) {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], k = m[10]
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return false
  const id = 1 / det
  out[0] = A * id; out[1] = -(b * k - c * h) * id; out[2] = (b * f - c * e) * id; out[3] = 0
  out[4] = B * id; out[5] = (a * k - c * g) * id; out[6] = -(a * f - c * d) * id; out[7] = 0
  out[8] = C * id; out[9] = -(a * h - b * g) * id; out[10] = (a * e - b * d) * id; out[11] = 0
  const tx = m[12], ty = m[13], tz = m[14]
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz)
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz)
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz)
  out[15] = 1
  return true
}
// the bone's bind-pose world rotation relative to the anchor's: inv(anchor rest) * bone rest (cached per pair)
function jigAnchorRel(rec, parentIdx, baseTRS, i, an) {
  const cache = rec.jigRel || (rec.jigRel = new Map())
  const key = i * 4096 + an
  let q = cache.get(key)
  if (!q) {
    const T = JIG_TMP
    q = ikQ()
    ikWorld(baseTRS, parentIdx, an, T.ap, T.ar, T.as)
    ikWorld(baseTRS, parentIdx, i, T.pp, T.pr, T.ps)
    ikLocal(q, T.ar, T.pr)
    cache.set(key, q)
  }
  return q
}
function applyJiggle(rec, parentIdx, data, at, count, saved, baseTRS) {
  const T = JIG_TMP
  const dt = Math.min(0.05, Math.max(0, data[at] || 0))
  const M = data.subarray(at + 1, at + 17)
  if (!jigInvert(T.inv, M)) return
  const st = rec.jig || (rec.jig = new Map())
  const steps = Math.max(1, Math.ceil(dt * 120)), h = dt / steps
  const Bw = [0, 0, 0], Tw = [0, 0, 0], pm = [0, 0, 0]
  for (let c = 0; c < count; c++) {
    const o = at + 17 + c * JIG_STRIDE
    const i = data[o], k = data[o + 1], damp = data[o + 2], maxA = data[o + 3], len = data[o + 4], grav = data[o + 5] || 0
    const ax = T.ax
    ax[0] = data[o + 6] || 0; ax[1] = data[o + 7] || 0; ax[2] = data[o + 8] || 0
    if (ikNorm(ax) < 1e-9) { ax[0] = 0; ax[1] = 1; ax[2] = 0 }
    const an = data[o + 9], aw = Math.min(1, Math.max(0, data[o + 10] || 0)), lx = data[o + 18] || 0, ly = data[o + 19] || 0, lz = data[o + 20] || 0, limA = data[o + 21] || 0, drag = Math.max(0, data[o + 22] || 0)
    if (!(i >= 0)) continue
    if (saved && !saved.has(i)) saved.set(i, Array.from(ikGetQ(rec.trs, i, T.q)))
    ikWorld(rec.trs, parentIdx, i, T.p, T.r, T.s)
    // the rest direction: the animated one, or (part of the way) the one that keeps the bind-pose angle to the anchor
    if (an >= 0 && an !== i && aw > 0 && baseTRS) {
      ikWorld(rec.trs, parentIdx, an, T.ap, T.ar, T.as)
      const rel = T.rel
      if (Number.isFinite(data[o + 11]) && Number.isFinite(data[o + 14])) { rel[0] = data[o + 11]; rel[1] = data[o + 12]; rel[2] = data[o + 13]; rel[3] = data[o + 14]; ikNormQ(rel) }
      else { const b = jigAnchorRel(rec, parentIdx, baseTRS, i, an); rel[0] = b[0]; rel[1] = b[1]; rel[2] = b[2]; rel[3] = b[3] }
      const ex = (data[o + 15] || 0) / 2, ey = (data[o + 16] || 0) / 2, ez = (data[o + 17] || 0) / 2
      if (ex || ey || ez) { // gl-matrix quat.fromEuler (like setBoneRotationOffset)
        const sx = Math.sin(ex), cx = Math.cos(ex), sy = Math.sin(ey), cy = Math.cos(ey), sz = Math.sin(ez), cz = Math.cos(ez), q = T.tilt
        q[0] = sx * cy * cz - cx * sy * sz; q[1] = cx * sy * cz + sx * cy * sz; q[2] = cx * cy * sz - sx * sy * cz; q[3] = cx * cy * cz + sx * sy * sz
        ikQuatMul(rel, rel, q)
      }
      ikQuatMul(T.ra, T.ar, rel)
      ikSlerp(T.r, T.r, T.ra, aw)
    }
    T.a[0] = ax[0] * len; T.a[1] = ax[1] * len; T.a[2] = ax[2] * len
    ikRotate(T.a, T.r, T.a)
    const tx = T.p[0] + T.a[0], ty = T.p[1] + T.a[1], tz = T.p[2] + T.a[2] // the rest tip (model space)
    jigXf(M, T.p[0], T.p[1], T.p[2], Bw)
    jigXf(M, tx, ty, tz, Tw)
    const Lw = hypot3(Tw[0] - Bw[0], Tw[1] - Bw[1], Tw[2] - Bw[2]) || 1
    let s = st.get(i)
    if (!s || hypot3(s.p[0] - Tw[0], s.p[1] - Tw[1], s.p[2] - Tw[2]) > Lw * 4) { s = { p: Tw.slice(), v: [0, 0, 0], t: Tw.slice() }; st.set(i, s) }
    // the rest tip moves from last frame's to this one's over the substeps; damping slows the tip relative to it,
    // drag slows it in the world (air: a coat streams back while running)
    const st0 = s.t, ivt = dt > 0 ? 1 / dt : 0, vt = T.vt
    for (let x = 0; x < 3; x++) vt[x] = (Tw[x] - st0[x]) * ivt // the rest tip's velocity
    for (let n = 0; n < steps; n++) {
      const u = n / steps // (the rest tip at the substep's start: semi-implicit Euler, no lag at a steady speed)
      for (let x = 0; x < 3; x++) {
        const tgt = st0[x] + (Tw[x] - st0[x]) * u
        s.v[x] += (k * (tgt - s.p[x]) - damp * (s.v[x] - vt[x]) - drag * s.v[x] - (x === 2 ? grav : 0)) * h // world z is up
        s.p[x] += s.v[x] * h
      }
    }
    st0[0] = Tw[0]; st0[1] = Tw[1]; st0[2] = Tw[2]
    // the bone keeps its length, and stays within maxAngle of its rest direction
    const r0 = [(Tw[0] - Bw[0]) / Lw, (Tw[1] - Bw[1]) / Lw, (Tw[2] - Bw[2]) / Lw]
    const d = [s.p[0] - Bw[0], s.p[1] - Bw[1], s.p[2] - Bw[2]]
    ikNorm(d)
    const cosA = r0[0] * d[0] + r0[1] * d[1] + r0[2] * d[2]
    if (cosA < Math.cos(maxA)) {
      const pp = [d[0] - r0[0] * cosA, d[1] - r0[1] * cosA, d[2] - r0[2] * cosA]
      if (ikNorm(pp) > 1e-9) for (let x = 0; x < 3; x++) d[x] = r0[x] * Math.cos(maxA) + pp[x] * Math.sin(maxA)
      // half the speed relative to the rest tip (not in the world: a model moving fast held the tip at the limit)
      for (let x = 0; x < 3; x++) s.v[x] = vt[x] + (s.v[x] - vt[x]) * 0.5
    }
    // one-sided limit: toward the limit axis (the body), at most limitAngle from the rest direction without the
    // animation: the bind pose under the parent (or the anchored one, as far as anchored)
    if (lx || ly || lz) {
      const n = T.n, m = T.m, b0 = T.f
      ikWorld(rec.trs, parentIdx, parentIdx[i], T.pp, T.pr, T.ps)
      ikQuatMul(T.q2, T.pr, ikGetQ(baseTRS || rec.trs, i, T.q)) // the bone's bind rotation under its parent
      if (an >= 0 && an !== i && aw > 0 && baseTRS) ikSlerp(T.q2, T.q2, T.ra, aw)
      T.a[0] = ax[0]; T.a[1] = ax[1]; T.a[2] = ax[2]
      ikRotate(b0, T.q2, T.a)
      n[0] = lx; n[1] = ly; n[2] = lz
      ikRotate(n, T.pr, n)
      const bx = M[0] * b0[0] + M[4] * b0[1] + M[8] * b0[2], by = M[1] * b0[0] + M[5] * b0[1] + M[9] * b0[2], bz = M[2] * b0[0] + M[6] * b0[1] + M[10] * b0[2]
      const nx = M[0] * n[0] + M[4] * n[1] + M[8] * n[2], ny = M[1] * n[0] + M[5] * n[1] + M[9] * n[2], nz = M[2] * n[0] + M[6] * n[1] + M[10] * n[2]
      b0[0] = bx; b0[1] = by; b0[2] = bz
      ikNorm(b0)
      const nb = nx * b0[0] + ny * b0[1] + nz * b0[2]
      n[0] = nx - b0[0] * nb; n[1] = ny - b0[1] * nb; n[2] = nz - b0[2] * nb // across the bind direction
      if (ikNorm(n) > 1e-9) {
        const ca = d[0] * b0[0] + d[1] * b0[1] + d[2] * b0[2], sa = d[0] * n[0] + d[1] * n[1] + d[2] * n[2]
        if (Math.atan2(sa, ca) > limA) {
          // keep the sideways part, put the in/out part on the limit
          m[0] = b0[1] * n[2] - b0[2] * n[1]; m[1] = b0[2] * n[0] - b0[0] * n[2]; m[2] = b0[0] * n[1] - b0[1] * n[0]
          const cm = d[0] * m[0] + d[1] * m[1] + d[2] * m[2], rho = Math.sqrt(Math.max(0, 1 - cm * cm))
          const c2 = rho * Math.cos(limA), s2 = rho * Math.sin(limA)
          for (let x = 0; x < 3; x++) d[x] = b0[x] * c2 + n[x] * s2 + m[x] * cm
          // no speed into the body relative to the rest tip
          const vin = (s.v[0] - vt[0]) * n[0] + (s.v[1] - vt[1]) * n[1] + (s.v[2] - vt[2]) * n[2]
          if (vin > 0) for (let x = 0; x < 3; x++) s.v[x] -= n[x] * vin
        }
      }
    }
    for (let x = 0; x < 3; x++) s.p[x] = Bw[x] + d[x] * Lw
    // back in model space: turn the bone from its animated tip toward the simulated one
    jigXf(T.inv, s.p[0], s.p[1], s.p[2], pm)
    ikWorld(rec.trs, parentIdx, i, T.p, T.r, T.s) // the animated rotation (the anchor replaced it above)
    T.a[0] = ax[0] * len; T.a[1] = ax[1] * len; T.a[2] = ax[2] * len
    ikRotate(T.f, T.r, T.a)
    T.t[0] = pm[0] - T.p[0]; T.t[1] = pm[1] - T.p[1]; T.t[2] = pm[2] - T.p[2]
    if (ikNorm(T.f) < 1e-9 || ikNorm(T.t) < 1e-9) continue
    ikFromTo(T.q, T.f, T.t)
    ikQuatMul(T.q2, T.q, T.r)
    ikWorld(rec.trs, parentIdx, parentIdx[i], T.pp, T.pr, T.ps)
    ikLocal(T.l, T.pr, T.q2)
    ikSetQ(rec.trs, i, T.l)
  }
}

// ---- Bone rotation offsets (script API setBoneRotationOffset). KEEP IN SYNC: gltfWorker.js / gltfModelW.js ----
// An extra local rotation per node multiplied onto the sampled rotation (rot = sampled * offset, about the
// bone's own axes). Packed as [count, (nodeIndex, x, y, z, w) * count]. Each offset node's pre-offset rotation is
// kept in `saved` and put back before the next sample, so an offset never stacks up on a node the clip doesn't
// animate (its TRS isn't re-sampled every frame).
function restoreBoneOffsets(trs, saved) {
  for (const [ni, q] of saved) {
    const o = ni * TRS_STRIDE + 3
    trs[o] = q[0]; trs[o + 1] = q[1]; trs[o + 2] = q[2]; trs[o + 3] = q[3]
  }
  saved.clear()
}
function applyBoneOffsets(trs, offs, p, count, saved, nodeCount) {
  for (let k = 0; k < count; k++, p += 5) {
    const ni = offs[p]
    if (!(ni >= 0 && ni < nodeCount)) continue
    const o = ni * TRS_STRIDE + 3
    const ax = trs[o], ay = trs[o + 1], az = trs[o + 2], aw = trs[o + 3]
    if (!saved.has(ni)) saved.set(ni, [ax, ay, az, aw])
    const bx = offs[p + 1], by = offs[p + 2], bz = offs[p + 3], bw = offs[p + 4]
    trs[o] = aw * bx + ax * bw + ay * bz - az * by
    trs[o + 1] = aw * by - ax * bz + ay * bw + az * bx
    trs[o + 2] = aw * bz + ax * by - ay * bx + az * bw
    trs[o + 3] = aw * bw - ax * bx - ay * by - az * bz
  }
}

let graph = null
// Per skin group: { positions: Float32Array(joints*3), radii: Float32Array(joints) }
let groupRadii = null
const tmp16 = new Float32Array(16)
const tmpJ = new Float32Array(16)

// ---- flat mat4 helpers on (array, offset) ----

// out = parent * T * R * S in one pass (glMatrix's fromRotationTranslationScale
// followed by a multiply, without the intermediate). parent may be null.
function composeWorldAt(out, oo, parent, po, trs, to) {
  const x = trs[to + 3], y = trs[to + 4], z = trs[to + 5], w = trs[to + 6]
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  const sx = trs[to + 7], sy = trs[to + 8], sz = trs[to + 9]
  const l0 = (1 - (yy + zz)) * sx, l1 = (xy + wz) * sx, l2 = (xz - wy) * sx
  const l4 = (xy - wz) * sy, l5 = (1 - (xx + zz)) * sy, l6 = (yz + wx) * sy
  const l8 = (xz + wy) * sz, l9 = (yz - wx) * sz, l10 = (1 - (xx + yy)) * sz
  const l12 = trs[to], l13 = trs[to + 1], l14 = trs[to + 2]
  if (!parent) {
    out[oo] = l0; out[oo + 1] = l1; out[oo + 2] = l2; out[oo + 3] = 0
    out[oo + 4] = l4; out[oo + 5] = l5; out[oo + 6] = l6; out[oo + 7] = 0
    out[oo + 8] = l8; out[oo + 9] = l9; out[oo + 10] = l10; out[oo + 11] = 0
    out[oo + 12] = l12; out[oo + 13] = l13; out[oo + 14] = l14; out[oo + 15] = 1
    return
  }
  const p0 = parent[po], p1 = parent[po + 1], p2 = parent[po + 2], p3 = parent[po + 3]
  const p4 = parent[po + 4], p5 = parent[po + 5], p6 = parent[po + 6], p7 = parent[po + 7]
  const p8 = parent[po + 8], p9 = parent[po + 9], p10 = parent[po + 10], p11 = parent[po + 11]
  const p12 = parent[po + 12], p13 = parent[po + 13], p14 = parent[po + 14], p15 = parent[po + 15]
  out[oo] = l0 * p0 + l1 * p4 + l2 * p8
  out[oo + 1] = l0 * p1 + l1 * p5 + l2 * p9
  out[oo + 2] = l0 * p2 + l1 * p6 + l2 * p10
  out[oo + 3] = l0 * p3 + l1 * p7 + l2 * p11
  out[oo + 4] = l4 * p0 + l5 * p4 + l6 * p8
  out[oo + 5] = l4 * p1 + l5 * p5 + l6 * p9
  out[oo + 6] = l4 * p2 + l5 * p6 + l6 * p10
  out[oo + 7] = l4 * p3 + l5 * p7 + l6 * p11
  out[oo + 8] = l8 * p0 + l9 * p4 + l10 * p8
  out[oo + 9] = l8 * p1 + l9 * p5 + l10 * p9
  out[oo + 10] = l8 * p2 + l9 * p6 + l10 * p10
  out[oo + 11] = l8 * p3 + l9 * p7 + l10 * p11
  out[oo + 12] = l12 * p0 + l13 * p4 + l14 * p8 + p12
  out[oo + 13] = l12 * p1 + l13 * p5 + l14 * p9 + p13
  out[oo + 14] = l12 * p2 + l13 * p6 + l14 * p10 + p14
  out[oo + 15] = l12 * p3 + l13 * p7 + l14 * p11 + p15
}

// out = a * b (glMatrix mat4.multiply)
function mul4At(out, oo, a, ao, b, bo) {
  const a00 = a[ao], a01 = a[ao + 1], a02 = a[ao + 2], a03 = a[ao + 3]
  const a10 = a[ao + 4], a11 = a[ao + 5], a12 = a[ao + 6], a13 = a[ao + 7]
  const a20 = a[ao + 8], a21 = a[ao + 9], a22 = a[ao + 10], a23 = a[ao + 11]
  const a30 = a[ao + 12], a31 = a[ao + 13], a32 = a[ao + 14], a33 = a[ao + 15]
  let b0 = b[bo], b1 = b[bo + 1], b2 = b[bo + 2], b3 = b[bo + 3]
  out[oo] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
  out[oo + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
  out[oo + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
  out[oo + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  b0 = b[bo + 4]; b1 = b[bo + 5]; b2 = b[bo + 6]; b3 = b[bo + 7]
  out[oo + 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
  out[oo + 5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
  out[oo + 6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
  out[oo + 7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  b0 = b[bo + 8]; b1 = b[bo + 9]; b2 = b[bo + 10]; b3 = b[bo + 11]
  out[oo + 8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
  out[oo + 9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
  out[oo + 10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
  out[oo + 11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  b0 = b[bo + 12]; b1 = b[bo + 13]; b2 = b[bo + 14]; b3 = b[bo + 15]
  out[oo + 12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
  out[oo + 13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
  out[oo + 14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
  out[oo + 15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
}

// glMatrix mat4.invert on (array, offset); leaves out untouched if singular
function invert4At(out, oo, a, ao) {
  const a00 = a[ao], a01 = a[ao + 1], a02 = a[ao + 2], a03 = a[ao + 3]
  const a10 = a[ao + 4], a11 = a[ao + 5], a12 = a[ao + 6], a13 = a[ao + 7]
  const a20 = a[ao + 8], a21 = a[ao + 9], a22 = a[ao + 10], a23 = a[ao + 11]
  const a30 = a[ao + 12], a31 = a[ao + 13], a32 = a[ao + 14], a33 = a[ao + 15]
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return false
  det = 1.0 / det
  out[oo] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  out[oo + 1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  out[oo + 2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  out[oo + 3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  out[oo + 4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  out[oo + 5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  out[oo + 6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  out[oo + 7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  out[oo + 8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  out[oo + 9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  out[oo + 10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  out[oo + 11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  out[oo + 12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  out[oo + 13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  out[oo + 14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  out[oo + 15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return true
}

/**
 * Shared, immutable description of the model graph in index form. Built once
 * per worker from the payload; records only hold per-instance numbers.
 */
function buildGraph(g) {
  const nodes = g.nodes || []
  const n = nodes.length
  const idxOf = new Map()
  for (let i = 0; i < n; i++) idxOf.set(nodes[i], i)
  const parentIdx = new Int32Array(n).fill(-1)
  const order = []
  const walk = (node, from) => {
    const i = idxOf.get(node)
    if (i === undefined) return
    if (from >= 0 && parentIdx[i] < 0) parentIdx[i] = from
    order.push(i)
    if (node.children) for (const c of node.children) walk(c, i)
  }
  const roots = (g.scene && g.scene.nodes) || []
  for (const r of roots) walk(r, -1)

  // Static = no animation targets it or any ancestor: world matrix is constant.
  const animated = new Uint8Array(n)
  for (const a of g.animations || []) {
    prepareAnimation(a, idxOf)
    for (let i = 0; i < a._targetIdx.length; i++) if (a._targetIdx[i] >= 0) animated[a._targetIdx[i]] = 1
  }
  const isStatic = new Uint8Array(n)
  for (let k = 0; k < order.length; k++) {
    const i = order[k]
    const p = parentIdx[i]
    isStatic[i] = !animated[i] && (p < 0 || isStatic[p]) ? 1 : 0
  }

  const unskinned = []
  for (let i = 0; i < n; i++) if (nodes[i].mesh && !nodes[i].skin) unskinned.push(i)

  const groups = []
  const byKey = new Map()
  for (const sn of g.skinnedNodes || []) {
    const i = idxOf.get(sn)
    const p = parentIdx[i]
    const key =
      p + "|" + (sn.translation || [0, 0, 0]).join(",") + "|" + (sn.scale || [1, 1, 1]).join(",") +
      "|" + sn.skin.joints.map((j) => idxOf.get(j)).join(",")
    let grp = byKey.get(key)
    if (!grp) {
      const joints = new Int32Array(sn.skin.joints.map((j) => idxOf.get(j)))
      const invBind = new Float32Array(joints.length * 16)
      for (let j = 0; j < joints.length; j++) {
        const ib = sn.skin.joints[j].invBindMatrix
        for (let q = 0; q < 16; q++) invBind[j * 16 + q] = ib ? ib[q] : q % 5 === 0 ? 1 : 0
      }
      grp = { head: i, nodes: [], joints, invBind }
      byKey.set(key, grp)
      groups.push(grp)
    }
    grp.nodes.push(i)
  }
  let floats = unskinned.length * 16
  for (const grp of groups) floats += (grp.joints.length + 1) * 16
  const boundsOffset = floats
  floats += 8
  const readbackOffset = floats
  floats += RB_MAX * 12

  const baseTRS = initTRS(new Float32Array(n * TRS_STRIDE), nodes)
  const rootIdx = roots.length ? idxOf.get(roots[0]) : -1
  return {
    n, nodes, idxOf, parentIdx, order: new Int32Array(order), isStatic,
    unskinned: new Int32Array(unskinned), groups, floats, boundsOffset, readbackOffset, baseTRS, rootIdx,
  }
}

function createBatchRecord() {
  const record = freshInstanceState()
  record.gltf = sharedGltf // legacy handlers (enableNode) read module state from here
  record.trs = new Float32Array(graph.baseTRS)
  record.mat = new Float32Array(graph.n * 16)
  record.matValid = new Uint8Array(graph.n)
  record.inv = new Float32Array(graph.groups.length * 16)
  record.invValid = new Uint8Array(graph.groups.length)
  record.sampler = createSamplerState(sharedGltf.animations)
  return record
}

function computePose(rec, out, base) {
  const order = graph.order
  const parentIdx = graph.parentIdx
  const isStatic = graph.isStatic
  const mat = rec.mat
  const trs = rec.trs
  const valid = rec.matValid
  for (let k = 0; k < order.length; k++) {
    const i = order[k]
    if (isStatic[i] && valid[i]) continue
    const p = parentIdx[i]
    composeWorldAt(mat, i * 16, p < 0 ? null : mat, p * 16, trs, i * TRS_STRIDE)
    if (isStatic[i]) valid[i] = 1
  }
  let k = base
  const unskinned = graph.unskinned
  for (let u = 0; u < unskinned.length; u++, k += 16) {
    const o = unskinned[u] * 16
    for (let q = 0; q < 16; q++) out[k + q] = mat[o + q]
  }
  // Root transform (legacy "parentMatrix"): the scene's first root node's TRS
  if (graph.rootIdx >= 0) composeWorldAt(tmp16, 0, null, 0, trs, graph.rootIdx * TRS_STRIDE)
  else for (let q = 0; q < 16; q++) tmp16[q] = q % 5 === 0 ? 1 : 0
  // Posed bounds, accumulated while the bones are built. Each joint owns a box
  // in its own bind space (groupRadii, from the vertex weights); the GPU takes a
  // joint-space point through inv(head) * world(joint) (the bone before invBind
  // is folded in) and then uRootNodeXform, so push the box corners through
  // root * inv(head) * world(joint) and union. Oriented per-joint boxes follow
  // limbs far more tightly than spheres, and bounding in the space the shader
  // draws in keeps a rotated or scaled root (Blender rigs) from misplacing it.
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  const disabled = rec.disabledNodes
  const nodes = graph.nodes
  const groups = graph.groups
  for (let gi = 0; gi < groups.length; gi++) {
    const grp = groups[gi]
    const head = grp.head
    if (!(isStatic[head] && rec.invValid[gi])) {
      invert4At(rec.inv, gi * 16, mat, head * 16)
      if (isStatic[head]) rec.invValid[gi] = 1
    }
    const joints = grp.joints
    const invBind = grp.invBind
    const rad = groupRadii && groupRadii[gi]
    // The bounds of a skin do not depend on which parts show; only a fully
    // hidden group drops out.
    let bound = false
    if (rad && disabled.size) {
      for (let i = 0; i < grp.nodes.length; i++) if (!disabled.get(nodes[grp.nodes[i]].name)) { bound = true; break }
    } else bound = !!rad
    for (let j = 0; j < joints.length; j++, k += 16) {
      // inv(head) * world(joint)
      mul4At(out, k, rec.inv, gi * 16, mat, joints[j] * 16)
      if (bound && rad.boxMin[j * 3] !== Infinity) {
        mul4At(tmpJ, 0, tmp16, 0, out, k)
        const bmin = rad.boxMin, bmax = rad.boxMax, o = j * 3
        for (let c = 0; c < 8; c++) {
          const px = c & 1 ? bmax[o] : bmin[o]
          const py = c & 2 ? bmax[o + 1] : bmin[o + 1]
          const pz = c & 4 ? bmax[o + 2] : bmin[o + 2]
          const wx = tmpJ[0] * px + tmpJ[4] * py + tmpJ[8] * pz + tmpJ[12]
          const wy = tmpJ[1] * px + tmpJ[5] * py + tmpJ[9] * pz + tmpJ[13]
          const wz = tmpJ[2] * px + tmpJ[6] * py + tmpJ[10] * pz + tmpJ[14]
          if (wx < minX) minX = wx
          if (wy < minY) minY = wy
          if (wz < minZ) minZ = wz
          if (wx > maxX) maxX = wx
          if (wy > maxY) maxY = wy
          if (wz > maxZ) maxZ = wz
        }
      }
      // bone = inv(head) * world(joint) * invBind(joint)
      mul4At(out, k, out, k, invBind, j * 16)
    }
    for (let q = 0; q < 16; q++) out[k + q] = tmp16[q]
    k += 16
  }
  const at = base + graph.boundsOffset
  if (minX === Infinity) {
    out[at] = NaN // no skinned bounds (all groups hidden or no boxes)
  } else {
    out[at] = minX; out[at + 1] = minY; out[at + 2] = minZ
    out[at + 3] = maxX; out[at + 4] = maxY; out[at + 5] = maxZ
  }
}

function onBatch(e) {
  const count = e.data.count
  const reqBuf = e.data.req
  const req = new Float64Array(reqBuf)
  const need = count * graph.floats * 4
  let out = e.data.out
  if (!out || out.byteLength < need) out = new ArrayBuffer(Math.max(need, 64))
  const outF = new Float32Array(out)
  const anims = sharedGltf.animations || []
  const offs = e.data.offs ? new Float32Array(e.data.offs) : null
  let op = 0
  for (let i = 0; i < count; i++) {
    const b = i * REQ_STRIDE
    const nOff = offs ? offs[op++] : 0
    const offAt = op
    op += nOff * 5
    const nMix = offs ? offs[op++] : 0
    const mixAt = op
    op += nMix * 3
    const nIK = offs ? offs[op++] : 0
    const ikAt = op
    op += nIK * IK_STRIDE
    const nJig = offs ? offs[op++] : 0
    const jigAt = op
    if (nJig) op += 17 + nJig * JIG_STRIDE
    const nRB = offs ? offs[op++] : 0
    const rbAt = op
    op += nRB
    const rec = instances.get(req[b])
    if (!rec) continue
    let mix = null
    if (nMix) {
      mix = rec.mix || (rec.mix = { count: 0, anims: [], idx: [], w: [], ph: [] })
      mix.count = nMix
      for (let k = 0; k < nMix; k++) {
        const ai = offs[mixAt + k * 3]
        mix.idx[k] = ai
        mix.anims[k] = anims[ai]
        mix.w[k] = offs[mixAt + k * 3 + 1]
        mix.ph[k] = offs[mixAt + k * 3 + 2]
      }
    }
    const saved = rec.offSaved || (rec.offSaved = new Map())
    const hadOffsets = saved.size > 0
    // undo in the reverse order of applying: IK (last) first, then the offsets
    const ikSaved = rec.ikSaved || (rec.ikSaved = new Map())
    const hadIK = ikSaved.size > 0
    const jigSaved = rec.jigSaved || (rec.jigSaved = new Map())
    const hadJig = jigSaved.size > 0
    if (hadJig) ikRestore(rec.trs, jigSaved)
    if (hadIK) ikRestore(rec.trs, ikSaved)
    if (hadOffsets) restoreBoneOffsets(rec.trs, saved)
    const animIndex = req[b + 1]
    if (animIndex >= 0) {
      const anim = anims[animIndex]
      if (anim) sampleAnimation(rec.sampler, anim, animIndex, req[b + 2], req[b + 3], req[b + 4], req[b + 5] !== 0, rec.trs, mix)
    }
    if (nOff) applyBoneOffsets(rec.trs, offs, offAt, nOff, saved, graph.n)
    if (nIK) applyIK(rec.trs, graph.parentIdx, offs, ikAt, nIK, ikSaved, null)
    if (nJig) applyJiggle(rec, graph.parentIdx, offs, jigAt, nJig, jigSaved, graph.baseTRS)
    // cached world matrices of static nodes may sit under an offset, IK or jiggle bone
    if (nOff || hadOffsets || nIK || hadIK || nJig || hadJig) { rec.matValid.fill(0); rec.invValid.fill(0) } // incl. cached skin-root inverses
    computePose(rec, outF, i * graph.floats)
    // the drawn nodes (setDrawnNodes): their model-space matrices as this pose draws them
    if (nRB) {
      const at = i * graph.floats + graph.readbackOffset, m = rec.mat
      for (let j = 0; j < nRB && j < RB_MAX; j++) {
        const mo = offs[rbAt + j] * 16, w = at + j * 12
        outF[w] = m[mo]; outF[w + 1] = m[mo + 1]; outF[w + 2] = m[mo + 2]
        outF[w + 3] = m[mo + 4]; outF[w + 4] = m[mo + 5]; outF[w + 5] = m[mo + 6]
        outF[w + 6] = m[mo + 8]; outF[w + 7] = m[mo + 9]; outF[w + 8] = m[mo + 10]
        outF[w + 9] = m[mo + 12]; outF[w + 10] = m[mo + 13]; outF[w + 11] = m[mo + 14]
      }
    }
  }
  const msg = { type: "batchResult", count, req: reqBuf, out }
  msgPort.postMessage(msg, [reqBuf, out])
}

function initEventListeners(e) {
  if (e.data && e.data["type"] === "construct-worker-init") {
    msgPort = e.data["port2"]
    msgPort.onmessage = OnMessage
    OnReady()
  }
}

// Receive the MessagePort from Construct
self.addEventListener("message", initEventListeners)

function OnMessage(e) {
  replyIid = e.data.iid
  switch (e.data.type) {
    case "init":
      break
    case "gltf":
      sharedGltf = e.data.gltf
      buffLength = e.data.buffLength
      buffBonesLength = e.data.buffBonesLength
      drawMeshes = e.data.drawMeshes
      normalizeAttributeStubs()
      graph = buildGraph(sharedGltf)
      groupRadii = e.data.groupRadii || null
      if (!e.data.shared) {
        // Legacy single-instance worker: one record mutating the received graph directly
        const record = freshInstanceState()
        record.gltf = sharedGltf
        instances.set(DEFAULT_IID, record)
      }
      break
    case "addInstance":
      instances.set(e.data.iid, createBatchRecord())
      break
    case "batch":
      onBatch(e)
      break
    case "removeInstance":
      instances.delete(e.data.iid)
      break
    case "attributes":
      patchAttributes(e.data.meshes)
      break
    case "updateAnimationPolygons":
      buff = e.data.buff
      if (e.data.buffBones) buffBones = e.data.buffBones
      if (e.data.debug) console.info("Update animation polygons")
      if (e.data.data.animationData.onScreen && !e.data.data.editorData.gpuSkinning && !attributesLoaded) {
        const msg = { type: "needAttributes", buff, iid: replyIid }
        msgPort.postMessage(msg, [msg.buff])
        break
      }
      if (!activateInstance(e.data.iid)) {
        // Instance already removed; return the buffer so the sender isn't starved
        const msg = { type: "status", status: { workerReady: true }, buff, iid: replyIid }
        msgPort.postMessage(msg, [msg.buff])
        break
      }
      updateAnimationPolygons(e.data.data)
      deactivateInstance()
      break
    case "getPolygons":
      buff = e.data.buff
      if (e.data.buffBones) buffBones = e.data.buffBones
      if (!e.data.data.editorData.gpuSkinning && !attributesLoaded) {
        const msg = { type: "needAttributes", buff, iid: replyIid }
        msgPort.postMessage(msg, [msg.buff])
        break
      }
      if (!activateInstance(e.data.iid)) {
        const msg = { type: "status", status: { workerReady: true }, buff, iid: replyIid }
        msgPort.postMessage(msg, [msg.buff])
        break
      }
      getPolygons(e.data.data)
      deactivateInstance()
      break
    case "release":
      release()
      self.close()
      break
    case "enableNode":
      if (!activateInstance(e.data.iid)) break
      if (e.data.enable) {
        disabledNodes.delete(e.data.nodeName)
      } else {
        disabledNodes.set(e.data.nodeName, true)
      }
      deactivateInstance()
      break
    default:
      console.warn("unknown message type:", e.data.type)
  }
}

function release() {
  self.removeEventListener("message", initEventListeners)
  if (msgPort) {
    msgPort.close()
    msgPort = null
  }
  buff = null
  buffBones = null
  drawVerts = null
  drawBones = null
  // @ts-ignore
  index = null
  gltf = null
  // @ts-ignore
  minBB = null
  // @ts-ignore
  maxBB = null
  // @ts-ignore
  buffLength = null
  // @ts-ignore
  buffBonesLength = null
  disabledNodes.clear()
  instances.clear()
  sharedGltf = null
  graph = null
  groupRadii = null
  currentRecord = null
  // @ts-ignore
  activeNodes = null
  // @ts-ignore
  nodeIndex = null
  // @ts-ignore
  bonesIndex = null
  // @ts-ignore
  drawMeshes = null
}

function OnReady() {}

// Updates animation at index to be at time.  Is used to play animation.

let blendState = "init"
const lastTarget = new Array(2)
lastTarget[0] = []
lastTarget[1] = []
let lastTargetIndex = 0
let blendTarget = []
let blendTime = 0
let lastIndex = 0


function updateAnimationPolygons(data) {
  const animationData = data.animationData
  const editorData = data.editorData
  const gpuSkinning = editorData.gpuSkinning

  updateAnimation(animationData)
  if (animationData.onScreen) {
    getPolygonsPrep(editorData)
  }
  // Post buffer to messagePort
  // Last float in array will be tick that requested the update
  if (animationData.onScreen) {
    drawVerts[drawVerts.length - 1] = editorData.tick
    setBBInVerts(drawVerts, minBB, maxBB)
    if (gpuSkinning) {
      // XXX Don't need to pass back buff
      let msg = { activeNodes, buffBones, gpuSkinning: true, buff, iid: replyIid }
      msgPort.postMessage(msg, [msg.buffBones, msg.buff])
      buffBones = null
    } else {
      let msg = { buff, activeNodes, iid: replyIid }
      msgPort.postMessage(msg, [msg.buff])
    }
    drawVerts = null
  } else {
    // No need to transfer data, worker us ready for next request
    const msg = { type: "status", status: { workerReady: true }, buff, iid: replyIid }
    msgPort.postMessage(msg, [msg.buff])
    drawVerts = null
  }
}

function getPolygons(data) {
  const editorData = data.editorData
  const gpuSkinning = editorData.gpuSkinning
  getPolygonsPrep(editorData)
  // Post buffer to messagePort
  // Last float in array will be tick that requested the update
  drawVerts[drawVerts.length - 1] = editorData.tick
  setBBInVerts(drawVerts, minBB, maxBB)
  if (gpuSkinning) {
    let msg = { activeNodes, buffBones, gpuSkinning: true, buff, iid: replyIid }
    msgPort.postMessage(msg, [msg.buffBones, msg.buff])
    buffBones = null
  } else {
    let msg = { buff, activeNodes, iid: replyIid }
    msgPort.postMessage(msg, [msg.buff])
  }
}

function setBBInVerts(verts, minBBox, maxBBox) {
  let l = verts.length - 2
  verts[l--] = maxBBox[2]
  verts[l--] = maxBBox[1]
  verts[l--] = maxBBox[0]
  verts[l--] = minBBox[2]
  verts[l--] = minBBox[1]
  verts[l--] = minBBox[0]
}

function updateAnimation(animationData) {
  // @ts-ignore
  const vec3 = glMatrix.vec3
  // @ts-ignore
  const quat = glMatrix.quat
  const index = animationData.index
  let time = animationData.time
  const onScreen = animationData.onScreen
  const deltaTime = animationData.deltaTime
  const animationBlend = animationData.animationBlend
  const animationLoop = animationData.animationLoop

  let anim = gltf.animations[index]

  // Blend state machine
  switch (blendState) {
    case "init":
      if (animationBlend != 0 && lastIndex != index) {
        blendState = "blend"
        blendTime = 0
        blendTarget = lastTarget[lastTargetIndex]
        if (lastTargetIndex == 0) {
          lastTargetIndex = 1
        } else {
          lastTargetIndex = 0
        }
        lastIndex = index
      }
      break
    case "blend":
      if (lastIndex != index) {
        blendState = "blend"
        blendTime = 0
        blendTarget = lastTarget[lastTargetIndex]
        if (lastTargetIndex == 0) {
          lastTargetIndex = 1
        } else {
          lastTargetIndex = 0
        }
        lastIndex = index
        break
      }
      if (blendTime > animationBlend) {
        blendState = "idle"
        break
      }
      blendTime += deltaTime
      break
    case "idle":
      if (lastIndex != index) {
        blendState = "blend"
        blendTime = 0
        blendTarget = lastTarget[lastTargetIndex]
        if (lastTargetIndex == 0) {
          lastTargetIndex = 1
        } else {
          lastTargetIndex = 0
        }
        lastIndex = index
      }
      break
    default:
      console.warn("[3DObject] bad blend state:", blendState)
  }

  lastTarget[lastTargetIndex] = []
  for (let i = 0; i < anim.channels.length; i++) {
    let c = anim.channels[i]
    let timeValues = c.sampler.input
    let otherValues = c.sampler.output.data
    let target = c.target

    if (timeValues.max[0] == timeValues.min[0]) {
      continue
    }

    if (animationLoop) {
      time = ((time - timeValues.min[0]) % (timeValues.max[0] - timeValues.min[0])) + timeValues.min[0] // loop
    } else {
      if (time > timeValues.max[0]) {
        time = timeValues.max[0] - 0.01 // Stop on max time
      }
    }

    // If not on screen no more animation required.
    if (!onScreen) continue

    //time = Math.min(Math.max(time, timeValues.min[0]), timeValues.max[0]);  //clamp
    timeValues = timeValues.data

    //find index in timeline
    let t0, t1
    for (t0 = 0, t1 = 1; t0 < timeValues.length - 1; t0++, t1++)
      if (time >= timeValues[t0] && time <= timeValues[t1]) break


    let t = (time - timeValues[t0]) / (timeValues[t1] - timeValues[t0])


    // Check if invalid state, if so, skip animation
    // TODO: Change how change animation vs tick is handled to make sure this case does not happen
    if (timeValues[t1] == null) continue

    if (target.path == "translation")
      vec3.lerp(
        target.node.translation,
        otherValues.subarray(t0 * 3, t0 * 3 + 3),
        otherValues.subarray(t1 * 3, t1 * 3 + 3),
        t
      )
    // vec3.lerp(otherValues.subarray(t0*3,t0*3+3), otherValues.subarray(t1*3,t1*3+3), t, target.node.translation);
    else if (target.path == "rotation")
      quat.slerp(
        target.node.rotation,
        otherValues.subarray(t0 * 4, t0 * 4 + 4),
        otherValues.subarray(t1 * 4, t1 * 4 + 4),
        t
      )
    // quat4.slerp(otherValues.subarray(t0*4,t0*4+4), otherValues.subarray(t1*4,t1*4+4), t, target.node.rotation);
    else if (target.path == "scale")
      vec3.lerp(
        target.node.scale,
        otherValues.subarray(t0 * 3, t0 * 3 + 3),
        otherValues.subarray(t1 * 3, t1 * 3 + 3),
        t
      )
    // vec3.lerp(otherValues.subarray(t0*3,t0*3+3), otherValues.subarray(t1*3,t1*3+3), t, target.node.scale);
    else if (target.path == "weights") {
      // Apply gltf morph target weights to node weights using lerp between two targets
      const node = target.node
      node.weights = new Float32Array(node.mesh.primitives[0].targets.length)
      const weights = node.weights
      const stride = weights.length
      for (let j = 0; j < stride; j++) {
        weights[j] = lerp(otherValues[t0 * stride + j], otherValues[t1 * stride + j], t)
      }
    }

    // Blend to last animation if during blend
    if (blendState == "blend") {
      const linear = blendTime == 0 ? 0 : Math.min(1, blendTime / animationBlend)
      const blend = linear * linear * (3 - 2 * linear) // eased in and out: no sudden start or stop of the transition
      const blendTargetI = blendTarget[i]
      if (blendTargetI != null) {
        if (target.path == "translation" && blendTargetI.path == "translation")
          vec3.lerp(target.node.translation, blendTargetI.node.translation, target.node.translation, blend)
        else if (target.path == "rotation" && blendTargetI.path == "rotation")
          quat.slerp(target.node.rotation, blendTargetI.node.rotation, target.node.rotation, blend)
        else if (target.path == "scale" && blendTargetI.path == "scale")
          vec3.lerp(target.node.scale, blendTargetI.node.scale, target.node.scale, blend)
      }
    }

    if (animationBlend != 0) {
      const currentTarget = {}
      currentTarget.node = {}
      if (target.path == "translation") {
        currentTarget.path = target.path
        currentTarget.node.translation = vec3.clone(target.node.translation)
      } else if (target.path == "rotation") {
        currentTarget.path = target.path
        currentTarget.node.rotation = quat.clone(target.node.rotation)
      } else if (target.path == "scale") {
        currentTarget.path = target.path
        currentTarget.node.scale = vec3.clone(target.node.scale)
      }
      lastTarget[lastTargetIndex].push(currentTarget)
    }
  }
}

function lerp(a, b, alpha) {
  const value = a + alpha * (b - a)
  return value
}
//	Updates scene graph, and as a second step sends transformed skinned mesh points to c2.
// This function prepares polygon data for rendering. It handles both GPU skinning and non-GPU skinning scenarios.
// When GPU skinning is enabled, it prepares bone matrices for GPU processing. Otherwise, it computes vertex positions in software.
function getPolygonsPrep(editorData) {
  // @ts-ignore
  const vec3 = glMatrix.vec3
  // @ts-ignore
  const mat4 = glMatrix.mat4
  // @ts-ignore
  const quat = glMatrix.quat
  const gpuSkinning = editorData.gpuSkinning
  drawVerts = new Float32Array(buff)
  if (gpuSkinning) {
    // buffBones is ping-ponged with the main thread like buff; reallocate only if lost
    if (!buffBones || buffBones.byteLength !== buffBonesLength * 4) {
      buffBones = new ArrayBuffer(buffBonesLength * 4)
    }
    drawBones = new Float32Array(buffBones)
  }
  // drawVerts index
  index = 0
  bonesIndex = 0
  const isEditor = editorData.isEditor
  activeNodes = []
  nodeIndex = 0

  if (isEditor) {
    const xScale = editorData.xScale
    const yScale = editorData.yScale
    const zScale = editorData.zScale

    const xAngle = editorData.xAngle
    const yAngle = editorData.yAngle
    const zAngle = editorData.zAngle

    const x = editorData.x
    const y = editorData.y
    const z = editorData.z

    quat.fromEuler(rotate, xAngle, yAngle, zAngle)
    const localCenter = editorData.localCenter || [0, 0, 0]
    mat4.fromRotationTranslationScaleOrigin(modelScaleRotate, rotate, [x, y, z], [xScale, -yScale, zScale], localCenter)
  }

  quat.fromEuler(rotationQuat, 0, 0, 0)

  mat4.fromRotationTranslation(parentMatrix, rotationQuat, [0, 0, 0])

  minBB = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  maxBB = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]

  // update all scene matrixes.
  for (let i = 0; i < gltf.scene.nodes.length; i++) {
    transformNode(gltf.scene.nodes[i], parentMatrix, modelScaleRotate, isEditor, gpuSkinning)
  }

  quat.fromEuler(rotationQuat, 0, 0, 0)

  // Check if the gltf scene root node has a rotation, translation or scale
  const rootNode = gltf?.scene?.nodes[0]
  let rootNodeXform = false

  if (rootNode && (rootNode.rotation || rootNode.translation || rootNode.scale)) {
    if (!rootNode.rotation) rootNode.rotation = quat.create()
    if (!rootNode.translation) rootNode.translation = vec3.create()
    if (!rootNode.scale) rootNode.scale = vec3.fromValues(1, 1, 1)

    mat4.fromRotationTranslationScale(parentMatrix, rootNode.rotation, rootNode.translation, rootNode.scale)
    rootNodeXform = true
  }

  for (let ii = 0; ii < gltf.skinnedNodes.length; ii++) {
    let node = gltf.skinnedNodes[ii]
    // Force skinned mesh node rotation to identity (skinning provides the pose).
    // Must be a per-node array: aliasing a shared scratch quat here would leak
    // rotation state across instance records in shared-worker mode.
    node.rotation = [0, 0, 0, 1]

    //update bone matrixes
    for (let jj = 0; jj < node.skin.joints.length; jj++) {
      let joint = node.skin.joints[jj]

      mat4.multiply(joint.boneMatrix, node.invMatrix, joint.matrix)
      mat4.multiply(joint.boneMatrix, joint.boneMatrix, joint.invBindMatrix)
      if (gpuSkinning) {
        drawBones.set(joint.boneMatrix, bonesIndex)
        bonesIndex += joint.boneMatrix.length
      }
    }

    if (gpuSkinning) {
      drawBones.set(parentMatrix, bonesIndex)
      bonesIndex += parentMatrix.length
    }

    for (let i = 0; i < node.mesh.primitives.length; i++) {
      let posData = node.mesh.primitives[i].attributes.POSITION.data
      let weights = node.mesh.primitives[i].attributes.WEIGHTS_0.data
      let joints = node.mesh.primitives[i].attributes.JOINTS_0.data

      // Don't animate disabled nodes
      if (disabledNodes.get(node.name)) {
        index += posData.length
        nodeIndex++
        continue
      }

      if (gpuSkinning) continue

      let morphActive = false
      let morphTargets = null
      let morphWeights = null

      if (node.weights) {
        morphActive = true
        morphTargets = node.mesh.primitives[i].targets
        morphWeights = node.weights
      }

      activeNodes.push(nodeIndex)
      nodeIndex++

      for (let j = 0; j < posData.length / 3; j++) {
        let w = weights.subarray(j * 4, j * 4 + 4)
        let b = joints.subarray(j * 4, j * 4 + 4)
        let vin = posData.subarray(j * 3, j * 3 + 3)
        let v = [0, 0, 0],
          vsum = [0, 0, 0]

        if (morphActive) {
          vin = morphTargetsXform(vin, j, morphWeights, morphTargets)
        }

        for (let i = 0; i < 4; i++) {
          vec3.transformMat4(v, vin, node.skin.joints[b[i]].boneMatrix)
          vec3.scale(v, v, w[i])
          vec3.add(vsum, vsum, v)
        }

        if (rootNodeXform) {
          // vec3.mul(vsum, vsum, rootNode.scale);
          vec3.transformMat4(vsum, vsum, parentMatrix)
          if (j == 0) {
          }
        }

        if (isEditor) {
          vec3.transformMat4(vsum, vsum, modelScaleRotate)
        }

        const x = vsum[0]
        const y = vsum[1]
        const z = vsum[2]

        if (minBB[0] > x) minBB[0] = x
        if (minBB[1] > y) minBB[1] = y
        if (minBB[2] > z) minBB[2] = z
        if (maxBB[0] < x) maxBB[0] = x
        if (maxBB[1] < y) maxBB[1] = y
        if (maxBB[2] < z) maxBB[2] = z

        drawVerts[index++] = x
        drawVerts[index++] = y
        drawVerts[index++] = z
      }
    }
  }
}

/*
    Updates a node's matrix and all it's children nodes.
    After that it transforms unskinned mesh points and sends them to c2.
*/
function transformNode(node, parentMat, modelScaleRotate, isEditor, gpuSkinning) {
  // @ts-ignore
  const mat4 = glMatrix.mat4
  // @ts-ignore
  const quat = glMatrix.quat
  // @ts-ignore
  const vec3 = glMatrix.vec3

  if (parentMat != undefined) mat4.copy(node.matrix, parentMat)
  else mat4.identity(node.matrix)

  mat4.translate(node.matrix, node.matrix, node.translation)
  mat4.multiply(node.matrix, node.matrix, mat4.fromQuat(dummyMat4Out, node.rotation))
  mat4.scale(node.matrix, node.matrix, node.scale)

  // XXX unused?
  if (node.skin != undefined) mat4.invert(node.invMatrix, node.matrix)

  // unskinned meshes
  if (node.mesh != undefined && node.skin == undefined) {
    if (gpuSkinning) {
      drawBones.set(node.matrix, bonesIndex)
      bonesIndex += 16
    }

    for (let i = 0; i < node.mesh.primitives.length; i++) {
      let posData = node.mesh.primitives[i].attributes.POSITION.data

      let v = [0, 0, 0]
      if (disabledNodes.get(node.name)) {
        index += posData.length
        nodeIndex++
        continue
      }

      let morphActive = false
      let morphTargets = null
      let morphWeights = null

      if (node.weights) {
        morphActive = true
        morphTargets = node.mesh.primitives[i].targets
        morphWeights = node.weights
      }

      activeNodes.push(nodeIndex)
      nodeIndex++

      if (gpuSkinning) continue

      for (let j = 0; j < posData.length / 3; j++) {
        let vin = posData.subarray(j * 3, j * 3 + 3)
        if (morphActive) {
          vin = morphTargetsXform(vin, j, morphWeights, morphTargets)
        }

        vec3.transformMat4(v, vin, node.matrix)

        if (isEditor) {
          vec3.transformMat4(v, v, modelScaleRotate)
        }

        const x = v[0]
        const y = v[1]
        const z = v[2]

        if (minBB[1] > y) minBB[1] = y
        if (minBB[0] > x) minBB[0] = x
        if (minBB[2] > z) minBB[2] = z
        if (maxBB[0] < x) maxBB[0] = x
        if (maxBB[1] < y) maxBB[1] = y
        if (maxBB[2] < z) maxBB[2] = z

        drawVerts[index++] = x
        drawVerts[index++] = y
        drawVerts[index++] = z
      }
    }
  }
  if (node.children != undefined)
    for (let i = 0; i < node.children.length; i++)
      transformNode(node.children[i], node.matrix, modelScaleRotate, isEditor, gpuSkinning)
}

function morphTargetsXform(vin, index, weights, targets) {
  // @ts-ignore
  const vec3 = glMatrix.vec3
  vec3.copy(vout, vin)
  for (let i = 0; i < targets.length; i++) {
    const w = weights[i]
    if (w == 0) continue
    const v = targets[i].POSITION.data.subarray(index * 3, index * 3 + 3)
    vec3.scaleAndAdd(vout, vout, v, w)
  }
  return vout
}

function smoothstep(min, max, value) {
  var x = Math.max(0, Math.min(1, (value - min) / (max - min)))
  return x * x * (3 - 2 * x)
}

/*!
@fileoverview gl-matrix - High performance matrix and vector operations
@author Brandon Jones
@author Colin MacKenzie IV
@version 3.3.0

Copyright (c) 2015-2020, Brandon Jones, Colin MacKenzie IV.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/

;(function (global, factory) {
  typeof exports === "object" && typeof module !== "undefined"
    ? factory(exports)
    : typeof define === "function" && define.amd
    ? define(["exports"], factory)
    : ((global = typeof globalThis !== "undefined" ? globalThis : global || self), factory((global.glMatrix = {})))
})(this, function (exports) {
  "use strict"

  /**
   * Common utilities
   * @module glMatrix
   */
  // Configuration Constants
  var EPSILON = 0.000001

  var ARRAY_TYPE = typeof Float32Array !== "undefined" ? Float32Array : Array

  var RANDOM = Math.random

  /**
   * Sets the type of array used when creating new vectors and matrices
   *
   * @param {Float32ArrayConstructor | ArrayConstructor} type Array type, such as Float32Array or Array
   */

  function setMatrixArrayType(type) {
    ARRAY_TYPE = type
  }
  var degree = Math.PI / 180

  /**
   * Convert Degree To Radian
   *
   * @param {Number} a Angle in Degrees
   */

  function toRadian(a) {
    return a * degree
  }
  /**
   * Tests whether or not the arguments have approximately the same value, within an absolute
   * or relative tolerance of glMatrix.EPSILON (an absolute tolerance is used for values less
   * than or equal to 1.0, and a relative tolerance is used for larger values)
   *
   * @param {Number} a The first number to test.
   * @param {Number} b The second number to test.
   * @returns {Boolean} True if the numbers are approximately equal, false otherwise.
   */

  function equals(a, b) {
    return Math.abs(a - b) <= EPSILON * Math.max(1.0, Math.abs(a), Math.abs(b))
  }
  if (!Math.hypot)
    Math.hypot = function () {
      var y = 0,
        i = arguments.length

      while (i--) {
        y += arguments[i] * arguments[i]
      }

      return Math.sqrt(y)
    }

  var common = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    EPSILON: EPSILON,
    get ARRAY_TYPE() {
      return ARRAY_TYPE
    },
    RANDOM: RANDOM,
    setMatrixArrayType: setMatrixArrayType,
    toRadian: toRadian,
    equals: equals,
  })

  /**
   * 2x2 Matrix
   * @module mat2
   */

  /**
   * Creates a new identity mat2
   *
   * @returns {mat2} a new 2x2 matrix
   */

  function create() {
    var out = new ARRAY_TYPE(4)

    if (ARRAY_TYPE != Float32Array) {
      out[1] = 0

      out[2] = 0
    }

    out[0] = 1

    out[3] = 1

    return out
  }
  /**
   * Creates a new mat2 initialized with values from an existing matrix
   *
   * @param {ReadonlyMat2} a matrix to clone
   * @returns {mat2} a new 2x2 matrix
   */

  function clone(a) {
    var out = new ARRAY_TYPE(4)

    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    return out
  }
  /**
   * Copy the values from one mat2 to another
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the source matrix
   * @returns {mat2} out
   */

  function copy(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    return out
  }
  /**
   * Set a mat2 to the identity matrix
   *
   * @param {mat2} out the receiving matrix
   * @returns {mat2} out
   */

  function identity(out) {
    out[0] = 1

    out[1] = 0

    out[2] = 0

    out[3] = 1

    return out
  }
  /**
   * Create a new mat2 with the given values
   *
   * @param {Number} m00 Component in column 0, row 0 position (index 0)
   * @param {Number} m01 Component in column 0, row 1 position (index 1)
   * @param {Number} m10 Component in column 1, row 0 position (index 2)
   * @param {Number} m11 Component in column 1, row 1 position (index 3)
   * @returns {mat2} out A new 2x2 matrix
   */

  function fromValues(m00, m01, m10, m11) {
    var out = new ARRAY_TYPE(4)

    out[0] = m00

    out[1] = m01

    out[2] = m10

    out[3] = m11

    return out
  }
  /**
   * Set the components of a mat2 to the given values
   *
   * @param {mat2} out the receiving matrix
   * @param {Number} m00 Component in column 0, row 0 position (index 0)
   * @param {Number} m01 Component in column 0, row 1 position (index 1)
   * @param {Number} m10 Component in column 1, row 0 position (index 2)
   * @param {Number} m11 Component in column 1, row 1 position (index 3)
   * @returns {mat2} out
   */

  function set(out, m00, m01, m10, m11) {
    out[0] = m00

    out[1] = m01

    out[2] = m10

    out[3] = m11

    return out
  }
  /**
   * Transpose the values of a mat2
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the source matrix
   * @returns {mat2} out
   */

  function transpose(out, a) {
    // If we are transposing ourselves we can skip a few steps but have to cache
    // some values
    if (out === a) {
      var a1 = a[1]

      out[1] = a[2]

      out[2] = a1
    } else {
      out[0] = a[0]

      out[1] = a[2]

      out[2] = a[1]

      out[3] = a[3]
    }

    return out
  }
  /**
   * Inverts a mat2
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the source matrix
   * @returns {mat2} out
   */

  function invert(out, a) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3]
    // Calculate the determinant

    var det = a0 * a3 - a2 * a1

    if (!det) {
      return null
    }

    det = 1.0 / det

    out[0] = a3 * det

    out[1] = -a1 * det

    out[2] = -a2 * det

    out[3] = a0 * det

    return out
  }
  /**
   * Calculates the adjugate of a mat2
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the source matrix
   * @returns {mat2} out
   */

  function adjoint(out, a) {
    // Caching this value is nessecary if out == a
    var a0 = a[0]

    out[0] = a[3]

    out[1] = -a[1]

    out[2] = -a[2]

    out[3] = a0

    return out
  }
  /**
   * Calculates the determinant of a mat2
   *
   * @param {ReadonlyMat2} a the source matrix
   * @returns {Number} determinant of a
   */

  function determinant(a) {
    return a[0] * a[3] - a[2] * a[1]
  }
  /**
   * Multiplies two mat2's
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the first operand
   * @param {ReadonlyMat2} b the second operand
   * @returns {mat2} out
   */

  function multiply(out, a, b) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3]

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2],
      b3 = b[3]

    out[0] = a0 * b0 + a2 * b1

    out[1] = a1 * b0 + a3 * b1

    out[2] = a0 * b2 + a2 * b3

    out[3] = a1 * b2 + a3 * b3

    return out
  }
  /**
   * Rotates a mat2 by the given angle
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the matrix to rotate
   * @param {Number} rad the angle to rotate the matrix by
   * @returns {mat2} out
   */

  function rotate(out, a, rad) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3]

    var s = Math.sin(rad)

    var c = Math.cos(rad)

    out[0] = a0 * c + a2 * s

    out[1] = a1 * c + a3 * s

    out[2] = a0 * -s + a2 * c

    out[3] = a1 * -s + a3 * c

    return out
  }
  /**
   * Scales the mat2 by the dimensions in the given vec2
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the matrix to rotate
   * @param {ReadonlyVec2} v the vec2 to scale the matrix by
   * @returns {mat2} out
   **/

  function scale(out, a, v) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3]

    var v0 = v[0],
      v1 = v[1]

    out[0] = a0 * v0

    out[1] = a1 * v0

    out[2] = a2 * v1

    out[3] = a3 * v1

    return out
  }
  /**
     * Creates a matrix from a given angle
     * This is equivalent to (but much faster than):
     *
     *     mat2.identity(dest);
  
     *     mat2.rotate(dest, dest, rad);
  
     *
     * @param {mat2} out mat2 receiving operation result
     * @param {Number} rad the angle to rotate the matrix by
     * @returns {mat2} out
     */

  function fromRotation(out, rad) {
    var s = Math.sin(rad)

    var c = Math.cos(rad)

    out[0] = c

    out[1] = s

    out[2] = -s

    out[3] = c

    return out
  }
  /**
     * Creates a matrix from a vector scaling
     * This is equivalent to (but much faster than):
     *
     *     mat2.identity(dest);
  
     *     mat2.scale(dest, dest, vec);
  
     *
     * @param {mat2} out mat2 receiving operation result
     * @param {ReadonlyVec2} v Scaling vector
     * @returns {mat2} out
     */

  function fromScaling(out, v) {
    out[0] = v[0]

    out[1] = 0

    out[2] = 0

    out[3] = v[1]

    return out
  }
  /**
   * Returns a string representation of a mat2
   *
   * @param {ReadonlyMat2} a matrix to represent as a string
   * @returns {String} string representation of the matrix
   */

  function str(a) {
    return "mat2(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")"
  }
  /**
   * Returns Frobenius norm of a mat2
   *
   * @param {ReadonlyMat2} a the matrix to calculate Frobenius norm of
   * @returns {Number} Frobenius norm
   */

  function frob(a) {
    return Math.hypot(a[0], a[1], a[2], a[3])
  }
  /**
   * Returns L, D and U matrices (Lower triangular, Diagonal and Upper triangular) by factorizing the input matrix
   * @param {ReadonlyMat2} L the lower triangular matrix
   * @param {ReadonlyMat2} D the diagonal matrix
   * @param {ReadonlyMat2} U the upper triangular matrix
   * @param {ReadonlyMat2} a the input matrix to factorize
   */

  function LDU(L, D, U, a) {
    L[2] = a[2] / a[0]

    U[0] = a[0]

    U[1] = a[1]

    U[3] = a[3] - L[2] * U[1]

    return [L, D, U]
  }
  /**
   * Adds two mat2's
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the first operand
   * @param {ReadonlyMat2} b the second operand
   * @returns {mat2} out
   */

  function add(out, a, b) {
    out[0] = a[0] + b[0]

    out[1] = a[1] + b[1]

    out[2] = a[2] + b[2]

    out[3] = a[3] + b[3]

    return out
  }
  /**
   * Subtracts matrix b from matrix a
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the first operand
   * @param {ReadonlyMat2} b the second operand
   * @returns {mat2} out
   */

  function subtract(out, a, b) {
    out[0] = a[0] - b[0]

    out[1] = a[1] - b[1]

    out[2] = a[2] - b[2]

    out[3] = a[3] - b[3]

    return out
  }
  /**
   * Returns whether or not the matrices have exactly the same elements in the same position (when compared with ===)
   *
   * @param {ReadonlyMat2} a The first matrix.
   * @param {ReadonlyMat2} b The second matrix.
   * @returns {Boolean} True if the matrices are equal, false otherwise.
   */

  function exactEquals(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
  }
  /**
   * Returns whether or not the matrices have approximately the same elements in the same position.
   *
   * @param {ReadonlyMat2} a The first matrix.
   * @param {ReadonlyMat2} b The second matrix.
   * @returns {Boolean} True if the matrices are equal, false otherwise.
   */

  function equals$1(a, b) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3]

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2],
      b3 = b[3]

    return (
      Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
      Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
      Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
      Math.abs(a3 - b3) <= EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3))
    )
  }
  /**
   * Multiply each element of the matrix by a scalar.
   *
   * @param {mat2} out the receiving matrix
   * @param {ReadonlyMat2} a the matrix to scale
   * @param {Number} b amount to scale the matrix's elements by
   * @returns {mat2} out
   */

  function multiplyScalar(out, a, b) {
    out[0] = a[0] * b

    out[1] = a[1] * b

    out[2] = a[2] * b

    out[3] = a[3] * b

    return out
  }
  /**
   * Adds two mat2's after multiplying each element of the second operand by a scalar value.
   *
   * @param {mat2} out the receiving vector
   * @param {ReadonlyMat2} a the first operand
   * @param {ReadonlyMat2} b the second operand
   * @param {Number} scale the amount to scale b's elements by before adding
   * @returns {mat2} out
   */

  function multiplyScalarAndAdd(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale

    out[1] = a[1] + b[1] * scale

    out[2] = a[2] + b[2] * scale

    out[3] = a[3] + b[3] * scale

    return out
  }
  /**
   * Alias for {@link mat2.multiply}
   * @function
   */

  var mul = multiply

  /**
   * Alias for {@link mat2.subtract}
   * @function
   */

  var sub = subtract

  var mat2 = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    create: create,
    clone: clone,
    copy: copy,
    identity: identity,
    fromValues: fromValues,
    set: set,
    transpose: transpose,
    invert: invert,
    adjoint: adjoint,
    determinant: determinant,
    multiply: multiply,
    rotate: rotate,
    scale: scale,
    fromRotation: fromRotation,
    fromScaling: fromScaling,
    str: str,
    frob: frob,
    LDU: LDU,
    add: add,
    subtract: subtract,
    exactEquals: exactEquals,
    equals: equals$1,
    multiplyScalar: multiplyScalar,
    multiplyScalarAndAdd: multiplyScalarAndAdd,
    mul: mul,
    sub: sub,
  })

  /**
   * 2x3 Matrix
   * @module mat2d
   * @description
   * A mat2d contains six elements defined as:
   * <pre>
   * [a, b,
   *  c, d,
   *  tx, ty]
   * </pre>
   * This is a short form for the 3x3 matrix:
   * <pre>
   * [a, b, 0,
   *  c, d, 0,
   *  tx, ty, 1]
   * </pre>
   * The last column is ignored so the array is shorter and operations are faster.
   */

  /**
   * Creates a new identity mat2d
   *
   * @returns {mat2d} a new 2x3 matrix
   */

  function create$1() {
    var out = new ARRAY_TYPE(6)

    if (ARRAY_TYPE != Float32Array) {
      out[1] = 0

      out[2] = 0

      out[4] = 0

      out[5] = 0
    }

    out[0] = 1

    out[3] = 1

    return out
  }
  /**
   * Creates a new mat2d initialized with values from an existing matrix
   *
   * @param {ReadonlyMat2d} a matrix to clone
   * @returns {mat2d} a new 2x3 matrix
   */

  function clone$1(a) {
    var out = new ARRAY_TYPE(6)

    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    out[4] = a[4]

    out[5] = a[5]

    return out
  }
  /**
   * Copy the values from one mat2d to another
   *
   * @param {mat2d} out the receiving matrix
   * @param {ReadonlyMat2d} a the source matrix
   * @returns {mat2d} out
   */

  function copy$1(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    out[4] = a[4]

    out[5] = a[5]

    return out
  }
  /**
   * Set a mat2d to the identity matrix
   *
   * @param {mat2d} out the receiving matrix
   * @returns {mat2d} out
   */

  function identity$1(out) {
    out[0] = 1

    out[1] = 0

    out[2] = 0

    out[3] = 1

    out[4] = 0

    out[5] = 0

    return out
  }
  /**
   * Create a new mat2d with the given values
   *
   * @param {Number} a Component A (index 0)
   * @param {Number} b Component B (index 1)
   * @param {Number} c Component C (index 2)
   * @param {Number} d Component D (index 3)
   * @param {Number} tx Component TX (index 4)
   * @param {Number} ty Component TY (index 5)
   * @returns {mat2d} A new mat2d
   */

  function fromValues$1(a, b, c, d, tx, ty) {
    var out = new ARRAY_TYPE(6)

    out[0] = a

    out[1] = b

    out[2] = c

    out[3] = d

    out[4] = tx

    out[5] = ty

    return out
  }
  /**
   * Set the components of a mat2d to the given values
   *
   * @param {mat2d} out the receiving matrix
   * @param {Number} a Component A (index 0)
   * @param {Number} b Component B (index 1)
   * @param {Number} c Component C (index 2)
   * @param {Number} d Component D (index 3)
   * @param {Number} tx Component TX (index 4)
   * @param {Number} ty Component TY (index 5)
   * @returns {mat2d} out
   */

  function set$1(out, a, b, c, d, tx, ty) {
    out[0] = a

    out[1] = b

    out[2] = c

    out[3] = d

    out[4] = tx

    out[5] = ty

    return out
  }
  /**
   * Inverts a mat2d
   *
   * @param {mat2d} out the receiving matrix
   * @param {ReadonlyMat2d} a the source matrix
   * @returns {mat2d} out
   */

  function invert$1(out, a) {
    var aa = a[0],
      ab = a[1],
      ac = a[2],
      ad = a[3]

    var atx = a[4],
      aty = a[5]

    var det = aa * ad - ab * ac

    if (!det) {
      return null
    }

    det = 1.0 / det

    out[0] = ad * det

    out[1] = -ab * det

    out[2] = -ac * det

    out[3] = aa * det

    out[4] = (ac * aty - ad * atx) * det

    out[5] = (ab * atx - aa * aty) * det

    return out
  }
  /**
   * Calculates the determinant of a mat2d
   *
   * @param {ReadonlyMat2d} a the source matrix
   * @returns {Number} determinant of a
   */

  function determinant$1(a) {
    return a[0] * a[3] - a[1] * a[2]
  }
  /**
   * Multiplies two mat2d's
   *
   * @param {mat2d} out the receiving matrix
   * @param {ReadonlyMat2d} a the first operand
   * @param {ReadonlyMat2d} b the second operand
   * @returns {mat2d} out
   */

  function multiply$1(out, a, b) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3],
      a4 = a[4],
      a5 = a[5]

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2],
      b3 = b[3],
      b4 = b[4],
      b5 = b[5]

    out[0] = a0 * b0 + a2 * b1

    out[1] = a1 * b0 + a3 * b1

    out[2] = a0 * b2 + a2 * b3

    out[3] = a1 * b2 + a3 * b3

    out[4] = a0 * b4 + a2 * b5 + a4

    out[5] = a1 * b4 + a3 * b5 + a5

    return out
  }
  /**
   * Rotates a mat2d by the given angle
   *
   * @param {mat2d} out the receiving matrix
   * @param {ReadonlyMat2d} a the matrix to rotate
   * @param {Number} rad the angle to rotate the matrix by
   * @returns {mat2d} out
   */

  function rotate$1(out, a, rad) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3],
      a4 = a[4],
      a5 = a[5]

    var s = Math.sin(rad)

    var c = Math.cos(rad)

    out[0] = a0 * c + a2 * s

    out[1] = a1 * c + a3 * s

    out[2] = a0 * -s + a2 * c

    out[3] = a1 * -s + a3 * c

    out[4] = a4

    out[5] = a5

    return out
  }
  /**
   * Scales the mat2d by the dimensions in the given vec2
   *
   * @param {mat2d} out the receiving matrix
   * @param {ReadonlyMat2d} a the matrix to translate
   * @param {ReadonlyVec2} v the vec2 to scale the matrix by
   * @returns {mat2d} out
   **/

  function scale$1(out, a, v) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3],
      a4 = a[4],
      a5 = a[5]

    var v0 = v[0],
      v1 = v[1]

    out[0] = a0 * v0

    out[1] = a1 * v0

    out[2] = a2 * v1

    out[3] = a3 * v1

    out[4] = a4

    out[5] = a5

    return out
  }
  /**
   * Translates the mat2d by the dimensions in the given vec2
   *
   * @param {mat2d} out the receiving matrix
   * @param {ReadonlyMat2d} a the matrix to translate
   * @param {ReadonlyVec2} v the vec2 to translate the matrix by
   * @returns {mat2d} out
   **/

  function translate(out, a, v) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3],
      a4 = a[4],
      a5 = a[5]

    var v0 = v[0],
      v1 = v[1]

    out[0] = a0

    out[1] = a1

    out[2] = a2

    out[3] = a3

    out[4] = a0 * v0 + a2 * v1 + a4

    out[5] = a1 * v0 + a3 * v1 + a5

    return out
  }
  /**
     * Creates a matrix from a given angle
     * This is equivalent to (but much faster than):
     *
     *     mat2d.identity(dest);
  
     *     mat2d.rotate(dest, dest, rad);
  
     *
     * @param {mat2d} out mat2d receiving operation result
     * @param {Number} rad the angle to rotate the matrix by
     * @returns {mat2d} out
     */

  function fromRotation$1(out, rad) {
    var s = Math.sin(rad),
      c = Math.cos(rad)

    out[0] = c

    out[1] = s

    out[2] = -s

    out[3] = c

    out[4] = 0

    out[5] = 0

    return out
  }
  /**
     * Creates a matrix from a vector scaling
     * This is equivalent to (but much faster than):
     *
     *     mat2d.identity(dest);
  
     *     mat2d.scale(dest, dest, vec);
  
     *
     * @param {mat2d} out mat2d receiving operation result
     * @param {ReadonlyVec2} v Scaling vector
     * @returns {mat2d} out
     */

  function fromScaling$1(out, v) {
    out[0] = v[0]

    out[1] = 0

    out[2] = 0

    out[3] = v[1]

    out[4] = 0

    out[5] = 0

    return out
  }
  /**
     * Creates a matrix from a vector translation
     * This is equivalent to (but much faster than):
     *
     *     mat2d.identity(dest);
  
     *     mat2d.translate(dest, dest, vec);
  
     *
     * @param {mat2d} out mat2d receiving operation result
     * @param {ReadonlyVec2} v Translation vector
     * @returns {mat2d} out
     */

  function fromTranslation(out, v) {
    out[0] = 1

    out[1] = 0

    out[2] = 0

    out[3] = 1

    out[4] = v[0]

    out[5] = v[1]

    return out
  }
  /**
   * Returns a string representation of a mat2d
   *
   * @param {ReadonlyMat2d} a matrix to represent as a string
   * @returns {String} string representation of the matrix
   */

  function str$1(a) {
    return "mat2d(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ", " + a[4] + ", " + a[5] + ")"
  }
  /**
   * Returns Frobenius norm of a mat2d
   *
   * @param {ReadonlyMat2d} a the matrix to calculate Frobenius norm of
   * @returns {Number} Frobenius norm
   */

  function frob$1(a) {
    return Math.hypot(a[0], a[1], a[2], a[3], a[4], a[5], 1)
  }
  /**
   * Adds two mat2d's
   *
   * @param {mat2d} out the receiving matrix
   * @param {ReadonlyMat2d} a the first operand
   * @param {ReadonlyMat2d} b the second operand
   * @returns {mat2d} out
   */

  function add$1(out, a, b) {
    out[0] = a[0] + b[0]

    out[1] = a[1] + b[1]

    out[2] = a[2] + b[2]

    out[3] = a[3] + b[3]

    out[4] = a[4] + b[4]

    out[5] = a[5] + b[5]

    return out
  }
  /**
   * Subtracts matrix b from matrix a
   *
   * @param {mat2d} out the receiving matrix
   * @param {ReadonlyMat2d} a the first operand
   * @param {ReadonlyMat2d} b the second operand
   * @returns {mat2d} out
   */

  function subtract$1(out, a, b) {
    out[0] = a[0] - b[0]

    out[1] = a[1] - b[1]

    out[2] = a[2] - b[2]

    out[3] = a[3] - b[3]

    out[4] = a[4] - b[4]

    out[5] = a[5] - b[5]

    return out
  }
  /**
   * Multiply each element of the matrix by a scalar.
   *
   * @param {mat2d} out the receiving matrix
   * @param {ReadonlyMat2d} a the matrix to scale
   * @param {Number} b amount to scale the matrix's elements by
   * @returns {mat2d} out
   */

  function multiplyScalar$1(out, a, b) {
    out[0] = a[0] * b

    out[1] = a[1] * b

    out[2] = a[2] * b

    out[3] = a[3] * b

    out[4] = a[4] * b

    out[5] = a[5] * b

    return out
  }
  /**
   * Adds two mat2d's after multiplying each element of the second operand by a scalar value.
   *
   * @param {mat2d} out the receiving vector
   * @param {ReadonlyMat2d} a the first operand
   * @param {ReadonlyMat2d} b the second operand
   * @param {Number} scale the amount to scale b's elements by before adding
   * @returns {mat2d} out
   */

  function multiplyScalarAndAdd$1(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale

    out[1] = a[1] + b[1] * scale

    out[2] = a[2] + b[2] * scale

    out[3] = a[3] + b[3] * scale

    out[4] = a[4] + b[4] * scale

    out[5] = a[5] + b[5] * scale

    return out
  }
  /**
   * Returns whether or not the matrices have exactly the same elements in the same position (when compared with ===)
   *
   * @param {ReadonlyMat2d} a The first matrix.
   * @param {ReadonlyMat2d} b The second matrix.
   * @returns {Boolean} True if the matrices are equal, false otherwise.
   */

  function exactEquals$1(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5]
  }
  /**
   * Returns whether or not the matrices have approximately the same elements in the same position.
   *
   * @param {ReadonlyMat2d} a The first matrix.
   * @param {ReadonlyMat2d} b The second matrix.
   * @returns {Boolean} True if the matrices are equal, false otherwise.
   */

  function equals$2(a, b) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3],
      a4 = a[4],
      a5 = a[5]

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2],
      b3 = b[3],
      b4 = b[4],
      b5 = b[5]

    return (
      Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
      Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
      Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
      Math.abs(a3 - b3) <= EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3)) &&
      Math.abs(a4 - b4) <= EPSILON * Math.max(1.0, Math.abs(a4), Math.abs(b4)) &&
      Math.abs(a5 - b5) <= EPSILON * Math.max(1.0, Math.abs(a5), Math.abs(b5))
    )
  }
  /**
   * Alias for {@link mat2d.multiply}
   * @function
   */

  var mul$1 = multiply$1

  /**
   * Alias for {@link mat2d.subtract}
   * @function
   */

  var sub$1 = subtract$1

  var mat2d = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    create: create$1,
    clone: clone$1,
    copy: copy$1,
    identity: identity$1,
    fromValues: fromValues$1,
    set: set$1,
    invert: invert$1,
    determinant: determinant$1,
    multiply: multiply$1,
    rotate: rotate$1,
    scale: scale$1,
    translate: translate,
    fromRotation: fromRotation$1,
    fromScaling: fromScaling$1,
    fromTranslation: fromTranslation,
    str: str$1,
    frob: frob$1,
    add: add$1,
    subtract: subtract$1,
    multiplyScalar: multiplyScalar$1,
    multiplyScalarAndAdd: multiplyScalarAndAdd$1,
    exactEquals: exactEquals$1,
    equals: equals$2,
    mul: mul$1,
    sub: sub$1,
  })

  /**
   * 3x3 Matrix
   * @module mat3
   */

  /**
   * Creates a new identity mat3
   *
   * @returns {mat3} a new 3x3 matrix
   */

  function create$2() {
    var out = new ARRAY_TYPE(9)

    if (ARRAY_TYPE != Float32Array) {
      out[1] = 0

      out[2] = 0

      out[3] = 0

      out[5] = 0

      out[6] = 0

      out[7] = 0
    }

    out[0] = 1

    out[4] = 1

    out[8] = 1

    return out
  }
  /**
   * Copies the upper-left 3x3 values into the given mat3.
   *
   * @param {mat3} out the receiving 3x3 matrix
   * @param {ReadonlyMat4} a   the source 4x4 matrix
   * @returns {mat3} out
   */

  function fromMat4(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[4]

    out[4] = a[5]

    out[5] = a[6]

    out[6] = a[8]

    out[7] = a[9]

    out[8] = a[10]

    return out
  }
  /**
   * Creates a new mat3 initialized with values from an existing matrix
   *
   * @param {ReadonlyMat3} a matrix to clone
   * @returns {mat3} a new 3x3 matrix
   */

  function clone$2(a) {
    var out = new ARRAY_TYPE(9)

    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    out[4] = a[4]

    out[5] = a[5]

    out[6] = a[6]

    out[7] = a[7]

    out[8] = a[8]

    return out
  }
  /**
   * Copy the values from one mat3 to another
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the source matrix
   * @returns {mat3} out
   */

  function copy$2(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    out[4] = a[4]

    out[5] = a[5]

    out[6] = a[6]

    out[7] = a[7]

    out[8] = a[8]

    return out
  }
  /**
   * Create a new mat3 with the given values
   *
   * @param {Number} m00 Component in column 0, row 0 position (index 0)
   * @param {Number} m01 Component in column 0, row 1 position (index 1)
   * @param {Number} m02 Component in column 0, row 2 position (index 2)
   * @param {Number} m10 Component in column 1, row 0 position (index 3)
   * @param {Number} m11 Component in column 1, row 1 position (index 4)
   * @param {Number} m12 Component in column 1, row 2 position (index 5)
   * @param {Number} m20 Component in column 2, row 0 position (index 6)
   * @param {Number} m21 Component in column 2, row 1 position (index 7)
   * @param {Number} m22 Component in column 2, row 2 position (index 8)
   * @returns {mat3} A new mat3
   */

  function fromValues$2(m00, m01, m02, m10, m11, m12, m20, m21, m22) {
    var out = new ARRAY_TYPE(9)

    out[0] = m00

    out[1] = m01

    out[2] = m02

    out[3] = m10

    out[4] = m11

    out[5] = m12

    out[6] = m20

    out[7] = m21

    out[8] = m22

    return out
  }
  /**
   * Set the components of a mat3 to the given values
   *
   * @param {mat3} out the receiving matrix
   * @param {Number} m00 Component in column 0, row 0 position (index 0)
   * @param {Number} m01 Component in column 0, row 1 position (index 1)
   * @param {Number} m02 Component in column 0, row 2 position (index 2)
   * @param {Number} m10 Component in column 1, row 0 position (index 3)
   * @param {Number} m11 Component in column 1, row 1 position (index 4)
   * @param {Number} m12 Component in column 1, row 2 position (index 5)
   * @param {Number} m20 Component in column 2, row 0 position (index 6)
   * @param {Number} m21 Component in column 2, row 1 position (index 7)
   * @param {Number} m22 Component in column 2, row 2 position (index 8)
   * @returns {mat3} out
   */

  function set$2(out, m00, m01, m02, m10, m11, m12, m20, m21, m22) {
    out[0] = m00

    out[1] = m01

    out[2] = m02

    out[3] = m10

    out[4] = m11

    out[5] = m12

    out[6] = m20

    out[7] = m21

    out[8] = m22

    return out
  }
  /**
   * Set a mat3 to the identity matrix
   *
   * @param {mat3} out the receiving matrix
   * @returns {mat3} out
   */

  function identity$2(out) {
    out[0] = 1

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = 1

    out[5] = 0

    out[6] = 0

    out[7] = 0

    out[8] = 1

    return out
  }
  /**
   * Transpose the values of a mat3
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the source matrix
   * @returns {mat3} out
   */

  function transpose$1(out, a) {
    // If we are transposing ourselves we can skip a few steps but have to cache some values
    if (out === a) {
      var a01 = a[1],
        a02 = a[2],
        a12 = a[5]

      out[1] = a[3]

      out[2] = a[6]

      out[3] = a01

      out[5] = a[7]

      out[6] = a02

      out[7] = a12
    } else {
      out[0] = a[0]

      out[1] = a[3]

      out[2] = a[6]

      out[3] = a[1]

      out[4] = a[4]

      out[5] = a[7]

      out[6] = a[2]

      out[7] = a[5]

      out[8] = a[8]
    }

    return out
  }
  /**
   * Inverts a mat3
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the source matrix
   * @returns {mat3} out
   */

  function invert$2(out, a) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2]

    var a10 = a[3],
      a11 = a[4],
      a12 = a[5]

    var a20 = a[6],
      a21 = a[7],
      a22 = a[8]

    var b01 = a22 * a11 - a12 * a21

    var b11 = -a22 * a10 + a12 * a20

    var b21 = a21 * a10 - a11 * a20
    // Calculate the determinant

    var det = a00 * b01 + a01 * b11 + a02 * b21

    if (!det) {
      return null
    }

    det = 1.0 / det

    out[0] = b01 * det

    out[1] = (-a22 * a01 + a02 * a21) * det

    out[2] = (a12 * a01 - a02 * a11) * det

    out[3] = b11 * det

    out[4] = (a22 * a00 - a02 * a20) * det

    out[5] = (-a12 * a00 + a02 * a10) * det

    out[6] = b21 * det

    out[7] = (-a21 * a00 + a01 * a20) * det

    out[8] = (a11 * a00 - a01 * a10) * det

    return out
  }
  /**
   * Calculates the adjugate of a mat3
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the source matrix
   * @returns {mat3} out
   */

  function adjoint$1(out, a) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2]

    var a10 = a[3],
      a11 = a[4],
      a12 = a[5]

    var a20 = a[6],
      a21 = a[7],
      a22 = a[8]

    out[0] = a11 * a22 - a12 * a21

    out[1] = a02 * a21 - a01 * a22

    out[2] = a01 * a12 - a02 * a11

    out[3] = a12 * a20 - a10 * a22

    out[4] = a00 * a22 - a02 * a20

    out[5] = a02 * a10 - a00 * a12

    out[6] = a10 * a21 - a11 * a20

    out[7] = a01 * a20 - a00 * a21

    out[8] = a00 * a11 - a01 * a10

    return out
  }
  /**
   * Calculates the determinant of a mat3
   *
   * @param {ReadonlyMat3} a the source matrix
   * @returns {Number} determinant of a
   */

  function determinant$2(a) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2]

    var a10 = a[3],
      a11 = a[4],
      a12 = a[5]

    var a20 = a[6],
      a21 = a[7],
      a22 = a[8]

    return a00 * (a22 * a11 - a12 * a21) + a01 * (-a22 * a10 + a12 * a20) + a02 * (a21 * a10 - a11 * a20)
  }
  /**
   * Multiplies two mat3's
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the first operand
   * @param {ReadonlyMat3} b the second operand
   * @returns {mat3} out
   */

  function multiply$2(out, a, b) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2]

    var a10 = a[3],
      a11 = a[4],
      a12 = a[5]

    var a20 = a[6],
      a21 = a[7],
      a22 = a[8]

    var b00 = b[0],
      b01 = b[1],
      b02 = b[2]

    var b10 = b[3],
      b11 = b[4],
      b12 = b[5]

    var b20 = b[6],
      b21 = b[7],
      b22 = b[8]

    out[0] = b00 * a00 + b01 * a10 + b02 * a20

    out[1] = b00 * a01 + b01 * a11 + b02 * a21

    out[2] = b00 * a02 + b01 * a12 + b02 * a22

    out[3] = b10 * a00 + b11 * a10 + b12 * a20

    out[4] = b10 * a01 + b11 * a11 + b12 * a21

    out[5] = b10 * a02 + b11 * a12 + b12 * a22

    out[6] = b20 * a00 + b21 * a10 + b22 * a20

    out[7] = b20 * a01 + b21 * a11 + b22 * a21

    out[8] = b20 * a02 + b21 * a12 + b22 * a22

    return out
  }
  /**
   * Translate a mat3 by the given vector
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the matrix to translate
   * @param {ReadonlyVec2} v vector to translate by
   * @returns {mat3} out
   */

  function translate$1(out, a, v) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2],
      a10 = a[3],
      a11 = a[4],
      a12 = a[5],
      a20 = a[6],
      a21 = a[7],
      a22 = a[8],
      x = v[0],
      y = v[1]

    out[0] = a00

    out[1] = a01

    out[2] = a02

    out[3] = a10

    out[4] = a11

    out[5] = a12

    out[6] = x * a00 + y * a10 + a20

    out[7] = x * a01 + y * a11 + a21

    out[8] = x * a02 + y * a12 + a22

    return out
  }
  /**
   * Rotates a mat3 by the given angle
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the matrix to rotate
   * @param {Number} rad the angle to rotate the matrix by
   * @returns {mat3} out
   */

  function rotate$2(out, a, rad) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2],
      a10 = a[3],
      a11 = a[4],
      a12 = a[5],
      a20 = a[6],
      a21 = a[7],
      a22 = a[8],
      s = Math.sin(rad),
      c = Math.cos(rad)

    out[0] = c * a00 + s * a10

    out[1] = c * a01 + s * a11

    out[2] = c * a02 + s * a12

    out[3] = c * a10 - s * a00

    out[4] = c * a11 - s * a01

    out[5] = c * a12 - s * a02

    out[6] = a20

    out[7] = a21

    out[8] = a22

    return out
  }
  /**
   * Scales the mat3 by the dimensions in the given vec2
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the matrix to rotate
   * @param {ReadonlyVec2} v the vec2 to scale the matrix by
   * @returns {mat3} out
   **/

  function scale$2(out, a, v) {
    var x = v[0],
      y = v[1]

    out[0] = x * a[0]

    out[1] = x * a[1]

    out[2] = x * a[2]

    out[3] = y * a[3]

    out[4] = y * a[4]

    out[5] = y * a[5]

    out[6] = a[6]

    out[7] = a[7]

    out[8] = a[8]

    return out
  }
  /**
     * Creates a matrix from a vector translation
     * This is equivalent to (but much faster than):
     *
     *     mat3.identity(dest);
  
     *     mat3.translate(dest, dest, vec);
  
     *
     * @param {mat3} out mat3 receiving operation result
     * @param {ReadonlyVec2} v Translation vector
     * @returns {mat3} out
     */

  function fromTranslation$1(out, v) {
    out[0] = 1

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = 1

    out[5] = 0

    out[6] = v[0]

    out[7] = v[1]

    out[8] = 1

    return out
  }
  /**
     * Creates a matrix from a given angle
     * This is equivalent to (but much faster than):
     *
     *     mat3.identity(dest);
  
     *     mat3.rotate(dest, dest, rad);
  
     *
     * @param {mat3} out mat3 receiving operation result
     * @param {Number} rad the angle to rotate the matrix by
     * @returns {mat3} out
     */

  function fromRotation$2(out, rad) {
    var s = Math.sin(rad),
      c = Math.cos(rad)

    out[0] = c

    out[1] = s

    out[2] = 0

    out[3] = -s

    out[4] = c

    out[5] = 0

    out[6] = 0

    out[7] = 0

    out[8] = 1

    return out
  }
  /**
     * Creates a matrix from a vector scaling
     * This is equivalent to (but much faster than):
     *
     *     mat3.identity(dest);
  
     *     mat3.scale(dest, dest, vec);
  
     *
     * @param {mat3} out mat3 receiving operation result
     * @param {ReadonlyVec2} v Scaling vector
     * @returns {mat3} out
     */

  function fromScaling$2(out, v) {
    out[0] = v[0]

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = v[1]

    out[5] = 0

    out[6] = 0

    out[7] = 0

    out[8] = 1

    return out
  }
  /**
   * Copies the values from a mat2d into a mat3
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat2d} a the matrix to copy
   * @returns {mat3} out
   **/

  function fromMat2d(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    out[2] = 0

    out[3] = a[2]

    out[4] = a[3]

    out[5] = 0

    out[6] = a[4]

    out[7] = a[5]

    out[8] = 1

    return out
  }
  /**
   * Calculates a 3x3 matrix from the given quaternion
   *
   * @param {mat3} out mat3 receiving operation result
   * @param {ReadonlyQuat} q Quaternion to create matrix from
   *
   * @returns {mat3} out
   */

  function fromQuat(out, q) {
    var x = q[0],
      y = q[1],
      z = q[2],
      w = q[3]

    var x2 = x + x

    var y2 = y + y

    var z2 = z + z

    var xx = x * x2

    var yx = y * x2

    var yy = y * y2

    var zx = z * x2

    var zy = z * y2

    var zz = z * z2

    var wx = w * x2

    var wy = w * y2

    var wz = w * z2

    out[0] = 1 - yy - zz

    out[3] = yx - wz

    out[6] = zx + wy

    out[1] = yx + wz

    out[4] = 1 - xx - zz

    out[7] = zy - wx

    out[2] = zx - wy

    out[5] = zy + wx

    out[8] = 1 - xx - yy

    return out
  }
  /**
   * Calculates a 3x3 normal matrix (transpose inverse) from the 4x4 matrix
   *
   * @param {mat3} out mat3 receiving operation result
   * @param {ReadonlyMat4} a Mat4 to derive the normal matrix from
   *
   * @returns {mat3} out
   */

  function normalFromMat4(out, a) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2],
      a03 = a[3]

    var a10 = a[4],
      a11 = a[5],
      a12 = a[6],
      a13 = a[7]

    var a20 = a[8],
      a21 = a[9],
      a22 = a[10],
      a23 = a[11]

    var a30 = a[12],
      a31 = a[13],
      a32 = a[14],
      a33 = a[15]

    var b00 = a00 * a11 - a01 * a10

    var b01 = a00 * a12 - a02 * a10

    var b02 = a00 * a13 - a03 * a10

    var b03 = a01 * a12 - a02 * a11

    var b04 = a01 * a13 - a03 * a11

    var b05 = a02 * a13 - a03 * a12

    var b06 = a20 * a31 - a21 * a30

    var b07 = a20 * a32 - a22 * a30

    var b08 = a20 * a33 - a23 * a30

    var b09 = a21 * a32 - a22 * a31

    var b10 = a21 * a33 - a23 * a31

    var b11 = a22 * a33 - a23 * a32
    // Calculate the determinant

    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06

    if (!det) {
      return null
    }

    det = 1.0 / det

    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det

    out[1] = (a12 * b08 - a10 * b11 - a13 * b07) * det

    out[2] = (a10 * b10 - a11 * b08 + a13 * b06) * det

    out[3] = (a02 * b10 - a01 * b11 - a03 * b09) * det

    out[4] = (a00 * b11 - a02 * b08 + a03 * b07) * det

    out[5] = (a01 * b08 - a00 * b10 - a03 * b06) * det

    out[6] = (a31 * b05 - a32 * b04 + a33 * b03) * det

    out[7] = (a32 * b02 - a30 * b05 - a33 * b01) * det

    out[8] = (a30 * b04 - a31 * b02 + a33 * b00) * det

    return out
  }
  /**
   * Generates a 2D projection matrix with the given bounds
   *
   * @param {mat3} out mat3 frustum matrix will be written into
   * @param {number} width Width of your gl context
   * @param {number} height Height of gl context
   * @returns {mat3} out
   */

  function projection(out, width, height) {
    out[0] = 2 / width

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = -2 / height

    out[5] = 0

    out[6] = -1

    out[7] = 1

    out[8] = 1

    return out
  }
  /**
   * Returns a string representation of a mat3
   *
   * @param {ReadonlyMat3} a matrix to represent as a string
   * @returns {String} string representation of the matrix
   */

  function str$2(a) {
    return (
      "mat3(" +
      a[0] +
      ", " +
      a[1] +
      ", " +
      a[2] +
      ", " +
      a[3] +
      ", " +
      a[4] +
      ", " +
      a[5] +
      ", " +
      a[6] +
      ", " +
      a[7] +
      ", " +
      a[8] +
      ")"
    )
  }
  /**
   * Returns Frobenius norm of a mat3
   *
   * @param {ReadonlyMat3} a the matrix to calculate Frobenius norm of
   * @returns {Number} Frobenius norm
   */

  function frob$2(a) {
    return Math.hypot(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8])
  }
  /**
   * Adds two mat3's
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the first operand
   * @param {ReadonlyMat3} b the second operand
   * @returns {mat3} out
   */

  function add$2(out, a, b) {
    out[0] = a[0] + b[0]

    out[1] = a[1] + b[1]

    out[2] = a[2] + b[2]

    out[3] = a[3] + b[3]

    out[4] = a[4] + b[4]

    out[5] = a[5] + b[5]

    out[6] = a[6] + b[6]

    out[7] = a[7] + b[7]

    out[8] = a[8] + b[8]

    return out
  }
  /**
   * Subtracts matrix b from matrix a
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the first operand
   * @param {ReadonlyMat3} b the second operand
   * @returns {mat3} out
   */

  function subtract$2(out, a, b) {
    out[0] = a[0] - b[0]

    out[1] = a[1] - b[1]

    out[2] = a[2] - b[2]

    out[3] = a[3] - b[3]

    out[4] = a[4] - b[4]

    out[5] = a[5] - b[5]

    out[6] = a[6] - b[6]

    out[7] = a[7] - b[7]

    out[8] = a[8] - b[8]

    return out
  }
  /**
   * Multiply each element of the matrix by a scalar.
   *
   * @param {mat3} out the receiving matrix
   * @param {ReadonlyMat3} a the matrix to scale
   * @param {Number} b amount to scale the matrix's elements by
   * @returns {mat3} out
   */

  function multiplyScalar$2(out, a, b) {
    out[0] = a[0] * b

    out[1] = a[1] * b

    out[2] = a[2] * b

    out[3] = a[3] * b

    out[4] = a[4] * b

    out[5] = a[5] * b

    out[6] = a[6] * b

    out[7] = a[7] * b

    out[8] = a[8] * b

    return out
  }
  /**
   * Adds two mat3's after multiplying each element of the second operand by a scalar value.
   *
   * @param {mat3} out the receiving vector
   * @param {ReadonlyMat3} a the first operand
   * @param {ReadonlyMat3} b the second operand
   * @param {Number} scale the amount to scale b's elements by before adding
   * @returns {mat3} out
   */

  function multiplyScalarAndAdd$2(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale

    out[1] = a[1] + b[1] * scale

    out[2] = a[2] + b[2] * scale

    out[3] = a[3] + b[3] * scale

    out[4] = a[4] + b[4] * scale

    out[5] = a[5] + b[5] * scale

    out[6] = a[6] + b[6] * scale

    out[7] = a[7] + b[7] * scale

    out[8] = a[8] + b[8] * scale

    return out
  }
  /**
   * Returns whether or not the matrices have exactly the same elements in the same position (when compared with ===)
   *
   * @param {ReadonlyMat3} a The first matrix.
   * @param {ReadonlyMat3} b The second matrix.
   * @returns {Boolean} True if the matrices are equal, false otherwise.
   */

  function exactEquals$2(a, b) {
    return (
      a[0] === b[0] &&
      a[1] === b[1] &&
      a[2] === b[2] &&
      a[3] === b[3] &&
      a[4] === b[4] &&
      a[5] === b[5] &&
      a[6] === b[6] &&
      a[7] === b[7] &&
      a[8] === b[8]
    )
  }
  /**
   * Returns whether or not the matrices have approximately the same elements in the same position.
   *
   * @param {ReadonlyMat3} a The first matrix.
   * @param {ReadonlyMat3} b The second matrix.
   * @returns {Boolean} True if the matrices are equal, false otherwise.
   */

  function equals$3(a, b) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3],
      a4 = a[4],
      a5 = a[5],
      a6 = a[6],
      a7 = a[7],
      a8 = a[8]

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2],
      b3 = b[3],
      b4 = b[4],
      b5 = b[5],
      b6 = b[6],
      b7 = b[7],
      b8 = b[8]

    return (
      Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
      Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
      Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
      Math.abs(a3 - b3) <= EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3)) &&
      Math.abs(a4 - b4) <= EPSILON * Math.max(1.0, Math.abs(a4), Math.abs(b4)) &&
      Math.abs(a5 - b5) <= EPSILON * Math.max(1.0, Math.abs(a5), Math.abs(b5)) &&
      Math.abs(a6 - b6) <= EPSILON * Math.max(1.0, Math.abs(a6), Math.abs(b6)) &&
      Math.abs(a7 - b7) <= EPSILON * Math.max(1.0, Math.abs(a7), Math.abs(b7)) &&
      Math.abs(a8 - b8) <= EPSILON * Math.max(1.0, Math.abs(a8), Math.abs(b8))
    )
  }
  /**
   * Alias for {@link mat3.multiply}
   * @function
   */

  var mul$2 = multiply$2

  /**
   * Alias for {@link mat3.subtract}
   * @function
   */

  var sub$2 = subtract$2

  var mat3 = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    create: create$2,
    fromMat4: fromMat4,
    clone: clone$2,
    copy: copy$2,
    fromValues: fromValues$2,
    set: set$2,
    identity: identity$2,
    transpose: transpose$1,
    invert: invert$2,
    adjoint: adjoint$1,
    determinant: determinant$2,
    multiply: multiply$2,
    translate: translate$1,
    rotate: rotate$2,
    scale: scale$2,
    fromTranslation: fromTranslation$1,
    fromRotation: fromRotation$2,
    fromScaling: fromScaling$2,
    fromMat2d: fromMat2d,
    fromQuat: fromQuat,
    normalFromMat4: normalFromMat4,
    projection: projection,
    str: str$2,
    frob: frob$2,
    add: add$2,
    subtract: subtract$2,
    multiplyScalar: multiplyScalar$2,
    multiplyScalarAndAdd: multiplyScalarAndAdd$2,
    exactEquals: exactEquals$2,
    equals: equals$3,
    mul: mul$2,
    sub: sub$2,
  })

  /**
   * 4x4 Matrix<br>Format: column-major, when typed out it looks like row-major<br>The matrices are being post multiplied.
   * @module mat4
   */

  /**
   * Creates a new identity mat4
   *
   * @returns {mat4} a new 4x4 matrix
   */

  function create$3() {
    var out = new ARRAY_TYPE(16)

    if (ARRAY_TYPE != Float32Array) {
      out[1] = 0

      out[2] = 0

      out[3] = 0

      out[4] = 0

      out[6] = 0

      out[7] = 0

      out[8] = 0

      out[9] = 0

      out[11] = 0

      out[12] = 0

      out[13] = 0

      out[14] = 0
    }

    out[0] = 1

    out[5] = 1

    out[10] = 1

    out[15] = 1

    return out
  }
  /**
   * Creates a new mat4 initialized with values from an existing matrix
   *
   * @param {ReadonlyMat4} a matrix to clone
   * @returns {mat4} a new 4x4 matrix
   */

  function clone$3(a) {
    var out = new ARRAY_TYPE(16)

    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    out[4] = a[4]

    out[5] = a[5]

    out[6] = a[6]

    out[7] = a[7]

    out[8] = a[8]

    out[9] = a[9]

    out[10] = a[10]

    out[11] = a[11]

    out[12] = a[12]

    out[13] = a[13]

    out[14] = a[14]

    out[15] = a[15]

    return out
  }
  /**
   * Copy the values from one mat4 to another
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the source matrix
   * @returns {mat4} out
   */

  function copy$3(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    out[4] = a[4]

    out[5] = a[5]

    out[6] = a[6]

    out[7] = a[7]

    out[8] = a[8]

    out[9] = a[9]

    out[10] = a[10]

    out[11] = a[11]

    out[12] = a[12]

    out[13] = a[13]

    out[14] = a[14]

    out[15] = a[15]

    return out
  }
  /**
   * Create a new mat4 with the given values
   *
   * @param {Number} m00 Component in column 0, row 0 position (index 0)
   * @param {Number} m01 Component in column 0, row 1 position (index 1)
   * @param {Number} m02 Component in column 0, row 2 position (index 2)
   * @param {Number} m03 Component in column 0, row 3 position (index 3)
   * @param {Number} m10 Component in column 1, row 0 position (index 4)
   * @param {Number} m11 Component in column 1, row 1 position (index 5)
   * @param {Number} m12 Component in column 1, row 2 position (index 6)
   * @param {Number} m13 Component in column 1, row 3 position (index 7)
   * @param {Number} m20 Component in column 2, row 0 position (index 8)
   * @param {Number} m21 Component in column 2, row 1 position (index 9)
   * @param {Number} m22 Component in column 2, row 2 position (index 10)
   * @param {Number} m23 Component in column 2, row 3 position (index 11)
   * @param {Number} m30 Component in column 3, row 0 position (index 12)
   * @param {Number} m31 Component in column 3, row 1 position (index 13)
   * @param {Number} m32 Component in column 3, row 2 position (index 14)
   * @param {Number} m33 Component in column 3, row 3 position (index 15)
   * @returns {mat4} A new mat4
   */

  function fromValues$3(m00, m01, m02, m03, m10, m11, m12, m13, m20, m21, m22, m23, m30, m31, m32, m33) {
    var out = new ARRAY_TYPE(16)

    out[0] = m00

    out[1] = m01

    out[2] = m02

    out[3] = m03

    out[4] = m10

    out[5] = m11

    out[6] = m12

    out[7] = m13

    out[8] = m20

    out[9] = m21

    out[10] = m22

    out[11] = m23

    out[12] = m30

    out[13] = m31

    out[14] = m32

    out[15] = m33

    return out
  }
  /**
   * Set the components of a mat4 to the given values
   *
   * @param {mat4} out the receiving matrix
   * @param {Number} m00 Component in column 0, row 0 position (index 0)
   * @param {Number} m01 Component in column 0, row 1 position (index 1)
   * @param {Number} m02 Component in column 0, row 2 position (index 2)
   * @param {Number} m03 Component in column 0, row 3 position (index 3)
   * @param {Number} m10 Component in column 1, row 0 position (index 4)
   * @param {Number} m11 Component in column 1, row 1 position (index 5)
   * @param {Number} m12 Component in column 1, row 2 position (index 6)
   * @param {Number} m13 Component in column 1, row 3 position (index 7)
   * @param {Number} m20 Component in column 2, row 0 position (index 8)
   * @param {Number} m21 Component in column 2, row 1 position (index 9)
   * @param {Number} m22 Component in column 2, row 2 position (index 10)
   * @param {Number} m23 Component in column 2, row 3 position (index 11)
   * @param {Number} m30 Component in column 3, row 0 position (index 12)
   * @param {Number} m31 Component in column 3, row 1 position (index 13)
   * @param {Number} m32 Component in column 3, row 2 position (index 14)
   * @param {Number} m33 Component in column 3, row 3 position (index 15)
   * @returns {mat4} out
   */

  function set$3(out, m00, m01, m02, m03, m10, m11, m12, m13, m20, m21, m22, m23, m30, m31, m32, m33) {
    out[0] = m00

    out[1] = m01

    out[2] = m02

    out[3] = m03

    out[4] = m10

    out[5] = m11

    out[6] = m12

    out[7] = m13

    out[8] = m20

    out[9] = m21

    out[10] = m22

    out[11] = m23

    out[12] = m30

    out[13] = m31

    out[14] = m32

    out[15] = m33

    return out
  }
  /**
   * Set a mat4 to the identity matrix
   *
   * @param {mat4} out the receiving matrix
   * @returns {mat4} out
   */

  function identity$3(out) {
    out[0] = 1

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = 0

    out[5] = 1

    out[6] = 0

    out[7] = 0

    out[8] = 0

    out[9] = 0

    out[10] = 1

    out[11] = 0

    out[12] = 0

    out[13] = 0

    out[14] = 0

    out[15] = 1

    return out
  }
  /**
   * Transpose the values of a mat4
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the source matrix
   * @returns {mat4} out
   */

  function transpose$2(out, a) {
    // If we are transposing ourselves we can skip a few steps but have to cache some values
    if (out === a) {
      var a01 = a[1],
        a02 = a[2],
        a03 = a[3]

      var a12 = a[6],
        a13 = a[7]

      var a23 = a[11]

      out[1] = a[4]

      out[2] = a[8]

      out[3] = a[12]

      out[4] = a01

      out[6] = a[9]

      out[7] = a[13]

      out[8] = a02

      out[9] = a12

      out[11] = a[14]

      out[12] = a03

      out[13] = a13

      out[14] = a23
    } else {
      out[0] = a[0]

      out[1] = a[4]

      out[2] = a[8]

      out[3] = a[12]

      out[4] = a[1]

      out[5] = a[5]

      out[6] = a[9]

      out[7] = a[13]

      out[8] = a[2]

      out[9] = a[6]

      out[10] = a[10]

      out[11] = a[14]

      out[12] = a[3]

      out[13] = a[7]

      out[14] = a[11]

      out[15] = a[15]
    }

    return out
  }
  /**
   * Inverts a mat4
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the source matrix
   * @returns {mat4} out
   */

  function invert$3(out, a) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2],
      a03 = a[3]

    var a10 = a[4],
      a11 = a[5],
      a12 = a[6],
      a13 = a[7]

    var a20 = a[8],
      a21 = a[9],
      a22 = a[10],
      a23 = a[11]

    var a30 = a[12],
      a31 = a[13],
      a32 = a[14],
      a33 = a[15]

    var b00 = a00 * a11 - a01 * a10

    var b01 = a00 * a12 - a02 * a10

    var b02 = a00 * a13 - a03 * a10

    var b03 = a01 * a12 - a02 * a11

    var b04 = a01 * a13 - a03 * a11

    var b05 = a02 * a13 - a03 * a12

    var b06 = a20 * a31 - a21 * a30

    var b07 = a20 * a32 - a22 * a30

    var b08 = a20 * a33 - a23 * a30

    var b09 = a21 * a32 - a22 * a31

    var b10 = a21 * a33 - a23 * a31

    var b11 = a22 * a33 - a23 * a32
    // Calculate the determinant

    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06

    if (!det) {
      return null
    }

    det = 1.0 / det

    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det

    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det

    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det

    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det

    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det

    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det

    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det

    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det

    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det

    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det

    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det

    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det

    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det

    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det

    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det

    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det

    return out
  }
  /**
   * Calculates the adjugate of a mat4
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the source matrix
   * @returns {mat4} out
   */

  function adjoint$2(out, a) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2],
      a03 = a[3]

    var a10 = a[4],
      a11 = a[5],
      a12 = a[6],
      a13 = a[7]

    var a20 = a[8],
      a21 = a[9],
      a22 = a[10],
      a23 = a[11]

    var a30 = a[12],
      a31 = a[13],
      a32 = a[14],
      a33 = a[15]

    var b00 = a00 * a11 - a01 * a10

    var b01 = a00 * a12 - a02 * a10

    var b02 = a00 * a13 - a03 * a10

    var b03 = a01 * a12 - a02 * a11

    var b04 = a01 * a13 - a03 * a11

    var b05 = a02 * a13 - a03 * a12

    var b06 = a20 * a31 - a21 * a30

    var b07 = a20 * a32 - a22 * a30

    var b08 = a20 * a33 - a23 * a30

    var b09 = a21 * a32 - a22 * a31

    var b10 = a21 * a33 - a23 * a31

    var b11 = a22 * a33 - a23 * a32

    out[0] = a11 * b11 - a12 * b10 + a13 * b09

    out[1] = a02 * b10 - a01 * b11 - a03 * b09

    out[2] = a31 * b05 - a32 * b04 + a33 * b03

    out[3] = a22 * b04 - a21 * b05 - a23 * b03

    out[4] = a12 * b08 - a10 * b11 - a13 * b07

    out[5] = a00 * b11 - a02 * b08 + a03 * b07

    out[6] = a32 * b02 - a30 * b05 - a33 * b01

    out[7] = a20 * b05 - a22 * b02 + a23 * b01

    out[8] = a10 * b10 - a11 * b08 + a13 * b06

    out[9] = a01 * b08 - a00 * b10 - a03 * b06

    out[10] = a30 * b04 - a31 * b02 + a33 * b00

    out[11] = a21 * b02 - a20 * b04 - a23 * b00

    out[12] = a11 * b07 - a10 * b09 - a12 * b06

    out[13] = a00 * b09 - a01 * b07 + a02 * b06

    out[14] = a31 * b01 - a30 * b03 - a32 * b00

    out[15] = a20 * b03 - a21 * b01 + a22 * b00

    return out
  }
  /**
   * Calculates the determinant of a mat4
   *
   * @param {ReadonlyMat4} a the source matrix
   * @returns {Number} determinant of a
   */

  function determinant$3(a) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2],
      a03 = a[3]

    var a10 = a[4],
      a11 = a[5],
      a12 = a[6],
      a13 = a[7]

    var a20 = a[8],
      a21 = a[9],
      a22 = a[10],
      a23 = a[11]

    var a30 = a[12],
      a31 = a[13],
      a32 = a[14],
      a33 = a[15]

    var b0 = a00 * a11 - a01 * a10

    var b1 = a00 * a12 - a02 * a10

    var b2 = a01 * a12 - a02 * a11

    var b3 = a20 * a31 - a21 * a30

    var b4 = a20 * a32 - a22 * a30

    var b5 = a21 * a32 - a22 * a31

    var b6 = a00 * b5 - a01 * b4 + a02 * b3

    var b7 = a10 * b5 - a11 * b4 + a12 * b3

    var b8 = a20 * b2 - a21 * b1 + a22 * b0

    var b9 = a30 * b2 - a31 * b1 + a32 * b0
    // Calculate the determinant

    return a13 * b6 - a03 * b7 + a33 * b8 - a23 * b9
  }
  /**
   * Multiplies two mat4s
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the first operand
   * @param {ReadonlyMat4} b the second operand
   * @returns {mat4} out
   */

  function multiply$3(out, a, b) {
    var a00 = a[0],
      a01 = a[1],
      a02 = a[2],
      a03 = a[3]

    var a10 = a[4],
      a11 = a[5],
      a12 = a[6],
      a13 = a[7]

    var a20 = a[8],
      a21 = a[9],
      a22 = a[10],
      a23 = a[11]

    var a30 = a[12],
      a31 = a[13],
      a32 = a[14],
      a33 = a[15]
    // Cache only the current line of the second matrix

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2],
      b3 = b[3]

    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30

    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31

    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32

    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33

    b0 = b[4]

    b1 = b[5]

    b2 = b[6]

    b3 = b[7]

    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30

    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31

    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32

    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33

    b0 = b[8]

    b1 = b[9]

    b2 = b[10]

    b3 = b[11]

    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30

    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31

    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32

    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33

    b0 = b[12]

    b1 = b[13]

    b2 = b[14]

    b3 = b[15]

    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30

    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31

    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32

    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33

    return out
  }
  /**
   * Translate a mat4 by the given vector
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the matrix to translate
   * @param {ReadonlyVec3} v vector to translate by
   * @returns {mat4} out
   */

  function translate$2(out, a, v) {
    var x = v[0],
      y = v[1],
      z = v[2]

    var a00, a01, a02, a03

    var a10, a11, a12, a13

    var a20, a21, a22, a23

    if (a === out) {
      out[12] = a[0] * x + a[4] * y + a[8] * z + a[12]

      out[13] = a[1] * x + a[5] * y + a[9] * z + a[13]

      out[14] = a[2] * x + a[6] * y + a[10] * z + a[14]

      out[15] = a[3] * x + a[7] * y + a[11] * z + a[15]
    } else {
      a00 = a[0]

      a01 = a[1]

      a02 = a[2]

      a03 = a[3]

      a10 = a[4]

      a11 = a[5]

      a12 = a[6]

      a13 = a[7]

      a20 = a[8]

      a21 = a[9]

      a22 = a[10]

      a23 = a[11]

      out[0] = a00

      out[1] = a01

      out[2] = a02

      out[3] = a03

      out[4] = a10

      out[5] = a11

      out[6] = a12

      out[7] = a13

      out[8] = a20

      out[9] = a21

      out[10] = a22

      out[11] = a23

      out[12] = a00 * x + a10 * y + a20 * z + a[12]

      out[13] = a01 * x + a11 * y + a21 * z + a[13]

      out[14] = a02 * x + a12 * y + a22 * z + a[14]

      out[15] = a03 * x + a13 * y + a23 * z + a[15]
    }

    return out
  }
  /**
   * Scales the mat4 by the dimensions in the given vec3 not using vectorization
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the matrix to scale
   * @param {ReadonlyVec3} v the vec3 to scale the matrix by
   * @returns {mat4} out
   **/

  function scale$3(out, a, v) {
    var x = v[0],
      y = v[1],
      z = v[2]

    out[0] = a[0] * x

    out[1] = a[1] * x

    out[2] = a[2] * x

    out[3] = a[3] * x

    out[4] = a[4] * y

    out[5] = a[5] * y

    out[6] = a[6] * y

    out[7] = a[7] * y

    out[8] = a[8] * z

    out[9] = a[9] * z

    out[10] = a[10] * z

    out[11] = a[11] * z

    out[12] = a[12]

    out[13] = a[13]

    out[14] = a[14]

    out[15] = a[15]

    return out
  }
  /**
   * Rotates a mat4 by the given angle around the given axis
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the matrix to rotate
   * @param {Number} rad the angle to rotate the matrix by
   * @param {ReadonlyVec3} axis the axis to rotate around
   * @returns {mat4} out
   */

  function rotate$3(out, a, rad, axis) {
    var x = axis[0],
      y = axis[1],
      z = axis[2]

    var len = Math.hypot(x, y, z)

    var s, c, t

    var a00, a01, a02, a03

    var a10, a11, a12, a13

    var a20, a21, a22, a23

    var b00, b01, b02

    var b10, b11, b12

    var b20, b21, b22

    if (len < EPSILON) {
      return null
    }

    len = 1 / len

    x *= len

    y *= len

    z *= len

    s = Math.sin(rad)

    c = Math.cos(rad)

    t = 1 - c

    a00 = a[0]

    a01 = a[1]

    a02 = a[2]

    a03 = a[3]

    a10 = a[4]

    a11 = a[5]

    a12 = a[6]

    a13 = a[7]

    a20 = a[8]

    a21 = a[9]

    a22 = a[10]

    a23 = a[11]
    // Construct the elements of the rotation matrix

    b00 = x * x * t + c

    b01 = y * x * t + z * s

    b02 = z * x * t - y * s

    b10 = x * y * t - z * s

    b11 = y * y * t + c

    b12 = z * y * t + x * s

    b20 = x * z * t + y * s

    b21 = y * z * t - x * s

    b22 = z * z * t + c
    // Perform rotation-specific matrix multiplication

    out[0] = a00 * b00 + a10 * b01 + a20 * b02

    out[1] = a01 * b00 + a11 * b01 + a21 * b02

    out[2] = a02 * b00 + a12 * b01 + a22 * b02

    out[3] = a03 * b00 + a13 * b01 + a23 * b02

    out[4] = a00 * b10 + a10 * b11 + a20 * b12

    out[5] = a01 * b10 + a11 * b11 + a21 * b12

    out[6] = a02 * b10 + a12 * b11 + a22 * b12

    out[7] = a03 * b10 + a13 * b11 + a23 * b12

    out[8] = a00 * b20 + a10 * b21 + a20 * b22

    out[9] = a01 * b20 + a11 * b21 + a21 * b22

    out[10] = a02 * b20 + a12 * b21 + a22 * b22

    out[11] = a03 * b20 + a13 * b21 + a23 * b22

    if (a !== out) {
      // If the source and destination differ, copy the unchanged last row
      out[12] = a[12]

      out[13] = a[13]

      out[14] = a[14]

      out[15] = a[15]
    }

    return out
  }
  /**
   * Rotates a matrix by the given angle around the X axis
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the matrix to rotate
   * @param {Number} rad the angle to rotate the matrix by
   * @returns {mat4} out
   */

  function rotateX(out, a, rad) {
    var s = Math.sin(rad)

    var c = Math.cos(rad)

    var a10 = a[4]

    var a11 = a[5]

    var a12 = a[6]

    var a13 = a[7]

    var a20 = a[8]

    var a21 = a[9]

    var a22 = a[10]

    var a23 = a[11]

    if (a !== out) {
      // If the source and destination differ, copy the unchanged rows
      out[0] = a[0]

      out[1] = a[1]

      out[2] = a[2]

      out[3] = a[3]

      out[12] = a[12]

      out[13] = a[13]

      out[14] = a[14]

      out[15] = a[15]
    } // Perform axis-specific matrix multiplication

    out[4] = a10 * c + a20 * s

    out[5] = a11 * c + a21 * s

    out[6] = a12 * c + a22 * s

    out[7] = a13 * c + a23 * s

    out[8] = a20 * c - a10 * s

    out[9] = a21 * c - a11 * s

    out[10] = a22 * c - a12 * s

    out[11] = a23 * c - a13 * s

    return out
  }
  /**
   * Rotates a matrix by the given angle around the Y axis
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the matrix to rotate
   * @param {Number} rad the angle to rotate the matrix by
   * @returns {mat4} out
   */

  function rotateY(out, a, rad) {
    var s = Math.sin(rad)

    var c = Math.cos(rad)

    var a00 = a[0]

    var a01 = a[1]

    var a02 = a[2]

    var a03 = a[3]

    var a20 = a[8]

    var a21 = a[9]

    var a22 = a[10]

    var a23 = a[11]

    if (a !== out) {
      // If the source and destination differ, copy the unchanged rows
      out[4] = a[4]

      out[5] = a[5]

      out[6] = a[6]

      out[7] = a[7]

      out[12] = a[12]

      out[13] = a[13]

      out[14] = a[14]

      out[15] = a[15]
    } // Perform axis-specific matrix multiplication

    out[0] = a00 * c - a20 * s

    out[1] = a01 * c - a21 * s

    out[2] = a02 * c - a22 * s

    out[3] = a03 * c - a23 * s

    out[8] = a00 * s + a20 * c

    out[9] = a01 * s + a21 * c

    out[10] = a02 * s + a22 * c

    out[11] = a03 * s + a23 * c

    return out
  }
  /**
   * Rotates a matrix by the given angle around the Z axis
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the matrix to rotate
   * @param {Number} rad the angle to rotate the matrix by
   * @returns {mat4} out
   */

  function rotateZ(out, a, rad) {
    var s = Math.sin(rad)

    var c = Math.cos(rad)

    var a00 = a[0]

    var a01 = a[1]

    var a02 = a[2]

    var a03 = a[3]

    var a10 = a[4]

    var a11 = a[5]

    var a12 = a[6]

    var a13 = a[7]

    if (a !== out) {
      // If the source and destination differ, copy the unchanged last row
      out[8] = a[8]

      out[9] = a[9]

      out[10] = a[10]

      out[11] = a[11]

      out[12] = a[12]

      out[13] = a[13]

      out[14] = a[14]

      out[15] = a[15]
    } // Perform axis-specific matrix multiplication

    out[0] = a00 * c + a10 * s

    out[1] = a01 * c + a11 * s

    out[2] = a02 * c + a12 * s

    out[3] = a03 * c + a13 * s

    out[4] = a10 * c - a00 * s

    out[5] = a11 * c - a01 * s

    out[6] = a12 * c - a02 * s

    out[7] = a13 * c - a03 * s

    return out
  }
  /**
     * Creates a matrix from a vector translation
     * This is equivalent to (but much faster than):
     *
     *     mat4.identity(dest);
  
     *     mat4.translate(dest, dest, vec);
  
     *
     * @param {mat4} out mat4 receiving operation result
     * @param {ReadonlyVec3} v Translation vector
     * @returns {mat4} out
     */

  function fromTranslation$2(out, v) {
    out[0] = 1

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = 0

    out[5] = 1

    out[6] = 0

    out[7] = 0

    out[8] = 0

    out[9] = 0

    out[10] = 1

    out[11] = 0

    out[12] = v[0]

    out[13] = v[1]

    out[14] = v[2]

    out[15] = 1

    return out
  }
  /**
     * Creates a matrix from a vector scaling
     * This is equivalent to (but much faster than):
     *
     *     mat4.identity(dest);
  
     *     mat4.scale(dest, dest, vec);
  
     *
     * @param {mat4} out mat4 receiving operation result
     * @param {ReadonlyVec3} v Scaling vector
     * @returns {mat4} out
     */

  function fromScaling$3(out, v) {
    out[0] = v[0]

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = 0

    out[5] = v[1]

    out[6] = 0

    out[7] = 0

    out[8] = 0

    out[9] = 0

    out[10] = v[2]

    out[11] = 0

    out[12] = 0

    out[13] = 0

    out[14] = 0

    out[15] = 1

    return out
  }
  /**
     * Creates a matrix from a given angle around a given axis
     * This is equivalent to (but much faster than):
     *
     *     mat4.identity(dest);
  
     *     mat4.rotate(dest, dest, rad, axis);
  
     *
     * @param {mat4} out mat4 receiving operation result
     * @param {Number} rad the angle to rotate the matrix by
     * @param {ReadonlyVec3} axis the axis to rotate around
     * @returns {mat4} out
     */

  function fromRotation$3(out, rad, axis) {
    var x = axis[0],
      y = axis[1],
      z = axis[2]

    var len = Math.hypot(x, y, z)

    var s, c, t

    if (len < EPSILON) {
      return null
    }

    len = 1 / len

    x *= len

    y *= len

    z *= len

    s = Math.sin(rad)

    c = Math.cos(rad)

    t = 1 - c
    // Perform rotation-specific matrix multiplication

    out[0] = x * x * t + c

    out[1] = y * x * t + z * s

    out[2] = z * x * t - y * s

    out[3] = 0

    out[4] = x * y * t - z * s

    out[5] = y * y * t + c

    out[6] = z * y * t + x * s

    out[7] = 0

    out[8] = x * z * t + y * s

    out[9] = y * z * t - x * s

    out[10] = z * z * t + c

    out[11] = 0

    out[12] = 0

    out[13] = 0

    out[14] = 0

    out[15] = 1

    return out
  }
  /**
     * Creates a matrix from the given angle around the X axis
     * This is equivalent to (but much faster than):
     *
     *     mat4.identity(dest);
  
     *     mat4.rotateX(dest, dest, rad);
  
     *
     * @param {mat4} out mat4 receiving operation result
     * @param {Number} rad the angle to rotate the matrix by
     * @returns {mat4} out
     */

  function fromXRotation(out, rad) {
    var s = Math.sin(rad)

    var c = Math.cos(rad)
    // Perform axis-specific matrix multiplication

    out[0] = 1

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = 0

    out[5] = c

    out[6] = s

    out[7] = 0

    out[8] = 0

    out[9] = -s

    out[10] = c

    out[11] = 0

    out[12] = 0

    out[13] = 0

    out[14] = 0

    out[15] = 1

    return out
  }
  /**
     * Creates a matrix from the given angle around the Y axis
     * This is equivalent to (but much faster than):
     *
     *     mat4.identity(dest);
  
     *     mat4.rotateY(dest, dest, rad);
  
     *
     * @param {mat4} out mat4 receiving operation result
     * @param {Number} rad the angle to rotate the matrix by
     * @returns {mat4} out
     */

  function fromYRotation(out, rad) {
    var s = Math.sin(rad)

    var c = Math.cos(rad)
    // Perform axis-specific matrix multiplication

    out[0] = c

    out[1] = 0

    out[2] = -s

    out[3] = 0

    out[4] = 0

    out[5] = 1

    out[6] = 0

    out[7] = 0

    out[8] = s

    out[9] = 0

    out[10] = c

    out[11] = 0

    out[12] = 0

    out[13] = 0

    out[14] = 0

    out[15] = 1

    return out
  }
  /**
     * Creates a matrix from the given angle around the Z axis
     * This is equivalent to (but much faster than):
     *
     *     mat4.identity(dest);
  
     *     mat4.rotateZ(dest, dest, rad);
  
     *
     * @param {mat4} out mat4 receiving operation result
     * @param {Number} rad the angle to rotate the matrix by
     * @returns {mat4} out
     */

  function fromZRotation(out, rad) {
    var s = Math.sin(rad)

    var c = Math.cos(rad)
    // Perform axis-specific matrix multiplication

    out[0] = c

    out[1] = s

    out[2] = 0

    out[3] = 0

    out[4] = -s

    out[5] = c

    out[6] = 0

    out[7] = 0

    out[8] = 0

    out[9] = 0

    out[10] = 1

    out[11] = 0

    out[12] = 0

    out[13] = 0

    out[14] = 0

    out[15] = 1

    return out
  }
  /**
     * Creates a matrix from a quaternion rotation and vector translation
     * This is equivalent to (but much faster than):
     *
     *     mat4.identity(dest);
  
     *     mat4.translate(dest, vec);
  
     *     let quatMat = mat4.create();
  
     *     quat4.toMat4(quat, quatMat);
  
     *     mat4.multiply(dest, quatMat);
  
     *
     * @param {mat4} out mat4 receiving operation result
     * @param {quat4} q Rotation quaternion
     * @param {ReadonlyVec3} v Translation vector
     * @returns {mat4} out
     */

  function fromRotationTranslation(out, q, v) {
    // Quaternion math
    var x = q[0],
      y = q[1],
      z = q[2],
      w = q[3]

    var x2 = x + x

    var y2 = y + y

    var z2 = z + z

    var xx = x * x2

    var xy = x * y2

    var xz = x * z2

    var yy = y * y2

    var yz = y * z2

    var zz = z * z2

    var wx = w * x2

    var wy = w * y2

    var wz = w * z2

    out[0] = 1 - (yy + zz)

    out[1] = xy + wz

    out[2] = xz - wy

    out[3] = 0

    out[4] = xy - wz

    out[5] = 1 - (xx + zz)

    out[6] = yz + wx

    out[7] = 0

    out[8] = xz + wy

    out[9] = yz - wx

    out[10] = 1 - (xx + yy)

    out[11] = 0

    out[12] = v[0]

    out[13] = v[1]

    out[14] = v[2]

    out[15] = 1

    return out
  }
  /**
   * Creates a new mat4 from a dual quat.
   *
   * @param {mat4} out Matrix
   * @param {ReadonlyQuat2} a Dual Quaternion
   * @returns {mat4} mat4 receiving operation result
   */

  function fromQuat2(out, a) {
    var translation = new ARRAY_TYPE(3)

    var bx = -a[0],
      by = -a[1],
      bz = -a[2],
      bw = a[3],
      ax = a[4],
      ay = a[5],
      az = a[6],
      aw = a[7]

    var magnitude = bx * bx + by * by + bz * bz + bw * bw
    //Only scale if it makes sense

    if (magnitude > 0) {
      translation[0] = ((ax * bw + aw * bx + ay * bz - az * by) * 2) / magnitude

      translation[1] = ((ay * bw + aw * by + az * bx - ax * bz) * 2) / magnitude

      translation[2] = ((az * bw + aw * bz + ax * by - ay * bx) * 2) / magnitude
    } else {
      translation[0] = (ax * bw + aw * bx + ay * bz - az * by) * 2

      translation[1] = (ay * bw + aw * by + az * bx - ax * bz) * 2

      translation[2] = (az * bw + aw * bz + ax * by - ay * bx) * 2
    }

    fromRotationTranslation(out, a, translation)

    return out
  }
  /**
   * Returns the translation vector component of a transformation
   *  matrix. If a matrix is built with fromRotationTranslation,
   *  the returned vector will be the same as the translation vector
   *  originally supplied.
   * @param  {vec3} out Vector to receive translation component
   * @param  {ReadonlyMat4} mat Matrix to be decomposed (input)
   * @return {vec3} out
   */

  function getTranslation(out, mat) {
    out[0] = mat[12]

    out[1] = mat[13]

    out[2] = mat[14]

    return out
  }
  /**
   * Returns the scaling factor component of a transformation
   *  matrix. If a matrix is built with fromRotationTranslationScale
   *  with a normalized Quaternion paramter, the returned vector will be
   *  the same as the scaling vector
   *  originally supplied.
   * @param  {vec3} out Vector to receive scaling factor component
   * @param  {ReadonlyMat4} mat Matrix to be decomposed (input)
   * @return {vec3} out
   */

  function getScaling(out, mat) {
    var m11 = mat[0]

    var m12 = mat[1]

    var m13 = mat[2]

    var m21 = mat[4]

    var m22 = mat[5]

    var m23 = mat[6]

    var m31 = mat[8]

    var m32 = mat[9]

    var m33 = mat[10]

    out[0] = Math.hypot(m11, m12, m13)

    out[1] = Math.hypot(m21, m22, m23)

    out[2] = Math.hypot(m31, m32, m33)

    return out
  }
  /**
   * Returns a quaternion representing the rotational component
   *  of a transformation matrix. If a matrix is built with
   *  fromRotationTranslation, the returned quaternion will be the
   *  same as the quaternion originally supplied.
   * @param {quat} out Quaternion to receive the rotation component
   * @param {ReadonlyMat4} mat Matrix to be decomposed (input)
   * @return {quat} out
   */

  function getRotation(out, mat) {
    var scaling = new ARRAY_TYPE(3)

    getScaling(scaling, mat)

    var is1 = 1 / scaling[0]

    var is2 = 1 / scaling[1]

    var is3 = 1 / scaling[2]

    var sm11 = mat[0] * is1

    var sm12 = mat[1] * is2

    var sm13 = mat[2] * is3

    var sm21 = mat[4] * is1

    var sm22 = mat[5] * is2

    var sm23 = mat[6] * is3

    var sm31 = mat[8] * is1

    var sm32 = mat[9] * is2

    var sm33 = mat[10] * is3

    var trace = sm11 + sm22 + sm33

    var S = 0

    if (trace > 0) {
      S = Math.sqrt(trace + 1.0) * 2

      out[3] = 0.25 * S

      out[0] = (sm23 - sm32) / S

      out[1] = (sm31 - sm13) / S

      out[2] = (sm12 - sm21) / S
    } else if (sm11 > sm22 && sm11 > sm33) {
      S = Math.sqrt(1.0 + sm11 - sm22 - sm33) * 2

      out[3] = (sm23 - sm32) / S

      out[0] = 0.25 * S

      out[1] = (sm12 + sm21) / S

      out[2] = (sm31 + sm13) / S
    } else if (sm22 > sm33) {
      S = Math.sqrt(1.0 + sm22 - sm11 - sm33) * 2

      out[3] = (sm31 - sm13) / S

      out[0] = (sm12 + sm21) / S

      out[1] = 0.25 * S

      out[2] = (sm23 + sm32) / S
    } else {
      S = Math.sqrt(1.0 + sm33 - sm11 - sm22) * 2

      out[3] = (sm12 - sm21) / S

      out[0] = (sm31 + sm13) / S

      out[1] = (sm23 + sm32) / S

      out[2] = 0.25 * S
    }

    return out
  }
  /**
   * Decomposes a transformation matrix into its rotation, translation
   * and scale components. Returns only the rotation component
   * @param  {quat} out_r Quaternion to receive the rotation component
   * @param  {vec3} out_t Vector to receive the translation vector
   * @param  {vec3} out_s Vector to receive the scaling factor
   * @param  {ReadonlyMat4} mat Matrix to be decomposed (input)
   * @returns {quat} out_r
   */

  function decompose(out_r, out_t, out_s, mat) {
    out_t[0] = mat[12]

    out_t[1] = mat[13]

    out_t[2] = mat[14]

    var m11 = mat[0]

    var m12 = mat[1]

    var m13 = mat[2]

    var m21 = mat[4]

    var m22 = mat[5]

    var m23 = mat[6]

    var m31 = mat[8]

    var m32 = mat[9]

    var m33 = mat[10]

    out_s[0] = Math.hypot(m11, m12, m13)

    out_s[1] = Math.hypot(m21, m22, m23)

    out_s[2] = Math.hypot(m31, m32, m33)

    var is1 = 1 / out_s[0]

    var is2 = 1 / out_s[1]

    var is3 = 1 / out_s[2]

    var sm11 = m11 * is1

    var sm12 = m12 * is2

    var sm13 = m13 * is3

    var sm21 = m21 * is1

    var sm22 = m22 * is2

    var sm23 = m23 * is3

    var sm31 = m31 * is1

    var sm32 = m32 * is2

    var sm33 = m33 * is3

    var trace = sm11 + sm22 + sm33

    var S = 0

    if (trace > 0) {
      S = Math.sqrt(trace + 1.0) * 2

      out_r[3] = 0.25 * S

      out_r[0] = (sm23 - sm32) / S

      out_r[1] = (sm31 - sm13) / S

      out_r[2] = (sm12 - sm21) / S
    } else if (sm11 > sm22 && sm11 > sm33) {
      S = Math.sqrt(1.0 + sm11 - sm22 - sm33) * 2

      out_r[3] = (sm23 - sm32) / S

      out_r[0] = 0.25 * S

      out_r[1] = (sm12 + sm21) / S

      out_r[2] = (sm31 + sm13) / S
    } else if (sm22 > sm33) {
      S = Math.sqrt(1.0 + sm22 - sm11 - sm33) * 2

      out_r[3] = (sm31 - sm13) / S

      out_r[0] = (sm12 + sm21) / S

      out_r[1] = 0.25 * S

      out_r[2] = (sm23 + sm32) / S
    } else {
      S = Math.sqrt(1.0 + sm33 - sm11 - sm22) * 2

      out_r[3] = (sm12 - sm21) / S

      out_r[0] = (sm31 + sm13) / S

      out_r[1] = (sm23 + sm32) / S

      out_r[2] = 0.25 * S
    }

    return out_r
  }
  /**
     * Creates a matrix from a quaternion rotation, vector translation and vector scale
     * This is equivalent to (but much faster than):
     *
     *     mat4.identity(dest);
  
     *     mat4.translate(dest, vec);
  
     *     let quatMat = mat4.create();
  
     *     quat4.toMat4(quat, quatMat);
  
     *     mat4.multiply(dest, quatMat);
  
     *     mat4.scale(dest, scale)
     *
     * @param {mat4} out mat4 receiving operation result
     * @param {quat4} q Rotation quaternion
     * @param {ReadonlyVec3} v Translation vector
     * @param {ReadonlyVec3} s Scaling vector
     * @returns {mat4} out
     */

  function fromRotationTranslationScale(out, q, v, s) {
    // Quaternion math
    var x = q[0],
      y = q[1],
      z = q[2],
      w = q[3]

    var x2 = x + x

    var y2 = y + y

    var z2 = z + z

    var xx = x * x2

    var xy = x * y2

    var xz = x * z2

    var yy = y * y2

    var yz = y * z2

    var zz = z * z2

    var wx = w * x2

    var wy = w * y2

    var wz = w * z2

    var sx = s[0]

    var sy = s[1]

    var sz = s[2]

    out[0] = (1 - (yy + zz)) * sx

    out[1] = (xy + wz) * sx

    out[2] = (xz - wy) * sx

    out[3] = 0

    out[4] = (xy - wz) * sy

    out[5] = (1 - (xx + zz)) * sy

    out[6] = (yz + wx) * sy

    out[7] = 0

    out[8] = (xz + wy) * sz

    out[9] = (yz - wx) * sz

    out[10] = (1 - (xx + yy)) * sz

    out[11] = 0

    out[12] = v[0]

    out[13] = v[1]

    out[14] = v[2]

    out[15] = 1

    return out
  }
  /**
     * Creates a matrix from a quaternion rotation, vector translation and vector scale, rotating and scaling around the given origin
     * This is equivalent to (but much faster than):
     *
     *     mat4.identity(dest);
  
     *     mat4.translate(dest, vec);
  
     *     mat4.translate(dest, origin);
  
     *     let quatMat = mat4.create();
  
     *     quat4.toMat4(quat, quatMat);
  
     *     mat4.multiply(dest, quatMat);
  
     *     mat4.scale(dest, scale)
     *     mat4.translate(dest, negativeOrigin);
  
     *
     * @param {mat4} out mat4 receiving operation result
     * @param {quat4} q Rotation quaternion
     * @param {ReadonlyVec3} v Translation vector
     * @param {ReadonlyVec3} s Scaling vector
     * @param {ReadonlyVec3} o The origin vector around which to scale and rotate
     * @returns {mat4} out
     */

  function fromRotationTranslationScaleOrigin(out, q, v, s, o) {
    // Quaternion math
    var x = q[0],
      y = q[1],
      z = q[2],
      w = q[3]

    var x2 = x + x

    var y2 = y + y

    var z2 = z + z

    var xx = x * x2

    var xy = x * y2

    var xz = x * z2

    var yy = y * y2

    var yz = y * z2

    var zz = z * z2

    var wx = w * x2

    var wy = w * y2

    var wz = w * z2

    var sx = s[0]

    var sy = s[1]

    var sz = s[2]

    var ox = o[0]

    var oy = o[1]

    var oz = o[2]

    var out0 = (1 - (yy + zz)) * sx

    var out1 = (xy + wz) * sx

    var out2 = (xz - wy) * sx

    var out4 = (xy - wz) * sy

    var out5 = (1 - (xx + zz)) * sy

    var out6 = (yz + wx) * sy

    var out8 = (xz + wy) * sz

    var out9 = (yz - wx) * sz

    var out10 = (1 - (xx + yy)) * sz

    out[0] = out0

    out[1] = out1

    out[2] = out2

    out[3] = 0

    out[4] = out4

    out[5] = out5

    out[6] = out6

    out[7] = 0

    out[8] = out8

    out[9] = out9

    out[10] = out10

    out[11] = 0

    out[12] = v[0] + ox - (out0 * ox + out4 * oy + out8 * oz)

    out[13] = v[1] + oy - (out1 * ox + out5 * oy + out9 * oz)

    out[14] = v[2] + oz - (out2 * ox + out6 * oy + out10 * oz)

    out[15] = 1

    return out
  }
  /**
   * Calculates a 4x4 matrix from the given quaternion
   *
   * @param {mat4} out mat4 receiving operation result
   * @param {ReadonlyQuat} q Quaternion to create matrix from
   *
   * @returns {mat4} out
   */

  function fromQuat$1(out, q) {
    var x = q[0],
      y = q[1],
      z = q[2],
      w = q[3]

    var x2 = x + x

    var y2 = y + y

    var z2 = z + z

    var xx = x * x2

    var yx = y * x2

    var yy = y * y2

    var zx = z * x2

    var zy = z * y2

    var zz = z * z2

    var wx = w * x2

    var wy = w * y2

    var wz = w * z2

    out[0] = 1 - yy - zz

    out[1] = yx + wz

    out[2] = zx - wy

    out[3] = 0

    out[4] = yx - wz

    out[5] = 1 - xx - zz

    out[6] = zy + wx

    out[7] = 0

    out[8] = zx + wy

    out[9] = zy - wx

    out[10] = 1 - xx - yy

    out[11] = 0

    out[12] = 0

    out[13] = 0

    out[14] = 0

    out[15] = 1

    return out
  }
  /**
   * Generates a frustum matrix with the given bounds
   *
   * @param {mat4} out mat4 frustum matrix will be written into
   * @param {Number} left Left bound of the frustum
   * @param {Number} right Right bound of the frustum
   * @param {Number} bottom Bottom bound of the frustum
   * @param {Number} top Top bound of the frustum
   * @param {Number} near Near bound of the frustum
   * @param {Number} far Far bound of the frustum
   * @returns {mat4} out
   */

  function frustum(out, left, right, bottom, top, near, far) {
    var rl = 1 / (right - left)

    var tb = 1 / (top - bottom)

    var nf = 1 / (near - far)

    out[0] = near * 2 * rl

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = 0

    out[5] = near * 2 * tb

    out[6] = 0

    out[7] = 0

    out[8] = (right + left) * rl

    out[9] = (top + bottom) * tb

    out[10] = (far + near) * nf

    out[11] = -1

    out[12] = 0

    out[13] = 0

    out[14] = far * near * 2 * nf

    out[15] = 0

    return out
  }
  /**
   * Generates a perspective projection matrix with the given bounds.
   * Passing null/undefined/no value for far will generate infinite projection matrix.
   *
   * @param {mat4} out mat4 frustum matrix will be written into
   * @param {number} fovy Vertical field of view in radians
   * @param {number} aspect Aspect ratio. typically viewport width/height
   * @param {number} near Near bound of the frustum
   * @param {number} far Far bound of the frustum, can be null or Infinity
   * @returns {mat4} out
   */

  function perspective(out, fovy, aspect, near, far) {
    var f = 1.0 / Math.tan(fovy / 2),
      nf

    out[0] = f / aspect

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = 0

    out[5] = f

    out[6] = 0

    out[7] = 0

    out[8] = 0

    out[9] = 0

    out[11] = -1

    out[12] = 0

    out[13] = 0

    out[15] = 0

    if (far != null && far !== Infinity) {
      nf = 1 / (near - far)

      out[10] = (far + near) * nf

      out[14] = 2 * far * near * nf
    } else {
      out[10] = -1

      out[14] = -2 * near
    }

    return out
  }
  /**
   * Generates a perspective projection matrix with the given field of view.
   * This is primarily useful for generating projection matrices to be used
   * with the still experiemental WebVR API.
   *
   * @param {mat4} out mat4 frustum matrix will be written into
   * @param {Object} fov Object containing the following values: upDegrees, downDegrees, leftDegrees, rightDegrees
   * @param {number} near Near bound of the frustum
   * @param {number} far Far bound of the frustum
   * @returns {mat4} out
   */

  function perspectiveFromFieldOfView(out, fov, near, far) {
    var upTan = Math.tan((fov.upDegrees * Math.PI) / 180.0)

    var downTan = Math.tan((fov.downDegrees * Math.PI) / 180.0)

    var leftTan = Math.tan((fov.leftDegrees * Math.PI) / 180.0)

    var rightTan = Math.tan((fov.rightDegrees * Math.PI) / 180.0)

    var xScale = 2.0 / (leftTan + rightTan)

    var yScale = 2.0 / (upTan + downTan)

    out[0] = xScale

    out[1] = 0.0

    out[2] = 0.0

    out[3] = 0.0

    out[4] = 0.0

    out[5] = yScale

    out[6] = 0.0

    out[7] = 0.0

    out[8] = -((leftTan - rightTan) * xScale * 0.5)

    out[9] = (upTan - downTan) * yScale * 0.5

    out[10] = far / (near - far)

    out[11] = -1.0

    out[12] = 0.0

    out[13] = 0.0

    out[14] = (far * near) / (near - far)

    out[15] = 0.0

    return out
  }
  /**
   * Generates a orthogonal projection matrix with the given bounds
   *
   * @param {mat4} out mat4 frustum matrix will be written into
   * @param {number} left Left bound of the frustum
   * @param {number} right Right bound of the frustum
   * @param {number} bottom Bottom bound of the frustum
   * @param {number} top Top bound of the frustum
   * @param {number} near Near bound of the frustum
   * @param {number} far Far bound of the frustum
   * @returns {mat4} out
   */

  function ortho(out, left, right, bottom, top, near, far) {
    var lr = 1 / (left - right)

    var bt = 1 / (bottom - top)

    var nf = 1 / (near - far)

    out[0] = -2 * lr

    out[1] = 0

    out[2] = 0

    out[3] = 0

    out[4] = 0

    out[5] = -2 * bt

    out[6] = 0

    out[7] = 0

    out[8] = 0

    out[9] = 0

    out[10] = 2 * nf

    out[11] = 0

    out[12] = (left + right) * lr

    out[13] = (top + bottom) * bt

    out[14] = (far + near) * nf

    out[15] = 1

    return out
  }
  /**
   * Generates a look-at matrix with the given eye position, focal point, and up axis.
   * If you want a matrix that actually makes an object look at another object, you should use targetTo instead.
   *
   * @param {mat4} out mat4 frustum matrix will be written into
   * @param {ReadonlyVec3} eye Position of the viewer
   * @param {ReadonlyVec3} center Point the viewer is looking at
   * @param {ReadonlyVec3} up vec3 pointing up
   * @returns {mat4} out
   */

  function lookAt(out, eye, center, up) {
    var x0, x1, x2, y0, y1, y2, z0, z1, z2, len

    var eyex = eye[0]

    var eyey = eye[1]

    var eyez = eye[2]

    var upx = up[0]

    var upy = up[1]

    var upz = up[2]

    var centerx = center[0]

    var centery = center[1]

    var centerz = center[2]

    if (
      Math.abs(eyex - centerx) < EPSILON &&
      Math.abs(eyey - centery) < EPSILON &&
      Math.abs(eyez - centerz) < EPSILON
    ) {
      return identity$3(out)
    }

    z0 = eyex - centerx

    z1 = eyey - centery

    z2 = eyez - centerz

    len = 1 / Math.hypot(z0, z1, z2)

    z0 *= len

    z1 *= len

    z2 *= len

    x0 = upy * z2 - upz * z1

    x1 = upz * z0 - upx * z2

    x2 = upx * z1 - upy * z0

    len = Math.hypot(x0, x1, x2)

    if (!len) {
      x0 = 0

      x1 = 0

      x2 = 0
    } else {
      len = 1 / len

      x0 *= len

      x1 *= len

      x2 *= len
    }

    y0 = z1 * x2 - z2 * x1

    y1 = z2 * x0 - z0 * x2

    y2 = z0 * x1 - z1 * x0

    len = Math.hypot(y0, y1, y2)

    if (!len) {
      y0 = 0

      y1 = 0

      y2 = 0
    } else {
      len = 1 / len

      y0 *= len

      y1 *= len

      y2 *= len
    }

    out[0] = x0

    out[1] = y0

    out[2] = z0

    out[3] = 0

    out[4] = x1

    out[5] = y1

    out[6] = z1

    out[7] = 0

    out[8] = x2

    out[9] = y2

    out[10] = z2

    out[11] = 0

    out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez)

    out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez)

    out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez)

    out[15] = 1

    return out
  }
  /**
   * Generates a matrix that makes something look at something else.
   *
   * @param {mat4} out mat4 frustum matrix will be written into
   * @param {ReadonlyVec3} eye Position of the viewer
   * @param {ReadonlyVec3} center Point the viewer is looking at
   * @param {ReadonlyVec3} up vec3 pointing up
   * @returns {mat4} out
   */

  function targetTo(out, eye, target, up) {
    var eyex = eye[0],
      eyey = eye[1],
      eyez = eye[2],
      upx = up[0],
      upy = up[1],
      upz = up[2]

    var z0 = eyex - target[0],
      z1 = eyey - target[1],
      z2 = eyez - target[2]

    var len = z0 * z0 + z1 * z1 + z2 * z2

    if (len > 0) {
      len = 1 / Math.sqrt(len)

      z0 *= len

      z1 *= len

      z2 *= len
    }

    var x0 = upy * z2 - upz * z1,
      x1 = upz * z0 - upx * z2,
      x2 = upx * z1 - upy * z0

    len = x0 * x0 + x1 * x1 + x2 * x2

    if (len > 0) {
      len = 1 / Math.sqrt(len)

      x0 *= len

      x1 *= len

      x2 *= len
    }

    out[0] = x0

    out[1] = x1

    out[2] = x2

    out[3] = 0

    out[4] = z1 * x2 - z2 * x1

    out[5] = z2 * x0 - z0 * x2

    out[6] = z0 * x1 - z1 * x0

    out[7] = 0

    out[8] = z0

    out[9] = z1

    out[10] = z2

    out[11] = 0

    out[12] = eyex

    out[13] = eyey

    out[14] = eyez

    out[15] = 1

    return out
  }
  /**
   * Returns a string representation of a mat4
   *
   * @param {ReadonlyMat4} a matrix to represent as a string
   * @returns {String} string representation of the matrix
   */

  function str$3(a) {
    return (
      "mat4(" +
      a[0] +
      ", " +
      a[1] +
      ", " +
      a[2] +
      ", " +
      a[3] +
      ", " +
      a[4] +
      ", " +
      a[5] +
      ", " +
      a[6] +
      ", " +
      a[7] +
      ", " +
      a[8] +
      ", " +
      a[9] +
      ", " +
      a[10] +
      ", " +
      a[11] +
      ", " +
      a[12] +
      ", " +
      a[13] +
      ", " +
      a[14] +
      ", " +
      a[15] +
      ")"
    )
  }
  /**
   * Returns Frobenius norm of a mat4
   *
   * @param {ReadonlyMat4} a the matrix to calculate Frobenius norm of
   * @returns {Number} Frobenius norm
   */

  function frob$3(a) {
    return Math.hypot(
      a[0],
      a[1],
      a[2],
      a[3],
      a[4],
      a[5],
      a[6],
      a[7],
      a[8],
      a[9],
      a[10],
      a[11],
      a[12],
      a[13],
      a[14],
      a[15]
    )
  }
  /**
   * Adds two mat4's
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the first operand
   * @param {ReadonlyMat4} b the second operand
   * @returns {mat4} out
   */

  function add$3(out, a, b) {
    out[0] = a[0] + b[0]

    out[1] = a[1] + b[1]

    out[2] = a[2] + b[2]

    out[3] = a[3] + b[3]

    out[4] = a[4] + b[4]

    out[5] = a[5] + b[5]

    out[6] = a[6] + b[6]

    out[7] = a[7] + b[7]

    out[8] = a[8] + b[8]

    out[9] = a[9] + b[9]

    out[10] = a[10] + b[10]

    out[11] = a[11] + b[11]

    out[12] = a[12] + b[12]

    out[13] = a[13] + b[13]

    out[14] = a[14] + b[14]

    out[15] = a[15] + b[15]

    return out
  }
  /**
   * Subtracts matrix b from matrix a
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the first operand
   * @param {ReadonlyMat4} b the second operand
   * @returns {mat4} out
   */

  function subtract$3(out, a, b) {
    out[0] = a[0] - b[0]

    out[1] = a[1] - b[1]

    out[2] = a[2] - b[2]

    out[3] = a[3] - b[3]

    out[4] = a[4] - b[4]

    out[5] = a[5] - b[5]

    out[6] = a[6] - b[6]

    out[7] = a[7] - b[7]

    out[8] = a[8] - b[8]

    out[9] = a[9] - b[9]

    out[10] = a[10] - b[10]

    out[11] = a[11] - b[11]

    out[12] = a[12] - b[12]

    out[13] = a[13] - b[13]

    out[14] = a[14] - b[14]

    out[15] = a[15] - b[15]

    return out
  }
  /**
   * Multiply each element of the matrix by a scalar.
   *
   * @param {mat4} out the receiving matrix
   * @param {ReadonlyMat4} a the matrix to scale
   * @param {Number} b amount to scale the matrix's elements by
   * @returns {mat4} out
   */

  function multiplyScalar$3(out, a, b) {
    out[0] = a[0] * b

    out[1] = a[1] * b

    out[2] = a[2] * b

    out[3] = a[3] * b

    out[4] = a[4] * b

    out[5] = a[5] * b

    out[6] = a[6] * b

    out[7] = a[7] * b

    out[8] = a[8] * b

    out[9] = a[9] * b

    out[10] = a[10] * b

    out[11] = a[11] * b

    out[12] = a[12] * b

    out[13] = a[13] * b

    out[14] = a[14] * b

    out[15] = a[15] * b

    return out
  }
  /**
   * Adds two mat4's after multiplying each element of the second operand by a scalar value.
   *
   * @param {mat4} out the receiving vector
   * @param {ReadonlyMat4} a the first operand
   * @param {ReadonlyMat4} b the second operand
   * @param {Number} scale the amount to scale b's elements by before adding
   * @returns {mat4} out
   */

  function multiplyScalarAndAdd$3(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale

    out[1] = a[1] + b[1] * scale

    out[2] = a[2] + b[2] * scale

    out[3] = a[3] + b[3] * scale

    out[4] = a[4] + b[4] * scale

    out[5] = a[5] + b[5] * scale

    out[6] = a[6] + b[6] * scale

    out[7] = a[7] + b[7] * scale

    out[8] = a[8] + b[8] * scale

    out[9] = a[9] + b[9] * scale

    out[10] = a[10] + b[10] * scale

    out[11] = a[11] + b[11] * scale

    out[12] = a[12] + b[12] * scale

    out[13] = a[13] + b[13] * scale

    out[14] = a[14] + b[14] * scale

    out[15] = a[15] + b[15] * scale

    return out
  }
  /**
   * Returns whether or not the matrices have exactly the same elements in the same position (when compared with ===)
   *
   * @param {ReadonlyMat4} a The first matrix.
   * @param {ReadonlyMat4} b The second matrix.
   * @returns {Boolean} True if the matrices are equal, false otherwise.
   */

  function exactEquals$3(a, b) {
    return (
      a[0] === b[0] &&
      a[1] === b[1] &&
      a[2] === b[2] &&
      a[3] === b[3] &&
      a[4] === b[4] &&
      a[5] === b[5] &&
      a[6] === b[6] &&
      a[7] === b[7] &&
      a[8] === b[8] &&
      a[9] === b[9] &&
      a[10] === b[10] &&
      a[11] === b[11] &&
      a[12] === b[12] &&
      a[13] === b[13] &&
      a[14] === b[14] &&
      a[15] === b[15]
    )
  }
  /**
   * Returns whether or not the matrices have approximately the same elements in the same position.
   *
   * @param {ReadonlyMat4} a The first matrix.
   * @param {ReadonlyMat4} b The second matrix.
   * @returns {Boolean} True if the matrices are equal, false otherwise.
   */

  function equals$4(a, b) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3]

    var a4 = a[4],
      a5 = a[5],
      a6 = a[6],
      a7 = a[7]

    var a8 = a[8],
      a9 = a[9],
      a10 = a[10],
      a11 = a[11]

    var a12 = a[12],
      a13 = a[13],
      a14 = a[14],
      a15 = a[15]

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2],
      b3 = b[3]

    var b4 = b[4],
      b5 = b[5],
      b6 = b[6],
      b7 = b[7]

    var b8 = b[8],
      b9 = b[9],
      b10 = b[10],
      b11 = b[11]

    var b12 = b[12],
      b13 = b[13],
      b14 = b[14],
      b15 = b[15]

    return (
      Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
      Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
      Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
      Math.abs(a3 - b3) <= EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3)) &&
      Math.abs(a4 - b4) <= EPSILON * Math.max(1.0, Math.abs(a4), Math.abs(b4)) &&
      Math.abs(a5 - b5) <= EPSILON * Math.max(1.0, Math.abs(a5), Math.abs(b5)) &&
      Math.abs(a6 - b6) <= EPSILON * Math.max(1.0, Math.abs(a6), Math.abs(b6)) &&
      Math.abs(a7 - b7) <= EPSILON * Math.max(1.0, Math.abs(a7), Math.abs(b7)) &&
      Math.abs(a8 - b8) <= EPSILON * Math.max(1.0, Math.abs(a8), Math.abs(b8)) &&
      Math.abs(a9 - b9) <= EPSILON * Math.max(1.0, Math.abs(a9), Math.abs(b9)) &&
      Math.abs(a10 - b10) <= EPSILON * Math.max(1.0, Math.abs(a10), Math.abs(b10)) &&
      Math.abs(a11 - b11) <= EPSILON * Math.max(1.0, Math.abs(a11), Math.abs(b11)) &&
      Math.abs(a12 - b12) <= EPSILON * Math.max(1.0, Math.abs(a12), Math.abs(b12)) &&
      Math.abs(a13 - b13) <= EPSILON * Math.max(1.0, Math.abs(a13), Math.abs(b13)) &&
      Math.abs(a14 - b14) <= EPSILON * Math.max(1.0, Math.abs(a14), Math.abs(b14)) &&
      Math.abs(a15 - b15) <= EPSILON * Math.max(1.0, Math.abs(a15), Math.abs(b15))
    )
  }
  /**
   * Alias for {@link mat4.multiply}
   * @function
   */

  var mul$3 = multiply$3

  /**
   * Alias for {@link mat4.subtract}
   * @function
   */

  var sub$3 = subtract$3

  var mat4 = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    create: create$3,
    clone: clone$3,
    copy: copy$3,
    fromValues: fromValues$3,
    set: set$3,
    identity: identity$3,
    transpose: transpose$2,
    invert: invert$3,
    adjoint: adjoint$2,
    determinant: determinant$3,
    multiply: multiply$3,
    translate: translate$2,
    scale: scale$3,
    rotate: rotate$3,
    rotateX: rotateX,
    rotateY: rotateY,
    rotateZ: rotateZ,
    fromTranslation: fromTranslation$2,
    fromScaling: fromScaling$3,
    fromRotation: fromRotation$3,
    fromXRotation: fromXRotation,
    fromYRotation: fromYRotation,
    fromZRotation: fromZRotation,
    fromRotationTranslation: fromRotationTranslation,
    fromQuat2: fromQuat2,
    getTranslation: getTranslation,
    getScaling: getScaling,
    getRotation: getRotation,
    decompose: decompose,
    fromRotationTranslationScale: fromRotationTranslationScale,
    fromRotationTranslationScaleOrigin: fromRotationTranslationScaleOrigin,
    fromQuat: fromQuat$1,
    frustum: frustum,
    perspective: perspective,
    perspectiveFromFieldOfView: perspectiveFromFieldOfView,
    ortho: ortho,
    lookAt: lookAt,
    targetTo: targetTo,
    str: str$3,
    frob: frob$3,
    add: add$3,
    subtract: subtract$3,
    multiplyScalar: multiplyScalar$3,
    multiplyScalarAndAdd: multiplyScalarAndAdd$3,
    exactEquals: exactEquals$3,
    equals: equals$4,
    mul: mul$3,
    sub: sub$3,
  })

  /**
   * 3 Dimensional Vector
   * @module vec3
   */

  /**
   * Creates a new, empty vec3
   *
   * @returns {vec3} a new 3D vector
   */

  function create$4() {
    var out = new ARRAY_TYPE(3)

    if (ARRAY_TYPE != Float32Array) {
      out[0] = 0

      out[1] = 0

      out[2] = 0
    }

    return out
  }
  /**
   * Creates a new vec3 initialized with values from an existing vector
   *
   * @param {ReadonlyVec3} a vector to clone
   * @returns {vec3} a new 3D vector
   */

  function clone$4(a) {
    var out = new ARRAY_TYPE(3)

    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    return out
  }
  /**
   * Calculates the length of a vec3
   *
   * @param {ReadonlyVec3} a vector to calculate length of
   * @returns {Number} length of a
   */

  function length(a) {
    var x = a[0]

    var y = a[1]

    var z = a[2]

    return Math.hypot(x, y, z)
  }
  /**
   * Creates a new vec3 initialized with the given values
   *
   * @param {Number} x X component
   * @param {Number} y Y component
   * @param {Number} z Z component
   * @returns {vec3} a new 3D vector
   */

  function fromValues$4(x, y, z) {
    var out = new ARRAY_TYPE(3)

    out[0] = x

    out[1] = y

    out[2] = z

    return out
  }
  /**
   * Copy the values from one vec3 to another
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the source vector
   * @returns {vec3} out
   */

  function copy$4(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    return out
  }
  /**
   * Set the components of a vec3 to the given values
   *
   * @param {vec3} out the receiving vector
   * @param {Number} x X component
   * @param {Number} y Y component
   * @param {Number} z Z component
   * @returns {vec3} out
   */

  function set$4(out, x, y, z) {
    out[0] = x

    out[1] = y

    out[2] = z

    return out
  }
  /**
   * Adds two vec3's
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {vec3} out
   */

  function add$4(out, a, b) {
    out[0] = a[0] + b[0]

    out[1] = a[1] + b[1]

    out[2] = a[2] + b[2]

    return out
  }
  /**
   * Subtracts vector b from vector a
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {vec3} out
   */

  function subtract$4(out, a, b) {
    out[0] = a[0] - b[0]

    out[1] = a[1] - b[1]

    out[2] = a[2] - b[2]

    return out
  }
  /**
   * Multiplies two vec3's
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {vec3} out
   */

  function multiply$4(out, a, b) {
    out[0] = a[0] * b[0]

    out[1] = a[1] * b[1]

    out[2] = a[2] * b[2]

    return out
  }
  /**
   * Divides two vec3's
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {vec3} out
   */

  function divide(out, a, b) {
    out[0] = a[0] / b[0]

    out[1] = a[1] / b[1]

    out[2] = a[2] / b[2]

    return out
  }
  /**
   * Math.ceil the components of a vec3
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a vector to ceil
   * @returns {vec3} out
   */

  function ceil(out, a) {
    out[0] = Math.ceil(a[0])

    out[1] = Math.ceil(a[1])

    out[2] = Math.ceil(a[2])

    return out
  }
  /**
   * Math.floor the components of a vec3
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a vector to floor
   * @returns {vec3} out
   */

  function floor(out, a) {
    out[0] = Math.floor(a[0])

    out[1] = Math.floor(a[1])

    out[2] = Math.floor(a[2])

    return out
  }
  /**
   * Returns the minimum of two vec3's
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {vec3} out
   */

  function min(out, a, b) {
    out[0] = Math.min(a[0], b[0])

    out[1] = Math.min(a[1], b[1])

    out[2] = Math.min(a[2], b[2])

    return out
  }
  /**
   * Returns the maximum of two vec3's
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {vec3} out
   */

  function max(out, a, b) {
    out[0] = Math.max(a[0], b[0])

    out[1] = Math.max(a[1], b[1])

    out[2] = Math.max(a[2], b[2])

    return out
  }
  /**
   * Math.round the components of a vec3
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a vector to round
   * @returns {vec3} out
   */

  function round(out, a) {
    out[0] = Math.round(a[0])

    out[1] = Math.round(a[1])

    out[2] = Math.round(a[2])

    return out
  }
  /**
   * Scales a vec3 by a scalar number
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the vector to scale
   * @param {Number} b amount to scale the vector by
   * @returns {vec3} out
   */

  function scale$4(out, a, b) {
    out[0] = a[0] * b

    out[1] = a[1] * b

    out[2] = a[2] * b

    return out
  }
  /**
   * Adds two vec3's after scaling the second operand by a scalar value
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @param {Number} scale the amount to scale b by before adding
   * @returns {vec3} out
   */

  function scaleAndAdd(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale

    out[1] = a[1] + b[1] * scale

    out[2] = a[2] + b[2] * scale

    return out
  }
  /**
   * Calculates the euclidian distance between two vec3's
   *
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {Number} distance between a and b
   */

  function distance(a, b) {
    var x = b[0] - a[0]

    var y = b[1] - a[1]

    var z = b[2] - a[2]

    return Math.hypot(x, y, z)
  }
  /**
   * Calculates the squared euclidian distance between two vec3's
   *
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {Number} squared distance between a and b
   */

  function squaredDistance(a, b) {
    var x = b[0] - a[0]

    var y = b[1] - a[1]

    var z = b[2] - a[2]

    return x * x + y * y + z * z
  }
  /**
   * Calculates the squared length of a vec3
   *
   * @param {ReadonlyVec3} a vector to calculate squared length of
   * @returns {Number} squared length of a
   */

  function squaredLength(a) {
    var x = a[0]

    var y = a[1]

    var z = a[2]

    return x * x + y * y + z * z
  }
  /**
   * Negates the components of a vec3
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a vector to negate
   * @returns {vec3} out
   */

  function negate(out, a) {
    out[0] = -a[0]

    out[1] = -a[1]

    out[2] = -a[2]

    return out
  }
  /**
   * Returns the inverse of the components of a vec3
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a vector to invert
   * @returns {vec3} out
   */

  function inverse(out, a) {
    out[0] = 1.0 / a[0]

    out[1] = 1.0 / a[1]

    out[2] = 1.0 / a[2]

    return out
  }
  /**
   * Normalize a vec3
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a vector to normalize
   * @returns {vec3} out
   */

  function normalize(out, a) {
    var x = a[0]

    var y = a[1]

    var z = a[2]

    var len = x * x + y * y + z * z

    if (len > 0) {
      //TODO: evaluate use of glm_invsqrt here?
      len = 1 / Math.sqrt(len)
    }

    out[0] = a[0] * len

    out[1] = a[1] * len

    out[2] = a[2] * len

    return out
  }
  /**
   * Calculates the dot product of two vec3's
   *
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {Number} dot product of a and b
   */

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  }
  /**
   * Computes the cross product of two vec3's
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @returns {vec3} out
   */

  function cross(out, a, b) {
    var ax = a[0],
      ay = a[1],
      az = a[2]

    var bx = b[0],
      by = b[1],
      bz = b[2]

    out[0] = ay * bz - az * by

    out[1] = az * bx - ax * bz

    out[2] = ax * by - ay * bx

    return out
  }
  /**
   * Performs a linear interpolation between two vec3's
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {vec3} out
   */

  function lerp(out, a, b, t) {
    var ax = a[0]

    var ay = a[1]

    var az = a[2]

    out[0] = ax + t * (b[0] - ax)

    out[1] = ay + t * (b[1] - ay)

    out[2] = az + t * (b[2] - az)

    return out
  }
  /**
   * Performs a spherical linear interpolation between two vec3's
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {vec3} out
   */

  function slerp(out, a, b, t) {
    var angle = Math.acos(Math.min(Math.max(dot(a, b), -1), 1))

    var sinTotal = Math.sin(angle)

    var ratioA = Math.sin((1 - t) * angle) / sinTotal

    var ratioB = Math.sin(t * angle) / sinTotal

    out[0] = ratioA * a[0] + ratioB * b[0]

    out[1] = ratioA * a[1] + ratioB * b[1]

    out[2] = ratioA * a[2] + ratioB * b[2]

    return out
  }
  /**
   * Performs a hermite interpolation with two control points
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @param {ReadonlyVec3} c the third operand
   * @param {ReadonlyVec3} d the fourth operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {vec3} out
   */

  function hermite(out, a, b, c, d, t) {
    var factorTimes2 = t * t

    var factor1 = factorTimes2 * (2 * t - 3) + 1

    var factor2 = factorTimes2 * (t - 2) + t

    var factor3 = factorTimes2 * (t - 1)

    var factor4 = factorTimes2 * (3 - 2 * t)

    out[0] = a[0] * factor1 + b[0] * factor2 + c[0] * factor3 + d[0] * factor4

    out[1] = a[1] * factor1 + b[1] * factor2 + c[1] * factor3 + d[1] * factor4

    out[2] = a[2] * factor1 + b[2] * factor2 + c[2] * factor3 + d[2] * factor4

    return out
  }
  /**
   * Performs a bezier interpolation with two control points
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the first operand
   * @param {ReadonlyVec3} b the second operand
   * @param {ReadonlyVec3} c the third operand
   * @param {ReadonlyVec3} d the fourth operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {vec3} out
   */

  function bezier(out, a, b, c, d, t) {
    var inverseFactor = 1 - t

    var inverseFactorTimesTwo = inverseFactor * inverseFactor

    var factorTimes2 = t * t

    var factor1 = inverseFactorTimesTwo * inverseFactor

    var factor2 = 3 * t * inverseFactorTimesTwo

    var factor3 = 3 * factorTimes2 * inverseFactor

    var factor4 = factorTimes2 * t

    out[0] = a[0] * factor1 + b[0] * factor2 + c[0] * factor3 + d[0] * factor4

    out[1] = a[1] * factor1 + b[1] * factor2 + c[1] * factor3 + d[1] * factor4

    out[2] = a[2] * factor1 + b[2] * factor2 + c[2] * factor3 + d[2] * factor4

    return out
  }
  /**
   * Generates a random vector with the given scale
   *
   * @param {vec3} out the receiving vector
   * @param {Number} [scale] Length of the resulting vector. If ommitted, a unit vector will be returned
   * @returns {vec3} out
   */

  function random(out, scale) {
    scale = scale || 1.0

    var r = RANDOM() * 2.0 * Math.PI

    var z = RANDOM() * 2.0 - 1.0

    var zScale = Math.sqrt(1.0 - z * z) * scale

    out[0] = Math.cos(r) * zScale

    out[1] = Math.sin(r) * zScale

    out[2] = z * scale

    return out
  }
  /**
   * Transforms the vec3 with a mat4.
   * 4th vector component is implicitly '1'
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the vector to transform
   * @param {ReadonlyMat4} m matrix to transform with
   * @returns {vec3} out
   */

  function transformMat4(out, a, m) {
    var x = a[0],
      y = a[1],
      z = a[2]

    var w = m[3] * x + m[7] * y + m[11] * z + m[15]

    w = w || 1.0

    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w

    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w

    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w

    return out
  }
  /**
   * Transforms the vec3 with a mat3.
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the vector to transform
   * @param {ReadonlyMat3} m the 3x3 matrix to transform with
   * @returns {vec3} out
   */

  function transformMat3(out, a, m) {
    var x = a[0],
      y = a[1],
      z = a[2]

    out[0] = x * m[0] + y * m[3] + z * m[6]

    out[1] = x * m[1] + y * m[4] + z * m[7]

    out[2] = x * m[2] + y * m[5] + z * m[8]

    return out
  }
  /**
   * Transforms the vec3 with a quat
   * Can also be used for dual quaternions. (Multiply it with the real part)
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec3} a the vector to transform
   * @param {ReadonlyQuat} q quaternion to transform with
   * @returns {vec3} out
   */

  function transformQuat(out, a, q) {
    // benchmarks: https://jsperf.com/quaternion-transform-vec3-implementations-fixed
    var qx = q[0],
      qy = q[1],
      qz = q[2],
      qw = q[3]

    var x = a[0],
      y = a[1],
      z = a[2]
    // var qvec = [qx, qy, qz];

    // var uv = vec3.cross([], qvec, a);

    var uvx = qy * z - qz * y,
      uvy = qz * x - qx * z,
      uvz = qx * y - qy * x
    // var uuv = vec3.cross([], qvec, uv);

    var uuvx = qy * uvz - qz * uvy,
      uuvy = qz * uvx - qx * uvz,
      uuvz = qx * uvy - qy * uvx
    // vec3.scale(uv, uv, 2 * w);

    var w2 = qw * 2

    uvx *= w2

    uvy *= w2

    uvz *= w2
    // vec3.scale(uuv, uuv, 2);

    uuvx *= 2

    uuvy *= 2

    uuvz *= 2
    // return vec3.add(out, a, vec3.add(out, uv, uuv));

    out[0] = x + uvx + uuvx

    out[1] = y + uvy + uuvy

    out[2] = z + uvz + uuvz

    return out
  }
  /**
   * Rotate a 3D vector around the x-axis
   * @param {vec3} out The receiving vec3
   * @param {ReadonlyVec3} a The vec3 point to rotate
   * @param {ReadonlyVec3} b The origin of the rotation
   * @param {Number} rad The angle of rotation in radians
   * @returns {vec3} out
   */

  function rotateX$1(out, a, b, rad) {
    var p = [],
      r = []
    //Translate point to the origin

    p[0] = a[0] - b[0]

    p[1] = a[1] - b[1]

    p[2] = a[2] - b[2]
    //perform rotation

    r[0] = p[0]

    r[1] = p[1] * Math.cos(rad) - p[2] * Math.sin(rad)

    r[2] = p[1] * Math.sin(rad) + p[2] * Math.cos(rad)
    //translate to correct position

    out[0] = r[0] + b[0]

    out[1] = r[1] + b[1]

    out[2] = r[2] + b[2]

    return out
  }
  /**
   * Rotate a 3D vector around the y-axis
   * @param {vec3} out The receiving vec3
   * @param {ReadonlyVec3} a The vec3 point to rotate
   * @param {ReadonlyVec3} b The origin of the rotation
   * @param {Number} rad The angle of rotation in radians
   * @returns {vec3} out
   */

  function rotateY$1(out, a, b, rad) {
    var p = [],
      r = []
    //Translate point to the origin

    p[0] = a[0] - b[0]

    p[1] = a[1] - b[1]

    p[2] = a[2] - b[2]
    //perform rotation

    r[0] = p[2] * Math.sin(rad) + p[0] * Math.cos(rad)

    r[1] = p[1]

    r[2] = p[2] * Math.cos(rad) - p[0] * Math.sin(rad)
    //translate to correct position

    out[0] = r[0] + b[0]

    out[1] = r[1] + b[1]

    out[2] = r[2] + b[2]

    return out
  }
  /**
   * Rotate a 3D vector around the z-axis
   * @param {vec3} out The receiving vec3
   * @param {ReadonlyVec3} a The vec3 point to rotate
   * @param {ReadonlyVec3} b The origin of the rotation
   * @param {Number} rad The angle of rotation in radians
   * @returns {vec3} out
   */

  function rotateZ$1(out, a, b, rad) {
    var p = [],
      r = []
    //Translate point to the origin

    p[0] = a[0] - b[0]

    p[1] = a[1] - b[1]

    p[2] = a[2] - b[2]
    //perform rotation

    r[0] = p[0] * Math.cos(rad) - p[1] * Math.sin(rad)

    r[1] = p[0] * Math.sin(rad) + p[1] * Math.cos(rad)

    r[2] = p[2]
    //translate to correct position

    out[0] = r[0] + b[0]

    out[1] = r[1] + b[1]

    out[2] = r[2] + b[2]

    return out
  }
  /**
   * Get the angle between two 3D vectors
   * @param {ReadonlyVec3} a The first operand
   * @param {ReadonlyVec3} b The second operand
   * @returns {Number} The angle in radians
   */

  function angle(a, b) {
    var ax = a[0],
      ay = a[1],
      az = a[2],
      bx = b[0],
      by = b[1],
      bz = b[2],
      mag1 = Math.sqrt(ax * ax + ay * ay + az * az),
      mag2 = Math.sqrt(bx * bx + by * by + bz * bz),
      mag = mag1 * mag2,
      cosine = mag && dot(a, b) / mag

    return Math.acos(Math.min(Math.max(cosine, -1), 1))
  }
  /**
   * Set the components of a vec3 to zero
   *
   * @param {vec3} out the receiving vector
   * @returns {vec3} out
   */

  function zero(out) {
    out[0] = 0.0

    out[1] = 0.0

    out[2] = 0.0

    return out
  }
  /**
   * Returns a string representation of a vector
   *
   * @param {ReadonlyVec3} a vector to represent as a string
   * @returns {String} string representation of the vector
   */

  function str$4(a) {
    return "vec3(" + a[0] + ", " + a[1] + ", " + a[2] + ")"
  }
  /**
   * Returns whether or not the vectors have exactly the same elements in the same position (when compared with ===)
   *
   * @param {ReadonlyVec3} a The first vector.
   * @param {ReadonlyVec3} b The second vector.
   * @returns {Boolean} True if the vectors are equal, false otherwise.
   */

  function exactEquals$4(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
  }
  /**
   * Returns whether or not the vectors have approximately the same elements in the same position.
   *
   * @param {ReadonlyVec3} a The first vector.
   * @param {ReadonlyVec3} b The second vector.
   * @returns {Boolean} True if the vectors are equal, false otherwise.
   */

  function equals$5(a, b) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2]

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2]

    return (
      Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
      Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
      Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2))
    )
  }
  /**
   * Alias for {@link vec3.subtract}
   * @function
   */

  var sub$4 = subtract$4

  /**
   * Alias for {@link vec3.multiply}
   * @function
   */

  var mul$4 = multiply$4

  /**
   * Alias for {@link vec3.divide}
   * @function
   */

  var div = divide

  /**
   * Alias for {@link vec3.distance}
   * @function
   */

  var dist = distance

  /**
   * Alias for {@link vec3.squaredDistance}
   * @function
   */

  var sqrDist = squaredDistance

  /**
   * Alias for {@link vec3.length}
   * @function
   */

  var len = length

  /**
   * Alias for {@link vec3.squaredLength}
   * @function
   */

  var sqrLen = squaredLength

  /**
   * Perform some operation over an array of vec3s.
   *
   * @param {Array} a the array of vectors to iterate over
   * @param {Number} stride Number of elements between the start of each vec3. If 0 assumes tightly packed
   * @param {Number} offset Number of elements to skip at the beginning of the array
   * @param {Number} count Number of vec3s to iterate over. If 0 iterates over entire array
   * @param {Function} fn Function to call for each vector in the array
   * @param {Object} [arg] additional argument to pass to fn
   * @returns {Array} a
   * @function
   */

  var forEach = (function () {
    var vec = create$4()

    return function (a, stride, offset, count, fn, arg) {
      var i, l

      if (!stride) {
        stride = 3
      }

      if (!offset) {
        offset = 0
      }

      if (count) {
        l = Math.min(count * stride + offset, a.length)
      } else {
        l = a.length
      }

      for (i = offset; i < l; i += stride) {
        vec[0] = a[i]

        vec[1] = a[i + 1]

        vec[2] = a[i + 2]

        fn(vec, vec, arg)

        a[i] = vec[0]

        a[i + 1] = vec[1]

        a[i + 2] = vec[2]
      }

      return a
    }
  })()

  var vec3 = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    create: create$4,
    clone: clone$4,
    length: length,
    fromValues: fromValues$4,
    copy: copy$4,
    set: set$4,
    add: add$4,
    subtract: subtract$4,
    multiply: multiply$4,
    divide: divide,
    ceil: ceil,
    floor: floor,
    min: min,
    max: max,
    round: round,
    scale: scale$4,
    scaleAndAdd: scaleAndAdd,
    distance: distance,
    squaredDistance: squaredDistance,
    squaredLength: squaredLength,
    negate: negate,
    inverse: inverse,
    normalize: normalize,
    dot: dot,
    cross: cross,
    lerp: lerp,
    slerp: slerp,
    hermite: hermite,
    bezier: bezier,
    random: random,
    transformMat4: transformMat4,
    transformMat3: transformMat3,
    transformQuat: transformQuat,
    rotateX: rotateX$1,
    rotateY: rotateY$1,
    rotateZ: rotateZ$1,
    angle: angle,
    zero: zero,
    str: str$4,
    exactEquals: exactEquals$4,
    equals: equals$5,
    sub: sub$4,
    mul: mul$4,
    div: div,
    dist: dist,
    sqrDist: sqrDist,
    len: len,
    sqrLen: sqrLen,
    forEach: forEach,
  })

  /**
   * 4 Dimensional Vector
   * @module vec4
   */

  /**
   * Creates a new, empty vec4
   *
   * @returns {vec4} a new 4D vector
   */

  function create$5() {
    var out = new ARRAY_TYPE(4)

    if (ARRAY_TYPE != Float32Array) {
      out[0] = 0

      out[1] = 0

      out[2] = 0

      out[3] = 0
    }

    return out
  }
  /**
   * Creates a new vec4 initialized with values from an existing vector
   *
   * @param {ReadonlyVec4} a vector to clone
   * @returns {vec4} a new 4D vector
   */

  function clone$5(a) {
    var out = new ARRAY_TYPE(4)

    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    return out
  }
  /**
   * Creates a new vec4 initialized with the given values
   *
   * @param {Number} x X component
   * @param {Number} y Y component
   * @param {Number} z Z component
   * @param {Number} w W component
   * @returns {vec4} a new 4D vector
   */

  function fromValues$5(x, y, z, w) {
    var out = new ARRAY_TYPE(4)

    out[0] = x

    out[1] = y

    out[2] = z

    out[3] = w

    return out
  }
  /**
   * Copy the values from one vec4 to another
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the source vector
   * @returns {vec4} out
   */

  function copy$5(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    return out
  }
  /**
   * Set the components of a vec4 to the given values
   *
   * @param {vec4} out the receiving vector
   * @param {Number} x X component
   * @param {Number} y Y component
   * @param {Number} z Z component
   * @param {Number} w W component
   * @returns {vec4} out
   */

  function set$5(out, x, y, z, w) {
    out[0] = x

    out[1] = y

    out[2] = z

    out[3] = w

    return out
  }
  /**
   * Adds two vec4's
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @returns {vec4} out
   */

  function add$5(out, a, b) {
    out[0] = a[0] + b[0]

    out[1] = a[1] + b[1]

    out[2] = a[2] + b[2]

    out[3] = a[3] + b[3]

    return out
  }
  /**
   * Subtracts vector b from vector a
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @returns {vec4} out
   */

  function subtract$5(out, a, b) {
    out[0] = a[0] - b[0]

    out[1] = a[1] - b[1]

    out[2] = a[2] - b[2]

    out[3] = a[3] - b[3]

    return out
  }
  /**
   * Multiplies two vec4's
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @returns {vec4} out
   */

  function multiply$5(out, a, b) {
    out[0] = a[0] * b[0]

    out[1] = a[1] * b[1]

    out[2] = a[2] * b[2]

    out[3] = a[3] * b[3]

    return out
  }
  /**
   * Divides two vec4's
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @returns {vec4} out
   */

  function divide$1(out, a, b) {
    out[0] = a[0] / b[0]

    out[1] = a[1] / b[1]

    out[2] = a[2] / b[2]

    out[3] = a[3] / b[3]

    return out
  }
  /**
   * Math.ceil the components of a vec4
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a vector to ceil
   * @returns {vec4} out
   */

  function ceil$1(out, a) {
    out[0] = Math.ceil(a[0])

    out[1] = Math.ceil(a[1])

    out[2] = Math.ceil(a[2])

    out[3] = Math.ceil(a[3])

    return out
  }
  /**
   * Math.floor the components of a vec4
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a vector to floor
   * @returns {vec4} out
   */

  function floor$1(out, a) {
    out[0] = Math.floor(a[0])

    out[1] = Math.floor(a[1])

    out[2] = Math.floor(a[2])

    out[3] = Math.floor(a[3])

    return out
  }
  /**
   * Returns the minimum of two vec4's
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @returns {vec4} out
   */

  function min$1(out, a, b) {
    out[0] = Math.min(a[0], b[0])

    out[1] = Math.min(a[1], b[1])

    out[2] = Math.min(a[2], b[2])

    out[3] = Math.min(a[3], b[3])

    return out
  }
  /**
   * Returns the maximum of two vec4's
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @returns {vec4} out
   */

  function max$1(out, a, b) {
    out[0] = Math.max(a[0], b[0])

    out[1] = Math.max(a[1], b[1])

    out[2] = Math.max(a[2], b[2])

    out[3] = Math.max(a[3], b[3])

    return out
  }
  /**
   * Math.round the components of a vec4
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a vector to round
   * @returns {vec4} out
   */

  function round$1(out, a) {
    out[0] = Math.round(a[0])

    out[1] = Math.round(a[1])

    out[2] = Math.round(a[2])

    out[3] = Math.round(a[3])

    return out
  }
  /**
   * Scales a vec4 by a scalar number
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the vector to scale
   * @param {Number} b amount to scale the vector by
   * @returns {vec4} out
   */

  function scale$5(out, a, b) {
    out[0] = a[0] * b

    out[1] = a[1] * b

    out[2] = a[2] * b

    out[3] = a[3] * b

    return out
  }
  /**
   * Adds two vec4's after scaling the second operand by a scalar value
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @param {Number} scale the amount to scale b by before adding
   * @returns {vec4} out
   */

  function scaleAndAdd$1(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale

    out[1] = a[1] + b[1] * scale

    out[2] = a[2] + b[2] * scale

    out[3] = a[3] + b[3] * scale

    return out
  }
  /**
   * Calculates the euclidian distance between two vec4's
   *
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @returns {Number} distance between a and b
   */

  function distance$1(a, b) {
    var x = b[0] - a[0]

    var y = b[1] - a[1]

    var z = b[2] - a[2]

    var w = b[3] - a[3]

    return Math.hypot(x, y, z, w)
  }
  /**
   * Calculates the squared euclidian distance between two vec4's
   *
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @returns {Number} squared distance between a and b
   */

  function squaredDistance$1(a, b) {
    var x = b[0] - a[0]

    var y = b[1] - a[1]

    var z = b[2] - a[2]

    var w = b[3] - a[3]

    return x * x + y * y + z * z + w * w
  }
  /**
   * Calculates the length of a vec4
   *
   * @param {ReadonlyVec4} a vector to calculate length of
   * @returns {Number} length of a
   */

  function length$1(a) {
    var x = a[0]

    var y = a[1]

    var z = a[2]

    var w = a[3]

    return Math.hypot(x, y, z, w)
  }
  /**
   * Calculates the squared length of a vec4
   *
   * @param {ReadonlyVec4} a vector to calculate squared length of
   * @returns {Number} squared length of a
   */

  function squaredLength$1(a) {
    var x = a[0]

    var y = a[1]

    var z = a[2]

    var w = a[3]

    return x * x + y * y + z * z + w * w
  }
  /**
   * Negates the components of a vec4
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a vector to negate
   * @returns {vec4} out
   */

  function negate$1(out, a) {
    out[0] = -a[0]

    out[1] = -a[1]

    out[2] = -a[2]

    out[3] = -a[3]

    return out
  }
  /**
   * Returns the inverse of the components of a vec4
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a vector to invert
   * @returns {vec4} out
   */

  function inverse$1(out, a) {
    out[0] = 1.0 / a[0]

    out[1] = 1.0 / a[1]

    out[2] = 1.0 / a[2]

    out[3] = 1.0 / a[3]

    return out
  }
  /**
   * Normalize a vec4
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a vector to normalize
   * @returns {vec4} out
   */

  function normalize$1(out, a) {
    var x = a[0]

    var y = a[1]

    var z = a[2]

    var w = a[3]

    var len = x * x + y * y + z * z + w * w

    if (len > 0) {
      len = 1 / Math.sqrt(len)
    }

    out[0] = x * len

    out[1] = y * len

    out[2] = z * len

    out[3] = w * len

    return out
  }
  /**
   * Calculates the dot product of two vec4's
   *
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @returns {Number} dot product of a and b
   */

  function dot$1(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  }
  /**
   * Returns the cross-product of three vectors in a 4-dimensional space
   *
   * @param {ReadonlyVec4} result the receiving vector
   * @param {ReadonlyVec4} U the first vector
   * @param {ReadonlyVec4} V the second vector
   * @param {ReadonlyVec4} W the third vector
   * @returns {vec4} result
   */

  function cross$1(out, u, v, w) {
    var A = v[0] * w[1] - v[1] * w[0],
      B = v[0] * w[2] - v[2] * w[0],
      C = v[0] * w[3] - v[3] * w[0],
      D = v[1] * w[2] - v[2] * w[1],
      E = v[1] * w[3] - v[3] * w[1],
      F = v[2] * w[3] - v[3] * w[2]

    var G = u[0]

    var H = u[1]

    var I = u[2]

    var J = u[3]

    out[0] = H * F - I * E + J * D

    out[1] = -(G * F) + I * C - J * B

    out[2] = G * E - H * C + J * A

    out[3] = -(G * D) + H * B - I * A

    return out
  }
  /**
   * Performs a linear interpolation between two vec4's
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the first operand
   * @param {ReadonlyVec4} b the second operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {vec4} out
   */

  function lerp$1(out, a, b, t) {
    var ax = a[0]

    var ay = a[1]

    var az = a[2]

    var aw = a[3]

    out[0] = ax + t * (b[0] - ax)

    out[1] = ay + t * (b[1] - ay)

    out[2] = az + t * (b[2] - az)

    out[3] = aw + t * (b[3] - aw)

    return out
  }
  /**
   * Generates a random vector with the given scale
   *
   * @param {vec4} out the receiving vector
   * @param {Number} [scale] Length of the resulting vector. If ommitted, a unit vector will be returned
   * @returns {vec4} out
   */

  function random$1(out, scale) {
    scale = scale || 1.0
    // Marsaglia, George. Choosing a Point from the Surface of a
    // Sphere. Ann. Math. Statist. 43 (1972), no. 2, 645--646.
    // http://projecteuclid.org/euclid.aoms/1177692644;

    var v1, v2, v3, v4

    var s1, s2

    do {
      v1 = RANDOM() * 2 - 1

      v2 = RANDOM() * 2 - 1

      s1 = v1 * v1 + v2 * v2
    } while (s1 >= 1)

    do {
      v3 = RANDOM() * 2 - 1

      v4 = RANDOM() * 2 - 1

      s2 = v3 * v3 + v4 * v4
    } while (s2 >= 1)

    var d = Math.sqrt((1 - s1) / s2)

    out[0] = scale * v1

    out[1] = scale * v2

    out[2] = scale * v3 * d

    out[3] = scale * v4 * d

    return out
  }
  /**
   * Transforms the vec4 with a mat4.
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the vector to transform
   * @param {ReadonlyMat4} m matrix to transform with
   * @returns {vec4} out
   */

  function transformMat4$1(out, a, m) {
    var x = a[0],
      y = a[1],
      z = a[2],
      w = a[3]

    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w

    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w

    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w

    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w

    return out
  }
  /**
   * Transforms the vec4 with a quat
   *
   * @param {vec4} out the receiving vector
   * @param {ReadonlyVec4} a the vector to transform
   * @param {ReadonlyQuat} q quaternion to transform with
   * @returns {vec4} out
   */

  function transformQuat$1(out, a, q) {
    var x = a[0],
      y = a[1],
      z = a[2]

    var qx = q[0],
      qy = q[1],
      qz = q[2],
      qw = q[3]
    // calculate quat * vec

    var ix = qw * x + qy * z - qz * y

    var iy = qw * y + qz * x - qx * z

    var iz = qw * z + qx * y - qy * x

    var iw = -qx * x - qy * y - qz * z
    // calculate result * inverse quat

    out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy

    out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz

    out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx

    out[3] = a[3]

    return out
  }
  /**
   * Set the components of a vec4 to zero
   *
   * @param {vec4} out the receiving vector
   * @returns {vec4} out
   */

  function zero$1(out) {
    out[0] = 0.0

    out[1] = 0.0

    out[2] = 0.0

    out[3] = 0.0

    return out
  }
  /**
   * Returns a string representation of a vector
   *
   * @param {ReadonlyVec4} a vector to represent as a string
   * @returns {String} string representation of the vector
   */

  function str$5(a) {
    return "vec4(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")"
  }
  /**
   * Returns whether or not the vectors have exactly the same elements in the same position (when compared with ===)
   *
   * @param {ReadonlyVec4} a The first vector.
   * @param {ReadonlyVec4} b The second vector.
   * @returns {Boolean} True if the vectors are equal, false otherwise.
   */

  function exactEquals$5(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
  }
  /**
   * Returns whether or not the vectors have approximately the same elements in the same position.
   *
   * @param {ReadonlyVec4} a The first vector.
   * @param {ReadonlyVec4} b The second vector.
   * @returns {Boolean} True if the vectors are equal, false otherwise.
   */

  function equals$6(a, b) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3]

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2],
      b3 = b[3]

    return (
      Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
      Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
      Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
      Math.abs(a3 - b3) <= EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3))
    )
  }
  /**
   * Alias for {@link vec4.subtract}
   * @function
   */

  var sub$5 = subtract$5

  /**
   * Alias for {@link vec4.multiply}
   * @function
   */

  var mul$5 = multiply$5

  /**
   * Alias for {@link vec4.divide}
   * @function
   */

  var div$1 = divide$1

  /**
   * Alias for {@link vec4.distance}
   * @function
   */

  var dist$1 = distance$1

  /**
   * Alias for {@link vec4.squaredDistance}
   * @function
   */

  var sqrDist$1 = squaredDistance$1

  /**
   * Alias for {@link vec4.length}
   * @function
   */

  var len$1 = length$1

  /**
   * Alias for {@link vec4.squaredLength}
   * @function
   */

  var sqrLen$1 = squaredLength$1

  /**
   * Perform some operation over an array of vec4s.
   *
   * @param {Array} a the array of vectors to iterate over
   * @param {Number} stride Number of elements between the start of each vec4. If 0 assumes tightly packed
   * @param {Number} offset Number of elements to skip at the beginning of the array
   * @param {Number} count Number of vec4s to iterate over. If 0 iterates over entire array
   * @param {Function} fn Function to call for each vector in the array
   * @param {Object} [arg] additional argument to pass to fn
   * @returns {Array} a
   * @function
   */

  var forEach$1 = (function () {
    var vec = create$5()

    return function (a, stride, offset, count, fn, arg) {
      var i, l

      if (!stride) {
        stride = 4
      }

      if (!offset) {
        offset = 0
      }

      if (count) {
        l = Math.min(count * stride + offset, a.length)
      } else {
        l = a.length
      }

      for (i = offset; i < l; i += stride) {
        vec[0] = a[i]

        vec[1] = a[i + 1]

        vec[2] = a[i + 2]

        vec[3] = a[i + 3]

        fn(vec, vec, arg)

        a[i] = vec[0]

        a[i + 1] = vec[1]

        a[i + 2] = vec[2]

        a[i + 3] = vec[3]
      }

      return a
    }
  })()

  var vec4 = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    create: create$5,
    clone: clone$5,
    fromValues: fromValues$5,
    copy: copy$5,
    set: set$5,
    add: add$5,
    subtract: subtract$5,
    multiply: multiply$5,
    divide: divide$1,
    ceil: ceil$1,
    floor: floor$1,
    min: min$1,
    max: max$1,
    round: round$1,
    scale: scale$5,
    scaleAndAdd: scaleAndAdd$1,
    distance: distance$1,
    squaredDistance: squaredDistance$1,
    length: length$1,
    squaredLength: squaredLength$1,
    negate: negate$1,
    inverse: inverse$1,
    normalize: normalize$1,
    dot: dot$1,
    cross: cross$1,
    lerp: lerp$1,
    random: random$1,
    transformMat4: transformMat4$1,
    transformQuat: transformQuat$1,
    zero: zero$1,
    str: str$5,
    exactEquals: exactEquals$5,
    equals: equals$6,
    sub: sub$5,
    mul: mul$5,
    div: div$1,
    dist: dist$1,
    sqrDist: sqrDist$1,
    len: len$1,
    sqrLen: sqrLen$1,
    forEach: forEach$1,
  })

  /**
   * Quaternion in the format XYZW
   * @module quat
   */

  /**
   * Creates a new identity quat
   *
   * @returns {quat} a new quaternion
   */

  function create$6() {
    var out = new ARRAY_TYPE(4)

    if (ARRAY_TYPE != Float32Array) {
      out[0] = 0

      out[1] = 0

      out[2] = 0
    }

    out[3] = 1

    return out
  }
  /**
   * Set a quat to the identity quaternion
   *
   * @param {quat} out the receiving quaternion
   * @returns {quat} out
   */

  function identity$4(out) {
    out[0] = 0

    out[1] = 0

    out[2] = 0

    out[3] = 1

    return out
  }
  /**
   * Sets a quat from the given angle and rotation axis,
   * then returns it.
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyVec3} axis the axis around which to rotate
   * @param {Number} rad the angle in radians
   * @returns {quat} out
   **/

  function setAxisAngle(out, axis, rad) {
    rad = rad * 0.5

    var s = Math.sin(rad)

    out[0] = s * axis[0]

    out[1] = s * axis[1]

    out[2] = s * axis[2]

    out[3] = Math.cos(rad)

    return out
  }
  /**
   * Gets the rotation axis and angle for a given
   *  quaternion. If a quaternion is created with
   *  setAxisAngle, this method will return the same
   *  values as providied in the original parameter list
   *  OR functionally equivalent values.
   * Example: The quaternion formed by axis [0, 0, 1] and
   *  angle -90 is the same as the quaternion formed by
   *  [0, 0, 1] and 270. This method favors the latter.
   * @param  {vec3} out_axis  Vector receiving the axis of rotation
   * @param  {ReadonlyQuat} q     Quaternion to be decomposed
   * @return {Number}     Angle, in radians, of the rotation
   */

  function getAxisAngle(out_axis, q) {
    var rad = Math.acos(q[3]) * 2.0

    var s = Math.sin(rad / 2.0)

    if (s > EPSILON) {
      out_axis[0] = q[0] / s

      out_axis[1] = q[1] / s

      out_axis[2] = q[2] / s
    } else {
      // If s is zero, return any axis (no rotation - axis does not matter)
      out_axis[0] = 1

      out_axis[1] = 0

      out_axis[2] = 0
    }

    return rad
  }
  /**
   * Gets the angular distance between two unit quaternions
   *
   * @param  {ReadonlyQuat} a     Origin unit quaternion
   * @param  {ReadonlyQuat} b     Destination unit quaternion
   * @return {Number}     Angle, in radians, between the two quaternions
   */

  function getAngle(a, b) {
    var dotproduct = dot$2(a, b)

    return Math.acos(2 * dotproduct * dotproduct - 1)
  }
  /**
   * Multiplies two quat's
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a the first operand
   * @param {ReadonlyQuat} b the second operand
   * @returns {quat} out
   */

  function multiply$6(out, a, b) {
    var ax = a[0],
      ay = a[1],
      az = a[2],
      aw = a[3]

    var bx = b[0],
      by = b[1],
      bz = b[2],
      bw = b[3]

    out[0] = ax * bw + aw * bx + ay * bz - az * by

    out[1] = ay * bw + aw * by + az * bx - ax * bz

    out[2] = az * bw + aw * bz + ax * by - ay * bx

    out[3] = aw * bw - ax * bx - ay * by - az * bz

    return out
  }
  /**
   * Rotates a quaternion by the given angle about the X axis
   *
   * @param {quat} out quat receiving operation result
   * @param {ReadonlyQuat} a quat to rotate
   * @param {number} rad angle (in radians) to rotate
   * @returns {quat} out
   */

  function rotateX$2(out, a, rad) {
    rad *= 0.5

    var ax = a[0],
      ay = a[1],
      az = a[2],
      aw = a[3]

    var bx = Math.sin(rad),
      bw = Math.cos(rad)

    out[0] = ax * bw + aw * bx

    out[1] = ay * bw + az * bx

    out[2] = az * bw - ay * bx

    out[3] = aw * bw - ax * bx

    return out
  }
  /**
   * Rotates a quaternion by the given angle about the Y axis
   *
   * @param {quat} out quat receiving operation result
   * @param {ReadonlyQuat} a quat to rotate
   * @param {number} rad angle (in radians) to rotate
   * @returns {quat} out
   */

  function rotateY$2(out, a, rad) {
    rad *= 0.5

    var ax = a[0],
      ay = a[1],
      az = a[2],
      aw = a[3]

    var by = Math.sin(rad),
      bw = Math.cos(rad)

    out[0] = ax * bw - az * by

    out[1] = ay * bw + aw * by

    out[2] = az * bw + ax * by

    out[3] = aw * bw - ay * by

    return out
  }
  /**
   * Rotates a quaternion by the given angle about the Z axis
   *
   * @param {quat} out quat receiving operation result
   * @param {ReadonlyQuat} a quat to rotate
   * @param {number} rad angle (in radians) to rotate
   * @returns {quat} out
   */

  function rotateZ$2(out, a, rad) {
    rad *= 0.5

    var ax = a[0],
      ay = a[1],
      az = a[2],
      aw = a[3]

    var bz = Math.sin(rad),
      bw = Math.cos(rad)

    out[0] = ax * bw + ay * bz

    out[1] = ay * bw - ax * bz

    out[2] = az * bw + aw * bz

    out[3] = aw * bw - az * bz

    return out
  }
  /**
   * Calculates the W component of a quat from the X, Y, and Z components.
   * Assumes that quaternion is 1 unit in length.
   * Any existing W component will be ignored.
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a quat to calculate W component of
   * @returns {quat} out
   */

  function calculateW(out, a) {
    var x = a[0],
      y = a[1],
      z = a[2]

    out[0] = x

    out[1] = y

    out[2] = z

    out[3] = Math.sqrt(Math.abs(1.0 - x * x - y * y - z * z))

    return out
  }
  /**
   * Calculate the exponential of a unit quaternion.
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a quat to calculate the exponential of
   * @returns {quat} out
   */

  function exp(out, a) {
    var x = a[0],
      y = a[1],
      z = a[2],
      w = a[3]

    var r = Math.sqrt(x * x + y * y + z * z)

    var et = Math.exp(w)

    var s = r > 0 ? (et * Math.sin(r)) / r : 0

    out[0] = x * s

    out[1] = y * s

    out[2] = z * s

    out[3] = et * Math.cos(r)

    return out
  }
  /**
   * Calculate the natural logarithm of a unit quaternion.
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a quat to calculate the exponential of
   * @returns {quat} out
   */

  function ln(out, a) {
    var x = a[0],
      y = a[1],
      z = a[2],
      w = a[3]

    var r = Math.sqrt(x * x + y * y + z * z)

    var t = r > 0 ? Math.atan2(r, w) / r : 0

    out[0] = x * t

    out[1] = y * t

    out[2] = z * t

    out[3] = 0.5 * Math.log(x * x + y * y + z * z + w * w)

    return out
  }
  /**
   * Calculate the scalar power of a unit quaternion.
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a quat to calculate the exponential of
   * @param {Number} b amount to scale the quaternion by
   * @returns {quat} out
   */

  function pow(out, a, b) {
    ln(out, a)

    scale$6(out, out, b)

    exp(out, out)

    return out
  }
  /**
   * Performs a spherical linear interpolation between two quat
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a the first operand
   * @param {ReadonlyQuat} b the second operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {quat} out
   */

  function slerp$1(out, a, b, t) {
    // benchmarks:
    //    http://jsperf.com/quaternion-slerp-implementations
    var ax = a[0],
      ay = a[1],
      az = a[2],
      aw = a[3]

    var bx = b[0],
      by = b[1],
      bz = b[2],
      bw = b[3]

    var omega, cosom, sinom, scale0, scale1
    // calc cosine

    cosom = ax * bx + ay * by + az * bz + aw * bw
    // adjust signs (if necessary)

    if (cosom < 0.0) {
      cosom = -cosom

      bx = -bx

      by = -by

      bz = -bz

      bw = -bw
    } // calculate coefficients

    if (1.0 - cosom > EPSILON) {
      // standard case (slerp)
      omega = Math.acos(cosom)

      sinom = Math.sin(omega)

      scale0 = Math.sin((1.0 - t) * omega) / sinom

      scale1 = Math.sin(t * omega) / sinom
    } else {
      // "from" and "to" quaternions are very close
      //  ... so we can do a linear interpolation
      scale0 = 1.0 - t

      scale1 = t
    } // calculate final values

    out[0] = scale0 * ax + scale1 * bx

    out[1] = scale0 * ay + scale1 * by

    out[2] = scale0 * az + scale1 * bz

    out[3] = scale0 * aw + scale1 * bw

    return out
  }
  /**
   * Generates a random unit quaternion
   *
   * @param {quat} out the receiving quaternion
   * @returns {quat} out
   */

  function random$2(out) {
    // Implementation of http://planning.cs.uiuc.edu/node198.html
    // TODO: Calling random 3 times is probably not the fastest solution
    var u1 = RANDOM()

    var u2 = RANDOM()

    var u3 = RANDOM()

    var sqrt1MinusU1 = Math.sqrt(1 - u1)

    var sqrtU1 = Math.sqrt(u1)

    out[0] = sqrt1MinusU1 * Math.sin(2.0 * Math.PI * u2)

    out[1] = sqrt1MinusU1 * Math.cos(2.0 * Math.PI * u2)

    out[2] = sqrtU1 * Math.sin(2.0 * Math.PI * u3)

    out[3] = sqrtU1 * Math.cos(2.0 * Math.PI * u3)

    return out
  }
  /**
   * Calculates the inverse of a quat
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a quat to calculate inverse of
   * @returns {quat} out
   */

  function invert$4(out, a) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3]

    var dot = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3

    var invDot = dot ? 1.0 / dot : 0
    // TODO: Would be faster to return [0,0,0,0] immediately if dot == 0

    out[0] = -a0 * invDot

    out[1] = -a1 * invDot

    out[2] = -a2 * invDot

    out[3] = a3 * invDot

    return out
  }
  /**
   * Calculates the conjugate of a quat
   * If the quaternion is normalized, this function is faster than quat.inverse and produces the same result.
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a quat to calculate conjugate of
   * @returns {quat} out
   */

  function conjugate(out, a) {
    out[0] = -a[0]

    out[1] = -a[1]

    out[2] = -a[2]

    out[3] = a[3]

    return out
  }
  /**
   * Creates a quaternion from the given 3x3 rotation matrix.
   *
   * NOTE: The resultant quaternion is not normalized, so you should be sure
   * to renormalize the quaternion yourself where necessary.
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyMat3} m rotation matrix
   * @returns {quat} out
   * @function
   */

  function fromMat3(out, m) {
    // Algorithm in Ken Shoemake's article in 1987 SIGGRAPH course notes
    // article "Quaternion Calculus and Fast Animation".
    var fTrace = m[0] + m[4] + m[8]

    var fRoot

    if (fTrace > 0.0) {
      // |w| > 1/2, may as well choose w > 1/2
      fRoot = Math.sqrt(fTrace + 1.0)
      // 2w

      out[3] = 0.5 * fRoot

      fRoot = 0.5 / fRoot
      // 1/(4w)

      out[0] = (m[5] - m[7]) * fRoot

      out[1] = (m[6] - m[2]) * fRoot

      out[2] = (m[1] - m[3]) * fRoot
    } else {
      // |w| <= 1/2
      var i = 0

      if (m[4] > m[0]) i = 1

      if (m[8] > m[i * 3 + i]) i = 2

      var j = (i + 1) % 3

      var k = (i + 2) % 3

      fRoot = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1.0)

      out[i] = 0.5 * fRoot

      fRoot = 0.5 / fRoot

      out[3] = (m[j * 3 + k] - m[k * 3 + j]) * fRoot

      out[j] = (m[j * 3 + i] + m[i * 3 + j]) * fRoot

      out[k] = (m[k * 3 + i] + m[i * 3 + k]) * fRoot
    }

    return out
  }
  /**
   * Creates a quaternion from the given euler angle x, y, z using the provided intrinsic order for the conversion.
   *
   * @param {quat} out the receiving quaternion
   * @param {x} Angle to rotate around X axis in degrees.
   * @param {y} Angle to rotate around Y axis in degrees.
   * @param {z} Angle to rotate around Z axis in degrees.
   * @param {order} Intrinsic order for conversion, default is ZYX.
   * @returns {quat} out
   * @function
   */

  function fromEuler(out, x, y, z) {
    var order = arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : "zyx"

    var halfToRad = (0.5 * Math.PI) / 180.0

    x *= halfToRad

    z *= halfToRad

    y *= halfToRad

    var sx = Math.sin(x)

    var cx = Math.cos(x)

    var sy = Math.sin(y)

    var cy = Math.cos(y)

    var sz = Math.sin(z)

    var cz = Math.cos(z)

    if (typeof order != "string") {
      order = "zyx"
    }

    switch (order.toLowerCase()) {
      case "xyz":
        out[0] = sx * cy * cz + cx * sy * sz

        out[1] = cx * sy * cz - sx * cy * sz

        out[2] = cx * cy * sz + sx * sy * cz

        out[3] = cx * cy * cz - sx * sy * sz

        break

      case "xzy":
        out[0] = sx * cy * cz - cx * sy * sz

        out[1] = cx * sy * cz - sx * cy * sz

        out[2] = cx * cy * sz + sx * sy * cz

        out[3] = cx * cy * cz + sx * sy * sz

        break

      case "yxz":
        out[0] = sx * cy * cz + cx * sy * sz

        out[1] = cx * sy * cz - sx * cy * sz

        out[2] = cx * cy * sz - sx * sy * cz

        out[3] = cx * cy * cz + sx * sy * sz

        break

      case "yzx":
        out[0] = sx * cy * cz + cx * sy * sz

        out[1] = cx * sy * cz + sx * cy * sz

        out[2] = cx * cy * sz - sx * sy * cz

        out[3] = cx * cy * cz - sx * sy * sz

        break

      case "zxy":
        out[0] = sx * cy * cz - cx * sy * sz

        out[1] = cx * sy * cz + sx * cy * sz

        out[2] = cx * cy * sz + sx * sy * cz

        out[3] = cx * cy * cz - sx * sy * sz

        break

      case "zyx":
      default:
        out[0] = sx * cy * cz - cx * sy * sz

        out[1] = cx * sy * cz + sx * cy * sz

        out[2] = cx * cy * sz - sx * sy * cz

        out[3] = cx * cy * cz + sx * sy * sz
    }

    return out
  }
  /**
   * Returns a string representation of a quatenion
   *
   * @param {ReadonlyQuat} a vector to represent as a string
   * @returns {String} string representation of the vector
   */

  function str$6(a) {
    return "quat(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")"
  }
  /**
   * Creates a new quat initialized with values from an existing quaternion
   *
   * @param {ReadonlyQuat} a quaternion to clone
   * @returns {quat} a new quaternion
   * @function
   */

  var clone$6 = clone$5

  /**
   * Creates a new quat initialized with the given values
   *
   * @param {Number} x X component
   * @param {Number} y Y component
   * @param {Number} z Z component
   * @param {Number} w W component
   * @returns {quat} a new quaternion
   * @function
   */

  var fromValues$6 = fromValues$5

  /**
   * Copy the values from one quat to another
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a the source quaternion
   * @returns {quat} out
   * @function
   */

  var copy$6 = copy$5

  /**
   * Set the components of a quat to the given values
   *
   * @param {quat} out the receiving quaternion
   * @param {Number} x X component
   * @param {Number} y Y component
   * @param {Number} z Z component
   * @param {Number} w W component
   * @returns {quat} out
   * @function
   */

  var set$6 = set$5

  /**
   * Adds two quat's
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a the first operand
   * @param {ReadonlyQuat} b the second operand
   * @returns {quat} out
   * @function
   */

  var add$6 = add$5

  /**
   * Alias for {@link quat.multiply}
   * @function
   */

  var mul$6 = multiply$6

  /**
   * Scales a quat by a scalar number
   *
   * @param {quat} out the receiving vector
   * @param {ReadonlyQuat} a the vector to scale
   * @param {Number} b amount to scale the vector by
   * @returns {quat} out
   * @function
   */

  var scale$6 = scale$5

  /**
   * Calculates the dot product of two quat's
   *
   * @param {ReadonlyQuat} a the first operand
   * @param {ReadonlyQuat} b the second operand
   * @returns {Number} dot product of a and b
   * @function
   */

  var dot$2 = dot$1

  /**
   * Performs a linear interpolation between two quat's
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a the first operand
   * @param {ReadonlyQuat} b the second operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {quat} out
   * @function
   */

  var lerp$2 = lerp$1

  /**
   * Calculates the length of a quat
   *
   * @param {ReadonlyQuat} a vector to calculate length of
   * @returns {Number} length of a
   */

  var length$2 = length$1

  /**
   * Alias for {@link quat.length}
   * @function
   */

  var len$2 = length$2

  /**
   * Calculates the squared length of a quat
   *
   * @param {ReadonlyQuat} a vector to calculate squared length of
   * @returns {Number} squared length of a
   * @function
   */

  var squaredLength$2 = squaredLength$1

  /**
   * Alias for {@link quat.squaredLength}
   * @function
   */

  var sqrLen$2 = squaredLength$2

  /**
   * Normalize a quat
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a quaternion to normalize
   * @returns {quat} out
   * @function
   */

  var normalize$2 = normalize$1

  /**
   * Returns whether or not the quaternions have exactly the same elements in the same position (when compared with ===)
   *
   * @param {ReadonlyQuat} a The first quaternion.
   * @param {ReadonlyQuat} b The second quaternion.
   * @returns {Boolean} True if the vectors are equal, false otherwise.
   */

  var exactEquals$6 = exactEquals$5

  /**
   * Returns whether or not the quaternions have approximately the same elements in the same position.
   *
   * @param {ReadonlyQuat} a The first vector.
   * @param {ReadonlyQuat} b The second vector.
   * @returns {Boolean} True if the vectors are equal, false otherwise.
   */

  var equals$7 = equals$6

  /**
   * Sets a quaternion to represent the shortest rotation from one
   * vector to another.
   *
   * Both vectors are assumed to be unit length.
   *
   * @param {quat} out the receiving quaternion.
   * @param {ReadonlyVec3} a the initial vector
   * @param {ReadonlyVec3} b the destination vector
   * @returns {quat} out
   */

  var rotationTo = (function () {
    var tmpvec3 = create$4()

    var xUnitVec3 = fromValues$4(1, 0, 0)

    var yUnitVec3 = fromValues$4(0, 1, 0)

    return function (out, a, b) {
      var dot$1 = dot(a, b)

      if (dot$1 < -0.999999) {
        cross(tmpvec3, xUnitVec3, a)

        if (len(tmpvec3) < 0.000001) cross(tmpvec3, yUnitVec3, a)

        normalize(tmpvec3, tmpvec3)

        setAxisAngle(out, tmpvec3, Math.PI)

        return out
      } else if (dot$1 > 0.999999) {
        out[0] = 0

        out[1] = 0

        out[2] = 0

        out[3] = 1

        return out
      } else {
        cross(tmpvec3, a, b)

        out[0] = tmpvec3[0]

        out[1] = tmpvec3[1]

        out[2] = tmpvec3[2]

        out[3] = 1 + dot$1

        return normalize$2(out, out)
      }
    }
  })()

  /**
   * Performs a spherical linear interpolation with two control points
   *
   * @param {quat} out the receiving quaternion
   * @param {ReadonlyQuat} a the first operand
   * @param {ReadonlyQuat} b the second operand
   * @param {ReadonlyQuat} c the third operand
   * @param {ReadonlyQuat} d the fourth operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {quat} out
   */

  var sqlerp = (function () {
    var temp1 = create$6()

    var temp2 = create$6()

    return function (out, a, b, c, d, t) {
      slerp$1(temp1, a, d, t)

      slerp$1(temp2, b, c, t)

      slerp$1(out, temp1, temp2, 2 * t * (1 - t))

      return out
    }
  })()

  /**
   * Sets the specified quaternion with values corresponding to the given
   * axes. Each axis is a vec3 and is expected to be unit length and
   * perpendicular to all other specified axes.
   *
   * @param {ReadonlyVec3} view  the vector representing the viewing direction
   * @param {ReadonlyVec3} right the vector representing the local "right" direction
   * @param {ReadonlyVec3} up    the vector representing the local "up" direction
   * @returns {quat} out
   */

  var setAxes = (function () {
    var matr = create$2()

    return function (out, view, right, up) {
      matr[0] = right[0]

      matr[3] = right[1]

      matr[6] = right[2]

      matr[1] = up[0]

      matr[4] = up[1]

      matr[7] = up[2]

      matr[2] = -view[0]

      matr[5] = -view[1]

      matr[8] = -view[2]

      return normalize$2(out, fromMat3(out, matr))
    }
  })()

  var quat = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    create: create$6,
    identity: identity$4,
    setAxisAngle: setAxisAngle,
    getAxisAngle: getAxisAngle,
    getAngle: getAngle,
    multiply: multiply$6,
    rotateX: rotateX$2,
    rotateY: rotateY$2,
    rotateZ: rotateZ$2,
    calculateW: calculateW,
    exp: exp,
    ln: ln,
    pow: pow,
    slerp: slerp$1,
    random: random$2,
    invert: invert$4,
    conjugate: conjugate,
    fromMat3: fromMat3,
    fromEuler: fromEuler,
    str: str$6,
    clone: clone$6,
    fromValues: fromValues$6,
    copy: copy$6,
    set: set$6,
    add: add$6,
    mul: mul$6,
    scale: scale$6,
    dot: dot$2,
    lerp: lerp$2,
    length: length$2,
    len: len$2,
    squaredLength: squaredLength$2,
    sqrLen: sqrLen$2,
    normalize: normalize$2,
    exactEquals: exactEquals$6,
    equals: equals$7,
    rotationTo: rotationTo,
    sqlerp: sqlerp,
    setAxes: setAxes,
  })

  /**
   * Dual Quaternion<br>
   * Format: [real, dual]<br>
   * Quaternion format: XYZW<br>
   * Make sure to have normalized dual quaternions, otherwise the functions may not work as intended.<br>
   * @module quat2
   */

  /**
   * Creates a new identity dual quat
   *
   * @returns {quat2} a new dual quaternion [real -> rotation, dual -> translation]
   */

  function create$7() {
    var dq = new ARRAY_TYPE(8)

    if (ARRAY_TYPE != Float32Array) {
      dq[0] = 0

      dq[1] = 0

      dq[2] = 0

      dq[4] = 0

      dq[5] = 0

      dq[6] = 0

      dq[7] = 0
    }

    dq[3] = 1

    return dq
  }
  /**
   * Creates a new quat initialized with values from an existing quaternion
   *
   * @param {ReadonlyQuat2} a dual quaternion to clone
   * @returns {quat2} new dual quaternion
   * @function
   */

  function clone$7(a) {
    var dq = new ARRAY_TYPE(8)

    dq[0] = a[0]

    dq[1] = a[1]

    dq[2] = a[2]

    dq[3] = a[3]

    dq[4] = a[4]

    dq[5] = a[5]

    dq[6] = a[6]

    dq[7] = a[7]

    return dq
  }
  /**
   * Creates a new dual quat initialized with the given values
   *
   * @param {Number} x1 X component
   * @param {Number} y1 Y component
   * @param {Number} z1 Z component
   * @param {Number} w1 W component
   * @param {Number} x2 X component
   * @param {Number} y2 Y component
   * @param {Number} z2 Z component
   * @param {Number} w2 W component
   * @returns {quat2} new dual quaternion
   * @function
   */

  function fromValues$7(x1, y1, z1, w1, x2, y2, z2, w2) {
    var dq = new ARRAY_TYPE(8)

    dq[0] = x1

    dq[1] = y1

    dq[2] = z1

    dq[3] = w1

    dq[4] = x2

    dq[5] = y2

    dq[6] = z2

    dq[7] = w2

    return dq
  }
  /**
   * Creates a new dual quat from the given values (quat and translation)
   *
   * @param {Number} x1 X component
   * @param {Number} y1 Y component
   * @param {Number} z1 Z component
   * @param {Number} w1 W component
   * @param {Number} x2 X component (translation)
   * @param {Number} y2 Y component (translation)
   * @param {Number} z2 Z component (translation)
   * @returns {quat2} new dual quaternion
   * @function
   */

  function fromRotationTranslationValues(x1, y1, z1, w1, x2, y2, z2) {
    var dq = new ARRAY_TYPE(8)

    dq[0] = x1

    dq[1] = y1

    dq[2] = z1

    dq[3] = w1

    var ax = x2 * 0.5,
      ay = y2 * 0.5,
      az = z2 * 0.5

    dq[4] = ax * w1 + ay * z1 - az * y1

    dq[5] = ay * w1 + az * x1 - ax * z1

    dq[6] = az * w1 + ax * y1 - ay * x1

    dq[7] = -ax * x1 - ay * y1 - az * z1

    return dq
  }
  /**
   * Creates a dual quat from a quaternion and a translation
   *
   * @param {ReadonlyQuat2} dual quaternion receiving operation result
   * @param {ReadonlyQuat} q a normalized quaternion
   * @param {ReadonlyVec3} t tranlation vector
   * @returns {quat2} dual quaternion receiving operation result
   * @function
   */

  function fromRotationTranslation$1(out, q, t) {
    var ax = t[0] * 0.5,
      ay = t[1] * 0.5,
      az = t[2] * 0.5,
      bx = q[0],
      by = q[1],
      bz = q[2],
      bw = q[3]

    out[0] = bx

    out[1] = by

    out[2] = bz

    out[3] = bw

    out[4] = ax * bw + ay * bz - az * by

    out[5] = ay * bw + az * bx - ax * bz

    out[6] = az * bw + ax * by - ay * bx

    out[7] = -ax * bx - ay * by - az * bz

    return out
  }
  /**
   * Creates a dual quat from a translation
   *
   * @param {ReadonlyQuat2} dual quaternion receiving operation result
   * @param {ReadonlyVec3} t translation vector
   * @returns {quat2} dual quaternion receiving operation result
   * @function
   */

  function fromTranslation$3(out, t) {
    out[0] = 0

    out[1] = 0

    out[2] = 0

    out[3] = 1

    out[4] = t[0] * 0.5

    out[5] = t[1] * 0.5

    out[6] = t[2] * 0.5

    out[7] = 0

    return out
  }
  /**
   * Creates a dual quat from a quaternion
   *
   * @param {ReadonlyQuat2} dual quaternion receiving operation result
   * @param {ReadonlyQuat} q the quaternion
   * @returns {quat2} dual quaternion receiving operation result
   * @function
   */

  function fromRotation$4(out, q) {
    out[0] = q[0]

    out[1] = q[1]

    out[2] = q[2]

    out[3] = q[3]

    out[4] = 0

    out[5] = 0

    out[6] = 0

    out[7] = 0

    return out
  }
  /**
   * Creates a new dual quat from a matrix (4x4)
   *
   * @param {quat2} out the dual quaternion
   * @param {ReadonlyMat4} a the matrix
   * @returns {quat2} dual quat receiving operation result
   * @function
   */

  function fromMat4$1(out, a) {
    //TODO Optimize this
    var outer = create$6()

    getRotation(outer, a)

    var t = new ARRAY_TYPE(3)

    getTranslation(t, a)

    fromRotationTranslation$1(out, outer, t)

    return out
  }
  /**
   * Copy the values from one dual quat to another
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a the source dual quaternion
   * @returns {quat2} out
   * @function
   */

  function copy$7(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    out[2] = a[2]

    out[3] = a[3]

    out[4] = a[4]

    out[5] = a[5]

    out[6] = a[6]

    out[7] = a[7]

    return out
  }
  /**
   * Set a dual quat to the identity dual quaternion
   *
   * @param {quat2} out the receiving quaternion
   * @returns {quat2} out
   */

  function identity$5(out) {
    out[0] = 0

    out[1] = 0

    out[2] = 0

    out[3] = 1

    out[4] = 0

    out[5] = 0

    out[6] = 0

    out[7] = 0

    return out
  }
  /**
   * Set the components of a dual quat to the given values
   *
   * @param {quat2} out the receiving quaternion
   * @param {Number} x1 X component
   * @param {Number} y1 Y component
   * @param {Number} z1 Z component
   * @param {Number} w1 W component
   * @param {Number} x2 X component
   * @param {Number} y2 Y component
   * @param {Number} z2 Z component
   * @param {Number} w2 W component
   * @returns {quat2} out
   * @function
   */

  function set$7(out, x1, y1, z1, w1, x2, y2, z2, w2) {
    out[0] = x1

    out[1] = y1

    out[2] = z1

    out[3] = w1

    out[4] = x2

    out[5] = y2

    out[6] = z2

    out[7] = w2

    return out
  }
  /**
   * Gets the real part of a dual quat
   * @param  {quat} out real part
   * @param  {ReadonlyQuat2} a Dual Quaternion
   * @return {quat} real part
   */

  var getReal = copy$6

  /**
   * Gets the dual part of a dual quat
   * @param  {quat} out dual part
   * @param  {ReadonlyQuat2} a Dual Quaternion
   * @return {quat} dual part
   */

  function getDual(out, a) {
    out[0] = a[4]

    out[1] = a[5]

    out[2] = a[6]

    out[3] = a[7]

    return out
  }
  /**
   * Set the real component of a dual quat to the given quaternion
   *
   * @param {quat2} out the receiving quaternion
   * @param {ReadonlyQuat} q a quaternion representing the real part
   * @returns {quat2} out
   * @function
   */

  var setReal = copy$6

  /**
   * Set the dual component of a dual quat to the given quaternion
   *
   * @param {quat2} out the receiving quaternion
   * @param {ReadonlyQuat} q a quaternion representing the dual part
   * @returns {quat2} out
   * @function
   */

  function setDual(out, q) {
    out[4] = q[0]

    out[5] = q[1]

    out[6] = q[2]

    out[7] = q[3]

    return out
  }
  /**
   * Gets the translation of a normalized dual quat
   * @param  {vec3} out translation
   * @param  {ReadonlyQuat2} a Dual Quaternion to be decomposed
   * @return {vec3} translation
   */

  function getTranslation$1(out, a) {
    var ax = a[4],
      ay = a[5],
      az = a[6],
      aw = a[7],
      bx = -a[0],
      by = -a[1],
      bz = -a[2],
      bw = a[3]

    out[0] = (ax * bw + aw * bx + ay * bz - az * by) * 2

    out[1] = (ay * bw + aw * by + az * bx - ax * bz) * 2

    out[2] = (az * bw + aw * bz + ax * by - ay * bx) * 2

    return out
  }
  /**
   * Translates a dual quat by the given vector
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a the dual quaternion to translate
   * @param {ReadonlyVec3} v vector to translate by
   * @returns {quat2} out
   */

  function translate$3(out, a, v) {
    var ax1 = a[0],
      ay1 = a[1],
      az1 = a[2],
      aw1 = a[3],
      bx1 = v[0] * 0.5,
      by1 = v[1] * 0.5,
      bz1 = v[2] * 0.5,
      ax2 = a[4],
      ay2 = a[5],
      az2 = a[6],
      aw2 = a[7]

    out[0] = ax1

    out[1] = ay1

    out[2] = az1

    out[3] = aw1

    out[4] = aw1 * bx1 + ay1 * bz1 - az1 * by1 + ax2

    out[5] = aw1 * by1 + az1 * bx1 - ax1 * bz1 + ay2

    out[6] = aw1 * bz1 + ax1 * by1 - ay1 * bx1 + az2

    out[7] = -ax1 * bx1 - ay1 * by1 - az1 * bz1 + aw2

    return out
  }
  /**
   * Rotates a dual quat around the X axis
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a the dual quaternion to rotate
   * @param {number} rad how far should the rotation be
   * @returns {quat2} out
   */

  function rotateX$3(out, a, rad) {
    var bx = -a[0],
      by = -a[1],
      bz = -a[2],
      bw = a[3],
      ax = a[4],
      ay = a[5],
      az = a[6],
      aw = a[7],
      ax1 = ax * bw + aw * bx + ay * bz - az * by,
      ay1 = ay * bw + aw * by + az * bx - ax * bz,
      az1 = az * bw + aw * bz + ax * by - ay * bx,
      aw1 = aw * bw - ax * bx - ay * by - az * bz

    rotateX$2(out, a, rad)

    bx = out[0]

    by = out[1]

    bz = out[2]

    bw = out[3]

    out[4] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by

    out[5] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz

    out[6] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx

    out[7] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz

    return out
  }
  /**
   * Rotates a dual quat around the Y axis
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a the dual quaternion to rotate
   * @param {number} rad how far should the rotation be
   * @returns {quat2} out
   */

  function rotateY$3(out, a, rad) {
    var bx = -a[0],
      by = -a[1],
      bz = -a[2],
      bw = a[3],
      ax = a[4],
      ay = a[5],
      az = a[6],
      aw = a[7],
      ax1 = ax * bw + aw * bx + ay * bz - az * by,
      ay1 = ay * bw + aw * by + az * bx - ax * bz,
      az1 = az * bw + aw * bz + ax * by - ay * bx,
      aw1 = aw * bw - ax * bx - ay * by - az * bz

    rotateY$2(out, a, rad)

    bx = out[0]

    by = out[1]

    bz = out[2]

    bw = out[3]

    out[4] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by

    out[5] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz

    out[6] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx

    out[7] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz

    return out
  }
  /**
   * Rotates a dual quat around the Z axis
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a the dual quaternion to rotate
   * @param {number} rad how far should the rotation be
   * @returns {quat2} out
   */

  function rotateZ$3(out, a, rad) {
    var bx = -a[0],
      by = -a[1],
      bz = -a[2],
      bw = a[3],
      ax = a[4],
      ay = a[5],
      az = a[6],
      aw = a[7],
      ax1 = ax * bw + aw * bx + ay * bz - az * by,
      ay1 = ay * bw + aw * by + az * bx - ax * bz,
      az1 = az * bw + aw * bz + ax * by - ay * bx,
      aw1 = aw * bw - ax * bx - ay * by - az * bz

    rotateZ$2(out, a, rad)

    bx = out[0]

    by = out[1]

    bz = out[2]

    bw = out[3]

    out[4] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by

    out[5] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz

    out[6] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx

    out[7] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz

    return out
  }
  /**
   * Rotates a dual quat by a given quaternion (a * q)
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a the dual quaternion to rotate
   * @param {ReadonlyQuat} q quaternion to rotate by
   * @returns {quat2} out
   */

  function rotateByQuatAppend(out, a, q) {
    var qx = q[0],
      qy = q[1],
      qz = q[2],
      qw = q[3],
      ax = a[0],
      ay = a[1],
      az = a[2],
      aw = a[3]

    out[0] = ax * qw + aw * qx + ay * qz - az * qy

    out[1] = ay * qw + aw * qy + az * qx - ax * qz

    out[2] = az * qw + aw * qz + ax * qy - ay * qx

    out[3] = aw * qw - ax * qx - ay * qy - az * qz

    ax = a[4]

    ay = a[5]

    az = a[6]

    aw = a[7]

    out[4] = ax * qw + aw * qx + ay * qz - az * qy

    out[5] = ay * qw + aw * qy + az * qx - ax * qz

    out[6] = az * qw + aw * qz + ax * qy - ay * qx

    out[7] = aw * qw - ax * qx - ay * qy - az * qz

    return out
  }
  /**
   * Rotates a dual quat by a given quaternion (q * a)
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat} q quaternion to rotate by
   * @param {ReadonlyQuat2} a the dual quaternion to rotate
   * @returns {quat2} out
   */

  function rotateByQuatPrepend(out, q, a) {
    var qx = q[0],
      qy = q[1],
      qz = q[2],
      qw = q[3],
      bx = a[0],
      by = a[1],
      bz = a[2],
      bw = a[3]

    out[0] = qx * bw + qw * bx + qy * bz - qz * by

    out[1] = qy * bw + qw * by + qz * bx - qx * bz

    out[2] = qz * bw + qw * bz + qx * by - qy * bx

    out[3] = qw * bw - qx * bx - qy * by - qz * bz

    bx = a[4]

    by = a[5]

    bz = a[6]

    bw = a[7]

    out[4] = qx * bw + qw * bx + qy * bz - qz * by

    out[5] = qy * bw + qw * by + qz * bx - qx * bz

    out[6] = qz * bw + qw * bz + qx * by - qy * bx

    out[7] = qw * bw - qx * bx - qy * by - qz * bz

    return out
  }
  /**
   * Rotates a dual quat around a given axis. Does the normalisation automatically
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a the dual quaternion to rotate
   * @param {ReadonlyVec3} axis the axis to rotate around
   * @param {Number} rad how far the rotation should be
   * @returns {quat2} out
   */

  function rotateAroundAxis(out, a, axis, rad) {
    //Special case for rad = 0
    if (Math.abs(rad) < EPSILON) {
      return copy$7(out, a)
    }

    var axisLength = Math.hypot(axis[0], axis[1], axis[2])

    rad = rad * 0.5

    var s = Math.sin(rad)

    var bx = (s * axis[0]) / axisLength

    var by = (s * axis[1]) / axisLength

    var bz = (s * axis[2]) / axisLength

    var bw = Math.cos(rad)

    var ax1 = a[0],
      ay1 = a[1],
      az1 = a[2],
      aw1 = a[3]

    out[0] = ax1 * bw + aw1 * bx + ay1 * bz - az1 * by

    out[1] = ay1 * bw + aw1 * by + az1 * bx - ax1 * bz

    out[2] = az1 * bw + aw1 * bz + ax1 * by - ay1 * bx

    out[3] = aw1 * bw - ax1 * bx - ay1 * by - az1 * bz

    var ax = a[4],
      ay = a[5],
      az = a[6],
      aw = a[7]

    out[4] = ax * bw + aw * bx + ay * bz - az * by

    out[5] = ay * bw + aw * by + az * bx - ax * bz

    out[6] = az * bw + aw * bz + ax * by - ay * bx

    out[7] = aw * bw - ax * bx - ay * by - az * bz

    return out
  }
  /**
   * Adds two dual quat's
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a the first operand
   * @param {ReadonlyQuat2} b the second operand
   * @returns {quat2} out
   * @function
   */

  function add$7(out, a, b) {
    out[0] = a[0] + b[0]

    out[1] = a[1] + b[1]

    out[2] = a[2] + b[2]

    out[3] = a[3] + b[3]

    out[4] = a[4] + b[4]

    out[5] = a[5] + b[5]

    out[6] = a[6] + b[6]

    out[7] = a[7] + b[7]

    return out
  }
  /**
   * Multiplies two dual quat's
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a the first operand
   * @param {ReadonlyQuat2} b the second operand
   * @returns {quat2} out
   */

  function multiply$7(out, a, b) {
    var ax0 = a[0],
      ay0 = a[1],
      az0 = a[2],
      aw0 = a[3],
      bx1 = b[4],
      by1 = b[5],
      bz1 = b[6],
      bw1 = b[7],
      ax1 = a[4],
      ay1 = a[5],
      az1 = a[6],
      aw1 = a[7],
      bx0 = b[0],
      by0 = b[1],
      bz0 = b[2],
      bw0 = b[3]

    out[0] = ax0 * bw0 + aw0 * bx0 + ay0 * bz0 - az0 * by0

    out[1] = ay0 * bw0 + aw0 * by0 + az0 * bx0 - ax0 * bz0

    out[2] = az0 * bw0 + aw0 * bz0 + ax0 * by0 - ay0 * bx0

    out[3] = aw0 * bw0 - ax0 * bx0 - ay0 * by0 - az0 * bz0

    out[4] = ax0 * bw1 + aw0 * bx1 + ay0 * bz1 - az0 * by1 + ax1 * bw0 + aw1 * bx0 + ay1 * bz0 - az1 * by0

    out[5] = ay0 * bw1 + aw0 * by1 + az0 * bx1 - ax0 * bz1 + ay1 * bw0 + aw1 * by0 + az1 * bx0 - ax1 * bz0

    out[6] = az0 * bw1 + aw0 * bz1 + ax0 * by1 - ay0 * bx1 + az1 * bw0 + aw1 * bz0 + ax1 * by0 - ay1 * bx0

    out[7] = aw0 * bw1 - ax0 * bx1 - ay0 * by1 - az0 * bz1 + aw1 * bw0 - ax1 * bx0 - ay1 * by0 - az1 * bz0

    return out
  }
  /**
   * Alias for {@link quat2.multiply}
   * @function
   */

  var mul$7 = multiply$7

  /**
   * Scales a dual quat by a scalar number
   *
   * @param {quat2} out the receiving dual quat
   * @param {ReadonlyQuat2} a the dual quat to scale
   * @param {Number} b amount to scale the dual quat by
   * @returns {quat2} out
   * @function
   */

  function scale$7(out, a, b) {
    out[0] = a[0] * b

    out[1] = a[1] * b

    out[2] = a[2] * b

    out[3] = a[3] * b

    out[4] = a[4] * b

    out[5] = a[5] * b

    out[6] = a[6] * b

    out[7] = a[7] * b

    return out
  }
  /**
   * Calculates the dot product of two dual quat's (The dot product of the real parts)
   *
   * @param {ReadonlyQuat2} a the first operand
   * @param {ReadonlyQuat2} b the second operand
   * @returns {Number} dot product of a and b
   * @function
   */

  var dot$3 = dot$2

  /**
   * Performs a linear interpolation between two dual quats's
   * NOTE: The resulting dual quaternions won't always be normalized (The error is most noticeable when t = 0.5)
   *
   * @param {quat2} out the receiving dual quat
   * @param {ReadonlyQuat2} a the first operand
   * @param {ReadonlyQuat2} b the second operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {quat2} out
   */

  function lerp$3(out, a, b, t) {
    var mt = 1 - t

    if (dot$3(a, b) < 0) t = -t

    out[0] = a[0] * mt + b[0] * t

    out[1] = a[1] * mt + b[1] * t

    out[2] = a[2] * mt + b[2] * t

    out[3] = a[3] * mt + b[3] * t

    out[4] = a[4] * mt + b[4] * t

    out[5] = a[5] * mt + b[5] * t

    out[6] = a[6] * mt + b[6] * t

    out[7] = a[7] * mt + b[7] * t

    return out
  }
  /**
   * Calculates the inverse of a dual quat. If they are normalized, conjugate is cheaper
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a dual quat to calculate inverse of
   * @returns {quat2} out
   */

  function invert$5(out, a) {
    var sqlen = squaredLength$3(a)

    out[0] = -a[0] / sqlen

    out[1] = -a[1] / sqlen

    out[2] = -a[2] / sqlen

    out[3] = a[3] / sqlen

    out[4] = -a[4] / sqlen

    out[5] = -a[5] / sqlen

    out[6] = -a[6] / sqlen

    out[7] = a[7] / sqlen

    return out
  }
  /**
   * Calculates the conjugate of a dual quat
   * If the dual quaternion is normalized, this function is faster than quat2.inverse and produces the same result.
   *
   * @param {quat2} out the receiving quaternion
   * @param {ReadonlyQuat2} a quat to calculate conjugate of
   * @returns {quat2} out
   */

  function conjugate$1(out, a) {
    out[0] = -a[0]

    out[1] = -a[1]

    out[2] = -a[2]

    out[3] = a[3]

    out[4] = -a[4]

    out[5] = -a[5]

    out[6] = -a[6]

    out[7] = a[7]

    return out
  }
  /**
   * Calculates the length of a dual quat
   *
   * @param {ReadonlyQuat2} a dual quat to calculate length of
   * @returns {Number} length of a
   * @function
   */

  var length$3 = length$2

  /**
   * Alias for {@link quat2.length}
   * @function
   */

  var len$3 = length$3

  /**
   * Calculates the squared length of a dual quat
   *
   * @param {ReadonlyQuat2} a dual quat to calculate squared length of
   * @returns {Number} squared length of a
   * @function
   */

  var squaredLength$3 = squaredLength$2

  /**
   * Alias for {@link quat2.squaredLength}
   * @function
   */

  var sqrLen$3 = squaredLength$3

  /**
   * Normalize a dual quat
   *
   * @param {quat2} out the receiving dual quaternion
   * @param {ReadonlyQuat2} a dual quaternion to normalize
   * @returns {quat2} out
   * @function
   */

  function normalize$3(out, a) {
    var magnitude = squaredLength$3(a)

    if (magnitude > 0) {
      magnitude = Math.sqrt(magnitude)

      var a0 = a[0] / magnitude

      var a1 = a[1] / magnitude

      var a2 = a[2] / magnitude

      var a3 = a[3] / magnitude

      var b0 = a[4]

      var b1 = a[5]

      var b2 = a[6]

      var b3 = a[7]

      var a_dot_b = a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3

      out[0] = a0

      out[1] = a1

      out[2] = a2

      out[3] = a3

      out[4] = (b0 - a0 * a_dot_b) / magnitude

      out[5] = (b1 - a1 * a_dot_b) / magnitude

      out[6] = (b2 - a2 * a_dot_b) / magnitude

      out[7] = (b3 - a3 * a_dot_b) / magnitude
    }

    return out
  }
  /**
   * Returns a string representation of a dual quatenion
   *
   * @param {ReadonlyQuat2} a dual quaternion to represent as a string
   * @returns {String} string representation of the dual quat
   */

  function str$7(a) {
    return (
      "quat2(" +
      a[0] +
      ", " +
      a[1] +
      ", " +
      a[2] +
      ", " +
      a[3] +
      ", " +
      a[4] +
      ", " +
      a[5] +
      ", " +
      a[6] +
      ", " +
      a[7] +
      ")"
    )
  }
  /**
   * Returns whether or not the dual quaternions have exactly the same elements in the same position (when compared with ===)
   *
   * @param {ReadonlyQuat2} a the first dual quaternion.
   * @param {ReadonlyQuat2} b the second dual quaternion.
   * @returns {Boolean} true if the dual quaternions are equal, false otherwise.
   */

  function exactEquals$7(a, b) {
    return (
      a[0] === b[0] &&
      a[1] === b[1] &&
      a[2] === b[2] &&
      a[3] === b[3] &&
      a[4] === b[4] &&
      a[5] === b[5] &&
      a[6] === b[6] &&
      a[7] === b[7]
    )
  }
  /**
   * Returns whether or not the dual quaternions have approximately the same elements in the same position.
   *
   * @param {ReadonlyQuat2} a the first dual quat.
   * @param {ReadonlyQuat2} b the second dual quat.
   * @returns {Boolean} true if the dual quats are equal, false otherwise.
   */

  function equals$8(a, b) {
    var a0 = a[0],
      a1 = a[1],
      a2 = a[2],
      a3 = a[3],
      a4 = a[4],
      a5 = a[5],
      a6 = a[6],
      a7 = a[7]

    var b0 = b[0],
      b1 = b[1],
      b2 = b[2],
      b3 = b[3],
      b4 = b[4],
      b5 = b[5],
      b6 = b[6],
      b7 = b[7]

    return (
      Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
      Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
      Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
      Math.abs(a3 - b3) <= EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3)) &&
      Math.abs(a4 - b4) <= EPSILON * Math.max(1.0, Math.abs(a4), Math.abs(b4)) &&
      Math.abs(a5 - b5) <= EPSILON * Math.max(1.0, Math.abs(a5), Math.abs(b5)) &&
      Math.abs(a6 - b6) <= EPSILON * Math.max(1.0, Math.abs(a6), Math.abs(b6)) &&
      Math.abs(a7 - b7) <= EPSILON * Math.max(1.0, Math.abs(a7), Math.abs(b7))
    )
  }

  var quat2 = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    create: create$7,
    clone: clone$7,
    fromValues: fromValues$7,
    fromRotationTranslationValues: fromRotationTranslationValues,
    fromRotationTranslation: fromRotationTranslation$1,
    fromTranslation: fromTranslation$3,
    fromRotation: fromRotation$4,
    fromMat4: fromMat4$1,
    copy: copy$7,
    identity: identity$5,
    set: set$7,
    getReal: getReal,
    getDual: getDual,
    setReal: setReal,
    setDual: setDual,
    getTranslation: getTranslation$1,
    translate: translate$3,
    rotateX: rotateX$3,
    rotateY: rotateY$3,
    rotateZ: rotateZ$3,
    rotateByQuatAppend: rotateByQuatAppend,
    rotateByQuatPrepend: rotateByQuatPrepend,
    rotateAroundAxis: rotateAroundAxis,
    add: add$7,
    multiply: multiply$7,
    mul: mul$7,
    scale: scale$7,
    dot: dot$3,
    lerp: lerp$3,
    invert: invert$5,
    conjugate: conjugate$1,
    length: length$3,
    len: len$3,
    squaredLength: squaredLength$3,
    sqrLen: sqrLen$3,
    normalize: normalize$3,
    str: str$7,
    exactEquals: exactEquals$7,
    equals: equals$8,
  })

  /**
   * 2 Dimensional Vector
   * @module vec2
   */

  /**
   * Creates a new, empty vec2
   *
   * @returns {vec2} a new 2D vector
   */

  function create$8() {
    var out = new ARRAY_TYPE(2)

    if (ARRAY_TYPE != Float32Array) {
      out[0] = 0

      out[1] = 0
    }

    return out
  }
  /**
   * Creates a new vec2 initialized with values from an existing vector
   *
   * @param {ReadonlyVec2} a vector to clone
   * @returns {vec2} a new 2D vector
   */

  function clone$8(a) {
    var out = new ARRAY_TYPE(2)

    out[0] = a[0]

    out[1] = a[1]

    return out
  }
  /**
   * Creates a new vec2 initialized with the given values
   *
   * @param {Number} x X component
   * @param {Number} y Y component
   * @returns {vec2} a new 2D vector
   */

  function fromValues$8(x, y) {
    var out = new ARRAY_TYPE(2)

    out[0] = x

    out[1] = y

    return out
  }
  /**
   * Copy the values from one vec2 to another
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the source vector
   * @returns {vec2} out
   */

  function copy$8(out, a) {
    out[0] = a[0]

    out[1] = a[1]

    return out
  }
  /**
   * Set the components of a vec2 to the given values
   *
   * @param {vec2} out the receiving vector
   * @param {Number} x X component
   * @param {Number} y Y component
   * @returns {vec2} out
   */

  function set$8(out, x, y) {
    out[0] = x

    out[1] = y

    return out
  }
  /**
   * Adds two vec2's
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {vec2} out
   */

  function add$8(out, a, b) {
    out[0] = a[0] + b[0]

    out[1] = a[1] + b[1]

    return out
  }
  /**
   * Subtracts vector b from vector a
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {vec2} out
   */

  function subtract$6(out, a, b) {
    out[0] = a[0] - b[0]

    out[1] = a[1] - b[1]

    return out
  }
  /**
   * Multiplies two vec2's
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {vec2} out
   */

  function multiply$8(out, a, b) {
    out[0] = a[0] * b[0]

    out[1] = a[1] * b[1]

    return out
  }
  /**
   * Divides two vec2's
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {vec2} out
   */

  function divide$2(out, a, b) {
    out[0] = a[0] / b[0]

    out[1] = a[1] / b[1]

    return out
  }
  /**
   * Math.ceil the components of a vec2
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a vector to ceil
   * @returns {vec2} out
   */

  function ceil$2(out, a) {
    out[0] = Math.ceil(a[0])

    out[1] = Math.ceil(a[1])

    return out
  }
  /**
   * Math.floor the components of a vec2
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a vector to floor
   * @returns {vec2} out
   */

  function floor$2(out, a) {
    out[0] = Math.floor(a[0])

    out[1] = Math.floor(a[1])

    return out
  }
  /**
   * Returns the minimum of two vec2's
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {vec2} out
   */

  function min$2(out, a, b) {
    out[0] = Math.min(a[0], b[0])

    out[1] = Math.min(a[1], b[1])

    return out
  }
  /**
   * Returns the maximum of two vec2's
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {vec2} out
   */

  function max$2(out, a, b) {
    out[0] = Math.max(a[0], b[0])

    out[1] = Math.max(a[1], b[1])

    return out
  }
  /**
   * Math.round the components of a vec2
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a vector to round
   * @returns {vec2} out
   */

  function round$2(out, a) {
    out[0] = Math.round(a[0])

    out[1] = Math.round(a[1])

    return out
  }
  /**
   * Scales a vec2 by a scalar number
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the vector to scale
   * @param {Number} b amount to scale the vector by
   * @returns {vec2} out
   */

  function scale$8(out, a, b) {
    out[0] = a[0] * b

    out[1] = a[1] * b

    return out
  }
  /**
   * Adds two vec2's after scaling the second operand by a scalar value
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @param {Number} scale the amount to scale b by before adding
   * @returns {vec2} out
   */

  function scaleAndAdd$2(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale

    out[1] = a[1] + b[1] * scale

    return out
  }
  /**
   * Calculates the euclidian distance between two vec2's
   *
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {Number} distance between a and b
   */

  function distance$2(a, b) {
    var x = b[0] - a[0],
      y = b[1] - a[1]

    return Math.hypot(x, y)
  }
  /**
   * Calculates the squared euclidian distance between two vec2's
   *
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {Number} squared distance between a and b
   */

  function squaredDistance$2(a, b) {
    var x = b[0] - a[0],
      y = b[1] - a[1]

    return x * x + y * y
  }
  /**
   * Calculates the length of a vec2
   *
   * @param {ReadonlyVec2} a vector to calculate length of
   * @returns {Number} length of a
   */

  function length$4(a) {
    var x = a[0],
      y = a[1]

    return Math.hypot(x, y)
  }
  /**
   * Calculates the squared length of a vec2
   *
   * @param {ReadonlyVec2} a vector to calculate squared length of
   * @returns {Number} squared length of a
   */

  function squaredLength$4(a) {
    var x = a[0],
      y = a[1]

    return x * x + y * y
  }
  /**
   * Negates the components of a vec2
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a vector to negate
   * @returns {vec2} out
   */

  function negate$2(out, a) {
    out[0] = -a[0]

    out[1] = -a[1]

    return out
  }
  /**
   * Returns the inverse of the components of a vec2
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a vector to invert
   * @returns {vec2} out
   */

  function inverse$2(out, a) {
    out[0] = 1.0 / a[0]

    out[1] = 1.0 / a[1]

    return out
  }
  /**
   * Normalize a vec2
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a vector to normalize
   * @returns {vec2} out
   */

  function normalize$4(out, a) {
    var x = a[0],
      y = a[1]

    var len = x * x + y * y

    if (len > 0) {
      //TODO: evaluate use of glm_invsqrt here?
      len = 1 / Math.sqrt(len)
    }

    out[0] = a[0] * len

    out[1] = a[1] * len

    return out
  }
  /**
   * Calculates the dot product of two vec2's
   *
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {Number} dot product of a and b
   */

  function dot$4(a, b) {
    return a[0] * b[0] + a[1] * b[1]
  }
  /**
   * Computes the cross product of two vec2's
   * Note that the cross product must by definition produce a 3D vector
   *
   * @param {vec3} out the receiving vector
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @returns {vec3} out
   */

  function cross$2(out, a, b) {
    var z = a[0] * b[1] - a[1] * b[0]

    out[0] = out[1] = 0

    out[2] = z

    return out
  }
  /**
   * Performs a linear interpolation between two vec2's
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the first operand
   * @param {ReadonlyVec2} b the second operand
   * @param {Number} t interpolation amount, in the range [0-1], between the two inputs
   * @returns {vec2} out
   */

  function lerp$4(out, a, b, t) {
    var ax = a[0],
      ay = a[1]

    out[0] = ax + t * (b[0] - ax)

    out[1] = ay + t * (b[1] - ay)

    return out
  }
  /**
   * Generates a random vector with the given scale
   *
   * @param {vec2} out the receiving vector
   * @param {Number} [scale] Length of the resulting vector. If ommitted, a unit vector will be returned
   * @returns {vec2} out
   */

  function random$3(out, scale) {
    scale = scale || 1.0

    var r = RANDOM() * 2.0 * Math.PI

    out[0] = Math.cos(r) * scale

    out[1] = Math.sin(r) * scale

    return out
  }
  /**
   * Transforms the vec2 with a mat2
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the vector to transform
   * @param {ReadonlyMat2} m matrix to transform with
   * @returns {vec2} out
   */

  function transformMat2(out, a, m) {
    var x = a[0],
      y = a[1]

    out[0] = m[0] * x + m[2] * y

    out[1] = m[1] * x + m[3] * y

    return out
  }
  /**
   * Transforms the vec2 with a mat2d
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the vector to transform
   * @param {ReadonlyMat2d} m matrix to transform with
   * @returns {vec2} out
   */

  function transformMat2d(out, a, m) {
    var x = a[0],
      y = a[1]

    out[0] = m[0] * x + m[2] * y + m[4]

    out[1] = m[1] * x + m[3] * y + m[5]

    return out
  }
  /**
   * Transforms the vec2 with a mat3
   * 3rd vector component is implicitly '1'
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the vector to transform
   * @param {ReadonlyMat3} m matrix to transform with
   * @returns {vec2} out
   */

  function transformMat3$1(out, a, m) {
    var x = a[0],
      y = a[1]

    out[0] = m[0] * x + m[3] * y + m[6]

    out[1] = m[1] * x + m[4] * y + m[7]

    return out
  }
  /**
   * Transforms the vec2 with a mat4
   * 3rd vector component is implicitly '0'
   * 4th vector component is implicitly '1'
   *
   * @param {vec2} out the receiving vector
   * @param {ReadonlyVec2} a the vector to transform
   * @param {ReadonlyMat4} m matrix to transform with
   * @returns {vec2} out
   */

  function transformMat4$2(out, a, m) {
    var x = a[0]

    var y = a[1]

    out[0] = m[0] * x + m[4] * y + m[12]

    out[1] = m[1] * x + m[5] * y + m[13]

    return out
  }
  /**
   * Rotate a 2D vector
   * @param {vec2} out The receiving vec2
   * @param {ReadonlyVec2} a The vec2 point to rotate
   * @param {ReadonlyVec2} b The origin of the rotation
   * @param {Number} rad The angle of rotation in radians
   * @returns {vec2} out
   */

  function rotate$4(out, a, b, rad) {
    //Translate point to the origin
    var p0 = a[0] - b[0],
      p1 = a[1] - b[1],
      sinC = Math.sin(rad),
      cosC = Math.cos(rad)
    //perform rotation and translate to correct position

    out[0] = p0 * cosC - p1 * sinC + b[0]

    out[1] = p0 * sinC + p1 * cosC + b[1]

    return out
  }
  /**
   * Get the angle between two 2D vectors
   * @param {ReadonlyVec2} a The first operand
   * @param {ReadonlyVec2} b The second operand
   * @returns {Number} The angle in radians
   */

  function angle$1(a, b) {
    var x1 = a[0],
      y1 = a[1],
      x2 = b[0],
      y2 = b[1],
      // mag is the product of the magnitudes of a and b
      mag = Math.sqrt(x1 * x1 + y1 * y1) * Math.sqrt(x2 * x2 + y2 * y2),
      // mag &&.. short circuits if mag == 0
      cosine = mag && (x1 * x2 + y1 * y2) / mag
    // Math.min(Math.max(cosine, -1), 1) clamps the cosine between -1 and 1

    return Math.acos(Math.min(Math.max(cosine, -1), 1))
  }
  /**
   * Set the components of a vec2 to zero
   *
   * @param {vec2} out the receiving vector
   * @returns {vec2} out
   */

  function zero$2(out) {
    out[0] = 0.0

    out[1] = 0.0

    return out
  }
  /**
   * Returns a string representation of a vector
   *
   * @param {ReadonlyVec2} a vector to represent as a string
   * @returns {String} string representation of the vector
   */

  function str$8(a) {
    return "vec2(" + a[0] + ", " + a[1] + ")"
  }
  /**
   * Returns whether or not the vectors exactly have the same elements in the same position (when compared with ===)
   *
   * @param {ReadonlyVec2} a The first vector.
   * @param {ReadonlyVec2} b The second vector.
   * @returns {Boolean} True if the vectors are equal, false otherwise.
   */

  function exactEquals$8(a, b) {
    return a[0] === b[0] && a[1] === b[1]
  }
  /**
   * Returns whether or not the vectors have approximately the same elements in the same position.
   *
   * @param {ReadonlyVec2} a The first vector.
   * @param {ReadonlyVec2} b The second vector.
   * @returns {Boolean} True if the vectors are equal, false otherwise.
   */

  function equals$9(a, b) {
    var a0 = a[0],
      a1 = a[1]

    var b0 = b[0],
      b1 = b[1]

    return (
      Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
      Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1))
    )
  }
  /**
   * Alias for {@link vec2.length}
   * @function
   */

  var len$4 = length$4

  /**
   * Alias for {@link vec2.subtract}
   * @function
   */

  var sub$6 = subtract$6

  /**
   * Alias for {@link vec2.multiply}
   * @function
   */

  var mul$8 = multiply$8

  /**
   * Alias for {@link vec2.divide}
   * @function
   */

  var div$2 = divide$2

  /**
   * Alias for {@link vec2.distance}
   * @function
   */

  var dist$2 = distance$2

  /**
   * Alias for {@link vec2.squaredDistance}
   * @function
   */

  var sqrDist$2 = squaredDistance$2

  /**
   * Alias for {@link vec2.squaredLength}
   * @function
   */

  var sqrLen$4 = squaredLength$4

  /**
   * Perform some operation over an array of vec2s.
   *
   * @param {Array} a the array of vectors to iterate over
   * @param {Number} stride Number of elements between the start of each vec2. If 0 assumes tightly packed
   * @param {Number} offset Number of elements to skip at the beginning of the array
   * @param {Number} count Number of vec2s to iterate over. If 0 iterates over entire array
   * @param {Function} fn Function to call for each vector in the array
   * @param {Object} [arg] additional argument to pass to fn
   * @returns {Array} a
   * @function
   */

  var forEach$2 = (function () {
    var vec = create$8()

    return function (a, stride, offset, count, fn, arg) {
      var i, l

      if (!stride) {
        stride = 2
      }

      if (!offset) {
        offset = 0
      }

      if (count) {
        l = Math.min(count * stride + offset, a.length)
      } else {
        l = a.length
      }

      for (i = offset; i < l; i += stride) {
        vec[0] = a[i]

        vec[1] = a[i + 1]

        fn(vec, vec, arg)

        a[i] = vec[0]

        a[i + 1] = vec[1]
      }

      return a
    }
  })()

  var vec2 = /*#__PURE__*/ Object.freeze({
    __proto__: null,
    create: create$8,
    clone: clone$8,
    fromValues: fromValues$8,
    copy: copy$8,
    set: set$8,
    add: add$8,
    subtract: subtract$6,
    multiply: multiply$8,
    divide: divide$2,
    ceil: ceil$2,
    floor: floor$2,
    min: min$2,
    max: max$2,
    round: round$2,
    scale: scale$8,
    scaleAndAdd: scaleAndAdd$2,
    distance: distance$2,
    squaredDistance: squaredDistance$2,
    length: length$4,
    squaredLength: squaredLength$4,
    negate: negate$2,
    inverse: inverse$2,
    normalize: normalize$4,
    dot: dot$4,
    cross: cross$2,
    lerp: lerp$4,
    random: random$3,
    transformMat2: transformMat2,
    transformMat2d: transformMat2d,
    transformMat3: transformMat3$1,
    transformMat4: transformMat4$2,
    rotate: rotate$4,
    angle: angle$1,
    zero: zero$2,
    str: str$8,
    exactEquals: exactEquals$8,
    equals: equals$9,
    len: len$4,
    sub: sub$6,
    mul: mul$8,
    div: div$2,
    dist: dist$2,
    sqrDist: sqrDist$2,
    sqrLen: sqrLen$4,
    forEach: forEach$2,
  })

  exports.glMatrix = common

  exports.mat2 = mat2

  exports.mat2d = mat2d

  exports.mat3 = mat3

  exports.mat4 = mat4

  exports.quat = quat

  exports.quat2 = quat2

  exports.vec2 = vec2

  exports.vec3 = vec3

  exports.vec4 = vec4

  Object.defineProperty(exports, "__esModule", { value: true })
})
glMatrix.glMatrix.setMatrixArrayType(Array)

// @ts-ignore
const mat4 = glMatrix.mat4
// @ts-ignore
const vec3 = glMatrix.vec3
// @ts-ignore
const vec4 = glMatrix.vec4
// @ts-ignore
const quat = glMatrix.quat
const modelScaleRotate = mat4.create()
const rotate = quat.create()
let rotationQuat = quat.create()
let parentMatrix = mat4.create()
let dummyMat4Out = mat4.create()
const vout = vec3.create()
