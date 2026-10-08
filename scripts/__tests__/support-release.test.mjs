import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  betaPlatformsForFiles,
  laneForPlatform,
  windowStartDate,
  recordReleaseAttempt,
  resetReleaseAttempts,
  releaseFailures,
  pendingPlatformsForIssue,
  summarizePending,
  latestCheckOutcomes,
  evaluateChecks,
  computePending,
  waitForMainCi,
  settle,
  gaveUpComment,
  loadReleaseState,
  _setExecFileForTests,
  _setSleepForTests,
} from "../lib/support-release.mjs";
import { nowLiveFingerprint, hasNowLive } from "../lib/now-live.mjs";

// Tests for the decisions behind nightly-support.sh Phase 4 (ADR-0042): which
// merged support fixes still need a beta, whether main is green, and what a
// finished lane delivered. Every gh / git call goes through the injected exec —
// a unit test that reaches the real GitHub API is a bug.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_CLI = path.resolve(HERE, "..", "lib", "state-cli.mjs");
const PROGRESS = "<!-- drafto-progress -->";

let workdir;
let stateFile;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "support-release-test-"));
  stateFile = path.join(workdir, "support-release-state.json");
});
afterEach(() => {
  _setExecFileForTests(null);
  _setSleepForTests(null);
  rmSync(workdir, { recursive: true, force: true });
});

// A scripted gh/git: `routes` maps a predicate over the argv string to a
// stdout (string / object → JSON) or an Error to throw. Unmatched calls fail
// loudly so a new, unmocked call can't silently pass.
function fakeExec(routes, calls = []) {
  return async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    for (const [match, reply] of routes) {
      if (typeof match === "string" ? line.includes(match) : match.test(line)) {
        const r = typeof reply === "function" ? reply(line) : reply;
        if (r instanceof Error) throw r;
        return { stdout: typeof r === "string" ? r : JSON.stringify(r) };
      }
    }
    throw new Error(`unmocked call: ${line}`);
  };
}

const nowLive = (platform, build, at) => ({
  body: `Now live in TestFlight (build ${build}). ${PROGRESS} ${nowLiveFingerprint(platform, build)}`,
  created_at: at,
});

describe("pure helpers", () => {
  it("maps changed files to beta platforms (shared → both apps, web → none)", () => {
    assert.deepEqual(betaPlatformsForFiles(["apps/mobile/src/a.ts"]), ["android", "ios"]);
    assert.deepEqual(betaPlatformsForFiles(["apps/desktop/src/a.ts"]), ["macos"]);
    assert.deepEqual(betaPlatformsForFiles(["packages/shared/src/a.ts"]), [
      "android",
      "ios",
      "macos",
    ]);
    assert.deepEqual(betaPlatformsForFiles(["apps/web/src/a.ts", "docs/x.md"]), []);
  });

  it("maps platforms to the lane that builds them", () => {
    assert.equal(laneForPlatform("android"), "mobile");
    assert.equal(laneForPlatform("ios"), "mobile");
    assert.equal(laneForPlatform("macos"), "desktop");
    assert.equal(laneForPlatform("web"), null);
  });

  it("computes the search window start as a UTC date", () => {
    assert.equal(windowStartDate("2026-10-08T01:00:00Z", 14), "2026-09-24");
  });

  it("counts failures and resets them on success", () => {
    const state = { issues: {} };
    recordReleaseAttempt(state, 658, "ios", "fail", "t1");
    recordReleaseAttempt(state, 658, "ios", "fail", "t2");
    assert.equal(releaseFailures(state, 658, "ios"), 2);
    assert.equal(releaseFailures(state, 658, "android"), 0);
    const rec = recordReleaseAttempt(state, 658, "ios", "ok", "t3");
    assert.deepEqual(rec, { failures: 0, lastAttemptAt: "t3", lastResult: "ok" });
    resetReleaseAttempts(state, 658);
    assert.equal(state.issues["658"].releaseAttempts, undefined);
  });

  it("scopes the failure budget to the issue's current close", () => {
    const state = { issues: {} };
    const first = "2026-09-01T00:00:00Z";
    for (const t of ["t1", "t2", "t3"]) {
      recordReleaseAttempt(state, 658, "ios", "fail", t, { closedAt: first });
    }
    assert.equal(releaseFailures(state, 658, "ios", { closedAt: first }), 3);
    // Reopened and fixed again: the old budget no longer applies…
    const second = "2026-10-05T00:00:00Z";
    assert.equal(releaseFailures(state, 658, "ios", { closedAt: second }), 0);
    // …and the next failure starts the new fix's count at 1.
    const rec = recordReleaseAttempt(state, 658, "ios", "fail", "t4", { closedAt: second });
    assert.deepEqual(rec, {
      failures: 1,
      lastAttemptAt: "t4",
      lastResult: "fail",
      closedAt: second,
    });
  });

  it("rejects an unknown result or platform", () => {
    assert.throws(() => recordReleaseAttempt({}, 1, "ios", "maybe", "t"), /ok\|fail/);
    assert.throws(() => recordReleaseAttempt({}, 1, "web", "ok", "t"), /unknown release platform/);
  });

  it("announces once per platform — any build counts, but only since the latest close", () => {
    const comments = [nowLive("ios", 50, "2026-10-01T00:00:00Z")];
    assert.equal(hasNowLive(comments, "ios"), true);
    assert.equal(hasNowLive(comments, "android"), false);
    assert.equal(hasNowLive(comments, "ios", { since: "2026-09-30T00:00:00Z" }), true);
    // Reopened and fixed again: the old notice was for the old fix.
    assert.equal(hasNowLive(comments, "ios", { since: "2026-10-05T00:00:00Z" }), false);
  });
});

describe("pendingPlatformsForIssue", () => {
  const issue = { number: 658, closedAt: "2026-10-05T22:25:31Z" };
  const mergedMobile = { state: "MERGED", baseRefName: "main", files: ["apps/mobile/x.ts"] };

  it("wants every platform a merged closing PR touched", () => {
    const got = pendingPlatformsForIssue({
      issue,
      prs: [mergedMobile, { state: "MERGED", baseRefName: "main", files: ["apps/desktop/y.ts"] }],
      comments: [],
      state: {},
      maxFailures: 3,
    });
    assert.deepEqual(got, ["android", "ios", "macos"]);
  });

  it("ignores PRs that are not merged into main", () => {
    const got = pendingPlatformsForIssue({
      issue,
      prs: [
        { state: "OPEN", baseRefName: "main", files: ["apps/mobile/x.ts"] },
        { state: "MERGED", baseRefName: "release", files: ["apps/desktop/x.ts"] },
      ],
      comments: [],
      state: {},
      maxFailures: 3,
    });
    assert.deepEqual(got, []);
  });

  it("drops a platform already announced since the close", () => {
    const got = pendingPlatformsForIssue({
      issue,
      prs: [mergedMobile],
      comments: [nowLive("android", 77, "2026-10-06T01:00:00Z")],
      state: {},
      maxFailures: 3,
    });
    assert.deepEqual(got, ["ios"]);
  });

  it("drops a platform that has used up its failure budget", () => {
    const state = { issues: { 658: { releaseAttempts: { ios: { failures: 3 } } } } };
    const got = pendingPlatformsForIssue({
      issue,
      prs: [mergedMobile],
      comments: [],
      state,
      maxFailures: 3,
    });
    assert.deepEqual(got, ["android"]);
  });
});

describe("summarizePending", () => {
  it("scopes --release-issues per lane so a mobile fix is not announced by the macOS build", () => {
    const out = summarizePending("a".repeat(40), [
      { number: 661, platforms: ["macos"] },
      { number: 658, platforms: ["android", "ios"] },
      { number: 700, platforms: [] },
    ]);
    assert.deepEqual(out.lanes, { mobile: true, desktop: true });
    assert.deepEqual(out.laneIssues, { mobile: "658", desktop: "661" });
    assert.equal(out.releaseIssues, "658,661");
    assert.deepEqual(
      out.issues.map((i) => i.number),
      [661, 658],
    );
  });

  it("reports no lanes when nothing is pending", () => {
    const out = summarizePending(null, []);
    assert.deepEqual(out.lanes, { mobile: false, desktop: false });
    assert.equal(out.releaseIssues, "");
  });
});

describe("computePending (injected gh)", () => {
  const SHA = "e".repeat(40);
  const routes = ({ comments658 = [], extra = [] } = {}) => [
    [
      "gh issue list --repo JakubAnderwald/drafto --label support --state closed --search closed:>=",
      [
        { number: 658, stateReason: "COMPLETED", closedAt: "2026-10-05T22:25:31Z" },
        { number: 659, stateReason: "NOT_PLANNED", closedAt: "2026-10-05T22:00:00Z" },
        { number: 662, stateReason: "COMPLETED", closedAt: "2026-10-04T10:00:00Z" },
      ],
    ],
    [
      "gh issue view 658 ",
      {
        closedByPullRequestsReferences: [
          { number: 661, repository: { name: "drafto", owner: { login: "JakubAnderwald" } } },
          { number: 9, repository: { name: "other", owner: { login: "someone" } } },
        ],
      },
    ],
    ["gh pr view 661 ", { number: 661, state: "MERGED", baseRefName: "main" }],
    ["gh pr diff 661 ", "apps/mobile/app/notes/[id].tsx\napps/mobile/src/lib/editor-css.ts\n"],
    // #662 was closed by a web-only PR: no beta, and no comment fetch needed.
    ["gh issue view 662 ", { closedByPullRequestsReferences: [{ number: 663 }] }],
    ["gh pr view 663 ", { number: 663, state: "MERGED", baseRefName: "main" }],
    ["gh pr diff 663 ", "apps/web/src/a.ts\n"],
    ["gh api --paginate repos/JakubAnderwald/drafto/issues/658/comments", comments658],
    ["gh api repos/JakubAnderwald/drafto/commits/main --jq .sha", `${SHA}\n`],
    ...extra,
  ];

  it("selects completed issues in the window and maps their PR's platforms", async () => {
    const calls = [];
    _setExecFileForTests(fakeExec(routes(), calls));
    const out = await computePending({
      windowDays: 14,
      statePath: stateFile,
      now: new Date("2026-10-08T01:00:00Z"),
    });
    assert.equal(out.sha, SHA);
    assert.deepEqual(out.issues, [
      { number: 658, closedAt: "2026-10-05T22:25:31Z", platforms: ["android", "ios"] },
    ]);
    assert.deepEqual(out.laneIssues, { mobile: "658", desktop: "" });
    assert.deepEqual(out.expired, []);
    assert.deepEqual(out.errors, []);
    // 14-day window + 3 grace days, searched only to flag fixes that ran out of it.
    assert.ok(
      calls.some((c) => c.includes("closed:>=2026-09-21")),
      "window + grace",
    );
    assert.ok(!calls.some((c) => c.includes("issue view 659")), "not-planned is never examined");
    assert.ok(!calls.some((c) => c.includes("pr view 9 ")), "PRs from other repos are ignored");
    assert.ok(!calls.some((c) => c.includes("issues/662/comments")), "web-only fix skips comments");
  });

  it("drops an issue once every platform is announced, and skips the sha lookup", async () => {
    const calls = [];
    _setExecFileForTests(
      fakeExec(
        routes({
          comments658: [
            nowLive("android", 90, "2026-10-06T00:00:00Z"),
            nowLive("ios", 91, "2026-10-06T00:10:00Z"),
          ],
        }),
        calls,
      ),
    );
    const out = await computePending({
      statePath: stateFile,
      now: new Date("2026-10-08T01:00:00Z"),
    });
    assert.deepEqual(out.issues, []);
    assert.equal(out.sha, null);
    assert.ok(!calls.some((c) => c.includes("commits/main")));
  });

  it("honours the failure budget recorded in the release state", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ issues: { 658: { releaseAttempts: { android: { failures: 3 } } } } }),
    );
    _setExecFileForTests(fakeExec(routes()));
    const out = await computePending({
      statePath: stateFile,
      now: new Date("2026-10-08T01:00:00Z"),
    });
    assert.deepEqual(out.issues[0].platforms, ["ios"]);
  });

  it("falls back to git ls-remote when the gh sha lookup fails", async () => {
    _setExecFileForTests(
      fakeExec([
        ["commits/main --jq .sha", new Error("rate limited")],
        ["git ls-remote origin refs/heads/main", `${"f".repeat(40)}\trefs/heads/main\n`],
        ...routes(),
      ]),
    );
    const out = await computePending({
      statePath: stateFile,
      now: new Date("2026-10-08T01:00:00Z"),
    });
    assert.equal(out.sha, "f".repeat(40));
  });

  it("propagates a failed issue search (the caller retries next night)", async () => {
    _setExecFileForTests(fakeExec([["gh issue list", new Error("HTTP 502")]]));
    await assert.rejects(computePending({ statePath: stateFile }), /HTTP 502/);
  });

  it("skips one issue whose lookup fails instead of failing the whole list", async () => {
    _setExecFileForTests(
      fakeExec([
        // #662's diff is too large for `gh pr diff`: only #662 is lost tonight.
        ["gh pr diff 663 ", new Error("HTTP 406: diff too large")],
        ...routes(),
      ]),
    );
    const out = await computePending({
      statePath: stateFile,
      now: new Date("2026-10-08T01:00:00Z"),
    });
    assert.deepEqual(
      out.issues.map((i) => i.number),
      [658],
    );
    assert.deepEqual(out.errors, [{ number: 662, error: "HTTP 406: diff too large" }]);
  });

  describe("fixes that ran out of the window", () => {
    // Now is 2026-10-21: #658 (closed 10-05) is 15+ days old — past the 14-day
    // window but inside the 3-day grace, never shipped.
    const now = new Date("2026-10-21T01:00:00Z");

    it("are not built, and are listed for flagging", async () => {
      _setExecFileForTests(fakeExec(routes()));
      const out = await computePending({ statePath: stateFile, now });
      assert.deepEqual(out.issues, []);
      assert.deepEqual(out.expired, [
        {
          number: 658,
          closedAt: "2026-10-05T22:25:31Z",
          platforms: ["android", "ios"],
          alreadyFlagged: false,
        },
      ]);
      assert.equal(out.sha, null);
    });

    it("--flag-expired labels them and leaves one operator comment (no progress marker)", async () => {
      let body = "";
      _setExecFileForTests(
        fakeExec([
          [
            "gh issue edit 658 --repo JakubAnderwald/drafto --add-label needs-manual-intervention",
            "",
          ],
          [
            "gh issue comment 658",
            (line) => {
              body = line;
              return "";
            },
          ],
          ...routes(),
        ]),
      );
      const out = await computePending({ statePath: stateFile, now, flagExpired: true });
      assert.equal(out.expired[0].flagged, true);
      assert.match(body, /window closed — android, ios never shipped/);
      assert.match(body, /drafto-nightly-release-expired:2026-10-05T22:25:31Z/);
      assert.ok(!body.includes(PROGRESS), "operator-only: never forwarded to the reporter");
    });

    it("are flagged only once", async () => {
      const calls = [];
      _setExecFileForTests(
        fakeExec(
          routes({
            comments658: [
              {
                body: "x <!-- drafto-nightly-release-expired:2026-10-05T22:25:31Z -->",
                created_at: "2026-10-20T00:00:00Z",
              },
            ],
          }),
          calls,
        ),
      );
      const out = await computePending({ statePath: stateFile, now, flagExpired: true });
      assert.equal(out.expired[0].alreadyFlagged, true);
      assert.ok(
        !calls.some((c) => c.startsWith("gh issue comment") || c.startsWith("gh issue edit")),
      );
    });
  });
});

describe("main CI evaluation", () => {
  it("takes the newest run per check name", () => {
    const out = latestCheckOutcomes({
      checkRuns: [
        { id: 1, name: "E2E Tests", status: "completed", conclusion: "failure" },
        { id: 2, name: "E2E Tests", status: "completed", conclusion: "success" },
        { id: 3, name: "Lint", status: "in_progress", conclusion: null },
        { id: 4, name: "Skipped", status: "completed", conclusion: "skipped" },
      ],
      statuses: [{ context: "Vercel", state: "pending" }],
    });
    assert.deepEqual(out, {
      "E2E Tests": "pass",
      Lint: "pending",
      Skipped: "pass",
      Vercel: "pending",
    });
  });

  it("judges only the required contexts when they are known", () => {
    const outcomes = { A: "pass", B: "pass", Advisory: "fail" };
    assert.equal(evaluateChecks({ required: ["A", "B"], outcomes }), "green");
    assert.equal(
      evaluateChecks({ required: ["A", "C"], outcomes }),
      "pending",
      "missing = pending",
    );
    assert.equal(evaluateChecks({ required: ["A", "Advisory"], outcomes }), "failed");
  });

  it("falls back to every check, and never calls 'no checks' green", () => {
    assert.equal(evaluateChecks({ required: [], outcomes: {} }), "pending");
    assert.equal(evaluateChecks({ required: [], outcomes: { A: "pass" } }), "green");
    assert.equal(evaluateChecks({ required: [], outcomes: { A: "pass", B: "fail" } }), "failed");
  });
});

describe("waitForMainCi (injected gh + clock)", () => {
  const SHA = "c".repeat(40);
  function harness(checkReplies) {
    let t = 0;
    let poll = 0;
    _setSleepForTests(async (ms) => {
      t += ms;
    });
    _setExecFileForTests(
      fakeExec([
        ["protection/required_status_checks", { contexts: ["Lint"], checks: [{ context: "E2E" }] }],
        [
          `commits/${SHA}/check-runs`,
          () => {
            const reply = checkReplies[Math.min(poll, checkReplies.length - 1)];
            poll += 1;
            return reply;
          },
        ],
        [`commits/${SHA}/status`, { statuses: [] }],
      ]),
    );
    return { clock: () => t, polls: () => poll };
  }
  const run = (id, name, status, conclusion) =>
    JSON.stringify({ id, name, status, conclusion }) + "\n";

  it("returns green once every required check passes", async () => {
    const h = harness([
      run(1, "Lint", "completed", "success") + run(2, "E2E", "in_progress", null),
      run(1, "Lint", "completed", "success") + run(2, "E2E", "completed", "success"),
    ]);
    const out = await waitForMainCi({ sha: SHA, waitMs: 60_000, intervalMs: 1000, clock: h.clock });
    assert.equal(out.result, "green");
    assert.equal(h.polls(), 2);
  });

  it("returns failed as soon as a required check fails", async () => {
    const h = harness([
      run(1, "Lint", "completed", "failure") + run(2, "E2E", "in_progress", null),
    ]);
    const out = await waitForMainCi({ sha: SHA, waitMs: 60_000, intervalMs: 1000, clock: h.clock });
    assert.equal(out.result, "failed");
    assert.equal(h.polls(), 1);
  });

  it("times out while a required check stays pending (and survives a failed poll)", async () => {
    const h = harness([new Error("HTTP 500"), run(1, "Lint", "completed", "success")]);
    const out = await waitForMainCi({ sha: SHA, waitMs: 5000, intervalMs: 1000, clock: h.clock });
    assert.equal(out.result, "timeout", "E2E never reported");
    assert.ok(h.polls() >= 5);
  });
});

describe("main-ci CLI exit codes", () => {
  const CLI = path.resolve(HERE, "..", "lib", "support-release.mjs");
  it("rejects a non-sha argument with exit 3 — a tool error, never 'CI failed' (1)", () => {
    const r = spawnSync("node", [CLI, "main-ci", "main;rm"], { encoding: "utf8" });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /requires a commit sha/);
  });
});

describe("settle (injected gh)", () => {
  const pending = {
    sha: "a".repeat(40),
    issues: [
      { number: 658, closedAt: "2026-10-05T22:25:31Z", platforms: ["android", "ios"] },
      { number: 661, closedAt: "2026-10-05T10:00:00Z", platforms: ["macos"] },
    ],
  };

  it("records ok where the notice appeared and fail where it did not", async () => {
    const calls = [];
    _setExecFileForTests(
      fakeExec(
        [
          [
            "issues/658/comments",
            [
              nowLive("android", 95, "2026-10-08T01:30:00Z"),
              { body: "unrelated", created_at: "x" },
            ],
          ],
        ],
        calls,
      ),
    );
    const out = await settle({
      pending,
      lanes: { mobile: "1" },
      logs: { mobile: "/logs/beta-lane-mobile.log" },
      statePath: stateFile,
      now: "2026-10-08T02:00:00Z",
    });
    assert.deepEqual(
      out.settled.map((e) => [e.number, e.platform, e.result, e.failures]),
      [
        [658, "android", "ok", 0],
        [658, "ios", "fail", 1],
      ],
    );
    assert.ok(!calls.some((c) => c.includes("661")), "desktop lane did not run: #661 untouched");
    const state = await loadReleaseState(stateFile);
    assert.equal(state.issues["658"].releaseAttempts.ios.failures, 1);
    assert.equal(state.issues["658"].releaseAttempts.ios.closedAt, "2026-10-05T22:25:31Z");
    assert.equal(state.issues["661"], undefined);
    assert.equal((statSync(stateFile).mode & 0o777).toString(8), "600");
  });

  it("flags a lane that exited 0 without announcing anything", async () => {
    _setExecFileForTests(fakeExec([["issues/661/comments", []]]));
    const out = await settle({ pending, lanes: { desktop: "0" }, statePath: stateFile });
    assert.equal(out.settled[0].result, "fail");
    assert.match(out.settled[0].reason, /exited 0 but posted no now-live notice/);
  });

  it("gives up at the budget: label + one operator comment without the progress marker", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ issues: { 661: { releaseAttempts: { macos: { failures: 2 } } } } }),
    );
    const calls = [];
    let posted = "";
    _setExecFileForTests(
      fakeExec(
        [
          ["issues/661/comments", []],
          [
            "gh issue edit 661 --repo JakubAnderwald/drafto --add-label needs-manual-intervention",
            "",
          ],
          [
            "gh issue comment 661",
            (line) => {
              posted = line;
              return "";
            },
          ],
        ],
        calls,
      ),
    );
    const out = await settle({
      pending,
      lanes: { desktop: "killed-cap" },
      logs: { desktop: "/logs/beta-lane-desktop.log" },
      statePath: stateFile,
    });
    assert.equal(out.settled[0].gaveUp, true);
    assert.equal(out.settled[0].failures, 3);
    assert.ok(calls.some((c) => c.includes("--add-label needs-manual-intervention")));
    assert.match(posted, /\/logs\/beta-lane-desktop\.log/);
    assert.match(posted, /reset-release-attempts 661/);
    assert.ok(!posted.includes(PROGRESS), "operator comment must not be forwarded to the reporter");
  });

  it("does not repeat the give-up comment when its marker is already there", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ issues: { 661: { releaseAttempts: { macos: { failures: 5 } } } } }),
    );
    const marker = gaveUpComment({
      issueNumber: 661,
      platform: "macos",
      failures: 3,
      laneResult: "1",
      logPath: "/x",
      closedAt: "2026-10-05T10:00:00Z",
    })
      .split("\n")
      .pop();
    const calls = [];
    _setExecFileForTests(
      fakeExec(
        [
          ["issues/661/comments", [{ body: `old\n${marker}`, created_at: "2026-10-07T00:00:00Z" }]],
          ["gh issue edit 661", ""],
        ],
        calls,
      ),
    );
    await settle({ pending, lanes: { desktop: "1" }, statePath: stateFile });
    assert.ok(!calls.some((c) => c.startsWith("gh issue comment")));
  });

  it("records nothing when the comments cannot be read", async () => {
    _setExecFileForTests(fakeExec([["issues/661/comments", new Error("HTTP 502")]]));
    const out = await settle({ pending, lanes: { desktop: "0" }, statePath: stateFile });
    assert.equal(out.settled[0].result, "unknown");
    assert.throws(() => readFileSync(stateFile), /ENOENT/, "no state written");
  });
});

describe("state-cli release-attempt subcommands", () => {
  const run = (args) => spawnSync("node", [STATE_CLI, ...args], { encoding: "utf8" });

  it("counts failures, resets on ok, and writes only the release state file", () => {
    let r = run([
      "record-release-attempt",
      "658",
      "ios",
      "fail",
      "--state-file",
      stateFile,
      "--now",
      "t1",
    ]);
    assert.equal(r.status, 0, r.stderr);
    r = run([
      "record-release-attempt",
      "658",
      "ios",
      "fail",
      "--state-file",
      stateFile,
      "--now",
      "t2",
    ]);
    assert.equal(JSON.parse(r.stdout).failures, 2);
    r = run([
      "record-release-attempt",
      "658",
      "android",
      "ok",
      "--state-file",
      stateFile,
      "--now",
      "t3",
    ]);
    assert.deepEqual(JSON.parse(r.stdout), {
      ok: true,
      issueNumber: "658",
      platform: "android",
      failures: 0,
      lastAttemptAt: "t3",
      lastResult: "ok",
    });
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(state.issues["658"].releaseAttempts.ios, {
      failures: 2,
      lastAttemptAt: "t2",
      lastResult: "fail",
    });
    assert.deepEqual(Object.keys(state), ["issues"], "not the support-state.json schema");
  });

  it("--closed-at scopes the count to that close", () => {
    const at = (c) => ["--closed-at", c, "--state-file", stateFile];
    run(["record-release-attempt", "658", "ios", "fail", ...at("2026-09-01T00:00:00Z")]);
    run(["record-release-attempt", "658", "ios", "fail", ...at("2026-09-01T00:00:00Z")]);
    const r = run(["record-release-attempt", "658", "ios", "fail", ...at("2026-10-05T00:00:00Z")]);
    assert.equal(JSON.parse(r.stdout).failures, 1);
  });

  it("reset-release-attempts clears every platform for the issue", () => {
    run(["record-release-attempt", "658", "ios", "fail", "--state-file", stateFile]);
    const r = run(["reset-release-attempts", "658", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.issues["658"].releaseAttempts, undefined);
  });

  it("rejects bad input", () => {
    for (const args of [
      ["record-release-attempt", "658", "ios"],
      ["record-release-attempt", "658", "web", "ok"],
      ["record-release-attempt", "abc", "ios", "ok"],
      ["record-release-attempt", "658", "ios", "maybe"],
      ["reset-release-attempts"],
      ["reset-release-attempts", "#661"],
    ]) {
      const r = run([...args, "--state-file", stateFile]);
      assert.equal(r.status, 1, `${args.join(" ")} should fail`);
      assert.match(r.stderr, /"error"/);
    }
  });
});
