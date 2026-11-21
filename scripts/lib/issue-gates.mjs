#!/usr/bin/env node
// Structural gates shared by the dark factory and interactive issue driving
// (ADR-0091). The factory keeps its own bash copies in factory-agent.sh
// (spec_missing_section, parity_violation, migration_violation,
// status_label_for); scripts/__tests__/issue-gates.test.mjs runs both on the
// same cases and fails if they ever disagree, so an interactive session
// (scripts/drive-issue.mjs) applies exactly the gates the factory does.
//
// Every gate returns "" when it passes, or a short reason string when it fails,
// like its bash twin.
//
// CLI (each prints the reason, or nothing, and exits 0; exit 2 on bad usage):
//   issue-gates.mjs spec-missing [--override <parity override>]   < spec JSON
//   issue-gates.mjs parity --platforms <csv> [--override <o>] [--phase <A-D>]
//                                                   < newline-separated files
//   issue-gates.mjs migration-label --labels <csv>  < newline-separated files
//   issue-gates.mjs status-label <Status>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STATUS_LABELS = Object.freeze({
  Ready: "status:ready",
  Planning: "status:planning",
  "Plan Review": "status:plan-review",
  "In Progress": "status:in-progress",
  "In Review": "status:in-review",
  Testing: "status:testing",
  "In Test": "status:in-test",
  Approved: "status:approved",
  Released: "status:released",
  Done: "status:done",
  Blocked: "status:blocked",
});

export const ALL_STATUS_LABELS = Object.freeze(Object.values(STATUS_LABELS));

// Board Status option → status:* label, or "" for a column with no label
// (Backlog, or anything unknown).
export function statusLabelFor(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : "";
}

// The spec gate: the issue form's required sections must be non-empty. `spec`
// is parseSpec()'s output (scripts/lib/factory-bundle.mjs). Mirrors
// spec_missing_section in factory-agent.sh.
export function specMissingSection(spec, parityOverride = "") {
  const s = spec ?? {};
  if (!s.what) return "What";
  if (!s.acceptance) return "Acceptance criteria";
  if (!s.outOfScope) return "Out of scope";
  if (s.schemaChanges === null || s.schemaChanges === undefined) return "Schema changes?";
  const count = Array.isArray(s.affectedPlatforms) ? s.affectedPlatforms.length : 0;
  const infraBox = s.infraOnly === true;
  const override = parityOverride ?? "";
  if ((infraBox || override === "infra-only") && count !== 0) {
    return "Affected platforms (None / infra-only can't be combined with a platform box)";
  }
  if (infraBox && override !== "" && override !== "infra-only") {
    return `Affected platforms (None box conflicts with the ${override} label)`;
  }
  if (!infraBox && override !== "infra-only" && count === 0) return "Affected platforms";
  return "";
}

const PLATFORM_DIRS = { web: "apps/web/", mobile: "apps/mobile/", desktop: "apps/desktop/" };

// The parity post-check on a change's file list. Mirrors parity_violation in
// factory-agent.sh. `platforms` is the issue's affected platforms (array or
// CSV), `override` the parity:*-only label ("web-only", "infra-only", …) or "",
// `phase` the factory phase (only "B" changes the result: web only).
export function parityViolation({ platforms = [], override = "", files = [], phase = "" } = {}) {
  const list = toList(files);
  if (phase === "B" && list.some((f) => /^apps\/(mobile|desktop)\//.test(f))) {
    return "Phase B is web-only but the PR changes files under apps/mobile or apps/desktop";
  }
  if (override === "infra-only") {
    if (list.some((f) => /^(apps\/|packages\/shared\/)/.test(f))) {
      return "parity:infra-only but the PR changes app code (apps/ or packages/shared/)";
    }
    return "";
  }
  if (override) return "";
  for (const plat of toList(platforms, ",")) {
    const dir = PLATFORM_DIRS[plat];
    if (dir && !list.some((f) => f.startsWith(dir))) {
      return `claimed platform '${plat}' has no ${dir.replace(/\/$/, "")} changes`;
    }
  }
  return "";
}

// The migration-label gate: a change under supabase/migrations/ needs the
// migration-approved label. Mirrors migration_violation in factory-agent.sh.
export function migrationViolation(files = [], labels = []) {
  const touches = toList(files).some((f) => f.startsWith("supabase/migrations/"));
  if (touches && !toList(labels, ",").includes("migration-approved")) {
    return "PR touches supabase/migrations/** without the migration-approved label";
  }
  return "";
}

function toList(value, sep = "\n") {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(sep);
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = "";
      else flags[a.slice(2)] = argv[++i];
    } else positional.push(a);
  }
  return { flags, positional };
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function runCli(argv, stdin = readStdin) {
  const [cmd, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  switch (cmd) {
    case "spec-missing":
      return specMissingSection(JSON.parse(stdin() || "{}"), flags.override ?? "");
    case "parity":
      return parityViolation({
        platforms: flags.platforms ?? "",
        override: flags.override ?? "",
        phase: flags.phase ?? "",
        files: stdin(),
      });
    case "migration-label":
      return migrationViolation(stdin(), flags.labels ?? "");
    case "status-label":
      return statusLabelFor(positional.join(" "));
    default:
      throw new UsageError(
        "Usage: issue-gates.mjs <spec-missing [--override o] | parity --platforms csv " +
          "[--override o] [--phase p] | migration-label --labels csv | status-label <Status>>",
      );
  }
}

export class UsageError extends Error {}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const out = runCli(process.argv.slice(2));
    if (out) process.stdout.write(`${out}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
