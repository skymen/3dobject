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
        this.scale = properties[0]
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
        this.sdkType.LoadDynamicTextures(this.renderer, this.sdkType.gltfData, this.sdkType.texture, this.sdkType)
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
          this.gltf.getPolygons(this.staticGeometry || this.gpuSkinning)
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

      // restore element array buffer
      this.renderer._gl.bindBuffer(this.renderer._gl.ELEMENT_ARRAY_BUFFER, this.renderer._indexBuffer)
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
        this.sdkType.LoadDynamicTextures(renderer, gltfData, textures, this.sdkType)
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

      if (useStaticBbox && this.gltf?.gltfData?.boundingBox) {
        maxBB = this.gltf.gltfData.boundingBox.max
        minBB = this.gltf.gltfData.boundingBox.min
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

    getNodePointPosition(nodeName, pointIndex) {
      const vec3 = globalThis.glMatrix3D.vec3
      let rotatedPoint = [0, 0, 0]
      let mapThis = map.get(this)
      if (!mapThis?.gltf?.gltfData) return rotatedPoint
      if (!mapThis?.gltf?.meshNames?.has(nodeName)) return rotatedPoint
      if (!mapThis?.gltf?.modelRotate) return rotatedPoint
      const drawVerts = mapThis.gltf.drawMeshes[mapThis.gltf.meshNames.get(nodeName)].drawVerts[0]
      if (!drawVerts) return rotatedPoint
      const point = vec3.fromValues(
        drawVerts[pointIndex * 3],
        drawVerts[pointIndex * 3 + 1],
        drawVerts[pointIndex * 3 + 2]
      )
      vec3.transformMat4(rotatedPoint, point, mapThis.gltf.modelRotate)
      return rotatedPoint
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
