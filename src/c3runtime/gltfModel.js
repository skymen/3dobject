// @ts-check
"use strict"

/**
 * Attribute data is immutable and shared between instances, so a conversion
 * must be memoised on the source array: ObjectBuffer.acquire keys its share
 * cache on array IDENTITY, and minting a fresh copy per instance makes every
 * instance miss the cache and allocate its own GL buffers. Indices are the
 * common case, since glTF often stores them as something other than Uint16.
 */
const convertedAttributeCache = new WeakMap()
// Untransformed min/max per POSITION accessor - model data, computed once.
const sourceBoundsCache = new WeakMap()

const IDENTITY_MAT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function isIdentityMat4(m) {
  for (let i = 0; i < 16; i++) if (m[i] !== IDENTITY_MAT4[i]) return false
  return true
}
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
const BoneBuffer = globalThis.BoneBuffer
// @ts-ignore
const ObjectBuffer = globalThis.ObjectBuffer

class GltfModelTop {
  constructor(runtime, sdkType, inst) {
    const mat4 = globalThis.glMatrix3D.mat4

    this._runtime = runtime
    this._sdkType = sdkType
    this.inst = inst
    this.gltfData = {}
    this._blendState = "init"
    this._lastTarget = new Array(2)
    this._lastTarget[0] = []
    this._lastTarget[1] = []
    this._lastTargetIndex = 0
    this._blendTarget = []
    this._blendTime = 0
    this._lastIndex = 0
    this.drawMeshes = []
    this.drawMeshesIndex = 0
    this.currentColor = [-1, -1, -1, -1]
    this.nodeMeshMap = {}
    this.modelRotate = mat4.create()
    this.normalMatrix = mat4.create()
    this.meshNames = new Map()
    this.released = false
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
    // Before the first getPolygons(), so a model that will only ever show one
    // skin never builds, animates or draws the rest of the mesh list.
    if (this.inst.startHidden) this.setAllNodesDisabled()
    this.getPolygons(this.inst.staticGeometry, this.inst.gpuSkinning)
    if (!this.inst.isEditor) this.inst.initBoundingBox()
  }

  /**
   * Mark every node disabled. Same effect as the "Disable all nodes" action,
   * but callable from init() — i.e. before the model has drawn or animated
   * once, which the action cannot be, since it can only run from an event and
   * the earliest of those is "On model loaded".
   *
   * No enableNode() call here: that is the worker handshake, and this class is
   * the non-worker path.
   */
  setAllNodesDisabled() {
    const gltf = this.gltfData
    for (const list of [gltf.skinnedNodes, gltf.nodes]) {
      if (!list) continue
      for (const node of list) node.disabled = true
    }
    this.inst.allNodesDisabled = true
  }

  release() {
    this.released = true
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
  }

  copyGltfData(sourceGltf) {
    // Per-instance view: mutable scene-graph state cloned, heavy immutable data shared
    if (globalThis.GltfData && typeof globalThis.GltfData.cloneInstanceView === "function") {
      return globalThis.GltfData.cloneInstanceView(sourceGltf)
    }
    return structuredClone(sourceGltf)
  }

  /**
   * True when raw GL work can be queued into C3's batch instead of forcing a
   * flush. See deferredBatch.js — this is what lets a whole frame's models
   * share one batch rather than costing two flushes each.
   */
  _useDeferred(renderer) {
    // install() is idempotent and the editor flag never changes, so the only
    // moving part is the kill switch. Re-deriving all of it several times per
    // instance per frame showed up as 8% of the profile.
    if (this._deferredInstalled === undefined) {
      const DeferredBatch = globalThis.DeferredBatch
      this._deferredInstalled = !!(DeferredBatch && !this.inst.isEditor && DeferredBatch.install(renderer))
    }
    return this._deferredInstalled && globalThis.C3_3DOBJECT_DEFERRED !== false
  }

  /**
   * Run one of the raw-GL helpers below, deferred into the batch when possible
   * and immediately otherwise.
   *
   * These helpers all read `renderer._batchState.currentShader`, which is only
   * accurate while the command list is executing, so running them deferred is
   * more correct than running them at record time — provided the batch has an
   * appropriate SetProgram queued ahead of them, which instance.js guarantees.
   *
   * @param {Float32Array|null} [mat] snapshotted if given; the caller's matrix
   *   is reused between instances and would otherwise be overwritten before the
   *   job runs.
   */
  _glCall(renderer, fn, mat) {
    const DeferredBatch = globalThis.DeferredBatch
    if (this._useDeferred(renderer)) {
      const job = DeferredBatch.push(renderer, fn, this, renderer)
      if (mat) job._c3obj_b = DeferredBatch.scratch(job, 0, 16, mat)
      return
    }
    fn.call(this, renderer, mat)
  }

  setVertexShaderModelRotate(renderer, modelRotate) {
    const gl = renderer._gl
    const batchState = renderer._batchState
    const shaderProgram = batchState.currentShader._shaderProgram

    globalThis.uniformCache.setMatrix4(gl, shaderProgram, "uModelRotate", modelRotate)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uModelRotateEnable", 1)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uPhongEnable", 0)
  }

  disableVertexShaderModelRotate(renderer) {
    const gl = renderer._gl
    const batchState = renderer._batchState
    const shaderProgram = batchState.currentShader._shaderProgram

    globalThis.uniformCache.setFloat(gl, shaderProgram, "uModelRotateEnable", 0)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uPhongEnable", 0)
  }

  _disableGPUSkinning(renderer) {
    const gl = renderer._gl
    const shaderProgram = renderer._batchState.currentShader._shaderProgram

    globalThis.uniformCache.setFloat(gl, shaderProgram, "uSkinEnable", 0.0)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uNodeXformEnable", 0.0)
  }

  /**
   * Draw one primitive as a single batched mesh.
   *
   * The old path issued one degenerate `Quad3D2` per triangle, which is what
   * made both the editor and the non-static runtime path slow: a 22-triangle
   * prop cost 22 draw-quad calls per instance per frame, and a 7,000-triangle
   * character cost 7,000. `DrawMesh` takes exactly the arrays already on hand -
   * positions, UVs and indices - and collapses all of it into one call.
   *
   * Positions need a copy because `Quad3D2` adds `baseZ + currentZ` to every z
   * itself while `DrawMesh` takes absolute positions, so the same offset has to
   * be folded in here along with the instance's z. The copy is one linear pass
   * and is reused between frames.
   */
  _drawMesh(renderer, drawMesh, index, positions, uvs, indices, z) {
    // GetBaseZ/GetCurrentZ are public on RendererBase; the editor's SDK
    // renderer interface exposes only GetCurrentZ, and never sets a base Z.
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

    // A mesh without TEXCOORD_0 draws against the white texture, so the UVs are
    // arbitrary - but DrawMesh still needs an array of the right length.
    let tex = uvs
    if (!tex || tex.length * 3 !== positions.length * 2) {
      if (!drawMesh._drawUV) drawMesh._drawUV = []
      const need = (positions.length / 3) * 2
      tex = drawMesh._drawUV[index]
      if (!tex || tex.length !== need) tex = drawMesh._drawUV[index] = new Float32Array(need)
    }

    // Indices are Uint16 here, so the vertex count can never exceed DrawMesh's
    // 65535 limit. The index count can, so start a new mesh draw rather than
    // dropping anything. MAX_INDICES is a multiple of 3, so chunks stay whole
    // triangles.
    const MAX_INDICES = 393210
    if (indices.length <= MAX_INDICES) {
      renderer.DrawMesh(pos, tex, indices)
      return
    }
    for (let start = 0; start < indices.length; start += MAX_INDICES) {
      renderer.DrawMesh(pos, tex, indices.subarray(start, Math.min(start + MAX_INDICES, indices.length)))
    }
  }

  /**
   * Point C3's vertex/texcoord attributes back at C3's own buffers.
   *
   * ObjectBuffer.draw binds its VAO to issue the model's drawElements, which
   * leaves the default VAO's attribute pointers stale. C3's subsequent draws
   * read through those pointers, so they have to be put back.
   */
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

  _resetColorUniforms(renderer) {
    const gl = renderer._gl
    const shaderProgram = renderer._batchState.currentShader._shaderProgram

    // Reset color uniforms for subsequent non-3D objects
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uUseUniformColor", 0.0)
    globalThis.uniformCache.setVec4(gl, shaderProgram, "uObjectColor", 1.0, 1.0, 1.0, 1.0)
    globalThis.uniformCache.setFloat(gl, shaderProgram, "uHasVertexColors", 1.0) // Reset to C3 default
  }

  render(renderer, x, y, z, tempQuad, whiteTexture, instanceC3Color, textures, opacity) {
    if (opacity === 0) return
    // Only flush when we can't queue our GL work into the batch instead. The
    // flush is what used to cost ~14 us per instance and truncate every other
    // object's batching as a side effect.
    if (!this.inst.isEditor && !this._useDeferred(renderer)) renderer.EndBatch()

    // Six allocations per instance per frame added up to real GC pressure at
    // high instance counts; all of it is scratch that never outlives the call.
    if (!this._scratch) {
      const m = globalThis.glMatrix3D
      this._scratch = {
        currentColor: [-1, -1, -1, -1],
        instanceColor: [0, 0, 0, 0],
        finalColor: m.vec4.create(),
        tmpModelView: m.mat4.create(),
        modelRotate: m.mat4.create(),
        rotate: m.quat.create(),
        iModel: m.mat4.create(),
        pos: [0, 0, 0],
        scl: [0, 0, 0],
        // x,y,z | angles | scales | localCenter - NaN so the first frame is a miss
        xform: new Float64Array(12).fill(NaN),
      }
    }
    const scratch = this._scratch

    let totalTriangles = 0
    const currentColor = scratch.currentColor
    currentColor[0] = currentColor[1] = currentColor[2] = currentColor[3] = -1
    let currentTexture = null
    const rendererVertexData = renderer._vertexData
    const rendererTexcoordData = renderer._texcoordData

    const vec4 = globalThis.glMatrix3D.vec4
    const vec3 = globalThis.glMatrix3D.vec3
    const mat4 = globalThis.glMatrix3D.mat4
    const quat = globalThis.glMatrix3D.quat

    const instanceColor = scratch.instanceColor
    instanceColor[0] = instanceC3Color.getR()
    instanceColor[1] = instanceC3Color.getG()
    instanceColor[2] = instanceC3Color.getB()
    instanceColor[3] = instanceC3Color.getA()
    const finalColor = scratch.finalColor

    const tmpModelView = scratch.tmpModelView
    const modelRotate = scratch.modelRotate
    // Instanced draws carry the model matrix as a vertex attribute, so none of
    // the per-instance SetModelViewMatrix / uModelRotate work below is needed.
    const instanced = this._canInstance(renderer)
    if (!this.inst.isEditor) {
      mat4.copy(tmpModelView, renderer._matMV)
      const xAngle = this.inst.xAngle
      const yAngle = this.inst.yAngle
      const zAngle = this.inst.zAngle
      const xScale = this.inst.scale / (this.inst.xScale == 0 ? 1 : this.inst.xScale)
      const yScale = this.inst.scale / (this.inst.yScale == 0 ? 1 : this.inst.yScale)
      const zScale = this.inst.scale / (this.inst.zScale == 0 ? 1 : this.inst.zScale)
      // Rebuild the model matrix only when something it depends on moved.
      // Most instances in a scene are static from frame to frame, and
      // fromEuler plus fromRotationTranslationScaleOrigin was 4% of the profile
      // on its own. The two vector arguments are scratch too - they were a pair
      // of array literals per instance per frame.
      const lc = this.inst.localCenter
      const t = scratch.xform
      const changed =
        t[0] !== x || t[1] !== y || t[2] !== z ||
        t[3] !== xAngle || t[4] !== yAngle || t[5] !== zAngle ||
        t[6] !== xScale || t[7] !== yScale || t[8] !== zScale ||
        t[9] !== lc[0] || t[10] !== lc[1] || t[11] !== lc[2]
      if (changed) {
        t[0] = x; t[1] = y; t[2] = z
        t[3] = xAngle; t[4] = yAngle; t[5] = zAngle
        t[6] = xScale; t[7] = yScale; t[8] = zScale
        t[9] = lc[0]; t[10] = lc[1]; t[11] = lc[2]
        const pos = scratch.pos
        pos[0] = x; pos[1] = y; pos[2] = z
        const scl = scratch.scl
        scl[0] = xScale; scl[1] = -yScale; scl[2] = zScale
        const rotate = scratch.rotate
        quat.fromEuler(rotate, xAngle, yAngle, zAngle)
        mat4.fromRotationTranslationScaleOrigin(this.modelRotate, rotate, pos, scl, lc)
      }
      if (!instanced) mat4.copy(modelRotate, this.modelRotate)
      if (!instanced) {
        mat4.multiply(modelRotate, tmpModelView, modelRotate)
        renderer.SetModelViewMatrix(modelRotate)
        this._glCall(renderer, this.setVertexShaderModelRotate, this.modelRotate)
      }
    }

    // Default color - no longer set via renderer, will be passed via uniforms
    // renderer.SetColor(instanceC3Color)
    vec4.copy(currentColor, instanceColor)
    let baseColorChanged = false
    if (!vec4.equals(currentColor, [1, 1, 1, 1])) baseColorChanged = true

    for (let j = 0; j <= this.drawMeshesIndex; j++) {
      // Skip render if disabled
      if (this.drawMeshes[j].disabled) continue

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
          let texture = textures[material.name]
          // If texture is not loaded, skip rendering
          if (!texture) continue
          if (texture != currentTexture) {
            renderer.SetTexture(texture)
            currentTexture = texture
          }
        }
      }
      const xVerts = drawVerts

      // Static geometry, draw from GPU buffers
      if (this.inst.staticGeometry) {
        const objectBuffers = this.drawMeshes[j].objectBuffers
        // Draw
        let instanceBoneBuffer
        for (let i = 0; i < objectBuffers.length; i++) {
          instanceBoneBuffer = this.drawMeshes[j]?.boneBuffer

          if (instanced) {
            // Fold the node transform into the per-instance matrix so a mesh
            // reused by several nodes still shares one buffer and one draw.
            const dm = this.drawMeshes[j]
            const nodeXform = objectBuffers[i].usesSourcePositions ? dm.nodeXform : null
            // A single-node prop usually has an identity node matrix, and the
            // multiply is then pure cost.
            if (dm._nodeXformIsIdentity === undefined) {
              dm._nodeXformIsIdentity = nodeXform ? isIdentityMat4(nodeXform) : true
            }
            let iModel = this.modelRotate
            if (!dm._nodeXformIsIdentity) {
              iModel = scratch.iModel
              mat4.multiply(iModel, this.modelRotate, nodeXform)
            }
            objectBuffers[i].addInstance(renderer, iModel, currentColor)
          } else {
            objectBuffers[i].draw(
              renderer,
              instanceBoneBuffer,
              this._sdkType.gltfData,
              currentColor, // Pass calculated color to draw method
              this.drawMeshes[j].morphWeights,
              objectBuffers[i].usesSourcePositions ? this.drawMeshes[j].nodeXform : null
            )
          }
          totalTriangles += objectBuffers[i].indexDataLength / 3
        }
        // There was an instanceBoneBuffer.disable(renderer) call here, but
        // BoneBuffer has never had a disable method - it only became reachable
        // once every model started taking the buffer path. Nothing needs it:
        // _disableGPUSkinning in _drawNow and the instanced path both clear
        // uSkinEnable before an unskinned mesh draws.
        continue
      }

      const drawMesh = this.drawMeshes[j]
      renderer.SetColorRgba(currentColor[0], currentColor[1], currentColor[2], currentColor[3])
      for (let ii = 0; ii < drawVerts.length; ii++) {
        const ind = drawIndices[ii]
        totalTriangles += ind.length / 3
        this._drawMesh(renderer, drawMesh, ii, xVerts[ii], hasTexture ? drawUVs[ii] : null, ind, z)
      }
    }

    // Restore modelview matrix
    if (!this.inst.isEditor && !instanced) {
      renderer.SetModelViewMatrix(tmpModelView)
    }
    this.inst.totalTriangles = totalTriangles
    // Restore renderer buffers
    renderer._vertexData = rendererVertexData
    renderer._texcoordData = rendererTexcoordData

    if (!this.inst.isEditor) {
      if (instanced) {
        // The instanced group binds and unbinds its own VAO and touches no
        // shared attribute state, so there is nothing per instance to undo.
      } else if (this._useDeferred(renderer)) {
        // One job for all of it. Every queued job costs a switch and a call at
        // flush time, and with hundreds of models on screen the per-instance
        // job count is worth keeping down.
        this._glCall(renderer, this._afterDrawCleanup)
      } else {
        // Original flush-path ordering, preserved exactly.
        this.disableVertexShaderModelRotate(renderer)
        this._disableGPUSkinning(renderer)
        this._resetColorUniforms(renderer)
        renderer.EndBatch()
        if (this.inst.staticGeometry) {
          this._restoreC3Attribs(renderer)
          // Safe here only because EndBatch just emptied the batch. Deferred,
          // C3 still owns these pointers and zeroing them would throw away
          // other objects' queued vertices.
          renderer._vertexPtr = 0
          renderer._texPtr = 0
        }
        // @ts-ignore
        if (globalThis.BoneBuffer) this._bindDummyBonesUbo(renderer)
      }
    }

  }

  /**
   * Everything that has to happen after a model's meshes are drawn, in one
   * deferred job: reset the uniforms we changed, point C3's attributes back at
   * its own buffers, and bind the dummy Bones UBO so a following C3 draw whose
   * shader declares that block doesn't read ours.
   */
  _afterDrawCleanup(renderer) {
    // The uniform resets that used to live here act on OUR dedicated program,
    // which nothing else draws with, so the next instance overwrites them
    // anyway. Only genuinely shared GL state needs putting back.
    if (this.inst.staticGeometry) this._restoreC3Attribs(renderer)
    // @ts-ignore
    if (globalThis.BoneBuffer) this._bindDummyBonesUbo(renderer)
  }

  /**
   * Bind a dummy UBO to the Bones binding point so a following C3 draw whose
   * shader declares the block doesn't read whatever this model left there.
   */
  _bindDummyBonesUbo(renderer) {
    {
      const gl = renderer._gl
      const currentShader = renderer._batchState?.currentShader?._shaderProgram
      if (currentShader) {
        // Assume the shader requires the 'Bones' block. Directly get and bind dummy UBO.
        // const blockIndex = gl.getUniformBlockIndex(currentShader, "Bones");
        // if (blockIndex !== gl.INVALID_INDEX && blockIndex !== -1) { // Assume always true
        // @ts-ignore
        const dummyUBO = globalThis.BoneBuffer._getOrCreateDummyUBO(gl)
        if (dummyUBO) {
          // Ensure block binding point association (idempotent)
          // We still need the block index for uniformBlockBinding.
          const blockIndex = globalThis.uniformCache.getUniformBlockIndex(gl, currentShader, "Bones")
          if (blockIndex !== gl.INVALID_INDEX && blockIndex !== -1) {
            // @ts-ignore
            gl.uniformBlockBinding(currentShader, blockIndex, globalThis.BoneBuffer.BONE_UBO_BINDING_POINT)
          } else {
            console.warn("[GltfModel Cleanup] 'Bones' block not found for uniformBlockBinding.")
          }
          // Bind the dummy UBO
          // @ts-ignore
          gl.bindBufferBase(gl.UNIFORM_BUFFER, globalThis.BoneBuffer.BONE_UBO_BINDING_POINT, dummyUBO)
          // console.log("[GltfModel Cleanup] Bound dummy UBO for subsequent rendering.");
        } else {
          console.error("[GltfModel Cleanup] Shader expects 'Bones' UBO, but dummy UBO is unavailable.")
        }
        // } // else: Shader doesn't expect 'Bones', no cleanup bind needed.
      } else {
        console.warn("[GltfModel Cleanup] Could not get current shader program to perform dummy UBO cleanup bind.")
      }
    }
  }

  /*
        Updates a node's matrix and all it's children nodes.
        After that it transforms unskinned mesh points and sends them to c2.
    */
  transformNode(node, parentMat, modelScaleRotate, staticGeometry = false, gpuSkinning = false) {
    // @ts-ignore
    const mat4 = globalThis.glMatrix3D.mat4
    // @ts-ignore
    const quat = globalThis.glMatrix3D.quat
    // @ts-ignore
    const vec3 = globalThis.glMatrix3D.vec3
    const gltf = this.gltfData
    let dummyMat4Out = mat4.create()

    if (parentMat != undefined) mat4.copy(node.matrix, parentMat)
    // mat4.set(parentMat, node.matrix);
    else mat4.identity(node.matrix)
    mat4.translate(node.matrix, node.matrix, node.translation)
    // mat4.translate(node.matrix, node.translation);
    mat4.multiply(node.matrix, node.matrix, mat4.fromQuat(dummyMat4Out, node.rotation))
    // mat4.multiply(node.matrix, quat4.toMat4(node.rotation));
    mat4.scale(node.matrix, node.matrix, node.scale)
    // mat4.scale(node.matrix, node.scale);

    if (node.skin != undefined) mat4.invert(node.invMatrix, node.matrix)
    // mat4.inverse(node.matrix, node.invMatrix);

    // unskinned meshes
    if (node.mesh != undefined && node.skin == undefined) {
      if (gpuSkinning) {
        if (!staticGeometry) {
          if (!node.hasOwnProperty("boneBuffer")) {
            // Use the constant directly from BoneBuffer if available
            // @ts-ignore - Linter doesn't know globalThis structure
            const maxBonesForBuffer = globalThis.BoneBuffer?.MAX_BONES || 256 // Default to 256 if needed
            const boneBuffer = new BoneBuffer(this.inst.renderer, maxBonesForBuffer, false)
            node.boneBuffer = boneBuffer
          }
          node.boneBuffer.setNodeXform(node.matrix)
        }
      }

      for (let i = 0; i < node.mesh.primitives.length; i++) {
        let posData = node.mesh.primitives[i].attributes.POSITION.data

        let morphActive = false
        let morphTargets = null
        let morphWeights = null
        if (node.weights) {
          morphActive = true
          morphTargets = node.mesh.primitives[i].targets
          morphWeights = node.weights
        }

        this.drawMeshesIndex++
        if (!this.drawMeshes[this.drawMeshesIndex]) {
          this.drawMeshes.push({
            drawVerts: [],
            drawVertsOrig: [],
            drawUVs: [],
            drawIndices: [],
            drawColors: [],
            drawNormals: [],
            drawBones: [],
            drawJoints: [],
            drawWeights: [],
            disabled: false,
            objectBuffers: [],
            morphTargets: [],
            morphWeights: null,
            nodeXform: null,
            _nodeXformIsIdentity: undefined,
            maxJointIndexUsed: -1,
          })
          this.meshNames.set(node.name, this.drawMeshesIndex)
        }

        if (gpuSkinning && !staticGeometry) this.drawMeshes[this.drawMeshesIndex].boneBuffer = node.boneBuffer

        this.drawMeshes[this.drawMeshesIndex].disabled = node.disabled

        // Update material each time, in case an ACE changes it
        if ("material" in node.mesh.primitives[i]) {
          this.drawMeshes[this.drawMeshesIndex].material = node.mesh.primitives[i].material
        } else {
          this.drawMeshes[this.drawMeshesIndex].material = null
        }

        const drawMesh = this.drawMeshes[this.drawMeshesIndex]
        const drawVerts = drawMesh.drawVerts
        const drawUVs = drawMesh.drawUVs
        const drawIndices = drawMesh.drawIndices
        const drawColors = drawMesh.drawColors
        const drawNormals = drawMesh.drawNormals
        const objectBuffers = drawMesh.objectBuffers
        const drawVertsOrig = drawMesh.drawVertsOrig

        // reset draw array for new values
        drawVerts.length = 0

        // Reuse the per-mesh output array instead of allocating every tick
        let transformedVerts = drawMesh._transformedVerts
        if (!transformedVerts || transformedVerts.length !== posData.length) {
          transformedVerts = drawMesh._transformedVerts = new Float32Array(posData.length)
        }

        let v = [0, 0, 0]

        // A static mesh is drawn from the immutable source positions with the
        // node transform as a uniform, so transformedVerts is thrown away. The
        // only thing the loop still produced was the bounding box, and that is
        // identical for every instance of the model - so take it from the cached
        // source bounds instead and skip the walk entirely.
        // Runtime never needs CPU vertices any more: skinning, morphs and the
        // bounding box are all GPU-side or derived from cached source bounds.
        // The editor is the exception - its renderer has no GL access, so it
        // still walks vertices and draws them with DrawMesh.
        const skipCpuVerts = !this.inst.isEditor
        if (skipCpuVerts) this._accumulateSourceBounds(posData, node.matrix)

        for (let j = 0; j < posData.length / 3; j++) {
          if (skipCpuVerts) continue
          let vin = posData.subarray(j * 3, j * 3 + 3)
          if (morphActive) {
            vin = this.morphTargets(vin, j, morphWeights, morphTargets)
          }

          vec3.transformMat4(v, vin, node.matrix)

          // vec3.transformMat4(v, vv, node.matrix);
          // mat4.multiplyVec3(node.matrix, posData.subarray(j*3, j*3+3), v);

          if (this.inst.isEditor) {
            vec3.transformMat4(v, v, modelScaleRotate)
          }

          const x = v[0]
          const y = v[1]
          const z = v[2]

          if (this.inst.minBB[0] > x) this.inst.minBB[0] = x
          if (this.inst.minBB[1] > y) this.inst.minBB[1] = y
          if (this.inst.minBB[2] > z) this.inst.minBB[2] = z
          if (this.inst.maxBB[0] < x) this.inst.maxBB[0] = x
          if (this.inst.maxBB[1] < y) this.inst.maxBB[1] = y
          if (this.inst.maxBB[2] < z) this.inst.maxBB[2] = z

          transformedVerts[j * 3] = x
          transformedVerts[j * 3 + 1] = y
          transformedVerts[j * 3 + 2] = z
        }

        if (transformedVerts.length > 0 || staticGeometry || gpuSkinning) {
          if (gltf.pointBatch != undefined)
            for (let ii = 0; ii < transformedVerts.length; ii++) gltf.pointBatch.push(transformedVerts[ii])
          else {
            if (transformedVerts.length > 0 && !skipCpuVerts) drawVerts.push(transformedVerts)
            // Only need to set once for all the below
            if (drawUVs.length === 0 && "TEXCOORD_0" in node.mesh.primitives[i].attributes) {
              drawUVs.push(sharedOrCopy(node.mesh.primitives[i].attributes.TEXCOORD_0.data, Float32Array))
            }
            if (
              (gpuSkinning || staticGeometry) &&
              drawVertsOrig.length === 0 &&
              "POSITION" in node.mesh.primitives[i].attributes
            ) {
              drawVertsOrig.push(sharedOrCopy(posData, Float32Array))
            }
            if (drawColors.length === 0 && "COLOR_0" in node.mesh.primitives[i].attributes) {
              drawColors.push(sharedOrCopy(node.mesh.primitives[i].attributes.COLOR_0.data, Float32Array))
            }
            if (drawNormals.length === 0) {
              // Falls back to generated smooth normals when the model has none.
              const normalData = globalThis.gltfPrimitiveNormals(node.mesh.primitives[i])
              if (normalData) drawNormals.push(sharedOrCopy(normalData, Float32Array))
            }

            if (drawIndices.length === 0)
              drawIndices.push(sharedOrCopy(node.mesh.primitives[i].indices.data, Uint16Array))
            // Targets are immutable model data shared between instances; weights
            // are the per-instance part and are read fresh at draw time.
            if (morphActive) {
              const dm = this.drawMeshes[this.drawMeshesIndex]
              if (dm.morphTargets.length === 0) dm.morphTargets.push(morphTargets)
              dm.morphWeights = morphWeights
            }
            if (staticGeometry) {
              const dm = this.drawMeshes[this.drawMeshesIndex]
              if (objectBuffers.length == 0) {
                objectBuffers.push(ObjectBuffer.acquire(this.inst.renderer, dm, 0, gpuSkinning, this._hasAnimations()))
              } else if (!gpuSkinning) {
                objectBuffers[0].updateVertexData(this.inst.renderer, dm, 0)
              }
              // Passed to draw() rather than stored on the buffer: a shared
              // buffer has no single owner to hold it for.
              dm.nodeXform = node.matrix
              dm._nodeXformIsIdentity = undefined
              objectBuffers[0].setNodeXform(node.matrix)
            }
          }
        }
      }
    }

    if (node.children != undefined)
      for (let i = 0; i < node.children.length; i++)
        this.transformNode(node.children[i], node.matrix, modelScaleRotate, staticGeometry, gpuSkinning)
  }

  morphTargets(vin, index, weights, targets) {
    const vec3 = globalThis.glMatrix3D.vec3
    const vout = vec3.create()
    vec3.copy(vout, vin)
    for (let i = 0; i < targets.length; i++) {
      const w = weights[i]
      if (w == 0) continue
      const v = targets[i].POSITION.data.subarray(index * 3, index * 3 + 3)
      vec3.scaleAndAdd(vout, vout, v, w)
    }
    return vout
  }
  //	Updates scene graph, and as a second step sends transformed skinned mesh points to c2.
  /**
   * Identity of everything the editor's polygon walk depends on.
   *
   * The layout view redraws constantly and called getPolygons() every frame for
   * every instance, re-running the whole node walk and per-vertex transform. In
   * the editor the result only changes when the instance transform does.
   */
  /**
   * True when this instance's meshes can go through the instanced path.
   *
   * Requires static GPU buffers with no per-instance vertex state: no skinning
   * (bone matrices are per-instance uniforms) and no morph targets (weights are
   * too). The shader check runs once - the program is created once and either
   * has the attributes or does not.
   */
  _canInstance(renderer) {
    if (this._instanceableCache === false) return false
    if (this.inst.isEditor) return false
    if (!this._useDeferred(renderer)) return false

    if (ObjectBuffer.instancingSupported === undefined) {
      const gl = renderer._gl
      const shader = globalThis.cached3DObjectShader
      const prog = shader && shader._shaderProgram
      ObjectBuffer.instancingSupported = !!(
        gl &&
        prog &&
        typeof gl.drawElementsInstanced === "function" &&
        gl.getAttribLocation(prog, "aIModel") !== -1 &&
        gl.getAttribLocation(prog, "aIColor") !== -1
      )
    }
    if (!ObjectBuffer.instancingSupported) return false

    // Walking every drawMesh on every render() of every instance showed up in
    // the profile; the answer only changes when getPolygons rebuilds the list.
    if (this._instanceableCache === undefined) {
      let ok = true
      for (let j = 0; j <= this.drawMeshesIndex; j++) {
        const dm = this.drawMeshes[j]
        if (dm.boneBuffer || (dm.morphTargets && dm.morphTargets.length)) {
          ok = false
          break
        }
      }
      this._instanceableCache = ok
    }
    return this._instanceableCache
  }

  /**
   * Expand the instance bounding box by one primitive's source bounds, put
   * through the node transform.
   *
   * The untransformed min/max of a POSITION accessor is pure model data, so it
   * is computed once and cached on the accessor array. Transforming the eight
   * corners is looser than transforming every vertex, but it is conservative -
   * never smaller - so it cannot cull early.
   */
  _accumulateSourceBounds(posData, nodeMatrix) {
    let bounds = sourceBoundsCache.get(posData)
    if (!bounds) {
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0, n = posData.length; i < n; i += 3) {
        for (let a = 0; a < 3; a++) {
          const c = posData[i + a]
          if (c < min[a]) min[a] = c
          if (c > max[a]) max[a] = c
        }
      }
      bounds = { min, max }
      sourceBoundsCache.set(posData, bounds)
    }

    const vec3 = globalThis.glMatrix3D.vec3
    const corner = this._boundsCorner || (this._boundsCorner = vec3.create())
    const minBB = this.inst.minBB
    const maxBB = this.inst.maxBB
    for (let c = 0; c < 8; c++) {
      corner[0] = (c & 1 ? bounds.max : bounds.min)[0]
      corner[1] = (c & 2 ? bounds.max : bounds.min)[1]
      corner[2] = (c & 4 ? bounds.max : bounds.min)[2]
      vec3.transformMat4(corner, corner, nodeMatrix)
      for (let a = 0; a < 3; a++) {
        if (corner[a] < minBB[a]) minBB[a] = corner[a]
        if (corner[a] > maxBB[a]) maxBB[a] = corner[a]
      }
    }
  }

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

  getPolygons(staticGeometry = false, gpuSkinning = false) {
    this._instanceableCache = undefined
    if (this.inst.isEditor) {
      const sig = this._editorPolygonSignature()
      if (sig === this._editorPolySig) return
      this._editorPolySig = sig
    }
    // @ts-ignore
    const vec3 = globalThis.glMatrix3D.vec3
    // @ts-ignore
    const mat4 = globalThis.glMatrix3D.mat4
    // @ts-ignore
    const quat = globalThis.glMatrix3D.quat
    const gltf = this.gltfData
    const scale = this.inst.scale
    const xScale = this.inst.scale / (this.inst.xScale == 0 ? 1 : this.inst.xScale)
    const yScale = this.inst.scale / (this.inst.yScale == 0 ? 1 : this.inst.yScale)
    const zScale = this.inst.scale / (this.inst.zScale == 0 ? 1 : this.inst.zScale)
    this.drawMeshesIndex = -1

    const modelScaleRotate = mat4.create()

    if (this.inst.isEditor) {
      const xAngle = this.inst.xAngle
      const yAngle = this.inst.yAngle
      const zAngle = this.inst.zAngle

      const x = this.inst.isEditor ? this.inst._inst.GetX() : this.inst.GetWorldInfo().GetX()
      const y = this.inst.isEditor ? this.inst._inst.GetY() : this.inst.GetWorldInfo().GetY()
      const z = this.inst.isEditor ? this.inst._inst.GetZElevation() : this.inst.GetWorldInfo().GetZElevation()

      const rotate = quat.create()
      quat.fromEuler(rotate, xAngle, yAngle, zAngle)
      mat4.fromRotationTranslationScale(modelScaleRotate, rotate, [x, y, z], [xScale, -yScale, zScale])
      if (globalThis.mikal3deditor?.enable) {
        const viewRotate = globalThis.mikal3deditor.viewRotate
        mat4.multiply(modelScaleRotate, viewRotate, modelScaleRotate)
      }
    }

    let rotationQuat = quat.create()
    let parentMatrix = mat4.create()

    quat.fromEuler(rotationQuat, 0, 0, 0)

    mat4.fromRotationTranslation(parentMatrix, rotationQuat, [0, 0, 0])

    this.inst.minBB = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
    this.inst.maxBB = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]

    // update all scene matrixes.
    for (let i = 0; i < gltf.scene.nodes.length; i++) {
      this.transformNode(gltf.scene.nodes[i], parentMatrix, modelScaleRotate, staticGeometry, gpuSkinning)
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
    // The transform the skinning shader applies after the bone matrices; the
    // instance bounds the posed skeleton in the same space (_poseLocalBounds).
    this.rootNodeXform = rootNodeXform ? parentMatrix : null

    for (let ii = 0; ii < gltf.skinnedNodes.length; ii++) {
      let node = gltf.skinnedNodes[ii]

      //update bone matrixes
      if (gpuSkinning) {
        if (!node.hasOwnProperty("boneBuffer")) {
          // Use the constant directly from BoneBuffer if available
          // @ts-ignore - Linter doesn't know globalThis structure
          const maxBonesForBuffer = globalThis.BoneBuffer?.MAX_BONES || 256 // Default to 256 if needed
          const boneBuffer = new BoneBuffer(this.inst.renderer, maxBonesForBuffer, true)
          node.boneBuffer = boneBuffer
        }
        node.boneBuffer.setRootNodeXform(parentMatrix)
      }

      for (let jj = 0; jj < node.skin.joints.length; jj++) {
        if (node.disabled) continue
        let joint = node.skin.joints[jj]

        mat4.multiply(joint.boneMatrix, node.invMatrix, joint.matrix)
        // mat4.multiply(node.invMatrix, joint.matrix, joint.boneMatrix);
        mat4.multiply(joint.boneMatrix, joint.boneMatrix, joint.invBindMatrix)
        // mat4.multiply(joint.boneMatrix, joint.invBindMatrix);
        if (gpuSkinning) node.boneBuffer.setBone(jj, joint.boneMatrix)
      }

      for (let i = 0; i < node.mesh.primitives.length; i++) {
        this.drawMeshesIndex++
        if (!this.drawMeshes[this.drawMeshesIndex]) {
          this.drawMeshes.push({
            drawVerts: [],
            drawUVs: [],
            drawIndices: [],
            drawColors: [],
            drawNormals: [],
            drawJoints: [],
            drawWeights: [],
            drawBones: [],
            drawVertsOrig: [],
            disabled: true,
            objectBuffers: [],
            morphTargets: [],
            morphWeights: null,
            nodeXform: null,
            _nodeXformIsIdentity: undefined,
            maxJointIndexUsed: -1,
          })
          this.meshNames.set(node.name, this.drawMeshesIndex)
        }
        if (gpuSkinning) this.drawMeshes[this.drawMeshesIndex].boneBuffer = node.boneBuffer

        this.drawMeshes[this.drawMeshesIndex].disabled = node.disabled
        if (node.disabled) continue

        let morphActive = false
        let morphTargets = null
        let morphWeights = null

        if (node.weights) {
          morphActive = true
          morphTargets = node.mesh.primitives[i].targets
          morphWeights = node.weights
        }

        // Update material each time, in case an ACE changes it
        if ("material" in node.mesh.primitives[i]) {
          this.drawMeshes[this.drawMeshesIndex].material = node.mesh.primitives[i].material
        } else {
          this.drawMeshes[this.drawMeshesIndex].material = null
        }

        const drawVerts = this.drawMeshes[this.drawMeshesIndex].drawVerts
        const drawUVs = this.drawMeshes[this.drawMeshesIndex].drawUVs
        const drawIndices = this.drawMeshes[this.drawMeshesIndex].drawIndices
        const drawColors = this.drawMeshes[this.drawMeshesIndex].drawColors
        const drawNormals = this.drawMeshes[this.drawMeshesIndex].drawNormals
        const drawJoints = this.drawMeshes[this.drawMeshesIndex].drawJoints
        const drawWeights = this.drawMeshes[this.drawMeshesIndex].drawWeights
        const drawBones = this.drawMeshes[this.drawMeshesIndex].drawBones
        const objectBuffers = this.drawMeshes[this.drawMeshesIndex].objectBuffers
        const drawVertsOrig = this.drawMeshes[this.drawMeshesIndex].drawVertsOrig

        // reset draw array for new values
        drawVerts.length = 0
        if (gpuSkinning) drawBones.length = 0

        let posData = node.mesh.primitives[i].attributes.POSITION.data
        // Reuse the per-mesh output array instead of allocating every tick
        const skinnedDrawMesh = this.drawMeshes[this.drawMeshesIndex]
        let transformedVerts = skinnedDrawMesh._transformedVerts
        if (!transformedVerts || transformedVerts.length !== posData.length) {
          transformedVerts = skinnedDrawMesh._transformedVerts = new Float32Array(posData.length)
        }

        // No CPU skinning anywhere. The editor has no animation preview, so it
        // only ever draws the bind pose, and there the weighted bone blend
        // collapses to a single matrix: every joint's boneMatrix is
        //     node.invMatrix * joint.matrix * joint.invBindMatrix
        // and in bind pose joint.matrix is the inverse of invBindMatrix, so
        // those two cancel and every bone contributes node.invMatrix. Weights
        // sum to 1 by the glTF spec, so the blend is just that one multiply -
        // identical output, no weights, no joints, no per-bone loop.
        const bindMatrix = node.invMatrix
        for (let j = 0; j < posData.length / 3; j++) {
          if (!this.inst.isEditor) continue
          let vin = posData.subarray(j * 3, j * 3 + 3)
          const vsum = [0, 0, 0]

          if (morphActive) {
            vin = this.morphTargets(vin, j, morphWeights, morphTargets)
          }

          vec3.transformMat4(vsum, vin, bindMatrix)

          if (rootNodeXform) {
            // vec3.mul(vsum, vsum, rootNode.scale);
            vec3.transformMat4(vsum, vsum, parentMatrix)
            if (j == 0) {
            }
          }

          if (this.inst.isEditor) {
            vec3.transformMat4(vsum, vsum, modelScaleRotate)
          }

          const x = vsum[0]
          const y = vsum[1]
          const z = vsum[2]

          if (this.inst.minBB[0] > x) this.inst.minBB[0] = x
          if (this.inst.minBB[1] > y) this.inst.minBB[1] = y
          if (this.inst.minBB[2] > z) this.inst.minBB[2] = z
          if (this.inst.maxBB[0] < x) this.inst.maxBB[0] = x
          if (this.inst.maxBB[1] < y) this.inst.maxBB[1] = y
          if (this.inst.maxBB[2] < z) this.inst.maxBB[2] = z

          transformedVerts[j * 3] = x
          transformedVerts[j * 3 + 1] = y
          transformedVerts[j * 3 + 2] = z
        }

        if (transformedVerts.length > 0 || staticGeometry || gpuSkinning) {
          if (gltf.pointBatch != undefined)
            for (let ii = 0; ii < transformedVerts.length; ii++) gltf.pointBatch.push(transformedVerts[ii])
          else {
            if (transformedVerts.length > 0) drawVerts.push(transformedVerts)
            // Only need to set once
            if (drawUVs.length === 0 && "TEXCOORD_0" in node.mesh.primitives[i].attributes) {
              drawUVs.push(sharedOrCopy(node.mesh.primitives[i].attributes.TEXCOORD_0.data, Float32Array))
            }
            if (
              (gpuSkinning || staticGeometry) &&
              drawVertsOrig.length === 0 &&
              "POSITION" in node.mesh.primitives[i].attributes
            ) {
              drawVertsOrig.push(sharedOrCopy(posData, Float32Array))
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
            if (drawIndices.length === 0)
              drawIndices.push(sharedOrCopy(node.mesh.primitives[i].indices.data, Uint16Array))
            // Targets are immutable model data shared between instances; weights
            // are the per-instance part and are read fresh at draw time.
            if (morphActive) {
              const dm = this.drawMeshes[this.drawMeshesIndex]
              if (dm.morphTargets.length === 0) dm.morphTargets.push(morphTargets)
              dm.morphWeights = morphWeights
            }
            if (staticGeometry) {
              const dm = this.drawMeshes[this.drawMeshesIndex]
              if (objectBuffers.length == 0) {
                objectBuffers.push(ObjectBuffer.acquire(this.inst.renderer, dm, 0, gpuSkinning, this._hasAnimations()))
              } else if (!gpuSkinning) {
                objectBuffers[0].updateVertexData(this.inst.renderer, dm, 0)
              }
            }
          }
        }
      }
    }
  }

  // sends a list of animation names
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

  updateAnimationPolygons(index, time, onScreen, deltaTime, staticGeometry, gpuSkinning) {
    this.updateAnimation(index, time, onScreen, deltaTime)
    this.inst.updateBbox = true

    if (onScreen) {
      this.getPolygons(staticGeometry, gpuSkinning)
      this.inst.runtime.UpdateRender()
    }
    // Applied. See the worker version for why this reports back.
    return true
  }

  lerp(a, b, alpha) {
    const value = a + alpha * (b - a)
    return value
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

  // Updates animation at index to be at time.  Is used to play animation.
  updateAnimation(index, time, onScreen, deltaTime) {
    // @ts-ignore
    const vec3 = globalThis.glMatrix3D.vec3
    // @ts-ignore
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

      // If not on screen no more animation required.
      if (!onScreen) continue

      //time = Math.min(Math.max(time, timeValues.min[0]), timeValues.max[0]);  //clamp
      timeValues = timeValues.data

      //find index in timeline
      let t0, t1
      for (t0 = 0, t1 = 1; t0 < timeValues.length - 1; t0++, t1++)
        if (time >= timeValues[t0] && time <= timeValues[t1]) break

      this.inst.currentAnimationFrame = t0

      let t = (time - timeValues[t0]) / (timeValues[t1] - timeValues[t0])

      this.inst.currentAnimationFrame = Math.round(t0 + t)

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
        // Apply gltf morph target weights to node weights using lerp between two targets
        const node = target.node
        node.weights = new Float32Array(node.mesh.primitives[0].targets.length)
        const weights = node.weights
        const stride = weights.length
        for (let j = 0; j < stride; j++) {
          weights[j] = this.lerp(otherValues[t0 * stride + j], otherValues[t1 * stride + j], t)
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
if (!globalThis.GltfModel) {
  // @ts-ignore
  globalThis.GltfModel = GltfModelTop
}
