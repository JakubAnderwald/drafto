#!/usr/bin/env node
// Parse the support-agent footer from a GitHub issue body.
//
// The agent writes this fenced block at the bottom of every issue body it
// creates (Phase F+):
//
//   <!-- drafto-support-agent v1
//   reporter-email: jane@example.com
//   reporter-allowlisted: false
//   zoho-thread-id: 8537837000001234567
//   zoho-message-id: 1791172614617005600
//   -->
//
// The footer is LLM-written, so it is a fallback, never the source of truth.
// `github-sync.mjs issue-route` reads `zoho-thread-id` / `zoho-message-id`
// from it only when logs/support-state.json has no route for the issue (an
// issue filed before the runner persisted routes). `reporter-email` and
// `reporter-allowlisted` are human-readable provenance and are NOT trusted
// for the allowlist gate or as an email recipient; see ADR-0025.
//
// An empty value, or `null` / `undefined` (any case), is an absent field:
// first-contact filings write `zoho-thread-id: null`, and returning the
// string "null" made callers treat it as a real thread id (issue #658).
//
// CLI (used by bash callers — single field at a time keeps the bash side
// minimal):
//   parse-issue-footer.mjs --field <name>    (stdin = issue body)
// `--field` prints the field value (or empty string if absent / no footer)
// to stdout with no trailing newline.

import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { isAbsentValue } from "./route-value.mjs";

const FOOTER_RE = /<!--\s*drafto-support-agent v1\s*\n([\s\S]*?)\n\s*-->/;

export function parseIssueFooter(body) {
  if (typeof body !== "string") return null;
  const m = body.match(FOOTER_RE);
  if (!m) return null;
  const inner = m[1];
  const fields = {};
  for (const line of inner.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key || isAbsentValue(value)) continue;
    fields[key] = value;
  }
  return fields;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv) {
  const { flags } = parseFlags(argv);
  const body = await readStdin();
  const field = flags.field;
  if (!field) {
    throw new Error("--field <name> required");
  }
  const fields = parseIssueFooter(body);
  if (!fields) return "";
  return fields[field] ?? "";
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out !== null && out !== undefined) {
        process.stdout.write(String(out));
      }
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    },
  );
}
