# 0034 — Enforcing the Factory's Prompt Refuse-Lists with `--disallowedTools`

- **Status**: Accepted
- **Date**: 2026-09-08
- **Authors**: Jakub Anderwald

## Context

Each factory prompt carries a prose **"Refuse:"** list — no `gh pr merge`, no `gh workflow run`,
no fastlane, no `claude` or `node scripts/...` subprocess, and so on. Until now **nothing enforced
any of it.** All five Claude invocations run with `--dangerously-skip-permissions` and no
`--allowedTools`, `--disallowedTools` or `--permission-mode`, so the entire "allow-list" was
markdown, honoured by the model's compliance alone. A single drifting run could merge a PR, dispatch
a release, or reset its own retry budget, and nothing in the harness would stop it.

The obvious fix — "add an allow-list" — does not work. Measured against the installed CLI:

| Flags                                                           | Result                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| `--dangerously-skip-permissions --allowedTools "Read"`          | Bash **ran anyway** — allow-list ignored under bypass      |
| `--allowedTools "Read"` with no bypass flag                     | Bash **still ran** — the flag grants, it does not restrict |
| `--dangerously-skip-permissions --disallowedTools "Bash"`       | Bash **removed entirely** from the session                 |
| `--dangerously-skip-permissions --disallowedTools "Bash(ls:*)"` | `ls` **denied**, `echo` ran                                |

So the only lever that restricts anything is a **deny-list**, and it composes with the existing
bypass flag. Four further probes shaped the design:

- **Multi-word prefixes match.** `Bash(git log:*)` denies `git log` while `git status` still runs.
- **Compound commands are matched per clause.** `cd /tmp && ls /tmp` trips `Bash(ls:*)`.
- **`Task` subagents inherit the deny set.** A subagent asked to run a denied command reported it
  had no Bash tool. The mechanism is therefore not bypassable by delegation — which matters most on
  the two `ultracode` stages that fan out.
- **`:*` does not span a colon-suffixed token.** `Bash(echo release:*)` does **not** match
  `echo release:beta`. Script-name lanes like `pnpm release:beta` are therefore inexpressible.
- **A malformed pattern is silently ignored.** `Bash(ls:*` with an unclosed paren produced no error
  and no enforcement.

## Decision

Pass `--disallowedTools` — and never `--allowedTools` — at all five invocation sites, keeping
`--dangerously-skip-permissions` unchanged. Deny sets are built as plain comma-separated bash
strings next to the effort block (never arrays: an empty array under `set -u` throws on the Mac
mini's bash 3.2), composed in layers:

- **`FACTORY_DENY_CORE`** — shared by every stage. Release and host-control verbs (`gh pr merge`,
  `gh release create`, `gh workflow run`, `fastlane`, `xcodebuild`, `gradlew`, `launchctl`, `sudo`,
  `claude`), shell-escape wrappers (`bash -c`, `sh -c`, `zsh -c`), `WebFetch`/`WebSearch`, and each
  dangerous `scripts/lib/*.mjs` CLI in both relative and `$REPO_ROOT`-absolute form.
- **`FACTORY_DENY_IMPLEMENT` / `_WATCH`** — core plus history-rewriting git verbs (`git push
--force`, `git reset`, `git checkout`, `git rebase`, `git commit --amend`, `git worktree`,
  `git remote`). Plain `git push` and `pnpm` stay allowed: they are how the work lands and how it is
  verified. Watch also denies `gh pr create`, since the PR already exists by then.
- **`FACTORY_DENY_PLAN` / `_INTEST`** — the read-only stages, which can afford to deny `git`,
  `pnpm` and `node` wholesale. In Test additionally denies `Write`, matching its prompt's "you post
  one comment; that is your entire write surface". Plan keeps `Write` because replan writes
  `/tmp/factory-replan-body.md`.

Two of the core patterns carry most of the value: `Bash(node scripts/lib/state-cli.mjs:*)` stops an
agent resetting its own retry budget — the budget that is supposed to park it in Blocked — and
`Bash(node scripts/lib/factory-project.mjs:*)` stops it writing its own board Status, which is the
loop guard the whole pipeline rests on.

Because a malformed pattern is silently ignored, each stage **logs the deny set it passed** before
invoking Claude, and `factory-deny-grounding.test.mjs` validates every pattern's syntax.

## Consequences

- **Positive**: The load-bearing refusals are now mechanical rather than advisory, and inherited by
  subagents. A drifting or confused run cannot merge, release, or rewrite its own state. The prompts
  keep explaining _why_, which is still where the nuance lives.
- **Negative**: This is **allow-by-omission** — a _new_ CLI added under `scripts/lib/` is permitted
  until someone lists it. A test enumerates `scripts/lib/*.mjs` against a hardcoded set of pure
  modules and fails when something new is neither denied nor declared CLI-less. Denying `git reset`
  and `git checkout` also removes the sanctioned way to discard an edit, so `git restore` /
  `git restore --staged` were added to the implement and watch allow-lists in the same change.
- **Neutral**: Each stage's log gains one line naming its deny set.

### Scope — this is not a sandbox

Stated plainly because the headline invites the wrong reading: `--disallowedTools` is
**defence-in-depth against drift and mistakes, not a security boundary against an adversarial or
prompt-injected agent.** Several refusals cannot be expressed at all:

- **`gh api` mutations.** The method can be `--method`, `-X`, positional, or _implicit_ —
  `gh api repos/x/y/issues -f title=z` POSTs with no method flag, and `gh api graphql -f
query='mutation{…}'` mutates with none ever.
- **`pnpm release:*` on the coding stages.** The colon result above makes the pattern inert, and
  `pnpm --filter <app> test` is sanctioned so the prefix cannot be denied. The real chokepoint is one
  level down at `fastlane` / `xcodebuild` / `gradlew`, which are invoked name-first — hence their
  place in the core set.
- **Argument-value constraints** ("only URLs present in `bundle.screenshots`"), **cardinality
  constraints** ("`gh pr create` used once"), and indirection via `env`, `xargs` or backticks.

The controls that actually hold are architectural and predate this change: bash validates the
summary line, bash owns every board write and the merge, and the migration gate is a hard stop.

## Alternatives Considered

- **An allow-list.** The intuitive design, and the one originally chosen — but it is inert here in
  both modes, as the probe table shows. Kept out of the script entirely, and asserted absent, so its
  presence can never imply a guarantee it cannot give.
- **Dropping `--dangerously-skip-permissions` and using `--permission-mode` + allow-list.** Would
  give real allow-list semantics, but any tool call not covered would prompt — and there is no tty
  under launchd, so an incomplete list means a hung or dead stage rather than a denied command. Far
  higher risk for an unattended pipeline.
- **Denying broadly (`Bash(git:*)`, `Bash(gh:*)`) on every stage.** Simple and much stricter, but it
  bricks the coding stages: they require `git push`, `gh pr create`, and the pnpm verification
  matrix. The per-stage split exists precisely so the read-only stages can be strict without taking
  the coding stages down with them; the test suite pins the unsafe patterns explicitly.
- **Leaving it as prose.** The status quo, and the reason a single non-compliant run had nothing
  standing between it and a production release.
