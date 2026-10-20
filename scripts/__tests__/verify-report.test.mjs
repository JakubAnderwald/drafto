import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMENT_MAX_CHARS,
  MANUAL_MAX,
  VERIFY_REPORT_MARKER,
  composeVerifyReport,
  parseLaneState,
  parseManualList,
  parseResultTable,
  parseShellOutput,
  readSecretValue,
  scanLaneText,
  verifyShaMarker,
} from "../lib/verify-report.mjs";

// The verification report is the only path from the Testing stage's lanes to
// a public GitHub comment. Its lanes run with the test password, the Vercel
// bypass secret and the dev service-role key within reach, so these tests lock
// in per-lane withholding and fail-closed scanning as much as the layout.

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "lib", "verify-report.mjs");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PASSWORD = "S3cret.pass*";
const BYPASS = "bypassSecret0123456789abcdefABCD";
// No pattern matches this value, so only the literal scan can find it.
const SERVICE_KEY = "svc-key-0123456789abcdefXYZ";
const SECRETS = { password: PASSWORD, bypass: BYPASS, signinKey: SERVICE_KEY };

function shellOutput({
  rows = ["| 1 | `pnpm --filter @drafto/web test notes` | PASS | 12 tests |"],
  summary = "**Summary:** 1 PASS, 0 FAIL.",
  assessment = "**Assessment:** The change does what the issue asked.",
  manual = "1. Open the notes list on iOS — expected: newest first.",
  status = "ok",
  verdict = "pass",
  extra = "",
} = {}) {
  return [
    "Working…",
    "<<<REPORT",
    "| # | Check | Result | Evidence |",
    "|---|---|---|---|",
    ...rows,
    "",
    summary,
    assessment,
    extra,
    "REPORT>>>",
    ...(manual == null ? [] : ["<<<MANUAL", manual, "MANUAL>>>"]),
    `shell=${status} verdict=${verdict}`,
    "",
  ].join("\n");
}

function browserOutput({
  rows = ["| 1 | Open /notebooks | PASS | the list shows |"],
  summary = "**Summary:** 1 PASS, 0 FAIL, 0 WARN, 0 SKIP.",
  status = "ok",
  verdict = "pass",
  extra = "",
} = {}) {
  return [
    "<<<REPORT",
    "Ran against the preview as qa@example.com.",
    "",
    "| # | Step | Result | Evidence |",
    "|---|---|---|---|",
    ...rows,
    "",
    summary,
    extra,
    "REPORT>>>",
    `browser=${status} verdict=${verdict}`,
    "",
  ].join("\n");
}

function scenario({ web = true, mobile = true, mac = true } = {}) {
  return [
    "🏭 **Ready to test — In Test.**",
    "",
    "## How to get a build",
    "",
    "### iOS",
    "A beta is building.",
    "",
    "## Test scenario",
    "",
    ...(web ? ["### Web", "", "1. Open /notebooks — expected: the list.", ""] : []),
    ...(mobile ? ["### iOS / Android", "", "1. Tap — expected: it works.", ""] : []),
    ...(mac ? ["### macOS", "", "1. Click — expected: it opens.", ""] : []),
    "<!-- drafto-factory-in-test -->",
    "<!-- drafto-factory-test-scenario -->",
    `<!-- drafto-factory-scenario-sha:${SHA} -->`,
  ].join("\n");
}

function compose(overrides = {}) {
  return composeVerifyReport({
    issue: 465,
    pr: 701,
    sha: SHA,
    platforms: { web: true, mobile: true, desktop: true },
    betaLanes: "mobile,desktop",
    scenario: scenario(),
    shell: { state: "reported:pass", dir: "/ev/shell", text: shellOutput() },
    browser: { state: "reported:pass", dir: "/ev/browser", text: browserOutput() },
    gaps: [],
    crNote: "",
    secrets: SECRETS,
    ...overrides,
  });
}

// The numbered lines under "Steps for you to do manually".
function manualLines(body) {
  // The headline can say "see **Coverage gaps**", so split on the section's own line.
  const section = body
    .split("\n**Steps for you to do manually**\n")[1]
    .split("\n**Coverage gaps**\n")[0];
  return section
    .split("\n")
    .filter((l) => /^\d+\. /.test(l))
    .map((l) => l.replace(/^\d+\. /, ""));
}

function gapsSection(body) {
  return body.split("\n**Coverage gaps**\n")[1].split("<details>")[0].split("<sub>")[0];
}

function tableRow(body, label) {
  return body.split("\n").find((l) => l.startsWith(`| ${label} |`));
}

describe("verdict merge", () => {
  it("is the worst verdict among the lanes that reported", () => {
    assert.equal(compose().verdict, "pass");
    const fail = compose({
      browser: { state: "reported:fail", text: browserOutput({ verdict: "fail" }) },
    });
    assert.equal(fail.verdict, "fail");
    assert.match(fail.body, /\*\*Verdict: FAIL\*\* for `0123456789ab` \(PR #701\)\./);
    const warn = compose({
      shell: { state: "reported:warn", text: shellOutput({ verdict: "warn" }) },
    });
    assert.equal(warn.verdict, "warn");
  });

  it("leads with the header, headline and the evidence-not-a-gate line", () => {
    const lines = compose().body.split("\n");
    assert.equal(lines[0], "🏭 **Verification before In Test**");
    assert.equal(lines[2], "**Verdict: PASS** for `0123456789ab` (PR #701).");
    assert.equal(lines[4], "Evidence, not a gate: the card is now In Test.");
  });

  it("counts a blocked lane as at least warn", () => {
    const r = compose({
      shell: { state: "reported:none", text: shellOutput({ status: "blocked", verdict: "none" }) },
    });
    assert.equal(r.verdict, "warn");
    assert.match(tableRow(r.body, "Repo & API (shell)"), /\| stopped \(blocked\) \| WARN \|/);
    const worse = compose({
      browser: {
        state: "reported:fail",
        text: browserOutput({ status: "blocked", verdict: "fail" }),
      },
    });
    assert.equal(worse.verdict, "fail");
  });

  it("is INCOMPLETE when no lane reported a verdict", () => {
    const r = compose({
      shell: { state: "timeout", dir: "", text: null },
      browser: { state: "none", dir: "", text: null },
    });
    assert.equal(r.verdict, "incomplete");
    assert.match(
      r.body,
      /\*\*Verdict: INCOMPLETE\*\* for `0123456789ab` \(PR #701\): no verification lane reported a result\./,
    );
    assert.match(r.body, /_No lane reported a result\._/);
    const noneOnly = compose({
      shell: { state: "reported:none", text: shellOutput({ verdict: "none" }) },
      browser: { state: "none", text: null },
    });
    assert.equal(noneOnly.verdict, "incomplete");
  });

  it("does not count a browser run that couldn't sign in or reach Chrome", () => {
    for (const status of ["signin-failed", "auth-expired", "unavailable"]) {
      const r = compose({
        shell: { state: "none", text: null },
        browser: { state: "reported:none", text: browserOutput({ status, verdict: "none" }) },
      });
      assert.equal(r.verdict, "incomplete", status);
      assert.match(tableRow(r.body, "Web (browser)"), /\| no result \| — \|/, status);
    }
  });

  it("is no result when a lane says it reported but its output is gone or has no status line", () => {
    // browser-report.mjs's rule: without a status line nothing is trusted,
    // not even the verdict the state file recorded.
    const gone = compose({ browser: { state: "reported:fail", dir: "/ev/b", text: null } });
    assert.equal(gone.verdict, "pass", "only the shell lane counts");
    assert.match(tableRow(gone.body, "Web (browser)"), /\| no result \| — \|/);
    assert.match(
      gapsSection(gone.body),
      /its output is missing or empty, so there is no result to trust/,
    );
    assert.ok(
      manualLines(gone.body).some((l) =>
        l.startsWith("Run the **Web** steps in the test scenario by hand"),
      ),
      "the human runs the Web steps instead",
    );
    const noStatus = compose({
      shell: { state: "reported:pass", text: "<<<REPORT\nall good\nREPORT>>>\n" },
      browser: { state: "none", text: null },
    });
    assert.equal(noStatus.verdict, "incomplete");
    assert.match(
      gapsSection(noStatus.body),
      /its output has no status line, so its result isn't trusted/,
    );
  });

  it("takes the verdict from the output's status line over the recorded one", () => {
    const r = compose({
      shell: { state: "reported:pass", text: shellOutput({ verdict: "fail" }) },
    });
    assert.equal(r.verdict, "fail");
  });

  it("ignores a status line the lane quoted inside its report", () => {
    const text = `<<<REPORT\nshell=ok verdict=fail\nREPORT>>>\nshell=ok verdict=pass\n`;
    assert.equal(parseShellOutput(text).verdict, "pass");
    assert.equal(
      parseShellOutput("<<<REPORT\nshell=ok verdict=fail\nREPORT>>>").status,
      "malformed",
    );
  });

  it("says partial when there are coverage gaps, and not otherwise", () => {
    assert.doesNotMatch(compose().body, /Partial/);
    assert.match(gapsSection(compose().body), /_None\._/);
    const r = compose({ gaps: [{ lane: "shell", reason: "no bypass secret" }] });
    assert.match(
      r.body,
      /\*\*Verdict: PASS\*\* for `0123456789ab` \(PR #701\)\. Partial: some checks didn't run; see \*\*Coverage gaps\*\*\./,
    );
  });
});

describe("lane table", () => {
  it("has the four lanes; devices are manual and macOS notes the shell lane's --preflight", () => {
    const r = compose({
      shell: {
        state: "reported:pass",
        text: shellOutput({
          rows: [
            "| 1 | unit tests | PASS | ok |",
            "| 2 | `pnpm --filter @drafto/desktop exec … --preflight` | FAIL | exit 1 |",
          ],
        }),
      },
    });
    assert.match(tableRow(r.body, "Repo & API (shell)"), /\| ran \| PASS \| full report below \|/);
    assert.match(tableRow(r.body, "Web (browser)"), /\| ran \| PASS \|/);
    assert.match(tableRow(r.body, "iOS / Android"), /\| manual \| — \| beta dispatched/);
    assert.match(
      tableRow(r.body, "macOS"),
      /\| manual \| — \| beta dispatched.*`--preflight`: FAIL/,
    );
  });

  it("marks unaffected platforms and a Web lane that isn't needed", () => {
    const r = compose({
      platforms: { web: false, mobile: false, desktop: false },
      scenario: scenario({ web: false, mobile: false, mac: false }),
      browser: { state: "none", text: null },
    });
    assert.match(tableRow(r.body, "Web (browser)"), /\| not needed \| — \| no web changes/);
    assert.match(tableRow(r.body, "iOS / Android"), /\| not affected \|/);
    assert.match(tableRow(r.body, "macOS"), /\| not affected \|/);
    assert.doesNotMatch(gapsSection(r.body), /Web \(browser\)/);
  });

  it("escapes pipes in a note so the row keeps its shape", () => {
    const r = compose({ browser: { state: "unavailable:a|b", text: null } });
    assert.equal(tableRow(r.body, "Web (browser)").split(/(?<!\\)\|/).length, 6);
  });
});

describe("assessment", () => {
  it("has each reported lane's summary and the shell lane's assessment", () => {
    const r = compose({
      shell: {
        state: "reported:pass",
        text: shellOutput({
          assessment: "**Assessment:** Looks right.\n\nThe mobile list is the remaining risk.",
        }),
      },
      browser: {
        state: "reported:fail",
        text: browserOutput({
          verdict: "fail",
          summary: "**Summary:** 0 PASS, 1 FAIL.\n- **Step 1:** the list is empty.",
        }),
      },
    });
    assert.match(r.body, /- \*\*Repo & API:\*\* 1 PASS, 0 FAIL\./);
    assert.match(
      r.body,
      /- \*\*Web:\*\* 0 PASS, 1 FAIL\.\n {2}- \*\*Step 1:\*\* the list is empty\./,
    );
    assert.match(
      r.body,
      /\*\*Repo & API assessment:\*\*\n\nLooks right\.\n\nThe mobile list is the remaining risk\./,
    );
  });

  it("caps a runaway summary", () => {
    const r = compose({
      browser: {
        state: "reported:pass",
        text: browserOutput({ summary: `**Summary:** ${"x".repeat(5000)}` }),
      },
    });
    const line = r.body.split("\n").find((l) => l.startsWith("- **Web:**"));
    assert.ok(line.length < 700, `length ${line.length}`);
    assert.ok(line.endsWith("…"));
  });
});

describe("manual steps", () => {
  it("lists MANUAL items, browser FAIL and SKIP rows, then one line per non-Web scenario section", () => {
    const r = compose({
      shell: {
        state: "reported:pass",
        text: shellOutput({
          manual: "1. Check the iOS list — expected: newest first.\n2. Sign out — expected: login.",
        }),
      },
      browser: {
        state: "reported:fail",
        text: browserOutput({
          verdict: "fail",
          rows: [
            "| 1 | Open /notebooks | PASS | ok |",
            "| 2 | Create a note | **FAIL** | the button is missing |",
            "| 3 | Drag to reorder | SKIPPED | needs a real drag |",
            "| 4 | Rename | WARN | slow |",
          ],
        }),
      },
      betaLanes: "mobile",
    });
    assert.deepEqual(manualLines(r.body), [
      "Check the iOS list — expected: newest first.",
      "Sign out — expected: login.",
      "Re-check by hand — Web step 2, which the browser marked **FAIL**: Create a note (the browser saw: the button is missing)",
      "Re-check by hand — Web step 3, which the browser marked **SKIP**: Drag to reorder",
      "Run the **iOS / Android** steps in the test scenario on the iOS / Android beta for this commit (a follow-up comment gives the build number).",
      "Run the **macOS** steps in the test scenario on a build of this branch (no beta was dispatched; the scenario says how to get one).",
    ]);
  });

  it("adds 'run the Web steps by hand' when the browser lane didn't report", () => {
    const r = compose({ browser: { state: "timeout", dir: "", text: null } });
    assert.ok(
      manualLines(r.body).includes(
        "Run the **Web** steps in the test scenario by hand on the preview: the browser lane didn't report (timed out before it reported).",
      ),
    );
    const blocked = compose({
      browser: {
        state: "reported:none",
        text: browserOutput({ status: "blocked", verdict: "none" }),
      },
    });
    assert.ok(
      manualLines(blocked.body).some((l) => /browser lane stopped early \(blocked\)/.test(l)),
    );
    assert.ok(!manualLines(compose().body).some((l) => /\*\*Web\*\* steps/.test(l)));
  });

  it("asks for a web check when the browser lane didn't report and the scenario has no Web section", () => {
    const r = compose({
      scenario: scenario({ web: false }),
      browser: { state: "skipped:no-web-steps", text: null },
    });
    assert.ok(
      manualLines(r.body).some((l) =>
        l.startsWith(
          "Check the web changes by hand on the preview: the browser lane didn't report (skipped: the scenario has no Web steps)",
        ),
      ),
    );
  });

  it("deduplicates items, ignoring case, emphasis and trailing dots", () => {
    const r = compose({
      shell: {
        state: "reported:pass",
        text: shellOutput({
          manual:
            "1. Open **Settings** — expected: it loads.\n2. open settings — expected: it loads\n3. Other.",
        }),
      },
      platforms: { web: true, mobile: false, desktop: false },
      scenario: scenario({ mobile: false, mac: false }),
    });
    assert.deepEqual(manualLines(r.body), ["Open **Settings** — expected: it loads.", "Other."]);
  });

  it(`caps the list at ${MANUAL_MAX}, never cutting the scenario and Web lines`, () => {
    const manual = Array.from({ length: 40 }, (_, i) => `${i + 1}. Step number ${i + 1}.`).join(
      "\n",
    );
    const r = compose({
      shell: { state: "reported:pass", text: shellOutput({ manual }) },
      browser: { state: "timeout", text: null },
    });
    const lines = manualLines(r.body);
    assert.equal(lines.length, MANUAL_MAX);
    // 3 reserved: iOS / Android, macOS and the Web line.
    assert.equal(lines.filter((l) => /^Step number/.test(l)).length, MANUAL_MAX - 3);
    assert.ok(lines.some((l) => /\*\*iOS \/ Android\*\*/.test(l)));
    assert.ok(lines.some((l) => /\*\*macOS\*\*/.test(l)));
    assert.ok(lines.some((l) => /\*\*Web\*\* steps/.test(l)));
    assert.match(r.body, /_…and 18 more; see the lane reports below\._/);
  });

  it("keeps a step's continuation lines and fenced commands under it", () => {
    const manual = [
      "1. Run the export:",
      "      ```bash",
      "      pnpm export --all",
      "      ```",
      "   Expected: a file appears.",
      "2. Done.",
    ].join("\n");
    const r = compose({
      shell: { state: "reported:pass", text: shellOutput({ manual }) },
      scenario: scenario({ mobile: false, mac: false }),
    });
    assert.match(
      r.body,
      /1\. Run the export:\n {6}```bash\n {6}pnpm export --all\n {6}```\n {3}Expected: a file appears\.\n2\. Done\./,
    );
  });

  it("says there is nothing to do when nothing is left", () => {
    const r = compose({
      platforms: { web: true, mobile: false, desktop: false },
      shell: { state: "reported:pass", text: shellOutput({ manual: null }) },
      scenario: scenario({ mobile: false, mac: false }),
    });
    assert.match(r.body, /_Nothing beyond the lane reports\._/);
  });
});

describe("parsers", () => {
  it("parseManualList splits on top-level markers only, outside fences", () => {
    assert.deepEqual(
      parseManualList("Intro line.\n1) First\n   - nested\n2. Second\n```\n3. not an item\n```"),
      [
        { first: "Intro line.", rest: [] },
        { first: "First", rest: ["   - nested"] },
        { first: "Second", rest: ["```", "3. not an item", "```"] },
      ],
    );
    assert.deepEqual(parseManualList(""), []);
  });

  it("parseResultTable reads rows of tables that have a Result column", () => {
    const md = [
      "| Name | Value |",
      "|---|---|",
      "| x | FAIL |",
      "",
      "| # | Step | **Result** | Evidence |",
      "|:-:|---|---|---|",
      "| 1 | A \\| B | ✅ PASSED | ok |",
      "| 2 | C | Failed — 500 | log |",
      "| 3 | D | n/a | |",
    ].join("\n");
    assert.deepEqual(parseResultTable(md), [
      { num: "1", step: "A \\| B", result: "PASS", evidence: "ok" },
      { num: "2", step: "C", result: "FAIL", evidence: "log" },
      { num: "3", step: "D", result: null, evidence: "" },
    ]);
  });

  it("parseLaneState splits kind and detail", () => {
    assert.deepEqual(parseLaneState("reported:pass"), { kind: "reported", detail: "pass" });
    assert.deepEqual(parseLaneState("unavailable:auth-expired"), {
      kind: "unavailable",
      detail: "auth-expired",
    });
    assert.deepEqual(parseLaneState(""), { kind: "none", detail: "" });
    assert.deepEqual(parseLaneState(undefined), { kind: "none", detail: "" });
  });
});

describe("coverage gaps", () => {
  it("lists --gaps, every lane that didn't report, then the CodeRabbit note", () => {
    const cases = {
      timeout: "timed out before it reported",
      "unavailable:chrome":
        "unavailable: this Mac mini's Chrome wasn't connected to Claude in Chrome",
      "stale-branch": "the PR branch predates the preview sign-in route",
      "no-preview": "no Vercel preview was ready for this commit",
      "skipped:memory": "skipped: deferred under memory pressure",
      "skipped:some-new-reason": "skipped: some-new-reason",
      none: "didn't run",
      weird: "unrecognised state `weird`",
      constructor: "unrecognised state `constructor`",
    };
    for (const [state, text] of Object.entries(cases)) {
      const r = compose({ browser: { state, text: null } });
      assert.ok(gapsSection(r.body).includes(`- **Web (browser):** ${text}`), state);
    }
    const r = compose({
      shell: { state: "timeout", text: null },
      gaps: [
        { lane: "betas", reason: "desktop beta not dispatched" },
        "bare reason",
        { lane: "x" },
      ],
      crNote: "CodeRabbit did not review 0123456789ab (rate limited)",
    });
    const lines = gapsSection(r.body).trim().split("\n");
    assert.deepEqual(lines, [
      "- **betas:** desktop beta not dispatched",
      "- bare reason",
      "- **Repo & API (shell):** timed out before it reported.",
      "- ℹ️ CodeRabbit did not review 0123456789ab (rate limited)",
    ]);
  });

  it("notes a missing scenario", () => {
    const r = compose({ scenario: null });
    assert.match(gapsSection(r.body), /\*\*Test scenario:\*\* none was available for this commit/);
  });

  it("says partial for a shell lane that ran only part of its checks", () => {
    const r = compose({
      shell: { state: "reported:pass", text: shellOutput({ status: "partial" }) },
    });
    assert.match(tableRow(r.body, "Repo & API (shell)"), /\| ran \(partial\) \| PASS \|/);
    assert.match(gapsSection(r.body), /ran only part of its checks/);
    assert.match(r.body, /Partial: some checks didn't run/);
  });
});

describe("secrets", () => {
  it("scanLaneText names each kind of hit, never the match", () => {
    assert.deepEqual(scanLaneText("all clear", SECRETS), []);
    assert.deepEqual(scanLaneText(`typed ${PASSWORD}`, SECRETS), ["password"]);
    assert.deepEqual(scanLaneText(`h: ${BYPASS}`, SECRETS), ["bypass-secret"]);
    assert.deepEqual(scanLaneText(`k=${SERVICE_KEY}`, SECRETS), ["service-role-key"]);
    assert.deepEqual(scanLaneText("-H x-vercel-protection-bypass: …", SECRETS), ["bypass-header"]);
    assert.deepEqual(scanLaneText("X-Vercel-Set-Bypass-Cookie: true", SECRETS), [
      "bypass-cookie-header",
    ]);
    assert.deepEqual(scanLaneText("cookie _vercel_jwt=…", SECRETS), ["vercel-cookie"]);
    assert.deepEqual(
      scanLaneText(`q=${encodeURIComponent(`${BYPASS}/+`)}`, { bypass: `${BYPASS}/+` }),
      ["bypass-secret"],
    );
    assert.deepEqual(scanLaneText("short", { bypass: "short" }), [], "too short to scan");
    assert.deepEqual(scanLaneText("key sb_secret_AbC123xyz789", {}), ["supabase-secret-key"]);
    assert.deepEqual(scanLaneText("sntrys_eyJpYXQiOjE3MDAwMDAwMDB9abc", {}), ["sentry-token"]);
    assert.deepEqual(scanLaneText("ghp_0123456789abcdefghijABCDEFGHIJ", {}), ["github-token"]);
    assert.deepEqual(scanLaneText("E2E_TEST_PASSWORD=hunter2hunter", {}), ["env-secret"]);
    assert.deepEqual(scanLaneText("export SENTRY_AUTH_TOKEN='abcdef123456'", {}), ["env-secret"]);
    // Names alone, empty or $-referenced values are not secrets.
    assert.deepEqual(scanLaneText("set FACTORY_BROWSER_PASSWORD= in the file", {}), []);
    assert.deepEqual(scanLaneText('E2E_TEST_PASSWORD="$E2E_TEST_PASSWORD"', {}), []);
    assert.deepEqual(scanLaneText("FACTORY_INTEST_BETA_DESKTOP=0123456", {}), []);
  });

  const leaks = {
    password: `typed ${PASSWORD} into the form`,
    "bypass-secret": `sent the header value ${BYPASS}`,
    "service-role-key": `key was ${SERVICE_KEY}`,
    "bypass-header": "curl -H 'x-vercel-protection-bypass: …'",
    jwt: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw",
  };

  for (const [name, leak] of Object.entries(leaks)) {
    it(`withholds only the shell lane when its text matches ${name}`, () => {
      const r = compose({
        shell: { state: "reported:pass", dir: "/ev/shell", text: shellOutput({ extra: leak }) },
      });
      assert.deepEqual(r.withheld, { shell: true, browser: false });
      assert.deepEqual(r.secretHits, [`shell:${name}`]);
      assert.ok(!r.body.includes(leak), "the leak is not posted");
      assert.ok(!r.body.includes("12 tests"), "nothing else from the lane either");
      assert.ok(!r.body.includes("newest first"), "not even its manual steps");
      assert.ok(
        r.body.includes(
          `Withheld: matched ${name}. The local copy is at \`/ev/shell/shell-output.txt\`.`,
        ),
      );
      assert.match(
        tableRow(r.body, "Repo & API (shell)"),
        new RegExp(`report withheld \\(matched ${name}\\)`),
      );
      assert.ok(
        manualLines(r.body).includes(
          "Read the Repo & API lane's local report (`/ev/shell/shell-output.txt`) for its manual steps: its text was withheld from this comment.",
        ),
      );
      // The verdict comes from the status line, which can't carry a secret.
      assert.equal(r.verdict, "pass");
      // The other lane is untouched.
      assert.match(r.body, /the list shows/);
    });

    it(`withholds only the browser lane when its text matches ${name}`, () => {
      const r = compose({
        browser: {
          state: "reported:pass",
          dir: "/ev/browser",
          text: browserOutput({ extra: leak }),
        },
      });
      assert.deepEqual(r.withheld, { shell: false, browser: true });
      assert.deepEqual(r.secretHits, [`browser:${name}`]);
      assert.ok(!r.body.includes(leak));
      assert.ok(!r.body.includes("the list shows"));
      assert.ok(r.body.includes(`Withheld: matched ${name}.`));
      assert.match(r.body, /12 tests/);
    });
  }

  it("fails closed: an unreadable bypass or sign-in key file withholds the shell lane only", () => {
    for (const [key, hit] of [
      ["bypass", "shell:bypass-file-unreadable"],
      ["signinKey", "shell:signin-key-file-unreadable"],
    ]) {
      const r = compose({ secrets: { ...SECRETS, [key]: null } });
      assert.deepEqual(r.withheld, { shell: true, browser: false }, key);
      assert.deepEqual(r.secretHits, [hit], key);
      assert.ok(!r.body.includes("12 tests"), key);
      assert.match(r.body, /the list shows/, key);
      assert.match(
        r.body,
        /couldn't read the (bypass secret|sign-in key) file, so the secret scan can't be trusted/,
      );
    }
  });

  it("fails closed: an unreadable account file withholds both lanes", () => {
    const r = compose({ secrets: { ...SECRETS, password: null } });
    assert.deepEqual(r.withheld, { shell: true, browser: true });
    assert.deepEqual(r.secretHits, [
      "shell:account-file-unreadable",
      "browser:account-file-unreadable",
    ]);
    assert.ok(!r.body.includes("12 tests"));
    assert.ok(!r.body.includes("the list shows"));
    assert.equal(r.verdict, "pass");
  });

  it('takes "" as "the lanes never had this secret": nothing to scan for, nothing withheld', () => {
    const r = compose({ secrets: { password: PASSWORD, bypass: "", signinKey: "" } });
    assert.deepEqual(r.withheld, { shell: false, browser: false });
    assert.deepEqual(r.secretHits, []);
    const absent = compose({ secrets: { password: PASSWORD } });
    assert.deepEqual(absent.withheld, { shell: true, browser: false }, "absent fails closed");
  });

  it("withholds nothing for a lane that printed nothing", () => {
    const r = compose({
      secrets: {},
      shell: { state: "timeout", text: null },
      browser: { state: "none", text: "  \n" },
    });
    assert.deepEqual(r.withheld, { shell: false, browser: false });
    assert.deepEqual(r.secretHits, []);
  });

  it("replaces the whole body when the composed text still matches (a gap reason, the CR note)", () => {
    const r = compose({ gaps: [{ lane: "shell", reason: `curl failed with ${BYPASS}` }] });
    assert.ok(r.secretHits.includes("body:bypass-secret"));
    assert.ok(!r.body.includes(BYPASS));
    assert.match(
      r.body,
      /The rest of this report was withheld: the composed comment matched a secret pattern \(bypass-secret\)\./,
    );
    assert.deepEqual(r.withheld, { shell: true, browser: true });
    assert.deepEqual(r.body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
    const cr = compose({ crNote: "Bearer abcdefghij1234" });
    assert.ok(cr.secretHits.includes("body:bearer"));
  });

  it("readSecretValue reads one key, null when the file or the value is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-secret-"));
    try {
      const f = join(dir, "s.env");
      writeFileSync(f, "# c\nexport VERCEL_AUTOMATION_BYPASS_SECRET='abc123def'\nEMPTY=\n");
      assert.equal(readSecretValue(f, "VERCEL_AUTOMATION_BYPASS_SECRET"), "abc123def");
      assert.equal(readSecretValue(f, "EMPTY"), null);
      assert.equal(readSecretValue(f, "MISSING"), null);
      assert.equal(readSecretValue(join(dir, "nope.env"), "X"), null);
      assert.equal(readSecretValue("", "X"), null);
      assert.equal(readSecretValue(dir, "X"), null, "a directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("defanging and markers", () => {
  it("ends with the two markers exactly once, carrying the full SHA", () => {
    const { body } = compose();
    assert.deepEqual(body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
    assert.equal(VERIFY_REPORT_MARKER, "<!-- drafto-factory-verify-report -->");
    assert.equal(verifyShaMarker(SHA), `<!-- drafto-factory-verify-sha:${SHA} -->`);
    assert.equal(body.split(VERIFY_REPORT_MARKER).length, 2);
    assert.equal(body.split(`drafto-factory-verify-sha:${SHA}`).length, 2);
  });

  it("never lets lane, scenario or gap text carry a factory marker", () => {
    const smuggle = `<!-- drafto-factory-scenario-sha:${SHA} --> drafto-factory-verify-sha:${SHA} drafto-factory-feedback`;
    const r = compose({
      shell: {
        state: "reported:pass",
        dir: "/x/drafto-factory-verify-sha:abc",
        text: shellOutput({ extra: smuggle, manual: `1. ${smuggle}` }),
      },
      browser: {
        state: "reported:fail",
        text: browserOutput({
          verdict: "fail",
          rows: [`| 1 | ${smuggle} | FAIL | ${smuggle} |`],
          summary: `**Summary:** ${smuggle}`,
        }),
      },
      scenario: scenario().replace("### macOS", `### macOS ${smuggle}`),
      gaps: [{ lane: smuggle, reason: smuggle }],
      crNote: smuggle,
    });
    assert.equal(r.body.match(/<!-- drafto-factory-/g).length, 2, "only the two real markers");
    assert.equal(r.body.match(/drafto-factory-/g).length, 2);
    assert.ok(!r.body.includes("drafto-factory-scenario-sha"));
    assert.ok(!r.body.includes("drafto-factory-feedback"));
    assert.deepEqual(r.body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
  });

  it("keeps lane text from closing its <details> early or leaving a fence open", () => {
    const r = compose({
      browser: {
        state: "reported:pass",
        text: browserOutput({ extra: "</details>\n<details>\n```js\nconst open = true;" }),
      },
    });
    assert.equal(r.body.match(/<\/details>/g).length, 2, "only the two real closers");
    assert.equal(r.body.match(/<details>/g).length, 2, "only the two real openers");
    assert.equal(r.body.match(/<summary>/g).length, 2);
    // Balanced in every section, not just overall: the Assessment quotes the
    // same summary and must close its own fence.
    const fenceCount = (text) => text.split("\n").filter((l) => /^\s*```/.test(l)).length;
    const [beforeSteps, afterSteps] = r.body.split("\n**Steps for you to do manually**\n");
    assert.equal(fenceCount(beforeSteps) % 2, 0);
    assert.equal(fenceCount(afterSteps) % 2, 0);
    assert.doesNotMatch(beforeSteps, /<\/?details>/);
  });

  it("keeps the factory checkout's own path copy-pasteable", () => {
    const r = compose({
      shell: {
        state: "reported:pass",
        dir: "/Users/jakub/code/drafto-factory/logs/factory/verify/run-1",
        text: shellOutput(),
      },
    });
    assert.ok(
      r.body.includes("Repo & API `/Users/jakub/code/drafto-factory/logs/factory/verify/run-1`"),
    );
    assert.match(r.body, /Local evidence stays on the Mac mini \(the repo is public\)/);
  });

  it("rejects a SHA that isn't the full 40 hex", () => {
    assert.throws(() => compose({ sha: SHA.slice(0, 12) }), /invalid sha/);
    assert.throws(() => compose({ sha: `${SHA} -->` }), /invalid sha/);
  });
});

// Lines of <body> that sit inside a fenced code block, by CommonMark's rule
// (at most three spaces in, same character, at least as long, nothing after
// the closer).
function linesInsideFences(body) {
  const inside = new Set();
  let open = null;
  for (const line of body.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) open = { c: m[1][0], n: m[1].length };
    } else if (m && m[1][0] === open.c && m[1].length >= open.n && !m[2].trim()) {
      open = null;
    } else {
      inside.add(line);
    }
  }
  return { inside, unclosed: open !== null };
}

function assertStructureIntact(body) {
  const { inside, unclosed } = linesInsideFences(body);
  assert.equal(unclosed, false, "no fence left open");
  for (const line of [
    "**Assessment**",
    "**Steps for you to do manually**",
    "**Coverage gaps**",
    "<details>",
    "</details>",
    VERIFY_REPORT_MARKER,
    verifyShaMarker(SHA),
  ]) {
    assert.ok(!inside.has(line), `${line} is inside a code block`);
  }
}

describe("rendering stays intact around lane fences", () => {
  it("a Summary or Assessment that opens with a fence", () => {
    const r = compose({
      shell: {
        state: "reported:pass",
        text: shellOutput({
          summary: "**Summary:**\n```\n3 passed\n```",
          assessment: "**Assessment:**\n```\nsome output\n```\nLooks right.",
        }),
      },
    });
    assertStructureIntact(r.body);
    assert.match(r.body, /- \*\*Repo & API:\*\*\n {2}```\n {2}3 passed\n {2}```/);
    assert.match(r.body, /\*\*Repo & API assessment:\*\*\n\n```\nsome output\n```\nLooks right\./);
  });

  it("a manual step whose fenced block is cut by the line or size cap", () => {
    const long = Array.from({ length: 40 }, (_, i) => `   echo line ${i}`);
    const manual = ["1. Run this:", "   ```bash", ...long, "   ```", "2. Second step."].join("\n");
    const huge = ["1. Paste:", "   ~~~~text", `   ${"x".repeat(5000)}`, "   ~~~~", "2. Third."];
    for (const m of [manual, huge.join("\n")]) {
      const r = compose({ shell: { state: "reported:pass", text: shellOutput({ manual: m }) } });
      assertStructureIntact(r.body);
      const lines = manualLines(r.body);
      assert.ok(
        lines.some((l) => l === "Second step." || l === "Third."),
        "the next step is still a list item",
      );
    }
  });

  it("a ~~~ fence left open is closed with tildes, and a ``` inside it doesn't count", () => {
    const r = compose({
      shell: {
        state: "reported:pass",
        text: shellOutput({
          extra: "~~~\n```\n~~~\n~~~~md\nunclosed",
          manual: "1. a\n   ~~~md\n   open",
        }),
      },
    });
    assertStructureIntact(r.body);
  });

  it("a fence-like line four spaces in is text, so no closer is added for it", () => {
    // GitHub reads it as indented code; a column-0 closer would open a real
    // fence and swallow the rest of the comment.
    const r = compose({
      shell: {
        state: "reported:pass",
        text: shellOutput({ extra: "Raw output:\n\n    ```\n    still text\n\n    ~~~~md" }),
      },
    });
    assertStructureIntact(r.body);
    assert.match(r.body, /\n {4}still text\n/);
    const lines = r.body.split("\n");
    assert.ok(!lines.includes("```") && !lines.includes("~~~~"), "no closer was added");
  });

  it("a manual step whose first line is a fence reads as text", () => {
    const r = compose({
      shell: { state: "reported:pass", text: shellOutput({ manual: "```bash\npnpm test\n```" }) },
    });
    assertStructureIntact(r.body);
    assert.match(r.body, /\n1\. ​```bash\n/);
  });

  it("a truncated `<detailsx` can't become a real tag", () => {
    const filler = "<detailsx>\n".repeat(20_000);
    const r = compose({
      shell: { state: "reported:pass", dir: "/ev/shell", text: shellOutput({ extra: filler }) },
      browser: { state: "reported:pass", dir: "/ev/b", text: browserOutput({ extra: filler }) },
    });
    assert.ok(r.body.length <= COMMENT_MAX_CHARS);
    assert.equal(r.body.match(/<details/g).length, 2, "only the two real openers");
    assertStructureIntact(r.body);
  });
});

describe("scenario sections and platforms", () => {
  it("takes the Web section from the scenario part only, not a fence or the build notes", () => {
    const body = [
      "## How to get a build",
      "### Web",
      "Open the preview.",
      "## Test scenario",
      "### iOS",
      "1. Quote this:",
      "   ```md",
      "### Web",
      "   ```",
    ].join("\n");
    const r = compose({
      platforms: { web: false, mobile: true, desktop: false },
      scenario: body,
      browser: { state: "none", text: null },
    });
    assert.match(tableRow(r.body, "Web (browser)"), /\| not needed \|/);
    assert.ok(!manualLines(r.body).some((l) => /\*\*Web\*\*/.test(l)));
  });

  it("asks for a pass over other sections without reserving room, and skips 'not testable' notes", () => {
    const body = [
      "## Test scenario",
      "### Setup",
      "1. Create a notebook.",
      "### What isn't manually testable",
      "The race in sync.ts is covered by unit tests.",
      "### macOS",
      "1. Click.",
    ].join("\n");
    const r = compose({ platforms: { web: false, mobile: false, desktop: true }, scenario: body });
    const lines = manualLines(r.body);
    assert.ok(lines.includes("Go through the **Setup** section of the test scenario."));
    assert.ok(!lines.some((l) => /testable/.test(l)));
    assert.ok(lines.some((l) => l.startsWith("Run the **macOS** steps")));
  });

  it("asks for an affected platform by hand when the scenario has no section for it", () => {
    const r = compose({
      scenario: scenario({ mobile: false, mac: false }),
      betaLanes: "desktop",
    });
    const lines = manualLines(r.body);
    assert.ok(
      lines.includes(
        "Test the iOS / Android changes by hand on a build of this branch (no beta was dispatched; the scenario says how to get one): the test scenario has no iOS / Android section.",
      ),
    );
    assert.ok(
      lines.includes(
        "Test the macOS changes by hand on the macOS beta for this commit (a follow-up comment gives the build number): the test scenario has no macOS section.",
      ),
    );
    const none = compose({ scenario: null });
    assert.equal(manualLines(none.body).filter((l) => l.startsWith("Test the ")).length, 2);
  });
});

describe("headline wording", () => {
  it("says a report was withheld, not partial, when every check ran", () => {
    const r = compose({
      shell: { state: "reported:pass", text: shellOutput({ extra: "rotated the refresh_token" }) },
    });
    assert.deepEqual(r.withheld, { shell: true, browser: false });
    assert.match(
      r.body,
      /\*\*Verdict: PASS\*\* for `0123456789ab` \(PR #701\)\. A lane's report was withheld from this comment; see \*\*Coverage gaps\*\*\./,
    );
    assert.doesNotMatch(r.body, /Partial/);
  });
});

describe(`${COMMENT_MAX_CHARS}-character cap`, () => {
  it("truncates the lane details first, pointing at the local files", () => {
    const r = compose({
      shell: {
        state: "reported:pass",
        dir: "/ev/shell",
        text: shellOutput({ extra: "s".repeat(150_000) }),
      },
      browser: {
        state: "reported:pass",
        dir: "/ev/browser",
        text: browserOutput({ extra: "b".repeat(100_000) }),
      },
    });
    assert.ok(r.body.length <= COMMENT_MAX_CHARS, `length ${r.body.length}`);
    assert.ok(r.body.length > COMMENT_MAX_CHARS - 1000, "uses most of the room");
    assert.match(
      r.body,
      /_…truncated to \d+ of \d+ characters; the full output is at `\/ev\/shell\/shell-output\.txt`\._/,
    );
    assert.match(
      r.body,
      /_…truncated to \d+ of \d+ characters; the full output is at `\/ev\/browser\/runner-output\.txt`\._/,
    );
    // Everything before the details survives intact.
    assert.match(r.body, /\*\*Steps for you to do manually\*\*/);
    assert.match(r.body, /\*\*Coverage gaps\*\*/);
    assert.deepEqual(r.body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
  });

  it("gives a short lane its whole report and the long one the rest", () => {
    const r = compose({
      shell: {
        state: "reported:pass",
        dir: "/ev/shell",
        text: shellOutput({ extra: "s".repeat(150_000) }),
      },
    });
    assert.ok(r.body.length <= COMMENT_MAX_CHARS);
    assert.match(r.body, /the list shows/);
    assert.doesNotMatch(r.body, /runner-output\.txt`\._/);
    assert.match(r.body, /shell-output\.txt`\._/);
  });

  it("leaves a body under the cap untouched", () => {
    const r = compose({
      shell: { state: "reported:pass", text: shellOutput({ extra: "y".repeat(30_000) }) },
    });
    assert.ok(r.body.includes("y".repeat(30_000)));
    assert.doesNotMatch(r.body, /truncated/);
  });

  it("stays under the cap with every section at its own cap", () => {
    const manual = Array.from({ length: 60 }, (_, i) => `${i + 1}. ${"m".repeat(3000)} ${i}`).join(
      "\n",
    );
    const rows = Array.from(
      { length: 60 },
      (_, i) => `| ${i} | ${"r".repeat(3000)} | FAIL | ${"e".repeat(3000)} |`,
    );
    const r = compose({
      shell: {
        state: "reported:pass",
        text: shellOutput({ manual, summary: `**Summary:** ${"z".repeat(9000)}` }),
      },
      browser: { state: "reported:fail", text: browserOutput({ verdict: "fail", rows }) },
      gaps: Array.from({ length: 50 }, (_, i) => ({
        lane: "x",
        reason: `${"g".repeat(2000)} ${i}`,
      })),
      crNote: "c".repeat(5000),
    });
    assert.ok(r.body.length <= COMMENT_MAX_CHARS, `length ${r.body.length}`);
    assert.match(r.body, /- …and 30 more\./);
    assert.deepEqual(r.body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
  });
});

describe("verify-report CLI", () => {
  let dir;
  let files;

  function run(args) {
    return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  }

  function args(overrides = {}) {
    const flags = {
      issue: "465",
      pr: "701",
      sha: SHA,
      "scenario-file": files.scenario,
      platforms: '{"web":true,"mobile":true,"desktop":false}',
      "beta-lanes": "mobile",
      "shell-state": "reported:pass",
      "shell-dir": files.shellDir,
      "browser-state": "reported:fail",
      "browser-dir": files.browserDir,
      gaps: '[{"lane":"shell","reason":"no bypass secret"}]',
      "cr-note": "",
      "account-file": files.account,
      "bypass-file": files.bypass,
      "signin-key-file": files.key,
      out: files.out,
      ...overrides,
    };
    return [
      "render",
      ...Object.entries(flags)
        .filter(([, v]) => v !== undefined)
        .flatMap(([k, v]) => [`--${k}`, v]),
    ];
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verify-report-cli-"));
    files = {
      scenario: join(dir, "scenario.md"),
      shellDir: join(dir, "shell"),
      browserDir: join(dir, "browser"),
      account: join(dir, "account.env"),
      bypass: join(dir, "bypass.env"),
      key: join(dir, "key.env"),
      out: join(dir, "body.md"),
    };
    mkdirSync(files.shellDir);
    mkdirSync(files.browserDir);
    writeFileSync(files.scenario, scenario({ mac: false }));
    writeFileSync(join(files.shellDir, "shell-output.txt"), shellOutput());
    writeFileSync(join(files.browserDir, "runner-output.txt"), browserOutput({ verdict: "fail" }));
    writeFileSync(
      files.account,
      `FACTORY_BROWSER_EMAIL=qa@example.com\nFACTORY_BROWSER_PASSWORD=${PASSWORD}\n`,
      { mode: 0o600 },
    );
    writeFileSync(files.bypass, `VERCEL_AUTOMATION_BYPASS_SECRET=${BYPASS}\n`, { mode: 0o600 });
    writeFileSync(
      files.key,
      `DEV_SUPABASE_URL=https://huhzactreblzcogqkbsd.supabase.co\nDEV_SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\n`,
      { mode: 0o600 },
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the body and prints one JSON line", () => {
    const r = run(args());
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      verdict: "fail",
      withheld: { shell: false, browser: false },
      secretHits: [],
    });
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const body = readFileSync(files.out, "utf8");
    assert.match(body, /\*\*Verdict: FAIL\*\*/);
    assert.match(body, /12 tests/);
    assert.match(body, /- \*\*Repo & API \(shell\):\*\* no bypass secret/);
    assert.deepEqual(body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
  });

  it("withholds the shell lane when its output carries the bypass secret from the file", () => {
    writeFileSync(join(files.shellDir, "shell-output.txt"), shellOutput({ extra: `v=${BYPASS}` }));
    const r = run(args());
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.withheld, { shell: true, browser: false });
    assert.deepEqual(out.secretHits, ["shell:bypass-secret"]);
    assert.ok(!readFileSync(files.out, "utf8").includes(BYPASS));
    assert.ok(!r.stdout.includes(BYPASS) && !r.stderr.includes(BYPASS));
  });

  it("fails closed when a secret file is missing, empty-keyed or not given", () => {
    rmSync(files.bypass);
    let r = run(args());
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).secretHits, ["shell:bypass-file-unreadable"]);
    // An empty value for the key fails closed too; `--bypass-file ""` says
    // the lanes never had a bypass secret, so there is nothing to scan for.
    writeFileSync(files.key, "DEV_SUPABASE_SERVICE_ROLE_KEY=\n");
    r = run(args({ "bypass-file": "" }));
    assert.deepEqual(JSON.parse(r.stdout).secretHits, ["shell:signin-key-file-unreadable"]);
    r = run(args({ "account-file": undefined }));
    assert.deepEqual(JSON.parse(r.stdout).withheld, { shell: true, browser: true });
  });

  it('takes an empty secret flag as "never given": nothing withheld', () => {
    const r = run(args({ "bypass-file": "", "signin-key-file": "" }));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      verdict: "fail",
      withheld: { shell: false, browser: false },
      secretHits: [],
    });
    assert.match(readFileSync(files.out, "utf8"), /12 tests/);
  });

  it("treats a missing lane output or scenario file as a gap, not an error", () => {
    rmSync(join(files.browserDir, "runner-output.txt"));
    const r = run(args({ "scenario-file": join(dir, "nope.md"), "shell-dir": "" }));
    assert.equal(r.status, 0, r.stderr);
    // Both lanes say "reported" but neither left output: no result to trust.
    assert.equal(JSON.parse(r.stdout).verdict, "incomplete");
    const body = readFileSync(files.out, "utf8");
    assert.match(body, /\*\*Test scenario:\*\* none was available/);
    assert.match(body, /its output is missing or empty/);
  });

  it("rejects usage errors with exit 2 and writes nothing", () => {
    for (const bad of [
      { sha: SHA.slice(0, 12) },
      { issue: "0" },
      { pr: "abc" },
      { platforms: "{not json" },
      { platforms: "[1]" },
      { gaps: '{"lane":"x"}' },
      { out: undefined },
    ]) {
      const r = run(args(bad));
      assert.equal(r.status, 2, JSON.stringify(bad));
      assert.ok(!existsSync(files.out), JSON.stringify(bad));
    }
    assert.equal(run(["render", "--issue"]).status, 2, "flag without a value");
    assert.equal(run(["bogus"]).status, 2);
    assert.equal(run(["--help"]).status, 0);
  });

  it("exits 1 when it can't write the body", () => {
    const r = run(args({ out: join(dir, "missing-dir", "body.md") }));
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stderr).error, /ENOENT/);
  });
});
