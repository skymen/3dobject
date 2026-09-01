"use strict"
{
  const SDK = self.SDK
  const PLUGIN_CLASS = SDK.Plugins.Mikal_3DObject

  PLUGIN_CLASS.Instance = class Object3DInstance extends SDK.IWorldInstanceBase {
    constructor(sdkType, inst) {
      super(sdkType, inst)
      this.sdkType = sdkType
      this.loaded = false
      this.localCenter = [0, 0, 0]
      this.uid = inst.GetUID()
      this.layout = inst.GetLayout()
      this.xScale = 1
      this.yScale = 1
      this.zScale = 1
      this.debug = false
      this.minBB = [0, 0, 0]
      this.maxBB = [0, 0, 0]
      this._runtime = sdkType._project
      this.dataLoaded = false
      this.texture = []
      this.loadFailed = false
      this.materialsModify = new Map()
      this.lightEnable = false
      this.lightUpdate = false
      this.lightColor = 0
      this.spotEnable = false
      this.spotDir = [0, 0, 0]
      this.spotCutoff = 0
      this.spotEdge = 0
      this.vertexScale = 0

      this.xAngle = 0
      this.yAngle = 0
      this.zAngle = 0
      this.rotationOrder = "xyz"
      this.scale = "1"
      this.instanceModel = null
      this.instanceTexture = null
      this.gltfData = null
      this.wireframe = null
      this.isEditor = true
      this.xWireframeWidth = 1
      this.yWireframeWidth = 1
      this.zWireframeWidth = 1
      this.gltf = null

      this.drawVerts = null
      this.drawUVs = null
      this.drawIndices = null
      this.layoutView = null
      this.doingInit = false
      this.gltfPath = ""
      this.gltfDataLoad = false
      this.spriteTextures = new Map()
    }

    Release() {}

    OnCreate() {
      this.xAngle = this._inst.GetPropertyValue("angle-x")
      this.yAngle = this._inst.GetPropertyValue("angle-y")
      this.zAngle = this._inst.GetPropertyValue("angle-z")
      this.rotationOrder = this._inst.GetPropertyValue("rotation-order")
      this.scale = this._inst.GetPropertyValue("scale")
      // this._inst.SetZElevation(this._inst.GetPropertyValue('z-elevation'));
      // this._inst._UpdateZElevation();
      this.debug = this._inst.GetPropertyValue("debug")
      this.instanceModel = this._inst.GetPropertyValue("instance-model")
      this.instanceTexture = this._inst.GetPropertyValue("image-texture")
      this.gltfData = null
      this.xScale = this._inst.GetPropertyValue("x-scale")
      this.yScale = this._inst.GetPropertyValue("y-scale")
      this.zScale = this._inst.GetPropertyValue("z-scale")
      this.wireframe = this._inst.GetPropertyValue("wireframe")
      this.isEditor = true
      this.xWireframeWidth = 1
      this.yWireframeWidth = 1
      this.zWireframeWidth = 1

      const wi = this._inst
      wi.SetOriginY(0.5)
    }

    OnPlacedInLayout() {
      // Initialise to size of image
      this.OnMakeOriginalSize()
    }

    RendersToOwnZPlane() {
      return false
    }

    async doInit() {
      if (this.instanceModel) {
        this.gltf = new globalThis.GltfModel(this._runtime, this, this)
      } else {
        this.gltf = new globalThis.GltfModel(this._runtime, this.sdkType, this)
      }
      await this.gltf.init()
      this.loaded = true
      this.drawVerts = []
      this.drawUVs = []
      this.drawIndices = []
      this.gltf.getPolygons()
    }

    /**
     * Load the model. Kicked off from Draw but never awaited by it: the editor
     * declares Draw as returning void and calls it bare, so anything after an
     * await would issue its draw calls outside the editor's draw pass.
     */
    async _startLoad(iRenderer) {
      if (this._loading || this.loaded || this.loadFailed) return
      this._loading = true

      const sdkType = this.sdkType
      const gltfData = this.instanceModel ? this.gltfData : sdkType.gltfData
      const textures = this.instanceModel ? this.texture : sdkType.texture
      const whiteTextureOwner = this.instanceModel ? this : sdkType

      if (this.gltfPath === "" || this.gltfPath === "path") {
        this._loading = false
        return
      }

      if (!this.instanceModel && sdkType.initOwner !== -1 && !sdkType.dataLoaded) {
        // another instance of this type is already loading the shared model
        this._loading = false
        return
      }

      if (!this.instanceModel) sdkType.initOwner = this.uid
      else this.gltfDataLoad = true

      const result = await gltfData.load(this.gltfPath, false, this.debug)
      if (!result) {
        if (!this.instanceModel) sdkType.initOwner = -1
        else this.gltfDataLoad = false
        this.loadFailed = true
        this._loading = false
        return
      }
      await sdkType.LoadDynamicTextures(iRenderer, gltfData, textures, whiteTextureOwner, this.instanceModel)

      this.doingInit = true
      await this.doInit()
      this._loading = false
      this._syncSizeFromBounds()
      // One refresh on completion, not one per frame for as long as it takes.
      if (this.layoutView) this.layoutView.Refresh()
    }

    /**
     * Push the model bounds onto the instance, but only when they actually
     * change. Writing size and origin on every draw fights the user's own
     * resize and drag, and mutates state the editor is mid-render from.
     */
    _syncSizeFromBounds() {
      if (
        this.maxBB[0] === Number.POSITIVE_INFINITY ||
        this.minBB[0] === Number.NEGATIVE_INFINITY ||
        this.maxBB[1] === Number.POSITIVE_INFINITY ||
        this.minBB[1] === Number.NEGATIVE_INFINITY
      )
        return

      const wi = this._inst
      const x = wi.GetX()
      const y = wi.GetY()
      let width = this.maxBB[0] - this.minBB[0]
      let height = this.maxBB[1] - this.minBB[1]
      width = width == 0 ? 1 : width
      height = height == 0 ? 1 : height
      const originX = -(this.minBB[0] - x) / width
      const originY = -(this.minBB[1] - y) / height

      if (wi.GetWidth() !== width || wi.GetHeight() !== height) wi.SetSize(width, height)
      if (wi.GetOriginX() !== originX) wi.SetOriginX(originX)
      if (wi.GetOriginY() !== originY) wi.SetOriginY(originY)
    }

    _drawPlaceholder(iRenderer) {
      iRenderer.SetAlphaBlend()
      iRenderer.SetColorFillMode()
      if (this.HadTextureError()) iRenderer.SetColorRgba(0.25, 0, 0, 0.25)
      else iRenderer.SetColorRgba(0, 0, 0.5, 0.5)
      iRenderer.Quad(this._inst.GetQuad())
    }

    // Synchronous: the editor declares Draw as returning void and does not await
    // it, so this must never contain an await.
    Draw(iRenderer, iDrawParams) {
      if (this.loadFailed) return
      if (!this.layoutView) this.layoutView = iDrawParams.GetLayoutView()

      const texture = this.GetTexture()
      if (!texture) {
        this._drawPlaceholder(iRenderer)
        return
      }

      if (!this.scale) this.scale = this._inst.GetPropertyValue("scale")
      this.gltfPath = this._inst.GetPropertyValue("gtlf-path")

      if (this.instanceModel && this.gltfData == null) {
        this.gltfData = new globalThis.GltfData(this._runtime, this)
      }

      if (!this.loaded) {
        this._startLoad(iRenderer).catch((err) => {
          this.loadFailed = true
          this._loading = false
          console.error("[3DObject] editor model load failed", err)
        })
        this._drawPlaceholder(iRenderer)
        return
      }

      const textures = this.instanceModel ? this.texture : this.sdkType.texture
      const whiteTextureOwner = this.instanceModel ? this : this.sdkType

      this._inst.ApplyBlendMode(iRenderer)
      iRenderer.SetTexture(texture)
      iRenderer.SetColor(this._inst.GetColor())

      // getPolygons() is cached on the instance transform, so this is nearly
      // free on the frames where nothing moved.
      this.gltf.getPolygons()
      this.gltf.render(
        iRenderer,
        this._inst.GetX(),
        this._inst.GetY(),
        this._inst.GetZElevation(),
        new SDK.Quad(),
        whiteTextureOwner.whiteTexture,
        this._inst.GetColor(),
        textures,
        1 // opacity
      )

      this._syncSizeFromBounds()
    }

    GetTexture() {
      const image = this.GetObjectType().GetImage()
      return super.GetTexture(image)
    }

    IsOriginalSizeKnown() {
      return true
    }

    GetOriginalWidth() {
      return this.GetObjectType().GetImage().GetWidth()
    }

    GetOriginalHeight() {
      return this.GetObjectType().GetImage().GetHeight()
    }

    OnMakeOriginalSize() {
      const image = this.GetObjectType().GetImage()
      this._inst.SetSize(image.GetWidth(), image.GetHeight())
    }

    HasDoubleTapHandler() {
      return true
    }

    OnDoubleTap() {
      this.GetObjectType().EditImage()
    }

    OnPropertyChanged(id, value) {
      switch (id) {
        case "scale":
          this.scale = value
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "z-elevation":
          // this._inst.SetZElevation(value);
          // this._inst.UpdateZElevation();
          // if (this.layoutView) this.layoutView.Refresh();
          break
        case "angle-x":
        case "angle-y":
        case "angle-z":
        case "rotation-order":
          this.xAngle = this._inst.GetPropertyValue("angle-x")
          this.yAngle = this._inst.GetPropertyValue("angle-y")
          this.zAngle = this._inst.GetPropertyValue("angle-z")
          let order = this._inst.GetPropertyValue("rotation-order")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "gtlf-path":
          /*
                    if (this.sdkType.initOwner = this.uid)
                    {
                        this.gltfPath = this._inst.GetPropertyValue('gtlf-path');
                        console.info('gltf-path changed', this.gltfPath)
                        this.sdkType.gltfData.load(this.gltfPath, false)
                        if (this.layoutView) this.layoutView.Refresh();
                    }
                    */
          this.loadFailed = false
          break
        case "debug":
          this.debug = this._inst.GetPropertyValue("debug")
          break
        case "image-texture":
          this.instanceTexture = this._inst.GetPropertyValue("image-texture")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "instance-model":
          // this.instanceModel = this._inst.GetPropertyValue('instance-model');
          break
        case "x-scale":
          this.xScale = this._inst.GetPropertyValue("x-scale")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "y-scale":
          this.yScale = this._inst.GetPropertyValue("y-scale")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "z-scale":
          this.zScale = this._inst.GetPropertyValue("z-scale")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "wireframe":
          this.wireframe = this._inst.GetPropertyValue("wireframe")
          if (this.layoutView) this.layoutView.Refresh()
          break
        default:
          break
      }
    }

    OnTimelinePropertyChanged(id, value, detail) {
      switch (id) {
        case "angle-x":
          this.xAngle = this._inst.GetTimelinePropertyValue("angle-x")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "angle-y":
          this.yAngle = this._inst.GetTimelinePropertyValue("angle-y")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "angle-z":
          this.zAngle = this._inst.GetTimelinePropertyValue("angle-z")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "x-scale":
          this.xScale = this._inst.GetTimelinePropertyValue("x-scale")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "y-scale":
          this.yScale = this._inst.GetTimelinePropertyValue("y-scale")
          if (this.layoutView) this.layoutView.Refresh()
          break
        case "z-scale":
          this.zScale = this._inst.GetTimelinePropertyValue("z-scale")
          if (this.layoutView) this.layoutView.Refresh()
          break
      }
    }

    OnExitTimelineEditMode() {
      this.xAngle = this._inst.GetPropertyValue("angle-x")
      this.yAngle = this._inst.GetPropertyValue("angle-y")
      this.zAngle = this._inst.GetPropertyValue("angle-z")
      this.xScale = this._inst.GetPropertyValue("x-scale")
      this.yScale = this._inst.GetPropertyValue("y-scale")
      this.zScale = this._inst.GetPropertyValue("z-scale")

      if (this.layoutView) this.layoutView.Refresh()
    }

    LoadC2Property(name, valueString) {
      return false // not handled
    }
  }
}
