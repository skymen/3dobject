# 002: WebGPU — dedicated shader can never be created, Draw self-requeues forever with errors swallowed

**Severity:** critical
**Fix recommendation:** Strongly recommended — small change (detect + log + stop retrying); full WGSL support is a separate project
**Area:** runtime / rendering
**Files:** `src/c3runtime/plugin.js:195-215`, `src/c3runtime/instance.js:347-356`

## Problem

`get3DObjectShaderProgram` builds a GLSL ES 300 shader via `renderer.CreateShaderProgram(shaderData)`. On a WebGPU renderer this fails (WGSL expected), so `globalThis.cached3DObjectShader` stays null forever. `Draw()` then hits:

```js
if (!globalThis.cached3DObjectShader) {
  if (globalThis.get3DObjectShaderProgram && !globalThis.cached3DObjectShaderPromise) {
    try {
      globalThis.cached3DObjectShaderPromise = globalThis.get3DObjectShaderProgram(renderer)
    } catch (e) {}
  }
  this.runtime.UpdateRender()
  return
}
```

— an infinite invisible-object + forced-redraw loop. The shader creation failure is swallowed by the empty `catch (e) {}` here and by `catch (e) { // ignore }` in plugin.js, so there is zero diagnostic output.

## Failure scenario

WebGPU-enabled export/preview: 3D objects never render, `UpdateRender()` is requested every frame forever (battery/CPU drain), and nothing in the console explains why.

## Suggested fix

Detect `renderer.IsWebGPU()` once at startup, log a clear "renderer not supported" error, and stop scheduling redraws instead of retrying every frame. Log the caught shader-creation errors in both catch blocks. (Longer term: provide a WGSL variant of the shader.)
