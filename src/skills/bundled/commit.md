---
name: commit
description: Create a git commit with a well-crafted message
trigger: /commit
---

Create a git commit for the current changes. Follow these steps:

1. Run `git status` to see all changes
2. Run `git diff --cached` to see staged changes (if any)
3. If nothing is staged, stage relevant files with `git add`
4. Run `git log --oneline -5` to see recent commit style
5. Draft a concise commit message that:
   - Summarizes the "why" not the "what"
   - Follows the repository's existing commit style
   - Is 1-2 sentences maximum
6. Create the commit with `git commit -m "message"`
7. Show the result with `git log --oneline -1`
