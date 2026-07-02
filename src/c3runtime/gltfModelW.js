// @ts-check
"use strict"
// @ts-ignore
const BoneBufferW = globalThis.BoneBuffer
// @ts-ignore
const ObjectBufferW = globalThis.ObjectBuffer

// One animation worker shared by all instances of an object type (used when GPU
// skinning is known at creation time). Owns the message port and dispatches worker
// replies to the registered GltfModelW instances by instance id.
class GltfWorkerHostTop {
  constructor() {
    this.msgPort = null
    this.instances = new Map()
    this.portPromise = null
    this.gltfSent = false
    this.attributesSent = false
    this.released = false
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
          const model = this.instances.get(e.data ? e.data.iid : undefined)
          if (model) model.onWorkerMessage(e)
        }
        return port
      })()
    }
    return this.portPromise
  }

  add(iid, model) {
    this.instances.set(iid, model)
  }

  remove(iid) {
    this.instances.delete(iid)
    if (this.msgPort) this.msgPort.postMessage({ type: "removeInstance", iid })
  }

  release() {
    this.released = true
    if (this.msgPort) {
      this.msgPort.postMessage({ type: "release" })
      this.msgPort.onmessage = null
      this.msgPort.close()
      this.msgPort = null
    }
    this.instances.clear()
  }
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

  createBoneBufferViews() {
    // Iterate through all nodes
    const MATRIX_SIZE = 16
    const boneBufferViews = this.boneBufferViews
    let bufferIndex = 0
    // Unskinned nodes with mesh
    for (let node of this.gltfData.nodes) {
      // Check if the node has a mesh and is not a skinned mesh
      if (node.mesh && !node.skin) {
        // Set the bufferView start to the current bufferCounter index
        boneBufferViews.push({ start: bufferIndex, length: MATRIX_SIZE })
        bufferIndex += MATRIX_SIZE
      }
    }
    // Iterate through all skinned nodes
    for (let skinnedNode of this.gltfData.skinnedNodes) {
      // Create a bufferView for each skinned node
      // Add additional matrix for rootNodeXform matrix
      boneBufferViews.push({ start: bufferIndex, length: (skinnedNode.skin.joints.length + 1) * MATRIX_SIZE })
      bufferIndex += (skinnedNode.skin.joints.length + 1) * MATRIX_SIZE
    }
  }

  copyGltfData(sourceGltf) {
    // Per-instance view: mutable scene-graph state cloned, heavy immutable data shared
    if (globalThis.GltfData && typeof globalThis.GltfData.cloneInstanceView === "function") {
      return globalThis.GltfData.cloneInstanceView(sourceGltf)
    }
    return structuredClone(sourceGltf)
  }

  async init() {
    this.gltfData = this.copyGltfData(this._sdkType.gltfData.gltf)
    await new Promise((resolve) => setTimeout(resolve, 66)) // Allow time for texture initialization
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
    this.createBoneBufferViews()
    await this.createWorker(this._runtime)
    if (this.released) return
    this.workerReady = true
    this.getPolygons(this.inst.gpuSkinning)
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
        if (node.offsetUV) this.drawMeshes[this.drawMeshesIndex].offsetUV = node.offsetUV
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

        // Attribute data is immutable and shared across instances; only copy when a
        // type conversion is actually needed
        const sharedOrCopy = (data, Type) => (data instanceof Type ? data : new Type(data))
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

  onWorkerMessage(e) {
    if (!e.data.type) {
      this.activeNodes = e.data.activeNodes
      const gpuSkinning = this.inst.gpuSkinning
      if (!gpuSkinning) {
        this.buff = e.data.buff
        this.verts = new Float32Array(this.buff)
        this.setBBFromVerts(this.verts, this.inst.minBB, this.inst.maxBB)
        this.inst.updateBbox = true
        this.updateDrawVerts = true
        this.typedVertsToDrawVerts(this.inst.staticGeometry)
      } else {
        this.buff = e.data.buff
        this.buffBones = e.data.buffBones
        this.bones = new Float32Array(this.buffBones)
        // this.setBBFromVerts(this.verts, this.inst.minBB, this.inst.maxBB)
        const x = this.inst.isEditor ? this.inst._inst.GetX() : this.inst.GetWorldInfo().GetX()
        const y = this.inst.isEditor ? this.inst._inst.GetY() : this.inst.GetWorldInfo().GetY()
        const z = this.inst.isEditor ? this.inst._inst.GetZElevation() : this.inst.GetWorldInfo().GetZElevation()
        this.inst.minBB = [-10000 + x, -10000 + y, -10000 + z]
        this.inst.maxBB = [10000 + x, 10000 + y, 10000 + z]
        this.inst.updateBbox = true
        this.updateDrawVerts = true
        this.typedBonesToDrawBones()
      }
      this.workerReady = true
      if (!this.boundingBoxInit) {
        this.inst.initBoundingBox()
        this.boundingBoxInit = true
      }
    } else if (e.data.type === "status") {
      this.buff = e.data.buff
      if (e.data?.status?.workerReady) {
        this.workerReady = true
      }
    } else if (e.data.type === "needAttributes") {
      // Worker was created without vertex data (GPU skinning) but a CPU-skinning
      // request arrived; send the attribute data once and retry next tick
      this.buff = e.data.buff
      this.workerReady = true
      this.sendAttributesToWorker()
    } else {
      if (this.inst.debug) console.debug("onMsg t:", this._runtime.GetTickCount(), e.data.type)
    }
  }

  _computeBuffLengths() {
    const bufferViews = this.drawMeshes[this.drawMeshes.length - 1].bufferViews
    const buffLength = bufferViews[bufferViews.length - 1].start + bufferViews[bufferViews.length - 1].length
    const buffBonesLength =
      this.boneBufferViews[this.boneBufferViews.length - 1].start +
      this.boneBufferViews[this.boneBufferViews.length - 1].length
    return { buffLength, buffBonesLength }
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
    // With GPU skinning known at creation time the worker only computes bone
    // matrices, so all instances of the type share one worker (and one copy of the
    // model data). Otherwise each instance gets a dedicated worker so CPU vertex
    // skinning still runs in parallel across instances (original behavior).
    this.useSharedWorker = !this.inst.instanceModel && !!this.inst.gpuSkinning
    if (this.useSharedWorker) {
      const sdkType = this._sdkType
      if (!sdkType.animWorkerHost) sdkType.animWorkerHost = new GltfWorkerHostTop()
      const host = sdkType.animWorkerHost
      const port = await host.getPort(runtime)
      if (this.released || !port) return null
      this._workerHost = host
      this._iid = this.inst.uid
      this.msgPort = port // shared port: release() must not close it
      host.add(this._iid, this)
      const { buffLength, buffBonesLength } = this._computeBuffLengths()
      this.buff = new ArrayBuffer((buffLength + 7) * 4)
      if (!host.gltfSent) {
        host.gltfSent = true
        host.attributesSent = false // GPU skinning: length stubs only
        port.postMessage({
          type: "gltf",
          shared: true,
          gltf: this.buildWorkerPayload(false),
          buffLength: buffLength,
          drawMeshes: this._slimDrawMeshes(),
          buffBonesLength,
        })
      }
      port.postMessage({ type: "addInstance", iid: this._iid })
      return { msgPort: port }
    }

    // Dedicated worker per instance.
    // Create the worker with the runtime.createWorker() method.
    // This must be awaited and resolves with a messagePort.
    let path = await runtime.GetAssetManager().GetProjectFileUrl("gltfWorker.js")
    if (this.released) return null
    this.msgPort = await runtime._iRuntime.createWorker(path)
    if (this.released) {
      // Instance was destroyed while the worker was being created; tell it to close
      this.msgPort.postMessage({ type: "release" })
      this.msgPort.close()
      this.msgPort = null
      return null
    }
    this.msgPort.onmessage = (e) => this.onWorkerMessage(e)
    // Send the gltfModel to the worker
    const { buffLength, buffBonesLength } = this._computeBuffLengths()
    this.buff = new ArrayBuffer((buffLength + 7) * 4)
    // With GPU skinning the worker only computes bone matrices, so vertex attribute
    // data is left out of the payload (stubs carry lengths for its bookkeeping).
    // If the instance later switches to CPU skinning, the worker requests the
    // attribute data via a "needAttributes" message.
    const includeAttributes = !this.inst.gpuSkinning
    this._attributesSentToWorker = includeAttributes
    this.msgPort.postMessage({
      type: "gltf",
      gltf: this.buildWorkerPayload(includeAttributes),
      buffLength: buffLength,
      drawMeshes: this._slimDrawMeshes(),
      buffBonesLength,
    })
    return { msgPort: this.msgPort }
  }

  // Builds the minimal object graph the animation worker needs: node/skin/animation
  // state always; vertex attributes (positions, weights, joints, morph targets) only
  // when the worker will do CPU skinning. Keyframe data is always required.
  buildWorkerPayload(includeAttributes) {
    const src = this.gltfData
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
    this.msgPort.postMessage({ type: "enableNode", nodeName: nodeName, enable: enable, iid: this._iid })
  }

  setNodeMorphWeight(nodeName, index, weight) {
    this.msgPort.postMessage({ type: "setNodeMorphWeight", nodeName, index, weight, iid: this._iid })
  }

  deleteNodeMorphWeight(nodeName, index) {
    this.msgPort.postMessage({ type: "deleteNodeMorphWeight", nodeName, index, iid: this._iid })
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

  setVertexShaderModelRotate(renderer, modelRotate) {
    const gl = renderer._gl
    const batchState = renderer._batchState
    const shaderProgram = batchState.currentShader._shaderProgram

    this.locUModelRotate = globalThis.uniformCache.getLocation(gl, shaderProgram, "uModelRotate")
    this.locUModelRotateEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uModelRotateEnable")
    this.locUPhongEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uPhongEnable")

    gl.uniformMatrix4fv(this.locUModelRotate, false, modelRotate)
    gl.uniform1f(this.locUModelRotateEnable, 1)
    gl.uniform1f(this.locUPhongEnable, 0)
  }

  disableVertexShaderModelRotate(renderer) {
    const gl = renderer._gl
    const batchState = renderer._batchState
    const shaderProgram = batchState.currentShader._shaderProgram

    this.locUModelRotateEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uModelRotateEnable")
    this.locUPhongEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uPhongEnable")

    gl.uniform1f(this.locUModelRotateEnable, 0)
    gl.uniform1f(this.locUPhongEnable, 0)
  }

  _disableGPUSkinning(renderer) {
    const gl = renderer._gl
    const shaderProgram = renderer._batchState.currentShader._shaderProgram

    this.locUSkinEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uSkinEnable")
    this.locUNodeXformEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uNodeXformEnable")

    gl.uniform1f(this.locUSkinEnable, 0.0)
    gl.uniform1f(this.locUNodeXformEnable, 0.0)
  }

  _resetColorUniforms(renderer) {
    const gl = renderer._gl
    const shaderProgram = renderer._batchState.currentShader._shaderProgram

    // Reset color uniforms for subsequent non-3D objects
    const locUseUniformColor = globalThis.uniformCache.getLocation(gl, shaderProgram, "uUseUniformColor")
    const locObjectColor = globalThis.uniformCache.getLocation(gl, shaderProgram, "uObjectColor")
    const locHasVertexColors = globalThis.uniformCache.getLocation(gl, shaderProgram, "uHasVertexColors")

    if (locUseUniformColor) gl.uniform1f(locUseUniformColor, 0.0)
    if (locObjectColor) gl.uniform4f(locObjectColor, 1.0, 1.0, 1.0, 1.0)
    if (locHasVertexColors) gl.uniform1f(locHasVertexColors, 1.0) // Reset to C3 default (use vertex colors)
  }

  render(renderer, x, y, z, tempQuad, whiteTexture, instanceC3Color, textures, instanceTexture, opacity) {
    if (opacity === 0) return
    renderer.EndBatch()
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
    const vertexScale = this.inst.vertexScale
    let totalTriangles = 0

    let xWireframeWidth, yWireframeWidth, zWireframeWidth

    if (this.inst.wireframe) {
      const xScale = this.inst.scale / (this.inst.xScale == 0 ? 1 : this.inst.xScale)
      const yScale = this.inst.scale / (this.inst.yScale == 0 ? 1 : this.inst.yScale)
      const zScale = this.inst.scale / (this.inst.zScale == 0 ? 1 : this.inst.zScale)

      xWireframeWidth = this.inst.isEditor ? this.inst.xWireframeWidth : this.inst.xWireframeWidth / xScale
      yWireframeWidth = this.inst.isEditor ? this.inst.yWireframeWidth : this.inst.yWireframeWidth / yScale
      zWireframeWidth = this.inst.isEditor ? this.inst.zWireframeWidth : this.inst.zWireframeWidth / zScale
    }

    const instanceColor = [
      instanceC3Color.getR(),
      instanceC3Color.getG(),
      instanceC3Color.getB(),
      instanceC3Color.getA(),
    ]
    const finalColor = vec4.create()

    const tmpModelView = mat4.create()
    const modelRotate = mat4.create()
    if (!(this.inst.isEditor || this.inst.cpuXform)) {
      mat4.copy(tmpModelView, renderer._matMV)
      const xAngle = this.inst.xAngle
      const yAngle = this.inst.yAngle
      const zAngle = this.inst.zAngle
      const xScale = this.inst.scale / (this.inst.xScale == 0 ? 1 : this.inst.xScale)
      const yScale = this.inst.scale / (this.inst.yScale == 0 ? 1 : this.inst.yScale)
      const zScale = this.inst.scale / (this.inst.zScale == 0 ? 1 : this.inst.zScale)
      const rotate = quat.create()
      if (this.inst.cannonBody && this.inst.cannonSetRotation) {
        quat.set(
          rotate,
          this.inst.cannonBody.quaternion.x,
          this.inst.cannonBody.quaternion.y,
          this.inst.cannonBody.quaternion.z,
          this.inst.cannonBody.quaternion.w
        )
      } else if (this.inst.enableQuaternion) {
        quat.copy(rotate, this.inst.quaternion)
      } else {
        quat.fromEuler(rotate, xAngle, yAngle, zAngle)
      }
      mat4.fromRotationTranslationScale(modelRotate, rotate, [x, y, z], [xScale, -yScale, zScale])
      mat4.copy(this.modelRotate, modelRotate)
      mat4.multiply(modelRotate, tmpModelView, modelRotate)
      renderer.SetModelViewMatrix(modelRotate)
      this.setVertexShaderModelRotate(renderer, this.modelRotate)
    }

    // Default color
    vec4.copy(currentColor, instanceColor)
    let baseColorChanged = false
    if (!vec4.equals(currentColor, [1, 1, 1, 1])) baseColorChanged = true

    if (this.updateDrawVerts) {
      this.updateDrawVerts = false
    }
    if (this.inst.staticGeometry) {
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
      const offsetUV = this.drawMeshes[j].offsetUV
      const materialsModify = this.inst.materialsModify
      const offsetMaterial = materialsModify.has(material?.name) && materialsModify.get(material?.name)?.offsetUV
      const rotateMaterial = materialsModify.has(material?.name) && materialsModify.get(material?.name)?.rotateUV

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

      if (!instanceTexture) {
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

      let rotateMatrix

      if (rotateMaterial) {
        const rotateUV = materialsModify.get(material.name)?.rotateUV
        // Create rotate matrix
        rotateMatrix = mat2.create()
        mat2.fromRotation(rotateMatrix, rotateUV.angle)
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
            rotateMaterial,
            offsetMaterial,
            false, // phong lighting removed
            currentColor // Pass calculated color to draw method
          )
          totalTriangles += objectBuffers[i].indexDataLength / 3
        }
        // XXX Perhaps too often, once per mesh, better to do once per model
        if (boneBuffer) {
          boneBuffer.disable(renderer)
        }
        continue
      }

      for (let ii = 0; ii < drawVerts.length; ii++) {
        let v = xVerts[ii]
        let uv = drawUVs[ii]
        let ind = drawIndices[ii]

        let triangleCount = ind.length / 3
        let center = [0, 0, 0]
        totalTriangles += triangleCount
        for (let i = 0; i < triangleCount; i++) {
          if (hasTexture) {
            if (offsetMaterial || rotateMaterial) {
              // create new arrays for the UVs
              const uvQuad = [
                [uv[ind[i * 3 + 0] * 2 + 0], uv[ind[i * 3 + 0] * 2 + 1]],
                [uv[ind[i * 3 + 1] * 2 + 0], uv[ind[i * 3 + 1] * 2 + 1]],
                [uv[ind[i * 3 + 2] * 2 + 0], uv[ind[i * 3 + 2] * 2 + 1]],
              ]
              if (rotateMaterial) {
                // Rotate UVs
                vec2.sub(uvQuad[0], uvQuad[0], [rotateMaterial.x, rotateMaterial.y])
                vec2.sub(uvQuad[1], uvQuad[1], [rotateMaterial.x, rotateMaterial.y])
                vec2.sub(uvQuad[2], uvQuad[2], [rotateMaterial.x, rotateMaterial.y])
                mat2.multiply(uvQuad[0], rotateMatrix, uvQuad[0])
                mat2.multiply(uvQuad[1], rotateMatrix, uvQuad[1])
                mat2.multiply(uvQuad[2], rotateMatrix, uvQuad[2])
                vec2.add(uvQuad[0], uvQuad[0], [rotateMaterial.x, rotateMaterial.y])
                vec2.add(uvQuad[1], uvQuad[1], [rotateMaterial.x, rotateMaterial.y])
                vec2.add(uvQuad[2], uvQuad[2], [rotateMaterial.x, rotateMaterial.y])
              }

              if (offsetMaterial) {
                const uOffset = offsetMaterial.u
                const vOffset = offsetMaterial.v
                // Offset UVs in uvQuad
                uvQuad[0][0] += uOffset
                uvQuad[0][1] += vOffset
                uvQuad[1][0] += uOffset
                uvQuad[1][1] += vOffset
                uvQuad[2][0] += uOffset
                uvQuad[2][1] += vOffset
              }
              // Set tempquad
              tempQuad.set(
                uvQuad[0][0],
                uvQuad[0][1],
                uvQuad[1][0],
                uvQuad[1][1],
                uvQuad[2][0],
                uvQuad[2][1],
                uvQuad[2][0],
                uvQuad[2][1]
              )
            } else if (offsetUV) {
              const uOffset = offsetUV.u
              const vOffset = offsetUV.v
              tempQuad.set(
                uv[ind[i * 3 + 0] * 2 + 0] + uOffset,
                uv[ind[i * 3 + 0] * 2 + 1] + vOffset,
                uv[ind[i * 3 + 1] * 2 + 0] + uOffset,
                uv[ind[i * 3 + 1] * 2 + 1] + vOffset,
                uv[ind[i * 3 + 2] * 2 + 0] + uOffset,
                uv[ind[i * 3 + 2] * 2 + 1] + vOffset,
                uv[ind[i * 3 + 2] * 2 + 0] + uOffset,
                uv[ind[i * 3 + 2] * 2 + 1] + vOffset
              )
            } else {
              tempQuad.set(
                uv[ind[i * 3 + 0] * 2 + 0],
                uv[ind[i * 3 + 0] * 2 + 1],
                uv[ind[i * 3 + 1] * 2 + 0],
                uv[ind[i * 3 + 1] * 2 + 1],
                uv[ind[i * 3 + 2] * 2 + 0],
                uv[ind[i * 3 + 2] * 2 + 1],
                uv[ind[i * 3 + 2] * 2 + 0],
                uv[ind[i * 3 + 2] * 2 + 1]
              )
            }
          } else {
            // Set face to color if possible
            tempQuad.set(0, 0, 1, 0, 0, 1, 0, 1)
          }

          let i3 = i * 3
          let x0, y0, z0, x1, y1, z1, x2, y2, z2

          x0 = v[ind[i3 + 0] * 3 + 0]
          y0 = v[ind[i3 + 0] * 3 + 1]
          z0 = v[ind[i3 + 0] * 3 + 2] - z
          x1 = v[ind[i3 + 1] * 3 + 0]
          y1 = v[ind[i3 + 1] * 3 + 1]
          z1 = v[ind[i3 + 1] * 3 + 2] - z
          x2 = v[ind[i3 + 2] * 3 + 0]
          y2 = v[ind[i3 + 2] * 3 + 1]
          z2 = v[ind[i3 + 2] * 3 + 2] - z

          if (vertexScale != 0) {
            const xScale = (this.inst.scale / (this.inst.xScale == 0 ? 1 : this.inst.xScale)) * vertexScale
            const yScale = (this.inst.scale / (this.inst.yScale == 0 ? 1 : this.inst.yScale)) * vertexScale
            const zScale = (this.inst.scale / (this.inst.zScale == 0 ? 1 : this.inst.zScale)) * vertexScale
            x0 = Math.round(x0 * xScale) / xScale
            y0 = Math.round(y0 * xScale) / yScale
            z0 = Math.round(z0 * xScale) / zScale
            x1 = Math.round(x1 * xScale) / xScale
            y1 = Math.round(y1 * xScale) / yScale
            z1 = Math.round(z1 * xScale) / zScale
            x2 = Math.round(x2 * xScale) / xScale
            y2 = Math.round(y2 * xScale) / yScale
            z2 = Math.round(z2 * xScale) / zScale
          }

          if (this.inst.wireframe) {
            this.drawWireFrame(
              renderer,
              whiteTexture,
              tempQuad,
              x0,
              y0,
              z0,
              x1,
              y1,
              z1,
              x2,
              y2,
              z2,
              xWireframeWidth,
              yWireframeWidth,
              zWireframeWidth
            )
          } else {
            renderer.Quad3D2(x0, y0, z0, x1, y1, z1, x2, y2, z2, x2, y2, z2, tempQuad)
          }
        }
      }
    }

    // Restore modelview matrix
    if (!(this.inst.isEditor || this.inst.cpuXform)) {
      renderer.SetModelViewMatrix(tmpModelView)
    }
    this.inst.totalTriangles = totalTriangles
    // Restore renderer buffers
    renderer._vertexData = rendererVertexData
    renderer._texcoordData = rendererTexcoordData

    if (!this.inst.isEditor) {
      renderer.EndBatch()
      this.disableVertexShaderModelRotate(renderer)
      this._disableGPUSkinning(renderer)
      this._resetColorUniforms(renderer)
    }
    // Restore attrib
    if (this.inst.staticGeometry) {
      // Restore for other C3 objects
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
      // Restore index buffer
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer._indexBuffer)
      renderer._vertexPtr = 0
      renderer._texPtr = 0
    }
  }

  typedBonesToDrawBones() {
    // Iterate through all nodes
    const MATRIX_SIZE = 16
    const boneBufferViews = this.boneBufferViews
    let bufferViewIndex = 0
    // Unskinned nodes with mesh
    const bones = this.bones
    const modelAssetBoneCount = this._sdkType.gltfData ? this._sdkType.gltfData.bonesPerModelAsset : 0

    for (let node of this.gltfData.nodes) {
      // Check if the node has a mesh and is not a skinned mesh
      if (node.mesh && !node.skin) {
        if (!node.hasOwnProperty("boneBuffer")) {
          const actualBonesForThisNode = 0 // Non-skinned nodes don't use skinning bone arrays
          const boneBuffer = new BoneBufferW(this.inst.renderer, actualBonesForThisNode, false)
          node.boneBuffer = boneBuffer
        }
        const start = boneBufferViews[bufferViewIndex].start
        // BoneBuffer setters copy into their own arrays, so views are safe here
        node.boneBuffer.setNodeXform(bones.subarray(start, start + MATRIX_SIZE))
        bufferViewIndex += 1
      }
    }

    // Iterate through all skinned nodes
    for (let skinnedNode of this.gltfData.skinnedNodes) {
      if (!skinnedNode.hasOwnProperty("boneBuffer")) {
        // For skinned nodes, use the modelAssetBoneCount
        const boneBuffer = new BoneBufferW(this.inst.renderer, modelAssetBoneCount, true)
        skinnedNode.boneBuffer = boneBuffer
      }
      const length = boneBufferViews[bufferViewIndex].length
      const start = boneBufferViews[bufferViewIndex].start
      // The data from worker (this.bones) via buffBones might be structured differently.
      // It seems to be a flat array of matrices.
      // bones.slice(start, start + length - MATRIX_SIZE) is for bone matrices
      // bones.slice(start + length - MATRIX_SIZE, start + length) is for rootNodeXform
      skinnedNode.boneBuffer.setBones(bones.subarray(start, start + length - MATRIX_SIZE))
      skinnedNode.boneBuffer.setRootNodeXform(bones.subarray(start + length - MATRIX_SIZE, start + length))
      bufferViewIndex += 1
    }
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
            objectBuffers.push(new ObjectBufferW(this.inst.renderer, this.drawMeshes[j], 0))
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
        if (node.offsetUV) this.drawMeshes[this.drawMeshesIndex].offsetUV = node.offsetUV
        // Update material each time, in case an ACE changes it
        if ("material" in node.mesh.primitives[i]) {
          this.drawMeshes[this.drawMeshesIndex].material = node.mesh.primitives[i].material
        } else {
          this.drawMeshes[this.drawMeshesIndex].material = null
        }
        if (gpuSkinning) {
          const objectBuffers = this.drawMeshes[this.drawMeshesIndex].objectBuffers
          if (objectBuffers.length === 0)
            objectBuffers.push(
              new ObjectBufferW(this.inst.renderer, this.drawMeshes[this.drawMeshesIndex], 0, gpuSkinning)
            )
        }
      }
    }
    if (node.children != undefined)
      for (let i = 0; i < node.children.length; i++) this.transformNode(node.children[i], staticGeometry, gpuSkinning)
  }

  getPolygons(staticGeometry) {
    if (!this.workerReady) return
    const editorData = this.getPolygonsPrep(staticGeometry, this.inst.gpuSkinning)
    const data = { editorData }
    this.workerReady = false
    // Return the bones buffer to the worker so it can be reused (ping-pong like buff)
    const buffBones = this.buffBones && this.buffBones.byteLength > 0 ? this.buffBones : null
    if (buffBones) {
      this.buffBones = null
      this.bones = null
    }
    this.msgPort.postMessage(
      { type: "getPolygons", data: data, buff: this.buff, buffBones, iid: this._iid },
      buffBones ? [this.buff, buffBones] : [this.buff]
    )
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
        if (node.offsetUV) this.drawMeshes[this.drawMeshesIndex].offsetUV = node.offsetUV
        // Update material each time, in case an ACE changes it
        if ("material" in node.mesh.primitives[i]) {
          this.drawMeshes[this.drawMeshesIndex].material = node.mesh.primitives[i].material
        } else {
          this.drawMeshes[this.drawMeshesIndex].material = null
        }
        if (gpuSkinning) {
          const objectBuffers = this.drawMeshes[this.drawMeshesIndex].objectBuffers
          if (objectBuffers.length === 0)
            objectBuffers.push(
              new ObjectBufferW(this.inst.renderer, this.drawMeshes[this.drawMeshesIndex], 0, gpuSkinning)
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

  // Get world position of a node by name
  // Works for any node in the scene (mesh nodes, empty transforms, etc.)
  getNodeWorldPosition(nodeName) {
    const vec3 = globalThis.glMatrix3D.vec3
    const gltf = this.gltfData
    if (!gltf) return null

    // Search in all nodes
    let node = null
    if (gltf.nodes) {
      for (const n of gltf.nodes) {
        if (n.name === nodeName) {
          node = n
          break
        }
      }
    }

    // Also check skinned nodes
    if (!node && gltf.skinnedNodes) {
      for (const n of gltf.skinnedNodes) {
        if (n.name === nodeName) {
          node = n
          break
        }
      }
    }

    if (!node || !node.matrix) {
      return null
    }

    // Extract translation from the node's matrix (columns 12, 13, 14)
    const localPos = vec3.fromValues(node.matrix[12], node.matrix[13], node.matrix[14])

    // Transform by the instance's modelRotate to get world position
    const worldPos = vec3.create()
    vec3.transformMat4(worldPos, localPos, this.modelRotate)

    return [worldPos[0], worldPos[1], worldPos[2]]
  }

  // Get world position of a bone/joint by name
  // Bones are specifically the joints used for skeletal animation
  getBoneWorldPosition(boneName) {
    const vec3 = globalThis.glMatrix3D.vec3
    const mat4 = globalThis.glMatrix3D.mat4
    const quat = globalThis.glMatrix3D.quat
    const gltf = this.gltfData
    if (!gltf) return null

    // Build a parent map for all nodes
    const parentMap = new Map()
    const buildParentMap = (nodes, parent) => {
      if (!nodes) return
      for (const node of nodes) {
        if (parent) parentMap.set(node, parent)
        if (node.children) buildParentMap(node.children, node)
      }
    }
    if (gltf.scene && gltf.scene.nodes) {
      buildParentMap(gltf.scene.nodes, null)
    }

    // Find the joint by name
    let targetJoint = null
    if (gltf.skinnedNodes) {
      for (const skinnedNode of gltf.skinnedNodes) {
        if (!skinnedNode.skin || !skinnedNode.skin.joints) continue
        for (const joint of skinnedNode.skin.joints) {
          if (joint.name === boneName) {
            targetJoint = joint
            break
          }
        }
        if (targetJoint) break
      }
    }

    if (!targetJoint) return null

    // Build the path from root to joint
    const path = []
    let current = targetJoint
    while (current) {
      path.unshift(current)
      current = parentMap.get(current)
    }

    // Calculate world matrix by multiplying transforms along the path
    const worldMatrix = mat4.create()
    mat4.identity(worldMatrix)

    for (const node of path) {
      const localMatrix = mat4.create()
      const translation = node.translation || [0, 0, 0]
      const rotation = node.rotation || [0, 0, 0, 1]
      const scale = node.scale || [1, 1, 1]

      mat4.fromRotationTranslationScale(localMatrix, rotation, translation, scale)
      mat4.multiply(worldMatrix, worldMatrix, localMatrix)
    }

    // Extract world position and transform by modelRotate
    const localPos = vec3.fromValues(worldMatrix[12], worldMatrix[13], worldMatrix[14])
    const worldPos = vec3.create()
    vec3.transformMat4(worldPos, localPos, this.modelRotate)

    return [worldPos[0], worldPos[1], worldPos[2]]
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

  drawWireFrame(renderer, whiteTexture, tempQuad, x0, y0, z0, x1, y1, z1, x2, y2, z2, xWidth, yWidth, zWidth) {
    renderer.SetTexture(whiteTexture)
    tempQuad.set(0, 0, 1, 0, 0, 1, 0, 1)

    renderer.Quad3D2(
      x0,
      y0,
      z0,
      x0 + xWidth,
      y0 + yWidth,
      z0 + zWidth,
      x1,
      y1,
      z1,
      x1 + xWidth,
      y1 + yWidth,
      z1 + zWidth,
      tempQuad
    )
    renderer.Quad3D2(
      x1,
      y1,
      z1,
      x1 + xWidth,
      y1 + yWidth,
      z1 + zWidth,
      x2,
      y2,
      z2,
      x2 + xWidth,
      y2 + yWidth,
      z2 + zWidth,
      tempQuad
    )
    renderer.Quad3D2(
      x2,
      y2,
      z2,
      x2 + xWidth,
      y2 + yWidth,
      z2 + zWidth,
      x0,
      y0,
      z0,
      x0 + xWidth,
      y0 + yWidth,
      z0 + zWidth,
      tempQuad
    )
  }

  updateAnimationPolygons(index, time, onScreen, deltaTime, staticGeometry, gpuSkinning = false) {
    if (!this.workerReady) return
    this.workerReady = false
    this.updateAnimation(index, time, onScreen, deltaTime)
    this.inst.updateBbox = true

    const animationBlend = this.inst.animationBlend
    const animationLoop = this.inst.animationLoop
    let animationData = { index, time, onScreen, deltaTime, animationBlend, animationLoop }
    let editorData = {}
    if (onScreen) {
      editorData = this.getPolygonsPrep(staticGeometry, gpuSkinning)
      this.inst.runtime.UpdateRender()
    }
    const data = { animationData, editorData }
    // Return the bones buffer to the worker so it can be reused (ping-pong like buff)
    const buffBones = this.buffBones && this.buffBones.byteLength > 0 ? this.buffBones : null
    if (buffBones) {
      this.buffBones = null
      this.bones = null
    }
    this.msgPort.postMessage(
      { type: "updateAnimationPolygons", data: data, buff: this.buff, buffBones, iid: this._iid },
      buffBones ? [this.buff, buffBones] : [this.buff]
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
    if (this.inst.cannonBody && this.inst.cannonSetRotation) {
      quat.set(
        rotate,
        this.inst.cannonBody.quaternion.x,
        this.inst.cannonBody.quaternion.y,
        this.inst.cannonBody.quaternion.z,
        this.inst.cannonBody.quaternion.w
      )
    } else if (this.inst.enableQuaternion) {
      quat.copy(rotate, this.inst.quaternion)
    } else {
      quat.fromEuler(rotate, xAngle, yAngle, zAngle)
    }
    mat4.fromRotationTranslationScale(this.modelRotate, rotate, [x, y, z], [xScale, -yScale, zScale])
  }

  lerp(a, b, alpha) {
    return a + alpha * (b - a)
  }

  // Updates animation at index to be at time.  Is used to play animation.
  // Also updates node transforms so getBoneWorldPosition works correctly.
  updateAnimation(index, time, onScreen, deltaTime) {
    const vec3 = globalThis.glMatrix3D.vec3
    const quat = globalThis.glMatrix3D.quat
    const gltf = this.gltfData
    const animationBlend = this.inst.animationBlend
    let anim = gltf.animations[index]

    // Blend state machine
    switch (this._blendState) {
      case "init":
        if (animationBlend != 0 && this._lastIndex != index) {
          this._blendState = "blend"
          this._blendTime = 0
          this._blendTarget = this._lastTarget[this._lastTargetIndex]
          if (this._lastTargetIndex == 0) {
            this._lastTargetIndex = 1
          } else {
            this._lastTargetIndex = 0
          }
          this._lastIndex = index
        }
        break
      case "blend":
        if (this._lastIndex != index) {
          this._blendState = "blend"
          this._blendTime = 0
          this._blendTarget = this._lastTarget[this._lastTargetIndex]
          if (this._lastTargetIndex == 0) {
            this._lastTargetIndex = 1
          } else {
            this._lastTargetIndex = 0
          }
          this._lastIndex = index
          break
        }
        if (this._blendTime > animationBlend) {
          this._blendState = "idle"
          break
        }
        this._blendTime += deltaTime
        break
      case "idle":
        if (this._lastIndex != index) {
          this._blendState = "blend"
          this._blendTime = 0
          this._blendTarget = this._lastTarget[this._lastTargetIndex]
          if (this._lastTargetIndex == 0) {
            this._lastTargetIndex = 1
          } else {
            this._lastTargetIndex = 0
          }
          this._lastIndex = index
        }
        break
      default:
        console.warn("[3DObject] bad blend state:", this._blendState)
    }

    this._lastTarget[this._lastTargetIndex] = []

    for (let i = 0; i < anim.channels.length; i++) {
      let c = anim.channels[i]
      let timeValues = c.sampler.input
      let otherValues = c.sampler.output.data
      let target = c.target

      if (timeValues.max[0] == timeValues.min[0]) {
        continue
      }

      if (this.inst.animationLoop) {
        time = ((time - timeValues.min[0]) % (timeValues.max[0] - timeValues.min[0])) + timeValues.min[0] // loop
      } else {
        if (time > timeValues.max[0]) {
          time = timeValues.max[0] - 0.01 // Stop on max time
          if (!this.inst.animationFinished) {
            this.inst.animationFinished = true
            this.inst.animationNameFinished = this.inst.animationName
            // @ts-ignore
            this.inst.Trigger(self.C3.Plugins.Mikal_3DObject.Cnds.OnAnimationFinished)
            // @ts-ignore
            this.inst.Trigger(self.C3.Plugins.Mikal_3DObject.Cnds.OnAnimationNameFinished)
          }
        }
      }
      this.inst.currentAnimationTime = time

      // Update node transforms for getBoneWorldPosition
      timeValues = timeValues.data

      // Find index in timeline
      let t0, t1
      for (t0 = 0, t1 = 1; t0 < timeValues.length - 1; t0++, t1++)
        if (time >= timeValues[t0] && time <= timeValues[t1]) break

      if (timeValues[t1] == null) continue

      let t = (time - timeValues[t0]) / (timeValues[t1] - timeValues[t0])

      if (target.path == "translation")
        vec3.lerp(
          target.node.translation,
          otherValues.subarray(t0 * 3, t0 * 3 + 3),
          otherValues.subarray(t1 * 3, t1 * 3 + 3),
          t
        )
      else if (target.path == "rotation")
        quat.slerp(
          target.node.rotation,
          otherValues.subarray(t0 * 4, t0 * 4 + 4),
          otherValues.subarray(t1 * 4, t1 * 4 + 4),
          t
        )
      else if (target.path == "scale")
        vec3.lerp(
          target.node.scale,
          otherValues.subarray(t0 * 3, t0 * 3 + 3),
          otherValues.subarray(t1 * 3, t1 * 3 + 3),
          t
        )
      else if (target.path == "weights") {
        const node = target.node
        if (node.mesh && node.mesh.primitives && node.mesh.primitives[0] && node.mesh.primitives[0].targets) {
          node.weights = new Float32Array(node.mesh.primitives[0].targets.length)
          const weights = node.weights
          const stride = weights.length
          for (let j = 0; j < stride; j++) {
            weights[j] = this.lerp(otherValues[t0 * stride + j], otherValues[t1 * stride + j], t)
          }
        }
      }

      // Blend to last animation if during blend
      if (this._blendState == "blend") {
        const blend = this._blendTime == 0 ? 0 : this._blendTime / animationBlend
        const blendTarget = this._blendTarget[i]
        if (blendTarget != null) {
          if (target.path == "translation" && blendTarget.path == "translation")
            vec3.lerp(target.node.translation, blendTarget.node.translation, target.node.translation, blend)
          else if (target.path == "rotation" && blendTarget.path == "rotation")
            quat.slerp(target.node.rotation, blendTarget.node.rotation, target.node.rotation, blend)
          else if (target.path == "scale" && blendTarget.path == "scale")
            vec3.lerp(target.node.scale, blendTarget.node.scale, target.node.scale, blend)
        }
      }

      // Store for next blend
      if (animationBlend != 0) {
        const lastTarget = {}
        lastTarget.node = {}
        if (target.path == "translation") {
          lastTarget.path = target.path
          lastTarget.node.translation = vec3.clone(target.node.translation)
        } else if (target.path == "rotation") {
          lastTarget.path = target.path
          lastTarget.node.rotation = quat.clone(target.node.rotation)
        } else if (target.path == "scale") {
          lastTarget.path = target.path
          lastTarget.node.scale = vec3.clone(target.node.scale)
        }
        this._lastTarget[this._lastTargetIndex].push(lastTarget)
      }
    }
  }
}

// @ts-ignore
if (!globalThis.GltfModelW) {
  // @ts-ignore
  globalThis.GltfModelW = GltfModelWTop
}
