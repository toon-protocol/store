// Single-PR review runner — the entry point the `agent:review` label→runner
// workflow (.github/workflows/agent-review.yml) invokes when `agent:review` is
// applied to ONE pull request.
//
// This is the single-pass replacement for the old 4-round `review-round:*`
// reviewer loop (store's pr-reviewer.yml). It runs the reviewer role
// (review-prompt.md — refactor for clarity while preserving behavior, enforce
// CODING_STANDARDS.md) against the PR's head branch, and pushes any refinement
// commits back to the PR. It NEVER merges the PR and NEVER closes anything — a
// human still merges.
//
// STANDALONE-REVIEW CAVEAT (verify on first run)
// ----------------------------------------------
// Sandcastle 0.12.0 exercises the reviewer only INSIDE the parallel loop's
// Phase 2, on a fresh `sandcastle/issue-*` branch it just created. Driving the
// same reviewer standalone against an already-existing PR head branch is our
// interpretation, not a documented engine feature. Two things to confirm on the
// first live run:
//   1. createSandbox({ branch: <existing PR head> }) checks out the EXISTING
//      branch (rather than failing because the ref already exists / creating a
//      divergent one). The workflow checks out the PR head first to help this.
//   2. The built-in {{TARGET_BRANCH}} inside review-prompt.md resolves to `main`
//      for a standalone sandbox. If the diff comes back empty, the base may be
//      resolving wrong — check the reviewer's logged `git diff` command.
//
// Required env:
//   SANDCASTLE_PR_NUMBER      the PR to review (github.event.pull_request.number)
//   CLAUDE_CODE_OAUTH_TOKEN   Claude Max-plan credential (org secret)
//   GH_TOKEN                  token with contents:write + pull-requests:write
//
// Usage:
//   SANDCASTLE_PR_NUMBER=42 npx tsx .sandcastle/agent-review-pr.ts
//   # or: pnpm sandcastle:review   (with SANDCASTLE_PR_NUMBER exported)

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { sandboxSecrets } from "./sandbox-secrets.ts";

const prNumber = process.env.SANDCASTLE_PR_NUMBER?.trim();
if (!prNumber || !/^\d+$/.test(prNumber)) {
  throw new Error(
    "SANDCASTLE_PR_NUMBER must be set to a numeric PR number " +
      `(got: ${JSON.stringify(process.env.SANDCASTLE_PR_NUMBER)}).`,
  );
}

// Resolve the PR's head branch on the host. `gh` authenticates via GH_TOKEN.
const headRef = execFileSync(
  "gh",
  ["pr", "view", prNumber, "--json", "headRefName", "--jq", ".headRefName"],
  { encoding: "utf8" },
).trim();

if (!headRef) {
  throw new Error(`Could not resolve head branch for PR #${prNumber}.`);
}

// store is a single-package pnpm repo — install with the committed lockfile
// (mirrors main.ts). We do NOT copyToWorktree node_modules (pnpm's symlinked
// store breaks across the host->worktree bind-mount).
const hooks = {
  sandbox: {
    onSandboxReady: [
      // Wire `git push` auth deterministically inside the container. The engine
      // (@ai-hero/sandcastle@0.12.0) configures git identity + safe.directory
      // but NO credential helper, so the review-push step's bare `git push` to
      // the PR branch is unauthenticated and only succeeds by luck. `gh auth
      // setup-git` installs `gh` as git's credential helper (reads GH_TOKEN at
      // push time, stores no token in any file). Guarded on GH_TOKEN so
      // token-less local dev no-ops rather than aborting setup. See
      // ./agent-implement-issue.ts for the full root-cause note.
      { command: 'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; fi' },
      { command: "pnpm install --frozen-lockfile" },
    ],
  },
};

console.log(
  `\n=== agent:review runner — PR #${prNumber} (head: ${headRef}) ===\n`,
);

// Set to a non-null message in the push-verification step below when the
// review-push phase reported success but the reviewer's commits never landed on
// the remote PR branch. Recorded here (not thrown inside the try) so the
// `finally` still closes the sandbox before we fail the job non-zero.
let reviewPushError: string | null = null;

const sandbox = await sandcastle.createSandbox({
  branch: headRef,
  // Forward CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN into the container (the engine's
  // env resolver does not — see ./sandbox-secrets.ts). GH_TOKEN is what the
  // review-push step's in-sandbox `git push` to the PR branch authenticates with.
  sandbox: docker({ env: sandboxSecrets() }),
  hooks,
});

try {
  const review = await sandbox.run({
    name: "reviewer",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-sonnet-5"),
    promptFile: "./.sandcastle/review-prompt.md",
    promptArgs: { BRANCH: headRef },
  });

  if (review.commits.length > 0) {
    // Push the reviewer's refinement commits back onto the PR branch. No merge,
    // no close, no new PR — the existing PR just gets updated.
    console.log(
      `\nReviewer made ${review.commits.length} commit(s) — pushing to the PR branch.`,
    );
    await sandbox.run({
      name: "push-review",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-sonnet-5"),
      promptFile: "./.sandcastle/review-push-prompt.md",
      promptArgs: { BRANCH: headRef },
    });

    // FAIL LOUD. The review-push phase emits COMPLETE from the prompt whether or
    // not the in-sandbox `git push` actually landed, so we must NOT trust it.
    // Verify from the HOST (whose `gh` is authenticated via GH_TOKEN) that every
    // reviewer commit is now reachable from the remote PR branch head. If any is
    // missing, the push failed silently — dump state and exit non-zero so the
    // Actions job FAILS instead of green-lying (the review-push analogue of the
    // open-pr store#50 silent-push failure).
    const nwo = execFileSync(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { encoding: "utf8" },
    ).trim();

    const missing: string[] = [];
    for (const { sha } of review.commits) {
      try {
        // compare base...head: `status` is "ahead"/"identical" when `sha` is an
        // ancestor of (or equal to) the remote branch head, i.e. it landed. A
        // 404 (commit not in repo) or "diverged"/"behind" means it did not.
        const status = execFileSync(
          "gh",
          [
            "api",
            `repos/${nwo}/compare/${sha}...${headRef}`,
            "--jq",
            ".status",
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
        if (status !== "ahead" && status !== "identical") missing.push(sha);
      } catch {
        // 404 / API error: the commit is not present on origin at all.
        missing.push(sha);
      }
    }

    if (missing.length === 0) {
      console.log(
        `\nVerified: all ${review.commits.length} reviewer commit(s) landed on origin/${headRef}.`,
      );
    } else {
      reviewPushError =
        `\nERROR: the review-push phase reported COMPLETE, but ${missing.length} ` +
        `of ${review.commits.length} reviewer commit(s) are NOT on ` +
        `origin/${headRef}:\n` +
        missing.map((s) => `  - ${s}`).join("\n") +
        `\n  The in-sandbox \`git push\` to the PR branch failed silently. ` +
        `Inspect the review-push phase logs above. The Actions job is failing ` +
        `deliberately so this is not mistaken for success.`;
    }
  } else {
    console.log(
      "\nReviewer made no changes — the code was already clean. Nothing to push.",
    );
  }
} finally {
  await sandbox.close();
}

// Fail loud AFTER the sandbox is closed: a silently-failed review push must turn
// the Actions job red, never green.
if (reviewPushError) {
  console.error(reviewPushError);
  process.exit(1);
}

console.log("\nReview complete. The PR was NOT merged — a human still merges.");
