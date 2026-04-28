#!/usr/bin/env node
// Wrappers around the gh CLI for the support agent's GitHub-side flows.
//
// The agent already relies on the gh CLI on the Mac mini (Stage 2 nightly
// auto-implementation, the failure-issue path in support-agent.sh). Reusing
// it here keeps the auth model identical: no new tokens, no new env vars.
//
// Subcommands (called from scripts/support-agent.sh during --comment-sync):
//   list-support-issues [--state <open|closed|all>] [--limit <n>]
//        Returns the support-labelled issues, with body + createdAt + labels.
//        Uses the same gh-issue-list shape as nightly-support.sh.
//
//   list-new-comments <issue-number> --since <iso> [--bot-user <login>]
//        Returns issue comments newer than --since AND not authored by
//        --bot-user. Defaults bot-user to JakubAnderwald (the human auth on
//        the Mac mini — anything *we* post via gh appears as that login,
//        whether by Stage 2's auto-impl Claude session or by manual reply,
//        so we filter all of it out of the customer-facing forward).
//
//   find-linked-thread <issue-number>
//        Reads the issue body and returns the `zoho-thread-id` field from the
//        agent's footer. Empty string if no footer or no field.
//
// All subcommands print JSON (or a plain string for find-linked-thread) to
// stdout and exit 0. Errors print `{"error": "..."}` to stderr and exit
// non-zero — same shape as zoho-cli.mjs / state-cli.mjs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { parseIssueFooter } from "./parse-issue-footer.mjs";

const execFileP = promisify(execFile);

const REPO = "JakubAnderwald/drafto";
const DEFAULT_BOT_USER = "JakubAnderwald";

let _execFileForTests = null;

export function _setExecFileForTests(impl) {
  _execFileForTests = impl;
}

async function runGh(args) {
  const fn = _execFileForTests ?? execFileP;
  // 16 MiB output cap — gh api --paginate can return large JSON arrays for
  // long-lived issues; the default 1 MiB cap was hit during dev.
  const { stdout } = await fn("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function listSupportIssues({ state = "all", limit = 200 } = {}) {
  const stdout = await runGh([
    "issue",
    "list",
    "--repo",
    REPO,
    "--label",
    "support",
    "--state",
    state,
    "--json",
    "number,title,state,body,createdAt,labels",
    "--limit",
    String(limit),
  ]);
  return JSON.parse(stdout);
}

export async function listIssueComments(issueNumber) {
  const stdout = await runGh(["api", "--paginate", `repos/${REPO}/issues/${issueNumber}/comments`]);
  // gh api --paginate concatenates pages by emitting the merged array as a
  // single JSON document. Defensive parse: if it ever changes to NDJSON we'd
  // see a parse error and the caller would log + skip.
  return JSON.parse(stdout);
}

export async function getIssueBody(issueNumber) {
  const stdout = await runGh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    REPO,
    "--json",
    "body",
  ]);
  const data = JSON.parse(stdout);
  return data?.body ?? "";
}

// Pure (no IO) — kept exported so tests can drive it without the gh shim.
export function filterNewComments(comments, sinceIso, botUser = DEFAULT_BOT_USER) {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  if (Number.isNaN(since)) {
    throw new Error(`filterNewComments: --since is not a valid ISO timestamp: ${sinceIso}`);
  }
  return (Array.isArray(comments) ? comments : []).filter((c) => {
    const author = c?.user?.login ?? c?.author?.login ?? "";
    if (author === botUser) return false;
    const t = Date.parse(c?.created_at ?? c?.createdAt ?? "");
    if (Number.isNaN(t)) return false;
    return t > since;
  });
}

export async function findLinkedThread(issueNumber) {
  const body = await getIssueBody(issueNumber);
  const fields = parseIssueFooter(body);
  return fields?.["zoho-thread-id"] ?? "";
}

async function main(argv) {
  const [sub, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  switch (sub) {
    case "list-support-issues":
      return listSupportIssues({
        state: flags.state ?? "all",
        limit: Number(flags.limit ?? 200),
      });
    case "list-new-comments": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("list-new-comments requires <issue-number>");
      if (!flags.since) throw new Error("list-new-comments requires --since <iso>");
      const comments = await listIssueComments(issueNumber);
      return filterNewComments(comments, flags.since, flags["bot-user"] ?? DEFAULT_BOT_USER);
    }
    case "find-linked-thread": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("find-linked-thread requires <issue-number>");
      return findLinkedThread(issueNumber);
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: github-sync.mjs <list-support-issues [--state <s>] [--limit <n>]|" +
          "list-new-comments <issue-number> --since <iso> [--bot-user <login>]|" +
          "find-linked-thread <issue-number>>\n",
      );
      return null;
    default:
      throw new Error(`Unknown subcommand: ${sub}`);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out === null || out === undefined) return;
      // find-linked-thread returns a bare string; everything else is JSON.
      // Bash callers parse JSON for arrays / objects, so emit the canonical
      // pretty-printed form, but leave plain strings raw (the bash side
      // captures them as `$(node github-sync.mjs find-linked-thread N)` and
      // expects a value, not `"value"`).
      if (typeof out === "string") process.stdout.write(out);
      else process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    },
  );
}
