import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMENT_MAX_CHARS,
  DEVICE_REPORT_MARKER,
  DEVICE_RUNNING_NOTE,
  EARLIER_RUN_STEP,
  MANUAL_MAX,
  VERIFY_REPORT_MARKER,
  composeDeviceReport,
  composeVerifyReport,
  deviceShaMarker,
  deviceStateNote,
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
// Since ADR-0096 the Web lane's published screenshots can be embedded too:
// only inside that lane's <details>, never cut, never for a lane that was
// withheld or didn't report, never for the shell lane (its output has no
// provenance), and the footer says where the rest of the evidence stays.

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

// The Web lane's upload record (evidence-upload.mjs's upload.json), built by
// hand the way publishRun writes one: every image pinned to the evidence commit.
const EVIDENCE_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const RUN_ID = "verify-20261110T000000";

function imageUrl(n) {
  return `https://raw.githubusercontent.com/JakubAnderwald/drafto/${EVIDENCE_COMMIT}/465/${SHA.slice(0, 12)}/${RUN_ID}/${String(n).padStart(2, "0")}.png`;
}

function upload(ns = [1, 2], extra = {}) {
  return {
    ok: true,
    issue: "465",
    sha: SHA,
    runId: RUN_ID,
    ref: `refs/factory-evidence/465/${SHA.slice(0, 12)}/${RUN_ID}`,
    commit: EVIDENCE_COMMIT,
    images: ns.map((n) => ({ n, url: imageUrl(n), local: `/ev/browser/evidence/${n}.png` })),
    overflow: [],
    ...extra,
  };
}

const imgTag = (n) => `<img src="${imageUrl(n)}" width="480" alt="Screenshot ${n}">`;
const imgCount = (body) => (body.match(/<img /g) ?? []).length;
// Browser rows that refer to the runner's screenshots (factory-browser-prompt.md, rule 7).
const SHOT_ROWS = [
  "| 1 | Open /notebooks | PASS | the list shows, screenshot 1 |",
  "| 2 | Open a note | PASS | screenshot 2 |",
];
const SHOT_BROWSER = {
  state: "reported:pass",
  dir: "/ev/browser",
  text: browserOutput({ rows: SHOT_ROWS }),
};
const LOCAL_BOTH =
  "<sub>Local evidence stays on the Mac mini (the repo is public): Repo & API `/ev/shell` · Web `/ev/browser`.";
const WEB_PUBLISHED =
  "<sub>Web screenshots are published in this report (ADR-0096): they show the dev test " +
  "account on dev data. The rest of the Web lane's evidence stays on the Mac mini: `/ev/browser`.</sub>";

// The Web lane's <details>, from its summary to its own closer (the body's
// last </details>; the shell lane's comes first).
function webLane(body) {
  const start = body.indexOf("<summary>Web (browser):");
  return start === -1 ? "" : body.slice(start, body.lastIndexOf("</details>"));
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

  // ADR-0081: a lane reused from an earlier commit's beta names that build.
  const FROM = "9248da9a0c630a0836ff781b224dc1d2a34faff7";
  const REUSED = [
    {
      id: "mobile",
      fromSha: FROM,
      builds: [
        { platform: "android", build: "152" },
        { platform: "ios", build: "147" },
      ],
    },
    { id: "desktop", fromSha: FROM, builds: [] },
  ];

  it("names a reused beta's build instead of saying none was dispatched", () => {
    const r = compose({ betaLanes: "", betaReused: REUSED });
    assert.ok(
      tableRow(r.body, "iOS / Android").includes(
        "| manual | — | No mobile change since Android build 152 / iOS build 147 (`9248da9a0c63`); keep testing that build. " +
          "Android: Play's internal track serves only its newest upload, so check that the installed build number is 152. " +
          "If Play shows a newer build, this card's Android build is no longer installable from Play; " +
          "test iOS from TestFlight and ask in a comment for the Android build. |",
      ),
      tableRow(r.body, "iOS / Android"),
    );
    assert.match(
      tableRow(r.body, "macOS"),
      /No macOS change since the beta built from `9248da9a0c63`; keep testing that build\. An earlier comment on this issue gives its build number\./,
    );
    assert.doesNotMatch(r.body, /no beta was dispatched/);
    const lines = manualLines(r.body);
    assert.ok(
      lines.includes(
        "Run the **iOS / Android** steps in the test scenario on the iOS / Android beta built from `9248da9a0c63` (Android build 152 / iOS build 147), which nothing since has changed.",
      ),
      lines.join("\n"),
    );
    assert.ok(
      lines.includes(
        "Run the **macOS** steps in the test scenario on the macOS beta built from `9248da9a0c63`, which nothing since has changed.",
      ),
      lines.join("\n"),
    );
  });

  it("lets a beta dispatched for this commit win over a reused one", () => {
    const r = compose({ betaLanes: "mobile", betaReused: REUSED });
    assert.match(tableRow(r.body, "iOS / Android"), /beta dispatched for this commit/);
    assert.match(tableRow(r.body, "macOS"), /No macOS change since/);
  });

  it("ignores a malformed reused entry", () => {
    const r = compose({
      betaLanes: "",
      betaReused: [{ id: "mobile", fromSha: "short" }, { id: "web", fromSha: FROM }, "x"],
    });
    assert.match(tableRow(r.body, "iOS / Android"), /no beta was dispatched/);
    assert.doesNotMatch(r.body, /No mobile change since|No macOS change since/);
  });
});

describe("web reached only through packages/shared/ (webViaShared, ADR-0053 5C)", () => {
  const viaShared = { web: true, mobile: true, desktop: true, webViaShared: true };
  const NOTE =
    "web changes come through `packages/shared/`, which the web app imports (no `apps/web/` files changed)";

  it("says why the browser ran on a PR with no apps/web/ files, before the lane's own note", () => {
    const r = compose({ platforms: viaShared });
    const row = tableRow(r.body, "Web (browser)");
    assert.match(row, /\| ran \| PASS \|/);
    assert.ok(row.includes(`| ${NOTE}; full report below |`), row);
    // Only the Web row: the other rows read as they always did.
    assert.doesNotMatch(tableRow(r.body, "Repo & API (shell)"), /packages\/shared/);
    assert.doesNotMatch(tableRow(r.body, "iOS / Android"), /packages\/shared/);
  });

  it("keeps the note beside a lane that didn't report, and the hand-run Web steps", () => {
    const r = compose({ platforms: viaShared, browser: { state: "no-preview", text: null } });
    const row = tableRow(r.body, "Web (browser)");
    assert.ok(row.includes(`${NOTE}; no Vercel preview was ready for this commit`), row);
    assert.ok(
      manualLines(r.body).some((l) =>
        /Run the \*\*Web\*\* steps in the test scenario by hand/.test(l),
      ),
    );
  });

  it("stands alone when the lane has nothing else to say", () => {
    const r = compose({
      platforms: viaShared,
      browser: { state: "reported:pass", dir: "", text: browserOutput() },
    });
    assert.ok(tableRow(r.body, "Web (browser)").includes(NOTE));
  });

  it("is absent for a PR that touches apps/web/ (or without the flag), and needs web", () => {
    for (const platforms of [
      { web: true, mobile: true, desktop: true },
      { web: true, mobile: true, desktop: true, webViaShared: false },
      // A stray flag without web is ignored: there are no web changes to explain.
      { web: false, mobile: true, desktop: true, webViaShared: true },
    ]) {
      const r = compose({ platforms });
      assert.doesNotMatch(r.body, /come through `packages\/shared\/`/, JSON.stringify(platforms));
    }
  });

  it("is carried by the CLI's --platforms JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-report-shared-"));
    try {
      const out = join(dir, "body.md");
      const r = spawnSync(
        "node",
        [
          cli,
          "render",
          "--issue",
          "465",
          "--pr",
          "701",
          "--sha",
          SHA,
          "--scenario-file",
          "",
          "--platforms",
          JSON.stringify(viaShared),
          "--beta-lanes",
          "",
          "--shell-state",
          "none",
          "--shell-dir",
          "",
          "--browser-state",
          "skipped:no-web-steps",
          "--browser-dir",
          "",
          "--gaps",
          "[]",
          "--cr-note",
          "",
          "--account-file",
          "",
          "--bypass-file",
          "",
          "--signin-key-file",
          "",
          "--out",
          out,
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const body = readFileSync(out, "utf8");
      assert.ok(tableRow(body, "Web (browser)").includes(NOTE));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("lists one Web line, not the SKIP rows, when an unavailable browser lane still wrote output", () => {
    // The runner reports every step SKIP when the pinned browser isn't
    // connected; none of them was tried.
    const r = compose({
      browser: {
        state: "unavailable:chrome",
        text: browserOutput({
          status: "unavailable",
          verdict: "none",
          rows: [
            "| 1 | Open /settings | SKIP | browser not connected |",
            "| 2 | Revoke | SKIP | not run |",
          ],
        }),
      },
    });
    const lines = manualLines(r.body);
    assert.ok(!lines.some((l) => l.startsWith("Re-check by hand")), lines.join("\n"));
    assert.equal(lines.filter((l) => /\*\*Web\*\* steps/.test(l)).length, 1);
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

  it("reads a gap's token as its sentence, and a reason as it is even when it spells a token", () => {
    // verify-lane.mjs's runGaps sends the signin-busy token when the browser
    // runner held the shared sign-in lease past the shell lane's wait.
    const r = compose({
      gaps: [
        { lane: "shell", token: "signin-busy" },
        { lane: "shell", token: "constructor" },
        { lane: "shell", reason: "busy" },
        { lane: "shell", reason: "signin-busy" },
      ],
    });
    const lines = gapsSection(r.body).trim().split("\n");
    assert.deepEqual(lines, [
      "- **Repo & API (shell):** the browser runner was signing in as the same test account for longer than the lane could wait (the sign-in lease), so the lane had no preview session and its signed-in API checks didn't run",
      "- **Repo & API (shell):** constructor",
      "- **Repo & API (shell):** busy",
      "- **Repo & API (shell):** signin-busy",
    ]);
  });

  it("reads the Testing sweep's own skip reasons as sentences", () => {
    // factory-agent.sh (verify_lane_states) and verify-decide.mjs send these.
    const cases = {
      "skipped:not-built": "skipped: this lane isn't built yet",
      "skipped:lane-off": "skipped: the lane is switched off (FACTORY_VERIFY_LANES)",
      "skipped:verification-off": "skipped: verification is switched off (FACTORY_VERIFY=0)",
      "skipped:feedback": "skipped: new feedback on the issue cut verification short",
      "skipped:hold-cap": "skipped: the hold cap was reached first",
    };
    for (const [state, text] of Object.entries(cases)) {
      const r = compose({ shell: { state, text: null }, browser: { state, text: null } });
      assert.ok(gapsSection(r.body).includes(`- **Repo & API (shell):** ${text}.`), state);
      assert.equal(r.verdict, "incomplete", state);
    }
  });

  it("reads the shell lane's own reasons as sentences", () => {
    // verify-lane.mjs and verify_shell_work send these; verify-decide.mjs turns
    // a deferred:<why> or retry:<why> lane into skipped:<why> or
    // skipped:after-<why> at the hold cap.
    const cases = {
      "skipped:busy": "skipped: another card's verification run held the lane",
      "skipped:lane-paused": "skipped: the verification lane was paused",
      "unavailable:error": "unavailable: it exited with an error on every attempt",
      "unavailable:no-result": "unavailable: it finished without a result on every attempt",
      "unavailable:lost": "unavailable: its supervisor died before it reported",
      "unavailable:claude-missing": "unavailable: the claude CLI wasn't found on the Mac mini",
      "unavailable:pnpm-missing": "unavailable: pnpm wasn't found on the Mac mini",
      "unavailable:curl-missing": "unavailable: curl wasn't found on the Mac mini",
      "unavailable:perl-missing":
        "unavailable: perl (the guard's timeout wrapper) wasn't found on the Mac mini",
      "unavailable:nice-missing": "unavailable: nice wasn't found on the Mac mini",
      "unavailable:prompt-missing": "unavailable: the lane's prompt file is missing",
      "skipped:after-error":
        "skipped: its run exited with an error, and the hold cap came before another attempt",
      "skipped:after-no-result":
        "skipped: its run ended without a result, and the hold cap came before another attempt",
      "skipped:after-lost":
        "skipped: its supervisor died, and the hold cap came before another attempt",
      "skipped:after-terminated":
        "skipped: its run was stopped from outside, and the hold cap came before another attempt",
      "skipped:after-stopped":
        "skipped: its run was stopped when the card left Testing, and the hold cap came before another attempt",
    };
    for (const [state, text] of Object.entries(cases)) {
      const r = compose({ shell: { state, text: null } });
      assert.ok(gapsSection(r.body).includes(`- **Repo & API (shell):** ${text}.`), state);
    }
  });

  it("reads the browser lane's own reasons as sentences", () => {
    // factory-agent.sh (verify_browser_work, browser_run verify) sends these.
    const cases = {
      "skipped:not-web":
        "skipped: the PR's diff touches neither the web app (apps/web/) nor packages/shared/",
      "skipped:browser-off":
        "skipped: the browser runner's verify kind is switched off (FACTORY_BROWSER, FACTORY_BROWSER_KINDS)",
      "skipped:no-scenario": "skipped: there was no test scenario for this commit",
      "skipped:no-web-steps": "skipped: the scenario has no Web steps",
      "unavailable:chrome-not-running": "unavailable: Chrome wasn't running on the Mac mini",
      "unavailable:runner-disabled":
        "unavailable: the browser runner is turned off until an operator resets it (factory:browser-reset)",
      "unavailable:account": "unavailable: the test account file is missing or unusable",
      "unavailable:signin-key": "unavailable: the dev sign-in key file is missing or unusable",
      "unavailable:signin-mint": "unavailable: the one-time sign-in link couldn't be minted",
      "unavailable:preflight": "unavailable: the browser runner's pre-run check failed",
      "unavailable:runner-start": "unavailable: the browser runner couldn't be started",
      "unavailable:runner-error": "unavailable: the browser runner failed on its last attempt",
      "unavailable:malformed":
        "unavailable: the runner's output had no status line, so its result can't be trusted",
      "unavailable:guard": "unavailable: the lane's guard hook didn't load",
      "unavailable:session-limit": "unavailable: the Claude session limit was reached",
      "unavailable:attempts": "unavailable: out of attempts",
      "unavailable:signin-failed":
        "unavailable: the one-time sign-in link didn't sign the runner in",
      "unavailable:auth-expired":
        "unavailable: the Vercel sign-in in the Mac mini's Chrome has expired",
    };
    for (const [state, text] of Object.entries(cases)) {
      const r = compose({ browser: { state, text: null } });
      assert.ok(gapsSection(r.body).includes(`- **Web (browser):** ${text}.`), state);
      assert.match(
        r.body,
        /Run the \*\*Web\*\* steps in the test scenario by hand on the preview/,
        state,
      );
    }
  });

  it("points a commit the In Test run already covered at that run's comment, still as a gap", () => {
    // #460: back in Testing after a no-op revision, the report asked for every
    // Web step by hand although the In Test run had run them. Its result never
    // reaches the composer (a FAIL, a blocked or a withheld run all look the
    // same here), so the commit stays a coverage gap and the headline stays
    // partial; only the pointer changes.
    for (const state of ["skipped:already-run", "skipped:Already-Run"]) {
      const r = compose({ browser: { state, text: null } });
      assert.match(r.body, /Partial: some checks didn't run/, state);
      assert.equal(r.verdict, "pass");
      const lines = manualLines(r.body);
      assert.ok(!lines.some((l) => /^Run the \*\*Web\*\* steps/.test(l)), lines.join("\n"));
      assert.ok(lines.includes(EARLIER_RUN_STEP), `${state}: ${lines.join("\n")}`);
    }
    const r = compose({ browser: { state: "skipped:already-run", text: null } });
    assert.ok(
      gapsSection(r.body).includes(
        "- **Web (browser):** skipped: the In Test browser run already reported on this commit, so this round didn't run the Web steps again (see its Browser run comment on the issue).",
      ),
      gapsSection(r.body),
    );
    // What the step must cover: a FAIL/SKIP row, a blocked or withheld run, and
    // a scenario or environment that changed since that run.
    assert.match(EARLIER_RUN_STEP, /FAIL or SKIP, or doesn't list/);
    assert.match(EARLIER_RUN_STEP, /stopped early, or its report was withheld/);
    assert.match(EARLIER_RUN_STEP, /the scenario or the environment changed since it ran/);

    // No web work at all: no pointer to Web steps that don't exist.
    const none = compose({
      platforms: { web: false, mobile: false, desktop: true },
      scenario: scenario({ web: false, mobile: false }),
      browser: { state: "skipped:already-run", text: null },
    });
    assert.match(tableRow(none.body, "Web (browser)"), /\| not needed \|/);
    assert.ok(!manualLines(none.body).includes(EARLIER_RUN_STEP), none.body);
  });

  it("names the browser lane's preview wait, should a fail-open promotion show it", () => {
    const r = compose({ browser: { state: "waiting-preview:2026-10-21T00:00:00Z", text: null } });
    assert.ok(
      gapsSection(r.body).includes(
        "- **Web (browser):** was still waiting for this commit's Vercel preview.",
      ),
    );
    assert.match(tableRow(r.body, "Web (browser)"), /\| not run \|/);
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

  it("the withheld body carries no local path: a lane dir can be what matched", () => {
    const dir = "/ev/Bearer abcdefghij1234";
    const r = compose({ shell: { state: "reported:pass", dir, text: shellOutput() } });
    assert.ok(r.secretHits.includes("body:bearer"), JSON.stringify(r.secretHits));
    assert.match(r.body, /The rest of this report was withheld/);
    assert.ok(!r.body.includes("abcdefghij1234"));
    assert.ok(!r.body.includes("/ev/"), "no lane's dir");
    assert.deepEqual(r.body.split("\n").slice(-4), [
      "<sub>The full report and the local evidence stay on the Mac mini (the repo is public).</sub>",
      "",
      VERIFY_REPORT_MARKER,
      verifyShaMarker(SHA),
    ]);
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

  it("never lists ### Fixtures as a step, and asks for ### Live tests by hand only without the shell lane (ADR-0073)", () => {
    const body = [
      "## Test scenario",
      "### Fixtures",
      "- small.jpg 1.5MB",
      "### Live tests",
      "- storage-quota",
      "### macOS",
      "1. Click.",
    ].join("\n");
    const platforms = { web: false, mobile: false, desktop: true };
    // The shell lane reported: it covers the live tests itself.
    const ran = manualLines(compose({ platforms, scenario: body }).body);
    assert.ok(!ran.some((l) => /Fixtures|Live tests/.test(l)), ran.join("\n"));
    // It didn't: the person runs them.
    const shell = { state: "timeout", dir: "", text: null };
    const lines = manualLines(compose({ platforms, scenario: body, shell }).body);
    assert.ok(!lines.some((l) => /Fixtures/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => /Go through the \*\*Live tests\*\*/.test(l)));
    assert.ok(
      lines.some((l) =>
        l.startsWith(
          "Run the **Live tests** in the test scenario by hand: `pnpm test:live:supabase",
        ),
      ),
      lines.join("\n"),
    );
  });

  it("leaves ### API to the shell lane once it reported, and asks for it by hand otherwise", () => {
    const body = [
      "## Test scenario",
      "### Web",
      "1. Open /notebooks — expected: the list.",
      "### API",
      "1. Signed out: `vercel curl /api/notebooks --deployment <url> -- -s` — expected: 401.",
    ].join("\n");
    const platforms = { web: true, mobile: false, desktop: false };
    const ran = manualLines(compose({ platforms, scenario: body }).body);
    assert.ok(!ran.some((l) => /\*\*API\*\*/.test(l)), ran.join("\n"));
    const byHand = "Run the **API** steps in the test scenario by hand with `vercel curl`: ";
    for (const [shell, why] of [
      [{ state: "timeout", dir: "", text: null }, "the shell lane didn't report."],
      [
        { state: "reported:none", text: shellOutput({ status: "blocked", verdict: "none" }) },
        "the shell lane stopped early (blocked).",
      ],
    ]) {
      const lines = manualLines(compose({ platforms, scenario: body, shell }).body);
      assert.ok(lines.includes(byHand + why), `${shell.state}: ${lines.join("\n")}`);
    }
    // A heading the writer decorated still counts as the shell lane's.
    for (const heading of ["### **API**", "### API checks"]) {
      const decorated = body.replace("### API", heading);
      const lines = manualLines(compose({ platforms, scenario: decorated }).body);
      assert.ok(!lines.some((l) => /\bAPI\b/.test(l)), `${heading}: ${lines.join("\n")}`);
    }
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

describe("Web lane screenshots (ADR-0096)", () => {
  it("embeds them inside the Web lane's <details>, after its text, under the rows that took them", () => {
    const r = compose({ browser: SHOT_BROWSER, images: { browser: upload() } });
    assert.deepEqual(r.images, { browser: 2 });
    assert.equal(imgCount(r.body), 2);
    const web = webLane(r.body);
    assert.ok(web.includes(imgTag(1)) && web.includes(imgTag(2)), "both in the Web lane");
    assert.ok(web.indexOf("**Summary:**") < web.indexOf("**Screenshots**"), "after its text");
    const l = web.split("\n");
    const step1 = l.indexOf("**Step 1** · PASS · Open /notebooks");
    assert.deepEqual(l.slice(step1, step1 + 3), [
      "**Step 1** · PASS · Open /notebooks",
      "",
      imgTag(1),
    ]);
    const step2 = l.indexOf("**Step 2** · PASS · Open a note");
    assert.deepEqual(l.slice(step2, step2 + 3), ["**Step 2** · PASS · Open a note", "", imgTag(2)]);
    // Nowhere else: not in the shell lane, not above the details, not in the footer.
    const shell = r.body.slice(
      r.body.indexOf("<summary>Repo &amp; API (shell):"),
      r.body.indexOf("<summary>Web (browser):"),
    );
    assert.doesNotMatch(shell, /<img/);
    assert.doesNotMatch(r.body.slice(0, r.body.indexOf("<details>")), /<img/);
    assert.doesNotMatch(r.body.slice(r.body.lastIndexOf("</details>")), /<img/);
    assert.deepEqual(r.body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
  });

  it("collapses several images for one row, and keeps the overflow list in the Web lane", () => {
    const r = compose({
      browser: {
        ...SHOT_BROWSER,
        text: browserOutput({ rows: ["| 1 | Open /notebooks | PASS | screenshots 1–3 |"] }),
      },
      images: {
        browser: upload([1, 2, 3], {
          overflow: [{ n: 4, path: "/ev/browser/evidence/04.png", why: "a symlink" }],
        }),
      },
    });
    const web = webLane(r.body);
    assert.ok(
      web.includes(
        [
          "<details>",
          "<summary>Screenshots (3)</summary>",
          "",
          imgTag(1),
          imgTag(2),
          imgTag(3),
        ].join("\n"),
      ),
    );
    assert.ok(web.includes("- screenshot 4, a symlink: `/ev/browser/evidence/04.png`"));
    assert.deepEqual(r.images, { browser: 3 });
  });

  it(`keeps every image when a huge browser report is cut to ${COMMENT_MAX_CHARS}`, () => {
    const ns = Array.from({ length: 20 }, (_, i) => i + 1);
    const r = compose({
      browser: {
        ...SHOT_BROWSER,
        text: browserOutput({ rows: SHOT_ROWS, extra: "b".repeat(150_000) }),
      },
      images: { browser: upload(ns) },
    });
    assert.ok(r.body.length <= COMMENT_MAX_CHARS, `length ${r.body.length}`);
    assert.match(
      r.body,
      /_…truncated to \d+ of \d+ characters; the full output is at `\/ev\/browser\/runner-output\.txt`\._/,
    );
    for (const n of ns) assert.ok(r.body.includes(imgTag(n)), `screenshot ${n}`);
    assert.equal(imgCount(r.body), 20);
    assert.deepEqual(r.images, { browser: 20 });
    const web = webLane(r.body);
    assert.ok(web.indexOf("_…truncated to") < web.indexOf(imgTag(1)), "only the text is cut");
    assert.ok(r.body.split("\n").includes(WEB_PUBLISHED));
    assert.deepEqual(r.body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
  });

  it("never gives the shell lane any, even when passed images for it", () => {
    const shell = {
      state: "reported:pass",
      dir: "/ev/shell",
      text: shellOutput({ rows: ["| 1 | `curl /api/notes` | PASS | screenshot 1 |"] }),
    };
    const r = compose({ shell, images: { shell: upload() } });
    assert.equal(imgCount(r.body), 0);
    assert.ok(!r.body.includes(EVIDENCE_COMMIT));
    assert.deepEqual(r.images, { browser: 0 });
    assert.ok(r.body.split("\n").includes(`${LOCAL_BOTH}</sub>`), "the footer is as before");

    const both = compose({
      shell,
      browser: SHOT_BROWSER,
      images: { shell: upload(), browser: upload() },
    });
    const shellLane = both.body.slice(0, both.body.indexOf("<summary>Web (browser):"));
    assert.doesNotMatch(shellLane, /<img/);
    assert.equal(imgCount(webLane(both.body)), 2);
  });

  it("renders none for a withheld browser lane, and the footer says why", () => {
    const jwt = "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw";
    const r = compose({
      browser: { ...SHOT_BROWSER, text: browserOutput({ rows: SHOT_ROWS, extra: jwt }) },
      images: { browser: upload() },
    });
    assert.deepEqual(r.withheld, { shell: false, browser: true });
    assert.equal(imgCount(r.body), 0);
    assert.ok(!r.body.includes(EVIDENCE_COMMIT));
    assert.deepEqual(r.images, { browser: 0 });
    assert.ok(
      r.body
        .split("\n")
        .includes(
          `${LOCAL_BOTH} Web screenshots weren't published: the report was withheld, so its screenshots were too.</sub>`,
        ),
    );
    assert.doesNotMatch(r.body, /Web screenshots are published/);
  });

  it("renders none for a lane that didn't report", () => {
    for (const browser of [
      { state: "timeout", dir: "/ev/browser", text: browserOutput({ rows: SHOT_ROWS }) },
      {
        state: "reported:none",
        dir: "/ev/browser",
        text: browserOutput({ rows: SHOT_ROWS, status: "unavailable", verdict: "none" }),
      },
      { state: "reported:pass", dir: "/ev/browser", text: null },
    ]) {
      const r = compose({ browser, images: { browser: upload() } });
      assert.equal(imgCount(r.body), 0, browser.state);
      assert.deepEqual(r.images, { browser: 0 }, browser.state);
      assert.ok(
        r.body
          .split("\n")
          .includes(
            `${LOCAL_BOTH} Web screenshots weren't published: the lane didn't report a result.</sub>`,
          ),
        browser.state,
      );
    }
  });

  it("leaves no image when a body-level secret hit replaces the body", () => {
    const r = compose({
      browser: SHOT_BROWSER,
      gaps: [{ lane: "shell", reason: `curl failed with ${BYPASS}` }],
      images: { browser: upload() },
    });
    assert.ok(r.secretHits.includes("body:bypass-secret"));
    assert.match(r.body, /The rest of this report was withheld/);
    assert.equal(imgCount(r.body), 0);
    assert.ok(!r.body.includes(EVIDENCE_COMMIT));
    assert.deepEqual(r.images, { browser: 0 });
    assert.doesNotMatch(r.body, /Web screenshots are published/);
    assert.ok(!r.body.includes("/ev/"), "the withheld body names no local dir");
    assert.deepEqual(r.body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
  });

  it("with no images passed, the footer is exactly as before", () => {
    const r = compose({ browser: SHOT_BROWSER });
    assert.ok(r.body.split("\n").includes(`${LOCAL_BOTH}</sub>`));
    assert.doesNotMatch(r.body, /<img|Web screenshots|\*\*Screenshots\*\*/);
    assert.deepEqual(r.images, { browser: 0 });
    for (const images of [{}, { browser: null }, { browser: undefined }, undefined]) {
      assert.equal(compose({ browser: SHOT_BROWSER, images }).body, r.body, JSON.stringify(images));
    }
  });

  it("moves the Web dir to its own published line when images are embedded; the shell dir stays", () => {
    const l = compose({ browser: SHOT_BROWSER, images: { browser: upload() } }).body.split("\n");
    assert.ok(
      l.includes(
        "<sub>Local evidence stays on the Mac mini (the repo is public): Repo & API `/ev/shell`.</sub>",
      ),
    );
    assert.ok(l.includes(WEB_PUBLISHED));
    assert.ok(l.indexOf(WEB_PUBLISHED) > l.lastIndexOf("</details>"), "in the footer");
    assert.ok(!l.some((x) => x.includes("Web `/ev/browser`")), "not in the local line");

    // No shell dir: no local line at all.
    const alone = compose({
      shell: { state: "timeout", text: null },
      browser: SHOT_BROWSER,
      images: { browser: upload() },
    }).body;
    assert.doesNotMatch(alone, /Local evidence stays on the Mac mini/);
    assert.ok(alone.split("\n").includes(WEB_PUBLISHED));
  });

  it("appends why the Web screenshots weren't published when the upload failed", () => {
    const cases = [
      [{ ok: false, reason: "push" }, "pushing them to GitHub failed"],
      [
        { ok: false, reason: "selftest-missing" },
        "the publishing self-test hasn't passed on this Mac mini yet (see the factory runbook)",
      ],
      [{ ok: false, reason: "unreadable" }, "the upload record couldn't be read"],
      [{ ok: false }, "the upload failed"],
      [upload([], { commit: null }), "the run saved no screenshots"],
    ];
    for (const [record, why] of cases) {
      const r = compose({ browser: SHOT_BROWSER, images: { browser: record } });
      assert.equal(imgCount(r.body), 0, why);
      assert.deepEqual(r.images, { browser: 0 }, why);
      assert.ok(
        r.body
          .split("\n")
          .includes(`${LOCAL_BOTH} Web screenshots weren't published: ${why}.</sub>`),
        why,
      );
      assert.doesNotMatch(r.body, /Web screenshots are published/, why);
    }
    // Every image kept back: the list is in the Web lane, the reason in the footer.
    const kept = compose({
      browser: SHOT_BROWSER,
      images: {
        browser: upload([], {
          commit: null,
          overflow: [{ n: 1, path: "/ev/browser/evidence/01.png", why: "a symlink" }],
        }),
      },
    }).body;
    assert.ok(webLane(kept).includes("- screenshot 1, a symlink: `/ev/browser/evidence/01.png`"));
    assert.ok(
      kept
        .split("\n")
        .includes(
          `${LOCAL_BOTH} Web screenshots weren't published: none of its screenshots passed the checks.</sub>`,
        ),
    );
    // No local dir to hang the reason on: it gets a line of its own.
    const bare = compose({
      shell: { state: "reported:pass", dir: "", text: shellOutput() },
      browser: { ...SHOT_BROWSER, dir: "" },
      images: { browser: { ok: false, reason: "push" } },
    }).body;
    assert.ok(
      bare
        .split("\n")
        .includes("<sub>Web screenshots weren't published: pushing them to GitHub failed.</sub>"),
    );
    assert.doesNotMatch(bare, /Local evidence stays on the Mac mini/);
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
      images: { browser: 0 },
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
      images: { browser: 0 },
    });
    assert.match(readFileSync(files.out, "utf8"), /12 tests/);
  });

  it("--browser-images embeds the Web lane's uploaded screenshots and counts them", () => {
    writeFileSync(
      join(files.browserDir, "runner-output.txt"),
      browserOutput({ rows: SHOT_ROWS, verdict: "fail" }),
    );
    const record = join(dir, "upload.json");
    writeFileSync(record, JSON.stringify(upload()), { mode: 0o600 });
    const r = run(args({ "browser-images": record }));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      verdict: "fail",
      withheld: { shell: false, browser: false },
      secretHits: [],
      images: { browser: 2 },
    });
    const body = readFileSync(files.out, "utf8");
    assert.ok(webLane(body).includes(imgTag(1)) && webLane(body).includes(imgTag(2)));
    assert.equal(imgCount(body), 2);
    assert.match(body, /<sub>Web screenshots are published in this report \(ADR-0096\)/);
    assert.deepEqual(body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
  });

  it('--browser-images "" reads as no upload tried: the body is as without the flag', () => {
    writeFileSync(join(files.browserDir, "runner-output.txt"), browserOutput({ rows: SHOT_ROWS }));
    assert.equal(run(args()).status, 0);
    const without = readFileSync(files.out, "utf8");
    const r = run(args({ "browser-images": "" }));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).images, { browser: 0 });
    const body = readFileSync(files.out, "utf8");
    assert.equal(body, without);
    assert.doesNotMatch(body, /<img|Web screenshots/);
  });

  it("--browser-images that can't be read says the upload record couldn't be read", () => {
    writeFileSync(join(files.browserDir, "runner-output.txt"), browserOutput({ rows: SHOT_ROWS }));
    const garbled = join(dir, "garbled.json");
    writeFileSync(garbled, "{not json");
    for (const record of [join(dir, "missing.json"), garbled]) {
      const r = run(args({ "browser-images": record }));
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout).images, { browser: 0 }, record);
      const body = readFileSync(files.out, "utf8");
      assert.equal(imgCount(body), 0, record);
      assert.match(
        body,
        /<sub>Local evidence stays on the Mac mini \(the repo is public\): [^\n]*\. Web screenshots weren't published: the upload record couldn't be read\.<\/sub>/,
        record,
      );
    }
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

  it("takes the reused betas as --beta-reused JSON (ADR-0081)", () => {
    const reused = [
      { id: "mobile", fromSha: "9248da9a0c630a0836ff781b224dc1d2a34faff7", builds: [] },
    ];
    const r = run(args({ "beta-lanes": "", "beta-reused": JSON.stringify(reused) }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      tableRow(readFileSync(files.out, "utf8"), "iOS / Android"),
      /No mobile change since the beta built from `9248da9a0c63`/,
    );
    // Left out or empty, it is no reuse at all, as before.
    for (const value of [undefined, ""]) {
      const again = run(args({ "beta-lanes": "", "beta-reused": value }));
      assert.equal(again.status, 0, again.stderr);
      assert.match(
        tableRow(readFileSync(files.out, "utf8"), "iOS / Android"),
        /no beta was dispatched/,
      );
    }
  });

  it("rejects usage errors with exit 2 and writes nothing", () => {
    for (const bad of [
      { "beta-reused": "{not json" },
      { "beta-reused": '{"id":"mobile"}' },
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

// ── the device lane (ADR-0106) ──────────────────────────────────────────────
// Its supervisor's device-output.json replaces the manual "iOS / Android" row
// with an emulator and a simulator row; with the lane off (no output) the
// report must read exactly as before. Its text is scanned like the other
// lanes' (and for its own account's password), and its screenshots sit only
// inside its own <details>.

const DEVICE_PASSWORD = "Dev1ce-Lane-Passw0rd";
const DEVICE_RUN = "465-0123456789ab-20261110T051950Z";
const DEVICE_EVIDENCE_RUN = `device-${DEVICE_RUN}`;
const DEVICE_SECRETS = { ...SECRETS, devicePassword: DEVICE_PASSWORD };

function devicePlatform(state = "done", over = {}) {
  const done = state === "done";
  return {
    state,
    verdict: done ? "PASS" : null,
    build: done ? { cached: true, durationS: 312 } : null,
    flows: done
      ? [
          { name: "01-login.yaml", status: "PASS", durationS: 40, failure: null },
          { name: "03-notes.yaml", status: "PASS", durationS: 51, failure: null },
        ]
      : [],
    ...over,
  };
}

function deviceOutput(platforms, over = {}) {
  return {
    version: 1,
    runId: DEVICE_RUN,
    issue: 465,
    pr: 701,
    sha: SHA,
    mode: "smoke",
    trigger: "testing",
    startedAt: "2026-11-10T05:19:50Z",
    finishedAt: "2026-11-10T06:19:50Z",
    platforms,
    ...over,
  };
}

const FAILED_ANDROID = devicePlatform("done", {
  verdict: "FAIL",
  build: { cached: false, durationS: 900 },
  flows: [
    { name: "01-login.yaml", status: "PASS", durationS: 40, failure: null },
    {
      name: "03-notes.yaml",
      status: "FAIL",
      durationS: 12,
      failure: 'Assertion is false: "Notes" is visible\nat line 4',
    },
  ],
});

function composeDevice(platforms, over = {}) {
  return compose({
    device: { output: deviceOutput(platforms), dir: "/runs/dev" },
    secrets: DEVICE_SECRETS,
    ...over,
  });
}

function deviceImageUrl(n) {
  return `https://raw.githubusercontent.com/JakubAnderwald/drafto/${EVIDENCE_COMMIT}/465/${SHA.slice(0, 12)}/${DEVICE_EVIDENCE_RUN}/${String(n).padStart(2, "0")}.png`;
}

function deviceUpload(labels = ["android: 01-login.yaml", "ios: ios-all.yaml"], extra = {}) {
  return {
    ok: true,
    issue: "465",
    sha: SHA,
    runId: DEVICE_EVIDENCE_RUN,
    commit: EVIDENCE_COMMIT,
    images: labels.map((label, i) => ({ n: i + 1, url: deviceImageUrl(i + 1), label })),
    overflow: [],
    ...extra,
  };
}

const deviceImg = (n) => `<img src="${deviceImageUrl(n)}" width="480" alt="Screenshot ${n}">`;

// The device lane's <details>, from its summary to its closer.
function deviceLane(body) {
  const start = body.indexOf("<summary>Devices (Maestro):");
  return start === -1 ? "" : body.slice(start, body.indexOf("</details>", start));
}

describe("device lane: the lane off leaves the report as it was", () => {
  it("no device input, a null one, or output that can't be used: the same body", () => {
    const before = compose();
    assert.deepEqual(compose({ device: null }), before);
    for (const device of [
      { output: null, dir: "/runs/dev" },
      { output: deviceOutput({}), dir: "/runs/dev" },
      { output: deviceOutput({ web: devicePlatform() }), dir: "/runs/dev" },
      // Another commit's run says nothing about this one.
      {
        output: deviceOutput({ ios: devicePlatform() }, { sha: "f".repeat(40) }),
        dir: "/runs/dev",
      },
      // One that names no commit can't be told apart from another commit's.
      { output: deviceOutput({ ios: devicePlatform() }, { sha: undefined }), dir: "/runs/dev" },
      { output: deviceOutput({ ios: devicePlatform() }, { sha: null }), dir: "/runs/dev" },
    ]) {
      const r = compose({ device, secrets: DEVICE_SECRETS });
      assert.equal(r.body, before.body, JSON.stringify(device.output));
      assert.equal(r.verdict, before.verdict);
      // Nothing usable: withheld, so evidence-upload's gate publishes no device shots.
      assert.deepEqual(r.withheld, { ...before.withheld, device: true });
      assert.deepEqual(r.images, { ...before.images, device: 0 });
    }
    assert.match(tableRow(before.body, "iOS / Android"), /\| manual \| — \| beta dispatched/);
    assert.equal(tableRow(before.body, "Android (emulator)"), undefined);
  });
});

describe("device lane: rows", () => {
  it("done PASS: the lane's state, verdict, flows passed and the reused native project", () => {
    const r = composeDevice({ android: devicePlatform(), ios: devicePlatform() });
    assert.equal(
      tableRow(r.body, "Android (emulator)"),
      "| Android (emulator) | ran | PASS | 2/2 flows passed; native project reused |",
    );
    assert.equal(
      tableRow(r.body, "iOS (simulator)"),
      "| iOS (simulator) | ran | PASS | 2/2 flows passed; native project reused |",
    );
    assert.equal(tableRow(r.body, "iOS / Android"), undefined);
    assert.match(tableRow(r.body, "macOS"), /\| manual \|/, "the macOS row is unchanged");
    const lines = r.body.split("\n");
    assert.ok(
      lines.indexOf(tableRow(r.body, "Web (browser)")) <
        lines.indexOf(tableRow(r.body, "Android (emulator)")) &&
        lines.indexOf(tableRow(r.body, "iOS (simulator)")) <
          lines.indexOf(tableRow(r.body, "macOS")),
      "between the Web and macOS rows",
    );
    assert.match(
      r.body,
      /- \*\*Devices:\*\* Android \(emulator\) PASS, 2\/2 flows passed; iOS \(simulator\) PASS, 2\/2 flows passed\./,
    );
    // The native project was reused; the app itself was still built.
    assert.ok(
      deviceLane(r.body).includes(
        "**Android (emulator)** · ran · PASS · build 312 s · native project reused",
      ),
    );
    assert.doesNotMatch(r.body, /build cached|not cached/);
  });

  it("done FAIL: the first failure's first line, and the verdict counts in the headline", () => {
    const r = composeDevice({ android: FAILED_ANDROID });
    assert.equal(
      tableRow(r.body, "Android (emulator)"),
      '| Android (emulator) | ran | FAIL | 1/2 flows passed; first failure: 03-notes.yaml (FAIL) — Assertion is false: "Notes" is visible; native project regenerated |',
    );
    assert.equal(r.verdict, "fail");
    assert.match(r.body, /\*\*Verdict: FAIL\*\*/);
    const lane = deviceLane(r.body);
    assert.ok(
      lane.includes('- FAIL `03-notes.yaml` (12 s): Assertion is false: "Notes" is visible'),
    );
    assert.ok(!lane.includes("at line 4"), "only the first line of a failure");
  });

  it("a platform the lane didn't cover keeps today's manual text under its own label", () => {
    const r = composeDevice({ ios: devicePlatform() });
    assert.equal(
      tableRow(r.body, "Android (emulator)"),
      "| Android (emulator) | manual | — | beta dispatched for this commit; run the iOS / Android steps on it |",
    );
    assert.match(tableRow(r.body, "iOS (simulator)"), /\| ran \| PASS \|/);
    const unaffected = composeDevice(
      { ios: devicePlatform() },
      { platforms: { web: true, mobile: false, desktop: true } },
    );
    assert.equal(
      tableRow(unaffected.body, "Android (emulator)"),
      "| Android (emulator) | not affected | — | no mobile changes |",
    );
  });

  it("running: results follow in a separate comment, and it isn't a coverage gap", () => {
    const r = composeDevice({ android: devicePlatform(), ios: devicePlatform("running") });
    assert.equal(
      tableRow(r.body, "iOS (simulator)"),
      `| iOS (simulator) | running | — | ${DEVICE_RUNNING_NOTE} |`,
    );
    assert.equal(DEVICE_RUNNING_NOTE, "running — results follow in a separate comment");
    assert.doesNotMatch(gapsSection(r.body), /Devices/);
    assert.equal(r.verdict, "pass");
  });

  it("unavailable: the reason as a sentence, and a coverage gap", () => {
    const r = composeDevice({
      android: devicePlatform("unavailable:no-avd"),
      ios: devicePlatform("failed:build-timeout"),
    });
    assert.equal(
      tableRow(r.body, "Android (emulator)"),
      "| Android (emulator) | unavailable | — | unavailable: the lane's Android emulator (AVD) is missing |",
    );
    assert.equal(
      tableRow(r.body, "iOS (simulator)"),
      "| iOS (simulator) | failed | — | failed: the build timed out |",
    );
    const gaps = gapsSection(r.body);
    assert.ok(
      gaps.includes(
        "- **Devices (Maestro):** Android (emulator) unavailable: the lane's Android emulator (AVD) is missing.",
      ),
    );
    assert.ok(
      gaps.includes("- **Devices (Maestro):** iOS (simulator) failed: the build timed out."),
    );
    assert.match(r.body, /Partial: some checks didn't run/);
  });

  it("annotates the mobile manual steps with the verdict of the platform the lane ran", () => {
    const scen = scenario().replace(
      "### iOS / Android\n\n1. Tap — expected: it works.\n",
      "### iOS\n\n1. Tap.\n\n### Android\n\n1. Swipe.\n",
    );
    const r = composeDevice({ android: FAILED_ANDROID, ios: devicePlatform() }, { scenario: scen });
    const steps = manualLines(r.body);
    assert.ok(
      steps.includes(
        "Run the **iOS** steps in the test scenario on the iOS / Android beta for this commit (a follow-up comment gives the build number) (the device lane ran: PASS).",
      ),
      steps.join("\n"),
    );
    assert.ok(
      steps.some(
        (l) =>
          l.startsWith("Run the **Android** steps") && l.endsWith("(the device lane ran: FAIL)."),
      ),
    );
    // A combined section names each platform; one the lane didn't run isn't annotated.
    const both = composeDevice({ android: FAILED_ANDROID, ios: devicePlatform("running") });
    assert.ok(
      manualLines(both.body).some((l) =>
        l.endsWith("(the device lane ran: Android FAIL, iOS still running)."),
      ),
    );
    const none = composeDevice({ android: devicePlatform("unavailable:no-avd") });
    assert.ok(
      manualLines(none.body).some(
        (l) => l.startsWith("Run the **iOS / Android** steps") && !l.includes("device lane"),
      ),
    );
  });
});

describe("device lane: secrets", () => {
  it("withholds the device lane's text when it carries the device account's password", () => {
    const leaky = devicePlatform("done", {
      verdict: "FAIL",
      flows: [
        {
          name: "01-login.yaml",
          status: "FAIL",
          durationS: 3,
          failure: `typed ${DEVICE_PASSWORD}`,
        },
      ],
    });
    const r = composeDevice(
      { android: leaky, ios: devicePlatform() },
      { images: { device: deviceUpload() } },
    );
    assert.ok(!r.body.includes(DEVICE_PASSWORD));
    assert.deepEqual(r.withheld, { shell: false, browser: false, device: true });
    assert.deepEqual(r.secretHits, ["device:device-password"]);
    assert.match(
      tableRow(r.body, "Android (emulator)"),
      /\| ran \| FAIL \| report withheld \(matched device-password\) \|/,
    );
    assert.match(tableRow(r.body, "iOS (simulator)"), /report withheld/);
    assert.ok(
      deviceLane(r.body).includes(
        "Withheld: matched device-password. The local copy is at `/runs/dev/device-output.json`.",
      ),
    );
    assert.ok(!r.body.includes("01-login.yaml"), "no flow name of a withheld lane");
    assert.equal(imgCount(r.body), 0);
    assert.deepEqual(r.images, { browser: 0, device: 0 });
    assert.ok(
      gapsSection(r.body).includes(
        "- **Devices (Maestro):** report withheld; matched device-password.",
      ),
    );
    assert.match(r.body, /- \*\*Devices:\*\* _withheld \(see the lane table\)_/);
    // The other lanes are untouched.
    assert.match(tableRow(r.body, "Repo & API (shell)"), /full report below/);
  });

  it("withholds it on a secret pattern, and fails closed when the device account file can't be read", () => {
    const key = `dk_${"0123456789abcdef".repeat(3)}`;
    const pattern = devicePlatform("done", {
      flows: [{ name: `01-${key}.yaml`, status: "PASS", durationS: 3, failure: null }],
    });
    const hit = composeDevice({ ios: pattern });
    assert.equal(hit.withheld.device, true);
    assert.deepEqual(hit.secretHits, ["device:drafto-api-key"]);
    assert.ok(!hit.body.includes(key));
    for (const devicePassword of [null, undefined]) {
      const r = composeDevice(
        { ios: devicePlatform() },
        { secrets: { ...SECRETS, devicePassword } },
      );
      assert.equal(r.withheld.device, true);
      assert.deepEqual(r.secretHits, ["device:device-account-file-unreadable"]);
      assert.match(tableRow(r.body, "iOS (simulator)"), /couldn't read the device account file/);
    }
    const never = composeDevice(
      { ios: devicePlatform() },
      { secrets: { ...SECRETS, devicePassword: "" } },
    );
    assert.equal(never.withheld.device, false);
  });

  it("defangs device text: a flow name can't spell a factory marker or close a <details>", () => {
    const r = composeDevice({
      android: devicePlatform("done", {
        flows: [
          {
            name: "<!-- drafto-factory-verify-report --></details>.yaml",
            status: "FAIL",
            durationS: 1,
            failure: "<summary>x</summary> | pipe",
          },
        ],
        verdict: "FAIL",
      }),
    });
    assert.equal(r.body.split(VERIFY_REPORT_MARKER).length, 2, "the marker only once");
    assert.equal(
      (r.body.match(/<\/details>/g) ?? []).length,
      (r.body.match(/<details>/g) ?? []).length,
    );
    assert.equal((r.body.match(/<summary>/g) ?? []).length, 3, "shell, browser and devices only");
  });
});

describe("device lane: screenshots", () => {
  it("aren't embedded while a platform is still running: they follow with the results", () => {
    const r = composeDevice(
      { android: devicePlatform(), ios: devicePlatform("running") },
      { images: { device: deviceUpload() } },
    );
    assert.equal(imgCount(r.body), 0);
    assert.deepEqual(r.images, { browser: 0, device: 0 });
    assert.match(
      r.body,
      /Device screenshots weren't published: the device run hasn't finished; they follow with its results in a separate comment\./,
    );
    // Said even when no upload was tried (the factory doesn't upload mid-run).
    const none = composeDevice({ android: devicePlatform(), ios: devicePlatform("running") });
    assert.match(none.body, /the device run hasn't finished; they follow with its results/);
  });

  it("go inside the device lane's <details>, by platform and flow, and the footer says so", () => {
    const r = composeDevice(
      { android: devicePlatform(), ios: devicePlatform() },
      { images: { device: deviceUpload() } },
    );
    assert.deepEqual(r.images, { browser: 0, device: 2 });
    assert.equal(imgCount(r.body), 2);
    const lane = deviceLane(r.body);
    const l = lane.split("\n");
    const a = l.indexOf("**Android (emulator)** · 01-login.yaml");
    const i = l.indexOf("**iOS (simulator)** · ios-all.yaml");
    assert.ok(a !== -1 && i > a, lane);
    assert.deepEqual(l.slice(a, a + 3), [
      "**Android (emulator)** · 01-login.yaml",
      "",
      deviceImg(1),
    ]);
    assert.deepEqual(l.slice(i, i + 3), ["**iOS (simulator)** · ios-all.yaml", "", deviceImg(2)]);
    assert.ok(
      lane.indexOf("- PASS `01-login.yaml`") < lane.indexOf("**Screenshots**"),
      "after the flows",
    );
    assert.doesNotMatch(webLane(r.body).split("<summary>Devices")[0], /<img/);
    assert.doesNotMatch(r.body.slice(0, r.body.indexOf("<details>")), /<img/);
    assert.ok(
      r.body.includes(
        "<sub>Device screenshots are published in this report (ADR-0096, ADR-0106): the lane's supervisor captured them on the Android emulator / iOS simulator, signed in to the dev device account on dev data. The rest of the device lane's evidence stays on the Mac mini: `/runs/dev`.</sub>",
      ),
    );
    assert.deepEqual(r.body.split("\n").slice(-2), [VERIFY_REPORT_MARKER, verifyShaMarker(SHA)]);
  });

  it("are shown for a run that ended before a platform finished, when its upload published them", () => {
    // Stopped after its first flow: the supervisor saved that flow's shot, and
    // the uploader published it once the run was over.
    const stopped = devicePlatform("stopped:head-moved", {
      flows: [{ name: "01-login.yaml", status: "PASS", durationS: 40, failure: null }],
    });
    const r = composeDevice(
      { android: stopped },
      { images: { device: deviceUpload(["android: 01-login.yaml"]) } },
    );
    assert.equal(imgCount(r.body), 1);
    assert.deepEqual(r.images, { browser: 0, device: 1 });
    assert.ok(deviceLane(r.body).includes("**Android (emulator)** · 01-login.yaml"));
    assert.doesNotMatch(r.body, /Device screenshots weren't published/);
  });

  it("aren't shown for a lane that didn't finish a platform and published nothing, and the footer says why", () => {
    const r = composeDevice(
      { android: devicePlatform("unavailable:no-avd") },
      { images: { device: { ok: false, reason: "push" } } },
    );
    assert.equal(imgCount(r.body), 0);
    assert.match(
      r.body,
      /Devices `\/runs\/dev`\. Device screenshots weren't published: the lane didn't report a result\./,
    );
    const failed = composeDevice(
      { android: devicePlatform() },
      { images: { device: { ok: false, reason: "selftest-failed" } } },
    );
    assert.match(
      failed.body,
      /Device screenshots weren't published: the publishing self-test failed/,
    );
  });
});

describe("device lane: an upload record of another run", () => {
  it("embeds nothing from a record for another commit or another run, and says so", () => {
    for (const extra of [
      { sha: "f".repeat(40) },
      { runId: "device-465-0123456789ab-20261109T000000Z" },
      { runId: DEVICE_RUN },
      { sha: undefined, runId: undefined },
    ]) {
      const r = composeDevice(
        { android: devicePlatform(), ios: devicePlatform() },
        { images: { device: deviceUpload(undefined, extra) } },
      );
      assert.equal(imgCount(r.body), 0, JSON.stringify(extra));
      assert.deepEqual(r.images, { browser: 0, device: 0 });
      assert.match(
        r.body,
        /Device screenshots weren't published: the upload record is for another run or commit\./,
      );
    }
    // An odd run id in the output can't be matched to any record.
    const odd = compose({
      device: {
        output: deviceOutput({ android: devicePlatform() }, { runId: "../x" }),
        dir: "/runs/dev",
      },
      secrets: DEVICE_SECRETS,
      images: { device: deviceUpload() },
    });
    assert.equal(imgCount(odd.body), 0);
  });

  it("embeds this run's record, also one read back from the evidence ref with no labels", () => {
    const recovered = deviceUpload();
    recovered.images = recovered.images.map(({ n, url }) => ({ n, url, local: null, name: null }));
    const r = composeDevice(
      { android: devicePlatform(), ios: devicePlatform() },
      { images: { device: { ...recovered, reused: true } } },
    );
    assert.equal(imgCount(r.body), 2);
    assert.deepEqual(r.images, { browser: 0, device: 2 });
  });
});

describe("device lane: a platform record without a recognised state", () => {
  it("isn't coverage: the manual row stays", () => {
    const before = compose();
    for (const ios of [{}, { state: "" }, { state: "queued" }, { flows: [] }]) {
      const r = compose({
        device: { output: deviceOutput({ ios }), dir: "/runs/dev" },
        secrets: DEVICE_SECRETS,
      });
      assert.equal(r.body, before.body, JSON.stringify(ios));
      assert.deepEqual(r.withheld, { ...before.withheld, device: true });
    }
    // One recognised platform still counts; the other keeps its manual text.
    const mixed = compose({
      device: { output: deviceOutput({ android: devicePlatform(), ios: {} }), dir: "/runs/dev" },
      secrets: DEVICE_SECRETS,
    });
    assert.match(tableRow(mixed.body, "Android (emulator)"), /\| ran \| PASS \|/);
    assert.match(tableRow(mixed.body, "iOS (simulator)"), /\| manual \|/);
  });
});

describe("composeDeviceReport (the follow-up comment)", () => {
  function follow(platforms, over = {}) {
    return composeDeviceReport({
      sha: SHA,
      pr: 701,
      output: deviceOutput(platforms),
      dir: "/runs/dev",
      secrets: { devicePassword: DEVICE_PASSWORD },
      ...over,
    });
  }

  it("its withheld body carries no local path: the run dir can be what matched", () => {
    const r = follow({ android: devicePlatform() }, { dir: "/runs/Bearer abcdefghij1234" });
    assert.ok(r.secretHits.includes("body:bearer"), JSON.stringify(r.secretHits));
    assert.match(r.body, /The rest of this comment was withheld: it matched a secret pattern/);
    assert.ok(!r.body.includes("abcdefghij1234"));
    assert.ok(!r.body.includes("/runs/"), "no run dir");
    assert.deepEqual(r.body.split("\n").slice(-4), [
      "<sub>The full report and the local evidence stay on the Mac mini (the repo is public).</sub>",
      "",
      DEVICE_REPORT_MARKER,
      deviceShaMarker(SHA, DEVICE_RUN),
    ]);
  });

  it("has its header, the device rows and its two markers last", () => {
    const r = follow({ android: FAILED_ANDROID, ios: devicePlatform() });
    const lines = r.body.split("\n");
    assert.equal(lines[0], `🏭 **Device lane results** for \`${SHA.slice(0, 12)}\` (PR #701)`);
    assert.equal(r.verdict, "fail");
    assert.ok(lines.includes("**Verdict: FAIL**"));
    assert.ok(lines.includes("Evidence, not a gate: the card stays where it is."));
    assert.match(tableRow(r.body, "Android (emulator)"), /\| ran \| FAIL \| 1\/2 flows passed/);
    assert.match(tableRow(r.body, "iOS (simulator)"), /\| ran \| PASS \|/);
    assert.deepEqual(lines.slice(-2), [DEVICE_REPORT_MARKER, deviceShaMarker(SHA, DEVICE_RUN)]);
    assert.equal(DEVICE_REPORT_MARKER, "<!-- drafto-factory-device-report -->");
    assert.equal(
      deviceShaMarker(SHA, DEVICE_RUN),
      `<!-- drafto-factory-device-sha:${SHA}:${DEVICE_RUN} -->`,
    );
    assert.ok(!r.body.includes(VERIFY_REPORT_MARKER), "not a verification report");
    assert.deepEqual(r.withheld, { device: false });
    assert.deepEqual(r.secretHits, []);
    assert.ok(
      r.body.includes(
        "<sub>Local evidence stays on the Mac mini (the repo is public): `/runs/dev`.</sub>",
      ),
    );
  });

  it("lists only the platforms the run covered, and says when it was asked for by label", () => {
    const r = follow(
      { ios: devicePlatform("running") },
      {
        output: deviceOutput({ ios: devicePlatform("running") }, { trigger: "on-demand" }),
      },
    );
    assert.equal(tableRow(r.body, "Android (emulator)"), undefined);
    assert.equal(
      tableRow(r.body, "iOS (simulator)"),
      "| iOS (simulator) | running | — | still running when this comment was posted |",
    );
    assert.equal(r.verdict, "incomplete");
    assert.ok(
      r.body.includes("Run on request (the `factory-device-run` label). Evidence, not a gate"),
    );
  });

  it("embeds the shots by platform and flow, with the published footer", () => {
    const r = follow(
      { android: devicePlatform(), ios: devicePlatform() },
      { images: deviceUpload() },
    );
    assert.deepEqual(r.images, { device: 2 });
    assert.ok(
      r.body.indexOf("**Flows**") < r.body.indexOf("**Android (emulator)** · 01-login.yaml"),
    );
    assert.ok(r.body.includes(deviceImg(1)) && r.body.includes(deviceImg(2)));
    assert.match(
      r.body,
      /<sub>Device screenshots are published in this report \(ADR-0096, ADR-0106\)/,
    );
    assert.deepEqual(r.body.split("\n").slice(-2), [
      DEVICE_REPORT_MARKER,
      deviceShaMarker(SHA, DEVICE_RUN),
    ]);
  });

  it("withholds the device text on a secret hit, keeping the markers", () => {
    const r = follow(
      {
        android: devicePlatform("done", {
          flows: [
            { name: "01-login.yaml", status: "FAIL", durationS: 1, failure: DEVICE_PASSWORD },
          ],
          verdict: "FAIL",
        }),
      },
      { images: deviceUpload() },
    );
    assert.ok(!r.body.includes(DEVICE_PASSWORD));
    assert.deepEqual(r.withheld, { device: true });
    assert.deepEqual(r.secretHits, ["device:device-password"]);
    assert.deepEqual(r.images, { device: 0 });
    assert.equal(imgCount(r.body), 0);
    assert.ok(r.body.includes("Withheld: matched device-password."));
    assert.deepEqual(r.body.split("\n").slice(-2), [
      DEVICE_REPORT_MARKER,
      deviceShaMarker(SHA, DEVICE_RUN),
    ]);
  });

  it("refuses another commit's output and a bad sha; an odd run id reads as unknown", () => {
    assert.throws(
      () =>
        follow({}, { output: deviceOutput({ ios: devicePlatform() }, { sha: "f".repeat(40) }) }),
      /another commit/,
    );
    assert.throws(() => follow({}, { sha: "abc" }), /invalid sha/);
    // An output that names no commit is refused too, not taken as this one's.
    for (const sha of [undefined, null, ""]) {
      assert.throws(
        () => follow({}, { output: deviceOutput({ ios: devicePlatform() }, { sha }) }),
        /another commit \(or names none\)/,
      );
    }
    const odd = follow({}, { output: deviceOutput({ ios: devicePlatform() }, { runId: "x -->" }) });
    assert.equal(odd.body.split("\n").at(-1), deviceShaMarker(SHA, "unknown"));
  });
});

describe("composeDeviceReport: platforms that didn't finish", () => {
  const follow = (platforms) =>
    composeDeviceReport({
      sha: SHA,
      pr: 701,
      output: deviceOutput(platforms),
      dir: "/runs/dev",
      secrets: { devicePassword: DEVICE_PASSWORD },
    });

  it("a failed, stopped or unavailable platform makes the verdict at least WARN, and partial", () => {
    for (const state of ["failed:build", "stopped:memory", "unavailable:no-simulator"]) {
      const r = follow({ android: devicePlatform(), ios: devicePlatform(state) });
      assert.equal(r.verdict, "warn", state);
      assert.ok(
        r.body
          .split("\n")
          .includes(
            "**Verdict: WARN**. Partial: a platform didn't finish its flows; see the table.",
          ),
        state,
      );
    }
    const clean = follow({ android: devicePlatform(), ios: devicePlatform() });
    assert.ok(
      clean.body.split("\n").includes("**Verdict: PASS**"),
      "no partial when both finished",
    );
  });

  it("counts the flows a platform ran before it ended: a FAIL among them fails the run", () => {
    const stopped = devicePlatform("stopped:head-moved", {
      flows: [{ name: "01-login.yaml", status: "FAIL", durationS: 3, failure: "boom" }],
    });
    const r = follow({ android: devicePlatform(), ios: stopped });
    assert.equal(r.verdict, "fail");
    assert.match(r.body, /\*\*Verdict: FAIL\*\*\. Partial:/);
    // The verification report counts it the same way.
    assert.equal(composeDevice({ android: devicePlatform(), ios: stopped }).verdict, "fail");
    assert.equal(
      composeDevice({ android: devicePlatform(), ios: devicePlatform("failed:build") }).verdict,
      "warn",
    );
  });

  it("a platform still running counts for nothing yet, but marks the headline partial", () => {
    const r = follow({ android: devicePlatform(), ios: devicePlatform("running") });
    assert.equal(r.verdict, "pass");
    assert.match(r.body, /\*\*Verdict: PASS\*\*\. Partial:/);
  });

  it("reads unavailable:java as a sentence", () => {
    const r = follow({ android: devicePlatform("unavailable:java") });
    assert.equal(
      tableRow(r.body, "Android (emulator)"),
      "| Android (emulator) | unavailable | — | unavailable: the installed JDK isn't one gradle can run on (17–24) |",
    );
  });

  it("withholds (for the upload gate) a run with no platform to show", () => {
    const r = follow({});
    assert.deepEqual(r.withheld, { device: true });
    assert.equal(r.verdict, "incomplete");
  });
});

describe("device lane: --device-state when there is no output for the commit", () => {
  it("says why the lane has no results, beside the beta note", () => {
    for (const [state, want] of [
      [
        "skipped:beta-build",
        /the device lane hadn't started \(a beta build was running\); it runs from In Test and its results follow/,
      ],
      ["skipped:attempts", /its attempts for this commit were spent/],
      [
        "unavailable:no-account",
        /couldn't run: the device lane's dev account file is missing or unusable/,
      ],
      ["skipped:feedback", /the device run was stopped: the card rolled back for feedback/],
      [
        "skipped:after-stopped-threads",
        /ended early \(it was stopped: the card went back to In Review for open review threads\)/,
      ],
      ["running", /still running; its results follow in a separate comment/],
      [
        "skipped:in-followup",
        /the device run's results are already on this issue, in the device lane's own comment/,
      ],
    ]) {
      const row = tableRow(compose({ deviceState: state }).body, "iOS / Android");
      assert.match(row, /^\| iOS \/ Android \| manual \| — \| /, state);
      assert.match(row, want, state);
      assert.match(row, /beta dispatched for this commit/, state);
    }
  });

  it("reads a deferral or a run that gave way as waiting, and says the results follow", () => {
    const follows = "it runs from In Test and its results follow in a separate comment";
    assert.equal(
      deviceStateNote("deferred:stopping"),
      `the device lane hadn't started (an earlier run was still shutting down); ${follows}`,
    );
    assert.equal(
      deviceStateNote("retry:beta-build"),
      `the device run gave way (a beta build was running); ${follows}`,
    );
    assert.equal(
      deviceStateNote("retry:memory"),
      `the device run gave way (the Mac mini was short of memory); ${follows}`,
    );
    assert.doesNotMatch(deviceStateNote("retry:beta-build"), /needed the Mac mini/);
    assert.ok(deviceStateNote("retry:stopped-threads").endsWith(`review threads); ${follows}`));
    assert.ok(deviceStateNote("retry:stopped-conflict").endsWith(`merge conflict); ${follows}`));
  });

  it("promises results only where the retry is sure; otherwise names the attempt cap", () => {
    const retries =
      "the factory tries it again from In Test while it has attempts left (FACTORY_DEVICE_MAX_ATTEMPTS)";
    for (const state of [
      "retry:lost",
      "skipped:after-lost",
      "retry:stopped-head-moved",
      "deferred:platforms-unknown",
      "deferred:pr-unreadable",
    ]) {
      const note = deviceStateNote(state);
      assert.ok(note.endsWith(retries), `${state}: ${note}`);
      assert.doesNotMatch(note, /results follow/, state);
    }
    assert.equal(
      deviceStateNote("deferred:platforms-unknown"),
      `the device lane hadn't started (the PR's changed files couldn't be read); ${retries}`,
    );
  });

  it("an operator's stop sticks: no promise of results", () => {
    assert.equal(
      deviceStateNote("skipped:stopped-stop"),
      "the device run was stopped: it was stopped by hand",
    );
    assert.equal(
      deviceStateNote("skipped:stopped-left-column"),
      "the device run was stopped: the card left Testing and In Test",
    );
  });

  it("adds nothing for a lane that is off, not applicable, or reported", () => {
    const before = compose().body;
    for (const state of [
      "",
      "none",
      "skipped:lane-off",
      "skipped:not-built",
      "skipped:verification-off",
      "skipped:not-applicable",
      "reported:pass",
    ]) {
      assert.equal(compose({ deviceState: state }).body, before, state);
      assert.equal(deviceStateNote(state), null, state);
    }
  });

  it("is ignored when the device output covers the commit", () => {
    const withState = composeDevice({ ios: devicePlatform() }, { deviceState: "skipped:attempts" });
    assert.doesNotMatch(withState.body, /attempts for this commit were spent/);
    assert.match(tableRow(withState.body, "iOS (simulator)"), /\| ran \| PASS \|/);
  });

  it("explains a stale run's output the same way", () => {
    const r = compose({
      device: {
        output: deviceOutput({ ios: devicePlatform() }, { sha: "f".repeat(40) }),
        dir: "/runs/dev",
      },
      deviceState: "skipped:attempts",
      secrets: DEVICE_SECRETS,
    });
    assert.match(tableRow(r.body, "iOS / Android"), /attempts for this commit were spent/);
  });
});

describe("verify-report CLI: the device lane", () => {
  let dir;
  const run = (argv) => spawnSync(process.execPath, [cli, ...argv], { encoding: "utf8" });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verify-report-device-"));
    mkdirSync(join(dir, "run"));
    writeFileSync(
      join(dir, "run", "device-output.json"),
      JSON.stringify(deviceOutput({ android: FAILED_ANDROID, ios: devicePlatform() })),
    );
    writeFileSync(join(dir, "upload.json"), JSON.stringify(deviceUpload()));
    writeFileSync(
      join(dir, "device-account.env"),
      `E2E_TEST_EMAIL=device@example.com\nE2E_TEST_PASSWORD=${DEVICE_PASSWORD}\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(dir, "scenario.md"), scenario({ web: false, mac: false }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const verifyArgs = (extra) => [
    "render",
    "--issue",
    "465",
    "--pr",
    "701",
    "--sha",
    SHA,
    "--scenario-file",
    join(dir, "scenario.md"),
    "--platforms",
    '{"web":false,"mobile":true,"desktop":false}',
    "--beta-lanes",
    "mobile",
    "--shell-state",
    "none",
    "--shell-dir",
    "",
    "--browser-state",
    "none",
    "--browser-dir",
    "",
    "--gaps",
    "[]",
    "--cr-note",
    "",
    "--account-file",
    "",
    "--bypass-file",
    "",
    "--signin-key-file",
    "",
    "--out",
    join(dir, "body.md"),
    ...extra,
  ];

  it("render --device-out / --device-images put the device rows and shots in the report", () => {
    const r = run(
      verifyArgs([
        "--device-out",
        join(dir, "run", "device-output.json"),
        "--device-images",
        join(dir, "upload.json"),
        "--device-account-file",
        join(dir, "device-account.env"),
      ]),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      verdict: "fail",
      withheld: { shell: false, browser: false, device: false },
      secretHits: [],
      images: { browser: 0, device: 2 },
    });
    const body = readFileSync(join(dir, "body.md"), "utf8");
    assert.match(tableRow(body, "Android (emulator)"), /\| ran \| FAIL \|/);
    assert.ok(deviceLane(body).includes(deviceImg(1)));
    assert.ok(body.includes(`\`${join(dir, "run")}\``), "the run dir is the lane's local evidence");
  });

  it("render --device-state explains the device rows without --device-out", () => {
    const r = run(verifyArgs(["--device-state", "deferred:beta-build"]));
    assert.equal(r.status, 0, r.stderr);
    const body = readFileSync(join(dir, "body.md"), "utf8");
    assert.match(
      tableRow(body, "iOS / Android"),
      /the device lane hadn't started \(a beta build was running\); it runs from In Test and its results follow in a separate comment; beta dispatched/,
    );
  });

  it("render without --device-out is the report as before; an unreadable one falls back to manual", () => {
    const off = run(verifyArgs([]));
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(JSON.parse(off.stdout).withheld, { shell: false, browser: false });
    const before = readFileSync(join(dir, "body.md"), "utf8");
    assert.match(tableRow(before, "iOS / Android"), /\| manual \|/);
    const missing = run(
      verifyArgs(["--device-out", join(dir, "nope.json"), "--device-account-file", ""]),
    );
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(readFileSync(join(dir, "body.md"), "utf8"), before);
    // Withheld, so evidence-upload's gate publishes no device shots for it.
    assert.equal(JSON.parse(missing.stdout).withheld.device, true);
    writeFileSync(join(dir, "corrupt.json"), "{not json");
    const corrupt = run(
      verifyArgs(["--device-out", join(dir, "corrupt.json"), "--device-account-file", ""]),
    );
    assert.equal(JSON.parse(corrupt.stdout).withheld.device, true);
  });

  it("render fails the device lane closed when --device-account-file is left out", () => {
    const r = run(verifyArgs(["--device-out", join(dir, "run", "device-output.json")]));
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.withheld.device, true);
    assert.deepEqual(out.secretHits, ["device:device-account-file-unreadable"]);
  });

  it("render --kind device writes the follow-up comment and prints its JSON line", () => {
    const argv = [
      "render",
      "--kind",
      "device",
      "--issue",
      "465",
      "--pr",
      "701",
      "--sha",
      SHA,
      "--device-out",
      join(dir, "run", "device-output.json"),
      "--device-images",
      join(dir, "upload.json"),
      "--device-account-file",
      join(dir, "device-account.env"),
      "--out",
      join(dir, "follow.md"),
    ];
    const r = run(argv);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      verdict: "fail",
      withheld: { device: false },
      secretHits: [],
      images: { device: 2 },
    });
    const body = readFileSync(join(dir, "follow.md"), "utf8");
    assert.deepEqual(body.split("\n").slice(-2), [
      DEVICE_REPORT_MARKER,
      deviceShaMarker(SHA, DEVICE_RUN),
    ]);

    const other = run(argv.map((a) => (a === SHA ? "f".repeat(40) : a)));
    assert.equal(other.status, 1);
    assert.match(JSON.parse(other.stderr).error, /another commit/);
    const unreadable = run(
      argv.map((a) => (a.endsWith("device-output.json") ? join(dir, "nope.json") : a)),
    );
    assert.equal(unreadable.status, 1);
    assert.equal(run(["render", "--kind", "bogus"]).status, 2);
    assert.equal(
      run(argv.filter((a, i) => a !== "--device-out" && argv[i - 1] !== "--device-out")).status,
      2,
    );
  });
});

describe("device lane: the scenario's steps (phase b)", () => {
  const withScenario = (over = {}) =>
    devicePlatform("done", {
      flows: [
        { name: "ios-all.yaml", status: "PASS", durationS: 90, failure: null },
        {
          name: "scenario: 01-create-notebook.yaml",
          status: "FAIL",
          durationS: 30,
          failure: "x",
          dispatched: true,
        },
      ],
      verdict: "FAIL",
      scenarioState: "done",
      scenarioSummary: "## Scenario steps (ios)\n\n- FAIL — create a notebook: not in the list",
      ...over,
    });

  it("shows the scenario rows as flows and the summary under the platform", () => {
    for (const r of [
      composeDeviceReport({
        sha: SHA,
        pr: 701,
        output: deviceOutput({ ios: withScenario() }),
        dir: "/runs/dev",
        secrets: { devicePassword: DEVICE_PASSWORD },
      }),
      composeDevice({ ios: withScenario() }),
    ]) {
      assert.match(r.body, /- FAIL `scenario: 01-create-notebook\.yaml` \(30 s\): x/);
      assert.match(r.body, /_Scenario steps: done\. A guarded session wrote the `scenario:` flows/);
      assert.match(r.body, /- FAIL — create a notebook: not in the list/);
      assert.match(tableRow(r.body, "iOS (simulator)"), /1\/2 flows passed/);
    }
  });

  it("says when the session hit a cap, and shows no summary it didn't have", () => {
    const r = composeDevice({
      ios: withScenario({ scenarioState: "timeout", scenarioSummary: undefined }),
    });
    assert.match(r.body, /_Scenario steps: stopped at its time or run cap\./);
    assert.doesNotMatch(r.body, /create a notebook: not in the list/);
  });

  it("says when the session was skipped for time", () => {
    const r = composeDevice({
      ios: withScenario({
        scenarioState: "skipped:time",
        scenarioSummary: undefined,
        flows: [{ name: "ios-all.yaml", status: "PASS", durationS: 90, failure: null }],
      }),
    });
    assert.match(r.body, /_Scenario steps: skipped: too little of the run was left\._/);
  });

  it("names the session as the flows' author only when there are scenario rows", () => {
    const phaseA = [{ name: "ios-all.yaml", status: "PASS", durationS: 90, failure: null }];
    for (const state of ["done", "timeout", "stopped", "skipped:time", "error"]) {
      const r = composeDevice({
        ios: withScenario({ scenarioState: state, scenarioSummary: undefined, flows: phaseA }),
      });
      // A session that left no flows: its state, and no claim about flows.
      assert.doesNotMatch(r.body, /A guarded session wrote/, state);
      assert.doesNotMatch(r.body, /ran them again/, state);
      assert.match(r.body, /_Scenario steps: [^_]+\._/, state);
    }
    // An error after the session wrote flows still says who wrote them.
    const r = composeDevice({ ios: withScenario({ scenarioState: "error" }) });
    assert.match(r.body, /_Scenario steps: failed\. A guarded session wrote/);
  });

  it("claims the final re-run only for flows the supervisor ran", () => {
    const row = (name, extra) => ({ name, status: "ERROR", durationS: 0, failure: "x", ...extra });
    const rejected = row("scenario: 01-bad.yaml", {
      failure: "rejected by the validator: commands[0]: nope",
    });
    const ran = row("scenario: 02-ok.yaml", { status: "PASS", failure: null, dispatched: true });
    const body = (flows) => composeDevice({ ios: withScenario({ flows }) }).body;
    const none = body([rejected]);
    assert.doesNotMatch(none, /ran them again/);
    assert.match(none, /none passed the supervisor's validation, so none ran\._/);
    assert.match(body([rejected, ran]), /ran the valid ones again after the session ended\._/);
    assert.match(body([ran]), /validated them and ran them again after the session ended\._/);
    // A row that only claims to be dispatched with a non-boolean doesn't count.
    assert.match(body([{ ...ran, dispatched: "yes" }]), /none passed/);
  });

  it("scans the summary: a secret in it withholds the device text", () => {
    const r = composeDevice({
      ios: withScenario({ scenarioSummary: `typed ${DEVICE_PASSWORD} into a note` }),
    });
    assert.ok(!r.body.includes(DEVICE_PASSWORD));
    assert.equal(r.withheld.device, true);
  });

  it("defangs the summary: no markers, no details tags", () => {
    const r = composeDevice({
      ios: withScenario({
        scenarioSummary: "</details><!-- drafto-factory-device-report --> ```\nopen fence",
      }),
    });
    assert.ok(!r.body.includes("</details><!-- drafto-factory-device-report"));
    assert.equal(
      r.body.split("\n").filter((l) => l === DEVICE_REPORT_MARKER).length,
      0,
      "no second device marker",
    );
  });
});
