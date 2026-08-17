"use strict"
// @ts-check

// @ts-ignore
class ObjectBufferTop {
  constructor(renderer, mesh, primitiveIndex, gpuSkinning) {
    this.gl = renderer._gl
    const gl = this.gl
    this.vao = null
    this.nodeXform = new Float32Array(16)
    // Set by acquire() when this buffer is shared between instances. Unshared
    // buffers keep refs === 1 and free their GL objects on the first release().
    this._shared = false
    this._refs = 1
    this._shareKey = null
    this.maxJointIndexUsed = mesh.maxJointIndexUsed ?? -1; // Store max index used by this mesh primitive
    this.gpuSkinning = gpuSkinning

    let vertexData, texcoordData, indexData, colorData, normalData, weightsData, jointsData
    if (gpuSkinning) {
      vertexData = mesh.drawVertsOrig[primitiveIndex]
    } else {
      vertexData = mesh.drawVerts[primitiveIndex]
    }
    texcoordData = mesh.drawUVs[primitiveIndex]
    if (!texcoordData || texcoordData.length == 0) {
      // Texcoords are 2 floats per vertex (positions are 3)
      texcoordData = this.createDefaultTexcoordData((vertexData.length / 3) * 2)
    }
    indexData = mesh.drawIndices[primitiveIndex]
    colorData = mesh.drawColors[primitiveIndex]
    normalData = mesh.drawNormals ? mesh.drawNormals[primitiveIndex] : null
    weightsData = mesh.drawWeights ? mesh.drawWeights[primitiveIndex] : null
    jointsData = mesh.drawJoints ? mesh.drawJoints[primitiveIndex] : null
    this.indexDataLength = indexData.length
    this.vertexData = vertexData
    this.texcoordData = texcoordData
    this.indexData = indexData
    this.colorData = colorData
    this.normalData = normalData
    this.weightsData = weightsData
    // Change jointsData to float32ARRAY FROM UINT16ARRAY
    // C3 Shader uniforms must be cast as float instead of int, unknown why
    // If non C3 shader program is used, it will not be required
    if (jointsData) {
      this.jointsData = new Float32Array(jointsData.length)
      this.jointsData.set(jointsData)
    }

    this.vertexBuffer = gl.createBuffer()
    this.texcoordBuffer = gl.createBuffer()
    this.indexBuffer = gl.createBuffer()
    if (colorData != null) {
      this.colorBuffer = gl.createBuffer()
    }
    if (normalData != null) {
      this.normalBuffer = gl.createBuffer()
    }
    if (weightsData != null) {
      this.weightsBuffer = gl.createBuffer()
    }
    if (jointsData != null) {
      this.jointsBuffer = gl.createBuffer()
    }
    // Fill all buffers
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData, gl.STATIC_DRAW)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texcoordBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.texcoordData, gl.STATIC_DRAW)

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexData, gl.STATIC_DRAW)

    if (colorData != null) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.colorData, gl.STATIC_DRAW)
    }
    if (normalData != null) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.normalData, gl.STATIC_DRAW)
    }
    if (weightsData != null) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.weightsBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.weightsData, gl.STATIC_DRAW)
    }
    if (jointsData != null) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.jointsBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.jointsData, gl.STATIC_DRAW)
    }

    // vao created at draw time to insure the correct shader is used
    // Color uniform locations for 3DObject compatibility
    this.locUseUniformColor = null;
    this.locObjectColor = null;
  }

  /**
   * Get a buffer for `mesh.primitives[primitiveIndex]`, sharing the GL objects
   * between instances of the same model where that is provably safe.
   *
   * ── WHY ───────────────────────────────────────────────────────────────────
   * Every ObjectBuffer allocates seven GL buffers (vertex, texcoord, index,
   * colour, normal, weights, joints). One per primitive *per instance* is what
   * puts a crowd of characters into an out-of-memory crash — 150 skinned models
   * of a few primitives each is over a thousand buffers holding a thousand
   * copies of identical bytes.
   *
   * ── WHEN IT IS SAFE ───────────────────────────────────────────────────────
   * Only when the vertex data itself is shared, and nothing per-instance lives
   * on the buffer.
   *
   * 1. **The data must be shared.** With GPU skinning the buffer is filled from
   *    `mesh.drawVertsOrig`, which `sharedOrCopy()` in gltfModel hands out as the
   *    *same* Float32Array for every instance (the parsed glTF lives on the
   *    sdkType). Bones deform it in the vertex shader, so it is never rewritten
   *    — note that `updateVertexData()` is only ever called on the `!gpuSkinning`
   *    path. With CPU skinning the buffer is filled from `mesh.drawVerts`, which
   *    is a per-instance array that gets re-uploaded every frame.
   *
   *    Keying the cache on the identity of the vertex array makes this
   *    self-enforcing rather than assumed: a per-instance array is a distinct
   *    key, so it simply gets its own buffer.
   *
   * 2. **`this.nodeXform` must be unused.** It is the one genuinely per-instance
   *    field, and sharing would let one instance clobber another's — invisibly,
   *    since draws are deferred to flush time, so *every* sharer would end up
   *    using whichever value was written last. `_drawNow` only reads it on the
   *    non-skinning path, so sharing is restricted to primitives that actually
   *    carry JOINTS/WEIGHTS. `setNodeXform` is a no-op on a shared buffer, and
   *    `uploadNodeXformUniforms` warns if one ever reaches it anyway.
   *
   * Anything not meeting both conditions falls through to a plain per-instance
   * buffer, i.e. exactly the previous behaviour.
   *
   * Per-instance state that is *not* on the buffer and so needs nothing here:
   * bone matrices (per-instance BoneBuffer UBO), instance tint (an argument to
   * `draw()`), and mesh visibility (`drawMeshes[j].disabled`, checked by the
   * caller). Different instances can therefore share geometry while still
   * playing different animations, wearing different skins and showing different
   * sub-meshes.
   */
  static acquire(renderer, mesh, primitiveIndex, gpuSkinning) {
    if (!ObjectBufferTop.isSharingEnabled() || !ObjectBufferTop._isShareable(mesh, primitiveIndex, gpuSkinning)) {
      ObjectBufferTop.stats.unshared++
      return new ObjectBufferTop(renderer, mesh, primitiveIndex, gpuSkinning)
    }

    const vertexData = mesh.drawVertsOrig[primitiveIndex]
    const indexData = mesh.drawIndices[primitiveIndex]

    // Outer key is weak so a model unloading drops its whole cache line with it.
    // Inner key distinguishes primitives that happen to share a POSITION accessor.
    let byIndexData = ObjectBufferTop._cache.get(vertexData)
    if (!byIndexData) {
      byIndexData = new Map()
      ObjectBufferTop._cache.set(vertexData, byIndexData)
    }

    let buffer = byIndexData.get(indexData)
    if (buffer) {
      buffer._refs++
      ObjectBufferTop.stats.reused++
      return buffer
    }

    buffer = new ObjectBufferTop(renderer, mesh, primitiveIndex, gpuSkinning)
    buffer._shared = true
    buffer._refs = 1
    buffer._shareKey = { vertexData, indexData }
    byIndexData.set(indexData, buffer)
    ObjectBufferTop.stats.created++
    return buffer
  }

  /** Runtime kill-switch, for A/B testing against per-instance allocation. */
  static isSharingEnabled() {
    return globalThis.C3_3DOBJECT_SHARE_BUFFERS !== false
  }

  static _isShareable(mesh, primitiveIndex, gpuSkinning) {
    if (!gpuSkinning) return false
    // Both conditions from acquire()'s doc comment: shared source data, and a
    // skinned primitive (so `nodeXform` is never read at draw time).
    return !!(
      mesh.drawVertsOrig &&
      mesh.drawVertsOrig[primitiveIndex] &&
      mesh.drawIndices &&
      mesh.drawIndices[primitiveIndex] &&
      mesh.drawWeights &&
      mesh.drawWeights[primitiveIndex] &&
      mesh.drawJoints &&
      mesh.drawJoints[primitiveIndex]
    )
  }

  _ExecuteBatch(renderer) {
    if (renderer._batchPtr === 0) {
      return
    }
    if (renderer.IsContextLost()) return
    // renderer._WriteBuffers()
    renderer._ExecuteBatch()
    renderer._batchPtr = 0
    renderer._vertexPtr = 0
    renderer._texPtr = 0
    renderer._pointPtr = 0
    renderer._topOfBatch = 0
  }

  createVao(renderer) {
    const gl = renderer._gl
    const batchState = renderer._batchState
    const shaderProgram = batchState.currentShader._shaderProgram
    this.locAPos = globalThis.uniformCache.getAttributeLocation(gl, shaderProgram, "aPos")
    this.locATex = globalThis.uniformCache.getAttributeLocation(gl, shaderProgram, "aTex")
    this.locAColor = globalThis.uniformCache.getAttributeLocation(gl, shaderProgram, "aColor")
    this.locANormal = globalThis.uniformCache.getAttributeLocation(gl, shaderProgram, "aNormal")
    this.locAWeights = globalThis.uniformCache.getAttributeLocation(gl, shaderProgram, "aWeights")
    this.locAJoints = globalThis.uniformCache.getAttributeLocation(gl, shaderProgram, "aJoints")
    this.locHasVertexColors = globalThis.uniformCache.getLocation(gl, shaderProgram, "uHasVertexColors")
    
    // Get color uniform locations for 3DObject compatibility
    this.locUseUniformColor = globalThis.uniformCache.getLocation(gl, shaderProgram, "uUseUniformColor")
    this.locObjectColor = globalThis.uniformCache.getLocation(gl, shaderProgram, "uObjectColor")
    
    // Debug logging for uniform availability
    if (this.locUseUniformColor === null) {
      console.warn("[3DObject] uUseUniformColor uniform not found in shader")
    }
    if (this.locObjectColor === null) {
      console.warn("[3DObject] uObjectColor uniform not found in shader")
    }

    const locAPos = this.locAPos
    const locATex = this.locATex
    const locAColor = this.locAColor
    const locANormal = this.locANormal
    const locAWeights = this.locAWeights
    const locAJoints = this.locAJoints
    const vB = this.vertexBuffer
    const tB = this.texcoordBuffer
    const cB = this.colorBuffer
    const nB = this.normalBuffer
    const jB = this.jointsBuffer
    const wB = this.weightsBuffer

    if (locAJoints == -1) {
      console.error("locAJoints == -1")
    }

    if (locAWeights == -1) {
      console.error("locAWeights == -1")
    }
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)

    gl.bindBuffer(gl.ARRAY_BUFFER, vB)
    gl.vertexAttribPointer(locAPos, 3, gl.FLOAT, false, 0, 0)
    gl.enableVertexAttribArray(locAPos)
    gl.bindBuffer(gl.ARRAY_BUFFER, tB)
    gl.vertexAttribPointer(locATex, 2, gl.FLOAT, false, 0, 0)
    gl.enableVertexAttribArray(locATex)
    // Store whether this object has vertex colors for use in draw()
    this.hasVertexColors = (cB != null && locAColor != -1)
    
    if (this.hasVertexColors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cB)
      gl.vertexAttribPointer(locAColor, 3, gl.FLOAT, false, 0, 0)
      gl.enableVertexAttribArray(locAColor)
    }
    if (nB != null && locANormal != -1) {
      gl.bindBuffer(gl.ARRAY_BUFFER, nB)
      gl.vertexAttribPointer(locANormal, 3, gl.FLOAT, false, 0, 0)
      gl.enableVertexAttribArray(locANormal)
    }
    if (wB != null && locAWeights != -1) {
      gl.bindBuffer(gl.ARRAY_BUFFER, wB)
      gl.vertexAttribPointer(locAWeights, 4, gl.FLOAT, false, 0, 0)
      gl.enableVertexAttribArray(locAWeights)
    }
    if (jB != null && locAJoints != -1) {
      gl.bindBuffer(gl.ARRAY_BUFFER, jB)
      gl.vertexAttribPointer(locAJoints, 4, gl.FLOAT, false, 0, 0)
      gl.enableVertexAttribArray(locAJoints)
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)

    gl.bindVertexArray(null)

    return vao
  }

  uploadNodeXformUniforms(renderer) {
    // Reaching here on a shared buffer means acquire()'s second precondition is
    // wrong for this model, and every sharer is about to draw with a stale
    // transform. Say so rather than shipping a subtle misplacement.
    if (this._shared && !ObjectBufferTop._warnedSharedNodeXform) {
      ObjectBufferTop._warnedSharedNodeXform = true
      console.warn(
        "3DObject: a shared ObjectBuffer reached uploadNodeXformUniforms; " +
          "its nodeXform is not per-instance. Set globalThis.C3_3DOBJECT_SHARE_BUFFERS = false to fall back."
      )
    }

    const gl = renderer._gl
    const shaderProgram = renderer._batchState.currentShader._shaderProgram
    const locUNodeXform = globalThis.uniformCache.getLocation(gl, shaderProgram, "uNodeXform")
    gl.uniformMatrix4fv(locUNodeXform, false, this.nodeXform)

    const locUNodeXformEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uNodeXformEnable")
    gl.uniform1f(locUNodeXformEnable, 1.0)
  }

  /**
   * Draw this primitive.
   *
   * Prefers queueing the GL work into C3's batch command list (see
   * deferredBatch.js) so the batch never has to be flushed. Flushing here is
   * the fallback for WebGPU or when the deferral is switched off, and it is
   * expensive: it costs four bufferSubData uploads plus a command-list walk,
   * per primitive, per instance, and it truncates every other object's batch
   * as a side effect.
   */
  draw(renderer, instanceBoneBuffer, modelGltfData, instanceColor = null) {
    const DeferredBatch = globalThis.DeferredBatch

    if (DeferredBatch && DeferredBatch.install(renderer) && DeferredBatch.isEnabled()) {
      const job = DeferredBatch.push(
        renderer,
        ObjectBufferTop.prototype._drawNow,
        this,
        renderer,
        instanceBoneBuffer,
        modelGltfData
      )
      // instanceColor is a scratch array the caller rewrites per mesh, so it
      // has to be copied rather than referenced.
      job._c3obj_d = instanceColor ? DeferredBatch.scratch(job, 1, 4, instanceColor) : null
      return
    }

    this._ExecuteBatch(renderer) // Flushes any pending C3 draw calls
    this._drawNow(renderer, instanceBoneBuffer, modelGltfData, instanceColor)
  }

  /**
   * The actual GL work. Runs at flush time when deferred, which is also when
   * `renderer._batchState.currentShader` is accurate — `DoSetProgram` sets it
   * as the command list executes, so reading it here is correct where reading
   * it at record time would not be.
   */
  _drawNow(renderer, instanceBoneBuffer, modelGltfData, instanceColor = null) {
    const gl = renderer._gl;

    if (this.vao === null) {
      this.vao = this.createVao(renderer); // also resolves the color uniform locations
    }
    // Set color uniforms for 3DObject compatibility
    this._setColorUniforms(gl, instanceColor);
    gl.bindVertexArray(this.vao);

    if (instanceBoneBuffer && instanceBoneBuffer.skinAnimation) {
        // --- Skinning Path --- 
        const sharedModelUbo = modelGltfData ? modelGltfData.getOrCreateModelBoneUbo(renderer) : null;
        // instanceBoneBuffer.uploadUniforms handles UBO, skin flags, rootNodeXform, and dummy fallback
        instanceBoneBuffer.uploadUniforms(sharedModelUbo);
        // Note: NodeXform from ObjectBuffer is not used in the skinning path; uRootNodeXform from BoneBuffer is used.

    } else {
        // --- Non-Skinning Path (or no specific instanceBoneBuffer for skinning) ---
        let nodeXformUploadedByBoneBuffer = false;
        if (instanceBoneBuffer) { // E.g., a BoneBuffer present but skinAnimation is false
            instanceBoneBuffer.uploadUniformsNonSkin(renderer);
            // uploadUniformsNonSkin handles dummy UBO, skin disable, UV xform, and also uploads BoneBuffer.nodeXform if present.
            if (instanceBoneBuffer.nodeXform) {
                 nodeXformUploadedByBoneBuffer = true; // Assume BoneBuffer handled nodeXform if it has one
            }
        } else {
            // No BoneBuffer instance provided at all.
            // ObjectBuffer must handle UV transforms and potentially dummy UBO for "Bones" block.
            this._disableGPUSkinning(renderer);

            // Manually handle dummy UBO binding if shader expects "Bones" and no BoneBuffer did it.
            const shaderProgram = renderer._batchState.currentShader._shaderProgram;
            // Check if globalThis.BoneBuffer (the class) exists before accessing its static members
            if (globalThis.BoneBuffer) { // Check if BoneBuffer class is available
                const blockIndex = globalThis.uniformCache.getUniformBlockIndex(gl, shaderProgram, "Bones");
                if (blockIndex !== gl.INVALID_INDEX && blockIndex !== -1) { // Shader expects the Bones UBO
                    gl.uniformBlockBinding(shaderProgram, blockIndex, globalThis.BoneBuffer.BONE_UBO_BINDING_POINT);
                    const dummyUBO = globalThis.BoneBuffer._getOrCreateDummyUBO(gl);
                    if (dummyUBO) {
                        gl.bindBufferBase(gl.UNIFORM_BUFFER, globalThis.BoneBuffer.BONE_UBO_BINDING_POINT, dummyUBO);
                    }
                    // Ensure uSkinEnable is off if we bound a dummy here.
                    // This might be redundant if the shader properly defaults or if uSkinEnable is always set.
                    const locUSkinEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uSkinEnable");
                    if (locUSkinEnable) gl.uniform1f(locUSkinEnable, 0.0);
                } else {
                    // Shader does not expect "Bones" block, do nothing for UBO.
                }
            } else {
                 // BoneBuffer class not globally available, cannot manage dummy UBO here.
                 // Check if shader expects it and warn if so, as it might lead to issues.
                 const blockIndex = globalThis.uniformCache.getUniformBlockIndex(gl, shaderProgram, "Bones");
                 if (blockIndex !== gl.INVALID_INDEX && blockIndex !== -1) {
                    console.warn("ObjectBuffer: globalThis.BoneBuffer not found, cannot bind dummy UBO even though shader expects 'Bones' block.");
                 }
            }
        }

        // Upload node transform if not handled by a BoneBuffer instance (non-skinned path)
        if (!nodeXformUploadedByBoneBuffer) {
            if (this.gpuSkinning) {
              this.uploadNodeXformUniforms(renderer);
            }
        }
    }

    // --- Draw Call (Common for all paths) ---
    gl.drawElements(gl.TRIANGLES, this.indexDataLength, gl.UNSIGNED_SHORT, 0);

    // Unbind VAO once after all drawing paths
    gl.bindVertexArray(null);
    // Note: UBO unbinding from the binding point (BoneBufferTop.BONE_UBO_BINDING_POINT)
    // is implicitly handled by the next bindBufferBase or if nothing else binds to it.
    // No explicit unbind is strictly necessary here for bindBufferBase.
  }

  _disableGPUSkinning(renderer) {
    const gl = renderer._gl;
    const shaderProgram = renderer._batchState.currentShader._shaderProgram;
    const locUSkinEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uSkinEnable");
    const locUNodeXformEnable = globalThis.uniformCache.getLocation(gl, shaderProgram, "uNodeXformEnable");
    if (locUSkinEnable) gl.uniform1f(locUSkinEnable, 0.0);
    if (locUNodeXformEnable) gl.uniform1f(locUNodeXformEnable, 0.0);
  }

  // Helper method for setting color uniforms for 3DObject instance tinting
  _setColorUniforms(gl, instanceColor) {
    try {
      // Enable 3DObject uniform color mode
      if (this.locUseUniformColor !== null) {
        gl.uniform1f(this.locUseUniformColor, 1.0);
      }
      
      // Set whether this object has vertex colors
      if (this.locHasVertexColors !== null) {
        gl.uniform1f(this.locHasVertexColors, this.hasVertexColors ? 1.0 : 0.0);
      }
      
      // Set instance color if provided
      if (this.locObjectColor !== null) {
        if (instanceColor && instanceColor.length >= 4) {
          gl.uniform4fv(this.locObjectColor, instanceColor);
        } else {
          // Default to white/opaque if no color provided
          gl.uniform4f(this.locObjectColor, 1.0, 1.0, 1.0, 1.0);
        }
      }
    } catch (e) {
      console.warn("[3DObject] Error setting color uniforms:", e);
    }
  }


  createDefaultTexcoordData(length) {
    const texcoordData = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      texcoordData[i] = 0.5
    }
    return texcoordData
  }

  setNodeXform(nodeXform) {
    // A shared buffer has no single owner to hold this for, and nothing reads it
    // on the skinned path it is restricted to. Dropping the write keeps one
    // instance from silently overwriting another's — see acquire().
    if (this._shared) return
    this.nodeXform = nodeXform
  }

  updateVertexData(renderer, mesh, primitiveIndex) {
    const gl = renderer._gl
    const vertexData = mesh.drawVerts[primitiveIndex]

    // Fill only vertex buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW)
  }

  release() {
    // Shared buffers outlive the instance that happened to release first.
    if (--this._refs > 0) return
    if (this._shareKey) {
      const byIndexData = ObjectBufferTop._cache.get(this._shareKey.vertexData)
      if (byIndexData) byIndexData.delete(this._shareKey.indexData)
      this._shareKey = null
      this._shared = false
    }

    const gl = this.gl
    if (this.vertexBuffer) {
      gl.deleteBuffer(this.vertexBuffer)
      this.vertexBuffer = null
    }
    if (this.texcoordBuffer) {
      gl.deleteBuffer(this.texcoordBuffer)
      this.texcoordBuffer = null
    }
    if (this.indexBuffer) {
      gl.deleteBuffer(this.indexBuffer)
      this.indexBuffer = null
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao)
      this.vao = null
    }
    if (this.colorBuffer) {
      gl.deleteBuffer(this.colorBuffer)
      this.colorBuffer = null
    }
    if (this.normalBuffer) {
      gl.deleteBuffer(this.normalBuffer)
      this.normalBuffer = null
    }
    if (this.weightsBuffer) {
      gl.deleteBuffer(this.weightsBuffer)
      this.weightsBuffer = null
    }
    if (this.jointsBuffer) {
      gl.deleteBuffer(this.jointsBuffer)
      this.jointsBuffer = null
    }
    this.gl = null
    this.vertexData = null
    this.texcoordData = null
    this.indexData = null
    this.colorData = null
    this.normalData = null
    this.weightsData = null
    this.jointsData = null
    this.locAPos = null
    this.locATex = null
    this.locAColor = null
    this.locANormal = null
    this.locAWeights = null
    this.locAJoints = null
    this.nodeXform = null
    this.vao = null
  }
}

/** vertex data array → (index data array → shared ObjectBuffer). See acquire(). */
ObjectBufferTop._cache = new WeakMap()
ObjectBufferTop._warnedSharedNodeXform = false

/**
 * How buffer sharing is doing.
 *
 *   ObjectBuffer.stats   // { created, reused, unshared }
 *
 * `created` is the number of distinct shared primitives, `reused` the number of
 * allocations avoided, `unshared` the primitives that fell back to a buffer of
 * their own (all CPU-skinned and all non-skinned ones). With a crowd of one
 * character model, `reused` should be roughly instances × primitives and
 * `created` should stay in the single digits.
 */
ObjectBufferTop.stats = { created: 0, reused: 0, unshared: 0 }
ObjectBufferTop.resetStats = function () {
  ObjectBufferTop.stats.created = 0
  ObjectBufferTop.stats.reused = 0
  ObjectBufferTop.stats.unshared = 0
}

// @ts-ignore
if (!globalThis.ObjectBuffer) {
  globalThis.ObjectBuffer = ObjectBufferTop
}
