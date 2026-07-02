# 007: `Is animation finished` condition always returns false (reads a nonexistent member)

**Severity:** high
**Fix recommendation:** Fix immediately — one-line fix restores a documented condition
**Area:** runtime / ACEs
**Files:** `src/c3runtime/conditions.js:16-18`

## Problem

```js
IsAnimationFinished() {
  return this.IsAnimationFinished
}
```

`this` is the SDK instance, which has no `IsAnimationFinished` property — the actual state flag is `this.animationFinished` (set in gltfModel.js and gltfModelW.js when a non-looping animation reaches its end). The condition returns `undefined` (falsy) forever; inverted, it is always true. The condition is exposed in aces.json (`is-animation-finished`), so this is a live, silently-broken ACE.

## Failure scenario

Any event sheet using "Is animation finished" — the event never fires (or always fires when inverted).

## Suggested fix

```js
IsAnimationFinished() {
  return this.animationFinished
}
```
