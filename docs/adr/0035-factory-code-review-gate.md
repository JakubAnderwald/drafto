# 0035 — Factory Code Review Gate (review threads block the merge)

- **Status**: Accepted
- **Date**: 2026-09-12
- **Authors**: Jakub Anderwald

## Context

Until now the dark factory had no code review step at all, and actively discarded
the review feedback it did receive.

`/code-review` appeared exactly once in the repository — `CLAUDE.md` line 174, an
instruction addressed to interactive agents — and zero times under `scripts/`.
`scripts/factory-prompt.md`'s verification matrix is lint, typecheck, tests and
`format:check`: the same checks CI re-runs. So the factory was the one
code-writing path in the repo that skipped a rule `CLAUDE.md` requires of humans
before every `/push`.

That would matter less if something else read the code, but nothing did:

- SonarCloud is scoped to `sonar.sources=apps/web/src`. Of CodeRabbit's 1,548
  all-time inline comments on this repo, only 129 landed on that path. 356 were
  in `apps/desktop/`, 270 in `scripts/`, 168 in `apps/mobile/`, 140 in `docs/`.
- CodeRabbit was therefore the only adversarial reader factory PRs ever had — and
  it is a free vendor tier that rate-limited 10 of 34 sampled PRs with "You've
  used all free OSS reviews for now", then stopped issuing automatic reviews
  entirely for three weeks when the repo sat under CodeRabbit's 10-star
  threshold.

Three mechanisms in `factory-agent.sh` combined to throw findings away even when
they arrived:

1. **The fix loop only ran on red CI.** Its entry condition was
   `if [[ "$FAILING" -gt 0 ]]`, and the unresolved-comment set was built _inside_
   that block. A green PR with ten findings was promoted straight to In Test.
2. **It never read review comments.** `gh pr view --json comments` returns
   PR-conversation comments only — not inline review comments, not review bodies.
   Every inline finding was invisible to the loop.
3. **`resolve_review_threads()` force-resolved every thread without reading one**,
   immediately before the squash-merge. The repo has
   `required_conversation_resolution` enabled, but the owner-token merge bypasses
   it; the function existed to make that bypass "explicit and audited". In
   practice it satisfied the rule on paper and cleared the findings unread. PR
   #601's five CodeRabbit threads are all `isResolved: true` for exactly this
   reason.

## Decision

**Review threads are the merge gate. The factory produces them, answers them, and
verifies they are gone — it never clears one unread.**

Four changes:

1. **A code-review stage in `--watch`** (`review_stage()`), modelled on
   `intest_handoff()`: read-only commentary, its own prompt
   (`scripts/factory-review-prompt.md`), its own timeout knob
   (`FACTORY_REVIEW_TIMEOUT_SEC`, default 900), run at `FACTORY_PLAN_EFFORT`. It
   runs once per head SHA (`lastReviewSha`) on a PR whose required CI is already
   green, and posts each finding as an inline review thread plus one summary
   comment carrying `<!-- drafto-factory-code-review -->`.

2. **`fetch_review_threads()`** replaces `resolve_review_threads()`. It selects
   unresolved threads _with their comment bodies_ — the first time the factory
   reads review-comment text at all, which also brings CodeRabbit's inline
   findings into the loop for the first time.

3. **The fix loop triggers on open threads as well as failing CI**, and the
   watcher prompt requires, for each thread: fix it or determine no change is
   needed, reply saying which and why, then resolve it. Never resolve without
   replying.

4. **`--release` verifies instead of clearing.** An open thread refuses the merge
   and moves the card back to **In Review** so `--watch` — the only mode that
   runs the fix loop — can address it. A failed thread query fails closed.

The review runs **on the Mac mini**, as a sixth `claude -p` call inside
`factory-agent.sh`, not as a GitHub Action.

## Consequences

- **Positive**: findings can no longer be silently discarded — the gate that was
  nominally enforced by `required_conversation_resolution` is now really
  enforced. `scripts/`, `apps/desktop/`, `apps/mobile/` and `docs/` get an
  adversarial reader for the first time. CodeRabbit's inline findings reach the
  fix loop. No new monthly cost and no new credential: the Mac mini's Claude Code
  is already logged in, and the stage inherits the existing session-limit
  backoff, timeout shim, logging and locking.
- **Negative**: every factory card now spends at least one extra Claude call and
  one extra tick before reaching In Test, against a subscription the factory
  already exhausts (1,274 "hit your session limit" lines in `logs/`). A wrong
  finding stalls a card until the fix loop or a human clears it. A card whose
  threads arrive after approval loses its ship authorisation and must be
  re-approved — deliberate, since the diff changed after the human authorised it.
- **Neutral**: `watch_bound_thread_loop()` spends one retry attempt per
  thread-driven fix pass. A CI loop is self-limiting (green CI ends it); a thread
  loop is not, because each fix creates a new head SHA that earns a fresh review.
  `FACTORY_MAX_ATTEMPTS` therefore caps the review conversation at five rounds,
  after which the existing exhaustion path parks the card in Blocked. Attempts
  reset on the In Test promotion, so a converging card pays nothing lasting.

## Alternatives Considered

**`anthropics/claude-code-action@v1` with `CLAUDE_CODE_OAUTH_TOKEN`.** The
original plan. Rejected on three counts. (a) `claude setup-token` mints a
_one-year_ bearer credential for a personal Claude subscription; storing it as a
secret in a **public** repo whose autonomous agent writes workflow files is a
poor trade, and it expires silently a year later with reviews simply stopping.
(b) There is no Actions equivalent of `check_session_limit` →
`pause_for_session_limit` → `factory:pause-until`; a session limit would fail the
job and drop the review. (c) The action's identity handling is a trap: it posts
as `claude[bot]`, which GraphQL reports as `claude` — safe against
`factory-agent.sh`'s `test("vercel|github-actions")` filter only for as long as
nobody adds `github_token:` to the workflow, which would silently rename the
author to `github-actions` and drop every finding.

**Review inside `--implement`, before `gh pr create`.** Matches `CLAUDE.md`'s
"before `/push`" phrasing and costs no extra tick. Rejected because the same
agent in the same context window would be grading its own diff, and because
nothing would re-review the `--watch` loop's fix commits.

**Keep the fix loop CI-only and let findings surface at the In Test human gate.**
Smallest diff. Rejected: it leaves the operator to adjudicate every finding by
hand, which is the manual step the factory exists to remove.

**Block the In Test promotion on high-severity findings.** Rejected in favour of
gating at merge. Blocking promotion re-creates the #463 failure mode, where an
advisory signal loops `--watch` to exhaustion and parks the card in Blocked.
