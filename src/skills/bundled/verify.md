---
name: verify
description: Verify that recent changes work correctly
trigger: /verify
---

Verify the recent code changes are correct:

1. Run `git diff --cached` or `git diff` to see what changed
2. Read the changed files to understand the context
3. Look for related test files (search for `test`, `spec`, `__tests__`)
4. If tests exist, run them with the appropriate command
5. If no tests, verify manually:
   - Check type correctness (run `tsc --noEmit` or equivalent)
   - Check for import errors
   - Verify edge cases
6. Report: "Verification passed" or list specific failures
