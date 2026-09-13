# 0033 — Factory Branch Safety and Implement Verification

- **Status**: Accepted
- **Date**: 2026-09-08
- **Authors**: Jakub Anderwald

## Context

Issue #463 sat in the factory for eight weeks without shipping. Diagnosing it uncovered a
three-link causal chain in which the factory could silently discard a reporter's change
request while reporting success.

**Link 1 — the branch is deleted while the PR is open.** The `--watch` cleanup sweep
(`factory-agent.sh`, "Cleanup sweep") releases the slot and removes the worktree for any
issue that is closed or has lost all of `status:in-progress` / `status:in-review` /
`status:in-test`. It passed `--delete-branch` unconditionally. `transition_status` is the
only writer of those labels, so the sweep does not fire on a human board drag — but it does
fire on every factory-driven transition to Blocked that leaves a slot held. Four such paths
existed: implement retry-exhausted, watch retry-exhausted, the disk guard, and the no-plan
guard. None released their slot, so the next tick's sweep deleted the local branch with the
PR still OPEN.

**Link 2 — `addWorktree` cannot see the remote.** `branchExists` consulted only
`refs/heads/factory/issue-<n>`. With the local branch gone it fell through to
`git worktree add -b <branch> <path> origin/main`, producing a worktree containing none of
the PR's commits. Nothing in `--implement` or `--watch` fetches, so even the remote-tracking
refs were stale, and `git branch -D` leaves `refs/remotes/origin/<branch>` behind while
`--release` deletes the remote branch server-side without pruning — so ref presence alone was
never trustworthy.

**Link 3 — the agent reports success anyway.** From a worktree that does not descend from the
PR head, `git push` is a guaranteed non-fast-forward rejection. `factory-prompt.md` then
_instructed_ the agent, on a `gh pr create` failure, to "force-update it via a new commit +
push (no `--force`), and emit `action=implemented` with the existing PR URL". Bash accepted
the claim: it advanced the card to In Review and wrote `lastFeedbackAt=now`, which marks every
comment up to that point consumed. The reporter's change request could then never be replayed,
`--watch` re-presented an unchanged preview, and the log read "revision pushed". No
human-visible error appeared anywhere.

## Decision

Fix all three links.

1. **Remote-aware branch resolution.** `addWorktree` gains a `--fetch` flag, used by both
   `--implement` and `--watch`. Resolution is now four-tier: registered worktree → local
   branch → `origin/<branch>` → `<base>`. The liveness probe is
   `git ls-remote --exit-code --heads origin`, which asks the remote directly rather than
   trusting a local remote-tracking ref. An unreachable remote is **fatal** — the caller
   already handles an `add` failure by releasing the slot without bumping the retry budget,
   so failing closed costs one tick, while branching from the wrong base costs the PR.
   When origin has no such branch, the stale remote-tracking ref is deleted and `<base>` is
   refreshed (closing the "`origin/main` is never fetched" staleness gap).

   Because decision 2 now deliberately _keeps_ local branches, the local-branch tier is the
   common path, so it is reconciled against origin rather than trusted blindly: strictly
   behind → take origin's tip (anything else would re-attach a stale head and get the next
   push rejected, which under the new prompt rule hard-stops the card); strictly ahead →
   keep it (unpushed commits from a crashed run); diverged → refuse rather than guess.
   Every network call carries a timeout (`FACTORY_GIT_NETWORK_TIMEOUT_MS`, default 60 s)
   and runs with `GIT_TERMINAL_PROMPT=0`: `addWorktree` never touched the network before,
   and a hang would have been worse than a failure, because `factory-agent-loop.sh` reaps
   its mutex only when the owning PID is dead — one hung tick would stop the pipeline
   silently. A timeout is classified as "unreachable", which already fails closed.

2. **PR-gated branch deletion.** New `branch_keep_reason` / `remove_worktree_for` helpers in
   `factory-agent.sh` delete the local branch only when no live PR points at it. MERGED or
   no-PR is safe; OPEN and CLOSED both keep it (a closed factory PR is reopen-by-push); any
   lookup failure or unrecognised state keeps it. `--delete-branch` now appears exactly once
   in the script. The four Blocked paths that kept their slot now release it, removing the
   trigger as well as the damage. `removeWorktree` reports the pre-deletion tip as
   `branchHead`, so a mistaken teardown is recoverable from the log.

3. **Verify the claim, don't trust it.** `--implement` records the PR head OID from GitHub
   before invoking Claude and re-reads it when the agent claims `action=implemented`. A
   separate `PRE_HEAD_KNOWN` flag distinguishes "nothing to verify" (a fresh
   implementation, where the new PR is itself proof of a push) from "could not find out"
   (a revision run whose pre-run lookup failed); collapsing both into an empty OID would
   have skipped the guard entirely on exactly the runs it exists to police. An
   unchanged head — or an unreadable one, at either end — is treated as a failed attempt: bump attempts,
   keep the slot and worktree, do **not** advance the card, and above all do **not** write
   `lastFeedbackAt`, so the feedback survives for the next attempt. After
   `FACTORY_MAX_ATTEMPTS` the existing retry-exhausted path parks the card in Blocked for a
   human. The adjacent `action=noop` hole is closed with a local check: a genuine no-op
   commits nothing, so the worktree HEAD must still be an ancestor of the PR head — an
   ancestor test rather than an equality test, so a worktree merely _behind_ the PR head
   (someone else pushed) is not mistaken for unlanded work. The prompt is corrected to
   require a verified push and to emit `action=blocked` on a rejection.

## Consequences

- **Positive**: A revision run can no longer be built on the wrong base, and a run that
  pushes nothing can no longer consume a reporter's feedback. The failure that did occur is
  now self-healing — once the branch is recoverable from origin, a stuck card resumes on its
  own. Fail-closed behaviour throughout means the degraded mode is "one wasted tick", never
  "lost work".
- **Negative**: Branches now outlive closed PRs, so `factory/issue-*` refs accumulate; the
  runbook documents reclamation. `branch_keep_reason` adds one `gh pr list` call per teardown
  (skipped on the `--release` path, which passes the known MERGED state). `git ls-remote` adds
  one network round-trip per cold worktree creation.
- **Neutral**: `add` gains `fromRemote` and `base` in its JSON, and `remove` gains
  `branchHead`; both are logged, making worktree provenance visible for the first time.

## Alternatives Considered

- **Put the PR check inside `worktree-cli.mjs`.** Rejected. The module is deliberately pure
  git plumbing — its header states that `factory-agent.sh` owns side effects so it can log
  and fail them in the right place — and its test harness is a temp `git init` repo with no
  network and no fakes. Importing `gh` would mean faking GitHub in every removal test to
  guard an operation bash already has `find_prior_pr` for.
- **Never delete branches.** Simple and safe, but leaks a ref per issue forever and discards
  the useful signal that a branch's absence carries.
- **Use `git merge-base --is-ancestor` to decide deletion safety.** Rejected, and actively
  wrong here: the factory squash-merges, so after a merge the branch tip is _not_ an ancestor
  of `main`. The check would refuse deletion in precisely the case where deletion is correct.
- **Compare the local `HEAD` instead of the PR head OID.** Rejected. The failure mode is
  "committed locally, push rejected", which a purely local comparison cannot see. The local
  check is used only where the remote one cannot discriminate (the `noop` revision path).
- **Trust the agent's self-report and fix only the prompt.** Rejected — that trust is the
  bug. The prompt fix removes the instruction that produced the false claim, but bash must
  still verify, because a rejected push has no sanctioned recovery available to the agent.

### Known-latent, deliberately not changed

- The parity post-check fails open: a `gh pr diff` failure sets no violation and the card
  advances. It now sits _behind_ the head-OID guard, so it can no longer be the sole gate on
  a run that pushed nothing. Tightening it risks livelocking a PR that persistently fails to
  diff.
- The cleanup sweep keys on `status:*` labels rather than the board's Status field, so a human
  drag and a factory transition are not equivalent. Making the sweep's teardown non-destructive
  is the right containment; reconciling labels with the board is a separate change.
