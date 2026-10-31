# TASK

Implement issue {{TASK_ID}}: {{ISSUE_TITLE}}

Work on branch {{BRANCH}}. Only this issue.

# BOARD

Before any other work, put the issue on the project board and set Status to **In Progress**:

```bash
item=$(gh project item-add 3 --owner janmichek --url https://github.com/janmichek/design-bot/issues/{{TASK_ID}} --format json --jq .id)
gh project item-edit --project-id PVT_kwHOAOpt584BneoC --id "$item" \
  --field-id PVTSSF_lAHOAOpt584BneoCzhmDD0I --single-select-option-id 47fc9ee4
```

Leave Status at **In Progress** when you stop. The host sets **Ready 4 Review** when it opens the PR.

# SKILL

Call the Skill tool with `implement` and follow it for this issue.

AFK overrides (no human in the loop):

- Fetch the issue with `{{VIEW_TASK_COMMAND}}` (task `{{TASK_ID}}`, and any linked parent/spec it names). Do not ask clarifying questions — decide from the issue text.
- Choose test seams from the issue/spec yourself; do not wait for confirmation.
- After the work is committed, **stop**. Do **not** call `code-review` — the next Sandcastle agent owns that.

# CONTEXT

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# DONE

Ship a working slice that matches the assignment. The reviewer agent will validate, desloppify, security-audit, and raise coverage — do not pre-empt that loop.

If the issue is only partly done, leave a `gh` comment with what landed. Do not close the issue.

Once complete, output <promise>COMPLETE</promise>.
