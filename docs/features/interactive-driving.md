# Interactive issue driving

**Status:** shipped **Updated:** 2026-11-21

## What it is

A Drafto Factory issue can be driven by either of two drivers:

- **Factory mode.** The unattended dark factory on the Mac mini ([dark-factory.md](./dark-factory.md)) works the card from the board.
- **Interactive mode.** A Claude Code session you're in drives the card through the same columns, gates and tests. You run it with `/drive-issue <n>`.

Interactive mode has three things the factory lacks:

- **You in the loop.** You approve the plan and the merge in the terminal.
- **This Mac's devices.** The Android emulator, the iOS simulator, the macOS app and the local Chrome.
- **The rules for interactive sessions.** Manual E2E, live tests and the Local Secrets recipes.

Every material step is posted on the issue, so the issue is the log of what happened, whichever driver did the work.

A card can switch drivers at any column, in either direction. An interactive session leaves the artifacts the factory expects, so the factory carries on from wherever the card is handed back. See [ADR-0090](../adr/0090-interactive-issue-driving.md).

## How it works

- **Claim.** `node scripts/drive-issue.mjs claim <n>` adds the **`driver:interactive`** label.
  - Every factory mode skips a labelled card, the same way it skips `factory-pause` (`card_opted_out` in `scripts/factory-agent.sh`).
  - A detached implement run that ends while the card is claimed is held, not collected.
  - A card not yet on the board is added to Ready, after the label is on.
- **Same artifacts as the factory.** (Only PRs from this repo count. A fork PR from a branch of the same name is ignored.)
  - The branch is `factory/issue-<n>`.
  - The PR body starts with `<!-- drafto-factory-pr -->`.
  - The plan comment starts with `<!-- drafto-factory-plan -->` and has the factory's plan sections and plan-size marker. A session replan keeps the factory's `replan-ack` and `plan-probe-ack` markers. `--ack <comment ids>` adds markers for operator comments the replan answered.
  - The In Test scenario ends with the factory's three scenario markers.
  - Column moves set the board Status and the `status:*` label together, as `transition_status` does.
- **Same gates.** `scripts/lib/issue-gates.mjs` is the node copy of the factory's spec gate, parity check and migration-label gate. `scripts/__tests__/issue-gates.test.mjs` runs each case through both the bash and the node versions and fails if they ever disagree.
  - `drive-issue.mjs gates` runs the `--release` merge checks in the factory's order:
    1. ready and against main
    2. the PR marker
    3. the `migration-approved` label, and the SQL hash when this session approved it
    4. parity
    5. no conflicts
    6. migration order
    7. required CI
    8. up to date with main
    9. review threads resolved
    10. hosted config
  - It reuses `migration-approval.mjs`, `check-migration-order.mjs` and `hosted-config.mjs`.
- **Same standards.** At each stage, the skill has the session follow named sections of the factory prompts: `factory-plan-prompt.md`, `factory-prompt.md`, `factory-review-prompt.md`, `factory-watch-prompt.md`, `factory-intest-prompt.md` and `factory-verify-prompt.md`. One set of rules covers both drivers. `scripts/__tests__/drive-issue-skill-grounding.test.mjs` fails if a cited section disappears.
- **The log.** Every comment the CLI posts reads `🧑‍💻 **Interactive session · <step>**` and ends with `<!-- drafto-factory-session:<step>[:<key>] -->`. That marker belongs to the `<!-- drafto-factory` family the factory's feedback sweeps ignore. After a handback, the factory never reads the log as you asking for a replan or a revision. Factory comments (🏭) and session comments (🧑‍💻) together form one timeline.
- **Hand back.** `drive-issue.mjs release <n> --to <Column> --note …` does four things:
  - checks that the column fits (the current column when `--to` is left out). `--force` skips only the plan and open-PR requirement, never an unknown column or Planning;
  - adds the PR marker if it's missing;
  - removes the label;
  - logs what the factory will do next.

## Stages

| Column                 | The session                                                                                                                                                    | Log steps                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Ready                  | Worktree on `factory/issue-<n>`, claim, spec gate. Missing spec sections are drafted with you rather than blocking the card.                                   | `claim`, `spec`                                                  |
| Planning → Plan Review | Reproduces the bug or observes the screens on the real platform, then writes the plan in the factory's structure.                                              | `plan`, `replan`                                                 |
| **Gate 1**             | You approve in the session; the session moves the card to In Progress.                                                                                         | `plan-approved`                                                  |
| In Progress            | Implements the plan and runs the full test matrix, including manual E2E. Runs the parity check, then `/code-review` against the factory's review checklist.    | `implement-start`, `tests`, `code-review`                        |
| In Review              | Opens the PR, then runs `/push` until CI and every review thread are green.                                                                                    | `pr-opened`, `ci-green`                                          |
| Testing                | Posts the scenario and dispatches pre-merge betas. Drives every affected platform itself: Chrome, emulator, simulator, macOS app. Posts a verification report. | `scenario`, `beta-dispatched`, `verify-report`, `handoff-to-you` |
| **Gate 2** (In Test)   | You test, then approve or ask for changes. Changes send the card back to In Progress.                                                                          | `approved`, `revision`                                           |
| Approved → Released    | Runs the merge gates. Approves migrations only after your explicit yes. Runs `/merge`, then the post-merge beta wave, then takes the label off.                | `gates`, `migration-approved`, `merged`, `beta-released`         |
| Any                    | Blocked, or handed back to the factory.                                                                                                                        | `blocked`, `handback`                                            |

Every `move` also posts a `move` entry. `note` is for anything else worth recording.

## Rules by mode

Everything in `CLAUDE.md` applies to both modes. These are the rules that differ:

| Rule                                              | Factory (Mac mini, unattended)                                            | Interactive (`/drive-issue`)                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Who works the card                                | The board column decides. Skips `factory-pause` and `driver:interactive`. | The session that put `driver:interactive` on it.                                                      |
| Plan approval (gate 1)                            | You drag Plan Review → In Progress on the board.                          | You approve in the session. It logs `plan-approved` and moves the card.                               |
| Merge approval (gate 2)                           | You drag In Test → Approved on the board.                                 | You approve in the session. It logs `approved`, then runs `gates` and `/merge`.                       |
| Migration SQL                                     | `migration-approved` label, voided on any SQL change (ADR-0078).          | The same label, added by `approve-migration` after your explicit yes. `gates` re-hashes the SQL.      |
| Production data, prod DB, public stores           | Never.                                                                    | Only after your explicit yes, every time.                                                             |
| Devices, Mobile/Desktop E2E, `test:live:supabase` | Never; the live tests run only through the verify lane's filtered runner. | Yes. Desktop E2E and the macOS In-Test harness still need your yes, because they write to production. |
| Browser                                           | The locked-down browser runner only, on the Mac mini's Chrome.            | This Mac's own Chrome, per `~/.claude/CLAUDE.md`.                                                     |
| Secrets                                           | Only what its own scripts load.                                           | The Local Secrets recipes in `CLAUDE.md`.                                                             |
| Permissions                                       | `--dangerously-skip-permissions`, or `dontAsk` in guarded lanes.          | Normal permission prompts.                                                                            |
| Pre-merge and post-merge betas                    | Factory dispatch (`dispatch-release.mjs`).                                | Pre-authorized lanes run in the session.                                                              |
| Log                                               | 🏭 marker comments.                                                       | 🧑‍💻 session comments, one per material step.                                                           |
| Branch and PR                                     | `factory/issue-<n>`, PR marker.                                           | The same.                                                                                             |

## Switching drivers

**Taking a card from the factory.** Run `drive-issue.mjs status <n>`, then `claim <n>`. `claim` refuses a card in Planning, In Progress, In Review, Testing or Approved without `--force`, because a factory run may be live there: a plan, a detached implement, a fix pass pushing to the PR, a verification lane, or a merge. It also refuses a card another session already claimed. `--resume` picks up your own earlier claim after a session ended. Before forcing, check on the Mac mini:

- **A tick already running.** The label is read when a tick starts, so a running tick can still touch the card. `pgrep -fl factory-agent.sh` shows none running.
- **A detached implement run.** `node scripts/lib/implement-lane.mjs status --issue <n>` no longer lists the card, or you stopped the run with `node scripts/lib/implement-lane.mjs kill --issue <n> --finish 1 --outcome stopped`. Otherwise its result is held while you drive.

**Handing a card to the factory.** Commit and push everything first: unpushed commits make the factory's worktree diverge, and its implement stage then blocks the card. Then run `drive-issue.mjs release <n> --to <Column> --note "<state, what's left>"`.

| Hand back to                        | Needs            | The factory then                                                  |
| ----------------------------------- | ---------------- | ----------------------------------------------------------------- |
| Ready                               | —                | plans it (spec gate first)                                        |
| Plan Review                         | —                | waits for your board drag; your comments trigger a replan         |
| In Progress                         | the plan comment | implements the plan on `factory/issue-<n>`                        |
| In Review                           | plan + open PR   | fixes CI and threads, runs its code review, hands on              |
| Testing                             | plan + open PR   | runs its verification lanes                                       |
| In Test                             | plan + open PR   | waits for your board drag; actionable comments trigger a revision |
| Approved                            | plan + open PR   | runs `--release`: gates, merge, betas                             |
| Released / Done / Blocked / Backlog | —                | nothing                                                           |

Planning can't be a handback target: it is the factory's own transient column.

The factory keeps its SHA-keyed state on the Mac mini. On a handed-back card it re-runs whatever it hasn't seen at the current head, such as its code review, scenario and verification. That is deliberate.

## Troubleshooting

- **The factory worked a card you're driving.** Check that the label is exactly `driver:interactive` (`drive-issue.mjs status <n>` shows `driver: interactive`). A tick that started before the claim can still finish; see "Taking a card" above.
- **The factory ignores a handed-back card.** Check that the label is gone. Then check that the card is in a polled column: Backlog, Released, Done and Blocked aren't polled. A card in In Review needs an open PR on `factory/issue-<n>`.
- **`claim` fails on the board.** The `gh` token needs `project` scope: run `gh auth refresh -s project`.
- **`gates` says "migration order: check out the PR head locally first".** Run it from the worktree with the PR head checked out.
- **The label doesn't exist yet.** Run `bash scripts/setup-factory-labels.sh`.

## Key files

- `.claude/skills/drive-issue/SKILL.md`: the `/drive-issue` skill, stage by stage.
- `scripts/drive-issue.mjs`: the session CLI (`claim`, `status`, `spec`, `move`, `log`, `plan`, `scenario`, `parity`, `approve-migration`, `gates`, `release`).
- `scripts/lib/issue-gates.mjs`: the gates shared with the factory.
- `scripts/lib/factory-project.mjs`: board I/O (`findItemForIssue`, `addIssueToProject`, `setItemStatusByName`).
- `scripts/factory-agent.sh`: `card_opted_out`, the factory-side skip.
- Tests in `scripts/__tests__/`: `drive-issue.test.mjs`, `issue-gates.test.mjs`, `factory-agent-interactive-label.test.mjs`, `drive-issue-skill-grounding.test.mjs`.
