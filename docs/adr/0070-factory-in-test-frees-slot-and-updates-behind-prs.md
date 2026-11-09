# 0070 — In Test Frees Its Slot, and a Behind PR Is Updated Before In Test

- **Status**: Accepted
- **Date**: 2026-11-09
- **Authors**: Jakub Anderwald, Claude

## Context

The factory has two worktree slots (`SLOT_COUNT` in `scripts/lib/factory-state.mjs`, [ADR-0026](./0026-dark-factory-pipeline.md)). On 2026-11-09 it was ticking every five minutes but starting nothing. The two In Test cards, #794 and #328, held both slots while they waited on the operator, and all five In Progress cards logged `both worktree slots busy; deferring to a later tick` on every tick. [ADR-0061](./0061-factory-resolves-merge-conflicts.md) records the same stall on 2026-10-27, when #718 waited two days behind an Approved card and an In Test card.

Nothing in the In Test sweep uses the slot or `worktrees/factory-issue-<n>`:

- the pre-merge betas build in their own build roots (`scripts/lib/beta-build-root.sh`);
- the scenario writer runs read-only in the factory checkout;
- the browser run uses an empty temporary directory;
- the verification and CodeRabbit CLI lanes use their own detached worktrees.

The slot was held only because the `--watch` cleanup sweep kept every slot whose issue carried `status:in-test`. That let a revision resume in its warm worktree, at the cost of blocking all new work for as long as the operator took to test. The sweep read the `status:*` label, and only the factory's own moves write labels. A card the operator drags therefore keeps the label of the column it left. #759, approved by being dragged out of Plan Review, sat in In Progress that morning still labelled `status:plan-review`, so between two retries the sweep would have freed its slot and deleted its worktree.

The same day, #794's desktop pre-merge beta failed all three attempts with `The train version '0.4.4' is closed for new build submissions`. PR #802 had branched five minutes before #801 bumped desktop to 0.4.5 on `main`, and App Store Connect had closed the 0.4.4 train once 0.4.4 was approved. `--watch` never checked whether a PR was behind `main` before moving it to In Test. Only `--release` did, through GitHub's update-branch after the operator's approval. So the merge would have worked, but the build the operator was asked to test could never ship. Even when no build fails, an operator who approves a behind PR has tested code that differs from what merges.

## Decision

**1. A card waiting on the operator holds no slot, and the board decides who does.**

- **Which cards keep a slot.** The cleanup sweep keeps a slot only for an open issue whose card on the factory board is in In Progress, In Review or Testing. It reads the column from the issue view it already makes (`gh issue view --json state,projectItems`) and never reads the label. A column it can't read counts as unknown, never as "left", and then only a closed issue's slot is freed that tick. That covers a failed read, an issue with no card on the Drafto Factory board, and a renamed or swapped board.
- **In Test.** On the first `--watch` tick after a card reaches In Test, the sweep frees its slot and removes its worktree. The branch stays while the PR is open, as [ADR-0033](./0033-factory-branch-safety-and-implement-verification.md) requires. Approved cards are freed the same way. Testing keeps its slot because it is factory work in progress ([ADR-0053](./0053-pre-in-test-verification-stage.md)).
- **No-op and declined revisions.** One that goes straight back to In Test (`revision_return_to_test`) frees its slot at once, so the next card in the same `--implement` sweep can use it.

Work coming back from In Test competes for a slot, so:

- **Work in flight goes first.** `--implement` orders its column (`implement_queue_order`) in three groups, keeping board order within each:
  - cards that already hold a slot, which never need a free one and are the only ones that can free one mid-sweep;
  - cards with an open factory PR, meaning revisions and retries;
  - fresh cards.

  This keeps [ADR-0068](./0068-factory-runs-the-board-right-to-left.md)'s rule of finishing work before starting more. In Review hand-backs already get a freed slot first, because `--watch` runs before `--implement`.

- **Fresh worktree.** A revision recreates its worktree from the PR branch through `worktree-cli.mjs add --fetch`.

**2. A PR that is behind `main` is updated before In Test.** In the In Review loop, `--watch` reads `behind_by` from GitHub's compare API as the last check before either promotion. By then required CI is green, the code review has run, the CodeRabbit lane has decided and the hosted-config gate has passed. Checking earlier would spend updates while the card waits on a preview, the CodeRabbit hold or a hosted-config change, and the card could still reach In Test behind `main`. When `main` is ahead, `--watch` calls update-branch with `expected_head_sha` set to the head it read (`update_pr_branch`, which `--release` now uses too), and the card's tick ends.

- **Merge, not rebase.** The factory never force-pushes (ADR-0061), and the PR is squash-merged anyway.
- **The review carries over.** GitHub's update-branch makes only clean merges of `main`, so the PR's own change is the one already reviewed. The gate records the commit it updated (`branchUpdatedFrom`). `carry_across_branch_update` then moves `lastReviewSha` to the new head when all of these hold:
  - the new head is a two-parent merge whose first parent is that commit;
  - GitHub itself committed it (`web-flow`) as `Merge branch 'main' into …`;
  - that commit was the last one reviewed.

  When CodeRabbit had decided the old commit, it moves `crCoverageSha` too, and the lane promotes with the same decision. Without this, every move of `main` would buy a fresh, nondeterministic Claude review. Its nits would spend fix attempts on code that hadn't changed, and could push a finished card into Blocked. Any other new head is reviewed as usual: a push, or a conflict resolution, which the conflict pass or a person commits locally.

- **The slot stays.** The card keeps its slot and worktree through the update. CI on the merged head can still send it to the fix loop, and freeing the slot would hand it to fresh work in the same tick. A resume fast-forwards the worktree to the merge, setting any leftovers aside (decision 3).
- **Unpushed commits.** The gate never updates past local commits the PR lacks, such as a fix whose push never landed (`worktree_within_head`). It checks the worktree's HEAD or, with no worktree, the kept local branch that worktree-cli would re-attach. When the PR head isn't in the local object store, it asks GitHub's compare API rather than fetching. An update would diverge origin from those commits and wedge every later resume, so it logs a warning instead, and the card goes on as it stands.
- **Budget.** Every attempt counts toward `FACTORY_MAX_BRANCH_UPDATES` (default 3). It is stored per issue as `branchUpdates`. It resets when `--implement` moves the card to In Review and on both promotions to In Test. Once it is spent, the card goes on as it stands, and `--release` updates it at merge time. The budget fails closed: if it can't be read it counts as spent, and if the attempt can't be recorded the gate doesn't update. `--release` records the commit it updated too, so a hand-back from Approved also carries the review over.
- **Failure.** When update-branch fails because the head moved or mergeability is unknown, the card is rechecked next tick. Any other failure is logged and the card goes on, so a failing API can't hold it.
- **No comment.** Nothing is posted on the issue at this point. Nobody is waiting on an In Review card.

**3. An In Review card that waits doesn't keep a slot, and a worktree left behind doesn't wedge its card.**

- **Hosted-config hold.** When the hosted-config gate ([ADR-0065](./0065-factory-hosted-config-gate.md)) holds a converged In Review card because the operator must act (the check's exit 3, `HOSTED_CONFIG_HELD=hold`), the card frees its slot and worktree (`free_waiting_slot`). A tick held for a transient error keeps them. The hold waits on the operator to apply the config to dev and prod, possibly for days. Only the fix loop uses the worktree, and it acquires a slot and rebuilds the worktree from the branch when it needs one. The code review runs in the factory checkout and the CodeRabbit lane uses its own worktree. A worktree holding commits the PR lacks keeps its slot.
- **Uncommitted leftovers.** When a resumed worktree is strictly behind its PR branch and has uncommitted leftovers, `worktree-cli.mjs` sets them aside, then fast-forwards. That happens after anyone else pushes, for example "Update branch" on GitHub, an update by `--release` or a human. The leftovers come from an unfrozen install's lockfile rewrite, a fix pass cut off mid-edit, or a hand edit. Before, the resume threw. `--watch` then released the slot without spending an attempt, so the card retried every tick and never reached Blocked.
- **How they are kept.** `git add --all` and `git stash create` snapshot the leftovers, new files included and ignored ones such as `node_modules` left alone. The snapshot is stored under `refs/factory-leftovers/<branch>/<sha12>-<ms>`, the worktree is reset to its HEAD, and the bash log names the ref. `git stash apply <ref>` brings them back. If the fast-forward then fails, its error names the ref.
- **Removals snapshot too.** Every forced worktree removal (`worktree-cli.mjs remove --force`) takes the same snapshot first. This PR makes removals far more frequent: In Test, a hosted-config hold, a no-op revision. Without the snapshot, a hand edit in a waiting card's worktree would be lost on the next tick. If the snapshot fails, the worktree is left in place and the log says so.
- **Still a hand job.** A diverged worktree, or one with a merge in progress, still throws, because picking a side is a human's call.

## Consequences

- **Positive**: an In Test card no longer stops new work. The factory keeps both slots busy while the operator tests.
- **Positive**: the operator tests and approves the head that will merge, and pre-merge betas build from it. A version bump on `main` no longer breaks a store upload.
- **Positive**: a card the operator drags keeps or frees its slot by the column it is actually in. This includes a plan approved out of Plan Review, which used to be at risk of losing its worktree between retries.
- **Negative**: a revision no longer has a warm worktree. It seeds `node_modules` and runs `pnpm install` again, about one to two minutes. An install failure costs an attempt, as for any new worktree.
- **Negative**: a revision can wait for a slot while two other cards are being worked on. It goes ahead of fresh cards, but it doesn't pre-empt a running one.
- **Negative**: each update re-runs CI on the merged head, and, with the factory's verification switched on, the Testing column's lanes. `FACTORY_MAX_BRANCH_UPDATES` bounds it.
- **Positive**: a card held for days by the hosted-config gate no longer keeps a slot. A push from elsewhere no longer leaves a card looping silently in In Review over a dirty worktree.
- **Negative**: `refs/factory-leftovers/*` refs accumulate. Nothing prunes them, and each is a small snapshot commit. `git for-each-ref refs/factory-leftovers` lists them, and `git update-ref -d <ref>` drops one.
- **Neutral**: an In Review card held by the CodeRabbit lane keeps its slot. That hold is bounded at about an hour plus a run, and its findings go straight to the fix loop.
- **Neutral**: a card already in In Test isn't updated when `main` moves. That would change the commit under test, skip the In Review checks, and churn every waiting card on each merge. A revision that changes code goes back through In Review and is updated there. A no-op or declined revision returns to In Test on the head that was already shown, and `--release` updates the branch before it merges.

## Alternatives Considered

- **Raise the slot count.** It hides the problem until two more cards sit in In Test. The slots bound concurrent Claude runs and disk use, not waiting.
- **Free the slot at every In Test transition instead of in the sweep.** It saves one tick, but adds release calls and dry-run guards at three transition sites, and a card dragged into In Test by hand would still need the sweep. Only the revision return frees its slot itself, because the same `--implement` sweep may want it for the next card.
- **Keep reading labels, and re-assert a card's label when it takes a slot.** That covers the column the card is taken from, but not a card dragged into In Test from Testing or In Review, which keeps an active label and would hold its slot again. It also turns a failed board write into a lost slot.
- **Check for `main` earlier, before the code review.** Then the review would run on the merged head without a carry-over rule. But the card waits after that point, for the preview, the CodeRabbit hold and the hosted config. Each move of `main` during those waits would spend an update, and the card could still reach In Test behind `main`.
- **Re-review every merged head.** Rejected: see "The review carries over" above.
- **Read `mergeStateStatus`, as `--release` does.** GitHub computes it in the background. It reads `UNKNOWN` right after `main` moves, which is when `--release` has just merged something, seconds before `--watch` reads the PR. The compare API answers directly.
- **Merge `main` in the worktree, as the conflict pass does.** That needs a slot and a worktree resume, and the factory's own merge commit can't be told apart from a conflict resolution, so its review couldn't carry over. update-branch needs neither and can't conflict, because a conflicting PR goes to the conflict pass first.
- **Discard the leftovers with `git reset --hard`, or keep them with `git stash push`.** Discarding loses a hand edit if one is there. This repo keeps uncommitted work it can't account for ([ADR-0060](./0060-dedicated-factory-build-volume.md)). The stash stack is shared by every worktree of the repo, including the operator's own checkouts, so entries pushed there would turn up in their `git stash list`. A ref keeps the snapshot without either problem.
- **Update In Test cards when `main` moves.** Rejected, for the reasons under Neutral above. A follow-up could hand a card back to In Review when a beta lane gives up on a PR that is behind `main`.

## Related

- [ADR-0026](./0026-dark-factory-pipeline.md): the slot model.
- [ADR-0033](./0033-factory-branch-safety-and-implement-verification.md): the cleanup sweep keeps the branch.
- [ADR-0035](./0035-factory-code-review-gate.md): the code review runs once per head.
- [ADR-0058](./0058-revision-blocks-return-to-test.md): revisions from In Test.
- [ADR-0061](./0061-factory-resolves-merge-conflicts.md): merging `main` into a PR branch.
- [ADR-0068](./0068-factory-runs-the-board-right-to-left.md): finish work before starting more.
