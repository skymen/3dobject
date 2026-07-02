// @ts-check
"use strict"
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
    this.getPolygons(this.inst.staticGeometry, this.inst.gpuSkinning)
    if (!this.inst.isEditor) this.inst.initBoundingBox()
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

  render(renderer, x, y, z, tempQuad, whiteTexture, instanceC3Color, textures, opacity) {
    if (opacity === 0) return
    if (!this.inst.isEditor) renderer.EndBatch()

    let totalTriangles = 0
    let currentColor = [-1, -1, -1, -1]
    let currentTexture = null
    const rendererVertexData = renderer._vertexData
    const rendererTexcoordData = renderer._texcoordData

    const vec4 = globalThis.glMatrix3D.vec4
    const vec3 = globalThis.glMatrix3D.vec3
    const mat4 = globalThis.glMatrix3D.mat4
    const quat = globalThis.glMatrix3D.quat

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
      mat4.fromRotationTranslationScaleOrigin(
        modelRotate,
        rotate,
        [x, y, z],
        [xScale, -yScale, zScale],
        this.inst.localCenter
      )
      mat4.copy(this.modelRotate, modelRotate)
      mat4.multiply(modelRotate, tmpModelView, modelRotate)
      renderer.SetModelViewMatrix(modelRotate)
      this.setVertexShaderModelRotate(renderer, this.modelRotate)
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
          this.setVertexShaderModelRotate(renderer, this.modelRotate)

          objectBuffers[i].draw(
            renderer,
            instanceBoneBuffer,
            this._sdkType.gltfData,
            currentColor // Pass calculated color to draw method
          )
          totalTriangles += objectBuffers[i].indexDataLength / 3
        }
        // XXX Perhaps too often, once per mesh, better to do once per model
        if (instanceBoneBuffer) {
          instanceBoneBuffer.disable(renderer)
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
            {
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

          {
            // Set base color
            renderer.SetColorRgba(currentColor[0], currentColor[1], currentColor[2], currentColor[3])

            renderer.Quad3D2(x0, y0, z0, x1, y1, z1, x2, y2, z2, x2, y2, z2, tempQuad, true)
          }
        }
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
      this.disableVertexShaderModelRotate(renderer)
      this._disableGPUSkinning(renderer)
      this._resetColorUniforms(renderer)
      renderer.EndBatch()
    }

    // Restore attrib
    if (this.inst.staticGeometry) {
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
      renderer._vertexPtr = 0
      renderer._texPtr = 0
    }

    // --- Final Dummy UBO Bind (Cleanup) ---
    // After rendering all meshes, bind the dummy UBO in case subsequent C3 rendering
    // uses a shader that expects the 'Bones' block.
    // @ts-ignore
    if (!this.inst.isEditor && globalThis.BoneBuffer) {
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
    // --- End Final Dummy UBO Bind ---
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

        for (let j = 0; j < posData.length / 3; j++) {
          if (gpuSkinning) continue
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
            if (transformedVerts.length > 0) drawVerts.push(transformedVerts)
            // Attribute data is immutable and shared across instances; only copy when
            // a type conversion is actually needed
            const sharedOrCopy = (data, Type) => (data instanceof Type ? data : new Type(data))
            // Only need to set once for all the below
            if (drawUVs.length === 0 && "TEXCOORD_0" in node.mesh.primitives[i].attributes) {
              drawUVs.push(sharedOrCopy(node.mesh.primitives[i].attributes.TEXCOORD_0.data, Float32Array))
            }
            if (gpuSkinning && drawVertsOrig.length === 0 && "POSITION" in node.mesh.primitives[i].attributes) {
              drawVertsOrig.push(sharedOrCopy(posData, Float32Array))
            }
            if (drawColors.length === 0 && "COLOR_0" in node.mesh.primitives[i].attributes) {
              drawColors.push(sharedOrCopy(node.mesh.primitives[i].attributes.COLOR_0.data, Float32Array))
            }
            if (drawNormals.length === 0 && "NORMAL" in node.mesh.primitives[i].attributes) {
              drawNormals.push(sharedOrCopy(node.mesh.primitives[i].attributes.NORMAL.data, Float32Array))
            }

            if (drawIndices.length === 0)
              drawIndices.push(sharedOrCopy(node.mesh.primitives[i].indices.data, Uint16Array))
            if (staticGeometry) {
              if (objectBuffers.length == 0) {
                objectBuffers.push(
                  new ObjectBuffer(this.inst.renderer, this.drawMeshes[this.drawMeshesIndex], 0, gpuSkinning)
                )
              } else if (!gpuSkinning) {
                objectBuffers[0].updateVertexData(this.inst.renderer, this.drawMeshes[this.drawMeshesIndex], 0)
              }
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
  getPolygons(staticGeometry = false, gpuSkinning = false) {
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
        let weights = node.mesh.primitives[i].attributes.WEIGHTS_0.data
        let joints = node.mesh.primitives[i].attributes.JOINTS_0.data
        // Reuse the per-mesh output array instead of allocating every tick
        const skinnedDrawMesh = this.drawMeshes[this.drawMeshesIndex]
        let transformedVerts = skinnedDrawMesh._transformedVerts
        if (!transformedVerts || transformedVerts.length !== posData.length) {
          transformedVerts = skinnedDrawMesh._transformedVerts = new Float32Array(posData.length)
        }

        for (let j = 0; j < posData.length / 3; j++) {
          if (gpuSkinning) continue
          let w = weights.subarray(j * 4, j * 4 + 4)
          let b = joints.subarray(j * 4, j * 4 + 4)
          let vin = posData.subarray(j * 3, j * 3 + 3)
          let v = [0, 0, 0],
            vsum = [0, 0, 0]

          if (morphActive) {
            vin = this.morphTargets(vin, j, morphWeights, morphTargets)
          }

          for (let i = 0; i < 4; i++) {
            vec3.transformMat4(v, vin, node.skin.joints[b[i]].boneMatrix)
            // mat4.multiplyVec3(node.skin.joints[b[i]].boneMatrix, vin, v);
            vec3.scale(v, v, w[i])
            // vec3.scale(v, w[i]);
            vec3.add(vsum, vsum, v)
            // vec3.add(vsum, v);
          }

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
            // Attribute data is immutable and shared across instances; only copy when
            // a type conversion is actually needed
            const sharedOrCopy = (data, Type) => (data instanceof Type ? data : new Type(data))
            // Only need to set once
            if (drawUVs.length === 0 && "TEXCOORD_0" in node.mesh.primitives[i].attributes) {
              drawUVs.push(sharedOrCopy(node.mesh.primitives[i].attributes.TEXCOORD_0.data, Float32Array))
            }
            if (gpuSkinning && drawVertsOrig.length === 0 && "POSITION" in node.mesh.primitives[i].attributes) {
              drawVertsOrig.push(sharedOrCopy(posData, Float32Array))
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
            if (drawIndices.length === 0)
              drawIndices.push(sharedOrCopy(node.mesh.primitives[i].indices.data, Uint16Array))
            if (staticGeometry) {
              if (objectBuffers.length == 0) {
                objectBuffers.push(
                  new ObjectBuffer(this.inst.renderer, this.drawMeshes[this.drawMeshesIndex], 0, gpuSkinning)
                )
              } else if (!gpuSkinning) {
                objectBuffers[0].updateVertexData(this.inst.renderer, this.drawMeshes[this.drawMeshesIndex], 0)
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

  updateAnimationPolygons(index, time, onScreen, deltaTime, staticGeometry, gpuSkinning) {
    this.updateAnimation(index, time, onScreen, deltaTime)
    this.inst.updateBbox = true

    if (onScreen) {
      this.getPolygons(staticGeometry, gpuSkinning)
      this.inst.runtime.UpdateRender()
    }
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
