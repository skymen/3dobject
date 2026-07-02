# 072: Property id typo `gtlf-path` (transposed "gltf") is baked into projects and already spawned a real bug

**Severity:** low
**Fix recommendation:** Optional — document only; the id is frozen by project compatibility
**Resolution:** Documented in v3.0.0 (trim stage 4): the frozen property ids are annotated in plugin.js and instance.js; the editor gtlfPath typo remains an open editor issue (see 046).
**Area:** properties / maintenance
**Files:** `src/plugin.js:71`, `src/lang/en-US.json`, editor `src/instance.js:128` (reader), `src/instance.js:185` (the `this.gtlfPath` bug, see issue 046)

## Problem

The property id is `"gtlf-path"` rather than `gltf-path`, mirrored in the lang file and every reader. It works because all readers share the typo — but it is permanently baked into existing project files (ids can't be renamed without breaking them), it confuses grep/maintenance, and it has already produced a genuine bug (`this.gtlfPath` vs `this.gltfPath` in the editor instance).

## Failure scenario

Ongoing maintenance hazard; see issue 046 for the concrete bug it caused.

## Suggested fix

Keep the id (compatibility), add a prominent comment at the property definition and both readers, and standardize the JS field name to one spelling (`gltfPath`) everywhere.
