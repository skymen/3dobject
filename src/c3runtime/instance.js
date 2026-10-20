"use strict"
{
  const C3 = self.C3

  /** Layer → per-tick camera position. See Instance._GetCameraPosition(). */
  const camPosCache = new WeakMap()

  // Bind-pose joint radii, keyed on the shared inverse-bind accessor so every
  // instance of a model reuses one computation. See _jointRadii().
  const jointRadiiCache = new WeakMap()

  // Scratch matrices and constants for node world reads (_nodeWorld, _chainMatrix); gl-matrix types (mat4.create)
  let _nodeWorldTmp = null, _nodeLocalTmp = null, _mIdentity = null, _drawnTmp = null
  // _updateBoundingBox: scratch vectors and the box corners' order (x, y max per corner; z max for the last four)
  let _bbOut = null, _bbPoint = null
  const BB_CORNER_X = [0, 1, 1, 0, 0, 1, 1, 0], BB_CORNER_Y = [0, 0, 1, 1, 0, 0, 1, 1]
  const Q_IDENTITY = [0, 0, 0, 1], V_ZERO = [0, 0, 0], V_ONE = [1, 1, 1]

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
      // Whether the project actually asked for a rate. Untouched, the animation
      // updates every tick: a hardcoded 60 caps it at 60 Hz, so on a 120 Hz
      // display every second frame repeats a pose and the result looks steppy
      // no matter how fast the game runs.
      this.animationRateExplicit = false
      // Fixed per-instance phase offset. This used to be fresh Math.random()
      // added to animationTime EVERY tick, which desynchronised instances but
      // also made each one's timestep uneven - visible as micro-stutter on a
      // single model. A constant offset desynchronises just as well.
      this.animationPhase = Math.random()
      // animationRate after the distance factor; readable via the
      // EffectiveAnimationRate expression for tuning the thresholds.
      this.effectiveAnimationRate = 60
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
      // ±Infinity until a vertex pass fills them, the same sentinels
      // getPolygons() resets to. Zeros counted as a valid (1×1) dynamic box on
      // the first _updateBoundingBox, before any polygon pass had run, so the
      // model spent its first frame with a degenerate box instead of the
      // static one (issue 068).
      this.minBB = [Infinity, Infinity, Infinity]
      this.maxBB = [-Infinity, -Infinity, -Infinity]
      this.updateBbox = true
      this.xMinBB = [0, 0, 0]
      this.xMaxBB = [0, 0, 0]
      this.animationNameFinished = ""
      this.totalTriangles = 0
      // The only runtime path. See the constructor note on the deprecated
      // gpu-skinning / static-mesh / worker-animation properties.
      this._hasAnimationData = false
      this.staticGeometry = true
      this.staticMeshMode = 0
      this.gpuSkinning = true
      // Distance-based animation rate. See _GetDistanceRateFactor().
      this.distanceRate = false
      this.distanceRateMinDist = 1024
      this.distanceRateMaxDist = 8192
      this.distanceRateMinRate = 5
      this.distanceRateMaxRate = 60
      this.animationOffset = 0
      this.allNodesDisabled = false
      // Hide every node as soon as the model is parsed, so "On model loaded"
      // can enable just the ones wanted. See GltfModel(W).setAllNodesDisabled().
      this.startHidden = false
      // Bone rotation offsets: node name -> [x, y, z, w], multiplied onto the sampled local rotation each frame
      this._boneOffsets = new Map()
      this._boneOffsetsVersion = 0
      // Blend weights (blend trees): animation name -> weight. When any is set, the pose is the weighted mix
      // of those clips, sampled at the playing animation's phase (all clips need the same channel layout)
      this._blendWeights = new Map()
      this._blendPhases = new Map() // name -> fixed phase (0..1) of a weighted clip, instead of the playing clip's
      // IK chains (script API setIKChain): name -> { upper, lower, end, target, pole, weight, endAxis, endDir, endWeight }
      this._ikChains = new Map()
      // jiggle bones (script API setJiggleBone): name -> { stiffness, damping, maxAngle, length, gravity, axis, anchor, anchorWeight, anchorPose, anchorTilt, limitAxis, limitAngle, drag }
      this._jiggle = new Map()
      this._blendWeightsVersion = 0
      this.useBoneBoundingBox = true // When true, use bone-based bbox; when false, use static bbox
      this._released = false
      this._drewCustomBuffers = false

      // Track last position for detecting position changes
      this._lastX = 0
      this._lastY = 0
      this._lastZ = 0
      // Last seen rotation / scale / hierarchy-parent transform, see
      // _transformChanged(). NaN so the first tick after load always syncs.
      this._lastXAngle = NaN
      this._lastYAngle = NaN
      this._lastZAngle = NaN
      this._lastScale = NaN
      this._lastXScale = NaN
      this._lastYScale = NaN
      this._lastZScale = NaN
      this._lastParentX = NaN
      this._lastParentY = NaN
      this._lastParentZ = NaN
      this._lastParentAngle = NaN

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
        // gpu-skinning (18) and cpu-xform (16) are deprecated no-ops: skinning,
        // morph targets and the bounding box are all GPU-side now, so there is
        // no second path to select between. worker-animation is NOT one of
        // them - the worker also runs keyframe sampling and the scene-graph
        // update, which are still real per-frame work worth keeping off the
        // main thread whatever does the skinning.
        this.workerAnimation = properties[15]
        this.useBoneBoundingBox = properties[17] !== false // Default to true
        this.distanceRate = properties[19] === true
        this.distanceRateMinDist = properties[20]
        this.distanceRateMaxDist = properties[21]
        this.distanceRateMinRate = properties[22]
        this.distanceRateMaxRate = properties[23]
        this.startHidden = properties[24] === true
        // static-mesh (25) is likewise a no-op: the GPU buffer path is the only
        // path now.
        this.staticMeshMode = properties[25] || 0
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

      this._hasAnimationData = Object.prototype.hasOwnProperty.call(this.gltf.gltfData, "animations")
      this.loaded = true
      this.renderOnce = true
      this.runtime.UpdateRender()
      if (this.gltf.getAnimationNames().length > 0) {
        this.animationName = this.gltf.getAnimationNames()[0]
      }
      if (this._pendingPlay) {
        const [name, loop] = this._pendingPlay
        this._pendingPlay = null
        // @ts-ignore
        self.C3.Plugins.Mikal_3DObject.Acts.PlayAnimation.call(this, name, loop)
      }
      this.gltf.updateModelRotate(wi.GetX(), wi.GetY(), wi.GetTotalZElevation())
      this._updateBoundingBox(wi.GetX(), wi.GetY(), wi.GetTotalZElevation(), this.gpuSkinning)
      // The box just went from whatever the layout had to the model's: tell
      // Construct now, not on the next tick that happens to move the instance.
      wi.SetBboxChanged()

      // Initialize position tracking
      this._lastX = wi.GetX()
      this._lastY = wi.GetY()
      this._lastZ = wi.GetTotalZElevation()
      this._transformChanged(wi)

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

    /**
     * The layer's 3D camera position, cached for the current tick.
     *
     * `Layer.GetCameraPosition()` returns a freshly allocated array on every
     * call, so asking per instance would mean one throwaway array per model per
     * frame — exactly the crowds this feature exists to speed up. The cache is
     * keyed weakly on the layer because C3 seals Layer in debug builds, so a
     * property can't be parked on it.
     */
    _GetCameraPosition() {
      const layer = this.GetWorldInfo().GetLayer()
      const tick = this._runtime.GetTickCount()
      let entry = camPosCache.get(layer)
      if (!entry) {
        entry = { tick: -1, pos: [0, 0, 0] }
        camPosCache.set(layer, entry)
      }
      if (entry.tick !== tick) {
        entry.tick = tick
        const p = layer.GetCameraPosition()
        entry.pos[0] = p[0]
        entry.pos[1] = p[1]
        entry.pos[2] = p[2]
      }
      return entry.pos
    }

    /**
     * Multiplier applied to `animationRate` based on distance from the camera.
     *
     * Returns a *factor*, not a rate, so this composes with the "Set animation
     * rate" action instead of fighting it: events keep authority over the base
     * rate (idle vs. active, quality settings, whatever) and this scales it for
     * distance. The factor is the distance-interpolated rate as a fraction of
     * "Rate max rate", so it is exactly 1 within "Rate min distance" — a model
     * up close animates at whatever the events asked for, untouched.
     *
     * Interpolation is linear in distance between the two thresholds and
     * clamped outside them.
     */
    _GetDistanceRateFactor() {
      if (!this.distanceRate) return 1

      const maxRate = this.distanceRateMaxRate
      const minRate = this.distanceRateMinRate
      if (!(maxRate > 0) || !(minRate > 0)) return 1

      const minDist = this.distanceRateMinDist
      const maxDist = this.distanceRateMaxDist

      const cam = this._GetCameraPosition()
      const wi = this.GetWorldInfo()
      const dx = wi.GetX() - cam[0]
      const dy = wi.GetY() - cam[1]
      const dz = wi.GetTotalZElevation() - cam[2]
      const distSq = dx * dx + dy * dy + dz * dz

      // Squared compare first: most instances in a crowd are at one extreme or
      // the other, so the sqrt below is usually skipped.
      if (distSq <= minDist * minDist) return 1
      if (distSq >= maxDist * maxDist || maxDist <= minDist) return minRate / maxRate

      const t = (Math.sqrt(distSq) - minDist) / (maxDist - minDist)
      return (maxRate + (minRate - maxRate) * t) / maxRate
    }

    /**
     * Rotation, scale and hierarchy-parent transform since the last call.
     *
     * The _set* setters mark the box dirty, but nothing stops a script from
     * writing xAngle / xScale straight onto the instance - the level editor's
     * gizmo does - and a hierarchy parent's rotation or scale reaches a child
     * that sits on the parent's origin without changing the child's x/y/z. The
     * SDK v1 runtime has no world-info-changed hook to catch either, so the
     * tick diffs them. Returns true when anything moved; always syncs.
     */
    _transformChanged(wi) {
      let changed = false
      if (
        this.xAngle !== this._lastXAngle ||
        this.yAngle !== this._lastYAngle ||
        this.zAngle !== this._lastZAngle ||
        this.scale !== this._lastScale ||
        this.xScale !== this._lastXScale ||
        this.yScale !== this._lastYScale ||
        this.zScale !== this._lastZScale
      ) {
        this._lastXAngle = this.xAngle
        this._lastYAngle = this.yAngle
        this._lastZAngle = this.zAngle
        this._lastScale = this.scale
        this._lastXScale = this.xScale
        this._lastYScale = this.yScale
        this._lastZScale = this.zScale
        changed = true
      }
      const parent = wi.GetParent()
      let px = NaN
      let py = NaN
      let pz = NaN
      let pa = NaN
      if (parent) {
        px = parent.GetX()
        py = parent.GetY()
        pz = parent.GetTotalZElevation()
        pa = parent.GetAngle()
      }
      // NaN !== NaN, so compare through Object.is to keep "no parent" stable.
      if (
        !Object.is(px, this._lastParentX) ||
        !Object.is(py, this._lastParentY) ||
        !Object.is(pz, this._lastParentZ) ||
        !Object.is(pa, this._lastParentAngle)
      ) {
        this._lastParentX = px
        this._lastParentY = py
        this._lastParentZ = pz
        this._lastParentAngle = pa
        changed = true
      }
      return changed
    }

    Tick() {
      // Detect transform changes (x, y, zElevation, angles, scale, parent)
      // and trigger bbox update
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
        if (this._transformChanged(wi)) this.updateBbox = true
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
      // Whether an animation step was requested this tick while the instance
      // was off screen; see the bbox refresh below.
      let animatedOffScreen = false
      if (this.loaded) {
        if (this.animationPlay && this._hasAnimationData) {
          // The action-set rate scaled for distance; identical to animationRate
          // when the distance feature is off or the model is close to the camera.
          const distanceFactor = this._GetDistanceRateFactor()
          const throttled = this.animationRateExplicit || distanceFactor !== 1
          const rate = Math.max(this.animationRate * distanceFactor, 0.001)
          // Per-instance dt: honours "Set object time scale" (and the object's
          // own pause via time scale 0), which the plain runtime dt ignored.
          const dt = this._runtime.GetDt(this.GetInstance())
          // Report the real update rate: unthrottled that is the frame rate,
          // not zero, so the expression stays meaningful for tuning. dt is 0
          // while the object is paused; never divide by it.
          this.effectiveAnimationRate = throttled ? rate : dt > 0 ? 1 / dt : rate
          if (Number.isFinite(this.animationSpeed)) this.animationTime += dt * this.animationSpeed
          const deltaTime = this.animationTime - this.animationLastTime
          // Unthrottled unless the project set a rate or distance-based rate is
          // on. The phase offset only staggers WHICH frame each instance
          // updates on, so it cannot make a timestep uneven.
          if (!throttled || deltaTime >= (1 + this.animationPhase * 0.1) / rate) {
            const onScreen = this.IsOnScreen()
            // Advance only if the update was accepted. Marking it done before
            // the call meant a request dropped by the worker's in-flight gate
            // cost a full rate interval before the next attempt, and at high
            // instance counts the worker is busy most of the time.
            const applied = this.gltf.updateAnimationPolygons(
              this.animationIndex,
              this.animationTime,
              onScreen,
              deltaTime,
              this.staticGeometry,
              this.gpuSkinning
            )
            if (applied !== false) this.animationLastTime = this.animationTime
            animatedOffScreen = !onScreen
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
      if (this.updateBbox) {
        this.refreshBoundingBox()
        // Off screen no pose is requested, so the box above came from the last
        // pose the instance had on screen. Keep it dirty so the first on-screen
        // Draw recomputes it before anything relies on it, instead of waiting
        // for the next transform change.
        if (animatedOffScreen) this.updateBbox = true
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

      // (for..in, not Object.keys: an array per draw per pass)
      let noMaterials = true
      for (const _ in textures) {
        noMaterials = false
        break
      }
      if (noMaterials) {
        // Model has no materials: fall back to the object's image texture
        renderer.SetTexture(texture)
      }

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
        const shader = globalThis.cached3DObjectShader
        const deferred = !!globalThis.DeferredBatch?.isEnabled?.()
        // SetProgram is equality-guarded (`if (this._lastProgram === t) return`).
        // Deferred, a skipped job is only safe when the 3D shader's matP/matMV
        // are still current: DoSetProgram is what re-uploads them after a
        // DoSetProjection/DoSetModelView. So force a job when the transform
        // changed since the last one (`_m3dXform`, counted by DeferredBatch),
        // and otherwise let a run of instances share the bound program. The
        // original program is restored lazily (see DeferredBatch) so a run of
        // models costs one switch in and one out, not two per instance.
        let originalProgram = null
        const xform = renderer._m3dXform | 0
        if (renderer.GetProgram() !== shader) {
          originalProgram = renderer.GetProgram()
          renderer.SetProgram(shader)
          renderer._m3dXformAtSet = xform
        } else if (deferred && renderer._m3dXformAtSet !== xform) {
          renderer.ResetLastProgram()
          renderer.SetProgram(shader)
          renderer._m3dXformAtSet = xform
        }
        // Deferred: the restore below is recorded by DeferredBatch's
        // SetProgram wrapper and pushed only when something needs it.
        try {
          this.gltf.render(
            renderer,
            x,
            y,
            z,
            null, // tempQuad: unused since the mesh path replaced Quad3D2
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

    /**
     * Recompute the Construct box (size, origin, depth) from the current pose
     * and transform. Called from the tick, and directly when a pose lands from
     * the worker: Construct sizes an effect surface from this box BEFORE it
     * calls Draw, so a box refreshed after drawing is a frame late and clips
     * fast animations at the edges.
     */
    refreshBoundingBox() {
      if (!this.loaded || !this.gltf?.modelRotate) return
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
        // Union the pose-aware skinned bounds with the bind-pose box of the
        // UNSKINNED meshes only: the posed bounds cover every skinned node, and
        // adding the skinned bind pose back (a T-pose is much wider than a run
        // cycle) inflated the box. The union is never smaller than either part.
        const posed = this._poseLocalBounds()
        let enabled = this._enabledLocalBounds(!!posed)
        if (posed && enabled) {
          // (into this instance's scratch box: it is only read just below)
          const u = this._bbUnion || (this._bbUnion = { min: [0, 0, 0], max: [0, 0, 0] })
          u.min[0] = Math.min(posed.min[0], enabled.min[0])
          u.min[1] = Math.min(posed.min[1], enabled.min[1])
          u.min[2] = Math.min(posed.min[2], enabled.min[2])
          u.max[0] = Math.max(posed.max[0], enabled.max[0])
          u.max[1] = Math.max(posed.max[1], enabled.max[1])
          u.max[2] = Math.max(posed.max[2], enabled.max[2])
          enabled = u
        } else if (posed) {
          enabled = posed
        }
        if (enabled) {
          maxBB = enabled.max
          minBB = enabled.min
        } else if (this.gltf?.gltfData?.boundingBox) {
          maxBB = this.gltf.gltfData.boundingBox.max
          minBB = this.gltf.gltfData.boundingBox.min
        }
      }

      const modelRotate = this.gltf.modelRotate
      if (!modelRotate) return

      // (refilled in place: built new three times a tick per model, ~20 MB/s of garbage with 50 models. Nothing else
      // holds these arrays)
      const xMinBB = this.xMinBB || (this.xMinBB = [0, 0, 0])
      const xMaxBB = this.xMaxBB || (this.xMaxBB = [0, 0, 0])
      xMinBB[0] = xMinBB[1] = xMinBB[2] = Infinity
      xMaxBB[0] = xMaxBB[1] = xMaxBB[2] = -Infinity
      const vec3 = globalThis.glMatrix3D.vec3

      // the box's corners in the same order as before (the first of equal values wins); point / rotatedPoint are
      // gl-matrix vectors (float32) as vec3.fromValues / vec3.create made them
      const rotatedPoint = _bbOut || (_bbOut = vec3.create())
      const point = _bbPoint || (_bbPoint = vec3.create())
      for (let i = 0; i < 8; i++) {
        point[0] = BB_CORNER_X[i] ? maxBB[0] : minBB[0]
        point[1] = BB_CORNER_Y[i] ? maxBB[1] : minBB[1]
        point[2] = i >= 4 ? maxBB[2] : minBB[2]
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
        wi.SetSize(width, height)
        wi.SetOriginX(-(xMinBB[0] - x) / width)
        wi.SetOriginY(-(xMinBB[1] - y) / height)
        // Construct spans the 3D box from the instance's Z elevation to
        // Z + depth (that is what sizes the effect surface and culls), so the
        // depth has to reach the model's top from the INSTANCE z, not from the
        // model's own lowest point - a pose with both feet off the ground would
        // otherwise lose that much off the top. Anything below the instance z
        // cannot be represented; keep the origin at the model's base.
        this._setZHeight(Math.max(xMaxBB[2] - z, 1))
      } else {
        const wi = this.GetWorldInfo()
        wi.SetSize(100, 100)
        wi.SetOriginX(0.5)
        wi.SetOriginY(0.5)
        this._setZHeight(100)
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
      const mat4 = globalThis.glMatrix3D.mat4
      let world = null
      // a drawn node (setDrawnNodes): the pose as drawn (the worker's last), under the model's current placement;
      // no main-thread pose needed
      if (this._drawnNodes && this._drawnNodes.includes(nodeName) && this.gltf && this.gltf.drawnNodeMatrix && this._refreshModelRotate()) {
        const local = _drawnTmp || (_drawnTmp = mat4.create())
        if (this.gltf.drawnNodeMatrix(nodeName, local)) world = mat4.multiply(mat4.create(), this.gltf.modelRotate, local)
      }
      if (!world) {
        const w = this._nodeWorld(nodeName)
        if (!w) return null
        world = mat4.clone(w) // (the caller keeps it: w is scratch)
      }
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
      const w = this._nodeWorld(nodeName)
      return w ? [w[12], w[13], w[14]] : null
    }

    // The node's world matrix (modelRotate x its TRS chain from the root) in a scratch matrix, valid until the next
    // call; null before the model loads or for an unknown node.
    _nodeWorld(nodeName) {
      if (!this._refreshModelRotate() || !this._ensureNodeMaps()) return null
      // a bone outside the main-thread set (setMainThreadNodes): from now on it is sampled there too (this read still
      // sees it as it was)
      if (this._mainNodes && this.gltf && this.gltf.mainNodeCovered && !this.gltf.mainNodeCovered(nodeName)) {
        if (!this._mainNodesWarned) {
          this._mainNodesWarned = true
          console.warn(`[3DObject] "${nodeName}" read outside the main-thread bones (setMainThreadNodes): added`)
        }
        this._mainNodes.add(String(nodeName))
        this._mainNodesVersion = (this._mainNodesVersion || 0) + 1
      }
      // Worker mode samples the main-thread pose lazily; bring it up to date.
      const g = this.gltf
      if (g && typeof g.ensureMainThreadPose === "function") g.ensureMainThreadPose()
      const node = this._nodeByName.get(nodeName)
      if (!node) return null
      const mat4 = globalThis.glMatrix3D.mat4
      const out = _nodeWorldTmp || (_nodeWorldTmp = mat4.create())
      if (g && g._poseVersion !== undefined) {
        // worker mode: the chain matrices are cached per node for the main-thread pose they were built from
        mat4.multiply(out, g.modelRotate, this._chainMatrix(node, g._poseVersion))
        return out
      }
      // (the same product, built from the root every call: node TRS another way, e.g. CPU animation)
      const path = []
      let current = node
      while (current) {
        path.unshift(current)
        current = this._nodeParent.get(current)
      }
      const local = _nodeLocalTmp || (_nodeLocalTmp = mat4.create())
      mat4.identity(out)
      for (const n of path) {
        mat4.fromRotationTranslationScale(local, n.rotation || Q_IDENTITY, n.translation || V_ZERO, n.scale || V_ONE)
        mat4.multiply(out, out, local)
      }
      mat4.multiply(out, g.modelRotate, out)
      return out
    }

    // identity x root local x ... x node local, exactly as the loop above builds it, kept per node until the pose
    // changes (ensureMainThreadPose bumps _poseVersion): bones share their ancestors, and bodyIK reads ~12 a tick
    _chainMatrix(node, version) {
      if (node._chainV === version) return node._chainM
      const mat4 = globalThis.glMatrix3D.mat4
      const parent = this._nodeParent.get(node)
      const pm = parent ? this._chainMatrix(parent, version) : _mIdentity || (_mIdentity = mat4.create())
      const local = _nodeLocalTmp || (_nodeLocalTmp = mat4.create())
      mat4.fromRotationTranslationScale(local, node.rotation || Q_IDENTITY, node.translation || V_ZERO, node.scale || V_ONE)
      const m = node._chainM || (node._chainM = mat4.create())
      mat4.multiply(m, pm, local)
      node._chainV = version
      return m
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
    /**
     * Bind-pose box of every joint, in that joint's own space, computed once
     * per model.
     *
     * For each joint, every vertex weighted to it is moved into joint space with
     * the inverse-bind matrix and the min/max kept. A posed vertex is
     * `boneMatrix * v_bind = (inv(node) * world(joint)) * (invBind * v_bind)`, so
     * it stays inside that joint box pushed through `inv(node) * world(joint)`.
     * An oriented box per joint follows a limb far more tightly than a sphere,
     * which reaches as far backwards along a bone as the bone is long.
     *
     * Cached on the shared inverse-bind accessor, so instances of the same model
     * pay for it once. The worker gets boxMin/boxMax; the main-thread fallback
     * also needs `bind` (the inverse of invBind) to undo invBind from boneMatrix.
     */
    _jointRadii(skin) {
      if (!skin || !skin.joints || !skin.inverseBindMatrices || !skin.inverseBindMatrices.data) return null
      const key = skin.inverseBindMatrices.data
      let entry = jointRadiiCache.get(key)
      if (entry !== undefined) return entry

      const mat4 = globalThis.glMatrix3D.mat4
      const vec3 = globalThis.glMatrix3D.vec3
      const joints = skin.joints
      const n = joints.length
      const boxMin = new Float32Array(n * 3).fill(Infinity)
      const boxMax = new Float32Array(n * 3).fill(-Infinity)
      const bind = new Float32Array(n * 16)
      const inv = mat4.create()
      for (let j = 0; j < n; j++) {
        if (!joints[j].invBindMatrix || !mat4.invert(inv, joints[j].invBindMatrix)) mat4.identity(inv)
        for (let q = 0; q < 16; q++) bind[j * 16 + q] = inv[q]
      }

      const gltf = this.gltf?.gltfData
      const v = vec3.create()
      for (const node of gltf.skinnedNodes || []) {
        if (node.skin !== skin || !node.mesh) continue
        for (const prim of node.mesh.primitives) {
          const pos = prim.attributes.POSITION && prim.attributes.POSITION.data
          const jnt = prim.attributes.JOINTS_0 && prim.attributes.JOINTS_0.data
          const wgt = prim.attributes.WEIGHTS_0 && prim.attributes.WEIGHTS_0.data
          if (!pos || !jnt || !wgt) continue
          for (let i = 0, cnt = pos.length / 3; i < cnt; i++) {
            for (let k = 0; k < 4; k++) {
              // Ignore near-zero influences: they drag a joint's box out to the
              // far side of the mesh for no visible deformation.
              if (wgt[i * 4 + k] < 0.05) continue
              const j = jnt[i * 4 + k]
              if (j >= n || !joints[j].invBindMatrix) continue
              vec3.set(v, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
              vec3.transformMat4(v, v, joints[j].invBindMatrix)
              const o = j * 3
              for (let a = 0; a < 3; a++) {
                if (v[a] < boxMin[o + a]) boxMin[o + a] = v[a]
                if (v[a] > boxMax[o + a]) boxMax[o + a] = v[a]
              }
            }
          }
        }
      }

      entry = { boxMin, boxMax, bind }
      jointRadiiCache.set(key, entry)
      return entry
    }

    /**
     * Local bounds of the CURRENT pose, from bone matrices rather than vertices.
     *
     * _enabledLocalBounds() is the bind-pose box and is cached, so it cannot
     * follow an animation that reaches outside the rest pose - a kick, a swing -
     * and C3 then culls or clips the model. This costs O(joints) per frame
     * instead of O(vertices) and is conservative, so it never culls early.
     */
    _poseLocalBounds() {
      const gltf = this.gltf?.gltfData
      if (!gltf || !gltf.skinnedNodes || gltf.skinnedNodes.length === 0) return null
      // Worker mode: the worker bounds the real pose and sends it with the bones.
      if (this.gltf && typeof this.gltf.getPosedBounds === "function") return this.gltf.getPosedBounds()
      const vec3 = globalThis.glMatrix3D.vec3
      const mat4 = globalThis.glMatrix3D.mat4
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      const p = vec3.create()
      const m = mat4.create()
      // boneMatrix is inv(node) * world(joint) * invBind and the shader applies
      // the scene root TRS (uRootNodeXform) on top. A joint-space box corner
      // therefore goes through root * boneMatrix * bind(joint).
      const root = this.gltf.rootNodeXform
      let any = false

      for (const node of gltf.skinnedNodes) {
        if (node.disabled) continue
        const boxes = this._jointRadii(node.skin)
        if (!boxes) continue
        const joints = node.skin.joints
        for (let j = 0; j < joints.length; j++) {
          const bone = joints[j].boneMatrix
          if (!bone || boxes.boxMin[j * 3] === Infinity) continue
          mat4.multiply(m, bone, boxes.bind.subarray(j * 16, j * 16 + 16))
          if (root) mat4.multiply(m, root, m)
          any = true
          const o = j * 3
          for (let c = 0; c < 8; c++) {
            p[0] = c & 1 ? boxes.boxMax[o] : boxes.boxMin[o]
            p[1] = c & 2 ? boxes.boxMax[o + 1] : boxes.boxMin[o + 1]
            p[2] = c & 4 ? boxes.boxMax[o + 2] : boxes.boxMin[o + 2]
            vec3.transformMat4(p, p, m)
            for (let a = 0; a < 3; a++) {
              if (p[a] < min[a]) min[a] = p[a]
              if (p[a] > max[a]) max[a] = p[a]
            }
          }
        }
      }
      return any ? { min, max } : null
    }

    /** @param {boolean} skipSkinned leave out skinned meshes (the posed bounds cover them) */
    _enabledLocalBounds(skipSkinned = false) {
      const cacheKey = skipSkinned ? "_enabledStaticBoundsCache" : "_enabledBoundsCache"
      if (this[cacheKey] !== undefined) return this[cacheKey]
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
        if (!node.mesh || node.disabled || (skipSkinned && node.skin)) continue
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
      this[cacheKey] = valid ? { min: mn, max: mx } : null
      return this[cacheKey]
    }

    _invalidateEnabledBounds() {
      this._enabledBoundsCache = undefined
      this._enabledStaticBoundsCache = undefined
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
      this.effectiveAnimationRate = null
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

    // ---- Bone rotation offsets: an extra local rotation per node, applied on top of whatever clip plays
    // (rot = sampled * offset, i.e. about the bone's own axes). Works in worker and main-thread animation.
    _setBoneRotationOffsetQuat(name, x, y, z, w) {
      const l = Math.hypot(x, y, z, w) || 1
      this._boneOffsets.set(String(name), [x / l, y / l, z / l, w / l])
      this._boneOffsetsChanged()
    }

    _setBoneRotationOffset(name, xDeg, yDeg, zDeg) {
      // @ts-ignore
      const quat = globalThis.glMatrix3D.quat
      const q = quat.create()
      quat.fromEuler(q, xDeg, yDeg, zDeg)
      this._setBoneRotationOffsetQuat(name, q[0], q[1], q[2], q[3])
    }

    _clearBoneRotationOffset(name) {
      if (this._boneOffsets.delete(String(name))) this._boneOffsetsChanged()
    }

    _clearBoneRotationOffsets() {
      if (this._boneOffsets.size === 0) return
      this._boneOffsets.clear()
      this._boneOffsetsChanged()
    }

    _setAnimationBlendWeight(name, weight) {
      name = String(name)
      if (!(weight > 0) || !Number.isFinite(weight)) {
        if (!this._blendWeights.delete(name)) return
      } else {
        if (this._blendWeights.get(name) === weight) return
        this._blendWeights.set(name, weight)
      }
      this._blendWeightsChanged()
    }

    // weights: { name: weight } or [[name, weight], ...]; replaces every weight
    _setIKChain(name, c) {
      const vec = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length >= 3 ? [+v[0], +v[1], +v[2]] : null
      const target = vec(c.target)
      if (!c.upper || !c.lower || !c.end || !target) throw new Error("setIKChain: upper, lower, end and target [x, y, z] are required")
      // a non-finite input (NaN from a bad velocity...) would solve a wild pose: keep the last good chain
      const bad = (v) => v && !(Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]))
      if (bad(target) || bad(vec(c.pole)) || bad(vec(c.endDir)) || bad(vec(c.endDir2)) || bad(vec(c.anchor)) || bad(vec(c.poleAnchor)) || !Number.isFinite(c.weight == null ? 1 : +c.weight)) return
      this._ikChains.set(String(name), {
        upper: String(c.upper), lower: String(c.lower), end: String(c.end), target, pole: vec(c.pole),
        weight: c.weight == null ? 1 : Math.max(0, Math.min(1, +c.weight)),
        endAxis: vec(c.endAxis), endDir: vec(c.endDir), endWeight: c.endWeight == null ? 1 : Math.max(0, Math.min(1, +c.endWeight)),
        endAxis2: vec(c.endAxis2), endDir2: vec(c.endDir2), hingeAxis: vec(c.hingeAxis),
        anchor: vec(c.anchor), poleAnchor: vec(c.poleAnchor),
        followH: c.follow ? Math.max(0, Math.min(1, +c.follow[0] || 0)) : 0,
        followV: c.follow ? Math.max(0, Math.min(1, +c.follow[1] || 0)) : 0,
      })
      if (this.gltf && this.gltf.onIKChanged) this.gltf.onIKChanged()
    }

    _clearIKChain(name) {
      if (!this._ikChains.delete(String(name))) return
      if (this.gltf && this.gltf.onIKChanged) this.gltf.onIKChanged()
    }

    _clearIKChains() {
      if (this._ikChains.size === 0) return
      this._ikChains.clear()
      if (this.gltf && this.gltf.onIKChanged) this.gltf.onIKChanged()
    }

    _setAnimationBlendWeights(weights) {
      this._blendWeights.clear()
      const entries = Array.isArray(weights) ? weights : Object.entries(weights || {})
      for (const [name, w] of entries) if (w > 0 && Number.isFinite(w)) this._blendWeights.set(String(name), w)
      this._blendWeightsChanged()
    }

    _setAnimationBlendPhase(name, phase) {
      name = String(name)
      if (phase == null || !Number.isFinite(+phase)) {
        if (!this._blendPhases.delete(name)) return
      } else {
        const p = Math.max(0, Math.min(1, +phase))
        if (this._blendPhases.get(name) === p) return
        this._blendPhases.set(name, p)
      }
      this._blendWeightsChanged()
    }

    _clearAnimationBlendWeights() {
      if (this._blendWeights.size === 0) return
      this._blendWeights.clear()
      this._blendWeightsChanged()
    }

    _blendWeightsChanged() {
      this._blendWeightsVersion++
      if (this.gltf && this.gltf.onBlendWeightsChanged) this.gltf.onBlendWeightsChanged()
      this.runtime.UpdateRender()
    }

    _boneOffsetsChanged() {
      this._boneOffsetsVersion++
      if (this.gltf && this.gltf.onBoneOffsetsChanged) this.gltf.onBoneOffsetsChanged()
      this.runtime.UpdateRender()
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

    // Extra local rotation on a bone on top of the playing animation (degrees, about the bone's own axes).
    setBoneRotationOffset(boneName, xDeg, yDeg, zDeg) {
      map.get(this)._setBoneRotationOffset(boneName, xDeg, yDeg, zDeg)
    }
    // Same as a quaternion [x, y, z, w] in the bone's local space.
    setBoneRotationOffsetQuat(boneName, x, y, z, w) {
      map.get(this)._setBoneRotationOffsetQuat(boneName, x, y, z, w)
    }
    clearBoneRotationOffset(boneName) {
      map.get(this)._clearBoneRotationOffset(boneName)
    }
    clearBoneRotationOffsets() {
      map.get(this)._clearBoneRotationOffsets()
    }

    // Blend tree: mix several clips (same skeleton/channel layout) by weight, all at the playing animation's
    // phase. The playing animation still sets time, speed, looping and crossfades; it only contributes if it
    // is in the weights. { "utrs_jog_60": 0.3, "utrs_run_60": 0.7 }. Weights are normalized.
    setAnimationBlendWeights(weights) {
      map.get(this)._setAnimationBlendWeights(weights)
    }
    setAnimationBlendWeight(animationName, weight) {
      map.get(this)._setAnimationBlendWeight(animationName, weight)
    }
    clearAnimationBlendWeights() {
      map.get(this)._clearAnimationBlendWeights()
    }
    // A weighted clip sampled at its own phase (0..1 of its length) instead of the playing clip's (a pose that
    // plays on its own clock: a vault fading out over the next clip). null: back to the playing clip's phase.
    setAnimationBlendPhase(animationName, phase) {
      map.get(this)._setAnimationBlendPhase(animationName, phase)
    }
    clearAnimationBlendPhase(animationName) {
      map.get(this)._setAnimationBlendPhase(animationName, null)
    }
    get animationBlendWeights() {
      return Object.fromEntries(map.get(this)._blendWeights)
    }

    set animationBlend(time) {
      map.get(this)._setAnimationBlend(time)
    }
    get animationBlend() {
      return map.get(this).animationBlend
    }

    // Playback speed multiplier, same as the "Set animation speed" action
    set animationSpeed(speed) {
      map.get(this).animationSpeed = speed
    }
    get animationSpeed() {
      return map.get(this).animationSpeed
    }
    // Name of the clip the last "Play animation" started ("" before any)
    get animationName() {
      return map.get(this).animationName
    }

    // The bones this instance's main-thread pose keeps up to date (with their parents): the ones scripts read
    // (getBoneWorldPosition, getNodeWorldTransform, IK chain info, trails). The worker still animates every bone for
    // drawing; the main thread then samples only these channels. null: all (the default). Reading another bone adds
    // it (a warning in the console: that first read sees it as it was).
    setMainThreadNodes(names) {
      const inst = map.get(this)
      inst._mainNodes = names == null ? null : new Set(Array.from(names, String))
      inst._mainNodesVersion = (inst._mainNodesVersion || 0) + 1
    }

    // On demand (>= 3.0.64): the main-thread pose is only sampled when a bone is read (or updateMainThreadPose),
    // even while crossfading (it otherwise samples every tick then). For a model read only now and then
    updateMainThreadPose() {
      const g = map.get(this).gltf
      if (g && typeof g.ensureMainThreadPose === "function") g.ensureMainThreadPose()
    }
    setMainThreadPoseOnDemand(on) {
      map.get(this)._mainPoseOnDemand = !!on
    }

    // Drawn nodes (>= 3.0.64, up to 6): getNodeWorldTransform answers for these with the pose as drawn (the worker's
    // last pose, which is what is on screen, under the model's current placement) and never samples the main-thread
    // pose. The other reads (getBoneWorldPosition, getNodeWorldPosition, IK chain info) stay on the main-thread pose.
    // null: none. Trails following a bone read it through getNodeWorldTransform.
    setDrawnNodes(names) {
      const inst = map.get(this)
      inst._drawnNodes = names == null ? null : Array.from(names, String).slice(0, 6)
      inst._drawnNodesVersion = (inst._drawnNodesVersion || 0) + 1
    }

    // Two-bone IK (worker animation), solved after the animation, blend weights and bone offsets.
    // chain: { upper, lower, end: bone names (thigh, shin, ankle / upper arm, forearm, hand),
    //          target: [x, y, z] world position for the end (layout px, z = elevation),
    //          pole?: [x, y, z] world point the knee/elbow bends toward (default: where the animation bends it),
    //          weight?: 0..1, endAxis?: [x, y, z] a bone-local axis of the end bone, endDir?: [x, y, z] world
    //          direction to turn it onto (sole onto the ground normal, palm onto a wall), endWeight?: 0..1,
    //          endAxis2?, endDir2?: a second end axis and the direction it twists toward about the first (fingers up),
    //          hingeAxis?: [x, y, z] the lower bone's local axis the middle joint bends about (elbow, knee): the solve
    //          keeps the joint a hinge (else the animated hinge is swung along and may end up turned sideways),
    //          (>= 3.0.64, for a chain set less often than every frame) anchor?: [x, y, z] the end's animated world
    //          position the target was worked out from, follow?: [horizontal, vertical] 0..1: how much of the
    //          animated end's move since then the target takes every frame (1, 1: a target relative to the animated
    //          foot; 0, 1: a foot held in place whose height follows the animation), poleAnchor?: [x, y, z] the upper
    //          joint's animated world position when the pole was worked out (the pole keeps its offset from it) }
    setIKChain(name, chain) {
      map.get(this)._setIKChain(name, chain || {})
    }
    clearIKChain(name) {
      map.get(this)._clearIKChain(name)
    }
    clearIKChains() {
      map.get(this)._clearIKChains()
    }
    // Same as the "Play animation" action
    playAnimation(name, loop = true) {
      // @ts-ignore
      self.C3.Plugins.Mikal_3DObject.Acts.PlayAnimation.call(map.get(this), String(name), !!loop)
    }
    get isLoaded() {
      return !!map.get(this).loaded
    }

    // Show or hide a mesh node (same as the "Enable node" action), e.g. to pick a skin
    setNodeEnabled(nodeName, enabled) {
      // @ts-ignore
      self.C3.Plugins.Mikal_3DObject.Acts.EnableNode.call(map.get(this), String(nodeName), !!enabled)
    }

    // A simple jiggle on a bone (worker animation): its tip springs toward where the animation puts it, swung by
    // the model's moves and turns. params: stiffness (1/s^2, default 150), damping (1/s, 10: against the tip's speed
    // relative to its animated position), drag (1/s, 0: against its speed in the world, like air), maxAngle (deg, 30),
    // length (model units from the bone to the tip, 20), axis ([x, y, z] bone-local: the way the part it moves points
    // from the bone, default [0, 1, 0]), gravity (px/s^2 pulling the tip down, 0 = none), anchor (node name: the rest direction keeps a fixed rotation to that node instead of following the parent, e.g.
    // a sword on the thigh hanging from the hips), anchorPose ([x, y, z, w]: that rotation, the bone's model-space
    // rotation relative to the anchor's; default: the bind pose's), anchorTilt ([x, y, z] deg about the bone's own
    // axes, on top), anchorWeight (0..1, 1), limitAxis ([x, y, z] in the parent's space, toward the body: the tip
    // goes at most limitAngle deg that way from its rest direction without the animation; 0 = never closer to the
    // body than the bind / anchored pose, < 0 = held off it). No collisions: purely visual.
    setJiggleBone(name, params) {
      const p = params || {}, num = (v, d) => (v !== null && v !== undefined && Number.isFinite(+v) ? +v : d)
      const vec = (v, n) => (Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(+x)) ? v.map(Number) : null)
      map.get(this)._jiggle.set(String(name), { stiffness: Math.max(0, num(p.stiffness, 150)), damping: Math.max(0, num(p.damping, 10)),
        maxAngle: Math.max(0, num(p.maxAngle, 30)), length: Math.max(0.001, num(p.length, 20)),
        gravity: Math.max(0, num(p.gravity, 0)), axis: vec(p.axis, 3),
        anchor: p.anchor ? String(p.anchor) : "", anchorWeight: Math.min(1, Math.max(0, num(p.anchorWeight, 1))),
        anchorPose: vec(p.anchorPose, 4), anchorTilt: vec(p.anchorTilt, 3),
        limitAxis: vec(p.limitAxis, 3), limitAngle: num(p.limitAngle, 0), drag: Math.max(0, num(p.drag, 0)) })
    }
    clearJiggleBone(name) {
      map.get(this)._jiggle.delete(String(name))
    }
    clearJiggleBones() {
      map.get(this)._jiggle.clear()
    }
    // { animatedEnd: [x, y, z] where the animation alone puts the end, reach: target distance / full reach }
    getIKChainInfo(name) {
      const inst = map.get(this)
      return inst.gltf && inst.gltf.ikChainInfo ? inst.gltf.ikChainInfo(String(name)) : null
    }
  }
}
