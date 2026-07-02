# 064: `scale` is a "text" property consumed as a number — `Scale` expression returns a string until `SetScale` runs

**Severity:** low
**Fix recommendation:** Nice to have — one-line coercion in the constructor
**Area:** properties / ACEs
**Files:** `src/plugin.js:43` (`new SDK.PluginProperty("text", "scale", "1")`), `src/c3runtime/instance.js:94`, `src/c3runtime/expressions.js` `Scale`

## Problem

`properties[0]` arrives as the string `"1"` (or whatever the user typed), so `this.scale` starts life as a string. Arithmetic like `scale / xScale` coerces, but `Exps.Scale()` is declared `returnType: "number"` in aces.json while returning a string until the `SetScale` action replaces it — which can trip C3's expression typing and makes string-concat event logic inconsistent. A non-numeric string typed into the property yields `NaN` scales with no validation.

## Failure scenario

Expression comparisons/typing oddities on `3DObject.Scale` before any `SetScale`; NaN geometry from a typo in the property.

## Suggested fix

Coerce in the constructor: `this.scale = parseFloat(properties[0]) || 1` (keeping the text property for project compatibility), or migrate the property to `float`.
