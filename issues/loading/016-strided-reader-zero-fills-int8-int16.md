# 016: Strided (interleaved) accessor reader silently zero-fills Int8/Int16 data

**Severity:** high
**Fix recommendation:** Strongly recommended — small switch cases; silent zero-filled geometry otherwise
**Area:** loading / glTF conformance
**Files:** `src/c3runtime/gltfData.js` byteStride branch (~1155-1181), duplicated in `_processStandardPrimitivesOnly` (~1390-1406)

## Problem

The `byteStride` reading loop only handles `Float32Array`, `Uint16Array`, `Uint8Array`, `Uint32Array`. ComponentTypes 5120 (Int8) and 5122 (Int16) fall into an `else` that only logs when `this._debug` is set — and leaves `a.data` as the zero-filled array allocated at the top of the branch. Normalized Int8/Int16 are legal for NORMAL/TEXCOORD/COLOR/WEIGHTS (KHR_mesh_quantization; vanilla spec for colors/weights). The dead copy in `_processStandardPrimitivesOnly` doesn't even have the else.

## Failure scenario

An interleaved quantized model "loads successfully" with all-zero normals/UVs/colors — silent visual corruption with no error in non-debug builds.

## Suggested fix

Add `view.getInt8` / `view.getInt16` cases; make the unsupported-type fallthrough a hard `return false` (combined with issue 014 so the failure actually propagates). Note normalization scaling is separately unhandled (values are read raw), which is worth a follow-up if quantized models are to be supported properly.
