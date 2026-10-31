---
"@ai-hero/sandcastle": minor
---

Scaffold a GitHub Actions workflow with the `parallel-planner-with-review` template. `sandcastle init` now writes `.github/workflows/sandcastle.yml` (with the selected sandbox CLI, main filename, and agent secret wired in), and the template hands off to a fresh run before the Actions timeout via `SANDCASTLE_SELF_RESTART` / `SANDCASTLE_RUN_BUDGET_MINUTES`. The README documents the workflow, its secrets, and the commands for running the loop locally and in CI.
