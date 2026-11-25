# 0099 — Factory Pins Its Claude Model, and Revision Runs at xhigh

- **Status**: Accepted
- **Date**: 2026-11-25
- **Authors**: Jakub Anderwald, with Claude Code

## Context

An audit of 506 factory sessions ([report](https://claude.ai/artifact/JcSyvJoExc7WkHP3FgwUHE)) found two things this ADR acts on.

**The model was never chosen.** The factory sets each stage's effort ([ADR-0029](./0029-factory-ultracode-effort.md), [ADR-0076](./0076-factory-watch-effort-and-retry-budget.md)), but only two read-only stages could name a model, and only when a knob was set ([ADR-0080](./0080-factory-model-knobs-browser-runner-scenario-writer.md)). Every other call took whatever model the CLI picked:

- the five calls with setting sources (plan, replan, code review, `--implement`, `--watch` fix passes) took the model in the operator's `~/.claude/settings.json`, which an interactive session can change at any time;
- the browser runner and the verification shell lane run with `--setting-sources ""`, so they fell back to the CLI's built-in default, which changes with CLI releases.

So a settings edit or a CLI update could move every factory stage to another model, with nothing in the factory's code or logs saying so.

**Revision runs ran at ultracode.** A revision run is `--implement` on a card that already has a factory PR (open or closed) and has new owner feedback since its last consumed feedback, usually from In Test. It is a small change to code that already exists, but it ran at `FACTORY_EFFORT` (ultracode, with multi-agent workflow orchestration) like a fresh implementation. In 30 days, seven ultracode revisions cost $108, and three of them changed nothing. Twelve revisions that ran without workflows cost $19 in all.

## Decision

1. **Every factory Claude call passes `--model`.** A new knob, `FACTORY_MODEL`, defaults to `opus[1m]`. It is validated at startup with the same pattern as ADR-0080's knobs, `^(claude-[a-z0-9-]+|opus|sonnet|haiku|fable)(\[1m\])?$`. An invalid value warns on stderr and falls back to `opus[1m]`. The flag goes on all seven `run-claude.mjs -p` calls, on the detached implement run (`implement-lane.mjs`, ADR-0085) and on the verification shell lane (`verify-lane.mjs`, ADR-0053):
   - plan, replan, the code review, the scenario writer and `--watch` fix passes: right after `--strict-mcp-config`, so `--effort … --no-chrome --strict-mcp-config` stays adjacent;
   - `--implement`: right before the session flag, the same place in the synchronous call and in `buildImplementArgv`, so the parity test still holds;
   - the browser runner: right before the `--effort` that ends the call;
   - the verification shell lane: last, after `--effort`. `verify_shell_work` passes `--model` to `verify-lane.mjs start`, and `readKnobs` reads it (or `FACTORY_MODEL`) into `meta.model`. `buildClaudeArgs` appends it, and `assertSafeClaudeArgs` checks the value again right before the spawn.

   Each "Invoking" log line names the model (`model=…`), and so do the detached start's log line and the shell lane's start answer.

2. **ADR-0080's stage knobs now default to `FACTORY_MODEL`.** `FACTORY_BROWSER_MODEL` and `FACTORY_INTEST_MODEL` keep their meaning when set. Empty now means `FACTORY_MODEL`, not "no `--model`". An invalid value still warns and falls back to empty, which is now `FACTORY_MODEL`. The live plist keeps both on Sonnet. Per-stage knobs for the other stages are deferred until an A/B trial needs one.

3. **One pattern in two languages.** `scripts/lib/claude-model.mjs` exports `MODEL_RE` (and `DEFAULT_MODEL`) for the node lanes. It has no imports, so `verify-lane.mjs`'s supervisor path can use it without pulling in `factory-state.mjs`. A test pins its source to bash's `MODEL_KNOB_RE` and checks that both engines give the same verdict on the same inputs. In the bash function bodies, the model always expands as `"${FACTORY_MODEL:-opus[1m]}"`. Tests load these functions without the knob block, so the default keeps them safe under `set -u`. The value is always quoted, because unquoted `opus[1m]` is a glob.

4. **Revision runs at `FACTORY_REVISION_EFFORT`, default `xhigh`.** The knob sits beside the other effort knobs, with the same `case` allowlist and fallback. `implement_effort <is_revision>` returns it for a revision run and `FACTORY_EFFORT` otherwise. The `--implement` loop sets `IMPL_EFFORT` from it once, right after it decides whether the run is a revision. The synchronous call, the detached start's spec and both log lines use it. It is not stored in the run's context: the detached run's `meta.effort` already records it. A resumed run gets the same effort as the run it resumes, because the resume task key includes the revision comments (`implement-resume.mjs`), so a resume never crosses between a fresh run and a revision.

5. **The implementer prompt follows the effort.** `implement_runtime_facts` adds the run's effort to the **Run-time facts** block as `effort`, from `IMPL_EFFORT`, in both the synchronous and the detached path. `scripts/factory-prompt.md`'s "Revision runs" section tells the agent to do a revision itself, with no Workflow and no background agents, unless `effort` is `ultracode`. The prompt never names the default, so the knob alone moves both the `--effort` flag and the instruction.

No version skew: bash writes a detached run's spec and `implement-lane.mjs` reads it in the same tick, from the same checkout. Runs already in flight keep the `argv` stored in their `meta.json`. A verification run started before this change has no `meta.model`, so its supervisor passes no `--model`, as before.

## Consequences

- **Positive**:
  - The factory's model is in its code and its logs. A settings edit or a CLI update no longer moves it, and every log line says which model ran.
  - The browser runner and the shell lane no longer run on the CLI's built-in default.
  - Revision runs should cost about what the plain-effort revisions did, not $15 each.
  - The model is one plist knob, so an A/B trial or a rollback needs no code change.
- **Negative**:
  - `FACTORY_MODEL` is a single point. A name the CLI rejects (the pattern accepts any well-formed `claude-…` name) fails every call that uses it. Smoke-test a model on the Mac mini before setting it, as ADR-0080 already asks for its knobs.
  - `opus[1m]` must be a model the subscription can use, with and without setting sources. The rollout smoke test checks both, before the merge.
  - A revision that really needs a large change now runs without workflows. Set `FACTORY_REVISION_EFFORT=ultracode` to undo that: the run then starts at ultracode and its `effort` fact lets it use Workflows again. No prompt or code change is needed.
  - The model in `~/.claude/settings.json` no longer reaches the factory. That is the point, but it surprises an operator who changes it expecting the factory to follow.
- **Neutral**:
  - Effort is unchanged everywhere except revision runs.
  - The support and nightly scripts are not part of this change and still take the CLI's model.
  - The factory still has seven `claude -p` calls.

## Alternatives Considered

- **Set the model in `~/.claude/settings.json` only.** Rejected. It is the operator's interactive setting, it moves with every session, and the two `--setting-sources ""` calls never read it.
- **A model knob per stage now.** Deferred. Nothing needs one yet, and each knob is one more pinned shape. ADR-0080's two knobs cover the stages a trial has flagged so far.
- **Leave the browser and scenario knobs as "empty means no `--model`".** Rejected. With `--setting-sources ""`, the runner would keep its unpinned built-in default, which is half of what this ADR fixes.
- **Revisions at `FACTORY_WATCH_EFFORT`.** Rejected. A revision is an `--implement` run, with its own deadline, prompt and cap. A separate knob lets the operator move it without touching the watch fix passes.
- **Decide revision effort from the size of the feedback.** Rejected for now. It is a guess without data. One knob is enough to tell whether xhigh is too little.
