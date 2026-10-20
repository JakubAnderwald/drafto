// Fenced code blocks, by CommonMark's rule — the one GitHub renders with.
//
// Why this exists: the factory reads its own scenario comments by section
// (factory-bundle.mjs) and posts lane output it didn't write
// (verify-report.mjs). Both must agree with GitHub on where a code block ends:
// a `### …` line inside one is content, not a section, and a block a lane
// leaves open would turn the rest of a posted comment into code.
//
// The rule: a fence opens on a line of 3+ backticks or tildes (a backtick
// fence's info string can't contain a backtick) and closes only on the same
// character, at least as long, with nothing but whitespace after it. So a
// ```` ````md ```` block that quotes a ```` ```js ```` block is still open
// after the inner ```` ``` ````.

// A line that looks like a fence: indent, the marker run, the rest.
export const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;

// The fence state after <line>, given the state before it: null when no fence
// is open, else { char, len } of the open one.
export function fenceStep(open, line) {
  const m = FENCE_LINE.exec(line);
  if (!m) return open;
  if (open === null) {
    if (m[1][0] === "`" && m[2].includes("`")) return null;
    return { char: m[1][0], len: m[1].length };
  }
  return m[1][0] === open.char && m[1].length >= open.len && !m[2].trim() ? null : open;
}

// <text> with the fence it leaves open (if any) closed. Apply before adding
// list indentation, so the closer gets the same indentation as the rest.
export function closeFences(text) {
  let open = null;
  for (const line of String(text).split("\n")) open = fenceStep(open, line);
  return open ? `${text}\n${open.char.repeat(open.len)}` : String(text);
}
