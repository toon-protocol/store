# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

store is a single-package pnpm repo. Before committing, run store's real gate and make sure every command passes:

- typecheck: `pnpm run typecheck`
- test: `vitest run`
- build: `pnpm run build`

There is NO lint step in store — do not run `eslint` (the repo has no eslint config). typecheck, test, and build are the whole gate.

Do not commit until typecheck, test, and build all pass.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.

## Context budget

If you approach ~60% of your context window, STOP: write a structured handoff note (current state + remaining steps) to `.sandcastle/logs/handoff-<task-id>.md` and end your turn so a fresh agent continues. Do not push past ~60% — small, resumable units beat one degraded run.
