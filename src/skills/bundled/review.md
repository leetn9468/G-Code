---
name: review
description: Review code changes for bugs, security issues, and quality
trigger: /review
---

Review the current code changes. Follow these steps:

1. Run `git diff` to see all uncommitted changes
2. For each changed file, analyze:
   - **Bugs**: Logic errors, off-by-one, null/undefined risks
   - **Security**: Input validation, injection risks, credential exposure
   - **Quality**: Naming, complexity, duplication, missing error handling
   - **Performance**: N+1 queries, unnecessary allocations, blocking I/O
3. Rate severity: Critical / Warning / Info
4. Suggest specific fixes with code snippets
5. Summarize: "X issues found (Y critical, Z warnings)"
