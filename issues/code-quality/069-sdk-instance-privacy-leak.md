# 069: Script interface publishes the internal SDK instance, defeating its own WeakMap encapsulation

**Severity:** low
**Fix recommendation:** Optional — an API decision more than a bug; at minimum fix the comment
**Area:** scripting API
**Files:** `src/c3runtime/instance.js` script-interface constructor (~825-834)

## Problem

The comment above the WeakMap says it exists "to safely hide the internal implementation details from the caller using the script interface" — and the constructor immediately does:

```js
map.set(this, self.IInstance._GetInitInst().GetSdkInstance())
this.sdk_instance = map.get(this)
```

publishing the SDK instance as a public own property of every `I3DObjectInstance`.

## Failure scenario

User scripts (including this project's own tests) couple to internals that can change any release; the encapsulation claim is false.

## Suggested fix

Either remove `sdk_instance` (breaking change for scripts that use it) or keep it but delete the misleading privacy comment and document it as an intentional escape hatch.
