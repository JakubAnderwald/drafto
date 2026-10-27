// Turns a reply the factory's model wrote into the issue comment bash posts.
//
// The planner (Plan Review replans) and the implementer (In Test revisions)
// answer each operator comment by writing a file, <replyDir>/<commentId>.md.
// They never post it: bash does, through `compose` below, which neutralises
// any factory marker in the text and appends the comment's reply marker. So a
// reply never depends on the model remembering its marker (a reply without
// one would read back as fresh OWNER feedback and start another replan or
// revision), and the model's text can't pass for a factory marker of its own.
//
// CLI:
//   node issue-reply.mjs compose --file <path> --marker <marker>
//     Prints the comment body. Exits 3 when the file is empty, 2 on a bad
//     marker, 1 when the file can't be read.

import { readFileSync } from "node:fs";
import { truncateReport } from "./browser-report.mjs";
import { isMainModule } from "./is-main.mjs";

// GitHub rejects a comment over 65,536 characters; leave room for the marker.
export const REPLY_BODY_MAX = 60_000;

// plan-blocked-reply answers a comment a replan couldn't handle (the card went
// to Blocked), so a later replan of the same comment still gets its own reply.
const MARKER_RE = /^drafto-factory-(plan|plan-blocked|revise)-reply-\d+$/;

// Break every "drafto-factory" token with a zero-width space, as defangReport
// does, so no marker grep can match the model's text. Unlike defangReport this
// leaves "<!--" alone: a reply quoting HTML or a log line in a code block must
// show it as written, and a hidden comment without the token marks nothing.
export function defangMarkers(text) {
  return String(text ?? "").replace(
    /drafto-factory/gi,
    (m) => `${m.slice(0, 6)}\u200b${m.slice(6)}`,
  );
}

export function composeReply(text, marker) {
  if (typeof marker !== "string" || !MARKER_RE.test(marker)) {
    throw new Error(`issue-reply: bad marker: ${JSON.stringify(marker)}`);
  }
  let body = defangMarkers(String(text ?? "").trim());
  if (!body) return null;
  if (body.length > REPLY_BODY_MAX) {
    body = `${truncateReport(body, REPLY_BODY_MAX).trimEnd()}\n\n_(Reply cut at ${REPLY_BODY_MAX.toLocaleString("en-US")} characters.)_`;
  }
  return `${body}\n\n<!-- ${marker} -->`;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, "")] = rest[i + 1];
  if (cmd !== "compose" || !flags.file) {
    process.stderr.write("usage: issue-reply.mjs compose --file <path> --marker <marker>\n");
    return 2;
  }
  let text;
  try {
    text = readFileSync(flags.file, "utf8");
  } catch (err) {
    process.stderr.write(`issue-reply: can't read ${flags.file}: ${err.message}\n`);
    return 1;
  }
  let body;
  try {
    body = composeReply(text, flags.marker);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (body === null) return 3;
  process.stdout.write(body);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
