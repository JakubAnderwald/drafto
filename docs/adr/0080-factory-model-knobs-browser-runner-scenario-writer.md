# 0080 — Factory Model Knobs for the Browser Runner and Scenario Writer

- **Status**: Accepted
- **Date**: 2026-11-16
- **Authors**: Jakub Anderwald, with Claude Code

## Context

Every factory `claude` call runs on the CLI's default model, which on the Mac mini is Opus. The factory chooses each stage's **effort** ([ADR-0029](./0029-factory-ultracode-effort.md), [ADR-0076](./0076-factory-watch-effort-and-retry-budget.md)) but never its model. No stage passes `--model`.

The factory analysis of Oct 17 – Nov 13 (337 sessions, 31 cards) found two read-only stages using about 8% of all factory tokens, at Opus and `xhigh`, for mostly mechanical work:

- **The browser runner** ([ADR-0051](./0051-factory-browser-runner.md)). `run_browser_task` follows the `### Web` steps of the factory's own scenario in Chrome and prints a report. It runs as the In Test web run (`intest`), the Testing column's browser lane (`verify`, [ADR-0053](./0053-pre-in-test-verification-stage.md)) and the plan-stage probe (`plan`, [ADR-0071](./0071-plan-stage-browser-probe.md)).
- **The scenario writer** (`intest_handoff`). It turns the plan and the PR diff into a test scenario comment, once per head. It runs when a card enters In Test, and again for the Testing column (`verify_prepare`).

Neither stage writes code. A cheaper model may do both well enough. Nobody can tell without a trial, and a trial needs a switch the operator can flip and flip back from the launchd plist, without a code change.

## Decision

1. **Two env knobs, both empty by default.** `FACTORY_BROWSER_MODEL` sets the model of the browser runner, for all three of its kinds. `FACTORY_INTEST_MODEL` sets the model of the scenario writer, for In Test and Testing. Empty passes no `--model` flag at all, so the call is exactly what it was before this ADR. Merging this changes nothing until the plist sets a knob.
2. **Strict validation at startup.** A value must match `^(claude-[a-z0-9-]+|opus|sonnet|haiku|fable)(\[1m\])?$`: one of the CLI's aliases or a full `claude-…` name, optionally with the `[1m]` suffix. Anything else prints a warning on stderr, which lands in the launchd log, and the knob falls back to empty. The pattern rejects spaces and a leading dash, so a value can't add a flag to the call.
3. **`--model` goes in through an optional array.** Each call site builds `model_args=(--model "$KNOB")` only when the knob is set and expands it as `${model_args[@]+"${model_args[@]}"}`. That is the form bash 3.2 accepts for an empty array under `set -u`. Its position is pinned by the tests:
   - in the browser runner, right before `--effort` (so after `--chrome`), and the call still ends in `--effort "$FACTORY_PLAN_EFFORT" )`;
   - in the scenario writer, right after `--strict-mcp-config`, so `--effort … --no-chrome --strict-mcp-config` stays adjacent.
4. **Effort is unchanged.** Both stages still run at `FACTORY_PLAN_EFFORT`. A model change and an effort change are separate trials.
5. **Each call logs its model.** The "Invoking" log line of both stages gains `model=<value>`, or `model=default` when the knob is empty. That lets the trial match each report to the model that wrote it.

The rollout is an operator step after merge, never automatic:

1. Smoke-test the model with the flags the stages use: `claude --model claude-sonnet-5-5 --effort xhigh -p 'reply with OK'`.
2. Set both knobs in the plist and reload.
3. Compare the next 3–5 scenario and browser reports with Opus ones.
4. Revert by emptying the knobs.

## Consequences

- **Positive**: The two stages can run on a cheaper model from the plist, one knob each, and go back the same way. Each knob is independent, so the trial can keep Opus for one stage and change the other. The default path is untouched, and the tests prove an empty knob adds no argv at all.
- **Negative**: The pattern accepts any well-formed `claude-…` name, so a typo like `claude-sonet-5-5` passes validation, and every call of that stage then fails at the CLI:
  - the scenario writer posts its deterministic fallback comment;
  - the browser runner records an `error` result, which spends the attempt, so each head loses both of its browser attempts.

  The smoke test above exists to catch this. A weaker model may also write thinner scenarios or miss a UI fault. Both outputs are evidence, never a gate: a human still tests at In Test.

  Session-limit handling stays model-blind. `check_session_limit` matches a "session", "usage", "weekly" or "N-hour" limit in the transcript, whatever the model. If a stage on a knob's model hits a limit that only that model has, there are two outcomes. When the message matches, the whole factory pauses until the reset, including the stages on the default model. When it doesn't, the call counts as a plain error, as with a typo above. Emptying the knob ends both. Model-aware limit handling is left for a later change, if the trial shows it is needed.

  A rejected value warns only in the launchd log, because the knobs are checked before `log()` exists, as every other knob is. The factory log shows it only as `model=default` on the next `Invoking` line.

- **Neutral**: Every other call keeps the CLI default model: planning, the code review, `--implement`, `--watch` fix passes, and the verification shell lane (`verify-lane.mjs`, which reads only `FACTORY_PLAN_EFFORT`). Extending the knobs to them is a separate decision. The factory still has seven `claude -p` calls.

## Alternatives Considered

- **One knob for every read-only stage.** Rejected. The plan and review stages judge whether code is right, and a model change there needs its own evidence. Two narrow knobs let the trial cover only the stages the analysis flagged.
- **Change the CLI's default model on the Mac mini.** Rejected. It would move every factory stage and the operator's own interactive sessions at once, with no per-stage revert.
- **Lower the effort of these stages instead.** Not rejected, but separate. `FACTORY_PLAN_EFFORT` is shared with planning and the code review, so lowering it moves stages this ADR doesn't target. Effort and model are better tried one at a time.
- **An allowlist of exact model names.** Rejected. Every new model release would need a code change before the operator could try it. The pattern still blocks flag injection, and the smoke test catches a name the CLI rejects.
