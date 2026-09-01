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





    EnableNode(nodeName, enable) {
      if (!this.gltf) return
      if (!this.gltf.gltfData) return

      const node = this._findNode(nodeName)
      if (!node) return
      node.disabled = !enable
      this.renderOnce = true
      this._invalidateEnabledBounds()
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
      this._invalidateEnabledBounds()
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
      this._invalidateEnabledBounds()
      this.allNodesDisabled = true
    },











    SetAnimationBlend(blendTime) {
      this.animationBlend = blendTime
    },




    // Deprecated no-ops. The GPU buffer path is the only path, so there is
    // nothing left to switch. Kept so existing projects still load.
    SetStaticGeometry(enable) {},
    SetGPUSkinning(enable) {},
  }
}

