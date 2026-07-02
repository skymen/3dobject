// @ts-check
"use strict"

const SHADER_MAX_BONES = 256; // Maximum bones supported by the shader's UBO definition

class GltfData {
  constructor(runtime, sdkType) {
    this._runtime = runtime
    this._sdkType = sdkType
    this.gltf = {}
    this.dynamicTexturesLoaded = false
    this.imageBitmap = {}
    this.sharedModelBoneUbo = null; // For the shared UBO containing bone matrices for this model asset
    this.bonesPerModelAsset = 0; // Actual number of bones in this model asset
    this.rendererForUbo = null; // Store renderer for UBO release
    this._cacheEntry = null; // Cross-type model cache entry (shared parsed gltf + GPU textures)
  }

  release() {
    if (this._dracoDecoder) {
      this._dracoDecoder.dispose();
      this._dracoDecoder = null;
    }

    // Cache-shared model: only drop our reference; shared resources are freed
    // with the last reference (the object graph itself is left to GC)
    if (this._cacheEntry) {
      const entry = this._cacheEntry
      this._cacheEntry = null
      entry.refCount--
      if (entry.refCount <= 0) {
        if (globalThis.gltf3DObjectModelCache) globalThis.gltf3DObjectModelCache.delete(entry.key)
        const renderer = entry.renderer
        if (renderer) {
          if (entry.textures) {
            for (const name in entry.textures) renderer.DeleteTexture(entry.textures[name])
          }
          if (entry.whiteTexture) renderer.DeleteTexture(entry.whiteTexture)
        }
        entry.textures = null
        entry.whiteTexture = null
        // Close bitmaps in case textures were never uploaded (close is a no-op if already closed)
        if (entry.imageBitmap) {
          for (const key in entry.imageBitmap) {
            const bitmap = entry.imageBitmap[key]
            if (bitmap && typeof bitmap.close === "function") bitmap.close()
          }
          entry.imageBitmap = null
        }
        if (entry.whiteImageBitmap && typeof entry.whiteImageBitmap.close === "function") {
          entry.whiteImageBitmap.close()
        }
        entry.whiteImageBitmap = null
        entry.gltf = null
      }
      // @ts-ignore
      this.gltf = null
      // @ts-ignore
      this.imageBitmap = null
      this._runtime = null
      this._sdkType = null
      // @ts-ignore
      this.dynamicTexturesLoaded = null
      if (this.sharedModelBoneUbo && this.rendererForUbo) {
        const gl = this.rendererForUbo._gl
        if (gl) gl.deleteBuffer(this.sharedModelBoneUbo)
        this.sharedModelBoneUbo = null
      }
      this.rendererForUbo = null
      return
    }

    // Release gltf data structure contents
    if (this.gltf) {
      // Release buffers
      if (this.gltf.buffers) {
        this.gltf.buffers = null
      }

      // Release boneBuffers in each node
      if (this.gltf.nodes) {
        const nodes = this.gltf.nodes
        const nodeCount = nodes.length
        for (let i = 0; i < nodeCount; i++) {
          const node = nodes[i]
          if (node && node.boneBuffer && typeof node.boneBuffer.release === 'function') {
            node.boneBuffer.release()
          }
        }
      }

      // Release accessors data
      if (this.gltf.accessors) {
        const accessors = this.gltf.accessors
        const accessorCount = accessors.length
        for (let i = 0; i < accessorCount; i++) {
          if (accessors[i]) {
            accessors[i].data = null
          }
        }
      }

      // Release skinned nodes
      if (this.gltf.skinnedNodes) {
        const skinnedNodes = this.gltf.skinnedNodes
        const skinnedNodeCount = skinnedNodes.length
        for (let i = 0; i < skinnedNodeCount; i++) {
          const skinnedNode = skinnedNodes[i]
          if (skinnedNode) {
            skinnedNode.invMatrix = null
            skinnedNode.boneMatrix = null
          }
        }
      }

      // Release matrices
      if (this.gltf.skins) {
        const skins = this.gltf.skins
        const skinCount = skins.length
        for (let i = 0; i < skinCount; i++) {
          const skin = skins[i]
          if (skin) {
            skin.inverseBindMatrices = null
            if (skin.joints) {
              const joints = skin.joints
              const jointCount = joints.length
              for (let j = 0; j < jointCount; j++) {
                const joint = joints[j]
                if (joint) {
                  joint.invBindMatrix = null
                  joint.boneMatrix = null
                }
              }
            }
          }
        }
      }
    }

    // Release image bitmaps
    for (const key in this.imageBitmap) {
      if (this.imageBitmap[key]) {
        if (typeof this.imageBitmap[key].close === 'function') {
          this.imageBitmap[key].close();
        }
        this.imageBitmap[key] = null;
      }
    }

    // Release white image bitmap
    if (this.whiteImageBitmap) {
      if (typeof this.whiteImageBitmap.close === 'function') {
        this.whiteImageBitmap.close();
      }
      this.whiteImageBitmap = null;
    }

    // Release references
    // @ts-ignore
    this.gltf = null
    // @ts-ignore
    this.imageBitmap = null
    this._runtime = null
    this._sdkType = null
    // @ts-ignore
    this.dynamicTexturesLoaded = null

    // Release shared UBO if it exists
    if (this.sharedModelBoneUbo && this.rendererForUbo) {
      const gl = this.rendererForUbo._gl;
      if (gl) {
        if (this._debug) console.log("Deleting shared Bone UBO for model asset");
        gl.deleteBuffer(this.sharedModelBoneUbo);
      }
      this.sharedModelBoneUbo = null;
    }
    this.rendererForUbo = null;
  }

  /*
	Requests an url as a json file, then does some processing on that, and finally calls a js or c2 function.
	Expects an "embeded" gltf file.

	Different object types loading the same model file share one parsed gltf (and
	later one set of GPU textures) through a global cache keyed by path. Editor and
	Editor loads bypass the cache.
    */
  async load(gltfPath, isRuntime, debug) {
    if (!isRuntime) {
      return this._loadDirect(gltfPath, isRuntime, debug)
    }

    if (!globalThis.gltf3DObjectModelCache) globalThis.gltf3DObjectModelCache = new Map()
    const cache = globalThis.gltf3DObjectModelCache
    let entry = cache.get(gltfPath)
    if (entry && entry.runtime !== this._runtime) {
      // Stale entry from a previous runtime session
      cache.delete(gltfPath)
      entry = null
    }

    if (entry) {
      // Adopt the shared model loaded (or being loaded) by another object type
      entry.refCount++
      this._cacheEntry = entry
      this._debug = debug
      this.rendererForUbo = this._runtime.GetCanvasManager().GetWebGLRenderer()
      const ok = await entry.promise
      if (!ok) return false
      this.gltf = entry.gltf
      this.bonesPerModelAsset = entry.bonesPerModelAsset
      if (this._sdkType) this._sdkType.dataLoaded = true
      return true
    }

    // First loader of this path: parse and publish into the cache
    entry = {
      key: gltfPath,
      runtime: this._runtime,
      refCount: 1,
      promise: null,
      gltf: null,
      imageBitmap: null,
      whiteImageBitmap: null,
      bonesPerModelAsset: 0,
      texturesPromise: null,
      textures: null,
      whiteTexture: null,
      renderer: null,
    }
    this._cacheEntry = entry
    cache.set(gltfPath, entry)
    entry.promise = this._loadDirect(gltfPath, isRuntime, debug)
      .then((ok) => {
        if (ok) {
          entry.gltf = this.gltf
          entry.imageBitmap = this.imageBitmap
          entry.whiteImageBitmap = this.whiteImageBitmap
          entry.bonesPerModelAsset = this.bonesPerModelAsset
        } else {
          cache.delete(gltfPath)
        }
        return ok
      })
      .catch((err) => {
        cache.delete(gltfPath)
        if (debug) console.error("[3DObject] model load failed:", gltfPath, err)
        return false
      })
    return entry.promise
  }

  async _loadDirect(gltfPath, isRuntime, debug) {
    let runtime = this._runtime
    let sdkType = this._sdkType
    this._debug = debug // Store debug flag for use in other methods
    
    if (isRuntime) {
      this.rendererForUbo = runtime.GetCanvasManager().GetWebGLRenderer(); // Store renderer for UBO management only in runtime
    } else {
      this.rendererForUbo = null; // Ensure it's null in edittime
    }

    if (debug) console.info("load gltfPath", gltfPath)

    let gltfURI
    if (isRuntime) {
      gltfURI = await runtime.GetAssetManager().GetProjectFileUrl(gltfPath)
    } else {
      if (gltfPath.includes("http")) {
        // Can't load from URL in editor
        alert("Cannot load from URL in editor")
        return false
      } else {
        // Get iProjectFiles
        gltfURI = await runtime.GetProjectFileByExportPath(gltfPath)
      }
    }

    if (gltfURI === null) {
      alert("gltfPath not found: " + gltfPath)
      if (this._debug) console.warn("glfPath not found:", gltfPath)
      return false
    }

    const isBinary = gltfPath.includes(".glb") || gltfPath.includes("ext=glb")

    let resultgltf

    // resultgltf = await this.loadGLTF(gltfURI, isRuntime, debug, isBinary)

    // Don't crash on loading error
    try {
      resultgltf = await this.loadGLTF(gltfURI, isRuntime, debug, isBinary)
    } catch (err) {
      alert("Error loading GLTF:" + err)
      if (this._debug) console.error("Error loading GLTF:", err)
      return false
    }

    if (resultgltf) {
      if (debug) console.info("[3DObject] modelData:", resultgltf)
      sdkType.dataLoaded = true
    } else {
      if (this._debug) console.warn("[3DObject] Unable to load gltf files")
      alert("Unable to load gltf files")
      return false
    }

    this.gltf = resultgltf

    // Determine bonesPerModelAsset after gltf is fully processed
    this._calculateBonesPerModelAsset();

    // Draco decoding is done; terminate its worker pool (recreated on demand if needed)
    if (this._dracoDecoder) {
      this._dracoDecoder.dispose();
      this._dracoDecoder = null;
    }

    return true
  }

  /*
	Once the gltf file is loaded as a json this does a few things to it to make out lives easier.
	1. It converts the buffers from base64 to a typed array.
	2. The accessors are then made as typed views of the buffers.
	3. All the places where indexes are used are changed to look at those objects themselves.
	4. Adds some properties that are optionally in the gltf file.
	5. Adds a few properties that are utilized when getting data from skinning.
*/
  async loadGLTF(uri, isRuntime, debug, isBinary) {
    let gltf
    let binBuffer

    if (debug) console.info("loadGLTF", uri)

    if (isRuntime) {
      if (isBinary) {
        let response = await fetch(uri, { mode: "cors" })
        let buffer = await response.arrayBuffer()
        const magic = new DataView(buffer.slice(0, 4)).getUint32(0, true)
        const version = new DataView(buffer.slice(4, 8)).getUint32(0, true)
        const jsonBufSize = new DataView(buffer.slice(12, 16)).getUint32(0, true)

        let utf8decoder = new TextDecoder()
        let jsonString = utf8decoder.decode(buffer.slice(20, 20 + jsonBufSize))
        gltf = JSON.parse(jsonString)
        binBuffer = buffer.slice(jsonBufSize + 28)
      } else {
        try {
          let response = await fetch(uri)
          let text = await response.text()
          gltf = JSON.parse(text)
        } catch (err) {
          if (debug) console.error("[3DShape], cannot fetch/parse gltf", uri)
          return false
        }
      }
    } else {
      if (isBinary) {
        try {
          let projectFile = await uri.GetBlob()
          if (!projectFile) return false
          let buffer = await projectFile.arrayBuffer()
          // if (!buffer) return false;
          const magic = new DataView(buffer.slice(0, 4)).getUint32(0, true)
          const version = new DataView(buffer.slice(4, 8)).getUint32(0, true)
          const jsonBufSize = new DataView(buffer.slice(12, 16)).getUint32(0, true)

          let utf8decoder = new TextDecoder()
          let jsonString = utf8decoder.decode(buffer.slice(20, 20 + jsonBufSize))

          gltf = JSON.parse(jsonString)
          binBuffer = buffer.slice(jsonBufSize + 28)
        } catch (err) {
          if (debug) console.error("[3DShape], cannot fetch/parse gltf blob", err)
          return false
        }
      } else {
        try {
          let projectFile = await uri.GetBlob()
          if (!projectFile) return false
          let text = await projectFile.text()
          if (!text) return false
          gltf = JSON.parse(text)
        } catch (err) {
          if (debug) console.error("[3DShape], cannot fetch/parse gltf blob", uri)
          return false
        }
      }
    }

    if (!gltf) return false

    // Debug GLTF file structure
    if (debug) {
      console.log('[DEBUG] GLTF file structure:', {
        asset: gltf.asset,
        extensionsUsed: gltf.extensionsUsed,
        extensionsRequired: gltf.extensionsRequired,
        hasBuffers: !!gltf.buffers,
        bufferCount: gltf.buffers?.length,
        hasBufferViews: !!gltf.bufferViews,
        bufferViewCount: gltf.bufferViews?.length,
        hasAccessors: !!gltf.accessors,
        accessorCount: gltf.accessors?.length,
        hasMeshes: !!gltf.meshes,
        meshCount: gltf.meshes?.length
      })
    }

    const isEditorEnvironment = !isRuntime
    
    // Check for Draco in extensions
    let hasDracoCompression = false
    if (gltf.extensionsUsed && gltf.extensionsUsed.includes('KHR_draco_mesh_compression')) {
      hasDracoCompression = true
      if (debug) {
        console.log('GLTF file declares Draco compression in extensionsUsed')
      }
    } else if (debug) {
      console.log('📄 GLTF file does not declare Draco compression in extensionsUsed')
    }

    //extra variable for a list of skinned meshes.  They need to be transformed after the rest.
    gltf.skinnedNodes = []

    // buffers - convert to typed arrays
    const bufferCount = gltf.buffers.length
    for (let i = 0; i < bufferCount; i++) {
      if (isBinary) {
        gltf.buffers[i] = new Uint8Array(binBuffer).buffer
      } else {
        let base64 = gltf.buffers[i].uri.slice(37)
        // @ts-ignore
        gltf.buffers[i] = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer
      }
    }

    // Store runtime mode for use in other methods
    this._isRuntime = isRuntime;
    
    // Process meshes - handle Draco in both editor and runtime environments  
    if (isEditorEnvironment && hasDracoCompression) {
      if (debug) console.log('🔥 EDITOR MODE: Initializing Draco with JavaScript decoder for editor compatibility')
      // Initialize Draco decoder with JS code for editor mode
      await this._initEditorDracoDecoder()
      // Process meshes with Draco support enabled
      await this._processMeshes(gltf)
      // Now process remaining accessors (non-Draco ones)
      await this._processAccessors(gltf)
    } else {
      // Process meshes first to handle Draco compression, then process accessors
      await this._processMeshes(gltf)
      // Now process remaining accessors (non-Draco ones)
      await this._processAccessors(gltf)
    }

    // scene
    if (typeof gltf.scene === "undefined") gltf.scene = 0
    gltf.scene = gltf.scenes[gltf.scene]

    // scenes
    const sceneCount = gltf.scenes.length
    const nodes = gltf.nodes
    for (let i = 0; i < sceneCount; i++) {
      const s = gltf.scenes[i]
      const nodeCount = s.nodes.length
      for (let j = 0; j < nodeCount; j++) {
        s.nodes[j] = nodes[s.nodes[j]]
      }
    }

    // nodes
    const nodeCount = gltf.nodes.length
    const nodeMeshes = gltf.meshes
    const nodeSkins = gltf.skins
    for (let i = 0; i < nodeCount; i++) {
      const n = gltf.nodes[i]

      if (n.translation == undefined) n.translation = [0, 0, 0]
      if (n.scale == undefined) n.scale = [1, 1, 1]
      if (n.rotation == undefined) n.rotation = [0, 0, 0, 1]
      if (n.matrix == undefined) n.matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

      if (n.mesh != undefined) n.mesh = nodeMeshes[n.mesh]
      if (n.skin != undefined) {
        n.skin = nodeSkins[n.skin]
        n.invMatrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        gltf.skinnedNodes.push(n)
      }
      if (n.children != undefined) {
        const childCount = n.children.length
        for (let j = 0; j < childCount; j++) {
          n.children[j] = nodes[n.children[j]]
        }
      }
    }

    // animations
    if (gltf.animations) {
      const animationCount = gltf.animations.length
      const animAccessors = gltf.accessors
      for (let i = 0; i < animationCount; i++) {
        const a = gltf.animations[i]

        const channelCount = a.channels.length
        for (let j = 0; j < channelCount; j++) {
          const c = a.channels[j]
          c.sampler = a.samplers[c.sampler]
          c.target.node = nodes[c.target.node]
        }

        const samplerCount = a.samplers.length
        for (let j = 0; j < samplerCount; j++) {
          const s = a.samplers[j]
          s.input = animAccessors[s.input]
          s.output = animAccessors[s.output]
        }
      }
    }

    // images
    if ("images" in gltf && gltf.images.length > 0) {
      const textures = gltf.textures
      const textureCount = textures.length
      const samplers = gltf.samplers
      for (let ii = 0; ii < textureCount; ii++) {
        const t = textures[ii]
        t.wrapS = "repeat"
        t.wrapT = "repeat"
        // webp support
        if (t?.extensions?.EXT_texture_webp?.source != undefined) {
          t.source = t.extensions.EXT_texture_webp.source
        }
        if (t.source != undefined && samplers != undefined && t.sampler != undefined) {
          const sampler = samplers[t.sampler]
          const wrapS = sampler.wrapS
          const wrapT = sampler.wrapT
          switch (wrapS) {
            case 33071:
              t.wrapS = "clamp-to-edge"
              break
            case 33648:
              t.wrapS = "mirror-repeat"
              break
            case 10497:
              t.wrapS = "repeat"
              break
            default:
              t.wrapS = "repeat"
          }
          switch (wrapT) {
            case 33071:
              t.wrapT = "clamp-to-edge"
              break
            case 33648:
              t.wrapT = "mirror-repeat"
              break
            case 10497:
              t.wrapT = "repeat"
              break
            default:
              t.wrapT = "repeat"
          }
        }
      }
      const images = gltf.images
      const imageCount = images.length
      for (let i = 0; i < imageCount; i++) {
        const image = images[i]
        // If image has no name, set it to the index.
        if (!("name" in image)) image.name = "image-index-" + i
        let blob
        try {
          if ("bufferView" in image) {
            const bufview = gltf.bufferViews[image.bufferView]
            let imageBuffer
            if (binBuffer) {
              imageBuffer = binBuffer.slice(bufview.byteOffset, bufview.byteOffset + bufview.byteLength)
            } else {
              imageBuffer = gltf.buffers[0].slice(bufview.byteOffset, bufview.byteOffset + bufview.byteLength)
            }
            blob = await new Blob([imageBuffer])
          } else {
            let uri = image.uri
            if (!uri.includes("data:") && !isRuntime) {
              uri = this._runtime.GetProjectFileByExportPath(uri)
              blob = await uri.GetBlob()
            } else {
              blob = await (await fetch(uri)).blob()
            }
          }
        } catch (err) {
          if (debug) console.error("Error loading image:", err)
          alert("Error loading image: " + err)
          blob = null
          return
        }
        let imageBitmap
        // @ts-ignore
        if (globalThis.createImageBitmap) {
          imageBitmap = await createImageBitmap(blob)
        } else {
          imageBitmap = await this.createImageBitmap(blob)
        }
        // this.imageBitmap.push(imageBitmap)
        this.imageBitmap[image.name] = imageBitmap
        const texture = textures.find((t) => t.source == i)
        this.imageBitmap[image.name].wrapS = texture.wrapS
        this.imageBitmap[image.name].wrapT = texture.wrapT
      }
    }

    // Standard GLTF processing for non-Draco primitives (after Draco has been handled)
    await this._processStandardPrimitives(gltf)

    // Compact accessors: accessor data are views over the whole GLB binary (including
    // embedded image bytes already extracted above), which keeps the entire binary alive.
    // Copy each view into its own compact buffer, then drop the source buffers.
    // Must run before the skins block below, which creates subarrays of accessor data.
    if (gltf.accessors) {
      for (const a of gltf.accessors) {
        if (a && a.data && a.data.buffer && a.data.byteLength < a.data.buffer.byteLength) {
          a.data = a.data.slice()
        }
      }
    }
    gltf.buffers = null

    //skins
    if (gltf.skins) {
      const skinSkins = gltf.skins
      const skinCount = skinSkins.length
      const skinAccessors = gltf.accessors
      for (let i = 0; i < skinCount; i++) {
        const s = skinSkins[i]
        s.inverseBindMatrices = skinAccessors[s.inverseBindMatrices]
        const jointCount = s.joints.length
        for (let j = 0; j < jointCount; j++) {
          s.joints[j] = gltf.nodes[s.joints[j]]
          s.joints[j].invBindMatrix = s.inverseBindMatrices.data.subarray(j * 16, j * 16 + 16)
          s.joints[j].boneMatrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        }
      }
    }
    // Create white texture
    const whitePNGURI =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAFElEQVR42mP8/58BL2AcVTCSFAAA0rYf8R32RV0AAAAASUVORK5CYII="
    const blob = await (await fetch(whitePNGURI)).blob()
    // @ts-ignore
    if (globalThis.createImageBitmap) {
      this.whiteImageBitmap = await createImageBitmap(blob)
    } else {
      this.whiteImageBitmap = await this.createImageBitmap(blob)
    }

    let min = [Infinity, Infinity, Infinity]
    let max = [-Infinity, -Infinity, -Infinity]

    const boundingMeshes = gltf.meshes
    const boundingMeshCount = boundingMeshes.length
    for (let i = 0; i < boundingMeshCount; i++) {
      const mesh = boundingMeshes[i]
      const primitiveCount = mesh.primitives.length
      for (let j = 0; j < primitiveCount; j++) {
        const primitive = mesh.primitives[j]
        const positionAccessor = primitive.attributes.POSITION
        if (positionAccessor) {
          const minVals = positionAccessor.min
          const maxVals = positionAccessor.max
          min = min.map((val, idx) => Math.min(val, minVals[idx]))
          max = max.map((val, idx) => Math.max(val, maxVals[idx]))
        }
      }
    }

    gltf.boundingBox = { min, max }

    return gltf
  }

  /* Safari and Edge polyfill for createImageBitmap
   * https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/createImageBitmap
   */
  async createImageBitmap(blob) {
    return new Promise((resolve, reject) => {
      let img = document.createElement("img")
      img.addEventListener("load", function () {
        resolve(this)
      })
      img.src = URL.createObjectURL(blob)
    })
  }

  _calculateBonesPerModelAsset() {
    // The shader UBO holds SHADER_MAX_BONES matrices; the bone count for this model
    // is the highest joint index referenced by any JOINTS_0 attribute, plus one.
    let modelMaxJointIndex = -1;
    if (this.gltf && this.gltf.meshes) {
        for (const mesh of this.gltf.meshes) {
            for (const primitive of mesh.primitives) {
                if (primitive.attributes.JOINTS_0) {
                    const jointData = primitive.attributes.JOINTS_0.data;
                    for (let k = 0; k < jointData.length; k++) {
                        if (jointData[k] > modelMaxJointIndex) {
                            modelMaxJointIndex = jointData[k];
                        }
                    }
                }
            }
        }
    }

    if (modelMaxJointIndex > -1) {
        this.bonesPerModelAsset = modelMaxJointIndex + 1;
    } else if (this.gltf && this.gltf.skins && this.gltf.skins.length > 0) {
        // Fallback: inverse-bind-matrix count of the largest skin
        let maxSkinJoints = 0;
        for (const skin of this.gltf.skins) {
            if (skin.inverseBindMatrices && skin.inverseBindMatrices.data) {
                const jointCountForThisSkin = skin.inverseBindMatrices.data.length / 16;
                if (jointCountForThisSkin > maxSkinJoints) {
                    maxSkinJoints = jointCountForThisSkin;
                }
            }
        }
        this.bonesPerModelAsset = maxSkinJoints;
    } else {
        this.bonesPerModelAsset = 0; // No skins, no bones needed for skinning UBO
    }

    if (this.bonesPerModelAsset > SHADER_MAX_BONES) {
        console.error(
            "[3DObject] Model uses " + this.bonesPerModelAsset + " joints but the shader supports " +
            SHADER_MAX_BONES + "; skinning will be truncated."
        );
        this.bonesPerModelAsset = SHADER_MAX_BONES;
    }

    if (this.bonesPerModelAsset > 0 && this._debug) {
        console.log(`Calculated bonesPerModelAsset: ${this.bonesPerModelAsset}`);
    }
  }

  // Initialize Draco decoder for editor mode with embedded JavaScript decoder
  async _initEditorDracoDecoder() {
    if (this._dracoDecoder) {
      return // Already initialized
    }

    try {
      if (this._debug) console.log('🔥 Initializing Draco decoder for editor mode with embedded JS decoder...')
      
      // Create DRACODecoder instance for editor mode
      // Uses embedded JS decoder string from globalThis.dracoDecoderGltfString
      this._dracoDecoder = new DRACODecoder(this._runtime, true)
      
      await this._dracoDecoder.preload()
      if (this._debug) console.log('🔥 Successfully initialized Draco decoder for editor mode')
      
    } catch (error) {
      if (this._debug) console.error('❌ Failed to initialize editor Draco decoder:', error)
      throw error
    }
  }

  // Process Draco compressed primitive
  async _processDracoPrimitive(primitive, gltf) {
    if (this._debug) {
      console.log('[DEBUG] Starting Draco primitive processing...')
    }
    
    const dracoExtension = primitive.extensions.KHR_draco_mesh_compression
    if (this._debug) {
      console.log('[DEBUG] Draco extension data:', dracoExtension)
    }
    
    try {
      // Initialize Draco decoder if not already done
      if (!this._dracoDecoder) {
        // Determine if we're in editor mode using stored runtime state
        const isEditorMode = !this._isRuntime
        
        if (isEditorMode) {
          if (this._debug) console.warn('⚠️ Draco decoder not initialized in editor mode, creating editor-mode decoder')
          this._dracoDecoder = new DRACODecoder(this._runtime, true)
        } else {
          if (this._debug) console.warn('⚠️ Draco decoder not initialized in runtime mode, creating runtime-mode decoder')
          this._dracoDecoder = new DRACODecoder(this._runtime)
          this._dracoDecoder.setDecoderPath('') // Path is handled by our wrapper
        }
        await this._dracoDecoder.preload()
      }

      // Get compressed buffer data
      const bufferView = gltf.bufferViews[dracoExtension.bufferView]
      const buffer = gltf.buffers[bufferView.buffer]
      const byteOffset = bufferView.byteOffset || 0
      const byteLength = bufferView.byteLength
      
      const compressedBuffer = new Uint8Array(buffer, byteOffset, byteLength)
      
      // Map GLTF attribute names to Draco attribute IDs
      const attributeIDs = {}
      const attributeTypes = {}
      
      for (const [gltfAttr, dracoId] of Object.entries(dracoExtension.attributes)) {
        attributeIDs[gltfAttr] = dracoId
        // Set appropriate attribute types
        switch (gltfAttr) {
          case 'POSITION':
          case 'NORMAL':
          case 'TEXCOORD_0':
          case 'TEXCOORD_1':
            attributeTypes[gltfAttr] = 'Float32Array'
            break
          case 'COLOR_0':
            attributeTypes[gltfAttr] = 'Float32Array'
            break
          case 'JOINTS_0':
            attributeTypes[gltfAttr] = 'Uint16Array'
            break
          case 'WEIGHTS_0':
            attributeTypes[gltfAttr] = 'Float32Array'
            break
          default:
            attributeTypes[gltfAttr] = 'Float32Array'
        }
      }

      // Decode the geometry
      const decodedGeometry = await this._dracoDecoder.decodePrimitive(
        compressedBuffer, attributeIDs, attributeTypes
      )

      // Create GLTF-compatible accessors from decoded data
      let nextAccessorIndex = gltf.accessors.length

      // Process indices
      if (decodedGeometry.indices) {
        const indicesAccessor = {
          componentType: decodedGeometry.indices.componentType,
          count: decodedGeometry.indices.count,
          type: 'SCALAR',
          data: decodedGeometry.indices.data,
          min: [Math.min(...decodedGeometry.indices.data)],
          max: [Math.max(...decodedGeometry.indices.data)],
          _dracoDecoded: true // Mark as Draco decoded
        }
        
        gltf.accessors[nextAccessorIndex] = indicesAccessor
        primitive.indices = indicesAccessor
        nextAccessorIndex++
      }

      // Process attributes
      primitive.attributes = {}
      for (const [attrName, attrData] of Object.entries(decodedGeometry.attributes)) {
        const accessor = {
          componentType: attrData.componentType,
          count: attrData.count,
          type: attrData.type,
          data: attrData.data,
          normalized: attrData.normalized,
          _dracoDecoded: true // Mark as Draco decoded
        }

        // Calculate min/max for position attributes
        if (attrName === 'POSITION' && attrData.itemSize === 3) {
          const data = attrData.data
          let min = [Infinity, Infinity, Infinity]
          let max = [-Infinity, -Infinity, -Infinity]
          
          for (let i = 0; i < data.length; i += 3) {
            min[0] = Math.min(min[0], data[i])
            min[1] = Math.min(min[1], data[i + 1])
            min[2] = Math.min(min[2], data[i + 2])
            max[0] = Math.max(max[0], data[i])
            max[1] = Math.max(max[1], data[i + 1])
            max[2] = Math.max(max[2], data[i + 2])
          }
          
          accessor.min = min
          accessor.max = max
        }

        gltf.accessors[nextAccessorIndex] = accessor
        primitive.attributes[attrName] = accessor
        nextAccessorIndex++
      }

      // Mark primitive as Draco processed
      primitive._dracoProcessed = true

      // Remove Draco extension after processing
      delete primitive.extensions.KHR_draco_mesh_compression
      if (Object.keys(primitive.extensions).length === 0) {
        delete primitive.extensions
      }

      if (this._debug) console.log('Successfully decoded Draco primitive with', Object.keys(decodedGeometry.attributes).length, 'attributes')
      
    } catch (error) {
      if (this._debug) console.error('Failed to decode Draco primitive:', error)
      throw error
    }
  }

  async _processMeshes(gltf) {
    // Cache array length
    const meshCount = gltf.meshes.length
    
    for (let i = 0; i < meshCount; i++) {
      const mesh = gltf.meshes[i]
      if (this._debug) console.log(`[DEBUG] Processing mesh ${i} with ${mesh.primitives.length} primitives`)
      
      for (let j = 0; j < mesh.primitives.length; j++) {
        const primitive = mesh.primitives[j]
        
        // Check for Draco extension
        if (primitive.extensions && primitive.extensions['KHR_draco_mesh_compression']) {
          if (this._debug) {
            console.log(`🔥 Found Draco primitive in mesh ${i}, primitive ${j}`)
            const dracoExt = primitive.extensions['KHR_draco_mesh_compression']
            console.log(`🔥 Draco extension data:`, dracoExt)
          }
          
          try {
                         // Process Draco compression
             await this._processDracoPrimitive(primitive, gltf)
             if (this._debug) console.log(`✅ Successfully processed Draco primitive ${i}.${j}`)
             
             // Material processing will be done later in _processStandardPrimitives
             // after images are loaded
             
           } catch (error) {
             if (this._debug) console.error(`❌ Failed to process Draco primitive ${i}.${j}:`, error)
             return false
           }
        } else {
          if (this._debug) console.log(`📄 Normal primitive in mesh ${i}, primitive ${j}`)
        }
      }
    }
    
    return true
  }

  async _processAccessors(gltf) {
    if (this._debug) console.log(`[DEBUG] Processing ${gltf.accessors.length} accessors`)
    
    // Cache array length and frequently accessed properties
    const accessorCount = gltf.accessors.length
    const buffers = gltf.buffers
    const bufferViews = gltf.bufferViews
    
    for (let i = 0; i < accessorCount; i++) {
      let a = gltf.accessors[i]
      /*console.log(`[DEBUG] Processing accessor ${i}:`, {
        componentType: a.componentType,
        type: a.type,
        count: a.count,
        hasBufferView: a.hasOwnProperty('bufferView'),
        bufferView: a.bufferView,
        hasSparse: !!a.sparse,
        isDracoDecoded: !!a._dracoDecoded
      })*/
      
      let buftype = null
      switch (a.componentType) {
        case 5120:
          buftype = Int8Array
          break
        case 5121:
          buftype = Uint8Array
          break
        case 5122:
          buftype = Int16Array
          break
        case 5123:
          buftype = Uint16Array
          break
        case 5125:
          buftype = Uint32Array
          break
        case 5126:
          buftype = Float32Array
          break
        default:
          if (this._debug) console.error("error: gltf, unhandled componentType: " + a.componentType + " for accessor " + i);
          return false; // Stop execution if componentType is unhandled
      }
      let compcount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[a.type]
      
      // Handle sparse accessors
      if (a.sparse) {
        // Create base data array if no bufferView
        if (a.bufferView === undefined || a.bufferView === null) {
          // @ts-ignore
          a.data = new buftype(compcount * a.count);
          // Fill with zeros or default values if specified
          // if (a.normalized) { // Normalization is applied on read, not by zero-filling different types
          // a.data.fill(0);
          // }
        } else {
          // Load base data as normal
          let bufview = bufferViews[a.bufferView];
          if (!bufview) {
            if (this._debug) console.error("error: gltf, missing bufferView for base accessor data in sparse accessor");
            return false; // Critical error
          }
          const byteOffset = (bufview.byteOffset || 0) + (a.byteOffset || 0);
          const elementSize = buftype.BYTES_PER_ELEMENT;
          const length = compcount * a.count;
          // @ts-ignore
          a.data = new buftype(gltf.buffers[bufview.buffer], byteOffset, length);
        }

        // Process sparse values
        const sparse = a.sparse;
        const indicesBufferView = bufferViews[sparse.indices.bufferView];
        const valuesBufferView = bufferViews[sparse.values.bufferView];
        
        let indicesComponentType = sparse.indices.componentType;
        let indicesType = null;
        switch (indicesComponentType) {
          case 5121: indicesType = Uint8Array; break;
          case 5123: indicesType = Uint16Array; break;
          case 5125: indicesType = Uint32Array; break;
          default: if (this._debug) console.error("Unsupported sparse indices componentType: " + indicesComponentType + " for accessor " + i); return false;
        }

        if (!indicesType) {
            if (this._debug) console.error("Critical error: indicesType is null after switch, should not happen. Accessor " + i);
            return false; // Should be unreachable if switch default returns false
        }
        
        const indicesByteOffset = (indicesBufferView.byteOffset || 0) + (sparse.indices.byteOffset || 0);
        const indicesLength = sparse.count;
        const indices = new indicesType(
          buffers[indicesBufferView.buffer],
          indicesByteOffset,
          indicesLength
        );

        // Get values
        const valuesByteOffset = (valuesBufferView.byteOffset || 0) + (sparse.values.byteOffset || 0);
        const valuesLength = sparse.count * compcount;
        // @ts-ignore
        const values = new buftype(
          buffers[valuesBufferView.buffer],
          valuesByteOffset,
          valuesLength
        );

        // Apply sparse values
        for (let j = 0; j < sparse.count; j++) {
          const targetIndex = indices[j];
          for (let k = 0; k < compcount; k++) {
            a.data[targetIndex * compcount + k] = values[j * compcount + k];
          }
        }
        
        continue; // Skip normal accessor processing
      }

      // Skip buffer processing for Draco decoded accessors (they already have data)
      if (a._dracoDecoded) {
        if (this._debug) console.log(`✅ Skipping Draco decoded accessor ${i}`)
        continue;
      }

      // Check if bufferView exists
      if (a.bufferView === undefined || a.bufferView === null) {
        if (this._debug) console.log(`⚠️ Accessor ${i} has no bufferView, assuming it will be populated by Draco or is unused`)
        continue; // Skip rather than error - will be handled by Draco or is unused
      }

      let bufview = bufferViews[a.bufferView];
      if (!bufview) {
        if (this._debug) console.error(`[ERROR] BufferView ${a.bufferView} not found for accessor ${i}:`, a)
        alert("error: gltf, unhandled bufferView for non-sparse accessor. Accessor index: " + i)
        if (this._debug) console.error("error: gltf, unhandled bufferView for non-sparse accessor", a)
        return false; // Critical error
      }

      // Check for case where there is no byteOffset prop, which means byteOffset is 0.
      if (!("byteOffset" in bufview)) bufview.byteOffset = 0
      const accessorByteOffset = a.byteOffset || 0;

      if ("byteStride" in bufview) {
        const stride = bufview.byteStride
        const view = new DataView(buffers[bufview.buffer])
        // @ts-ignore
        a.data = new buftype(compcount * a.count)
        for (let j = 0; j < a.count; j++) {
          for (let k = 0; k < compcount; k++) {
            // Assuming componentType 5126 (Float32Array) for view.getFloat32
            // Need to handle other types if necessary, though typically vertex data is float.
            // The 'buftype' determines how a.data stores it, but reading from ArrayBuffer needs specific get methods.
            // For simplicity, assuming float for now. If other types are used for positions/normals/etc. this needs adjustment.
            if (buftype === Float32Array) {
              a.data[j * compcount + k] = view.getFloat32(bufview.byteOffset + stride * j + accessorByteOffset + k * Float32Array.BYTES_PER_ELEMENT, true);
            } else if (buftype === Uint16Array) {
               a.data[j * compcount + k] = view.getUint16(bufview.byteOffset + stride * j + accessorByteOffset + k * Uint16Array.BYTES_PER_ELEMENT, true);
            } else if (buftype === Uint8Array) {
               a.data[j * compcount + k] = view.getUint8(bufview.byteOffset + stride * j + accessorByteOffset + k * Uint8Array.BYTES_PER_ELEMENT);
            } else if (buftype === Uint32Array) {
              a.data[j * compcount + k] = view.getUint32(bufview.byteOffset + stride * j + accessorByteOffset + k * Uint32Array.BYTES_PER_ELEMENT, true);
            }
            // Add other types as necessary (Int8, Int16, Int32)
            else {
              if (this._debug) console.error("Unsupported buftype in strided accessor:", buftype);
              // Fallback or error
            }
          }
        }
      } else {
        const finalByteOffset = bufview.byteOffset + accessorByteOffset;
        const length = compcount * a.count;
        // @ts-ignore
        a.data = new buftype(buffers[bufview.buffer], finalByteOffset, length);
      }
    }
    
    return true
  }

  async _processStandardPrimitives(gltf) {
    if (this._debug) console.log(`[DEBUG] Processing all primitives (standard + Draco) for material setup`)
    
    const meshes = gltf.meshes
    const meshCount = meshes.length
    const accessors = gltf.accessors
    const materials = gltf.materials
    const textures = gltf.textures
    const images = gltf.images
    
    for (let i = 0; i < meshCount; i++) {
      const m = meshes[i]
      
      const primitiveCount = m.primitives.length
      for (let j = 0; j < primitiveCount; j++) {
        const p = m.primitives[j]
        
        const isDracoPrimitive = !!(p.extensions && p.extensions.KHR_draco_mesh_compression) || p._dracoProcessed
        
        if (isDracoPrimitive) {
          if (this._debug) {
            console.log(`🔥 Processing Draco primitive ${i}.${j} for materials`)
            console.log(`🔥 Draco primitive attributes:`, Object.keys(p.attributes))
            console.log(`🔥 Draco primitive indices:`, !!p.indices)
          }
          // Draco primitives already have their geometry decoded, just process materials
          // Their attributes are already accessor objects, not indices
        } else {
          if (this._debug) console.log(`📄 Processing standard primitive ${i}.${j}`)
          
          // Standard GLTF primitive processing
          if (p.indices !== undefined) {
            p.indices = accessors[p.indices]
          }
          
          const attributeKeys = Object.keys(p.attributes)
          for (let k = 0; k < attributeKeys.length; k++) {
            const key = attributeKeys[k]
            p.attributes[key] = accessors[p.attributes[key]]
          }

          // For ease of use point directly to the accessor data
          if ("targets" in p) {
            const targetCount = p.targets.length
            for (let k = 0; k < targetCount; k++) {
              const target = p.targets[k]
              const targetKeys = Object.keys(target)
              for (let l = 0; l < targetKeys.length; l++) {
                const key = targetKeys[l]
                target[key] = accessors[target[key]]
              }
            }
          }
        }
        
        // Material processing (common for both Draco and standard)
        if (typeof p.material != "undefined" && p.material != null) {
          p.material = materials[p.material]
          
          // Set material name to image name with safety checks
          if (p.material.pbrMetallicRoughness && p.material.pbrMetallicRoughness.baseColorTexture) {
            const textureIndex = p.material.pbrMetallicRoughness.baseColorTexture.index
            if (textures && textures[textureIndex]) {
              const imageIndex = textures[textureIndex].source
              if (images && images[imageIndex] && images[imageIndex].name) {
                p.material.name = images[imageIndex].name
                if (this._debug) console.log(`✅ Set material name: ${p.material.name} for primitive ${i}.${j}`)
              } else {
                if (this._debug) console.log(`⚠️ Image not found for material, using default name for primitive ${i}.${j}`)
                p.material.name = `material_${i}_${j}`
              }
            } else {
              if (this._debug) console.log(`⚠️ Texture not found for material, using default name for primitive ${i}.${j}`) 
              p.material.name = `material_${i}_${j}`
            }
          } else {
            if (this._debug) console.log(`⚠️ No baseColorTexture for material, using default name for primitive ${i}.${j}`)
            p.material.name = `material_${i}_${j}`
          }
        }
      }
    }
    
    return true
  }

  /*
    Creates a per-instance view of a loaded gltf: mutable scene-graph state (node transforms,
    matrices, morph weights, material assignments, joint bone matrices) is cloned, while all
    heavy immutable data (accessor typed arrays, animation keyframes, inverse bind matrices,
    images) is shared by reference with the source. Replaces structuredClone of the whole
    gltf, which duplicated the entire decoded model (and its underlying binary buffer) per
    instance.
  */
  static cloneInstanceView(sourceGltf) {
    const nodeMap = new Map()
    const meshMap = new Map()
    const materialMap = new Map()
    const skinMap = new Map()

    const cloneMaterial = (material) => {
      if (material == null || typeof material !== "object") return material
      if (materialMap.has(material)) return materialMap.get(material)
      const copy = { ...material }
      if (material.pbrMetallicRoughness) {
        copy.pbrMetallicRoughness = { ...material.pbrMetallicRoughness }
        const baseColor = material.pbrMetallicRoughness.baseColorFactor
        // render() mutates baseColorFactor[3]; keep it per instance
        if (Array.isArray(baseColor)) copy.pbrMetallicRoughness.baseColorFactor = baseColor.slice()
      }
      materialMap.set(material, copy)
      return copy
    }

    const cloneMesh = (mesh) => {
      if (mesh == null) return mesh
      if (meshMap.has(mesh)) return meshMap.get(mesh)
      const copy = {
        ...mesh,
        // attributes/indices/targets reference shared immutable accessors;
        // material is per instance (SetMeshMaterial replaces it)
        primitives: mesh.primitives.map((p) => {
          const pc = { ...p }
          if ("material" in p) pc.material = cloneMaterial(p.material)
          return pc
        }),
      }
      meshMap.set(mesh, copy)
      return copy
    }

    const cloneSkin = (skin) => {
      if (skin == null) return skin
      if (skinMap.has(skin)) return skinMap.get(skin)
      const copy = {
        ...skin,
        // joints rebound in the second pass (nodes may not all be cloned yet)
        joints: skin.joints.slice(),
      }
      skinMap.set(skin, copy)
      return copy
    }

    // Pass 1: clone every node's mutable state
    const sourceNodes = sourceGltf.nodes || []
    for (const node of sourceNodes) {
      const copy = { ...node }
      if (node.translation) copy.translation = Array.from(node.translation)
      if (node.rotation) copy.rotation = Array.from(node.rotation)
      if (node.scale) copy.scale = Array.from(node.scale)
      if (node.matrix) copy.matrix = Array.from(node.matrix)
      if (node.invMatrix) copy.invMatrix = Array.from(node.invMatrix)
      if (node.weights) copy.weights = new Float32Array(node.weights)
      if (node.boneMatrix) copy.boneMatrix = Array.from(node.boneMatrix)
      // invBindMatrix is immutable — shared by reference (kept via {...node})
      // boneBuffer/morphWeights are created lazily per instance; consumers use
      // hasOwnProperty checks, so the keys must not exist on the clone
      delete copy.boneBuffer
      delete copy.morphWeights
      nodeMap.set(node, copy)
    }

    // Pass 2: rebind graph references on the clones
    for (const node of sourceNodes) {
      const copy = nodeMap.get(node)
      if (node.children) copy.children = node.children.map((c) => nodeMap.get(c) || c)
      if (node.mesh) copy.mesh = cloneMesh(node.mesh)
      if (node.skin) copy.skin = cloneSkin(node.skin)
    }
    for (const skinCopy of skinMap.values()) {
      skinCopy.joints = skinCopy.joints.map((j) => nodeMap.get(j) || j)
    }

    const target = { ...sourceGltf }
    target.buffers = null
    target.imageBitmap = null
    target.nodes = sourceNodes.map((n) => nodeMap.get(n))
    target.skinnedNodes = (sourceGltf.skinnedNodes || []).map((n) => nodeMap.get(n) || n)
    if (sourceGltf.scene) {
      target.scene = { ...sourceGltf.scene, nodes: sourceGltf.scene.nodes.map((n) => nodeMap.get(n) || n) }
    }
    if (sourceGltf.scenes) {
      target.scenes = sourceGltf.scenes.map((s) => ({ ...s, nodes: s.nodes.map((n) => nodeMap.get(n) || n) }))
    }
    if (sourceGltf.meshes) target.meshes = sourceGltf.meshes.map((m) => cloneMesh(m))
    if (sourceGltf.materials) target.materials = sourceGltf.materials.map((m) => cloneMaterial(m))
    if (sourceGltf.skins) target.skins = sourceGltf.skins.map((s) => cloneSkin(s))
    if (sourceGltf.animations) {
      target.animations = sourceGltf.animations.map((a) => ({
        ...a,
        // samplers (and their keyframe accessors) are shared; targets rebound to cloned nodes
        channels: a.channels.map((c) => ({
          ...c,
          target: { ...c.target, node: nodeMap.get(c.target.node) || c.target.node },
        })),
      }))
    }
    return target
  }

  getOrCreateModelBoneUbo(renderer) {
    if (!this.bonesPerModelAsset) {
        return null;
    }

    const effectiveRenderer = renderer || this.rendererForUbo;

    if (!effectiveRenderer) {
        return null; 
    }
    
    const gl = effectiveRenderer._gl;
    if (!gl) {
        return null; 
    }

    if (!this.sharedModelBoneUbo) {
        const uboSize = SHADER_MAX_BONES * 16 * 4; // Use defined constant for UBO size

        this.sharedModelBoneUbo = gl.createBuffer();
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.sharedModelBoneUbo);
        gl.bufferData(gl.UNIFORM_BUFFER, uboSize, gl.DYNAMIC_DRAW); 
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);
        if (this._debug) console.log(`Created shared Bone UBO for model: ${this.gltf?.asset?.extras?.originalFileName || 'Unknown Model'}, Shader Max Bones: ${SHADER_MAX_BONES}, Size: ${uboSize} bytes, Actual Model Bones: ${this.bonesPerModelAsset}`);
    }
    return this.sharedModelBoneUbo;
  }
}

// @ts-ignore
if (!globalThis.GltfData) {
  // @ts-ignore
  globalThis.GltfData = GltfData
}
