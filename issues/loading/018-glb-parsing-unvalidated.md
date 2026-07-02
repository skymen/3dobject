# 018: GLB parsing — unvalidated header/chunks, single-buffer assumption, hardcoded base64 prefix length

**Severity:** high
**Fix recommendation:** Recommended — robustness hardening; do the cheap validations first, multi-buffer support as follow-up
**Area:** loading / glTF conformance
**Files:** `src/c3runtime/gltfData.js` GLB paths (~341-350, 362-376) and buffer conversion (~437-446)

## Problem

1. `magic` and `version` are read into variables and never checked (should be `0x46546C67` / `2`); the chunk type at bytes 16-20 is never verified to be JSON; `jsonBufSize` is not bounds-checked against `buffer.byteLength`. A truncated or non-GLB file produces garbled `TextDecoder` output and a cryptic `JSON.parse` error surfaced via `alert` (issue 004).
2. The runtime binary path never checks `fetch` `response.ok` — a 404 HTML page is parsed as GLB.
3. Every buffer is assigned the same BIN chunk: `gltf.buffers[i] = new Uint8Array(binBuffer).buffer` — a GLB whose `buffers[1+]` have external `uri`s is silently corrupted (all accessors of those buffers read the wrong bytes).
4. The embedded-glTF base64 path does `gltf.buffers[i].uri.slice(37)`, hardcoding the exact length of `"data:application/octet-stream;base64,"`. The equally spec-legal `data:application/gltf-buffer;base64,` prefix produces `atob` garbage or throws.

## Failure scenario

Truncated downloads, wrong-path 404s, multi-buffer GLBs, and gltf-buffer data URIs all fail with misleading errors or silent corruption.

## Suggested fix

Validate magic/version/chunk type/lengths with clear error messages; check `response.ok`; map only buffer 0 to the BIN chunk and fetch (or explicitly reject) `uri` buffers; parse data URIs with `uri.slice(uri.indexOf(",") + 1)` after checking for `;base64,`.
