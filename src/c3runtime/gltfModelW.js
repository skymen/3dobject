// @ts-check
"use strict"
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

/**
 * Sample `anim` (prepared with prepareAnimation) at `time` into `trs`, with
 * the blend state machine and cross-animation blending of the original
 * implementation. Morph-target weight channels are ignored: the worker path
 * never rendered morphs.
 */
function sampleAnimation(state, anim, index, time, deltaTime, animationBlend, animationLoop, trs) {
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

  const blending = state.blendState === "blend" && state.blendSnap
  const blendSnap = blending ? state.blendSnap : null
  let blend = 0
  if (blending) {
    blend = state.blendTime == 0 ? 0 : state.blendTime / animationBlend
    if (blend > 1) blend = 1
  }
  const snapshot = animationBlend != 0 ? state.snaps[state.lastTargetIndex] : null
  if (snapshot) snapshot.count = n

  for (let i = 0; i < n; i++) {
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
    const span = times[t1] - times[t0]
    const f = span > 0 ? (t - times[t0]) / span : 0

    const out = c.sampler.output.data
    const base = targetIdx[i] * TRS_STRIDE
    let o
    if (code === PATH_TRANSLATION) {
      o = base
      lerp3(trs, o, out, t0 * 3, t1 * 3, f)
    } else if (code === PATH_ROTATION) {
      o = base + 3
      slerp4(trs, o, out, t0 * 4, t1 * 4, f)
    } else {
      o = base + 7
      lerp3(trs, o, out, t0 * 3, t1 * 3, f)
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

// @ts-ignore
const BoneBufferW = globalThis.BoneBuffer
// @ts-ignore
const ObjectBufferW = globalThis.ObjectBuffer

// One animation worker shared by all instances of an object type (used when GPU
// skinning is known at creation time). Owns the message port and dispatches worker
// replies to the registered GltfModelW instances by instance id.
// Request slot layout, shared with the worker (see files/gltfWorker.js).
const REQ_STRIDE = 8

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
    this.msgPort.postMessage({ type: "batch", count, req: reqBuf, out }, [reqBuf, out])
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
      model.applyPose(out, i * this.poseFloats)
    }
    slots.length = 0
    if (this.pending.size) this.flush()
  }

  release() {
    this.released = true
    this.pending.clear()
    this.slots.length = 0
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
  return { unskinned, groups, floats, boundsOffset }
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
        if (drawNormals.length === 0 && "NORMAL" in node.mesh.primitives[i].attributes) {
          drawNormals.push(sharedOrCopy(node.mesh.primitives[i].attributes.NORMAL.data, Float32Array))
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
   * Bind-pose joint position and radius per skin group, so the worker can
   * bound the posed model. Uses the instance's cached _jointRadii (computed
   * once per model from the vertex weights).
   */
  _groupRadiiPayload() {
    const layout = this._poseLayout
    const nodes = this.gltfData.nodes
    const inst = this.inst
    return layout.groups.map((grp) => {
      const node = nodes[grp.nodes[0]]
      const r = typeof inst._jointRadii === "function" ? inst._jointRadii(node.skin) : null
      return r ? { positions: r.positions, radii: r.radii } : null
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
    if (!this._useDeferred(renderer)) renderer.EndBatch()
    let currentColor = [-1, -1, -1, -1]
    let currentTexture = null
    const rendererVertexData = renderer._vertexData
    const rendererTexcoordData = renderer._texcoordData

    if (this.drawMeshes.length == 0) {
      console.warn("gltfModelW: No drawMeshes")
      return
    }

    const vec4 = globalThis.glMatrix3D.vec4
    const vec2 = globalThis.glMatrix3D.vec2
    const mat2 = globalThis.glMatrix3D.mat2
    const mat4 = globalThis.glMatrix3D.mat4
    const quat = globalThis.glMatrix3D.quat
    let totalTriangles = 0

    const instanceColor = [
      instanceC3Color.getR(),
      instanceC3Color.getG(),
      instanceC3Color.getB(),
      instanceC3Color.getA(),
    ]
    const finalColor = vec4.create()

    const tmpModelView = mat4.create()
    const modelRotate = mat4.create()
    if (!this.inst.isEditor) {
      mat4.copy(tmpModelView, renderer._matMV)
      const xAngle = this.inst.xAngle
      const yAngle = this.inst.yAngle
      const zAngle = this.inst.zAngle
      const xScale = this.inst.scale / (this.inst.xScale == 0 ? 1 : this.inst.xScale)
      const yScale = this.inst.scale / (this.inst.yScale == 0 ? 1 : this.inst.yScale)
      const zScale = this.inst.scale / (this.inst.zScale == 0 ? 1 : this.inst.zScale)
      const rotate = quat.create()
      quat.fromEuler(rotate, xAngle, yAngle, zAngle)
      mat4.fromRotationTranslationScale(modelRotate, rotate, [x, y, z], [xScale, -yScale, zScale])
      mat4.copy(this.modelRotate, modelRotate)
      mat4.multiply(modelRotate, tmpModelView, modelRotate)
      renderer.SetModelViewMatrix(modelRotate)
      this._glCall(renderer, this.setVertexShaderModelRotate, this.modelRotate)
    }

    // Default color
    vec4.copy(currentColor, instanceColor)
    let baseColorChanged = false
    if (!vec4.equals(currentColor, [1, 1, 1, 1])) baseColorChanged = true

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
    if (!this.inst.isEditor) {
      renderer.SetModelViewMatrix(tmpModelView)
    }
    this.inst.totalTriangles = totalTriangles
    // Restore renderer buffers
    renderer._vertexData = rendererVertexData
    renderer._texcoordData = rendererTexcoordData

    if (!this.inst.isEditor) {
      if (this._useDeferred(renderer)) {
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
  applyPose(out, base) {
    if (!this._ensurePoseBuffers()) return
    const layout = this._poseLayout
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
    this._poseIndex = index
    this._poseTime = time
    this._poseDelta = deltaTime
    this._poseDirty = true
    // Blending is stateful (it snapshots the previous pose every frame), so a
    // blending model has to be sampled every frame to stay correct. Without
    // blending the pose is only needed when something asks for a node.
    if (this.inst.animationBlend != 0) this.ensureMainThreadPose()
  }

  /** Bring the main-thread node transforms up to date with the current time. */
  ensureMainThreadPose() {
    if (!this._poseDirty || !this._mainSampler) return
    this._poseDirty = false
    const anim = this.gltfData.animations[this._poseIndex]
    if (!anim) return
    AnimSampler.sampleAnimation(
      this._mainSampler,
      AnimSampler.prepareAnimation(anim, this._nodeIndexOf),
      this._poseIndex,
      this._poseTime,
      this._poseDelta,
      this.inst.animationBlend,
      this.inst.animationLoop,
      this._trs
    )
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
    const rotate = quat.create()
    quat.fromEuler(rotate, xAngle, yAngle, zAngle)
    mat4.fromRotationTranslationScale(this.modelRotate, rotate, [x, y, z], [xScale, -yScale, zScale])
  }

}

// @ts-ignore
if (!globalThis.GltfModelW) {
  // @ts-ignore
  globalThis.GltfModelW = GltfModelWTop
}
