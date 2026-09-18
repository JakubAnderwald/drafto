import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Guard for #511: nightly-audit.sh compares its "24 hours ago" cutoff as a
// string against GitHub's UTC createdAt/mergedAt. A local-time cutoff runs
// ahead of UTC on the Mac mini (CET/CEST) and silently drops the first 1–2
// hours of the window, so every `date` that builds YESTERDAY must pass -u.

const HERE = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(HERE, "..", "nightly-audit.sh"), "utf8");
const DAY_MS = 24 * 60 * 60 * 1000;

const yesterdayLines = script.split("\n").filter((line) => /^\s*YESTERDAY=/.test(line));

// A `date` command in command position: the start of a $( … ) body or after a
// ||, &&, | or ; separator. Captures its arguments up to the next separator.
const DATE_INVOCATION =
  /(?:\$\(|\|\||&&|[|;])\s*date(?![\w-])((?:\s+(?:'[^']*'|"[^"]*"|[^\s'"|;&)]+))*)/g;

function dateInvocations(line) {
  return [...line.matchAll(DATE_INVOCATION)].map(
    (m) => m[1].trim().match(/'[^']*'|"[^"]*"|\S+/g) ?? [],
  );
}

describe("nightly-audit YESTERDAY cutoff", () => {
  it("is assigned exactly once", () => {
    assert.equal(
      yesterdayLines.length,
      1,
      "expected exactly one YESTERDAY= assignment in nightly-audit.sh",
    );
  });

  it("passes -u to every date invocation", () => {
    const [line] = yesterdayLines;
    const invocations = dateInvocations(line);
    // Every whole-word `date` on the line must be one we parsed, so a `date` in
    // an unexpected position fails loudly instead of escaping the -u check.
    const bareDates = line.match(/(?<![\w$.-])date(?![\w-])/g) ?? [];
    assert.equal(
      invocations.length,
      bareDates.length,
      `could not parse every date invocation on: ${line}`,
    );
    assert.ok(
      invocations.length >= 2,
      `expected the macOS (-v) and GNU (-d) date branches, found ${invocations.length}`,
    );
    for (const args of invocations) {
      assert.ok(
        args.includes("-u"),
        `date ${args.join(" ")} must pass -u to compare against GitHub's UTC timestamps`,
      );
    }
  });

  it("evaluates to the UTC time 24h ago regardless of the local timezone", () => {
    const [line] = yesterdayLines;
    // POSIX TZ string (UTC+05:45, no DST) so the check needs no tzdata; a
    // local-time cutoff would land 5h45m away from the UTC one.
    const cutoff = execFileSync("bash", ["-c", `${line}\nprintf '%s' "$YESTERDAY"`], {
      env: { ...process.env, TZ: "XYZ-05:45" },
      encoding: "utf8",
    });
    assert.match(cutoff, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    const cutoffMs = Date.parse(`${cutoff}Z`);
    const drift = Math.abs(cutoffMs - (Date.now() - DAY_MS));
    assert.ok(drift < 60_000, `cutoff ${cutoff} is ${drift}ms away from UTC now-24h`);

    // jq's string >= against GitHub's Z-suffixed form keeps the boundary second.
    const github = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    assert.ok(github(cutoffMs) >= cutoff);
    assert.ok(github(cutoffMs + 1000) >= cutoff);
    assert.ok(!(github(cutoffMs - 1000) >= cutoff));
  });
});
