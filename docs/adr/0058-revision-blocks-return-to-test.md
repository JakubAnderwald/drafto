# 0058 — Declined Revision Feedback Returns the Card to In Test

- **Status**: Accepted
- **Date**: 2026-10-25
- **Authors**: Jakub Anderwald, with Claude Code

## Context

A comment on a card in **In Test** rolls it back to In Progress, and the next `--implement` tick runs the implementer on the same PR branch with that comment (the "revision run"). The implementer ended with one of three directives:

- `implemented`: it pushed a change.
- `noop`: no code change was needed (a question, "run the test scenario for me"). Bash returns the card to In Test (or Testing, [ADR-0053](./0053-pre-in-test-verification-stage.md)), marks the comment consumed and checks for the implementer's reply.
- `blocked`: the card moved to **Blocked**, for every reason. That covered a request outside the approved plan, as well as a change it couldn't finish, a malformed plan or a suspected prompt injection.

On issue #457 (a security fix: users could make themselves admins) the owner commented "Run the test scenario for me on the mac mini". Two steps needed the operator: a migration push to the dev project and the dev service-role key. The implementer returned `blocked`, and the card sat in Blocked from 2026-09-26 to 2026-10-24 with a finished, testable PR, while production stayed exposed.

- Blocked is out of the column the owner watches for things to test, so a still-valid PR disappeared from view.
- The prompt has since ([#667](https://github.com/JakubAnderwald/drafto/pull/667)) classified "run the scenario" as a no-code request (`noop`), but a refusal still had only `blocked` to say it with.

## Decision

Revision runs get a fourth directive, **`action=declined`**. It is for feedback outside the approved plan's scope, with the PR left untouched. Bash sends a declined revision back to Testing / In Test exactly as it does a revision `noop`, through one shared helper (`revision_return_to_test`). The card keeps its slot and worktree, the comment is consumed, attempts reset, and bash checks for the reply. If there is no reply, a fallback says the request was outside the plan and to open a new issue rather than rephrase it.

Bash honours a decline only when all of these hold. Otherwise the card parks in Blocked, as for `blocked`:

- it is a revision run with a known PR head;
- that head is the one the reporter was shown at In Test (`intestCommentSha`). A card dragged out of Blocked hasn't been through In Review's CI, review and parity gates on its head, so it must not jump to In Test;
- the worktree holds nothing the PR lacks: HEAD is the PR head or behind it, and `git status` is clean. Any git error counts as touched.

`action=blocked` keeps its meaning and always parks the card in Blocked. That covers a change the implementer started but couldn't finish, a rejected push, a malformed plan and suspected prompt injection, because a human has to look at those.

The prompt changes to match:

- **Mixed feedback.** When one round mixes an in-plan change with an out-of-plan request, the implementer makes the in-plan change, emits `implemented`, and declines the rest in its reply.
- **Steps for you.** Steps only the operator can run (a dev migration push, the dev live tests) go in a **Steps for you** list with exact commands. They are never a reason to block or decline. For the push, `supabase projects list` confirms the dev link before `supabase db push`.
- **No marker on blocking comments.** A blocking comment never carries the reply marker, because the marker means "answered" and would make a retry skip the work.

## Consequences

- **Positive**: an out-of-plan request no longer hides a finished PR. The card stays in the column where the owner tests and ships, the comment is consumed (no re-run loop), and the reply says what to do instead.
- **Positive**: failures stay loud. A change request the implementer couldn't finish isn't consumed and doesn't land the card in In Test, where the PR could be shipped without the change.
- **Positive**: it is safe. Nothing leaves In Test without a human dragging the card to Approved, and a decline only returns a head that already passed In Review's gates.
- **Negative**: one more directive for the implementer to choose correctly. A failure misfiled as `declined` would be consumed. The worktree guard catches half-done edits, and the reply still tells the owner what happened.
- **Neutral**: a declined card holds its implement slot while it waits in In Test, like any In Test card, until the owner ships it or drags it away.

## Alternatives Considered

- **Treat every revision `blocked` with an untouched PR as a no-op.** This was the first draft. Review showed it would consume in-scope change requests the implementer failed to finish, letting the owner ship the PR without them. It would also let a card dragged out of Blocked skip In Review's gates, and could loop on a markerless blocking comment.
- **Keep Blocked, but consume the comment and always reply.** This fixes the loop but keeps the hiding problem that cost #457 four weeks.
- **Prompt rules only.** #667 already said "don't block a run request", and nothing enforced it.
- **Classify requests in bash before the implementer runs** (a regex like `is_noise_comment`). This is brittle: a misread change request would skip a needed revision, and the implementer already sorts comments with full context.
