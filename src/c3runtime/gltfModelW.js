// @ts-check
"use strict"
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
// Keyframe sampler shared with the worker (verbatim copy in gltfWorker.js;
// KEEP IN SYNC). Index-based: targets are node indices and transforms go into
// a flat per-instance Float32Array, so every instance shares one animation list.
const AnimSampler = (() => {
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

  return { TRS_STRIDE, PATH_NONE, pathCode, prepareAnimation, initTRS, createSamplerState, sampleAnimation, animationTimeRange }
})()

/**
 * Attribute data is immutable and shared between instances, so a conversion
 * must be memoised on the source array: ObjectBuffer.acquire keys its share
 * cache on array IDENTITY, and minting a fresh copy per instance makes every
 * instance miss the cache and allocate its own GL buffers. Indices are the
 * common case, since glTF often stores them as something other than Uint16.
 */
const convertedAttributeCache = new WeakMap()
function sharedOrCopy(data, Type) {
  if (data instanceof Type) return data
  let converted = convertedAttributeCache.get(data)
  if (!converted) {
    converted = new Type(data)
    convertedAttributeCache.set(data, converted)
  }
  return converted
}

const WHITE4 = [1, 1, 1, 1]

// A host drawing several models in a shadow pass (renderer._m3dShadowPass)
// calls this after the run: the cleanup each model left owed, once, before
// Construct draws again (its attribute pointers and the Bones binding).
globalThis.Mikal3DObjectEndShadowRun = function (renderer) {
  const model = renderer._m3dShadowCleanup
  if (!model) return
  renderer._m3dShadowCleanup = null
  model._glCall(renderer, endShadowRunJob)
}
function endShadowRunJob(renderer) {
  this._restoreC3Attribs(renderer)
  if (globalThis.BoneBuffer && typeof this._bindDummyBonesUbo === "function") this._bindDummyBonesUbo(renderer)
}

// @ts-ignore
const BoneBufferW = globalThis.BoneBuffer
// @ts-ignore
const ObjectBufferW = globalThis.ObjectBuffer

// One animation worker shared by all instances of an object type (used when GPU
// skinning is known at creation time). Owns the message port and dispatches worker
// replies to the registered GltfModelW instances by instance id.
// Request slot layout, shared with the worker (see files/gltfWorker.js).
const REQ_STRIDE = 8
// Nodes per instance whose pose as drawn comes back with each batch (setDrawnNodes), 12 floats each
const RB_MAX = 6

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

// ---- Bone rotation offsets (script API setBoneRotationOffset). KEEP IN SYNC: gltfWorker.js / gltfModelW.js ----
// (the worker has TRS_STRIDE at top level; here it lives inside the AnimSampler closure)
const TRS_STRIDE = AnimSampler.TRS_STRIDE
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

/**
 * One animation worker shared by all instances of an object type. Owns the
 * message port and, since the batched protocol, the per-frame request:
 * instances queue their update during the tick and one message goes out per
 * frame carrying all of them; one reply comes back carrying every pose.
 *
 * Flushing happens in a microtask, i.e. as soon as the synchronous tick that
 * queued the first request finishes. At most one batch is in flight; requests
 * queued while it is are merged (latest per instance wins) and sent the moment
 * the reply lands, so the worker never idles and latency stays at one frame.
 */
class GltfWorkerHostTop {
  constructor() {
    this.msgPort = null
    this.instances = new Map()
    this.portPromise = null
    this.gltfSent = false
    this.attributesSent = false
    this.released = false
    this.poseFloats = 0
    this.pending = new Map() // model -> request
    this.slots = [] // models in the in-flight batch, by slot
    this.slotRB = [] // their drawn node lists (setDrawnNodes), by slot
    this.inFlight = false
    this.flushScheduled = false
    this.reqBuf = null
    this.outBuf = null
  }

  async getPort(runtime) {
    if (!this.portPromise) {
      this.portPromise = (async () => {
        const path = await runtime.GetAssetManager().GetProjectFileUrl("gltfWorker.js")
        if (this.released) return null
        const port = await runtime._iRuntime.createWorker(path)
        if (this.released) {
          port.postMessage({ type: "release" })
          port.close()
          return null
        }
        this.msgPort = port
        port.onmessage = (e) => {
          if (!e.data) return
          if (e.data.type === "batchResult") {
            this._onBatchResult(e.data)
            return
          }
          const model = this.instances.get(e.data.iid)
          if (model) model.onWorkerMessage(e)
        }
        port.onmessageerror = (e) => console.error("[3DObject] worker message error", e)
        return port
      })().catch((err) => {
        // Allow a later instance to retry instead of poisoning the type forever
        console.error("[3DObject] animation worker creation failed", err)
        this.portPromise = null
        return null
      })
    }
    return this.portPromise
  }

  add(iid, model) {
    this.instances.set(iid, model)
  }

  remove(iid) {
    const model = this.instances.get(iid)
    if (model) this.pending.delete(model)
    this.instances.delete(iid)
    if (this.msgPort) this.msgPort.postMessage({ type: "removeInstance", iid })
  }

  /** Queue this frame's request for `model`; a later queue in the same frame replaces it. */
  queue(model, animIndex, time, deltaTime, blend, loop) {
    let r = this.pending.get(model)
    if (!r) {
      r = { animIndex: 0, time: 0, deltaTime: 0, blend: 0, loop: 1 }
      this.pending.set(model, r)
    } else if (r.animIndex >= 0 && animIndex < 0) {
      // A pose-only request must not cancel a sampling request queued earlier.
      return
    }
    r.animIndex = animIndex
    r.time = time
    r.deltaTime = deltaTime
    r.blend = blend
    r.loop = loop
    // The bone offsets and blend weights that go with this frame's clip and time. The batch only goes out at the
    // end of the tick, after the events: reading them then paired the old clip with weights the events had just
    // set for the next one, and that pose became the next crossfade's starting pose (the new clip showed at once).
    // (The getters return a new array whenever the values change, so keeping the reference is a snapshot.)
    r.offs = model.boneOffsetFloats()
    r.mix = model.blendMixFloats()
    r.rb = model.drawnNodeIdx()
    if (!this.inFlight && !this.flushScheduled) {
      this.flushScheduled = true
      queueMicrotask(() => {
        this.flushScheduled = false
        this.flush()
      })
    }
  }

  flush() {
    if (this.inFlight || this.released || !this.msgPort || this.pending.size === 0 || !this.poseFloats) return
    const count = this.pending.size
    const floats = count * REQ_STRIDE
    if (!this.reqBuf || this.reqBuf.byteLength < floats * 8) {
      this.reqBuf = new ArrayBuffer(Math.max(floats, 64 * REQ_STRIDE) * 8)
    }
    const req = new Float64Array(this.reqBuf, 0, floats)
    const slots = this.slots
    slots.length = 0
    this.slotRB.length = 0
    // side buffer, per slot: [nOff, (node, x, y, z, w) * nOff, nMix, (animIndex, weight, phase (NaN: the playing clip's)) * nMix, nIK, chains, nJig, jiggle, nRB, drawn node indices]
    // (bone rotation offsets, blend weights, IK chains; only sent when some instance has one)
    let offFloats = 0, anyOff = false
    for (const [model, r] of this.pending) {
      // IK targets are world positions: into model space now, with the model's latest (and predicted) placement
      r.ik = model.ikFloats(true)
      r.jig = model.jiggleFloats()
      const l = r.offs, m = r.mix, k = r.ik, j = r.jig, b = r.rb
      offFloats += (l ? l.length : 1) + (m ? m.length : 1) + (k ? k.length : 1) + (j ? j.length : 1) + (b ? b.length + 1 : 1)
      if (l || m || k || j || b) anyOff = true
    }
    let offs = null
    if (anyOff) {
      offs = new Float32Array(offFloats)
      let p = 0
      for (const r of this.pending.values()) {
        const l = r.offs, m = r.mix, k = r.ik, j = r.jig
        if (l) { offs.set(l, p); p += l.length } else offs[p++] = 0
        if (m) { offs.set(m, p); p += m.length } else offs[p++] = 0
        if (k) { offs.set(k, p); p += k.length } else offs[p++] = 0
        if (j) { offs.set(j, p); p += j.length } else offs[p++] = 0
        const b = r.rb
        if (b) { offs[p++] = b.length; offs.set(b, p); p += b.length } else offs[p++] = 0
      }
    }
    let i = 0
    for (const [model, r] of this.pending) {
      const b = i * REQ_STRIDE
      req[b] = model._iid
      req[b + 1] = r.animIndex
      req[b + 2] = r.time
      req[b + 3] = r.deltaTime
      req[b + 4] = r.blend
      req[b + 5] = r.loop
      slots.push(model)
      this.slotRB.push(r.rb || null)
      i++
    }
    this.pending.clear()
    const outNeed = count * this.poseFloats * 4
    let out = this.outBuf
    if (!out || out.byteLength < outNeed) out = new ArrayBuffer(Math.max(outNeed, 64))
    this.outBuf = null
    const reqBuf = this.reqBuf
    this.reqBuf = null
    this.inFlight = true
    if (offs) this.msgPort.postMessage({ type: "batch", count, req: reqBuf, out, offs: offs.buffer }, [reqBuf, out, offs.buffer])
    else this.msgPort.postMessage({ type: "batch", count, req: reqBuf, out }, [reqBuf, out])
  }

  _onBatchResult(data) {
    this.inFlight = false
    this.reqBuf = data.req
    this.outBuf = data.out
    const out = new Float32Array(data.out)
    const slots = this.slots
    const count = Math.min(data.count, slots.length)
    for (let i = 0; i < count; i++) {
      const model = slots[i]
      // Destroyed since the request went out
      if (!model || model.released || this.instances.get(model._iid) !== model) continue
      model.applyPose(out, i * this.poseFloats, this.slotRB[i])
    }
    slots.length = 0
    this.slotRB.length = 0
    if (this.pending.size) this.flush()
  }

  release() {
    this.released = true
    this.pending.clear()
    this.slots.length = 0
    this.slotRB.length = 0
    if (this.msgPort) {
      this.msgPort.postMessage({ type: "release" })
      this.msgPort.onmessage = null
      this.msgPort.close()
      this.msgPort = null
    }
    this.instances.clear()
  }
}

/**
 * Pose buffer layout for a model graph: which nodes carry a plain node matrix
 * and which skinned nodes share one set of bone matrices. KEEP IN SYNC with
 * buildPoseLayout in files/gltfWorker.js - both sides walk the same graph and
 * must agree on every offset.
 */
function buildPoseLayout(g) {
  const nodes = g.nodes || []
  const idxOf = new Map()
  for (let i = 0; i < nodes.length; i++) idxOf.set(nodes[i], i)
  const parent = new Map()
  const walk = (list, from) => {
    for (const n of list) {
      if (from && !parent.has(n)) parent.set(n, from)
      if (n.children) walk(n.children, n)
    }
  }
  walk((g.scene && g.scene.nodes) || [], null)
  const unskinned = []
  for (let i = 0; i < nodes.length; i++) if (nodes[i].mesh && !nodes[i].skin) unskinned.push(i)
  const groups = []
  const byKey = new Map()
  for (const sn of g.skinnedNodes || []) {
    const p = parent.get(sn)
    const key =
      (p ? idxOf.get(p) : -1) +
      "|" + (sn.translation || [0, 0, 0]).join(",") +
      "|" + (sn.scale || [1, 1, 1]).join(",") +
      "|" + sn.skin.joints.map((j) => idxOf.get(j)).join(",")
    let grp = byKey.get(key)
    if (!grp) {
      grp = { nodes: [], joints: sn.skin.joints.length }
      byKey.set(key, grp)
      groups.push(grp)
    }
    grp.nodes.push(idxOf.get(sn))
  }
  let floats = unskinned.length * 16
  for (const grp of groups) floats += (grp.joints + 1) * 16
  // Posed local bounds (min xyz, max xyz, 2 pad), see the worker's computePosedBounds.
  const boundsOffset = floats
  floats += 8
  // The drawn nodes' model-space matrices (setDrawnNodes): RB_MAX x 12 floats (3x3 + translation)
  const readbackOffset = floats
  floats += RB_MAX * 12
  return { unskinned, groups, floats, boundsOffset, readbackOffset }
}

class GltfModelWTop {
  constructor(runtime, sdkType, inst) {
    const mat4 = globalThis.glMatrix3D.mat4
    this._runtime = runtime
    this._sdkType = sdkType
    this.inst = inst
    this.gltfData = {}
    this._blendState = "init"
    this._lastTarget = [[], []]
    this._blendTarget = []
    this._blendTime = 0
    this._lastIndex = 0
    this._lastTargetIndex = 0
    this.drawMeshes = []
    this.drawMeshesIndex = 0
    this.currentColor = [-1, -1, -1, -1]
    this.nodeMeshMap = {}
    this.modelRotate = mat4.create()
    this.normalMatrix = mat4.create()
    this.meshNames = new Map()
    this.msgPort = null
    this.arrayBufferIndex = 0
    this.buff = null
    this.verts = new Float32Array(0)
    this.bones = new Float32Array(0)
    this.updateDrawVerts = false
    this.activeNodes = []
    this.workerReady = false
    this.boundingBoxInit = false
    this.boneBufferViews = []
    this.locUModelRotate = null
    this.locUModelRotateEnable = null
    this.locUPhongEnable = null
    this.locUSkinEnable = null
    this.locUNodeXformEnable = null
    this.locUNormalMatrix = null
    this.released = false
    this.useSharedWorker = false
    this._workerHost = null
    this._iid = undefined
    // Batched worker protocol state
    this._poseLayout = null
    this._groupBuffers = null
    this._prepDirty = true
    // Main-thread keyframe state, sampled lazily for node/bone world queries
    this._mainSampler = null
    this._nodeIndexOf = null
    this._trs = null
    this._poseDirty = false
    this._poseIndex = 0
    this._posePlayed = false // an animation has been sampled at least once (else the main pose stays at rest)
    this._poseTime = 0
    this._poseDelta = 0
    // Latest posed local bounds from the worker, or null before the first pose
    this._posedBounds = null
  }


  release() {
    this.released = true
    if (this._workerHost) {
      // Shared per-type worker: only unregister this instance
      this._workerHost.remove(this._iid)
      this._workerHost = null
      this.msgPort = null
    } else if (this.msgPort) {
      this.msgPort.postMessage({ type: "release" })
      this.msgPort.onmessage = null
      this.msgPort.close()
    }

    // Release boneBuffers in nodes
    if (this.gltfData && this.gltfData.nodes) {
      for (let i = 0; i < this.gltfData.nodes.length; i++) {
        if (
          this.gltfData.nodes[i] &&
          this.gltfData.nodes[i].boneBuffer &&
          typeof this.gltfData.nodes[i].boneBuffer.release === "function"
        ) {
          this.gltfData.nodes[i].boneBuffer.release()
          this.gltfData.nodes[i].boneBuffer = null
        }
      }
    }

    // Release boneBuffers in skinned nodes
    if (this.gltfData && this.gltfData.skinnedNodes) {
      for (let i = 0; i < this.gltfData.skinnedNodes.length; i++) {
        if (
          this.gltfData.skinnedNodes[i] &&
          this.gltfData.skinnedNodes[i].boneBuffer &&
          typeof this.gltfData.skinnedNodes[i].boneBuffer.release === "function"
        ) {
          this.gltfData.skinnedNodes[i].boneBuffer.release()
          this.gltfData.skinnedNodes[i].boneBuffer = null
        }
      }
    }

    this._runtime = null
    this._sdkType = null
    this.inst = null
    // @ts-ignore
    this.gltfData = null
    // @ts-ignore
    this._blendState = null
    // @ts-ignore
    this._lastTarget = null
    // @ts-ignore
    this._blendTarget = null
    // @ts-ignore
    this._blendTime = null
    // @ts-ignore
    this._lastIndex = null
    // @ts-ignore
    for (let ii = 0; ii < this.drawMeshes.length; ii++) {
      for (let jj = 0; jj < this.drawMeshes[ii].objectBuffers.length; jj++) {
        this.drawMeshes[ii].objectBuffers[jj].release()
      }
    }
    // @ts-ignore
    this.drawMeshes = null
    // @ts-ignore
    this.drawMeshesIndex = null
    // @ts-ignore
    this.currentColor = null
    // @ts-ignore
    this.nodeMeshMap = null
    this.modelRotate = null
    this.normalMatrix = null
    // @ts-ignore
    this.meshNames = null
    this.msgPort = null
    // @ts-ignore
    this.arrayBufferIndex = null
    this.buff = null
    // @ts-ignore
    this.verts = null
    // @ts-ignore
    this.bones = null
    // @ts-ignore
    this.updateDrawVerts = null
    // @ts-ignore
    this.activeNodes = null
    // @ts-ignore
    // @ts-ignore
    this.workerReady = null
    // @ts-ignore
    this.boundingBoxInit = null
    // @ts-ignore
    this.buffBones = null
    // @ts-ignore
    this.buffNodesMat = null
    // @ts-ignore
    this.nodesMat = null
    // @ts-ignore
    this.boneBufferViews = null
    // @ts-ignore
    this.locUModelRotate = null
    // @ts-ignore
    this.locUModelRotateEnable = null
    // @ts-ignore
    this.locUPhongEnable = null
    // @ts-ignore
    this.locUSkinEnable = null
    // @ts-ignore
    this.locUNodeXformEnable = null
    // @ts-ignore
    this.locUNormalMatrix = null
  }

  copyGltfData(sourceGltf) {
    // Light per-instance view: node objects cloned, everything else shared.
    // See GltfData.cloneInstanceViewLight.
    return globalThis.GltfData.cloneInstanceViewLight(sourceGltf)
  }

  async init() {
    this.gltfData = this.copyGltfData(this._sdkType.gltfData.gltf)
    if (this.released) return
    if ("buffers" in this.gltfData) {
      this.gltfData.buffers = null
    }
    if ("imageBitmap" in this.gltfData) {
      this.gltfData.imageBitmap = null
    }
    // Create node mesh map
    for (let ii = 0; ii < this.gltfData.nodes.length; ii++) {
      let node = this.gltfData.nodes[ii]
      if (!node.mesh) continue
      this.nodeMeshMap[node.name] = node.mesh.name
    }
    // Create dedicdated web worker for skinned mesh animation
    this.initDrawMeshes()
    // Layout and node indices come from the MASTER graph (the worker builds its
    // graph from the same one); indices apply to the clone by position.
    const master = this._sdkType.gltfData.gltf
    this._poseLayout = buildPoseLayout(master)
    this._nodeIndexOf = new Map()
    for (let i = 0; i < master.nodes.length; i++) this._nodeIndexOf.set(master.nodes[i], i)
    // Main-thread transforms live in one flat array; the clone nodes' TRS
    // properties become views into it so node/bone world queries keep working.
    this._trs = AnimSampler.initTRS(new Float32Array(master.nodes.length * AnimSampler.TRS_STRIDE), master.nodes)
    for (let i = 0; i < this.gltfData.nodes.length; i++) {
      const node = this.gltfData.nodes[i]
      const o = i * AnimSampler.TRS_STRIDE
      node.translation = this._trs.subarray(o, o + 3)
      node.rotation = this._trs.subarray(o + 3, o + 7)
      node.scale = this._trs.subarray(o + 7, o + 10)
    }
    this._mainSampler = AnimSampler.createSamplerState(master.animations)
    await this.createWorker(this._runtime)
    if (this.released) return
    this.workerReady = true
    // Before the first getPolygons(), so a model that will only ever show one
    // skin never builds, animates or draws the rest of the mesh list.
    if (this.inst.startHidden) this.setAllNodesDisabled()
    this.getPolygons(this.inst.gpuSkinning)
  }

  /**
   * Mark every node disabled. Same effect as the "Disable all nodes" action,
   * but callable from init() — i.e. before the model has drawn or animated
   * once, which the action cannot be, since it can only run from an event and
   * the earliest of those is "On model loaded".
   */
  setAllNodesDisabled() {
    const gltf = this.gltfData
    for (const list of [gltf.skinnedNodes, gltf.nodes]) {
      if (!list) continue
      for (const node of list) {
        node.disabled = true
        this.enableNode(node.name, false)
      }
    }
    this.inst.allNodesDisabled = true
    this._prepDirty = true
  }

  initDrawMeshes() {
    // For each mesh, create a drawMesh and initialize with UV, indices, name and material
    const gltf = this.gltfData
    this.drawMeshesIndex = -1
    // update all scene meshes, except skinned meshes
    for (let i = 0; i < gltf.scene.nodes.length; i++) {
      this.scanNode(gltf.scene.nodes[i], false)
    }
    // skinned nodes
    for (let ii = 0; ii < gltf.skinnedNodes.length; ii++) {
      this.scanNode(gltf.skinnedNodes[ii], true)
    }
  }

  scanNode(node, scanSkin, gpuSkinning) {
    gpuSkinning = true
    if ((node.mesh != undefined && node.skin == undefined) || scanSkin) {
      for (let i = 0; i < node.mesh.primitives.length; i++) {
        let posDataLength = node.mesh.primitives[i].attributes.POSITION.data.length
        this.drawMeshesIndex++
        if (!this.drawMeshes[this.drawMeshesIndex]) {
          this.drawMeshes.push({
            drawVerts: [],
            drawVertsOrig: [],
            bufferViews: [],
            drawUVs: [],
            drawIndices: [],
            drawColors: [],
            drawNormals: [],
            drawBones: [],
            drawJoints: [],
            drawWeights: [],
            disabled: false,
            objectBuffers: [],
            maxJointIndexUsed: -1,
          })
        }
        this.drawMeshes[this.drawMeshesIndex].node = node
        this.drawMeshes[this.drawMeshesIndex].bufferViews.push({ start: this.arrayBufferIndex, length: posDataLength })
        this.arrayBufferIndex += posDataLength
        this.meshNames.set(node.name, this.drawMeshesIndex)
        this.drawMeshes[this.drawMeshesIndex].disabled = node.disabled
        if ("material" in node.mesh.primitives[i]) {
          this.drawMeshes[this.drawMeshesIndex].material = node.mesh.primitives[i].material
        } else {
          this.drawMeshes[this.drawMeshesIndex].material = null
        }

        const drawUVs = this.drawMeshes[this.drawMeshesIndex].drawUVs
        const drawIndices = this.drawMeshes[this.drawMeshesIndex].drawIndices
        const drawColors = this.drawMeshes[this.drawMeshesIndex].drawColors
        const drawNormals = this.drawMeshes[this.drawMeshesIndex].drawNormals
        const drawJoints = this.drawMeshes[this.drawMeshesIndex].drawJoints
        const drawWeights = this.drawMeshes[this.drawMeshesIndex].drawWeights
        const drawVertsOrig = this.drawMeshes[this.drawMeshesIndex].drawVertsOrig

        if (drawUVs.length === 0 && "TEXCOORD_0" in node.mesh.primitives[i].attributes) {
          drawUVs.push(sharedOrCopy(node.mesh.primitives[i].attributes.TEXCOORD_0.data, Float32Array))
        }
        if (gpuSkinning && drawVertsOrig.length === 0 && "POSITION" in node.mesh.primitives[i].attributes) {
          drawVertsOrig.push(sharedOrCopy(node.mesh.primitives[i].attributes.POSITION.data, Float32Array))
        }
        if (drawColors.length === 0 && "COLOR_0" in node.mesh.primitives[i].attributes) {
          drawColors.push(sharedOrCopy(node.mesh.primitives[i].attributes.COLOR_0.data, Float32Array))
        }
        if (drawNormals.length === 0) {
          // Falls back to generated smooth normals when the model has none.
          const normalData = globalThis.gltfPrimitiveNormals(node.mesh.primitives[i])
          if (normalData) drawNormals.push(sharedOrCopy(normalData, Float32Array))
        }
        if (gpuSkinning && drawJoints.length === 0 && "JOINTS_0" in node.mesh.primitives[i].attributes) {
          const jointsData = sharedOrCopy(node.mesh.primitives[i].attributes.JOINTS_0.data, Uint16Array)
          drawJoints.push(jointsData)
          // Calculate maxJointIndexUsed
          let maxIndex = -1
          for (let k = 0; k < jointsData.length; k++) {
            if (jointsData[k] > maxIndex) {
              maxIndex = jointsData[k]
            }
          }
          this.drawMeshes[this.drawMeshesIndex].maxJointIndexUsed = maxIndex
        }
        if (gpuSkinning && drawWeights.length === 0 && "WEIGHTS_0" in node.mesh.primitives[i].attributes) {
          drawWeights.push(sharedOrCopy(node.mesh.primitives[i].attributes.WEIGHTS_0.data, Float32Array))
        }
        if (drawIndices.length === 0) drawIndices.push(sharedOrCopy(node.mesh.primitives[i].indices.data, Uint16Array))
      }
    }
    if (node.children) {
      for (let ii = 0; ii < node.children.length; ii++) {
        this.scanNode(node.children[ii])
      }
    }
  }

  /** Non-batch replies (legacy status messages); poses arrive via the host. */
  onWorkerMessage(e) {
    if (e.data && e.data.type === "status") {
      if (e.data.status && e.data.status.workerReady) this.workerReady = true
    } else if (this.inst && this.inst.debug) {
      console.debug("onMsg t:", this._runtime.GetTickCount(), e.data && e.data.type)
    }
  }

  // The worker only reads bufferViews, drawIndices and (rebuilt per tick) drawVerts
  _slimDrawMeshes() {
    return this.drawMeshes.map((dm) => ({
      bufferViews: dm.bufferViews,
      drawIndices: dm.drawIndices,
      drawVerts: [],
    }))
  }

  async createWorker(runtime) {
    // All instances of the type share one worker and one copy of the model
    // data; the worker only ever computes bone and node matrices (GPU skinning
    // is the only runtime path), so it needs no vertex data at all.
    this.useSharedWorker = true
    const sdkType = this._sdkType
    if (!sdkType.animWorkerHost) sdkType.animWorkerHost = new GltfWorkerHostTop()
    const host = sdkType.animWorkerHost
    const port = await host.getPort(runtime)
    if (this.released || !port) return null
    this._workerHost = host
    this._iid = this.inst.uid
    this.msgPort = port // shared port: release() must not close it
    host.poseFloats = this._poseLayout.floats
    host.add(this._iid, this)
    if (!host.gltfSent) {
      host.gltfSent = true
      host.attributesSent = false // length stubs only
      port.postMessage({
        type: "gltf",
        shared: true,
        gltf: this.buildWorkerPayload(false),
        buffLength: 0,
        drawMeshes: this._slimDrawMeshes(),
        buffBonesLength: this._poseLayout.floats,
        groupRadii: this._groupRadiiPayload(),
      })
    }
    port.postMessage({ type: "addInstance", iid: this._iid })
    return { msgPort: port }
  }

  /**
   * Per-joint bind-space boxes per skin group, so the worker can bound the
   * posed model. Uses the instance's cached _jointRadii (computed once per
   * model from the vertex weights).
   */
  _groupRadiiPayload() {
    const layout = this._poseLayout
    const nodes = this.gltfData.nodes
    const inst = this.inst
    return layout.groups.map((grp) => {
      const node = nodes[grp.nodes[0]]
      const r = typeof inst._jointRadii === "function" ? inst._jointRadii(node.skin) : null
      return r ? { boxMin: r.boxMin, boxMax: r.boxMax } : null
    })
  }

  /** Posed local bounds from the last worker reply, or null. */
  getPosedBounds() {
    return this._posedBounds
  }

  // Builds the minimal object graph the animation worker needs: node/skin/animation
  // state always; vertex attributes (positions, weights, joints, morph targets) only
  // when the worker will do CPU skinning. Keyframe data is always required.
  buildWorkerPayload(includeAttributes) {
    // From the MASTER graph, not this instance's light clone: the payload is
    // shared by every instance of the type, and the master is the graph whose
    // skins and animations reference its own nodes (the light clone shares
    // those objects, so its skins point at master joints - resolving them
    // against clone nodes yields nothing and every joint collapses to node 0).
    const src = this._sdkType.gltfData.gltf
    const nodeMap = new Map()
    const meshMap = new Map()
    const skinMap = new Map()

    const attrPayload = (acc) => {
      if (acc == null || acc.data == null) return undefined
      return includeAttributes ? { data: acc.data } : { dataLength: acc.data.length }
    }

    const meshPayload = (mesh) => {
      if (mesh == null) return undefined
      if (meshMap.has(mesh)) return meshMap.get(mesh)
      const copy = {
        name: mesh.name,
        primitives: mesh.primitives.map((p) => ({
          attributes: {
            POSITION: attrPayload(p.attributes && p.attributes.POSITION),
            WEIGHTS_0: attrPayload(p.attributes && p.attributes.WEIGHTS_0),
            JOINTS_0: attrPayload(p.attributes && p.attributes.JOINTS_0),
          },
          targets: p.targets
            ? p.targets.map((t) => (includeAttributes && t.POSITION ? { POSITION: { data: t.POSITION.data } } : {}))
            : undefined,
        })),
      }
      meshMap.set(mesh, copy)
      return copy
    }

    const skinPayload = (skin) => {
      if (skin == null) return undefined
      if (skinMap.has(skin)) return skinMap.get(skin)
      const copy = { joints: skin.joints.slice() } // rebound below
      skinMap.set(skin, copy)
      return copy
    }

    const nodes = (src.nodes || []).map((node) => {
      const copy = {
        name: node.name,
        translation: node.translation,
        rotation: node.rotation,
        scale: node.scale,
        matrix: node.matrix,
        invMatrix: node.invMatrix,
        weights: node.weights,
        disabled: node.disabled,
        invBindMatrix: node.invBindMatrix,
        boneMatrix: node.boneMatrix,
      }
      nodeMap.set(node, copy)
      return copy
    })
    for (const node of src.nodes || []) {
      const copy = nodeMap.get(node)
      if (node.children) copy.children = node.children.map((c) => nodeMap.get(c) || c)
      if (node.mesh) copy.mesh = meshPayload(node.mesh)
      if (node.skin) copy.skin = skinPayload(node.skin)
    }
    for (const skinCopy of skinMap.values()) {
      skinCopy.joints = skinCopy.joints.map((j) => nodeMap.get(j) || j)
    }

    const animations = (src.animations || []).map((a) => {
      const samplerMap = new Map()
      const samplerPayload = (s) => {
        if (samplerMap.has(s)) return samplerMap.get(s)
        const copy = {
          input: { min: s.input.min, max: s.input.max, data: s.input.data },
          output: { data: s.output.data },
        }
        samplerMap.set(s, copy)
        return copy
      }
      return {
        name: a.name,
        channels: a.channels.map((c) => ({
          sampler: samplerPayload(c.sampler),
          target: { path: c.target.path, node: nodeMap.get(c.target.node) || null },
        })),
      }
    })

    return {
      nodes,
      // Ordered meshes array: the "attributes" patch message indexes into it
      meshes: (src.meshes || []).map((m) => meshPayload(m)),
      animations,
      scene: src.scene ? { nodes: src.scene.nodes.map((n) => nodeMap.get(n) || n) } : { nodes: [] },
      skinnedNodes: (src.skinnedNodes || []).map((n) => nodeMap.get(n) || n),
    }
  }

  // One-time transfer of vertex attribute data to the worker, requested when a
  // GPU-skinning instance switches to a code path that needs CPU vertex transforms
  sendAttributesToWorker() {
    // With a shared worker the attribute data is shared too — send it once per host
    const store = this._workerHost || this
    if ((this._workerHost ? store.attributesSent : store._attributesSentToWorker) || !this.msgPort) return
    if (this._workerHost) store.attributesSent = true
    else store._attributesSentToWorker = true
    const src = this.gltfData
    const meshes = (src.meshes || []).map((m) => ({
      primitives: m.primitives.map((p) => ({
        POSITION: p.attributes && p.attributes.POSITION ? p.attributes.POSITION.data : undefined,
        WEIGHTS_0: p.attributes && p.attributes.WEIGHTS_0 ? p.attributes.WEIGHTS_0.data : undefined,
        JOINTS_0: p.attributes && p.attributes.JOINTS_0 ? p.attributes.JOINTS_0.data : undefined,
        targets: p.targets ? p.targets.map((t) => (t.POSITION ? t.POSITION.data : undefined)) : undefined,
      })),
    }))
    this.msgPort.postMessage({ type: "attributes", meshes })
  }

  enableNode(nodeName, enable) {
    this._prepDirty = true
    if (!this.msgPort) return // worker still starting up or already released
    this.msgPort.postMessage({ type: "enableNode", nodeName: nodeName, enable: enable, iid: this._iid })
  }

  setBBFromVerts(verts, minBBox, maxBBox) {
    let l = verts.length - 2
    maxBBox[2] = verts[l--]
    maxBBox[1] = verts[l--]
    maxBBox[0] = verts[l--]
    minBBox[2] = verts[l--]
    minBBox[1] = verts[l--]
    minBBox[0] = verts[l--]
  }

  /**
   * True when raw GL work can be queued into C3's batch instead of forcing a
   * flush. See deferredBatch.js. Mirrors GltfModel — this worker-animation
   * variant is a parallel implementation of the same render path, and skinned
   * objects come through here rather than through GltfModel.
   */
  _useDeferred(renderer) {
    const DeferredBatch = globalThis.DeferredBatch
    return !!(
      DeferredBatch &&
      !this.inst.isEditor &&
      DeferredBatch.install(renderer) &&
      DeferredBatch.isEnabled()
    )
  }

  /** Run a raw-GL helper, deferred into the batch when possible. */
  _glCall(renderer, fn, mat) {
    const DeferredBatch = globalThis.DeferredBatch
    if (this._useDeferred(renderer)) {
      const job = DeferredBatch.push(renderer, fn, this, renderer)
      if (mat) job._c3obj_b = DeferredBatch.scratch(job, 0, 16, mat)
      return
    }
    fn.call(this, renderer, mat)
  }

  /** Point C3's vertex/texcoord attributes back at C3's own buffers. */
  /**
   * Draw one primitive as a single batched mesh. See gltfModel.js for why the
   * positions need a copy: Quad3D2 folds in baseZ + currentZ itself, DrawMesh
   * takes absolute positions.
   */
  _drawMesh(renderer, drawMesh, index, positions, uvs, indices, z) {
    const zBase = this.inst.isEditor
      ? renderer.GetCurrentZ()
      : renderer.GetBaseZ() + renderer.GetCurrentZ()
    const zShift = zBase - z

    if (!drawMesh._drawPos) drawMesh._drawPos = []
    let pos = drawMesh._drawPos[index]
    if (!pos || pos.length !== positions.length) {
      pos = drawMesh._drawPos[index] = new Float32Array(positions.length)
    }
    for (let i = 0, n = positions.length; i < n; i += 3) {
      pos[i] = positions[i]
      pos[i + 1] = positions[i + 1]
      pos[i + 2] = positions[i + 2] + zShift
    }

    let tex = uvs
    if (!tex || tex.length * 3 !== positions.length * 2) {
      if (!drawMesh._drawUV) drawMesh._drawUV = []
      const need = (positions.length / 3) * 2
      tex = drawMesh._drawUV[index]
      if (!tex || tex.length !== need) tex = drawMesh._drawUV[index] = new Float32Array(need)
    }

    const MAX_INDICES = 393210
    if (indices.length <= MAX_INDICES) {
      renderer.DrawMesh(pos, tex, indices)
      return
    }
    for (let start = 0; start < indices.length; start += MAX_INDICES) {
      renderer.DrawMesh(pos, tex, indices.subarray(start, Math.min(start + MAX_INDICES, indices.length)))
    }
  }

  _restoreC3Attribs(renderer) {
    const gl = renderer._gl
    const batchState = renderer._batchState
    const shaderProgram = batchState.currentShader._shaderProgram
    const locAPos = globalThis.uniformCache.getAttributeLocation(gl, shaderProgram, "aPos")
    const locATex = globalThis.uniformCache.getAttributeLocation(gl, shaderProgram, "aTex")
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer._vertexBuffer)
    gl.vertexAttribPointer(locAPos, 3, gl.FLOAT, false, 0, 0)
    gl.enableVertexAttribArray(locAPos)
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer._texcoordBuffer)
    gl.vertexAttribPointer(locATex, 2, gl.FLOAT, false, 0, 0)
    gl.enableVertexAttribArray(locATex)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer._indexBuffer)
  }

  /** All post-draw cleanup in a single deferred job. */
  /**
   * Everything that has to happen after a model's meshes are drawn, in one
   * deferred job. Only genuinely shared GL state is put back: the uniforms
   * live on OUR dedicated program, which nothing else draws with, and the next
   * draw sets them through the value cache anyway.
   *
   * This used to also reset the colour/skin/rotate uniforms with RAW gl calls,
   * which the cache never saw. The cache then believed uUseUniformColor was
   * still 1 and uObjectColor still the last tint, skipped the next upload, and
   * every worker-animated model after the first drew untinted.
   */
  _afterDrawCleanup(renderer) {
    if (this.inst.staticGeometry) this._restoreC3Attribs(renderer)
    // @ts-ignore
    if (globalThis.BoneBuffer && typeof this._bindDummyBonesUbo === "function") this._bindDummyBonesUbo(renderer)
  }

  // All uniform writes below go through the value cache so it never disagrees
  // with the GL state. See _afterDrawCleanup.
  setVertexShaderModelRotate(renderer, modelRotate) {
    const gl = renderer._gl
    const shaderProgram = renderer._batchState.currentShader._shaderProgram
    globalThis.uniformCache.setMatrix4(gl, shaderProgram, "uModelRotate", modelRotate)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uModelRotateEnable", 1)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uPhongEnable", 0)
  }

  disableVertexShaderModelRotate(renderer) {
    const gl = renderer._gl
    const shaderProgram = renderer._batchState.currentShader._shaderProgram
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uModelRotateEnable", 0)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uPhongEnable", 0)
  }

  _disableGPUSkinning(renderer) {
    const gl = renderer._gl
    const shaderProgram = renderer._batchState.currentShader._shaderProgram
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uSkinEnable", 0.0)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uNodeXformEnable", 0.0)
  }

  _resetColorUniforms(renderer) {
    const gl = renderer._gl
    const shaderProgram = renderer._batchState.currentShader._shaderProgram
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uUseUniformColor", 0.0)
    globalThis.uniformCache.setVec4(gl, shaderProgram, "uObjectColor", 1.0, 1.0, 1.0, 1.0)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uHasVertexColors", 1.0)
  }

  render(renderer, x, y, z, tempQuad, whiteTexture, instanceC3Color, textures, opacity) {
    if (opacity === 0) return
    const deferred = this._useDeferred(renderer)
    if (!deferred) renderer.EndBatch()
    // A shadow pass (renderer._m3dShadowPass, set by the host around its
    // caster draws) projects the world position the vertex shader computes
    // from uModelRotate, so the model-view matrix is never read: skip setting
    // and restoring it. The per-model cleanup job is owed instead and run once
    // per run of models (Mikal3DObjectEndShadowRun).
    const shadow = deferred && renderer._m3dShadowPass === true && !this.inst.isEditor
    // Scratch, not per-call allocations: a draw per instance per pass.
    if (!this._scratch) {
      const m = globalThis.glMatrix3D
      this._scratch = {
        currentColor: [-1, -1, -1, -1],
        instanceColor: [0, 0, 0, 0],
        finalColor: m.vec4.create(),
        tmpModelView: m.mat4.create(),
        modelRotate: m.mat4.create(),
        rotate: m.quat.create(),
        pos: [0, 0, 0],
        scl: [0, 0, 0],
      }
    }
    const scratch = this._scratch
    const currentColor = scratch.currentColor
    currentColor[0] = currentColor[1] = currentColor[2] = currentColor[3] = -1
    let currentTexture = null
    const rendererVertexData = renderer._vertexData
    const rendererTexcoordData = renderer._texcoordData

    if (this.drawMeshes.length == 0) {
      console.warn("gltfModelW: No drawMeshes")
      return
    }

    const vec4 = globalThis.glMatrix3D.vec4
    const mat4 = globalThis.glMatrix3D.mat4
    const quat = globalThis.glMatrix3D.quat
    let totalTriangles = 0

    const instanceColor = scratch.instanceColor
    instanceColor[0] = instanceC3Color.getR()
    instanceColor[1] = instanceC3Color.getG()
    instanceColor[2] = instanceC3Color.getB()
    instanceColor[3] = instanceC3Color.getA()
    const finalColor = scratch.finalColor

    const tmpModelView = scratch.tmpModelView
    const modelRotate = scratch.modelRotate
    if (!this.inst.isEditor) {
      const xAngle = this.inst.xAngle
      const yAngle = this.inst.yAngle
      const zAngle = this.inst.zAngle
      const xScale = this.inst.scale / (this.inst.xScale == 0 ? 1 : this.inst.xScale)
      const yScale = this.inst.scale / (this.inst.yScale == 0 ? 1 : this.inst.yScale)
      const zScale = this.inst.scale / (this.inst.zScale == 0 ? 1 : this.inst.zScale)
      const rotate = scratch.rotate
      quat.fromEuler(rotate, xAngle, yAngle, zAngle)
      const pos = scratch.pos
      pos[0] = x; pos[1] = y; pos[2] = z
      const scl = scratch.scl
      scl[0] = xScale; scl[1] = -yScale; scl[2] = zScale
      mat4.fromRotationTranslationScale(modelRotate, rotate, pos, scl)
      mat4.copy(this.modelRotate, modelRotate)
      if (!shadow) {
        mat4.copy(tmpModelView, renderer._matMV)
        mat4.multiply(modelRotate, tmpModelView, modelRotate)
        renderer.SetModelViewMatrix(modelRotate)
      }
      this._glCall(renderer, this.setVertexShaderModelRotate, this.modelRotate)
    }

    // Default color
    vec4.copy(currentColor, instanceColor)
    let baseColorChanged = false
    if (!vec4.equals(currentColor, WHITE4)) baseColorChanged = true

    if (this.updateDrawVerts) {
      this.updateDrawVerts = false
    }
    // Deferred, C3 still owns the batch and these pointers — flushing and
    // zeroing them here would discard other objects' queued vertices.
    if (this.inst.staticGeometry && !this._useDeferred(renderer)) {
      renderer.EndBatch()
      renderer._vertexPtr = 0
      renderer._texPtr = 0
    }
    for (let j = 0; j <= this.drawMeshesIndex; j++) {
      // Skip render if disabled
      if (this.drawMeshes[j].disabled) continue

      if (this.inst.gpuSkinning && !this.drawMeshes[j].boneBuffer) {
        this.drawMeshes[j].boneBuffer = this.drawMeshes[j].node.boneBuffer
      }

      const drawVerts = this.drawMeshes[j].drawVerts
      const drawUVs = this.drawMeshes[j].drawUVs
      const drawIndices = this.drawMeshes[j].drawIndices
      const material = this.drawMeshes[j].material
      const hasTexture =
        material && "pbrMetallicRoughness" in material && "baseColorTexture" in material.pbrMetallicRoughness

      let color
      if (material && "pbrMetallicRoughness" in material && "baseColorFactor" in material.pbrMetallicRoughness) {
        color = material.pbrMetallicRoughness.baseColorFactor
      } else {
        color = null
      }
      if (color && color.length == 4) {
        color[3] = 1
        vec4.multiply(finalColor, instanceColor, color)
        if (vec4.equals(finalColor, currentColor) == false) {
          vec4.copy(currentColor, finalColor)
          // Remove SetColorRgba - we'll pass color via uniforms instead
          // renderer.SetColorRgba(finalColor[0], finalColor[1], finalColor[2], finalColor[3])
          baseColorChanged = true
        }
      }

      {
        if (!hasTexture) {
          if (currentTexture != whiteTexture) {
            renderer.SetTexture(whiteTexture)
            currentTexture = whiteTexture
          }
        } else {
          const texture = textures[material.name]
          // If texture is not loaded, skip rendering
          if (!texture) continue
          if (texture != currentTexture) {
            renderer.SetTexture(texture)
            currentTexture = texture
          }
        }
      }

      const xVerts = drawVerts

      if (this.inst.staticGeometry || this.inst.gpuSkinning) {
        const objectBuffers = this.drawMeshes[j].objectBuffers
        // Draw
        const boneBuffer = this.drawMeshes[j]?.node?.boneBuffer
        for (let i = 0; i < objectBuffers.length; i++) {
          const nodeXform = boneBuffer?.nodeXform
          if (nodeXform) {
            objectBuffers[i].setNodeXform(nodeXform)
          }
          objectBuffers[i].draw(
            renderer,
            boneBuffer, // This is the instanceBoneBuffer (BoneBufferW)
            this._sdkType.gltfData, // Pass the GltfData class instance
            currentColor // Pass calculated color to draw method
          )
          totalTriangles += objectBuffers[i].indexDataLength / 3
        }
        continue
      }

      const drawMesh = this.drawMeshes[j]
      for (let ii = 0; ii < drawVerts.length; ii++) {
        const ind = drawIndices[ii]
        totalTriangles += ind.length / 3
        this._drawMesh(renderer, drawMesh, ii, xVerts[ii], hasTexture ? drawUVs[ii] : null, ind, z)
      }
    }

    // Restore modelview matrix
    if (!this.inst.isEditor && !shadow) {
      renderer.SetModelViewMatrix(tmpModelView)
    }
    this.inst.totalTriangles = totalTriangles
    // Restore renderer buffers
    renderer._vertexData = rendererVertexData
    renderer._texcoordData = rendererTexcoordData

    if (!this.inst.isEditor) {
      if (shadow) {
        renderer._m3dShadowCleanup = this
      } else if (deferred) {
        // One job for the uniform resets and the attribute restore.
        this._glCall(renderer, this._afterDrawCleanup)
      } else {
        // Original flush-path ordering, preserved exactly.
        renderer.EndBatch()
        this.disableVertexShaderModelRotate(renderer)
        this._disableGPUSkinning(renderer)
        this._resetColorUniforms(renderer)
        if (this.inst.staticGeometry) {
          this._restoreC3Attribs(renderer)
          renderer._vertexPtr = 0
          renderer._texPtr = 0
        }
      }
    }
  }

  /**
   * One BoneBufferW per skin group, shared by every node in the group, plus a
   * node-matrix buffer per unskinned mesh node. Created on the first pose,
   * when the renderer is available.
   */
  _ensurePoseBuffers() {
    if (this._groupBuffers) return true
    const renderer = this.inst.renderer
    if (!renderer) return false
    const layout = this._poseLayout
    const nodes = this.gltfData.nodes
    for (let i = 0; i < layout.unskinned.length; i++) {
      const node = nodes[layout.unskinned[i]]
      if (!node.boneBuffer) node.boneBuffer = new BoneBufferW(renderer, 0, false)
    }
    const bonesPer = this._sdkType.gltfData ? this._sdkType.gltfData.bonesPerModelAsset : 0
    this._groupBuffers = layout.groups.map((grp) => {
      const bb = new BoneBufferW(renderer, bonesPer, true)
      for (let i = 0; i < grp.nodes.length; i++) nodes[grp.nodes[i]].boneBuffer = bb
      return bb
    })
    return true
  }

  /** Consume one pose from a batch reply (layout: see buildPoseLayout). */
  applyPose(out, base, rb) {
    if (!this._ensurePoseBuffers()) return
    const layout = this._poseLayout
    // the drawn nodes' matrices, with the node list they were asked for
    if (rb && rb.length) {
      const n = Math.min(rb.length, RB_MAX), d = this._drawn || (this._drawn = new Float32Array(RB_MAX * 12))
      const at = base + layout.readbackOffset
      for (let q = 0; q < n * 12; q++) d[q] = out[at + q]
      this._drawnIdx = rb
      this._drawnCount = n
    }
    const nodes = this.gltfData.nodes
    let k = base
    for (let i = 0; i < layout.unskinned.length; i++) {
      nodes[layout.unskinned[i]].boneBuffer.setNodeXformFrom(out, k)
      k += 16
    }
    const groups = layout.groups
    for (let gi = 0; gi < groups.length; gi++) {
      const floats = groups[gi].joints * 16
      const bb = this._groupBuffers[gi]
      bb.setBonesFrom(out, k, floats)
      k += floats
      bb.setRootNodeXformFrom(out, k)
      k += 16
    }
    const b = base + layout.boundsOffset
    if (out[b] === out[b]) {
      // NaN marks "no skinned bounds" (all groups hidden or no radii)
      let pb = this._posedBounds
      if (!pb) pb = this._posedBounds = { min: [0, 0, 0], max: [0, 0, 0] }
      pb.min[0] = out[b]; pb.min[1] = out[b + 1]; pb.min[2] = out[b + 2]
      pb.max[0] = out[b + 3]; pb.max[1] = out[b + 4]; pb.max[2] = out[b + 5]
    } else {
      this._posedBounds = null
    }
    this.updateDrawVerts = true
    this.workerReady = true
    if (!this.boundingBoxInit) {
      this.inst.initBoundingBox()
      this.boundingBoxInit = true
    }
    // Refresh the Construct box now rather than on the next tick: Construct
    // sizes an effect surface from the box before Draw, so a stale box clips.
    this.inst.updateBbox = true
    if (typeof this.inst.refreshBoundingBox === "function") this.inst.refreshBoundingBox()
    this.inst.runtime.UpdateRender()
  }

  typedVertsToDrawVerts(staticGeometry) {
    for (let j = 0; j <= this.drawMeshesIndex; j++) {
      const drawMesh = this.drawMeshes[j]
      const drawVerts = drawMesh.drawVerts
      const bufferViews = drawMesh.bufferViews
      const objectBuffers = drawMesh.objectBuffers
      drawVerts.length = 0
      if (!this.activeNodes.includes(j)) {
        drawVerts.push([])
        continue
      }
      if (!drawMesh._vertsCache) drawMesh._vertsCache = []
      for (let ii = 0; ii < bufferViews.length; ii++) {
        const bufferView = bufferViews[ii]
        let buffStart = bufferView.start

        // Reuse a persistent per-bufferView array instead of allocating every tick
        let v = drawMesh._vertsCache[ii]
        if (!v || v.length !== bufferView.length) {
          v = drawMesh._vertsCache[ii] = new Float32Array(bufferView.length)
        }
        v.set(this.verts.subarray(buffStart, buffStart + bufferView.length))
        drawVerts.push(v)
        if (staticGeometry) {
          if (objectBuffers.length == 0) {
            // No gpuSkinning here, so acquire() always allocates: this path
            // re-uploads per-instance vertex data via updateVertexData() below.
            objectBuffers.push(ObjectBufferW.acquire(this.inst.renderer, this.drawMeshes[j], 0, false, this._hasAnimations()))
          } else {
            objectBuffers[0].updateVertexData(this.inst.renderer, this.drawMeshes[j], 0)
          }
        }
      }
    }
  }

  /*
        Updates a node's matrix and all it's children nodes.
        After that it transforms unskinned mesh points and sends them to c2.
    */
  transformNode(node, staticGeometry, gpuSkinning) {
    const gltf = this.gltfData

    if (node.mesh != undefined && node.skin == undefined) {
      for (let i = 0; i < node.mesh.primitives.length; i++) {
        this.drawMeshesIndex++
        this.drawMeshes[this.drawMeshesIndex].disabled = node.disabled
        // Update material each time, in case an ACE changes it
        if ("material" in node.mesh.primitives[i]) {
          this.drawMeshes[this.drawMeshesIndex].material = node.mesh.primitives[i].material
        } else {
          this.drawMeshes[this.drawMeshesIndex].material = null
        }
        // Disabled meshes are skipped by render(), so allocating their GL
        // buffers is pure waste — and it is the bulk of load cost for a model
        // that ships many skins and shows one. This runs every prep, so a mesh
        // enabled later allocates on the next one, before it can draw.
        if (gpuSkinning && !node.disabled) {
          const objectBuffers = this.drawMeshes[this.drawMeshesIndex].objectBuffers
          if (objectBuffers.length === 0)
            objectBuffers.push(
              ObjectBufferW.acquire(
                this.inst.renderer,
                this.drawMeshes[this.drawMeshesIndex],
                0,
                gpuSkinning,
                this._hasAnimations()
              )
            )
        }
      }
    }
    if (node.children != undefined)
      for (let i = 0; i < node.children.length; i++) this.transformNode(node.children[i], staticGeometry, gpuSkinning)
  }

  /**
   * Identity of everything the editor's polygon walk depends on.
   *
   * The layout view redraws constantly and called getPolygons() every frame for
   * every instance, re-running the whole node walk and per-vertex transform. In
   * the editor the result only changes when the instance transform does.
   */
  /** True when anything can rewrite this model's vertices between frames. */
  _hasAnimations() {
    const anims = this.gltfData && this.gltfData.animations
    return !!(anims && anims.length)
  }

  _editorPolygonSignature() {
    const inst = this.inst
    const wi = inst._inst
    const mk = globalThis.mikal3deditor
    const viewRotate = mk && mk.enable ? mk.viewRotate : null
    return (
      wi.GetX() + "|" + wi.GetY() + "|" + wi.GetZElevation() + "|" +
      inst.xAngle + "|" + inst.yAngle + "|" + inst.zAngle + "|" +
      inst.scale + "|" + inst.xScale + "|" + inst.yScale + "|" + inst.zScale +
      (viewRotate ? "|" + viewRotate.join(",") : "")
    )
  }

  /** Request a pose without advancing the animation (init, node enable/disable). */
  getPolygons(staticGeometry) {
    if (!this.workerReady || !this._workerHost) return
    this.getPolygonsPrep(staticGeometry, this.inst.gpuSkinning)
    this._workerHost.queue(this, -1, 0, 0, 0, 1)
  }

  getEditorData(isEditor, gpuSkinning) {
    const tick = this._runtime.GetTickCount()
    let editorData = { tick: tick, isEditor: isEditor, gpuSkinning }
    if (isEditor) {
      const xAngle = this.inst.xAngle
      const yAngle = this.inst.yAngle
      const zAngle = this.inst.zAngle

      const x = this.inst._inst.GetX()
      const y = this.inst._inst.GetY()
      const z = this.inst._inst.GetZElevation()

      const xScale = this.inst.scale / (this.inst.xScale == 0 ? 1 : this.inst.xScale)
      const yScale = this.inst.scale / (this.inst.yScale == 0 ? 1 : this.inst.yScale)
      const zScale = this.inst.scale / (this.inst.zScale == 0 ? 1 : this.inst.zScale)

      const cullEnable = this.inst.backFaceCull

      // Send to worker with postMessage in case in editor
      editorData = {
        xScale,
        yScale,
        zScale,
        xAngle,
        yAngle,
        zAngle,
        x,
        y,
        z,
        tick,
        isEditor,
        cullEnable,
        gpuSkinning,
        localCenter: this.inst.localCenter,
      }
    }

    return editorData
  }

  //	Updates scene graph, and as a second step sends transformed skinned mesh points to c2.
  getPolygonsPrep(staticGeometry, gpuSkinning = false) {
    const gltf = this.gltfData

    this.drawMeshesIndex = -1

    const editorData = this.getEditorData(this.inst.isEditor, gpuSkinning)
    this._prepDirty = false

    // update all scene matrixes.
    // only update drawMesh meta data, vertex data will be updated in the worker
    for (let i = 0; i < gltf.scene.nodes.length; i++) {
      this.transformNode(gltf.scene.nodes[i], staticGeometry, gpuSkinning)
    }

    for (let ii = 0; ii < gltf.skinnedNodes.length; ii++) {
      let node = gltf.skinnedNodes[ii]
      for (let i = 0; i < node.mesh.primitives.length; i++) {
        this.drawMeshesIndex++
        this.drawMeshes[this.drawMeshesIndex].disabled = node.disabled
        // Update material each time, in case an ACE changes it
        if ("material" in node.mesh.primitives[i]) {
          this.drawMeshes[this.drawMeshesIndex].material = node.mesh.primitives[i].material
        } else {
          this.drawMeshes[this.drawMeshesIndex].material = null
        }
        // Same as transformNode: no GL buffers for meshes render() will skip.
        if (gpuSkinning && !node.disabled) {
          const objectBuffers = this.drawMeshes[this.drawMeshesIndex].objectBuffers
          if (objectBuffers.length === 0)
            objectBuffers.push(
              ObjectBufferW.acquire(
                this.inst.renderer,
                this.drawMeshes[this.drawMeshesIndex],
                0,
                gpuSkinning,
                this._hasAnimations()
              )
            )
        }
      }
    }
    return editorData
  }

  // sends a list of animation names to c2.
  getAnimationNames() {
    const gltf = this.gltfData
    let names = []
    if (!gltf.animations) return names

    for (let i = 0; i < gltf.animations.length; i++) names.push(gltf.animations[i].name)

    return names
  }

  // Get list of all bone/joint names
  getBoneNames() {
    const gltf = this.gltfData
    if (!gltf) return []

    const names = []
    if (gltf.skinnedNodes) {
      for (const skinnedNode of gltf.skinnedNodes) {
        if (!skinnedNode.skin || !skinnedNode.skin.joints) continue

        for (const joint of skinnedNode.skin.joints) {
          if (joint.name && !names.includes(joint.name)) {
            names.push(joint.name)
          }
        }
      }
    }

    return names
  }

  // Get list of all node names
  getNodeNames() {
    const gltf = this.gltfData
    if (!gltf) return []

    const names = []
    if (gltf.nodes) {
      for (const node of gltf.nodes) {
        if (node.name) {
          names.push(node.name)
        }
      }
    }

    return names
  }

  /**
   * Returns whether the update was actually sent.
   *
   * Only one message per instance is in flight at a time, so a request that
   * arrives while the worker is still busy is dropped. The caller must not
   * treat a dropped request as an update, or it waits a full rate interval
   * before trying again - at high instance counts the worker is busy most of
   * the time, so most updates were being lost for an interval each.
   */
  updateAnimationPolygons(index, time, onScreen, deltaTime, staticGeometry, gpuSkinning = false) {
    if (!this.workerReady || !this._workerHost) return false
    this._advanceTime(index, time, deltaTime)
    this.inst.updateBbox = true
    // Off screen: nothing to pose. Time keeps advancing on the main thread, so
    // the model resumes at the right frame when it comes back into view.
    if (!onScreen) return true
    if (this._prepDirty) this.getPolygonsPrep(staticGeometry, gpuSkinning)
    this._workerHost.queue(this, index, time, deltaTime, this.inst.animationBlend, this.inst.animationLoop ? 1 : 0)
    return true
  }

  /**
   * Main-thread bookkeeping that used to ride on a full keyframe pass: the
   * wrapped time, and the finished triggers for non-looping animations.
   */
  _advanceTime(index, time, deltaTime) {
    const anim = this.gltfData.animations[index]
    if (!anim) return
    const range = AnimSampler.animationTimeRange(anim)
    const tMin = range[0]
    const tMax = range[1]
    let t = time
    if (tMax > tMin) {
      if (this.inst.animationLoop) {
        t = ((time - tMin) % (tMax - tMin)) + tMin
      } else if (time > tMax) {
        t = tMax - 0.01
        if (!this.inst.animationFinished) {
          this.inst.animationFinished = true
          this.inst.animationNameFinished = this.inst.animationName
          this.inst.Trigger(self.C3.Plugins.Mikal_3DObject.Cnds.OnAnimationFinished)
          this.inst.Trigger(self.C3.Plugins.Mikal_3DObject.Cnds.OnAnimationNameFinished)
        }
      }
    }
    this.inst.currentAnimationTime = t
    // On demand (script API setMainThreadPoseOnDemand): nothing is sampled here; a tick that wasn't sampled hands
    // its time on to the next sample (the crossfade's clock counts it), and a clip change after such ticks first
    // samples the last one, so the crossfade starts from the pose it would have had
    const onDemand = this.inst._mainPoseOnDemand
    if (onDemand && this._poseDirty && this._posePlayed && index !== this._poseIndex) this.ensureMainThreadPose()
    const pending = onDemand && this._poseDirty ? this._poseDelta : 0
    // The inputs as they are now go with this tick's pose, like sampling here does: by the time the pose is asked
    // for, the events may have moved the model (its IK chains go in under this placement), changed the crossfade
    // time, or set new weights and offsets (those are for the next tick)
    this._tickValid = false
    this._tickMValid = false
    if (onDemand) {
      this._tickBlend = this.inst.animationBlend
      this._tickLoop = this.inst.animationLoop
      this._tickMix = this._mainMix()
      this._tickOffs = this.boneOffsetFloats()
      this._tickValid = true
      if (this.inst._ikChains && this.inst._ikChains.size && this.inst._refreshModelRotate()) {
        const tm = this._tickM || (this._tickM = new Float64Array(16)) // (as precise as modelRotate, whatever its array type)
        tm.set(this.modelRotate)
        this._tickMValid = true
      }
    }
    this._poseIndex = index
    this._posePlayed = true
    this._poseTime = time
    this._poseDelta = onDemand ? pending + deltaTime : deltaTime
    this._poseDirty = true
    // Blending is stateful (it snapshots the previous pose every frame), so a
    // blending model has to be sampled every frame to stay correct. Without
    // blending the pose is only needed when something asks for a node.
    if (this.inst.animationBlend != 0 && !onDemand) this.ensureMainThreadPose()
  }

  /** Bring the main-thread node transforms up to date with the current time. */
  ensureMainThreadPose() {
    if (!this._poseDirty || !this._mainSampler) return
    this._poseDirty = false
    // node world matrices cached for the last pose (instance.js _chainMatrix) are stale from here
    this._poseVersion = (this._poseVersion || 0) + 1
    const saved = this._offSaved || (this._offSaved = new Map())
    // undo in the reverse order of applying: IK (last) first, then the offsets
    const ikSaved = this._ikSaved || (this._ikSaved = new Map())
    if (ikSaved.size) ikRestore(this._trs, ikSaved)
    if (saved.size) restoreBoneOffsets(this._trs, saved)
    const anim = this._posePlayed ? this.gltfData.animations[this._poseIndex] : null
    // (an on-demand pose sampled after its tick began: the inputs kept when it began)
    const tick = this._tickValid
    this._tickValid = false
    if (anim) {
      AnimSampler.sampleAnimation(
        this._mainSampler,
        AnimSampler.prepareAnimation(anim, this._nodeIndexOf),
        this._poseIndex,
        this._poseTime,
        this._poseDelta,
        tick ? this._tickBlend : this.inst.animationBlend,
        tick ? this._tickLoop : this.inst.animationLoop,
        this._trs,
        tick ? this._tickMix : this._mainMix(),
        this._mainChannelMask(anim, this._poseIndex)
      )
    }
    const offs = tick ? this._tickOffs : this.boneOffsetFloats()
    if (offs) applyBoneOffsets(this._trs, offs, 1, offs[0], saved, this._trs.length / TRS_STRIDE)
    // the info is kept per chain NAME: chains removed and set again reorder the map, and an animating model's
    // pose isn't recomputed in between (an index lookup gave a foot the other foot's animated position)
    const infoByName = this._ikInfoByName || (this._ikInfoByName = new Map())
    infoByName.clear()
    const ik = this.ikFloats(false, this._tickMValid ? this._tickM : null)
    this._tickMValid = false
    if (ik) {
      const n = ik[0]
      if (!this._ikInfo || this._ikInfo.length < n * 7) this._ikInfo = new Float32Array(n * 7)
      applyIK(this._trs, this._ikParents(), ik, 1, n, ikSaved, this._ikInfo)
      // (one array per chain name, refilled: ikChainInfo only reads it)
      const pool = this._ikInfoPool || (this._ikInfoPool = new Map())
      let k = 0
      for (const name of this.inst._ikChains.keys()) {
        let v = pool.get(name)
        if (!v) pool.set(name, (v = new Array(7)))
        for (let j = 0; j < 7; j++) v[j] = this._ikInfo[k * 7 + j]
        infoByName.set(name, v)
        k++
      }
    }
  }

  /**
   * Main-thread bones (script API setMainThreadNodes): the channels of those nodes and their parents, per animation,
   * or null (all). The main-thread pose only serves bone reads (getBoneWorldPosition, IK chain info): sampling the
   * other channels there was half of the work for nothing.
   */
  _mainChannelMask(anim, animIndex) {
    if (!this.inst._mainNodes) return null
    this._ensureMainNodeSet()
    let m = this._chanMasks.get(animIndex)
    if (!m) {
      const t = anim._targetIdx
      m = new Uint8Array(t.length)
      for (let i = 0; i < t.length; i++) m[i] = t[i] >= 0 && this._mainNodeSet.has(t[i]) ? 1 : 0
      this._chanMasks.set(animIndex, m)
    }
    return m
  }

  /** The main-thread bones with all their parents, as node indices (rebuilt when the set changes). */
  _ensureMainNodeSet() {
    if (this._chanMasksV === this.inst._mainNodesVersion) return
    this._chanMasksV = this.inst._mainNodesVersion
    this._chanMasks = new Map()
    const parents = this._ikParents(), set = new Set()
    for (const name of this.inst._mainNodes) for (let i = this._nodeIdx(name); i >= 0 && !set.has(i); i = parents[i]) set.add(i)
    this._mainNodeSet = set
  }

  /** Node indices of the instance's drawn nodes (setDrawnNodes), cached per change, or null. */
  drawnNodeIdx() {
    const names = this.inst._drawnNodes
    if (!names || !names.length) return null
    if (this._drawnV !== this.inst._drawnNodesVersion) {
      this._drawnV = this.inst._drawnNodesVersion
      const idx = []
      for (const nm of names) { const i = this._nodeIdx(nm); if (i >= 0 && idx.length < RB_MAX) idx.push(i) }
      this._drawnReq = idx.length ? new Int32Array(idx) : null
    }
    return this._drawnReq
  }

  /** The model-space matrix of a drawn node as last drawn (into out, a mat4), or false (not drawn yet). */
  drawnNodeMatrix(name, out) {
    const idx = this._drawnIdx, d = this._drawn
    if (!idx || !d) return false
    const ni = this._nodeIdx(name)
    for (let j = 0; j < this._drawnCount; j++) {
      if (idx[j] !== ni) continue
      const q = j * 12
      out[0] = d[q]; out[1] = d[q + 1]; out[2] = d[q + 2]; out[3] = 0
      out[4] = d[q + 3]; out[5] = d[q + 4]; out[6] = d[q + 5]; out[7] = 0
      out[8] = d[q + 6]; out[9] = d[q + 7]; out[10] = d[q + 8]; out[11] = 0
      out[12] = d[q + 9]; out[13] = d[q + 10]; out[14] = d[q + 11]; out[15] = 1
      return true
    }
    return false
  }

  /** Whether the main-thread pose keeps `name` up to date (no main-thread bone set, or the node is in it). */
  mainNodeCovered(name) {
    if (!this.inst._mainNodes) return true
    this._ensureMainNodeSet()
    const i = this._nodeIdx(name)
    return i < 0 || this._mainNodeSet.has(i)
  }

  /** Parent index of every node (master graph order), for the IK solver. */
  _ikParents() {
    if (this._ikParentIdx) return this._ikParentIdx
    const nodes = this._sdkType.gltfData.gltf.nodes
    const idx = new Map(nodes.map((n, i) => [n, i]))
    const p = new Int32Array(nodes.length).fill(-1)
    nodes.forEach((n, i) => (n.children || []).forEach((c) => { const ci = typeof c === "number" ? c : idx.get(c); if (ci !== undefined) p[ci] = i }))
    return (this._ikParentIdx = p)
  }

  _nodeIdx(name) {
    if (!this._nodeIndexByName) {
      this._nodeIndexByName = new Map()
      const nodes = this._sdkType.gltfData.gltf.nodes
      for (let i = 0; i < nodes.length; i++) if (nodes[i].name != null && !this._nodeIndexByName.has(nodes[i].name)) this._nodeIndexByName.set(nodes[i].name, i)
    }
    const i = this._nodeIndexByName.get(name)
    return i === undefined ? -1 : i
  }

  /**
   * [n, dt, model matrix (16), (node, stiffness, damping, max angle (rad), length, gravity, axis xyz, anchor node
   * (-1 = none), anchor weight, anchor pose xyzw (NaN = bind), anchor tilt xyz (rad), limit axis xyz, limit angle (rad),
   * drag) * n]: the instance's jiggle bones for the worker (applyJiggle, JIG_STRIDE 23), or null.
   */
  jiggleFloats() {
    const map = this.inst && this.inst._jiggle
    if (!map || map.size === 0 || !this._trs || !this.inst._refreshModelRotate()) return null
    const S = 23, need = 18 + map.size * S
    const out = this._jigOut && this._jigOut.length === need ? this._jigOut : (this._jigOut = new Float32Array(need))
    out[0] = map.size
    out[1] = this._runtime.GetDt(this.inst.GetInstance()) // its own time scale (0: paused, the springs too)
    out.set(this.modelRotate, 2)
    const R = Math.PI / 180
    let o = 18
    for (const [name, j] of map) {
      out[o] = this._nodeIdx(name)
      out[o + 1] = j.stiffness
      out[o + 2] = j.damping
      out[o + 3] = j.maxAngle * R
      out[o + 4] = j.length
      out[o + 5] = j.gravity
      const a = j.axis, q = j.anchorPose, t = j.anchorTilt, lx = j.limitAxis
      for (let k = 0; k < 3; k++) out[o + 6 + k] = a ? a[k] : k === 1 ? 1 : 0
      out[o + 9] = j.anchor ? this._nodeIdx(j.anchor) : -1
      out[o + 10] = j.anchorWeight
      for (let k = 0; k < 4; k++) out[o + 11 + k] = q ? q[k] : NaN
      for (let k = 0; k < 3; k++) out[o + 15 + k] = t ? t[k] * R : 0
      for (let k = 0; k < 3; k++) out[o + 18 + k] = lx ? lx[k] : 0
      out[o + 21] = (j.limitAngle || 0) * R
      out[o + 22] = j.drag || 0
      o += S
    }
    return out
  }

  /**
   * [count, (IK_STRIDE floats) * count]: the instance's IK chains (world targets) in model space, or null, in the
   * order of inst._ikChains. predict: for the worker, whose pose is drawn one frame later: the targets go into
   * model space with next frame's model matrix, extrapolated from this frame's and the last (the model keeps
   * moving and turning meanwhile; a planted foot would slide by a frame of movement otherwise).
   */
  ikFloats(predict, placement) {
    const chains = this.inst._ikChains
    if (!chains || chains.size === 0 || !this._trs || !this.inst._refreshModelRotate()) return null
    // @ts-ignore
    const mat4 = globalThis.glMatrix3D.mat4
    const M = this.modelRotate
    // placement: a model matrix to use instead of the current one (an on-demand pose sampled later in the tick)
    let use = placement || M
    if (predict) {
      // next frame's matrix, extrapolated from this tick's and the previous tick's. Only from a matrix recorded
      // exactly one tick ago (chains that just came back would extrapolate from a stale one: a wild frame), and
      // never across a jump (a teleport, a snap)
      const tick = this._runtime.GetTickCount()
      const last = this._ikLastM || (this._ikLastM = mat4.create())
      const prev = this._ikPrevM || (this._ikPrevM = mat4.create())
      if (this._ikTick !== tick) {
        this._ikHasPrev = this._ikTick === tick - 1
        mat4.copy(prev, last)
        this._ikTick = tick
      }
      mat4.copy(last, M)
      if (this._ikHasPrev) {
        const scale = hypot3(M[0], M[1], M[2]) || 1
        let turn = 0
        for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) turn = Math.max(turn, Math.abs(M[i] - prev[i]) / scale)
        if (hypot3(M[12] - prev[12], M[13] - prev[13], M[14] - prev[14]) < 120 && turn < 0.35) {
          use = this._ikPredM || (this._ikPredM = mat4.create())
          for (let i = 0; i < 16; i++) use[i] = 2 * M[i] - prev[i]
        }
      }
    }
    const inv = this._ikInv || (this._ikInv = mat4.create())
    if (!mat4.invert(inv, use)) return null
    // (reused, zeroed like a new array: the batch copies it into its side buffer, the main-thread pose uses it at once)
    const need = 1 + chains.size * IK_STRIDE, key = predict ? "_ikOutP" : "_ikOut"
    let out = this[key]
    if (!out || out.length !== need) out = this[key] = new Float32Array(need)
    else out.fill(0)
    out[0] = chains.size
    let o = 1
    const pt = (x, y, z, k) => {
      out[k] = inv[0] * x + inv[4] * y + inv[8] * z + inv[12]
      out[k + 1] = inv[1] * x + inv[5] * y + inv[9] * z + inv[13]
      out[k + 2] = inv[2] * x + inv[6] * y + inv[10] * z + inv[14]
    }
    for (const c of chains.values()) {
      out[o] = this._nodeIdx(c.upper); out[o + 1] = this._nodeIdx(c.lower); out[o + 2] = this._nodeIdx(c.end)
      pt(c.target[0], c.target[1], c.target[2], o + 3)
      if (c.pole) pt(c.pole[0], c.pole[1], c.pole[2], o + 6)
      else out[o + 6] = out[o + 7] = out[o + 8] = NaN
      out[o + 9] = c.weight
      if (c.endAxis && c.endDir && c.endWeight > 0) {
        out[o + 10] = c.endAxis[0]; out[o + 11] = c.endAxis[1]; out[o + 12] = c.endAxis[2]
        const x = c.endDir[0], y = c.endDir[1], z = c.endDir[2]
        out[o + 13] = inv[0] * x + inv[4] * y + inv[8] * z
        out[o + 14] = inv[1] * x + inv[5] * y + inv[9] * z
        out[o + 15] = inv[2] * x + inv[6] * y + inv[10] * z
        out[o + 16] = c.endWeight
      }
      if (c.endAxis2 && c.endDir2) {
        out[o + 17] = c.endAxis2[0]
        out[o + 18] = c.endAxis2[1]
        out[o + 19] = c.endAxis2[2]
        const x2 = c.endDir2[0], y2 = c.endDir2[1], z2 = c.endDir2[2]
        out[o + 20] = inv[0] * x2 + inv[4] * y2 + inv[8] * z2
        out[o + 21] = inv[1] * x2 + inv[5] * y2 + inv[9] * z2
        out[o + 22] = inv[2] * x2 + inv[6] * y2 + inv[10] * z2
      }
      if (c.hingeAxis) {
        out[o + 23] = c.hingeAxis[0]
        out[o + 24] = c.hingeAxis[1]
        out[o + 25] = c.hingeAxis[2]
      }
      // follow (a chain set less often than every frame): the anchor into model space like the target, world up as
      // a model-space direction
      if (c.anchor && (c.followH || c.followV)) {
        pt(c.anchor[0], c.anchor[1], c.anchor[2], o + 26)
        out[o + 29] = c.followH
        out[o + 30] = c.followV
        const ul = hypot3(inv[8], inv[9], inv[10]) || 1
        out[o + 31] = inv[8] / ul; out[o + 32] = inv[9] / ul; out[o + 33] = inv[10] / ul
      }
      if (c.pole && c.poleAnchor) pt(c.poleAnchor[0], c.poleAnchor[1], c.poleAnchor[2], o + 34)
      else out[o + 34] = out[o + 35] = out[o + 36] = NaN
      o += IK_STRIDE
    }
    return out
  }

  /** The chain's end before IK and how far its target was (1 = full reach), from the main-thread pose. */
  ikChainInfo(name) {
    if (!this.inst || !this.inst._refreshModelRotate()) return null
    this.ensureMainThreadPose()
    // from the last main-thread pose: a chain set since then has no info yet (its bone is still where the animation
    // put it: read the bone), one removed since then still has the animated position it was solved from
    const v = this._ikInfoByName && this._ikInfoByName.get(name)
    if (!v) return null
    const M = this.modelRotate, x = v[0], y = v[1], z = v[2]
    return {
      animatedEnd: [
        M[0] * x + M[4] * y + M[8] * z + M[12],
        M[1] * x + M[5] * y + M[9] * z + M[13],
        M[2] * x + M[6] * y + M[10] * z + M[14],
      ],
      reach: v[3],
      // the middle joint (knee / elbow) where the animation puts it
      animatedMid: [
        M[0] * v[4] + M[4] * v[5] + M[8] * v[6] + M[12],
        M[1] * v[4] + M[5] * v[5] + M[9] * v[6] + M[13],
        M[2] * v[4] + M[6] * v[5] + M[10] * v[6] + M[14],
      ],
    }
  }


  /** [count, (nodeIndex, x, y, z, w) * count] for the instance's bone rotation offsets, or null. */
  boneOffsetFloats() {
    const map = this.inst._boneOffsets
    if (!map || map.size === 0 || !this._trs) return null
    if (this._offFloats && this._offVersion === this.inst._boneOffsetsVersion) return this._offFloats
    if (!this._nodeIndexByName) {
      this._nodeIndexByName = new Map()
      const nodes = this._sdkType.gltfData.gltf.nodes
      for (let i = 0; i < nodes.length; i++) if (nodes[i].name != null && !this._nodeIndexByName.has(nodes[i].name)) this._nodeIndexByName.set(nodes[i].name, i)
    }
    const list = []
    for (const [name, q] of map) {
      const ni = this._nodeIndexByName.get(name)
      if (ni !== undefined) list.push(ni, q[0], q[1], q[2], q[3])
    }
    this._offFloats = list.length ? new Float32Array([list.length / 5, ...list]) : null
    this._offVersion = this.inst._boneOffsetsVersion
    return this._offFloats
  }

  /** [count, (animIndex, weight, phase (NaN: the playing clip's)) * count] for the instance's blend weights (normalized), or null. */
  blendMixFloats() {
    const map = this.inst._blendWeights
    if (!map || map.size === 0) return null
    if (this._mixVersion === this.inst._blendWeightsVersion) return this._mixFloats
    const anims = this.gltfData.animations || []
    if (this._animIdxFor !== anims) {
      // first index per name, like findIndex
      this._animIdxFor = anims
      this._animIdx = new Map()
      for (let i = 0; i < anims.length; i++) if (!this._animIdx.has(anims[i].name)) this._animIdx.set(anims[i].name, i)
    }
    const phases = this.inst._blendPhases
    const list = []
    let sum = 0
    for (const [name, w] of map) {
      const found = this._animIdx.get(name), ai = found === undefined ? -1 : found
      if (ai >= 0 && w > 0) { list.push(ai, w, phases && phases.has(name) ? phases.get(name) : NaN); sum += w }
    }
    for (let k = 1; k < list.length; k += 3) list[k] /= sum
    this._mixFloats = list.length ? new Float32Array([list.length / 3, ...list]) : null
    this._mixVersion = this.inst._blendWeightsVersion
    this._mainMixCache = null
    return this._mixFloats
  }

  /** The mix for the main-thread sampler ({count, anims, idx, w}), or null. */
  _mainMix() {
    const m = this.blendMixFloats()
    if (!m) return null
    if (this._mainMixCache) return this._mainMixCache
    const anims = this.gltfData.animations
    const mix = { count: m[0], anims: [], idx: [], w: [], ph: [] }
    for (let k = 0; k < m[0]; k++) {
      const ai = m[1 + k * 3]
      mix.anims.push(AnimSampler.prepareAnimation(anims[ai], this._nodeIndexOf))
      mix.idx.push(ai)
      mix.w.push(m[2 + k * 3])
      mix.ph.push(m[3 + k * 3])
    }
    this._mainMixCache = mix
    return mix
  }

  onBlendWeightsChanged() {
    this._poseChangedOutsideTick()
  }

  /** Offsets changed: main-thread pose and (if not animating every frame anyway) a worker pose are stale. */
  onBoneOffsetsChanged() {
    this._poseChangedOutsideTick()
  }

  onIKChanged() {
    this._poseChangedOutsideTick()
  }

  // Weights or offsets changed (in events, between two ticks). An animating model picks them up at its next tick:
  // re-sampling now would run the stateful sampler a second time this tick (blend time counted twice) and write
  // the old clip with the new weights into the crossfade snapshot. A still model needs a fresh pose now (no time
  // passes: delta 0).
  _poseChangedOutsideTick() {
    if (this.inst.animationPlay && this._posePlayed) return
    this._poseDirty = true
    this._poseDelta = 0
    if (this._workerHost && this.workerReady) this._workerHost.queue(this, -1, 0, 0, 0, 1)
  }

  updateModelRotate(x, y, z) {
    // @ts-ignore
    const vec3 = globalThis.glMatrix3D.vec3
    // @ts-ignore
    const mat4 = globalThis.glMatrix3D.mat4
    // @ts-ignore
    const quat = globalThis.glMatrix3D.quat

    const xAngle = this.inst.xAngle
    const yAngle = this.inst.yAngle
    const zAngle = this.inst.zAngle
    const xScale = this.inst.scale / (this.inst.xScale == 0 ? 1 : this.inst.xScale)
    const yScale = this.inst.scale / (this.inst.yScale == 0 ? 1 : this.inst.yScale)
    const zScale = this.inst.scale / (this.inst.zScale == 0 ? 1 : this.inst.zScale)
    // called for every bone read, IK chain info and batch: the same inputs (and a matrix nobody else rewrote since:
    // the draw sets it too) give the same matrix. Compared like Object.is (-0 and NaN too), inline in typed arrays:
    // Object.is calls on doubles boxed them wherever the call wasn't inlined (~24 MB/s of garbage with 50 players)
    const M = this.modelRotate, last = this._mrOut
    const cur = this._mrCur || (this._mrCur = new Float64Array(9)), prev = this._mrIn
    cur[0] = x; cur[1] = y; cur[2] = z; cur[3] = xAngle; cur[4] = yAngle; cur[5] = zAngle; cur[6] = xScale; cur[7] = yScale; cur[8] = zScale
    if (prev && last) {
      let same = true
      for (let i = 0; i < 9 && same; i++) {
        const a = cur[i], b = prev[i]
        same = a === b ? a !== 0 || 1 / a === 1 / b : a !== a && b !== b
      }
      for (let i = 0; i < 16 && same; i++) {
        const a = M[i], b = last[i]
        same = a === b ? a !== 0 || 1 / a === 1 / b : a !== a && b !== b
      }
      if (same) return
    }
    const rotate = this._mrQ || (this._mrQ = quat.create())
    const t = this._mrT || (this._mrT = [0, 0, 0]), s = this._mrS || (this._mrS = [0, 0, 0])
    t[0] = x; t[1] = y; t[2] = z
    s[0] = xScale; s[1] = -yScale; s[2] = zScale
    quat.fromEuler(rotate, xAngle, yAngle, zAngle)
    mat4.fromRotationTranslationScale(M, rotate, t, s)
    ;(this._mrIn || (this._mrIn = new Float64Array(9))).set(cur)
    if (!this._mrOut) this._mrOut = new Float32Array(16)
    this._mrOut.set(M)
  }

}

// @ts-ignore
if (!globalThis.GltfModelW) {
  // @ts-ignore
  globalThis.GltfModelW = GltfModelWTop
}
