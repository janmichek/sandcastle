# TASK

Merge Sandcastle pull requests labelled `{{MERGE_READY_LABEL}}` into `{{BASE_BRANCH}}`.

Only merge PRs in the list below (they already carry that label). Do not merge anything still waiting for human review.

Ready-to-merge PRs:

{{PRS}}

# FOR EACH PR

1. Prefer a clean GitHub merge when the PR is mergeable:
   `gh pr merge <NUMBER> --merge --delete-branch`
2. If `gh pr merge` fails due to conflicts:
   - Check out `{{BASE_BRANCH}}` and update it from origin
   - `gh pr checkout <NUMBER>`
   - Merge `{{BASE_BRANCH}}` into the PR branch, resolve conflicts carefully
   - Run `npm run check` (or at least typecheck + tests) and fix failures
   - Push the PR branch, then `gh pr merge <NUMBER> --merge --delete-branch`
3. After a successful merge, close the linked issue if it is still open:
   `gh issue close <ID> --comment "Merged via {{MERGE_READY_LABEL}} PR by Sandcastle"`
   Issue ID is the number in the head branch `sandcastle/issue-<ID>`, or from `Fixes #<ID>` in the PR body.
4. Set board Status to **Done**:

```bash
item=$(gh project item-add 3 --owner janmichek --url https://github.com/janmichek/design-bot/issues/<ID> --format json --jq .id)
gh project item-edit --project-id PVT_kwHOAOpt584BneoC --id "$item" \
  --field-id PVTSSF_lAHOAOpt584BneoCzhmDD0I --single-select-option-id 98236657
```

# RULES

- Never merge a PR that is not in the list above.
- Never run `git reset --hard`, `git checkout -- .`, or anything else that discards commits or uncommitted work.
- Never leave a `git stash` unpopped.
- If a PR cannot be merged cleanly, leave it open, comment on the PR with what blocked you, and continue with the others.
- Do not open new PRs or start new issue work in this phase.

Once you've merged everything you can, output <promise>COMPLETE</promise>.
