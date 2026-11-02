# 0061 — The Factory Resolves Merge Conflicts With Main

- **Status**: Accepted
- **Date**: 2026-10-29
- **Authors**: Jakub Anderwald, with Claude Code

## Context

On 2026-10-27 the owner dragged #688 to **Approved**, and its PR #755 couldn't merge: it conflicted with `main`. `--release` handled a conflict by posting one comment (`drafto-factory-merge-conflict`) and leaving the card in Approved. Nothing in the factory ever merged `main` into a PR branch, so the card stayed there until a human resolved it by hand:

- **The comment pointed nowhere.** It said to "comment a change request to have the factory revise it". No mode reads comments on an Approved card. The In Test sweep is the only one that turns a comment into a revision.
- **It held a worktree slot.** A card keeps its slot until it merges. With #688 in Approved and #748 in In Test, both slots were taken, and #718, approved in In Progress, couldn't start for two days.
- **It hid behind CI.** The conflict check came after the CI gate. GitHub runs no `pull_request` workflows on a conflicting head, so a conflicting PR whose required checks hadn't run would have waited at "not all green yet" forever, without ever reaching the conflict comment.
- **`--watch` didn't look.** It fetched `mergeable` but never read it, so stale green checks on a conflicting head moved the card on to In Test.

The conflict itself is common in this repo. #755 added `docs/adr/0059-desktop-pkce-native-csprng.md`. Meanwhile #757 merged `0059-keep-login-page-out-of-search-index.md` and #762 merged `0060-…`. Every PR that adds an ADR takes the next free number, so two that do so in parallel collide. When their index rows conflict, git reports `docs/adr/README.md`. When the rows merge cleanly, git reports nothing, and `docs/adr/` quietly holds two files with the same number.

## Decision

A conflict with `main` joins red CI and unresolved review threads as the third case that hands a card back to the fix loop ([ADR-0035](./0035-factory-code-review-gate.md), [ADR-0041](./0041-factory-ci-red-and-cancelled-checks.md)).

- **Approved (`--release`).** A `CONFLICTING` PR goes back to **In Review**. The check sits ahead of the CI gate. The comment is posted once per head SHA (`drafto-factory-conflict:<sha12>`), so a later conflict on a new head is announced too.
- **In Test (the feedback sweep).** A card whose PR starts conflicting goes back to In Review too, before any beta is dispatched for a head that has to change. If the reporter has feedback pending, the revision runs first, and the conflict is resolved once the card reaches In Review. That way no comment is dropped.
- **In Review (`--watch`).** A conflicting PR triggers a **conflict pass** through the existing fix loop, ahead of every CI wait:
  1. Bash resumes the worktree and runs `worktree-cli.mjs merge-main`, which fetches `origin/main` and merges it in. A failed fetch is transient: the tick is skipped without spending budget.
  2. A clean merge with no ADR clash is pushed by bash. No Claude run, no attempt spent.
  3. A merge that stops on conflicts, or a clean merge that leaves two ADRs with the same number, goes to the watch agent with the result in the bundle (`mergeConflict`). The pass carries no CI summary, review threads or PR comments, so the merge commit holds nothing but the merge. The agent resolves so both sides' changes survive. It never hand-edits `pnpm-lock.yaml`: it runs `pnpm install`, which resolves lockfile conflicts itself. (Bash skips its own install while a `package.json` is conflicted, since that would fail.) It renumbers the PR's own ADR to the next free number, touching only references the PR added, because main's ADR keeps the old number. It then commits the merge, but never pushes on a conflict pass.
  4. Bash doesn't trust `action=fixed`. `merge-check` judges the commit bash would push, never the working tree. The merge must be committed, with nothing tracked left uncommitted. `origin/main` must be in `HEAD`. No conflict marker may be left in the files git stopped on, and no two ADRs in `HEAD` may share a number that main doesn't already duplicate. Only a commit that passes is pushed, and bash pushes it. A resolution that fails never reaches the PR, so the rollback can undo all of it.
  5. Every other ending (failed check, `noop`, `blocked`, timeout, session limit) rolls the worktree back with `merge-abort --to <pre-merge head>`. That aborts an unfinished merge, resets away whatever `HEAD` carries that origin lacks (an unpushed merge, or an amend), and removes untracked files the pass left. A half-merged or diverged worktree would otherwise fail every later tick's resume, silently and without spending budget, and a stray file could block the next merge.
  6. Only a pass that fails spends an attempt, so a card that can't be resolved ends in Blocked after `FACTORY_MAX_ATTEMPTS` passes. A verified resolution spends none. Charging it would let one merge tip a card that had spent its budget on CI fixes into Blocked, under a comment blaming CI. Attempts reset at the In Test hand-off as before.
- **Merge, not rebase.** Merging never rewrites the PR's history, so nothing force-pushes, and a bad resolution can be undone with a revert commit. Bash starts every merge and the agent may only abort one. A run therefore never leaves a merge behind that nobody owns.
- **Re-approval.** The resolution changes the diff, so the card goes back through CI, the code-review stage and In Test, and the owner drags it to Approved again ([ADR-0026](./0026-dark-factory-pipeline.md)).

## Consequences

- **Positive**: a conflict no longer parks a card, or its worktree slot, until someone notices. The factory unblocks itself, and the owner's only step is the re-approval they already give for the other two hand-backs.
- **Positive**: an ADR-number clash is caught even when git merges it cleanly, and fixed without changing main's references to its own ADR.
- **Positive**: the misleading "comment a change request" advice is gone.
- **Negative**: a card that conflicts after approval needs testing and approving again. A docs-only resolution gets the same round trip as a code one.
- **Negative**: the merge-from-main commit makes the CodeRabbit CLI lane ([ADR-0036](./0036-factory-coderabbit-cli-gap-fill.md)) fall back to a full review against the merge base, which uses more of its hourly allowance.
- **Neutral**: a conflict where main rewrote the code the plan changes, or a lockfile `pnpm install` can't produce, still goes to a human: the agent aborts the merge and parks the card in Blocked with a comment.

## Alternatives Considered

- **Merge without re-approval when the resolution is trivial.** For example, when the PR's own changes are unchanged apart from renumbered ADRs or docs. This needs a diff-equivalence check, and it weakens the one gate that authorises merging to production. Rejected; the owner chose re-approval.
- **Rebase onto main instead of merging.** That needs a force-push to the PR branch, and the factory forbids force-pushes everywhere. It also rewrites the commits the code review and the owner already saw.
- **GitHub's "update branch" API.** `--release` already uses it for a PR that is only behind main. It can't resolve a conflict.
- **Leave conflicts in Approved, but fix the comment.** The slot stays held and a human still does the merge, which is exactly what stalled #718.
- **Catch conflicts only at Approved.** The owner chose to catch them in In Test too, so they don't test, and approve, a head that has to change anyway.
