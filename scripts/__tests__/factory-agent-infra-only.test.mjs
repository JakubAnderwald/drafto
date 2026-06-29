import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Coverage for the parity:infra-only override — a change that touches no app
// platform (factory internals under scripts/, docs, CI). It must (a) let an
// empty-"Affected platforms" spec through the structural gate and (b) pass the
// parity post-check, while still blocking if the PR sneaks in apps/** edits.
// The two bash helpers are exercised behaviourally by extracting their real
// definitions from factory-agent.sh (same harness as factory-intest-iteration).

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

// Run a bash snippet that extracts a function definition from the real script
// (start of `name()` through its first column-0 `}`) and exercises it.
function withFn(fn, body) {
  const snippet = `
set -euo pipefail
eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
${body}
`;
  const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
  assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A fully-specced bundle .spec with NO platform boxes ticked.
const noPlatformSpec = JSON.stringify({
  what: "internal change",
  acceptance: "tests pass",
  affectedPlatforms: [],
  schemaChanges: false,
  ui: "",
  outOfScope: "nothing",
});

// Same, but with a platform ticked (the normal case).
const webSpec = JSON.stringify({
  what: "web change",
  acceptance: "tests pass",
  affectedPlatforms: ["web"],
  schemaChanges: false,
  ui: "",
  outOfScope: "nothing",
});

describe("spec_missing_section + parity:infra-only", () => {
  it("blocks an empty-platform spec with no override", () => {
    assert.equal(
      withFn("spec_missing_section", `spec_missing_section ${JSON.stringify(noPlatformSpec)} ""`),
      "Affected platforms",
    );
  });

  it("accepts an empty-platform spec when the override is infra-only", () => {
    assert.equal(
      withFn(
        "spec_missing_section",
        `spec_missing_section ${JSON.stringify(noPlatformSpec)} "infra-only"`,
      ),
      "",
    );
  });

  it("still accepts a normal spec with a platform ticked", () => {
    assert.equal(
      withFn("spec_missing_section", `spec_missing_section ${JSON.stringify(webSpec)} ""`),
      "",
    );
  });
});

describe("parity_violation + parity:infra-only", () => {
  it("passes when an infra-only PR touches only scripts/docs", () => {
    assert.equal(
      withFn(
        "parity_violation",
        `PHASE=C; parity_violation "" "infra-only" "scripts/factory-agent.sh
docs/features/dark-factory.md"`,
      ),
      "",
    );
  });

  it("blocks when an infra-only PR sneaks in apps/** changes", () => {
    assert.equal(
      withFn("parity_violation", `PHASE=C; parity_violation "" "infra-only" "apps/web/src/x.ts"`),
      "parity:infra-only but the PR changes app code (apps/ or packages/shared/)",
    );
  });

  it("blocks when an infra-only PR touches packages/shared (compiled into all platforms)", () => {
    assert.equal(
      withFn(
        "parity_violation",
        `PHASE=C; parity_violation "" "infra-only" "packages/shared/src/editor/markdown-converter.ts"`,
      ),
      "parity:infra-only but the PR changes app code (apps/ or packages/shared/)",
    );
  });

  it("leaves the existing single-platform override behaviour intact", () => {
    assert.equal(
      withFn("parity_violation", `PHASE=C; parity_violation "web" "web-only" "scripts/x.mjs"`),
      "",
    );
  });
});

describe("structural wiring", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("threads the parity override into the spec gate", () => {
    assert.match(script, /spec_missing_section "\$SPEC" "\$SPEC_PARITY_OVERRIDE"/);
  });
});
