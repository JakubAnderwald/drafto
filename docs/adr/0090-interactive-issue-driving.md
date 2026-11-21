# 0090 — Interactive Issue Driving Alongside the Factory

- **Status**: Accepted
- **Date**: 2026-11-21
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

The dark factory ([ADR-0026](./0026-dark-factory-pipeline.md)) drives a GitHub issue across the Drafto Factory board on the Mac mini, unattended:

- spec gate
- plan
- implement
- code review and fix loop
- verification
- In Test
- merge
- betas

It is deliberately locked down:

- It can't drive the Android emulator, the iOS simulator or the macOS app.
- It reaches a browser only through the guarded runner ([ADR-0051](./0051-factory-browser-runner.md)).
- It never runs the manual E2E rows or the live tests directly.
- It can only ask the operator something through a board drag or an issue comment.

Some cards are better driven with the operator in the loop: visual bugs that need reproducing on a device, desktop work, anything where a conversation beats a comment round-trip.

#861 was driven that way by hand. The runbook recipe it produced ("Driving a card from an interactive session") pauses the card with `factory-pause` and has the operator do everything else by hand:

- copy the factory's markers;
- swap board columns and labels with raw GraphQL;
- remember every gate.

Three things made that fragile:

- The factory recognises only its own artifacts:
  - an OWNER plan comment starting `<!-- drafto-factory-plan -->`;
  - a `factory/issue-<n>` branch;
  - the PR marker;
  - the scenario markers.
- It reads any OWNER comment without a `<!-- drafto-factory` marker as operator feedback, which triggers a replan or a revision.
- Its spec, parity and migration-label gates existed only as bash inside `factory-agent.sh`.

## Decision

Add a second driver mode, **interactive**, that drives the same issue through the same columns, gates and standards from a Claude Code session. Let a card switch drivers at any column, in either direction.

1. **Ownership label.** `driver:interactive` means a session owns the card. The factory routes every per-card skip through one helper, `card_opted_out`, which honours `factory-pause` and `driver:interactive` alike:
   - the Testing sweep, the plan rescue, Ready, Plan Review, In Progress, In Review, the In Test sweep and Approved;
   - the detached-run collection check;
   - the browser re-check.

   A test fails if a bare `factory-pause` guard reappears.

2. **Same artifacts.** A session works on `factory/issue-<n>` and opens the PR with the PR marker. It posts the plan in the factory's structure, with its markers, and the scenario with the factory's three markers. It moves cards the way `transition_status` does. That is what makes a handback work: the factory picks up whatever it finds.
3. **One log.** Every session comment is `🧑‍💻 **Interactive session · <step>**` with a `<!-- drafto-factory-session:<step>[:<key>] -->` marker. The marker is inside the family the factory's feedback sweeps already ignore. The CLI posts a log entry with every column move, and the skill names a log step for every material action.
4. **Shared gates, proven equal.** `scripts/lib/issue-gates.mjs` ports the spec gate, the parity check, the migration-label gate and the status-label map to node. The bash originals stay in `factory-agent.sh`, and a test runs every case through both. The tests extract the bash functions on their own, so delegating bash to node would have meant rewriting those tests. An equivalence test is a smaller and safer way to guarantee one behaviour.
5. **A CLI and a skill.**
   - `scripts/drive-issue.mjs` does the mechanics: claim, status, spec, move, log, plan, scenario, parity, approve-migration, gates (the `--release` order) and release.
   - `.claude/skills/drive-issue/SKILL.md` (`/drive-issue <n>`) does the judgement.
     - At each stage it sends the session to named sections of the factory's prompt files, so both drivers follow one set of standards. A test fails if a cited section disappears.
     - It adds what only an interactive session has: reproduce first, drive every affected platform, approval in the session.
     - It is user-invocable only (`disable-model-invocation: true`).
6. **Gates in session.** Plan approval and merge approval are the operator's words in the session, quoted in the log. Migration SQL, production data and public-store releases still need an explicit yes each time. The `migration-approved` label is still required, and `gates` re-hashes the SQL against the hash logged at approval (as [ADR-0078](./0078-migration-approval-tied-to-sql.md) does).

## Consequences

- **Positive**
  - The operator can take any card and hand it back mid-flight without the factory misreading it.
  - Interactive cards get the factory's gates and standards. Factory cards keep their own.
  - The issue is a complete log across both drivers.
  - Device and desktop verification becomes routine instead of a manual exception.
- **Negative**
  - The gate logic now exists twice, bash and node, kept equal by a test rather than by construction.
  - A claimed card that's abandoned stays out of the factory's hands until someone runs `release` or removes the label.
  - A tick that started before a claim can still touch the card once. The claim refuses risky columns (Planning, In Progress, In Review, Testing, Approved) without `--force`, and a card another session holds without `--resume`.
- **Neutral**
  - The factory's own behaviour changes only in which labels opt a card out.
  - Its SHA-keyed state on the Mac mini still drives what it re-runs after a handback.
  - The runbook's manual recipe now points to the CLI.

## Alternatives Considered

- **Keep using `factory-pause` for interactive work.** That label means "stop", not "someone else owns this", so `status` couldn't tell a paused card from a driven one. It also carries none of the handback checks.
- **Delegate the bash gates to node.** This gives one implementation. But the existing tests extract single functions out of `factory-agent.sh`, and that can't reach a node script by path. It would also put a node call on the factory's hot path for no behavioural gain over an equivalence test.
- **Separate standards files included by both the prompts and the skill.** This needs an include mechanism in the factory's prompt loading, a factory change with its own risk. Citing prompt sections, guarded by a grounding test, gets one set of standards without touching the factory.
- **A long-lived interactive daemon or a second factory "mode" flag.** Claude Code's own interaction model is the point. A skill plus a thin CLI keeps the human in the loop without a new service.
