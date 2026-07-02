# 025: Worker mode: `drawLightsEnable` set before any light update → render crash on null `drawLightsBufferViews`

**Severity:** medium
**Fix recommendation:** Fix immediately — one-line guard; easy-to-hit crash
**Resolution:** Resolved by deletion in v3.0.0 (trim stage 2): the lighting subsystem was removed.
**Area:** rendering / lighting (worker path)
**Files:** `src/c3runtime/gltfModelW.js` `onWorkerMessage` (~415-423) and `render` (~872-875)

## Problem

`onWorkerMessage` stores `drawLightsBufferViews` only `if (e.data.lightUpdate)`, but sets `this.drawLightsEnable = e.data.drawLightsEnable` unconditionally. `drawLightsBufferViews` is initialized to `null`. In `render`:

```js
if (this.drawLightsEnable) {
  drawLightsBufferView = this.drawLightsBufferViews[j]   // null[j] → TypeError
  lightIndex = drawLightsBufferView.start
}
```

`lightEnable` and `lightUpdate` are independent flags set by separate actions (`EnableLight`, `UpdateLight`), both defaulting false — enabling lighting without ever enabling light update reaches this state.

## Failure scenario

Worker-animation instance: call "Enable light" but never "Update light" → TypeError every rendered frame.

## Suggested fix

Guard the render branch with `this.drawLightsEnable && this.drawLightsBufferViews`, or don't set `drawLightsEnable` true until buffer views have actually arrived.
