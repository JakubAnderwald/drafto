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
//   -->
//
// Library exports:
//   parseIssueFooter(body)
//     → { "reporter-email", "reporter-allowlisted", "zoho-thread-id", ... } | null
//   evaluateAllowlist(body, allowlist)
//     → { allowed, reason, email, claim } — the defence-in-depth gate
//        nightly-support.sh uses to decide whether to invoke Claude on the
//        issue. `allowed` is true iff the footer claims `reporter-allowlisted: true`
//        AND the footer's `reporter-email` is in the allowlist. Trusting just
//        the claim would let a tampered issue body bypass the gate; trusting
//        just the env list would re-enable old Apps Script issues we want
//        skipped now that filing flows through the new agent.
//
// CLI (used by bash callers — single field at a time keeps the bash side
// minimal; --check-allowlist returns the joined gate result):
//   parse-issue-footer.mjs --field <name>            (stdin = issue body)
//   parse-issue-footer.mjs --check-allowlist --allowlist <csv>
//                                                    (stdin = issue body)
// `--field` prints the field value (or empty string if absent / no footer)
// to stdout with no trailing newline. `--check-allowlist` prints
// "allowed=<true|false> reason=<reason>" on a single line and exits 0
// regardless of the verdict (callers branch on the parsed boolean — exit
// codes are reserved for hard errors like missing args).

import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

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
    if (key) fields[key] = value;
  }
  return fields;
}

function normaliseAllowlist(input) {
  if (Array.isArray(input)) {
    return input.map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

export function evaluateAllowlist(body, allowlist) {
  const list = normaliseAllowlist(allowlist);
  const fields = parseIssueFooter(body);
  if (!fields) {
    return { allowed: false, reason: "no-footer", email: "", claim: "" };
  }
  const email = (fields["reporter-email"] ?? "").toLowerCase().trim();
  const claim = (fields["reporter-allowlisted"] ?? "").toLowerCase().trim();
  if (claim !== "true") {
    return { allowed: false, reason: "claim-not-true", email, claim };
  }
  if (!email) {
    return { allowed: false, reason: "no-email", email, claim };
  }
  if (!list.includes(email)) {
    return { allowed: false, reason: "email-not-in-allowlist", email, claim };
  }
  return { allowed: true, reason: "ok", email, claim };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv) {
  const { flags } = parseFlags(argv);
  const body = await readStdin();
  if (flags["check-allowlist"] !== undefined) {
    const allowlist = flags.allowlist ?? "";
    const result = evaluateAllowlist(body, allowlist);
    process.stdout.write(`allowed=${result.allowed} reason=${result.reason}\n`);
    return null;
  }
  const field = flags.field;
  if (!field) {
    throw new Error("either --field <name> or --check-allowlist --allowlist <csv> required");
  }
  const fields = parseIssueFooter(body);
  if (!fields) return "";
  return fields[field] ?? "";
}

// `--check-allowlist` is a flag with no value, so the shared parseFlags
// helper (which requires every flag to have a value) would reject it. To keep
// things simple, the CLI uses `parseFlags` for the value-bearing flags only
// (--field, --allowlist) and detects --check-allowlist via a presence check
// before invoking parseFlags. The pre-check strips the bare flag from argv.
function preprocessCheckFlag(argv) {
  const out = [];
  let present = false;
  for (const a of argv) {
    if (a === "--check-allowlist") {
      present = true;
    } else {
      out.push(a);
    }
  }
  return { present, rest: out };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { present, rest } = preprocessCheckFlag(argv);
  const flagsArgv = present ? ["--check-allowlist", "x", ...rest] : rest;
  // Workaround: re-inject --check-allowlist as a value-bearing flag with a
  // throwaway value. main() reads the flag as truthy presence, not by value.
  main(flagsArgv).then(
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
