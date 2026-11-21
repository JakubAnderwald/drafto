import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_STATUS_LABELS,
  migrationViolation,
  parityViolation,
  runCli,
  specMissingSection,
  statusLabelFor,
} from "../lib/issue-gates.mjs";

// scripts/lib/issue-gates.mjs is the node copy of four factory-agent.sh
// helpers, used by interactive sessions (scripts/drive-issue.mjs, ADR-0091).
// The factory keeps its bash originals; every case below runs through BOTH and
// must agree, so the two modes can never apply different gates.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");

// Extract one function from the real script (its `name()` line through the
// first column-0 `}`) and run `body` after it, under /bin/bash (3.2 on macOS,
// what launchd runs).
function bash(fns, body, env = {}) {
  const defs = fns
    .map((fn) => `eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`)
    .join("\n");
  const r = spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${defs}\n${body}`], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
  return r.stdout.replace(/\n$/, "");
}

const base = {
  what: "a change",
  acceptance: "it works",
  affectedPlatforms: ["web"],
  infraOnly: false,
  schemaChanges: false,
  ui: "",
  outOfScope: "nothing",
};

const SPEC_CASES = [
  ["complete", base, ""],
  ["no What", { ...base, what: "" }, ""],
  ["no acceptance", { ...base, acceptance: "" }, ""],
  ["no out of scope", { ...base, outOfScope: "" }, ""],
  ["schema unset", { ...base, schemaChanges: null }, ""],
  ["no platforms", { ...base, affectedPlatforms: [] }, ""],
  ["no platforms, infra-only label", { ...base, affectedPlatforms: [] }, "infra-only"],
  ["None box", { ...base, affectedPlatforms: [], infraOnly: true }, ""],
  ["None box + platform", { ...base, infraOnly: true }, ""],
  ["infra-only label + platform", base, "infra-only"],
  ["None box + web-only label", { ...base, affectedPlatforms: [], infraOnly: true }, "web-only"],
  ["web-only label", base, "web-only"],
];

describe("specMissingSection matches spec_missing_section", () => {
  for (const [name, spec, override] of SPEC_CASES) {
    it(name, () => {
      const viaBash = bash(["spec_missing_section"], `spec_missing_section "$SPEC" "$OVERRIDE"`, {
        SPEC: JSON.stringify(spec),
        OVERRIDE: override,
      });
      assert.equal(specMissingSection(spec, override), viaBash);
    });
  }

  it("names the first missing section", () => {
    assert.equal(specMissingSection({ ...base, what: "", acceptance: "" }), "What");
    assert.equal(specMissingSection(base), "");
  });
});

const PARITY_CASES = [
  ["web claimed, web changed", "web", "", ["apps/web/src/a.ts"], "C"],
  ["web claimed, nothing under apps/web", "web", "", ["scripts/x.mjs"], "C"],
  [
    "all three claimed, desktop missing",
    "desktop,mobile,web",
    "",
    ["apps/web/a", "apps/mobile/b"],
    "D",
  ],
  [
    "all three claimed and changed",
    "desktop,mobile,web",
    "",
    ["apps/web/a", "apps/mobile/b", "apps/desktop/c"],
    "D",
  ],
  ["infra-only, scripts only", "", "infra-only", ["scripts/x.mjs", "docs/y.md"], "D"],
  ["infra-only touching apps", "", "infra-only", ["apps/web/x.ts"], "D"],
  ["infra-only touching shared", "", "infra-only", ["packages/shared/src/x.ts"], "D"],
  ["single-platform override", "web,mobile", "web-only", ["apps/web/x"], "D"],
  ["no claims (release call)", "", "", ["apps/mobile/x"], "D"],
  ["phase B with mobile files", "web", "", ["apps/web/a", "apps/mobile/b"], "B"],
  ["phase B, web only", "web", "", ["apps/web/a"], "B"],
];

describe("parityViolation matches parity_violation", () => {
  for (const [name, platforms, override, files, phase] of PARITY_CASES) {
    it(name, () => {
      const viaBash = bash(
        ["parity_violation"],
        `PHASE="$P"; parity_violation "$PLATS" "$OVERRIDE" "$FILES"`,
        { P: phase, PLATS: platforms, OVERRIDE: override, FILES: files.join("\n") },
      );
      assert.equal(parityViolation({ platforms, override, files, phase }), viaBash);
    });
  }

  it("takes an array of platforms too", () => {
    assert.match(
      parityViolation({ platforms: ["mobile"], files: ["apps/web/x"] }),
      /claimed platform 'mobile' has no apps\/mobile changes/,
    );
  });
});

const MIGRATION_CASES = [
  ["no migrations", ["apps/web/x"], ""],
  ["migration without label", ["supabase/migrations/20261101000000_x.sql"], "status:in-review"],
  ["migration with label", ["supabase/migrations/20261101000000_x.sql"], "a,migration-approved"],
  ["config.toml is not a migration", ["supabase/config.toml"], ""],
];

describe("migrationViolation matches migration_violation", () => {
  for (const [name, files, labels] of MIGRATION_CASES) {
    it(name, () => {
      const viaBash = bash(["migration_violation"], `migration_violation "$FILES" "$LABELS"`, {
        FILES: files.join("\n"),
        LABELS: labels,
      });
      assert.equal(migrationViolation(files, labels), viaBash);
    });
  }
});

describe("statusLabelFor matches status_label_for and ALL_STATUS_LABELS", () => {
  const columns = [
    "Backlog",
    "Ready",
    "Planning",
    "Plan Review",
    "In Progress",
    "In Review",
    "Testing",
    "In Test",
    "Approved",
    "Released",
    "Done",
    "Blocked",
    "Nope",
  ];
  for (const col of columns) {
    it(col, () => {
      assert.equal(
        statusLabelFor(col),
        bash(["status_label_for"], `status_label_for "$C"`, { C: col }),
      );
    });
  }

  it("lists the same labels as the script's ALL_STATUS_LABELS", () => {
    const line = bash([], `grep -m1 '^ALL_STATUS_LABELS=' "${agentPath}" | cut -d'"' -f2`);
    assert.deepEqual([...ALL_STATUS_LABELS], line.split(","));
  });
});

describe("issue-gates CLI", () => {
  it("spec-missing reads the spec from stdin", () => {
    const out = runCli(["spec-missing", "--override", ""], () =>
      JSON.stringify({ ...base, what: "" }),
    );
    assert.equal(out, "What");
  });

  it("parity reads the file list from stdin", () => {
    const out = runCli(["parity", "--platforms", "web,mobile"], () => "apps/web/x\n");
    assert.equal(out, "claimed platform 'mobile' has no apps/mobile changes");
  });

  it("migration-label and status-label", () => {
    assert.equal(
      runCli(["migration-label", "--labels", ""], () => "supabase/migrations/1_x.sql\n"),
      "PR touches supabase/migrations/** without the migration-approved label",
    );
    assert.equal(runCli(["status-label", "In", "Test"]), "status:in-test");
  });

  it("rejects an unknown command", () => {
    assert.throws(() => runCli(["nope"]), /Usage/);
  });
});
