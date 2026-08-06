# TASK

Review the code changes on branch `{{BRANCH}}` along two axes, then deliver a
structured verdict:

1. **Standards** — improve code clarity, consistency, and maintainability
   while preserving exact functionality.
2. **Spec** — does the change actually satisfy the issue it targets and its
   acceptance criteria?

# CONTEXT

## Target issue

Issue: #{{ISSUE_NUMBER}} — {{ISSUE_TITLE}}

If the issue number above is `none`, no target issue could be resolved for this
branch; skip the Spec axis and review the Standards axis only.

Otherwise, BEFORE reading the diff, run:

    gh issue view {{ISSUE_NUMBER}}

and read the issue body — especially its acceptance criteria. The Spec axis
reviews the diff AGAINST THOSE CRITERIA, not against the diff itself.

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the issue (above) and the diff and commits
   to understand the intent.

2. **Spec axis**: Check the diff against the target issue:
   - Does the change actually resolve what the issue asked for?
   - Is every acceptance criterion met by the diff (not merely claimed)?
   - Does anything in the diff contradict the issue?

3. **Analyze for improvements** (Standards axis): Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

4. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

5. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

6. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

7. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

# WHAT YOU FIX vs WHAT IS BLOCKING

Fix yourself (Standards axis): presentation-level issues — naming, structure,
readability, redundancy, unnecessary complexity, inconsistency with the
project's coding standards — always behavior-preserving.

BLOCKING (report in the verdict, do NOT rewrite): a defect that makes the
change wrong to merge —

- the diff fails or contradicts the target issue's acceptance criteria
- the diff introduces a functional defect or security issue, or breaks the gate
- the diff asserts something factually wrong (in code, tests, or docs) that
  you cannot verify a fix for

Never rewrite the substance of the change to force a pass. Substance defects
are the author's to fix; your channel for them is the verdict below.

# EXECUTION

If you find Standards improvements to make:

1. Make the changes directly on this branch
2. Run store's gate to ensure nothing is broken — `pnpm lint`, `pnpm run typecheck`, `vitest run`, and `pnpm run build`. Lint is `eslint .` against the frozen `eslint-suppressions.json` allowlist (ESLint native bulk-suppressions): any NEW violation fails; never add suppressions to get green, and if a fix makes a suppression unused, run `npx eslint . --prune-suppressions` and commit the shrunk file.
3. Commit describing the refinements

If the code is already clean and well-structured, make no commits.

# REQUIRED VERDICT (structured output)

You MUST end your final message with exactly one verdict block. The block is
machine-parsed; a missing or malformed block FAILS the run. Emit it even when
you made no changes.

Format — JSON only inside the tag, no comments, no trailing commas, no code
fences:

<review>
{"verdict":"clean","blockingFindings":[]}
</review>

Rules:

- `verdict` is `"clean"` or `"blocking"` — nothing else.
- `blockingFindings` MUST be empty for `clean` and non-empty for `blocking`.
- Each finding is
  `{"file":"<repo-relative path>","line":<1-based number or null>,"summary":"<one line>","why":"<why this blocks the merge>"}`
  — `line` is `null` for file-level findings.
- Standards fixes you already made are NOT findings; findings are only the
  blocking defects defined above.

Once complete, output the verdict block and then <promise>COMPLETE</promise>.

## Context budget

Operate as if your context is capped at **~200k tokens**, whatever your model's actual window
is (org policy: toon-meta's `CLAUDE.md` → *Context budget policy* — the cap is absolute, not a
percentage of the window). Treat ~200k as a hard ceiling, not a target.

Start preparing a handoff at roughly **120k** tokens of context, and hand off no later than
roughly **160k** — never run to the ceiling. Handing off means: write a structured handoff note
(what you reviewed, what you changed, what is left to check, and exact file/line pointers) to
`.sandcastle/logs/handoff-<task-id>.md`, **commit it on this branch** (use `git add -f` —
`.sandcastle/.gitignore` ignores `logs/`, and the sandbox is destroyed when the run ends, so an
uncommitted note is lost), and end your turn so a fresh agent continues.
