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

3. **A fresh run that stops early is recorded as resumable.** That covers a wall-cap timeout (exit 124) and `action=incomplete`. The record holds the session id, the worktree HEAD, the task key (`plan:<plan comment id>|rev:<sorted revision comment ids>`), the PR head before the run and the time (`factory:implement-resume-set`). The attempt is still spent. A run the session limit stops is recorded too, resumed or not: the limit stopped it, not the card, and it spends no attempt (as before). Claude gets `FACTORY_IMPLEMENT_TERM_GRACE_SEC` (30 s) between SIGTERM and SIGKILL to write the interrupted tool call to its transcript. `run-with-timeout.mjs` reads it as `CLAUDE_CALL_KILL_GRACE_SEC`, default 5 s.
4. **The next run resumes only when it is safe.** The pure `decideResume` in `scripts/lib/implement-resume.mjs` refuses, in this order, when:
   - resuming is off (`off`);
   - there is no record (`no-record`);
   - the record is older than `FACTORY_IMPLEMENT_RESUME_MAX_AGE_MIN` (`stale`);
   - the worktree was created for this run (`worktree-new`);
   - it was fast-forwarded or had its leftovers set aside (`worktree-moved`);
   - HEAD moved (`head-moved`);
   - the task key changed (`task-changed`);
   - the PR was closed or merged (`pr-closed`);
   - claude has no transcript for the session (`no-transcript`).

   Every start clears the record, whatever the answer, so a timeout chain resumes at most once. A resumed run gets the short `scripts/factory-implement-resume-prompt.md` and fresh run-time facts, not the prompt and bundle the session already holds. It keeps the stopped run's PR head as its baseline, so work pushed before the cap still counts, and it keeps the reply directory.

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
