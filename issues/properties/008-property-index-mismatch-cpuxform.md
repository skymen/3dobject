# 008: Property index mismatch — `cpuXform` reads the obsolete z-elevation float; the "cpu-xform" property actually feeds `backFaceCull`

**Severity:** high
**Fix recommendation:** Strongly recommended — stop reading properties[1] as cpuXform now; the id/label cleanup needs project-compat care
**Area:** runtime / properties
**Files:** `src/c3runtime/instance.js:98` (`cpuXform = properties[1]`), `src/c3runtime/instance.js:113` (`backFaceCull = properties[16]`), `src/plugin.js:44-47` (z-elevation), `src/plugin.js:104-106` (cpu-xform), `src/lang/en-US.json` ("cpu-xform" → "Worker BFC")

## Problem

With the editor `link` property ("edit-image") stripped from the runtime property array, runtime indices are: 0 scale, **1 z-elevation (float, labeled "Obsolete, use zElevation")**, … 6 gtlf-path, 7 debug, … **16 cpu-xform (checkbox, labeled "Worker BFC")**, 17 use-bone-bounding-box, 18 gpu-skinning.

The runtime reads:

```js
this.cpuXform = properties[1]      // ← the obsolete z-elevation FLOAT
...
this.backFaceCull = properties[16] // ← the property whose id is "cpu-xform"
```

The original use of slot 1 (`wi.SetZElevation(properties[1])`) is commented out. So:

- **There is no property that can legitimately set `cpuXform`** — yet `cpuXform` selects a whole different bbox/render path (`if (this.inst.isEditor || this.inst.cpuXform)`).
- **Setting the obsolete "Z Elevation" property to any nonzero value silently enables cpuXform** (truthy float) *and* the elevation itself is never applied.
- The property *id* `cpu-xform` vs its *label* "Worker BFC" vs its runtime meaning `backFaceCull` is a three-way trap for any maintainer.

## Failure scenario

A legacy project with a nonzero obsolete z-elevation value: bounding boxes and rendering silently switch to the CPU-transform path, with the model's actual elevation dropped. Any maintainer reading the ids will wire the wrong fields together.

## Suggested fix

Stop reading `properties[1]` as `cpuXform` (default it to false, or add a real dedicated property in the next release). Keep `backFaceCull = properties[16]` but document the id↔label↔meaning mismatch on both sides (plugin.js and instance.js), since renaming the id would break existing projects.
