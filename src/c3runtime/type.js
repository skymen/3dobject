"use strict";
{
    const C3 = self.C3;

    C3.Plugins.Mikal_3DObject.Type = class Object3DType extends C3.SDKTypeBase
    {
        constructor(objectClass)
        {
            super(objectClass);
        }

        Release()
        {
            if (this.animWorkerHost) {
                this.animWorkerHost.release();
                this.animWorkerHost = null;
            }
            // Cache-shared textures are owned (and refcount-freed) by the cache entry
            const texturesShared = !!(this.gltfData && this.gltfData._cacheEntry);
            if (this.gltfData && typeof this.gltfData.release === "function") {
                this.gltfData.release();
                this.gltfData = null;
            }
            const renderer = this._runtime?.GetCanvasManager?.()?.GetRenderer?.();
            if (renderer && !texturesShared) {
                if (this.texture) {
                    for (const name in this.texture) {
                        renderer.DeleteTexture(this.texture[name]);
                    }
                }
                if (this.whiteTexture) {
                    renderer.DeleteTexture(this.whiteTexture);
                }
            }
            this.texture = null;
            this.whiteTexture = null;
            super.Release();
        }

        OnCreate()
        {
            this.GetImageInfo().LoadAsset(this._runtime);
            this.initOwner = -1;
            this.dataLoaded = false;
            this.gltfData = new globalThis.GltfData(this._runtime, this);
            this.dynamicTexturesLoaded = false;
            this.texture = {};
            this.animWorkerHost = null; // shared per-type animation worker (GPU skinning)
        }

        async LoadDynamicTextures(renderer, gltfData, textures, whiteTextureOwner)
        {
            // Cache-shared model: GPU textures are uploaded once into the cache entry
            // and shared by every object type using this model
            const cacheEntry = gltfData._cacheEntry;
            if (cacheEntry) {
                if (gltfData.dynamicTexturesLoaded === true || gltfData.dynamicTexturesLoaded === null) return;
                gltfData.dynamicTexturesLoaded = null;
                try {
                    if (!cacheEntry.texturesPromise) {
                        cacheEntry.renderer = renderer;
                        cacheEntry.texturesPromise = this._uploadCachedTextures(renderer, cacheEntry);
                    }
                    const shared = await cacheEntry.texturesPromise;
                    for (const name in shared.textures) {
                        textures[name] = shared.textures[name];
                    }
                    whiteTextureOwner.whiteTexture = shared.whiteTexture;
                    gltfData.dynamicTexturesLoaded = true;
                } catch (err) {
                    // Reset the in-progress sentinel so the next draw retries
                    console.error("[3DObject] texture upload failed", err);
                    gltfData.dynamicTexturesLoaded = false;
                    cacheEntry.texturesPromise = null;
                }
                return;
            }

            if (gltfData.dynamicTexturesLoaded === true || gltfData.dynamicTexturesLoaded === null) return;
            gltfData.dynamicTexturesLoaded = null;

            try {
            // White texture for solid color
            const width = gltfData.whiteImageBitmap.width;
            const height = gltfData.whiteImageBitmap.height;
            whiteTextureOwner.whiteTexture = renderer.CreateDynamicTexture(width, height);
            await renderer.UpdateTexture(gltfData.whiteImageBitmap, whiteTextureOwner.whiteTexture);
            if (typeof gltfData.whiteImageBitmap.close === "function") gltfData.whiteImageBitmap.close();

            if (!gltfData.imageBitmap || Object.keys(gltfData.imageBitmap).length === 0) {
                gltfData.dynamicTexturesLoaded = true;
                return;
            }

            for (const imageName in gltfData.imageBitmap) {
                const width = gltfData.imageBitmap[imageName].width;
                const height = gltfData.imageBitmap[imageName].height;
                const sampling = this._runtime.GetSampling();
                let options =  { sampling: sampling,
                    wrapX: gltfData.imageBitmap[imageName].wrapS,
                    wrapY: gltfData.imageBitmap[imageName].wrapT,
                };
    
                textures[imageName] = renderer.CreateDynamicTexture(width, height, options);
                await renderer.UpdateTexture(gltfData.imageBitmap[imageName], textures[imageName]);
                if (typeof gltfData.imageBitmap[imageName].close === "function") gltfData.imageBitmap[imageName].close();
            }

            gltfData.dynamicTexturesLoaded = true;
            } catch (err) {
                console.error("[3DObject] texture upload failed", err);
                gltfData.dynamicTexturesLoaded = false;
            }
        }

        async _uploadCachedTextures(renderer, entry)
        {
            const result = { textures: {}, whiteTexture: null };

            const whiteBitmap = entry.whiteImageBitmap;
            result.whiteTexture = renderer.CreateDynamicTexture(whiteBitmap.width, whiteBitmap.height);
            await renderer.UpdateTexture(whiteBitmap, result.whiteTexture);
            if (typeof whiteBitmap.close === "function") whiteBitmap.close();

            const bitmaps = entry.imageBitmap || {};
            const sampling = this._runtime.GetSampling();
            for (const imageName in bitmaps) {
                const bitmap = bitmaps[imageName];
                const options = { sampling: sampling, wrapX: bitmap.wrapS, wrapY: bitmap.wrapT };
                result.textures[imageName] = renderer.CreateDynamicTexture(bitmap.width, bitmap.height, options);
                await renderer.UpdateTexture(bitmap, result.textures[imageName]);
                if (typeof bitmap.close === "function") bitmap.close();
            }

            entry.textures = result.textures;
            entry.whiteTexture = result.whiteTexture;
            return result;
        }

        LoadTextures(renderer)
        {
            return this.GetImageInfo().LoadStaticTexture(renderer, {
                sampling: this._runtime.GetSampling()
            });
        }

        ReleaseTextures()
        {
            this.GetImageInfo().ReleaseTexture();
        }
    };
}