import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASYNC_LANES,
  LANES,
  asyncWaitExpired,
  decide,
  holdExpired,
  isTerminalLaneState,
  laneKind,
} from "../lib/verify-decide.mjs";

// The Testing sweep's decision table (ADR-0053). Each row is one call: the
// module is pure, so the whole matrix — including the rule ORDER, which is
// where the bugs would be — is pinned here rather than in a bash harness.

const HERE = dirname(fileURLToPath(import.meta.url));
const cli = resolve(HERE, "..", "lib", "verify-decide.mjs");

const HEAD = "a".repeat(40);
// The device lane switched off, as bash sends it by default (ADR-0106).
const OFF = "skipped:lane-off";
const OLD = "b".repeat(40);
const T0 = "2026-10-20T10:00:00Z";
const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();

// A card mid-round that should simply keep working its lanes. The device lane
// (an async lane, ADR-0106) is switched off unless a row says otherwise.
const base = () => ({
  enabled: true,
  prState: "OPEN",
  headSha: HEAD,
  verifySha: HEAD,
  verifyReportSha: "",
  requiredCi: "green",
  lastReviewSha: HEAD,
  openThreads: 0,
  bounces: 0,
  bounceMax: 2,
  newFeedback: false,
  lanes: { shell: "running", browser: "none", device: OFF },
  startedAt: T0,
  now: at(5),
  holdMaxMin: 60,
  deviceWaitMin: 30,
});

const run = (over) => decide({ ...base(), ...over });

describe("verify-decide: helpers", () => {
  it("reads a lane state's kind", () => {
    assert.equal(laneKind("reported:pass"), "reported");
    assert.equal(laneKind("Unavailable:chrome"), "unavailable");
    assert.equal(laneKind(""), "none");
    assert.equal(laneKind(undefined), "none");
  });

  it("knows which lane states are terminal", () => {
    for (const s of [
      "reported",
      "reported:fail",
      "timeout",
      "unavailable:memory",
      "stale-branch",
      "no-preview",
      "skipped:not-built",
      "skipped:lane-off",
    ]) {
      assert.equal(isTerminalLaneState(s), true, s);
    }
    for (const s of ["none", "", null, "running", "starting", "queued", "garbage"]) {
      assert.equal(isTerminalLaneState(s), false, String(s));
    }
  });

  it("expires the hold cap at exactly holdMaxMin, and on any doubt", () => {
    assert.equal(holdExpired({ startedAt: T0, now: at(59), holdMaxMin: 60 }), false);
    assert.equal(holdExpired({ startedAt: T0, now: at(60), holdMaxMin: 60 }), true);
    assert.equal(holdExpired({ startedAt: "", now: at(1), holdMaxMin: 60 }), true);
    assert.equal(holdExpired({ startedAt: "garbage", now: at(1), holdMaxMin: 60 }), true);
    assert.equal(holdExpired({ startedAt: T0, now: "", holdMaxMin: 60 }), true);
    assert.equal(holdExpired({ startedAt: T0, now: at(1), holdMaxMin: "x" }), true);
  });
});

describe("verify-decide: the rules, in order", () => {
  it("works the lanes while any is pending and the cap isn't reached", () => {
    assert.deepEqual(run({}), {
      action: "work-lanes",
      reason: "lanes-pending",
      pending: ["shell", "browser"],
    });
    assert.deepEqual(
      run({ lanes: { shell: "reported:pass", browser: "running", device: OFF } }).pending,
      ["browser"],
    );
  });

  describe("1. a PR that isn't open is left alone", () => {
    for (const [prState, reason] of [
      ["MERGED", "pr-merged"],
      ["CLOSED", "pr-closed"],
      ["", "pr-unknown"],
      [undefined, "pr-unknown"],
    ]) {
      it(`${prState ?? "missing"} → skip (${reason})`, () => {
        assert.deepEqual(run({ prState }), { action: "skip", reason });
      });
    }

    it("even with verification off (a merged card is never drained to In Test)", () => {
      assert.deepEqual(run({ prState: "MERGED", enabled: false }), {
        action: "skip",
        reason: "pr-merged",
      });
    });

    it("accepts the state in any case", () => {
      assert.equal(run({ prState: "open" }).action, "work-lanes");
    });
  });

  describe("2. verification off drains the card", () => {
    it("promotes whatever else holds, with pending lanes skipped:verification-off", () => {
      const r = run({
        enabled: false,
        requiredCi: "red",
        openThreads: 3,
        verifySha: "",
        lanes: { shell: "reported:warn", browser: "running", device: OFF },
      });
      assert.deepEqual(r, {
        action: "promote",
        reason: "verification-off",
        lanes: { shell: "reported:warn", browser: "skipped:verification-off", device: OFF },
      });
    });

    it("treats anything but a literal true as off", () => {
      for (const enabled of [undefined, "true", 1, null]) {
        assert.equal(run({ enabled }).reason, "verification-off", String(enabled));
      }
    });
  });

  it("3. waits when the head is unknown, but not past the hold cap", () => {
    assert.deepEqual(run({ headSha: "" }), { action: "wait", reason: "head-unknown" });
    assert.equal(run({ headSha: "", now: at(60) }).reason, "hold-cap");
  });

  describe("4. actionable feedback cuts the round short", () => {
    it("promotes, with pending lanes skipped:feedback", () => {
      assert.deepEqual(
        run({ newFeedback: true, lanes: { shell: "timeout", browser: "running", device: OFF } }),
        {
          action: "promote",
          reason: "feedback",
          lanes: { shell: "timeout", browser: "skipped:feedback", device: OFF },
        },
      );
    });

    it("before the hand-backs: the revision replaces this commit anyway", () => {
      assert.equal(run({ newFeedback: true, verifySha: OLD }).reason, "feedback");
      assert.equal(run({ newFeedback: true, requiredCi: "red" }).reason, "feedback");
      assert.equal(run({ newFeedback: true, lastReviewSha: OLD }).reason, "feedback");
      assert.equal(run({ newFeedback: true, openThreads: 2 }).reason, "feedback");
    });

    it("before init, a CI-pending wait or an unknown thread list", () => {
      assert.equal(run({ newFeedback: true, verifySha: "" }).reason, "feedback");
      assert.equal(run({ newFeedback: true, requiredCi: "pending" }).reason, "feedback");
      assert.equal(run({ newFeedback: true, openThreads: null }).reason, "feedback");
    });

    it("only on a literal true", () => {
      assert.equal(run({ newFeedback: "true" }).action, "work-lanes");
    });
  });

  describe("5. head moved during an open round", () => {
    it("hands back", () => {
      assert.deepEqual(run({ verifySha: OLD }), { action: "hand-back", reason: "head-moved" });
    });

    it("beats red CI, a missing review and threads (the old commit is moot)", () => {
      assert.equal(
        run({ verifySha: OLD, requiredCi: "red", lastReviewSha: OLD, openThreads: 2 }).reason,
        "head-moved",
      );
    });

    it("but a finished round (its report posted) starts a new one instead", () => {
      assert.deepEqual(run({ verifySha: OLD, verifyReportSha: OLD }), {
        action: "init",
        reason: "new-round",
      });
    });
  });

  describe("6–8. the commit isn't ready: hand back to In Review", () => {
    it("required CI red", () => {
      assert.deepEqual(run({ requiredCi: "red" }), { action: "hand-back", reason: "ci-red" });
    });

    it("head not code-reviewed", () => {
      assert.deepEqual(run({ lastReviewSha: OLD }), {
        action: "hand-back",
        reason: "not-reviewed",
      });
      assert.equal(run({ lastReviewSha: "" }).reason, "not-reviewed");
    });

    it("red CI is reported before a missing review", () => {
      assert.equal(run({ requiredCi: "red", lastReviewSha: OLD }).reason, "ci-red");
    });

    it("open threads, until the bounce cap", () => {
      assert.deepEqual(run({ openThreads: 2, bounces: 0 }), {
        action: "hand-back",
        reason: "threads",
      });
      assert.equal(run({ openThreads: 2, bounces: 1 }).reason, "threads");
    });

    it("past the bounce cap, open threads no longer hand back (--release still gates)", () => {
      assert.equal(run({ openThreads: 2, bounces: 2 }).action, "work-lanes");
      assert.equal(
        run({
          openThreads: 2,
          bounces: 2,
          lanes: { shell: "timeout", browser: "skipped:x", device: OFF },
        }).reason,
        "lanes-done",
      );
    });

    it("a bounce cap of 0 never bounces on threads", () => {
      assert.equal(run({ openThreads: 1, bounceMax: 0 }).action, "work-lanes");
    });

    it("hands back a card dragged in with red CI before initialising it", () => {
      assert.equal(run({ verifySha: "", requiredCi: "red" }).reason, "ci-red");
      assert.equal(run({ verifySha: "", openThreads: 1 }).reason, "threads");
    });

    it("a verdict never hands back: a FAIL lane just counts as done", () => {
      const r = run({ lanes: { shell: "reported:fail", browser: "reported:fail", device: OFF } });
      assert.equal(r.action, "promote");
      assert.equal(r.reason, "lanes-done");
    });
  });

  describe("9. init", () => {
    it("starts a round for a card with none (dragged in, or the revision no-op path)", () => {
      assert.deepEqual(run({ verifySha: "" }), { action: "init", reason: "no-round" });
    });

    it("comes before the CI-pending wait (the round's clock starts at init)", () => {
      assert.equal(run({ verifySha: "", requiredCi: "pending" }).action, "init");
    });
  });

  describe("10. required CI pending", () => {
    it("waits", () => {
      assert.deepEqual(run({ requiredCi: "pending" }), { action: "wait", reason: "ci-pending" });
      assert.equal(run({ requiredCi: "" }).reason, "ci-pending", "unknown reads as pending");
    });

    it("but promotes once the hold cap is reached", () => {
      assert.deepEqual(run({ requiredCi: "pending", now: at(60) }), {
        action: "promote",
        reason: "hold-cap",
        lanes: { shell: "skipped:hold-cap", browser: "skipped:hold-cap", device: OFF },
      });
    });
  });

  describe("11. an unreadable thread list", () => {
    it("waits", () => {
      assert.deepEqual(run({ openThreads: null }), { action: "wait", reason: "threads-unknown" });
      assert.equal(run({ openThreads: undefined }).reason, "threads-unknown");
    });

    it("but promotes once the hold cap is reached", () => {
      assert.equal(run({ openThreads: null, now: at(61) }).reason, "hold-cap");
    });
  });

  describe("12–13. promotion", () => {
    it("once every lane is terminal (the not-built and lane-off placeholders included)", () => {
      assert.deepEqual(
        run({ lanes: { shell: "skipped:not-built", browser: "skipped:lane-off", device: OFF } }),
        {
          action: "promote",
          reason: "lanes-done",
          lanes: { shell: "skipped:not-built", browser: "skipped:lane-off", device: OFF },
        },
      );
    });

    it("or when the hold cap is reached with lanes still running", () => {
      assert.deepEqual(
        run({ now: at(60), lanes: { shell: "reported:pass", browser: "running", device: OFF } }),
        {
          action: "promote",
          reason: "hold-cap",
          lanes: { shell: "reported:pass", browser: "skipped:hold-cap", device: OFF },
        },
      );
    });

    it("shows why a lane deferred until the hold cap, or how its last attempt ended, and keeps both pending until then", () => {
      assert.deepEqual(
        run({
          now: at(60),
          lanes: { shell: "deferred:memory", browser: "retry:error", device: OFF },
        }).lanes,
        { shell: "skipped:memory", browser: "skipped:after-error", device: OFF },
      );
      const pending = run({
        lanes: { shell: "deferred:busy", browser: "reported:pass", device: OFF },
      });
      assert.equal(pending.action, "work-lanes");
      assert.deepEqual(pending.pending, ["shell"]);
      // Feedback cuts a deferred lane short like any other pending one.
      assert.deepEqual(
        run({
          newFeedback: true,
          lanes: { shell: "deferred:disk", browser: "reported:pass", device: OFF },
        }).lanes,
        { shell: "skipped:feedback", browser: "reported:pass", device: OFF },
      );
    });

    it("a missing round clock counts as expired, so a card can't be stranded", () => {
      assert.equal(run({ startedAt: "" }).reason, "hold-cap");
    });

    it("missing lanes read as pending", () => {
      assert.deepEqual(run({ lanes: undefined }).pending, ["shell", "browser", "device"]);
      assert.deepEqual(run({ lanes: undefined, now: at(90) }).lanes, {
        shell: "skipped:hold-cap",
        browser: "skipped:hold-cap",
        device: "skipped:hold-cap",
      });
    });
  });

  it("tolerates garbage facts without throwing", () => {
    assert.deepEqual(decide(), { action: "skip", reason: "pr-unknown" });
    assert.deepEqual(decide(null), { action: "skip", reason: "pr-unknown" });
    assert.equal(run({ bounces: "x", bounceMax: -1, openThreads: "3" }).action, "work-lanes");
  });
});

describe("verify-decide: the device lane, an async lane (ADR-0106 decision 6)", () => {
  const dev = (device, over = {}) =>
    run({ lanes: { shell: "reported:pass", browser: "skipped:not-web", device }, ...over });

  it("is a lane, and the only async one", () => {
    assert.deepEqual(LANES, ["shell", "browser", "device"]);
    assert.deepEqual(ASYNC_LANES, ["device"]);
    assert.equal(isTerminalLaneState("running"), false, "running is not terminal");
  });

  it("holds the card while its run is going, until deviceWaitMin", () => {
    for (const device of ["none", "running", "deferred:beta-build", "retry:lost"]) {
      const r = dev(device, { now: at(29) });
      assert.equal(r.action, "work-lanes", device);
      assert.deepEqual(r.pending, ["device"], device);
    }
  });

  it("stops holding it after deviceWaitMin: a running run reads running", () => {
    assert.deepEqual(dev("running", { now: at(30) }), {
      action: "promote",
      reason: "lanes-done",
      lanes: { shell: "reported:pass", browser: "skipped:not-web", device: "running" },
    });
  });

  it("reports a run that never started like a lane at the hold cap", () => {
    assert.equal(dev("deferred:beta-build", { now: at(30) }).lanes.device, "skipped:beta-build");
    assert.equal(dev("retry:lost", { now: at(30) }).lanes.device, "skipped:after-lost");
    assert.equal(dev("none", { now: at(30) }).lanes.device, "skipped:async-wait");
  });

  it("doesn't hold up the other lanes, which still decide", () => {
    const r = run({
      now: at(45),
      lanes: { shell: "running", browser: "reported:pass", device: "running" },
    });
    assert.equal(r.action, "work-lanes");
    assert.deepEqual(r.pending, ["shell"]);
  });

  it("never outlasts the hold cap: a shorter cap wins over deviceWaitMin", () => {
    const r = dev("running", { holdMaxMin: 20, now: at(20) });
    assert.equal(r.action, "promote");
    assert.equal(r.lanes.device, "running", "the run carries on past the cap");
    assert.equal(dev("running", { holdMaxMin: 20, now: at(19) }).action, "work-lanes");
    // A longer wait than the cap is cut to the cap.
    assert.equal(
      asyncWaitExpired({ startedAt: T0, now: at(60), holdMaxMin: 60, deviceWaitMin: 90 }),
      true,
    );
    assert.equal(
      asyncWaitExpired({ startedAt: T0, now: at(59), holdMaxMin: 60, deviceWaitMin: 90 }),
      false,
    );
    // The hold cap, with the other lanes still running, reports it running too.
    assert.equal(
      run({ now: at(60), lanes: { shell: "running", browser: "none", device: "running" } }).lanes
        .device,
      "running",
    );
  });

  it("a promotion that stops the run never reads it as running", () => {
    assert.equal(dev("running", { newFeedback: true }).lanes.device, "skipped:feedback");
    assert.equal(dev("running", { enabled: false }).lanes.device, "skipped:verification-off");
  });

  it("a missing or bad wait counts as over (doubt resolves toward promotion)", () => {
    assert.equal(dev("running", { deviceWaitMin: undefined }).reason, "lanes-done");
    assert.equal(dev("running", { deviceWaitMin: "x" }).reason, "lanes-done");
  });

  it("a finished run is terminal like any lane", () => {
    assert.deepEqual(dev("reported:fail", { now: at(1) }).lanes.device, "reported:fail");
    assert.equal(dev("skipped:not-applicable", { now: at(1) }).reason, "lanes-done");
  });
});

describe("verify-decide CLI", () => {
  const call = (args, input) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", input: input ?? "" });

  it("reads facts on stdin and prints one JSON line", () => {
    const r = call(["decide"], JSON.stringify({ ...base(), verifySha: "" }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(r.stdout), { action: "init", reason: "no-round" });
  });

  it("takes --facts instead of stdin", () => {
    const r = call(["decide", "--facts", JSON.stringify({ ...base(), requiredCi: "red" })]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { action: "hand-back", reason: "ci-red" });
  });

  it("exits 2 on bad facts or a bad command", () => {
    for (const [args, input] of [
      [["decide"], "not json"],
      [["decide"], "[1,2]"],
      [["decide", "--facts"], ""],
      [["bogus"], ""],
    ]) {
      const r = call(args, input);
      assert.equal(r.status, 2, `${args.join(" ")} ${input}: ${r.stderr}`);
    }
  });

  it("prints usage and exits 0 with no command", () => {
    const r = call([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: verify-decide\.mjs decide/);
  });
});
