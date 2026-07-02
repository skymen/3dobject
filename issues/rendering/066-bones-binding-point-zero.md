# 066: Bones UBO binding point is 0 while the comment claims "a high number to reduce conflicts"

**Severity:** low
**Fix recommendation:** Nice to have — change after 010/057 make the binding-point change safe
**Area:** rendering / skinning
**Files:** `src/c3runtime/plugin.js:16-18` (`globalThis.bonesBindingPoint = 0`), `src/c3runtime/boneBuffer.js:7` (`BONE_UBO_BINDING_POINT = 0`)

## Problem

```js
// Choose a binding point for the bones UBO. Using a high number to reduce
// potential conflicts with C3's internal bindings.
globalThis.bonesBindingPoint = 0
```

Binding index 0 is the *most* likely index for the engine's own uniform blocks, contradicting the comment. It also happens to be why the stale-block-index bug (issue 057) is currently harmless — a fragile coincidence.

## Failure scenario

If a future C3 version binds its own UBO at index 0, bone data and engine data stomp each other with confusing rendering corruption.

## Suggested fix

Pick a genuinely high index validated against `gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS)`, keep the two constants in one place (boneBuffer's static vs the plugin global are separate today), and fix issue 057 first so the change is safe.
