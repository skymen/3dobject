# 050: Build script polish — `numfmt` missing on macOS; dangling `sourceMappingURL` comments in shipped files

**Severity:** low
**Fix recommendation:** Nice to have — cosmetic build noise; quick fixes
**Resolution:** Fixed in v3.0.0 (trim stage 5): awk-based human() replaces numfmt; --source-map dropped.
**Area:** build / release
**Files:** `release-minified.sh:46, 49-54, 63-64, 70, 85, 105`

## Problem

1. `$(numfmt --to=si $BEFORE)B` — `numfmt` is GNU coreutils and absent on stock macOS (the script otherwise accommodates macOS via `stat -f%z`), so every size line prints `numfmt: command not found` and an empty size, defeating the savings report.
2. Terser is invoked with `--source-map`; the resulting `//# sourceMappingURL=<file>.min.map` comment stays in the shipped file while the `.map` itself is deleted — every user who opens DevTools gets 404/missing-map warnings, and generating maps just to delete them slows the build.

## Failure scenario

Noisy builds on the primary dev platform; DevTools warnings for all addon users.

## Suggested fix

Replace `numfmt` with an awk helper or raw byte counts guarded by `command -v numfmt`; drop `--source-map` from the terser invocation (or strip the comment with `sed` after minifying).
