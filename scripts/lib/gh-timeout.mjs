// Wall-clock cap for every `gh` call the factory makes. On #748 one
// `gh issue comment` sat idle for 2+ days (no socket open, every thread
// parked). Nothing bounded it, so it held the loop lock and froze every card
// until it was killed by hand. factory-agent.sh caps its own gh calls with the
// same knob through its gh() wrapper, which exports the validated value to the
// node helpers it starts.
//
// gh is a Go program: it exits on SIGTERM but ignores SIGALRM, so callers
// enforce this with a SIGTERM-sending timer (execFile's `timeout`,
// runCommand's `timeoutMs`), never alarm().

export const GH_TIMEOUT_SEC_DEFAULT = 120;

// Pure: the cap in ms from FACTORY_GH_TIMEOUT_SEC (whole seconds, ≥ 1), or the
// default when unset or invalid. Exported for tests.
export function ghTimeoutMs(env = process.env) {
  const raw = env.FACTORY_GH_TIMEOUT_SEC ?? "";
  const sec = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : GH_TIMEOUT_SEC_DEFAULT;
  return sec * 1000;
}
