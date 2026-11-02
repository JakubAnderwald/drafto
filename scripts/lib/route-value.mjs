// One rule for "is this Zoho id / subject / address actually there?", shared by
// state-cli.mjs (writes), parse-issue-footer.mjs (footer reads),
// github-sync.mjs (route resolution) and build-bundle.mjs (bundle output), so
// the four can never disagree about what counts as absent.
//
// "", "null" and "undefined" (any case, any surrounding whitespace) are what an
// unset bash / jq / LLM value turns into: the singleton footer line
// `zoho-thread-id: null` is how issue #658 lost its progress emails. None of
// them is a real route.

// Pure: the trimmed string value, or null when absent. Numbers are stringified
// (an id read back from JSON); any other type is absent.
export function normaliseRouteValue(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  const lower = s.toLowerCase();
  if (s === "" || lower === "null" || lower === "undefined") return null;
  return s;
}

export function isAbsentValue(raw) {
  return normaliseRouteValue(raw) == null;
}
