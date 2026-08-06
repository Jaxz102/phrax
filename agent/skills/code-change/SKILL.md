---
name: code-change
description: Implement a requested repository change and deliver it as a tested pull request
---

# Code change procedure

- Establish the repository and acceptance criteria before editing.
- Prepare the repository, then read its local instructions and inspect nearby
  implementation and tests.
- Prefer an existing project command over inventing a new build or test flow.
- Keep the diff scoped. Add or update tests when behavior changes.
- Inspect both `git diff` and `git status --short` before publishing.
- Report every verification command and its outcome in the PR body.
- Publishing is a separate, approval-gated step. Never merge.
