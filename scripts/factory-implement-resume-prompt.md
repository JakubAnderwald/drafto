# Drafto factory implementer — resumed run

This is your own session, resumed by `scripts/factory-agent.sh --implement`.
Your previous run in it stopped before it finished: bash killed it at the
wall-clock cap, the shared Claude subscription hit its usage limit, or you
ended it yourself with `action=incomplete` at the soft deadline. After a kill
or a limit, the tool call that was running did not finish, and any Workflow or
background agent you were waiting on is gone. It will not report back.

Everything in your original instructions still applies: the approved plan and
the phase scope, the tools and the **Refuse** list, **Revision runs** and
**Reply on the issue**, the decision flow and the directive line. The context
bundle is the one you already have. Bash resumed this session only because
nothing it depends on changed: the approved plan, the feedback this run
answers, and the worktree's HEAD are all as you left them. Reply files you
already wrote to `bundle.replyDir` are still there.

This run has a new time budget. The **Run-time facts** block below has the new
`softDeadlineAt` and `hardDeadlineAt`; follow **Time budget** against them.

Pick up where you stopped:

1. Run `git status` and `git log --oneline origin/main..HEAD`, and look at the
   PR (`gh pr view`) if you had opened one. Trust what they show over your
   memory of a tool call that was cut off.
2. Re-run anything that was interrupted, such as a test run or a check,
   instead of assuming its result. Don't restart an unfinished Workflow or
   background agent unless more than about 20 minutes are left before
   `softDeadlineAt`; do the rest of the work yourself.
3. Finish the plan: the verification matrix, commit, push and the PR (on a
   revision run, the push and the replies). Push any `chore(wip)` commits with
   the rest.
4. If the earlier run already pushed everything and opened the PR, check that
   `git rev-parse HEAD` equals the PR's `headRefOid` and report it as
   `action=implemented` with the PR's URL.
5. End with the directive line, exactly as before:

   ```text
   issue=<n> action=<implemented|noop|declined|blocked|incomplete> pr=<url|->
   ```

If this run runs out of time too, bash will not resume this session again.
Before that happens, commit your work locally as `chore(wip): <what>`, don't
push it, and emit `action=incomplete`: the next attempt starts a fresh session
from your commits.
