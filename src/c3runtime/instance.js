"use strict"
{
  const C3 = self.C3

  C3.Plugins.Mikal_3DObject.Instance = class Object3DInstance extends C3.SDKWorldInstanceBase {
    constructor(inst, properties) {
      super(inst)
      this.sdkType = this.GetSdkType()
      this.runtime = inst.GetRuntime()
      this.renderer = this.runtime.GetCanvasManager().GetRenderer()
      this.isWebGPU = this.renderer.IsWebGPU()
      this.uid = this.GetInstance().GetUID()
      this.loaded = false
      this.animationTime = 0
      this.animationIndex = 0
      this.animationSpeed = 1
      this.animationLastTime = 0
      this.animationRate = 60
      this.animationLoop = true
      this.animationPlay = true
      this.animationFinished = false
      this.animationName = ""
      this.xScale = 1
      this.yScale = 1
      this.zScale = 1
      this.debug = false
      this.renderOnce = false
      this.currentAnimationTime = 0
      this.currentAnimationFrame = 0
      this.minBB = [0, 0, 0]
      this.maxBB = [0, 0, 0]
      this.updateBbox = true
      this.xMinBB = [0, 0, 0]
      this.xMaxBB = [0, 0, 0]
      this.bboxScale = 1
      this.animationNameFinished = ""
      this.totalTriangles = 0
      this.staticGeometry = false
      this.gpuSkinning = false
      this.animationOffset = 0
      this.allNodesDisabled = false
      this.useBoneBoundingBox = true // When true, use bone-based bbox; when false, use static bbox
      this._released = false
      this._drewCustomBuffers = false

      // Track last position for detecting position changes
      this._lastX = 0
      this._lastY = 0
      this._lastZ = 0

      if (properties) {
        // Runtime property indices (the editor "link" property is not present here,
        // so indices are shifted by one vs plugin.js). Frozen for project
        // compatibility — several ids no longer match their meaning:
        //   [1]  "z-elevation"  — obsolete, ignored (historically misread as cpuXform)
        //   [5]  "rotation-order" — stored but not honored at runtime
        //   [9]  "instance-model", [10] "image-texture", [14] "wireframe" — features
        //        removed in the UTRS trim; values ignored
        //   [16] id "cpu-xform", labeled "Worker BFC" — historically backFaceCull;
        //        the light-culling consumer was removed, value ignored
        const scaleValue = parseFloat(properties[0])
        this.scale = isNaN(scaleValue) ? 1 : scaleValue
        this.xAngle = properties[2]
        this.yAngle = properties[3]
        this.zAngle = properties[4]
        this.rotationOrder = properties[5]
        this.gltfPath = properties[6]
        this.debug = properties[7]
        this.animationBlend = properties[8]
        this.xScale = properties[11]
        this.yScale = properties[12]
        this.zScale = properties[13]
        this.workerAnimation = properties[15]
        this.useBoneBoundingBox = properties[17] !== false // Default to true
        if (properties[18] === true) {
          // GPU skinning known at creation: bones-only worker payload, static geometry path
          this.gpuSkinning = true
          this.staticGeometry = true
        }
      }

      this.localCenter = [0, 0, 0]

      // Model data is loaded once per object type (shared via the cross-type cache)
      {
        let sdkType = this.sdkType
        if (sdkType.initOwner == -1) {
          sdkType.initOwner = this.uid
          if (this.gltfPath && this.gltfPath != "path") {
            sdkType.gltfData.load(this.gltfPath, true, this.debug)
          }
        }
      }

      this._StartTicking()
    }

    async doInit() {
      const wi = this.GetWorldInfo()
      if (this.workerAnimation) {
        this.gltf = new globalThis.GltfModelW(this._runtime, this.sdkType, this)
      } else {
        this.gltf = new globalThis.GltfModel(this._runtime, this.sdkType, this)
      }
      await this.gltf.init()
      // Instance may have been destroyed while init was awaiting
      if (this._released) return

      // If needed load textures
      if (this.sdkType.gltfData.dynamicTexturesLoaded !== true) {
        this.sdkType
          .LoadDynamicTextures(this.renderer, this.sdkType.gltfData, this.sdkType.texture, this.sdkType)
          .catch((err) => console.error("[3DObject] texture load failed", err))
      }

      this.loaded = true
      this.renderOnce = true
      this.runtime.UpdateRender()
      if (this.gltf.getAnimationNames().length > 0) {
        this.animationName = this.gltf.getAnimationNames()[0]
      }
      this.gltf.updateModelRotate(wi.GetX(), wi.GetY(), wi.GetTotalZElevation())
      this._updateBoundingBox(wi.GetX(), wi.GetY(), 0, this.gpuSkinning)

      // Initialize position tracking
      this._lastX = wi.GetX()
      this._lastY = wi.GetY()
      this._lastZ = wi.GetTotalZElevation()

      this.Trigger(C3.Plugins.Mikal_3DObject.Cnds.OnLoaded)
    }

    IsOnScreen() {
      const wi = this.GetWorldInfo()
      const layer = wi.GetLayer()
      if (layer.Has3DCamera()) return wi.IsInViewport3D(layer._GetViewFrustum())
      else
        return wi.IsInViewport(
          layer.GetViewport(),
          wi.GetLayout().HasVanishingPointOutsideViewport(),
          wi.GetLayout().IsOrthographicProjection()
        )
    }

    Tick() {
      const onScreen = this.IsOnScreen()

      // Detect position changes (x, y, zElevation) and trigger bbox update
      if (this.loaded) {
        const wi = this.GetWorldInfo()
        const x = wi.GetX()
        const y = wi.GetY()
        const z = wi.GetTotalZElevation()

        if (x !== this._lastX || y !== this._lastY || z !== this._lastZ) {
          this._lastX = x
          this._lastY = y
          this._lastZ = z
          this.updateBbox = true
        }
      }

      if (!this.loaded) {
        if (this.sdkType.dataLoaded) {
          if (!this.doingInit) {
            this.doingInit = true
            this.doInit().catch((err) => {
              if (!this._released) console.error("[3DObject] doInit failed", err)
            })
          }
        }
      }

      // Animate gltf model
      if (this.loaded) {
        if (this.animationPlay && this.gltf.gltfData.hasOwnProperty("animations")) {
          this.animationTime +=
            this._runtime.GetDt() * this.animationSpeed +
            (Math.random() * (1 / this.animationRate) - 1 / this.animationRate / 2) * 0.1
          const deltaTime = this.animationTime - this.animationLastTime
          if (deltaTime >= 1 / this.animationRate) {
            this.animationLastTime = this.animationTime
            this.gltf.updateAnimationPolygons(
              this.animationIndex,
              this.animationTime,
              onScreen,
              deltaTime,
              this.staticGeometry,
              this.gpuSkinning
            )
          }
          this.renderOnce = false
          // } else if (this.renderOnce || (this.workerAnimation))
        } else if (this.renderOnce) {
          this.renderOnce = false
          this.gltf.getPolygons(this.staticGeometry || this.gpuSkinning, this.gpuSkinning)
          this.runtime.UpdateRender()
          this.updateBbox = true
        }
      }

      // Update transformed bounding box (xMinBB/xMaxBB) even when offscreen
      // This ensures bbox values are always up-to-date for visibility testing
      // and for external queries (e.g., getObjectBounds)
      if (this.updateBbox && this.loaded && this.gltf?.modelRotate) {
        const wi = this.GetWorldInfo()
        const x = wi.GetX()
        const y = wi.GetY()
        const z = wi.GetTotalZElevation()

        // Update modelRotate matrix first
        this.gltf.updateModelRotate(x, y, z)
        this._updateBoundingBox(x, y, z, this.gpuSkinning)
        wi.SetBboxChanged()
        this.updateBbox = false
      }

      // Restore the element array buffer, but only when we actually drew (our
      // static-geometry path rebinds it) and only on WebGL (no _gl on WebGPU)
      if (this._drewCustomBuffers && this.renderer._gl) {
        this.renderer._gl.bindBuffer(this.renderer._gl.ELEMENT_ARRAY_BUFFER, this.renderer._indexBuffer)
        this._drewCustomBuffers = false
      }
    }

    RendersToOwnZPlane() {
      return false
    }

    _setZHeight(h) {
      h = Math.max(h, 0)
      if (this._zHeight === h) return
      this._zHeight = h
      this.GetWorldInfo().SetDepth(h)
      this._runtime.UpdateRender()
    }

    Draw(renderer) {
      const imageInfo = this._objectClass.GetImageInfo()
      const texture = imageInfo.GetTexture()

      if (!texture) return // dynamic texture load which hasn't completed yet; can't draw anything
      if (!this.loaded) return

      const wi = this.GetWorldInfo()
      const x = wi.GetX()
      const y = wi.GetY()
      // z elevation handles offset on draw
      const z = wi.GetTotalZElevation()

      const textures = this.sdkType.texture
      const gltfData = this.sdkType.gltfData

      if (gltfData.dynamicTexturesLoaded !== true) {
        this.sdkType
          .LoadDynamicTextures(renderer, gltfData, textures, this.sdkType)
          .catch((err) => console.error("[3DObject] texture load failed", err))
      }

      if (Object.keys(textures).length === 0) {
        // Model has no materials: fall back to the object's image texture
        renderer.SetTexture(texture)
      }

      const tempQuad = C3.New(C3.Quad)
      if (this.loaded && this.gltfPath != "path") {
        // Ensure dedicated 3D shader program is ready; if not, kick off creation and skip this frame
        if (!globalThis.cached3DObjectShader) {
          if (globalThis.get3DObjectShaderProgram && !globalThis.cached3DObjectShaderPromise) {
            try {
              globalThis.cached3DObjectShaderPromise = globalThis.get3DObjectShaderProgram(renderer)
            } catch (e) {}
          }
          // Try again next frame
          this.runtime.UpdateRender()
          return
        }
        const originalProgram = renderer.GetProgram()
        renderer.SetProgram(globalThis.cached3DObjectShader)
        try {
          this.gltf.render(
            renderer,
            x,
            y,
            z,
            tempQuad,
            this.sdkType.whiteTexture,
            wi.GetPremultipliedColor(),
            textures,
            wi.GetOpacity()
          )
        } finally {
          if (originalProgram) renderer.SetProgram(originalProgram)
        }
        this._drewCustomBuffers = true

        if (this.updateBbox) {
          this._updateBoundingBox(x, y, z, this.gpuSkinning)
          wi.SetBboxChanged()
          this.updateBbox = false
        }
      }
    }

    initBoundingBox() {
      const wi = this.GetWorldInfo()
      const x = wi.GetX()
      const y = wi.GetY()
      // z elevation handles offset on draw
      const z = wi.GetTotalZElevation()
      this._updateBoundingBox(x, y, z, this.gpuSkinning)
      wi.SetBboxChanged()
      this.boundingBoxInit = true
    }

    _updateBoundingBox(x, y, z, gpuSkinning) {
      let maxBB = this.maxBB
      let minBB = this.minBB

      // For GPU skinning, minBB/maxBB aren't calculated from vertices, so use static model bbox
      // Also use static bbox if values are uninitialized (Infinity/-Infinity)
      const hasValidDynamicBbox = maxBB && minBB && maxBB[0] !== -Infinity && minBB[0] !== Infinity
      const useStaticBbox = gpuSkinning || !hasValidDynamicBbox

      if (useStaticBbox) {
        // Prefer the bounds of the currently ENABLED nodes (e.g. the active skin);
        // fall back to the whole-model bounds
        const enabled = this._enabledLocalBounds()
        if (enabled) {
          maxBB = enabled.max
          minBB = enabled.min
        } else if (this.gltf?.gltfData?.boundingBox) {
          maxBB = this.gltf.gltfData.boundingBox.max
          minBB = this.gltf.gltfData.boundingBox.min
        }
      }

      const cube = [
        [minBB[0], minBB[1], minBB[2]],
        [maxBB[0], minBB[1], minBB[2]],
        [maxBB[0], maxBB[1], minBB[2]],
        [minBB[0], maxBB[1], minBB[2]],
        [minBB[0], minBB[1], maxBB[2]],
        [maxBB[0], minBB[1], maxBB[2]],
        [maxBB[0], maxBB[1], maxBB[2]],
        [minBB[0], maxBB[1], maxBB[2]],
      ]
      const modelRotate = this.gltf.modelRotate
      if (!modelRotate) return

      this.xMinBB = [Infinity, Infinity, Infinity]
      this.xMaxBB = [-Infinity, -Infinity, -Infinity]
      const xMinBB = this.xMinBB
      const xMaxBB = this.xMaxBB
      const vec3 = globalThis.glMatrix3D.vec3

      const rotatedPoint = vec3.create()
      for (let i = 0; i < cube.length; i++) {
        const cubePoint = cube[i]
        const point = vec3.fromValues(cubePoint[0], cubePoint[1], cubePoint[2])
        vec3.transformMat4(rotatedPoint, point, modelRotate)
        if (xMinBB[0] > rotatedPoint[0]) xMinBB[0] = rotatedPoint[0]
        if (xMinBB[1] > rotatedPoint[1]) xMinBB[1] = rotatedPoint[1]
        if (xMinBB[2] > rotatedPoint[2]) xMinBB[2] = rotatedPoint[2]
        if (xMaxBB[0] < rotatedPoint[0]) xMaxBB[0] = rotatedPoint[0]
        if (xMaxBB[1] < rotatedPoint[1]) xMaxBB[1] = rotatedPoint[1]
        if (xMaxBB[2] < rotatedPoint[2]) xMaxBB[2] = rotatedPoint[2]
      }

      if (xMaxBB[0] != Infinity && xMinBB[0] != -Infinity && xMaxBB[1] != Infinity && xMinBB[1] != -Infinity) {
        const wi = this.GetWorldInfo()
        let width = xMaxBB[0] - xMinBB[0]
        let height = xMaxBB[1] - xMinBB[1]
        height = height == 0 ? 1 : height
        width = width == 0 ? 1 : width
        wi.SetSize(width * this.bboxScale, height * this.bboxScale)
        wi.SetOriginX(-(xMinBB[0] - x) / width)
        wi.SetOriginY(-(xMinBB[1] - y) / height)
        this._setZHeight((xMaxBB[2] - xMinBB[2]) * this.bboxScale)
      } else {
        const wi = this.GetWorldInfo()
        wi.SetSize(100 * this.bboxScale, 100 * this.bboxScale)
        wi.SetOriginX(0.5)
        wi.SetOriginY(0.5)
        this._setZHeight(100 * this.bboxScale)
        if (this.debug && !this.allNodesDisabled)
          console.warn("No min/max found in GLTF accessors. Bounding box dimensions set to default 100,100,100 values.")
      }
    }


    // ============================ Public geometry APIs ============================
    // All world-space getters refresh modelRotate first, so results reflect the
    // instance transform at call time. They return null/[] until the model loads.

    _refreshModelRotate() {
      if (!this.loaded || !this.gltf || !this.gltf.gltfData) return false
      const wi = this.GetWorldInfo()
      this.gltf.updateModelRotate(wi.GetX(), wi.GetY(), wi.GetTotalZElevation())
      return true
    }

    // Model-local bounding box (bind pose) in model units, INCLUDING node-chain
    // transforms (a mesh may sit under scaled/translated nodes; the raw accessor
    // min/max alone understates the real footprint). Skinned meshes contribute
    // their raw accessor bounds (bind pose; the node chain is not applied to
    // skinned vertices at render time). Computed once per model from the pristine
    // master graph (never animated) and cached on it.
    _localBoundingBox() {
      if (!this.loaded || !this.gltf?.gltfData) return null
      const master = this.sdkType?.gltfData?.gltf
      if (!master || !master.nodes) return null
      if (master._localBoundsCache !== undefined) {
        const c = master._localBoundsCache
        return c ? { min: c.min.slice(), max: c.max.slice() } : null
      }

      const mat4 = globalThis.glMatrix3D.mat4
      const vec3 = globalThis.glMatrix3D.vec3
      const outMin = [Infinity, Infinity, Infinity]
      const outMax = [-Infinity, -Infinity, -Infinity]
      const p = vec3.create()

      const addBounds = (min, max, matrix) => {
        for (let i = 0; i < 8; i++) {
          vec3.set(p, i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2])
          if (matrix) vec3.transformMat4(p, p, matrix)
          for (let a = 0; a < 3; a++) {
            if (p[a] < outMin[a]) outMin[a] = p[a]
            if (p[a] > outMax[a]) outMax[a] = p[a]
          }
        }
      }

      const local = mat4.create()
      const walk = (node, parentMatrix) => {
        mat4.fromRotationTranslationScale(
          local,
          node.rotation || [0, 0, 0, 1],
          node.translation || [0, 0, 0],
          node.scale || [1, 1, 1]
        )
        const world = mat4.create()
        if (parentMatrix) mat4.multiply(world, parentMatrix, local)
        else mat4.copy(world, local)
        if (node.mesh) {
          for (const primitive of node.mesh.primitives) {
            const pos = primitive.attributes && primitive.attributes.POSITION
            if (pos && pos.min && pos.max) {
              // Skinned vertices ignore the node chain at render time (bind pose)
              addBounds(pos.min, pos.max, node.skin ? null : world)
            }
          }
        }
        if (node.children) for (const child of node.children) walk(child, world)
      }
      if (master.scene && master.scene.nodes) {
        for (const node of master.scene.nodes) walk(node, null)
      }

      const valid = outMin.every(isFinite) && outMax.every(isFinite)
      master._localBoundsCache = valid ? { min: outMin, max: outMax } : null
      return valid ? { min: outMin.slice(), max: outMax.slice() } : null
    }

    // Local size and center offset in world units at per-axis scale 1. Matches the
    // contract of UTRS's hand-harvested MODEL_BASE_SIZES table: extents scaled by the
    // uniform scale property, with the renderer's Y mirror baked into oy.
    _getBaseSize() {
      const bb = this._localBoundingBox()
      if (!bb) return null
      const S = Number(this.scale) || 1
      const { min, max } = bb
      return {
        w: (max[0] - min[0]) * S,
        h: (max[1] - min[1]) * S,
        d: (max[2] - min[2]) * S,
        ox: ((min[0] + max[0]) / 2) * S,
        oy: (-(min[1] + max[1]) / 2) * S, // modelRotate negates Y scale
        oz: ((min[2] + max[2]) / 2) * S,
      }
    }

    // Fresh copy of the model->world matrix
    _getModelRotation() {
      if (!this._refreshModelRotate()) return null
      return new Float32Array(this.gltf.modelRotate)
    }

    // Oriented world bounds of the (bind-pose) local box under the current transform.
    // Corner index bits: bit0 -> X max, bit1 -> Y max, bit2 -> Z max of the LOCAL box.
    _getWorldBoundingBox() {
      const bb = this._localBoundingBox()
      if (!bb || !this._refreshModelRotate()) return null
      const vec3 = globalThis.glMatrix3D.vec3
      const m = this.gltf.modelRotate
      const { min, max } = bb
      const corners = []
      const aabbMin = [Infinity, Infinity, Infinity]
      const aabbMax = [-Infinity, -Infinity, -Infinity]
      const p = vec3.create()
      for (let i = 0; i < 8; i++) {
        vec3.set(p, i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2])
        vec3.transformMat4(p, p, m)
        corners.push([p[0], p[1], p[2]])
        for (let a = 0; a < 3; a++) {
          if (p[a] < aabbMin[a]) aabbMin[a] = p[a]
          if (p[a] > aabbMax[a]) aabbMax[a] = p[a]
        }
      }
      vec3.set(p, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
      vec3.transformMat4(p, p, m)
      return { corners, center: [p[0], p[1], p[2]], aabb: { min: aabbMin, max: aabbMax } }
    }

    // Name -> node and node -> parent maps, built once per instance (the node graph
    // is fixed after the per-instance clone)
    _ensureNodeMaps() {
      if (this._nodeByName) return true
      const gltf = this.gltf?.gltfData
      if (!gltf) return false
      const byName = new Map()
      const parent = new Map()
      if (gltf.nodes) {
        for (const node of gltf.nodes) {
          if (node.name && !byName.has(node.name)) byName.set(node.name, node)
        }
      }
      const walk = (nodes, from) => {
        if (!nodes) return
        for (const node of nodes) {
          if (from && !parent.has(node)) parent.set(node, from)
          if (node.children) walk(node.children, node)
        }
      }
      if (gltf.scene && gltf.scene.nodes) walk(gltf.scene.nodes, null)
      this._nodeByName = byName
      this._nodeParent = parent
      return true
    }

    // World matrix of a node composed from its TRS chain (never node.matrix, which is
    // stale on the main thread in worker mode), premultiplied by a fresh modelRotate
    _getNodeWorldTransform(nodeName) {
      if (!this._refreshModelRotate() || !this._ensureNodeMaps()) return null
      const node = this._nodeByName.get(nodeName)
      if (!node) return null
      const mat4 = globalThis.glMatrix3D.mat4
      const path = []
      let current = node
      while (current) {
        path.unshift(current)
        current = this._nodeParent.get(current)
      }
      const world = mat4.create()
      const local = mat4.create()
      for (const n of path) {
        mat4.fromRotationTranslationScale(local, n.rotation || [0, 0, 0, 1], n.translation || [0, 0, 0], n.scale || [1, 1, 1])
        mat4.multiply(world, world, local)
      }
      mat4.multiply(world, this.gltf.modelRotate, world)
      const quat = globalThis.glMatrix3D.quat
      const rotation = quat.create()
      const scale = [0, 0, 0]
      mat4.getRotation(rotation, world)
      mat4.getScaling(scale, world)
      return {
        position: [world[12], world[13], world[14]],
        // NOTE: modelRotate mirrors Y (negative determinant); quaternion/scale are
        // correct only up to that mirror — matrix is the ground truth
        matrix: world,
        quaternion: [rotation[0], rotation[1], rotation[2], rotation[3]],
        scale: [scale[0], scale[1], scale[2]],
      }
    }

    _getNodeWorldPosition(nodeName) {
      const t = this._getNodeWorldTransform(nodeName)
      return t ? t.position : null
    }

    // Zero-copy access to the shared bind-pose geometry. positions/indices are the
    // SHARED accessor arrays — callers must not mutate them.
    _getGeometry() {
      const gltf = this.gltf?.gltfData
      if (!this.loaded || !gltf || !gltf.nodes) return []
      const out = []
      for (const node of gltf.nodes) {
        if (!node.mesh) continue
        for (const primitive of node.mesh.primitives) {
          const pos = primitive.attributes && primitive.attributes.POSITION
          if (!pos || !pos.data || !primitive.indices || !primitive.indices.data) continue
          out.push({
            nodeName: node.name,
            positions: pos.data,
            indices: primitive.indices.data,
            skinned: !!node.skin,
            disabled: !!node.disabled,
          })
        }
      }
      return out
    }

    // World-space triangles of enabled nodes as [ {x,y,z} x3 ] entries. Skinned nodes
    // use the bind pose (posed vertices only exist on the GPU under GPU skinning).
    _getWorldTriangles() {
      const entries = this._getGeometry()
      if (!entries.length || !this._refreshModelRotate() || !this._ensureNodeMaps()) return []
      const vec3 = globalThis.glMatrix3D.vec3
      const mat4 = globalThis.glMatrix3D.mat4
      const modelRotate = this.gltf.modelRotate
      const local = mat4.create()
      const full = mat4.create()
      const p = vec3.create()
      const triangles = []
      for (const entry of entries) {
        if (entry.disabled) continue
        if (entry.skinned) {
          mat4.copy(full, modelRotate)
        } else {
          // Compose the node's TRS chain (bind/animated local pose)
          const node = this._nodeByName.get(entry.nodeName)
          mat4.identity(full)
          const path = []
          let current = node
          while (current) {
            path.unshift(current)
            current = this._nodeParent.get(current)
          }
          const chain = mat4.create()
          for (const n of path) {
            mat4.fromRotationTranslationScale(local, n.rotation || [0, 0, 0, 1], n.translation || [0, 0, 0], n.scale || [1, 1, 1])
            mat4.multiply(chain, chain, local)
          }
          mat4.multiply(full, modelRotate, chain)
        }
        const positions = entry.positions
        const indices = entry.indices
        for (let i = 0; i + 2 < indices.length; i += 3) {
          const tri = new Array(3)
          for (let v = 0; v < 3; v++) {
            const base = indices[i + v] * 3
            vec3.set(p, positions[base], positions[base + 1], positions[base + 2])
            vec3.transformMat4(p, p, full)
            tri[v] = { x: p[0], y: p[1], z: p[2] }
          }
          triangles.push(tri)
        }
      }
      return triangles
    }

    // Local bounds of ENABLED nodes only (bind pose), used for the GPU-skinning
    // bounding box so a character shows the box of its active skin rather than the
    // union of every variant. Cached; invalidated when nodes are toggled.
    _enabledLocalBounds() {
      if (this._enabledBoundsCache !== undefined) return this._enabledBoundsCache
      const gltf = this.gltf?.gltfData
      if (!gltf || !gltf.nodes || !this._ensureNodeMaps()) return null
      const mat4 = globalThis.glMatrix3D.mat4
      const vec3 = globalThis.glMatrix3D.vec3
      const mn = [Infinity, Infinity, Infinity]
      const mx = [-Infinity, -Infinity, -Infinity]
      const p = vec3.create()
      const local = mat4.create()
      const chain = mat4.create()
      for (const node of gltf.nodes) {
        if (!node.mesh || node.disabled) continue
        let matrix = null
        if (!node.skin) {
          // Unskinned meshes render through their node chain
          mat4.identity(chain)
          const path = []
          let current = node
          while (current) {
            path.unshift(current)
            current = this._nodeParent.get(current)
          }
          for (const n of path) {
            mat4.fromRotationTranslationScale(local, n.rotation || [0, 0, 0, 1], n.translation || [0, 0, 0], n.scale || [1, 1, 1])
            mat4.multiply(chain, chain, local)
          }
          matrix = chain
        }
        for (const primitive of node.mesh.primitives) {
          const pos = primitive.attributes && primitive.attributes.POSITION
          if (!pos || !pos.min || !pos.max) continue
          for (let i = 0; i < 8; i++) {
            vec3.set(p, i & 1 ? pos.max[0] : pos.min[0], i & 2 ? pos.max[1] : pos.min[1], i & 4 ? pos.max[2] : pos.min[2])
            if (matrix) vec3.transformMat4(p, p, matrix)
            for (let a = 0; a < 3; a++) {
              if (p[a] < mn[a]) mn[a] = p[a]
              if (p[a] > mx[a]) mx[a] = p[a]
            }
          }
        }
      }
      const valid = mn.every(isFinite) && mx.every(isFinite)
      this._enabledBoundsCache = valid ? { min: mn, max: mx } : null
      return this._enabledBoundsCache
    }

    _invalidateEnabledBounds() {
      this._enabledBoundsCache = undefined
      this.updateBbox = true
    }

    SaveToJson() {
      return {
        // data to be saved for savegames
      }
    }

    LoadFromJson(o) {
      // load state for savegames
    }

    GetDebuggerProperties() {
      return [
        {
          title: "3DObject",
          properties: [
            //{name: ".current-animation",	value: this._currentAnimation.GetName(),	onedit: v => this.CallAction(Acts.SetAnim, v, 0) },
          ],
        },
      ]
    }

    // timeline support
    GetPropertyValueByIndex(index) {
      return 0
    }

    SetPropertyValueByIndex(index, value) {
      //set property value here
    }

    _findNode(nodeName) {
      if (this.gltf?.gltfData?.skinnedNodes?.length) {
        for (let ii = 0; ii < this.gltf.gltfData.skinnedNodes.length; ii++) {
          let node = this.gltf.gltfData.skinnedNodes[ii]
          if (node.name == nodeName) {
            return node
          }
        }
      }
      if (this.gltf?.gltfData?.nodes?.length) {
        for (let ii = 0; ii < this.gltf.gltfData.nodes.length; ii++) {
          let node = this.gltf.gltfData.nodes[ii]
          if (node.name == nodeName) {
            return node
          }
        }
      }
      return false
    }

    Release() {
      this._released = true
      if (this.gltf) {
        this.gltf.release()
      }
      this.sdkType = null
      this.runtime = null
      this.renderer = null
      this.uid = null
      this.loaded = null
      this.animationTime = null
      this.animationIndex = null
      this.animationSpeed = null
      this.animationLastTime = null
      this.animationRate = null
      this.animationLoop = null
      this.animationPlay = null
      this.animationFinished = null
      this.animationName = null
      this.xScale = null
      this.yScale = null
      this.zScale = null
      this.debug = null
      this.renderOnce = null
      this.currentAnimationTime = null
      this.currentAnimationFrame = null
      this.minBB = null
      this.maxBB = null
      this.updateBbox = null
      this.bboxScale = null
      this.workerAnimation = null
      this.gltf = null
      this.animationOffset = null
      super.Release()
    }

    GetPropertyValueByIndex(index) {
      switch (index) {
        case 0:
          return this.scale
        case 2: // x angle
          return this.xAngle
        case 3: // y angle
          return this.yAngle
        case 4: // z angle
          return this.zAngle
        case 11: // x scale
          return this.xScale
        case 12: // y scale
          return this.yScale
        case 13: // z scale
          return this.zScale
        default:
          return 0
      }
    }

    SetPropertyValueByIndex(index, value) {
      switch (index) {
        case 0:
          this.scale = value
          break
        case 2: // x angle
          this.xAngle = value
          break
        case 3: // y angle
          this.yAngle = value
          break
        case 4: // z angle
          this.zAngle = value
          break
        case 11: // x scale
          this.xScale = value
          break
        case 12: // y scale
          this.yScale = value
          break
        case 13: // z scale
          this.zScale = value
          break
        default:
          break
      }
      this.runtime.UpdateRender()
      this.updateBbox = true
    }

    _setXAngle(angle) {
      this.xAngle = angle
      this.runtime.UpdateRender()
      this.updateBbox = true
    }

    _setYAngle(angle) {
      this.yAngle = angle
      this.runtime.UpdateRender()
      this.updateBbox = true
    }

    _setZAngle(angle) {
      this.zAngle = angle
      this.runtime.UpdateRender()
      this.updateBbox = true
    }

    _setXScale(scale) {
      this.xScale = scale
      this.runtime.UpdateRender()
      this.updateBbox = true
    }
    _setYScale(scale) {
      this.yScale = scale
      this.runtime.UpdateRender()
      this.updateBbox = true
    }
    _setZScale(scale) {
      this.zScale = scale
      this.runtime.UpdateRender()
      this.updateBbox = true
    }

    _setScale(scale) {
      this.scale = scale
      this.runtime.UpdateRender()
      this.updateBbox = true
    }

    _setAnimationBlend(time) {
      this.animationBlend = time
    }

    GetScriptInterfaceClass() {
      // @ts-ignore
      return self.I3DObjectInstance
    }
  }

  // Script interface. Use a WeakMap to safely hide the internal implementation details from the
  // caller using the script interface.
  const map = new WeakMap()
  // @ts-ignore
  self.I3DObjectInstance = class I3DObjectInstance extends self.IWorldInstance {
    constructor() {
      super()
      // Map by SDK instance
      // @ts-ignore
      map.set(this, self.IInstance._GetInitInst().GetSdkInstance())
      // @ts-ignore
      this.sdk_instance = map.get(this)
    }

    // ---- Geometry / bounds APIs (see the _-prefixed implementations above) ----

    // Model-local bounding box: { min:[x,y,z], max:[x,y,z] } in model units, or null
    get localBoundingBox() {
      return map.get(this)._localBoundingBox()
    }

    // { w,h,d, ox,oy,oz } in world units at per-axis scale 1 (replaces the
    // hand-harvested MODEL_BASE_SIZES table)
    getBaseSize() {
      return map.get(this)._getBaseSize()
    }

    // { corners:[[x,y,z]x8], center:[x,y,z], aabb:{min,max} } under the current transform
    getWorldBoundingBox() {
      return map.get(this)._getWorldBoundingBox()
    }

    // Float32Array(16) copy of the model->world matrix, refreshed at call time
    getModelRotation() {
      return map.get(this)._getModelRotation()
    }

    // { position, matrix, quaternion, scale } — works in worker/GPU-skinning mode
    getNodeWorldTransform(nodeName) {
      return map.get(this)._getNodeWorldTransform(nodeName)
    }

    getNodeWorldPosition(nodeName) {
      return map.get(this)._getNodeWorldPosition(nodeName)
    }

    // Joints are nodes; kept as an alias for familiarity
    getBoneWorldPosition(boneName) {
      return map.get(this)._getNodeWorldPosition(boneName)
    }

    // [{ nodeName, positions, indices, skinned, disabled }] — positions/indices are
    // SHARED bind-pose accessor arrays; do not mutate
    getGeometry() {
      return map.get(this)._getGeometry()
    }

    // [[{x,y,z},{x,y,z},{x,y,z}], ...] world-space triangles of enabled nodes
    // (bind pose for skinned nodes)
    getWorldTriangles() {
      return map.get(this)._getWorldTriangles()
    }

    set xAngle(angle) {
      map.get(this)._setXAngle(angle)
    }
    set yAngle(angle) {
      map.get(this)._setYAngle(angle)
    }
    set zAngle(angle) {
      map.get(this)._setZAngle(angle)
    }

    get xAngle() {
      return map.get(this).xAngle
    }
    get yAngle() {
      return map.get(this).yAngle
    }
    get zAngle() {
      return map.get(this).zAngle
    }

    set xScale(scale) {
      map.get(this)._setXScale(scale)
    }
    set yScale(scale) {
      map.get(this)._setYScale(scale)
    }
    set zScale(scale) {
      map.get(this)._setZScale(scale)
    }

    get xScale() {
      return map.get(this).xScale
    }
    get yScale() {
      return map.get(this).yScale
    }
    get zScale() {
      return map.get(this).zScale
    }

    set scale(scale) {
      map.get(this)._setScale(scale)
    }

    get scale() {
      return map.get(this).scale
    }

    set animationBlend(time) {
      map.get(this)._setAnimationBlend(time)
    }
    get animationBlend() {
      return map.get(this).animationBlend
    }
  }
}
