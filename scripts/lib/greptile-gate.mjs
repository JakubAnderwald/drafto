#!/usr/bin/env node
// Greptile review hold: the IO half. See ADR-0047. Every decision lives in the
// pure greptile-review.mjs; this file only reads GitHub around it.
//
// Subcommands (each prints exactly ONE JSON line on stdout and exits 0; exit 1
// only on bad argv):
//
//   gate --pr N [--now ISO]
//       → {action: "promote"|"hold", reason, activity, note}. Called by --watch
//         on a converged In Review card, right after the CodeRabbit lane. Any
//         error inside the gate promotes, with "Greptile review status of PR #N
//         unknown (gate error)" as the note.
//   note --pr N [--now ISO]
//       → {note}. The In Test note when the In Test sweep re-writes a scenario
//         after the promotion: "" once Greptile has reviewed the PR. Never holds.
//
// Read-only and stateless. It reads the PR (for its creation time), the PR's
// reviews and its issue comments over REST through the factory's existing `gh`
// auth, plus the clock. It never reads or writes logs/factory-state.json, never
// posts, and needs no Greptile API key: Greptile itself runs as its GitHub App,
// configured by greptile.json at the repo root.

import { spawn } from "node:child_process";

import {
  classifyGreptileActivity,
  decideGreptileGate,
  greptileInTestNote,
  greptileUnknownNote,
  readGreptileKnobs,
} from "./greptile-review.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const REPO = "JakubAnderwald/drafto";

// One `gh` call may not hold up the --watch tick for long: every other card is
// waiting behind it. A timed-out read counts as a failed one.
const GH_TIMEOUT_MS = 60_000;

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// Spawn and collect, never throw: callers branch on `code`.
function runGh(args, { timeoutMs = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: err.message });
      return;
    }
    const out = [];
    const errOut = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => errOut.push(d));
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: err.message });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : (code ?? (signal ? 128 : 1)),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errOut).toString("utf8"),
      });
    });
  });
}

export function createDeps() {
  return {
    env: process.env,
    now: () => new Date().toISOString(),
    gh: (args) => runGh(args),
  };
}

async function ghPages(deps, apiPath) {
  const r = await deps.gh(["api", "--paginate", "--slurp", apiPath]);
  if (r.code !== 0) return { ok: false };
  const pages = parseJson(r.stdout);
  if (!Array.isArray(pages)) return { ok: false };
  return { ok: true, items: pages.flat() };
}

// {prCreatedAt, activity}. prCreatedAt is null when the PR can't be read;
// activity is "unavailable" when its reviews or comments can't.
export async function readGreptileInputs(pr, deps) {
  const [prRes, reviews, comments] = await Promise.all([
    deps.gh(["api", `repos/${REPO}/pulls/${pr}`]),
    ghPages(deps, `repos/${REPO}/pulls/${pr}/reviews?per_page=100`),
    ghPages(deps, `repos/${REPO}/issues/${pr}/comments?per_page=100`),
  ]);
  const view = prRes.code === 0 ? parseJson(prRes.stdout) : null;
  const prCreatedAt = typeof view?.created_at === "string" ? view.created_at : null;
  const activity =
    reviews.ok && comments.ok
      ? classifyGreptileActivity({ reviews: reviews.items, comments: comments.items })
      : "unavailable";
  return { prCreatedAt, activity };
}

export async function runGate({ pr, now }, deps = createDeps()) {
  const inputs = await readGreptileInputs(pr, deps);
  const decision = decideGreptileGate({
    ...inputs,
    pr,
    knobs: readGreptileKnobs(deps.env),
    now: now ?? deps.now(),
  });
  return {
    action: decision.action,
    reason: decision.reason,
    activity: inputs.activity,
    note: decision.note,
  };
}

export async function runNote({ pr, now }, deps = createDeps()) {
  const inputs = await readGreptileInputs(pr, deps);
  return {
    note: greptileInTestNote({
      ...inputs,
      pr,
      knobs: readGreptileKnobs(deps.env),
      now: now ?? deps.now(),
    }),
  };
}

const USAGE = "Usage: greptile-gate.mjs <gate|note> --pr N [--now ISO]";

class UsageError extends Error {}

export async function main(argv, deps = createDeps()) {
  const [sub, ...rest] = argv;
  if (sub !== "gate" && sub !== "note") {
    throw new UsageError(sub ? `unknown subcommand: ${sub}` : "missing subcommand");
  }
  const { flags } = parseFlags(rest);
  const pr = String(flags.pr ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(pr)) {
    throw new UsageError(`--pr must be a PR number: ${JSON.stringify(flags.pr ?? null)}`);
  }
  if (flags.now !== undefined && !Number.isFinite(Date.parse(flags.now))) {
    throw new UsageError(`--now must be a timestamp: ${JSON.stringify(flags.now)}`);
  }
  if (sub === "gate") {
    try {
      return await runGate({ pr, now: flags.now }, deps);
    } catch (err) {
      // Fail open: Greptile is an optional second reviewer and must never be
      // the reason a green card stays out of In Test. greptile_gate in
      // factory-agent.sh uses the same note for its own fail-open branches.
      return {
        action: "promote",
        reason: `gate-error: ${err.message}`,
        activity: "unavailable",
        note: greptileUnknownNote(pr, "gate error"),
      };
    }
  }
  try {
    return await runNote({ pr, now: flags.now }, deps);
  } catch {
    return { note: greptileUnknownNote(pr, "gate error") };
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      process.stdout.write(JSON.stringify(out) + "\n");
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message, usage: USAGE }) + "\n");
      process.exit(1);
    },
  );
}
