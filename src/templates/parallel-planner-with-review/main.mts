// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch. All issue pipelines run concurrently
//                               via Promise.allSettled().
//   Phase 3 (Open PRs):         Host-side. Each completed issue branch is
//                               pushed and a pull request against
//                               PUBLISH.baseBranch is opened (or reused).
//                               Board Status moves to Ready 4 Review.
//                               A human reviews the PR and labels it
//                               ready-for-agent when it is safe to merge.
//   Phase 4 (Merge labelled):   An agent merges only PRs whose head is a
//                               sandcastle/issue-* branch and that carry the
//                               ready-for-agent label, then closes issues.
//
// Phase 4 also runs at the start of each iteration so labelled PRs from a
// prior cycle (or while you were AFK) get merged before new work is planned.
//
// The outer loop runs indefinitely. When idle (nothing to merge, nothing to
// plan), it polls every IDLE_POLL_MS with cheap gh checks for new triggers
// (ready-for-agent PRs or Todo Sandcastle issues) before waking agents again.
// GitHub Actions jobs are hard-capped, so in CI (SANDCASTLE_SELF_RESTART=1)
// the loop hands off to a fresh workflow run shortly before its budget runs
// out instead of being killed mid-phase.
//
// Usage:
//   npx tsx .sandcastle/main.ts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.ts" }

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

type PlannedIssue = z.infer<typeof planSchema>["issues"][number];

type ReadyToMergePr = {
  number: number;
  title: string;
  headRefName: string;
  url: string;
};

const MERGE_READY_LABEL = "ready-for-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// How long to wait between scans when there is nothing to merge or plan.
const IDLE_POLL_MS = 60_000;

// GitHub Actions cancels jobs at their hard timeout and loses any unpushed
// sandbox work. In CI we poll as usual, but hand off to a fresh run before
// that happens. Locally the budget is ignored and the loop polls forever.
const SELF_RESTART = process.env.SANDCASTLE_SELF_RESTART === "1";
// Hand off after this much wall-clock. The job timeout is 340 minutes, so
// 285 leaves ~55 minutes for the final phase to wrap up.
const RUN_BUDGET_MS =
  Number(process.env.SANDCASTLE_RUN_BUDGET_MINUTES ?? "285") * 60_000;
// Do not start issue pipelines this close to the budget; the next run picks
// the planned issues up instead of losing a sandbox to the hard timeout.
const MIN_EXECUTION_BUDGET_MS = 60 * 60_000;

const startedAt = Date.now();

function elapsedMs(): number {
  return Date.now() - startedAt;
}

function remainingBudgetMs(): number {
  return RUN_BUDGET_MS - elapsedMs();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// Publishing runs on the host, with the host's git and gh credentials.
const PUBLISH = {
  // Push each sandcastle/issue-* branch as soon as its pipeline produces commits.
  issueBranches: true,
  // The pull request target for each issue branch.
  baseBranch: "main",
};

// ---------------------------------------------------------------------------
// Publishers / PR helpers
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function warn(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`  ✗ ${context}: ${message}`);
}

// Queue a fresh workflow run before this one exits. The job-level
// `concurrency: sandcastle` group makes it start only once this run is gone,
// so the two never overlap. GITHUB_TOKEN carries the workflow's `actions:
// write` permission; the PAT in GH_TOKEN may not, so prefer it when present.
function dispatchNextRun(): void {
  try {
    const env = { ...process.env };
    if (env.GITHUB_TOKEN) env.GH_TOKEN = env.GITHUB_TOKEN;
    execFileSync("gh", ["workflow", "run", "sandcastle.yml"], {
      env,
      stdio: "inherit",
    });
    console.log("  → queued the next Sandcastle run");
  } catch (error) {
    warn("Could not queue the next Sandcastle run", error);
  }
}

function handOffAndExit(): void {
  console.log("Run budget reached; handing off before the Actions timeout.");
  dispatchNextRun();
}

function publishBranch(branch: string): void {
  try {
    execFileSync("git", ["push", "--set-upstream", "origin", branch], {
      stdio: "inherit",
    });
    console.log(`  ↑ pushed ${branch}`);
  } catch (error) {
    warn(`Could not push ${branch}`, error);
  }
}

const PROJECT_ID = "PVT_kwHOAOpt584BneoC";
const STATUS_FIELD_ID = "PVTSSF_lAHOAOpt584BneoCzhmDD0I";
const READY_4_REVIEW_OPTION_ID = "52ec52fb";

function setIssueReady4Review(issueId: string): void {
  try {
    const item = execFileSync(
      "gh",
      [
        "project",
        "item-add",
        "3",
        "--owner",
        "janmichek",
        "--url",
        `https://github.com/janmichek/design-bot/issues/${issueId}`,
        "--format",
        "json",
        "--jq",
        ".id",
      ],
      { encoding: "utf8" },
    ).trim();
    execFileSync(
      "gh",
      [
        "project",
        "item-edit",
        "--project-id",
        PROJECT_ID,
        "--id",
        item,
        "--field-id",
        STATUS_FIELD_ID,
        "--single-select-option-id",
        READY_4_REVIEW_OPTION_ID,
      ],
      { stdio: "inherit" },
    );
    console.log(`  → #${issueId} board Status → Ready 4 Review`);
  } catch (error) {
    warn(`Could not set Ready 4 Review for #${issueId}`, error);
  }
}

function openIssuePr(issue: PlannedIssue): void {
  const { branch, id, title } = issue;
  try {
    const existing = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        ".[0].url",
      ],
      { encoding: "utf8" },
    ).trim();
    if (existing !== "" && existing !== "null") {
      console.log(`  PR already open for ${branch}: ${existing}`);
      setIssueReady4Review(id);
      return;
    }
    execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--base",
        PUBLISH.baseBranch,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        `Fixes #${id}\n\nOpened by Sandcastle after implement + agent review. When you are happy, label this PR \`${MERGE_READY_LABEL}\`; the next Sandcastle cycle will merge it.`,
      ],
      { stdio: "inherit" },
    );
    console.log(`  ✓ opened PR for ${branch} (Fixes #${id})`);
    setIssueReady4Review(id);
  } catch (error) {
    warn(`Could not open a pull request for ${branch}`, error);
  }
}

function listReadyToMergeSandcastlePrs(): ReadyToMergePr[] {
  try {
    const raw = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--base",
        PUBLISH.baseBranch,
        "--label",
        MERGE_READY_LABEL,
        "--json",
        "number,title,headRefName,url",
      ],
      { encoding: "utf8" },
    );
    const prs = JSON.parse(raw) as ReadyToMergePr[];
    return prs.filter((pr) => pr.headRefName.startsWith("sandcastle/issue-"));
  } catch (error) {
    warn(`Could not list ${MERGE_READY_LABEL} PRs`, error);
    return [];
  }
}

/** Cheap host-side check: any Sandcastle PRs labelled ready-for-agent? */
function hasMergeTriggers(): boolean {
  return listReadyToMergeSandcastlePrs().length > 0;
}

/**
 * Cheap host-side check: any open Sandcastle issues in Todo (or missing from
 * the board)? Matches the planner's "ready for planning" rule without an agent.
 * Fail open on errors so a flaky gh call wakes the planner instead of missing work.
 */
function hasPlanTriggers(): boolean {
  try {
    const issuesRaw = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "Sandcastle",
        "--limit",
        "100",
        "--json",
        "number",
      ],
      { encoding: "utf8" },
    );
    const issues = JSON.parse(issuesRaw) as { number: number }[];
    if (issues.length === 0) return false;

    const boardRaw = execFileSync(
      "gh",
      [
        "project",
        "item-list",
        "3",
        "--owner",
        "janmichek",
        "--format",
        "json",
        "--limit",
        "200",
        "--jq",
        "[.items[] | {number: .content.number, status}]",
      ],
      { encoding: "utf8" },
    );
    const board = JSON.parse(boardRaw) as {
      number: number | null;
      status: string | null;
    }[];
    const statusByNumber = new Map<number, string | null>();
    for (const item of board) {
      if (item.number != null) statusByNumber.set(item.number, item.status);
    }

    return issues.some((issue) => {
      const status = statusByNumber.get(issue.number);
      return status == null || status === "Todo";
    });
  } catch (error) {
    warn("Could not scan for plan triggers", error);
    return true;
  }
}

async function waitForTriggers(): Promise<void> {
  for (;;) {
    if (SELF_RESTART && remainingBudgetMs() <= 0) {
      console.log("Run budget exhausted while idle.");
      return;
    }
    console.log(
      `Idle: scanning for triggers again in ${IDLE_POLL_MS / 1000}s...`,
    );
    await sleep(IDLE_POLL_MS);
    console.log("Scanning for merge / plan triggers...");
    if (hasMergeTriggers() || hasPlanTriggers()) {
      console.log("Trigger found; resuming.");
      return;
    }
    console.log("No triggers yet.");
  }
}

async function mergeReadyPrs(): Promise<number> {
  const ready = listReadyToMergeSandcastlePrs();
  if (ready.length === 0) {
    console.log(`No Sandcastle PRs labelled ${MERGE_READY_LABEL} to merge.`);
    return 0;
  }

  console.log(`Merging ${ready.length} ${MERGE_READY_LABEL} PR(s):`);
  for (const pr of ready) {
    console.log(`  #${pr.number}: ${pr.title} (${pr.headRefName}) → ${pr.url}`);
  }

  await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      BASE_BRANCH: PUBLISH.baseBranch,
      MERGE_READY_LABEL,
      PRS: ready
        .map(
          (pr) =>
            `- PR #${pr.number}: ${pr.title} (head \`${pr.headRefName}\`) — ${pr.url}`,
        )
        .join("\n"),
    },
  });

  return ready.length;
}

// The merger works on the same working tree this script runs on, and may reset
// the tree while resolving conflicts. A dirty tree would lose work silently.
function assertCleanTree(): void {
  if (process.env.SANDCASTLE_ALLOW_DIRTY === "1") return;
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty !== "") {
    throw new Error(
      "Working tree has uncommitted tracked changes. Commit or stash them (or set SANDCASTLE_ALLOW_DIRTY=1 to override); the merger may reset the tree.",
    );
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

assertCleanTree();

for (let iteration = 1; ; iteration++) {
  console.log(`\n=== Iteration ${iteration} ===\n`);

  // Checked between phases, when no sandbox is open, so a handoff never
  // kills an implementer or reviewer mid-run.
  if (SELF_RESTART && remainingBudgetMs() <= 0) {
    handOffAndExit();
    break;
  }

  // -------------------------------------------------------------------------
  // Phase 4 (also at loop start): Merge PRs labelled ready-for-agent
  // -------------------------------------------------------------------------
  console.log(`Checking for Sandcastle PRs labelled ${MERGE_READY_LABEL}...`);
  const mergedCount = await mergeReadyPrs();

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent reads the open issue list, builds a dependency graph,
  // and selects the issues that can be worked in parallel right now.
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/plan-prompt.md",
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    if (mergedCount > 0) {
      // Merges may have unblocked work — plan again next iteration.
      console.log(
        "No unblocked issues this pass; merges landed. Continuing...",
      );
      continue;
    }
    console.log(`No unblocked issues and no ${MERGE_READY_LABEL} PRs.`);
    await waitForTriggers();
    continue;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  if (SELF_RESTART && remainingBudgetMs() < MIN_EXECUTION_BUDGET_MS) {
    console.log(
      "Not enough budget to finish an implement + review pass; deferring to the next run.",
    );
    handOffAndExit();
    break;
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; if it produces commits, the reviewer runs in the same sandbox.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: docker(),
        hooks,
        copyToWorktree,
      });

      try {
        // Run the implementer
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: sandcastle.claudeCode("claude-opus-4-8"),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        // Only review if the implementer produced commits
        if (implement.commits.length > 0) {
          // Many iterations: Validate → code-review → security loop, then
          // coverage (+ optional UI demo/polish when the branch has a UI).
          const review = await sandbox.run({
            name: "reviewer",
            maxIterations: 50,
            agent: sandcastle.claudeCode("claude-opus-4-8"),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              TASK_ID: issue.id,
              BRANCH: issue.branch,
            },
          });

          // Combine commits from both runs for the publish gate.
          // Each sandbox.run() only returns commits from its own run.
          return {
            ...review,
            commits: [...implement.commits, ...review.commits],
          };
        }

        return implement;
      } finally {
        await sandbox.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only open PRs for branches that actually produced commits.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  console.log(
    `\nExecution complete. ${completedIssues.length} branch(es) with commits:`,
  );
  for (const issue of completedIssues) {
    console.log(`  ${issue.branch}`);
  }

  if (completedIssues.length === 0) {
    console.log("No commits produced. Nothing to open as a PR.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Push + open PRs (human reviews; do not merge here)
  // -------------------------------------------------------------------------
  console.log("\nPublishing issue branches and opening PRs...");
  for (const issue of completedIssues) {
    if (PUBLISH.issueBranches) publishBranch(issue.branch);
    openIssuePr(issue);
  }
}
