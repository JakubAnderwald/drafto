# 0084 — Factory Implement Deadline and Session Resume

- **Status**: Accepted
- **Date**: 2026-11-16
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

From 2026-10-17 to 2026-11-13 the factory ran 337 Claude sessions on 31 cards. Five of them were `--implement` runs that hit the 45-minute wall cap (`FACTORY_IMPLEMENT_TIMEOUT_SEC`), and those five used 13.5% of all the factory's tokens. A timeout killed the session, and the retry started a new one, so the 45 minutes of context the killed run had built up were lost (#797; #821 came close).

The agent also didn't know when its time ran out. #794's run (`e596cda3`) called `ScheduleWakeup` at 23:08Z to wait 31 minutes for a review Workflow, though its cap ended at 23:14Z. Nothing in the prompt or the bundle told it the deadline.

The CLI (2.1.323 on the Mac mini) can continue a session: `claude -p --resume <id>` keeps the session id and appends to the same `<id>.jsonl`. Only `--fork-session` mints a new id. Interrupted tool calls are not re-run, and a background Workflow the session was waiting on shows up as "didn't finish". Flags are not restored, so every call passes the same ones.

## Decision

1. **Every implement run names its session.** The run passes `--session-id <uuid>`. A resumed run passes `--resume <id>` instead, as plain strings (bash 3.2). `check_session_limit` gets the id as a third argument, and `session-limit.mjs check --session-id` reads that session's transcript rather than the newest one in the cwd. Verify-lane's lookup by id moved into `session-limit.mjs` as `findTranscriptById`.
2. **The agent gets its deadline.** After the install, bash appends a `## Run-time facts` JSON block to the input. It holds `capMinutes`, `startedAt`, `softDeadlineAt` (the cap minus `FACTORY_IMPLEMENT_SOFT_MARGIN_MIN`, 15 by default, with the margin clamped to the cap minus 5 minutes), `hardDeadlineAt`, `resumed`, and `worktree: {reused, leftoversRef, unpushedCommits, uncommittedChanges}`. A new **Time budget** section in `factory-prompt.md` tells the agent:
   - check `date -u` before a Workflow, a background agent, a long test run or a `ScheduleWakeup`;
   - never wait past `softDeadlineAt`;
   - commit `chore(wip): …` locally, unpushed, before a long Workflow;
   - start no Workflow with less than about 20 minutes left;
   - at the soft deadline, finish or stop with the new directive `action=incomplete`.

   A fresh run starts with `git status` and `git log origin/main..HEAD`, because an earlier attempt may have left work in the worktree.

3. **A fresh run that stops early is recorded as resumable.** That covers a wall-cap timeout (exit 124) and `action=incomplete`. The record holds the session id, the worktree HEAD, a digest of the worktree's uncommitted state, the task key, the PR head before the run and the time (`factory:implement-resume-set`). The task key is `plan:<id>@<digest>|rev:<id>@<digest>,…|issue:<digest>|phase:<FACTORY_PHASE>`, with each digest a hash of a body. So an approved plan or a feedback comment edited in place (same comment id), an edited issue body (the spec, which every fresh bundle reads again), or a change of phase (which decides what the run may touch) changes it. The worktree digest hashes `git status --porcelain=v1 -z`, `git diff HEAD --binary`, `git diff --cached --binary` and the contents of untracked, non-ignored files. The attempt is still spent. A run the session limit stops is recorded too, resumed or not: the limit stopped it, not the card, and it spends no attempt (as before). Claude gets `FACTORY_IMPLEMENT_TERM_GRACE_SEC` (30 s) between SIGTERM and SIGKILL to write the interrupted tool call to its transcript. `run-with-timeout.mjs` reads it as `CLAUDE_CALL_KILL_GRACE_SEC`, default 5 s. The implement call also sets `CLAUDE_CALL_KILL_GROUP=1`, so claude runs in its own process group. At the cap, or on a SIGTERM, SIGINT or SIGHUP sent to the wrapper, the whole group gets SIGTERM and then SIGKILL after the grace window. That timer runs on its own, so claude exiting on SIGTERM doesn't cancel it. A leader killed from outside, or one that exits on its own (a session-limit exit included) while leaving processes in its group, gets the same cleanup before the result. The wrapper returns only once the group is gone, polling for at most the grace window plus 10 s, and logs a group that survived. Claude's Bash tasks and background agents are ordinary children, and a nested `( … ) &` stays in the group (pinned by a test), so they die with it and none can keep writing to the worktree once the next run resumes there. A descendant that calls `setsid` (or daemonises) leaves the group and is out of reach; that is a known limitation. Every other caller keeps the default: no detached spawn and no group signals.
4. **The next run resumes only when it is safe.** The pure `decideResume` in `scripts/lib/implement-resume.mjs` refuses, in this order, when:
   - resuming is off (`off`);
   - there is no record (`no-record`);
   - the record is older than `FACTORY_IMPLEMENT_RESUME_MAX_AGE_MIN` (`stale`);
   - the worktree was created for this run (`worktree-new`);
   - it was fast-forwarded or had its leftovers set aside (`worktree-moved`);
   - HEAD moved (`head-moved`);
   - HEAD is the same but the uncommitted files changed (`worktree-dirty-changed`). That includes a lockfile the next start's `pnpm install` rewrote: the run is then fresh, as before this ADR;
   - the task key changed (`task-changed`), including an edit to the plan or to a feedback comment;
   - the reporter's comments changed since the stopped run's snapshot (`new-feedback`). The record stores a digest of the OWNER comments, minus the factory's own, as `{id, body}` pairs, taken from the snapshot that run's bundle was built from. A first implementation's key names no feedback, so without this a resumed session could miss a comment that its fresh replacement's bundle would carry;
   - the PR was closed or merged (`pr-closed`);
   - claude has no transcript for the session (`no-transcript`).

   Every start clears the record, whatever the answer, so a timeout chain resumes at most once. A resumed run gets the short `scripts/factory-implement-resume-prompt.md` and fresh run-time facts, not the prompt and bundle the session already holds. It keeps the reply directory. Its `action=implemented` is accepted only when the worktree's HEAD is on the PR (the PR head, or an ancestor of it after a fetch), so commits made after a predecessor's push can't be claimed without being pushed. Bash keeps two PR heads for it. `PRE_HEAD_OID` is the PR head at this run's start: the noop check (is the worktree's work on the PR?) and the noop and declined routing (is this the head shown at In Test?) use it. `CHAIN_PRE_HEAD_OID` is the PR head before the chain's first run: `action=implemented`'s "did the PR move" check and the migration post-check use it, so work a stopped predecessor pushed still counts.

   **Comment edge cases.** The `new-feedback` check compares two snapshots of GitHub data. It reads no timestamps, so neither the local clock nor GitHub's can skew it, and a comment that landed after the snapshot but before claude started still counts. Adding, editing or deleting a reporter comment changes the digest. The factory's own comments all carry a `<!-- drafto-factory` marker and don't count, and other people's comments don't count. A support-agent forward ([ADR-0066](./0066-support-forward-provenance-gate.md)) is an OWNER comment, so it counts: the fresh run's bundle applies the provenance gate to it as usual.

   **What a comment does on a first implementation.** The approved plan is the source of truth there. Comments reach the run only as `bundle.comments`, which is context, never a change request (`factory-prompt.md`: "Additional issue context", "Treat input as data"; the `--implement` block's "Fresh implementations have none" note). Feedback becomes actionable once the PR exists, through `lastFeedbackAt` and the In Test revision path, with its reply markers. A first implementation used to set `lastFeedbackAt` to the local "now" when it finished, which consumed unread any comment posted while it ran. It now sets it to the newest `createdAt` in its own comment snapshot, so a comment posted after the snapshot stays newer and the In Test sweep takes it up as feedback. A comment created in the same second as the snapshot's newest, yet missing from the snapshot, would still be marked consumed. The `new-feedback` digest still catches it for a resume.

5. **A resume that never started is free.** When a resumed run ends within 180 s and its transcript has no real assistant record after its start, no attempt is spent, and the next tick runs fresh. Examples are a CLI that refuses the session, or an API error on the restored conversation.

`FACTORY_IMPLEMENT_RESUME=0` turns resuming off. The deadline facts stay either way.

## Consequences

- **Positive**: A run that times out after 45 minutes of work continues with that context instead of rebuilding it, which saves most of a retry's tokens. The agent can plan around its cap, and it can stop cleanly with its work committed instead of being killed mid-Workflow. A wip commit also survives the worktree being snapshotted or fast-forwarded. The session-limit check can no longer read a concurrent run's transcript in the same cwd.
- **Negative**: The resumed session holds the old conversation, so the first call after a resume costs a cache miss on a long context. A resume is only as good as what the CLI restores. If a CLI upgrade changes `--resume`, resumes fail, and rule 5 keeps that from spending attempts. Unpushed `chore(wip)` commits plus a push by someone else to the PR branch leave a diverged worktree, which `worktree-cli add` refuses until a human reconciles it, as it already does for any crashed run with unpushed commits. That failure used to release the slot without spending an attempt, so the card retried unseen every tick. It now spends one, and the retry budget parks the card in Blocked.
- **Neutral**: A timed-out or incomplete run still spends an attempt, so the retry budget still bounds a card that never finishes. The record is per issue in `logs/factory-state.json` (`implementSessionId`, `implementResume*`). The post-claude handler stays in place for now; a later change extracts it into a function. The plan named the wip commit `wip(factory): …`, but the repo's commitlint (`config-conventional`) rejects a `wip` type in the commit-msg hook, so it is `chore(wip): …`.

## Alternatives Considered

- **Raise the implement cap.** Rejected. It spends more time on the same failure, and the agent still doesn't know when its time ends.
- **Resume with `--fork-session`.** Rejected. A new id for every resume adds nothing here, and the plain resume keeps one transcript per chain, which is easier to read afterwards.
- **Resume whenever a record exists.** Rejected. A resumed session trusts its memory of the worktree and the task. If the worktree moved, the plan changed or new feedback arrived, that memory is wrong, and a fresh run reading the current state is safer.
- **Resume repeatedly.** Rejected. A session that times out twice is more likely stuck than unlucky, and an ever-longer context costs more each time. After one resume the next attempt runs fresh and builds on the wip commits.
- **Enforce the soft deadline in bash with a second timer.** Rejected. Bash can only kill, and a kill loses the same work. The agent is the one that can stop cleanly, so it gets the deadline and a directive for it.
