// @ts-check
"use strict"
{
  //@ts-ignorets-ignore
  self.C3.Plugins.Mikal_3DObject.Acts = {
    SetZElevation0(z) {
      const wi = this.GetWorldInfo()
      wi.SetZElevation(z)
      wi._UpdateZElevation()
      this.updateBbox = true
      this.updateBbox = true
    },

    SetLocalCenter(x, y, z) {
      this.localCenter[0] = x
      this.localCenter[1] = y
      this.localCenter[2] = z
    },

    SetScale(scale) {
      this.scale = scale
      this.runtime.UpdateRender()
      this.updateBbox = true
    },

    SetRotationOrdered(x, y, z, order) {
      if (!this.loaded) return
      this.xAngle = x
      this.yAngle = y
      this.zAngle = z
      this.runtime.UpdateRender()
      this.updateBbox = true
    },

    PlayAnimation(animation, loop) {
      if (!this.loaded) return
      let names = this.gltf.getAnimationNames()
      if (!names) return
      let newAnimationIndex = -1
      names.forEach((name, index) => {
        if (animation == name) {
          newAnimationIndex = index
        }
      })
      if (newAnimationIndex >= 0) {
        this.animationName = animation
        this.animationTime = 0
        this.animationLastTime = 0
        this.animationIndex = newAnimationIndex
        this.animationLoop = loop
        this.animationPlay = true
        this.animationFinished = false
      }
      this.updateBbox = true
    },
    SetAnimationRate(rate) {
      this.animationRate = rate > 0 ? rate : 1
    },
    SetZHeight(h) {
      this._setZHeight(h)
      this.updateBbox = true
    },
    SetAnimationSpeed(speed) {
      this.animationSpeed = speed
    },
    StopAnimation() {
      this.animationPlay = false
    },
    UnpauseAnimation() {
      this.animationPlay = true
    },
    SetXScale(xScale) {
      this.xScale = xScale
      this.runtime.UpdateRender()
      this.updateBbox = true
    },
    SetYScale(yScale) {
      this.yScale = yScale
      this.runtime.UpdateRender()
      this.updateBbox = true
    },
    SetZScale(zScale) {
      this.zScale = zScale
      this.runtime.UpdateRender()
      this.updateBbox = true
    },
    UpdateBbox() {
      this.updateBbox = true
    },
    LoadModel(gltfPath) {
      if (!gltfPath || gltfPath == "" || gltfPath == "path") return
      if (this.instanceModel && this.dataLoaded) return
      if (!this.instanceModel && this.sdkType.dataLoaded) return

      if (this.instanceModel) {
        // Free the previous per-instance model data before replacing it
        if (this.gltfData && typeof this.gltfData.release === "function") {
          this.gltfData.release()
        }
        //@ts-ignore
        this.gltfData = new globalThis.GltfData(this.runtime, this)
        if (this.debug) console.info("gltfPath - ACE", gltfPath)
        this.gltfData.load(gltfPath, true, this.debug)
        this.gltfData.dynamicTexturesLoaded = false
        this.doingInit = false
        this.loaded = false
      } else {
        let sdkType = this.sdkType
        sdkType.initOwner = this.uid
        sdkType.gltfData.load(gltfPath, true, this.debug)
        sdkType.gltfData.dynamicTexturesLoaded = false
        this.doingInit = false
        this.loaded = false
      }
      this.runtime.UpdateRender()
      this.updateBbox = true
    },





    EnableNode(nodeName, enable) {
      if (!this.gltf) return
      if (!this.gltf.gltfData) return

      const node = this._findNode(nodeName)
      if (!node) return
      node.disabled = !enable
      this.renderOnce = true
      if (this.workerAnimation) {
        this.gltf.enableNode(nodeName, enable)
      }
      // Clear the allNodesDisabled flag if enabling any node
      if (enable) {
        this.allNodesDisabled = false
      }
    },

    EnableAllNodes() {
      if (!this.gltf) return
      if (!this.gltf.gltfData) return

      // Enable all skinned nodes
      if (this.gltf.gltfData.skinnedNodes?.length) {
        for (let ii = 0; ii < this.gltf.gltfData.skinnedNodes.length; ii++) {
          let node = this.gltf.gltfData.skinnedNodes[ii]
          node.disabled = false
          if (this.workerAnimation) {
            this.gltf.enableNode(node.name, true)
          }
        }
      }

      // Enable all regular nodes
      if (this.gltf.gltfData.nodes?.length) {
        for (let ii = 0; ii < this.gltf.gltfData.nodes.length; ii++) {
          let node = this.gltf.gltfData.nodes[ii]
          node.disabled = false
          if (this.workerAnimation) {
            this.gltf.enableNode(node.name, true)
          }
        }
      }

      this.renderOnce = true
      this.allNodesDisabled = false
    },

    DisableAllNodes() {
      if (!this.gltf) return
      if (!this.gltf.gltfData) return

      // Disable all skinned nodes
      if (this.gltf.gltfData.skinnedNodes?.length) {
        for (let ii = 0; ii < this.gltf.gltfData.skinnedNodes.length; ii++) {
          let node = this.gltf.gltfData.skinnedNodes[ii]
          node.disabled = true
          if (this.workerAnimation) {
            this.gltf.enableNode(node.name, false)
          }
        }
      }

      // Disable all regular nodes
      if (this.gltf.gltfData.nodes?.length) {
        for (let ii = 0; ii < this.gltf.gltfData.nodes.length; ii++) {
          let node = this.gltf.gltfData.nodes[ii]
          node.disabled = true
          if (this.workerAnimation) {
            this.gltf.enableNode(node.name, false)
          }
        }
      }

      this.renderOnce = true
      this.allNodesDisabled = true
    },





    SetOriginX(xOrigin) {
      const wi = this.GetWorldInfo()
      wi.SetOriginX(xOrigin)
      wi.SetBboxChanged()
    },

    SetOriginY(yOrigin) {
      const wi = this.GetWorldInfo()
      wi.SetOriginY(yOrigin)
      wi.SetBboxChanged()
    },

    SetBBoxScale(scale) {
      this._setBBoxScale(scale)
      this.updateBbox = true
    },

    SetUseBoneBoundingBox(enable) {
      this.useBoneBoundingBox = enable
      this.updateBbox = true
    },



    LoadModelFromTemplate(uid) {
      if (!this.instanceModel) {
        console.warn("LoadModelFromTemplate only works on instance models")
        return
      }
      const template = this.runtime.GetInstanceByUID(uid)
      if (!template) {
        console.warn("LoadModelFromTemplate template uid not found", uid)
        return
      }
      const objectName = this.GetObjectClass().GetName()
      const templateObjectName = template.GetObjectClass().GetName()
      if (objectName !== templateObjectName) {
        console.warn(
          "LoadModelFromTemplate: template object type does not match, instance uid, template uid",
          this.uid,
          uid
        )
        return
      }
      const templateInst = template.GetSdkInstance()
      if (!templateInst.loaded) {
        console.warn("LoadModelFromTemplate: template not loaded, instance uid, template uid", this.uid, uid)
        return
      }
      this.sdkType = templateInst
      this.sdkType.dataLoaded = true
      this.instanceModel = false
    },
    SetAnimationBlend(blendTime) {
      this.animationBlend = blendTime
    },



    SetQuaternion(quaternion, x, y, z) {
      this._setQuaternion(quaternion, x, y, z)
    },

    EnableQuaternion(enable) {
      this._enableQuaternion(enable)
    },
    SetStaticGeometry(enable) {
      this.staticGeometry = enable
      if (enable) {
        this.renderOnce = true
      }
    },
    SetGPUSkinning(enable) {
      this.staticGeometry = enable
      this.gpuSkinning = enable
      if (enable) {
        this.renderOnce = true
      }
    },
    SetTargetToPosition(x, y, z, upX, upY, upZ) {
      const mat4 = globalThis.glMatrix3D.mat4
      const quat = globalThis.glMatrix3D.quat
      const mat3 = globalThis.glMatrix3D.mat3
      const targetToQuat = quat.create()
      const wi = this.GetWorldInfo()
      const eye = [wi.GetX(), wi.GetY(), wi.GetTotalZElevation()]
      const target = [x, y, z]
      const up = [upX, upY, upZ]
      const targetTo = mat4.create()
      mat4.targetTo(targetTo, target, eye, up)
      const targetToMat3 = mat3.create()
      mat3.fromMat4(targetToMat3, targetTo)
      quat.fromMat3(targetToQuat, targetToMat3)
      this.enableQuaternion = true
      quat.copy(this.quaternion, targetToQuat)
    },
  }
}

