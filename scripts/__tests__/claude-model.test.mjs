// ADR-0101: the node lanes (implement-lane.mjs, verify-lane.mjs) validate a
// --model value with claude-model.mjs's MODEL_RE; factory-agent.sh validates
// its model knobs with MODEL_KNOB_RE. The two must accept exactly the same
// values, or a model bash lets through would make a lane throw (or the
// reverse). Pinned here twice: the pattern text, and the verdicts of both
// engines (bash 3.2's ERE on the Mac mini, JS) over the same inputs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, MODEL_RE, isValidModel } from "../lib/claude-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(HERE, "..", "factory-agent.sh"), "utf8");

const SAMPLES = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "opus[1m]",
  "sonnet[1m]",
  "claude-sonnet-5-5",
  "claude-sonnet-5-5[1m]",
  "claude-opus-4-1-20250805",
  "",
  "--chrome",
  "opus --chrome",
  " opus",
  "Opus",
  "gpt-5",
  "claude-",
  "claude-x;rm",
  "claude-X",
  "opus[2m]",
  "opus[1m][1m]",
  "$(id)",
];

describe("claude-model.mjs MODEL_RE = factory-agent.sh MODEL_KNOB_RE", () => {
  const bashRe = script.match(/^MODEL_KNOB_RE='([^']*)'$/m);

  it("is the same pattern text", () => {
    assert.ok(bashRe, "MODEL_KNOB_RE not found in factory-agent.sh");
    assert.equal(MODEL_RE.source, bashRe[1]);
    assert.equal(MODEL_RE.flags, "", "no flags: case-sensitive, whole string");
  });

  it("gives the same verdict as bash on every sample", () => {
    // NUL-free samples, one per line; "sonnet\n" can't ride a line, so it is
    // checked on the JS side only, below.
    const r = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail\nMODEL_KNOB_RE='${bashRe[1]}'\n` +
          'while IFS= read -r m; do if [[ "$m" =~ $MODEL_KNOB_RE ]]; then echo 1; else echo 0; fi; done',
      ],
      { encoding: "utf8", input: `${SAMPLES.join("\n")}\n`, env: { PATH: process.env.PATH } },
    );
    assert.equal(r.status, 0, r.stderr);
    const bash = r.stdout.trim().split("\n");
    assert.equal(bash.length, SAMPLES.length);
    SAMPLES.forEach((m, i) => {
      assert.equal(MODEL_RE.test(m) ? "1" : "0", bash[i], JSON.stringify(m));
    });
  });

  it("refuses a trailing newline and non-strings; the default is valid", () => {
    assert.equal(isValidModel("sonnet\n"), false);
    for (const v of [undefined, null, 7, ["opus"]]) assert.equal(isValidModel(v), false);
    assert.equal(isValidModel(DEFAULT_MODEL), true);
    assert.match(script, /^FACTORY_MODEL="\$\{FACTORY_MODEL:-opus\[1m\]\}"/m);
    assert.equal(DEFAULT_MODEL, "opus[1m]");
  });
});
