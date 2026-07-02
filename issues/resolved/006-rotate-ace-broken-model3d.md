# 006: `Rotate` action throws — references `this.model3D`, which is never assigned anywhere

**Severity:** high
**Fix recommendation:** Fix immediately — trivial (make the deprecated action a safe no-op); prevents crashes in legacy projects
**Resolution:** Resolved by deletion in v3.0.0 (trim stage 1): Rotate/SetRotationZXY removed.
**Area:** runtime / ACEs
**Files:** `src/c3runtime/actions.js:8` (`Rotate`), `src/c3runtime/actions.js:34` (`SetRotationZXY`)

## Problem

```js
Rotate(angle, axis) {
  if (!this.loaded) return
  this.model3D.rotate(angle, axis, false)
},
SetRotationZXY(x, y, z) {
  if (!this.loaded) return
  this.model3D.rotateZXY(x, y, z)
},
```

`this.model3D` appears nowhere else in the entire `src/` tree — it is never assigned. `Rotate` is declared in aces.json (`transform/rotate`, deprecated but still invocable from existing projects) → guaranteed `TypeError: Cannot read properties of undefined (reading 'rotate')` once `this.loaded` is true. `SetRotationZXY` is not declared in aces.json at all → pure dead code that would also crash if ever wired up.

## Failure scenario

Any legacy project that still uses the deprecated "Rotate" action crashes as soon as the model finishes loading.

## Suggested fix

Delete `SetRotationZXY`. Make `Rotate` a safe no-op (log a deprecation warning) or reimplement it against `this.xAngle/yAngle/zAngle`, since it is deprecated but reachable.
