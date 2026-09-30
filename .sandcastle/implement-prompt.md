/mattpocock-skills:implement {{ISSUE_URL}}

You are running AFK in a sandbox, on branch `{{BRANCH}}`, which is already checked out.
Nobody will answer a question, so do not ask one. Treat the issue, its comments and its
parent spec (if it has one) as settled. Read them with `gh issue view {{ISSUE_NUMBER}} --comments`.

Commit to `{{BRANCH}}`, and reference `#{{ISSUE_NUMBER}}` in each commit message. Do not
push, open a PR or close the issue. The runner does all three once you finish.

## This repository

- `CLAUDE.md` covers what this repo is and how to build it. It is a container, not an npm
  package: a `POST /store` backend behind the connector, built from `Dockerfile.store`. The
  connector does claim validation, so this app never does.
- `deploy/` is the store box itself, and `src/deploy-bundle-guard.test.ts` keeps it
  consistent. Change a pin in `deploy/` and the literal in that guard test together.
- Never commit key material or a rendered `deploy/` output. The `ARNS_DVM_SOLANA_SECRET_KEY`
  credential spends, so no ticket needs it in the sandbox.
- The package manager is pnpm 8.15.9, and `pnpm install --frozen-lockfile` has already run. The sandbox is the shared image, which also carries Rust, Foundry and the Solana CLI that this repo does not use.
  Add a dependency only if the ticket needs one, and commit the lockfile with it.
- After you finish, the runner runs CI's `build` job commands itself and won't open a PR
  while any is red: `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test`. Run them
  yourself before you commit. Never weaken, skip or delete a test, and never loosen a lint,
  to get green.
- A ticket that needs a live box, a funded key or a deploy is not one you can finish from
  here. Stop as described below.

## When you cannot finish

Stop only when a genuinely new decision is needed and no ADR covers it, the action is
irreversible, it touches mainnet or real funds, or it needs a credential that no workflow
exposes. In that case, commit nothing and explain what blocks you in a comment on the issue
(`gh issue comment {{ISSUE_NUMBER}}`). The runner moves an issue with no commits to
`needs-triage`.

If your context is getting full (around 150k tokens) before you are done, commit what works,
write the remaining steps to `.sandcastle/logs/handoff-{{ISSUE_NUMBER}}.md`, commit it with
`git add -f`, and end your turn. A fresh session continues from your commits.

When the ticket is done and committed, output <promise>COMPLETE</promise>.
