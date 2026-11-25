// The model a factory Claude call names with --model (ADR-0080, ADR-0101).
//
// factory-agent.sh validates its model knobs (FACTORY_MODEL and the two stage
// knobs) against MODEL_KNOB_RE; the node lanes that build a claude argv of
// their own (implement-lane.mjs, verify-lane.mjs) validate against MODEL_RE.
// claude-model.test.mjs pins the two patterns to each other. A value is a
// model alias (opus, sonnet, haiku, fable) or a full claude-… name, optionally
// with the [1m] suffix: always one argv token, never a flag.
//
// Kept in its own module, with no imports, so verify-lane.mjs's supervisor
// path can use it without pulling in factory-state.mjs.

export const MODEL_RE = /^(claude-[a-z0-9-]+|opus|sonnet|haiku|fable)(\[1m\])?$/;

// FACTORY_MODEL's default in factory-agent.sh.
export const DEFAULT_MODEL = "opus[1m]";

export function isValidModel(value) {
  return typeof value === "string" && MODEL_RE.test(value);
}
