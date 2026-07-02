# 049: Packaging — `zip -r` updates existing archives (stale entries), picks up `.DS_Store`, and never syncs the internal version

**Severity:** medium
**Fix recommendation:** Strongly recommended — small script fixes that prevent shipping stale/broken addon packages
**Resolution:** Fixed in v3.0.0 (trim stage 5): rm -f before zip, .DS_Store excluded, internal version verified against the requested one.
**Area:** build / release
**Files:** `release-minified.sh:92-93, 12-15`, `release.sh:1-3`

## Problem

1. **Stale entries:** `zip -r "../$OUTPUT_FILE" *` *updates* an existing archive. Rebuilding the same version after deleting or renaming a source file leaves the old file inside the .c3addon — C3 either rejects the addon (file-list mismatch) or ships stale code.
2. **Finder droppings:** `-r` recurses into subdirectories and happily includes `.DS_Store` files, which are not in addon.json's `file-list`.
3. **Version mismatch:** `$VERSION` is only used for the output *filename*; `addon.json`/`plugin.js` inside the package keep whatever version is in the tree. `./release-minified.sh 3.0.0` produces `3DObject-3.0.0.c3addon` that internally says `2.91.0` — C3 keys updates on the internal version.
4. **`release.sh`** has no shebang, no argument validation (produces `3DObject-.c3addon`), doesn't create `dist/` on a fresh clone, and shares the stale-zip problem.

## Failure scenario

An addon that installs fine on the dev machine but fails C3 validation or ships stale/renamed files to users; "new" releases that C3 refuses to treat as updates.

## Suggested fix

`rm -f "$OUTPUT_FILE"` before zipping; add `-x "*.DS_Store"`; `sed`-patch (or verify) the version in `addon.json`/`plugin.js` against `$1` and fail on mismatch; fix or delete `release.sh`.
