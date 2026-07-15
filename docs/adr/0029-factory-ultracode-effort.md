# 0029 — Dark Factory Claude Effort (ultracode coding stages)

- **Status**: Accepted
- **Date**: 2026-07-15
- **Authors**: Jakub Anderwald

## Context

The dark factory ([ADR-0026](./0026-dark-factory-pipeline.md)) drives issues through plan → implement → watch → release by invoking Claude Code from four call sites in `scripts/factory-agent.sh`. Every call was byte-identical and carried **no effort/model flag**:

```
node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions
```

So the reasoning effort of every unattended run was left to whatever ambient default the Mac mini's Claude config happened to have — not a deliberate choice, and silently subject to drift.

The installed Claude Code CLI exposes `--effort <level>`. Decoding the CLI confirmed that `--effort ultracode` is an accepted value in headless `-p` mode: it resolves reasoning effort to `xhigh` **and** activates dynamic multi-agent workflow orchestration. There is no `choices()` restriction, and if the Workflows feature is not enabled on the account it degrades safely to plain `xhigh` (no error). `run-claude.mjs` forwards all argv verbatim to `claude`, so the flag only needs to be added at the factory's own call sites — and _must not_ be added to `run-claude.mjs`, which is shared with `support-agent.sh`.

Forces at play:

- **Quality vs. cost.** ultracode fans out to many subagents and consumes materially more tokens. The factory ticks every 5 minutes and runs all stages back-to-back, so uniform ultracode would multiply usage against the shared paid subscription — which also rate-limits Jakub's own interactive Claude Code sessions on the same account (see the "Infrastructure cost discipline" section of the root `CLAUDE.md`).
- **Timeouts.** The `--plan`/replan sites inherited a 180 s wall-clock cap; xhigh planning of a real feature thinks longer than that and would be SIGKILLed (exit 124), churning the retry budget. The implement/watch caps (1800/900 s) are likewise tight for longer ultracode workflow runs.
- **Platform constraints.** The Mac mini runs bash 3.2, where expanding an empty array under `set -u` throws — so the flag must be a plain, always-non-empty, single-token string.
- **Output contract.** The factory greps each run's stdout for a strict single-line summary (`^issue=… action=… (plan-comment|pr)=…$`) via `grep … | tail -1`. Workflow subagent output lands in separate transcripts, so it does not corrupt this contract.

## Decision

Add `--effort` to all four factory Claude call sites, with the effort split by stage cost:

- **Code-writing stages** (`--implement`, `--watch`) → **`ultracode`** (env knob `FACTORY_EFFORT`).
- **Read-only planning stages** (`--plan`, replan) → **`xhigh`** (env knob `FACTORY_PLAN_EFFORT`).

Both knobs are validated against a fixed allowlist (`ultracode|max|xhigh|high|medium|low`); an unknown/empty value warns on stderr and falls back to the stage default, guaranteeing a single safe token for `--effort "$VAR"`. Raise the plan/replan cap to a knob `FACTORY_PLAN_TIMEOUT_SEC` (default 360 s, up from 180) and bump the implement/watch defaults to 2700/1800 s (from 1800/900) for ultracode headroom. The change is confined to `scripts/factory-agent.sh`; `run-claude.mjs`, `support-agent.sh`, and `nightly-support.sh` are untouched. `--release` never calls Claude and is unchanged.

## Consequences

- **Positive**: deliberate, high-effort unattended runs where they matter most (writing and fixing code); a single per-stage knob makes effort tunable and fully reversible without a code redeploy; blast radius is confined to the factory; safe degradation to xhigh if Workflows is unavailable.
- **Negative**: higher token consumption and rate-limit pressure on the shared subscription (mitigated by keeping planning at xhigh and by the dial-down knob); longer wall-clock per call means a hung run holds its mode lock/slot longer before the wall-time kill; introduces a rollout precondition — the Mac mini's `claude` must support `--effort` (an older CLI would fail every call and Block cards within `FACTORY_MAX_ATTEMPTS` ticks).
- **Neutral**: new env knobs (`FACTORY_EFFORT`, `FACTORY_PLAN_EFFORT`, `FACTORY_PLAN_TIMEOUT_SEC`) on the plist surface; ADR-0026 is amended, not superseded.

## Alternatives Considered

- **Uniform ultracode on every stage** — rejected: doubles down on the cost/rate-limit problem for the read-only planning stage, which benefits least from multi-agent fan-out. Still reachable by setting `FACTORY_PLAN_EFFORT=ultracode`.
- **Change the default in `run-claude.mjs`** — rejected: that wrapper is shared with the support agent, so the change would sweep in unrelated automation.
- **Plain `--effort xhigh` everywhere (no ultracode/workflows)** — rejected: drops the multi-agent autonomy that motivates the change on the coding stages; still reachable via the knob.
- **Leave the 180 s plan cap** — rejected: guarantees exit-124 churn once planning runs at xhigh.
- **Capability-gate the flag (degrade silently on an old CLI)** — rejected as the primary path: it would silently undo the decision. A hard rollout precondition (verify `claude --effort` on the Mac mini) is preferred; the CLI already degrades ultracode→xhigh on its own when Workflows is off.
