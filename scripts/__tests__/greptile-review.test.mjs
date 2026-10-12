// Unit tests for scripts/lib/greptile-review.mjs — the pure half of the
// factory's Greptile review hold (ADR-0047). Greptile is an optional second
// reviewer: these pin that only the real Greptile App can count as a review,
// and that every way the gate can go wrong ends in a bounded wait and a note,
// never a stuck card.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GREPTILE_BOT_LOGIN,
  DEFAULT_GREPTILE_KNOBS,
  MAX_GREPTILE_HOLD_MIN,
  isTrustedGreptileItem,
  classifyGreptileActivity,
  readGreptileKnobs,
  decideGreptileGate,
  greptileInTestNote,
  greptileUnknownNote,
} from "../lib/greptile-review.mjs";

const MODULE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "greptile-review.mjs",
);

const MINUTE_MS = 60_000;
const PR = 12;
// GitHub writes seconds-precision timestamps; node writes millis. Both appear.
const OPENED = "2026-10-12T10:00:00Z";
const at = (minutes, base = OPENED) =>
  new Date(Date.parse(base) + minutes * MINUTE_MS).toISOString();

const GREPTILE = { login: GREPTILE_BOT_LOGIN, type: "Bot" };
const SPOOF = { login: GREPTILE_BOT_LOGIN, type: "User" };
const OTHER_BOT = { login: "coderabbitai[bot]", type: "Bot" };

const REVIEW_BODY = "**3 files reviewed, 2 comments**\n\n[Edit Code Review Agent Settings]";
const SUMMARY_BODY = "<h3>Greptile Summary</h3>\n\nThis PR adds a hold to the factory.";
const OVERVIEW_BODY = "<h2>Greptile Overview</h2>\n\nThis PR adds a hold to the factory.";

const review = (extra = {}) => ({
  user: GREPTILE,
  state: "COMMENTED",
  body: REVIEW_BODY,
  ...extra,
});
const comment = (extra = {}) => ({ user: GREPTILE, body: SUMMARY_BODY, ...extra });

const NOT_REVIEWED_30 = `Greptile did not review PR #${PR} (no review within 30 min of the PR opening)`;
const UNKNOWN = `Greptile review status of PR #${PR} unknown (its reviews could not be read)`;
const NO_WINDOW = `Greptile did not review PR #${PR} (the PR's opening time could not be read, so the factory did not wait)`;

const decide = (extra = {}) =>
  decideGreptileGate({
    activity: "absent",
    pr: PR,
    prCreatedAt: OPENED,
    knobs: { holdMaxMin: 30 },
    now: at(10),
    ...extra,
  });

// ── constants ───────────────────────────────────────────────────────────────

describe("constants", () => {
  it("names the Greptile App's REST login and a bounded default hold", () => {
    assert.equal(GREPTILE_BOT_LOGIN, "greptile-apps[bot]");
    assert.deepEqual(DEFAULT_GREPTILE_KNOBS, { holdMaxMin: 30 });
    assert.ok(Object.isFrozen(DEFAULT_GREPTILE_KNOBS), "the defaults must not be mutable");
    assert.equal(MAX_GREPTILE_HOLD_MIN, 1440);
  });
});

// ── isTrustedGreptileItem ───────────────────────────────────────────────────

describe("isTrustedGreptileItem", () => {
  it("trusts only a Bot-typed greptile-apps[bot]", () => {
    assert.equal(isTrustedGreptileItem({ user: GREPTILE }), true);
  });

  // GraphQL drops the [bot] suffix and anyone can register "greptile-apps"
  // style names, so the REST type is what makes the login trustworthy.
  it("refuses a lookalike: User type, GraphQL-style login, another bot", () => {
    assert.equal(isTrustedGreptileItem({ user: SPOOF }), false);
    assert.equal(isTrustedGreptileItem({ user: { login: "greptile-apps", type: "Bot" } }), false);
    assert.equal(isTrustedGreptileItem({ user: OTHER_BOT }), false);
  });

  it("is false, never a throw, on garbage", () => {
    for (const item of [null, undefined, 0, "greptile-apps[bot]", {}, { user: null }]) {
      assert.equal(isTrustedGreptileItem(item), false, JSON.stringify(item));
    }
  });
});

// ── classifyGreptileActivity ────────────────────────────────────────────────

describe("classifyGreptileActivity", () => {
  it("a trusted review with a body is a finished review", () => {
    assert.equal(classifyGreptileActivity({ reviews: [review()], comments: [] }), "reviewed");
  });

  it("the same login typed User (spoofed) is absent", () => {
    assert.equal(classifyGreptileActivity({ reviews: [review({ user: SPOOF })] }), "absent");
  });

  it("another bot's review is absent", () => {
    assert.equal(classifyGreptileActivity({ reviews: [review({ user: OTHER_BOT })] }), "absent");
  });

  // An empty-bodied review object is GitHub's wrapper for a reply on a thread.
  it("an empty or whitespace-bodied trusted review (thread reply) is absent", () => {
    for (const body of ["", "   \n", null, undefined]) {
      assert.equal(
        classifyGreptileActivity({ reviews: [review({ body })] }),
        "absent",
        JSON.stringify(body),
      );
    }
  });

  // PENDING is a draft only its author can see: nothing has been posted yet.
  it("a PENDING trusted review is absent, whatever the case of the state", () => {
    for (const state of ["PENDING", "pending"]) {
      assert.equal(classifyGreptileActivity({ reviews: [review({ state })] }), "absent", state);
    }
  });

  it("any submitted state with a body counts", () => {
    for (const state of ["COMMENTED", "APPROVED", "CHANGES_REQUESTED", undefined]) {
      assert.equal(classifyGreptileActivity({ reviews: [review({ state })] }), "reviewed", state);
    }
  });

  it("a trusted summary comment under either heading is a finished review", () => {
    assert.equal(classifyGreptileActivity({ comments: [comment()] }), "reviewed");
    assert.equal(
      classifyGreptileActivity({ comments: [comment({ body: OVERVIEW_BODY })] }),
      "reviewed",
    );
    assert.equal(
      classifyGreptileActivity({ comments: [comment({ body: "## greptile  summary\n…" })] }),
      "reviewed",
    );
  });

  // A quota notice, a skip notice or an @-mention reply is Greptile talking,
  // not Greptile having reviewed the PR.
  it("a trusted comment without the heading is absent", () => {
    for (const body of [
      "You have reached your monthly review limit. Upgrade to continue.",
      "Skipped: this PR's author is excluded from reviews.",
      "Good question — the hold is bounded by the window.",
      "",
    ]) {
      assert.equal(classifyGreptileActivity({ comments: [comment({ body })] }), "absent", body);
    }
  });

  it("a spoofed or foreign comment with the heading is absent", () => {
    assert.equal(classifyGreptileActivity({ comments: [comment({ user: SPOOF })] }), "absent");
    assert.equal(classifyGreptileActivity({ comments: [comment({ user: OTHER_BOT })] }), "absent");
    assert.equal(
      classifyGreptileActivity({ comments: [comment({ user: { login: "JakubAnderwald" } })] }),
      "absent",
    );
  });

  it("one trusted signal among noise is enough", () => {
    assert.equal(
      classifyGreptileActivity({
        reviews: [null, review({ user: SPOOF }), review({ body: "" }), review()],
        comments: [comment({ user: OTHER_BOT })],
      }),
      "reviewed",
    );
    assert.equal(
      classifyGreptileActivity({
        reviews: [review({ state: "PENDING" })],
        comments: [{}, comment({ body: "quota" }), comment()],
      }),
      "reviewed",
    );
  });

  it("non-array or garbage inputs are absent, never a throw", () => {
    assert.equal(classifyGreptileActivity(), "absent");
    assert.equal(classifyGreptileActivity({}), "absent");
    for (const bad of [null, "reviewed", 42, {}, { 0: review() }, [null, 0, "x", []]]) {
      assert.equal(
        classifyGreptileActivity({ reviews: bad, comments: bad }),
        "absent",
        JSON.stringify(bad),
      );
    }
  });
});

// ── readGreptileKnobs ───────────────────────────────────────────────────────

describe("readGreptileKnobs", () => {
  it("honours a sane override up to the 1440 ceiling", () => {
    assert.deepEqual(readGreptileKnobs({ FACTORY_GREPTILE_HOLD_MAX_MIN: "45" }), {
      holdMaxMin: 45,
    });
    assert.deepEqual(readGreptileKnobs({ FACTORY_GREPTILE_HOLD_MAX_MIN: "1440" }), {
      holdMaxMin: 1440,
    });
  });

  // 0 would disable the hold and a huge or non-numeric value would park the
  // card; both fall back to the default instead.
  it("falls back to 30 on garbage, unset or out-of-range values", () => {
    for (const raw of ["0", "abc", "1441", "1e3", "", " 45", "45.5", "-5", undefined, 45]) {
      assert.deepEqual(
        readGreptileKnobs({ FACTORY_GREPTILE_HOLD_MAX_MIN: raw }),
        { holdMaxMin: 30 },
        JSON.stringify(raw),
      );
    }
  });

  it("falls back to 30 with no env at all", () => {
    assert.deepEqual(readGreptileKnobs(), { holdMaxMin: 30 });
    assert.deepEqual(readGreptileKnobs({}), { holdMaxMin: 30 });
    assert.deepEqual(readGreptileKnobs(null), { holdMaxMin: 30 });
  });
});

// ── decideGreptileGate ──────────────────────────────────────────────────────

describe("decideGreptileGate", () => {
  it("reviewed → promote with no note, even long past the window", () => {
    for (const now of [at(1), at(10_000)]) {
      assert.deepEqual(decide({ activity: "reviewed", now }), {
        action: "promote",
        reason: "greptile-reviewed",
        note: "",
      });
    }
  });

  it("reviewed → promote even when the PR's opening time is unreadable", () => {
    assert.equal(decide({ activity: "reviewed", prCreatedAt: null }).reason, "greptile-reviewed");
  });

  it("absent inside the window → hold", () => {
    for (const now of [OPENED, at(10), at(29.99)]) {
      assert.deepEqual(decide({ now }), { action: "hold", reason: "greptile-wait", note: "" }, now);
    }
  });

  it("absent exactly at the deadline → promote with the not-reviewed note", () => {
    assert.deepEqual(decide({ now: at(30) }), {
      action: "promote",
      reason: "greptile-hold-expired",
      note: NOT_REVIEWED_30,
    });
    assert.equal(
      NOT_REVIEWED_30,
      "Greptile did not review PR #12 (no review within 30 min of the PR opening)",
    );
  });

  it("absent after the deadline → promote with the same note", () => {
    for (const now of [at(31), at(60 * 24 * 7)]) {
      assert.deepEqual(decide({ now }), {
        action: "promote",
        reason: "greptile-hold-expired",
        note: NOT_REVIEWED_30,
      });
    }
  });

  // A read failure is bounded by the same window: it may cost the wait, never
  // more.
  it("unavailable inside the window → hold", () => {
    assert.deepEqual(decide({ activity: "unavailable" }), {
      action: "hold",
      reason: "greptile-unreadable",
      note: "",
    });
  });

  it("unavailable at or past the deadline → promote with the unknown note", () => {
    for (const now of [at(30), at(90)]) {
      assert.deepEqual(decide({ activity: "unavailable", now }), {
        action: "promote",
        reason: "greptile-unreadable-expired",
        note: UNKNOWN,
      });
    }
    assert.equal(UNKNOWN, greptileUnknownNote(PR, "its reviews could not be read"));
  });

  it("an unknown activity value is treated as absent", () => {
    for (const activity of [undefined, null, "", "covered", 1]) {
      assert.equal(decide({ activity }).reason, "greptile-wait", String(activity));
      assert.equal(decide({ activity, now: at(30) }).reason, "greptile-hold-expired");
    }
  });

  // Without an opening time there is no window, and a hold with no deadline
  // is exactly the stuck card the gate must never cause.
  describe("no usable window → promote at once, never hold", () => {
    for (const [label, prCreatedAt] of [
      ["missing", undefined],
      ["null", null],
      ["empty", ""],
      ["blank", "   "],
      ["garbage", "yesterday-ish"],
      ["a number", Date.parse(OPENED)],
      ["far future (> 5 min)", at(16)],
      ["a year ahead", at(60 * 24 * 365)],
    ]) {
      it(`prCreatedAt ${label}`, () => {
        assert.deepEqual(decide({ prCreatedAt, now: at(10) }), {
          action: "promote",
          reason: "greptile-no-window",
          note: NO_WINDOW,
        });
        assert.deepEqual(decide({ prCreatedAt, now: at(10), activity: "unavailable" }), {
          action: "promote",
          reason: "greptile-no-window",
          note: UNKNOWN,
        });
      });
    }

    for (const [label, now] of [
      ["missing", undefined],
      ["null", null],
      ["garbage", "not a time"],
      ["a Date object", new Date(at(10))],
    ]) {
      it(`now ${label}`, () => {
        assert.deepEqual(decide({ now }), {
          action: "promote",
          reason: "greptile-no-window",
          note: NO_WINDOW,
        });
      });
    }
  });

  // Clock skew between GitHub and the Mac mini is real but small: a PR that
  // "opens" a couple of minutes ahead is still a PR worth waiting for.
  it("a createdAt within 5 min in the future (skew) still holds", () => {
    assert.equal(decide({ prCreatedAt: at(12), now: at(10) }).action, "hold");
    assert.equal(decide({ prCreatedAt: at(15), now: at(10) }).action, "hold");
    assert.equal(decide({ prCreatedAt: at(15.001), now: at(10) }).reason, "greptile-no-window");
  });

  it("garbage knobs fall back to 30 min", () => {
    for (const holdMaxMin of [0, -1, 1441, NaN, Infinity, 1.5, "30", "45", null, undefined]) {
      const knobs = { holdMaxMin };
      assert.equal(decide({ knobs, now: at(29) }).action, "hold", String(holdMaxMin));
      assert.deepEqual(
        decide({ knobs, now: at(30) }),
        { action: "promote", reason: "greptile-hold-expired", note: NOT_REVIEWED_30 },
        String(holdMaxMin),
      );
    }
    for (const knobs of [undefined, null, {}, "45"]) {
      assert.equal(decide({ knobs, now: at(30) }).reason, "greptile-hold-expired");
    }
  });

  it("a sane knob is honoured, and named in the note", () => {
    const knobs = { holdMaxMin: 45 };
    assert.equal(decide({ knobs, now: at(30) }).action, "hold");
    assert.equal(decide({ knobs, now: at(44.99) }).action, "hold");
    assert.deepEqual(decide({ knobs, now: at(45) }), {
      action: "promote",
      reason: "greptile-hold-expired",
      note: "Greptile did not review PR #12 (no review within 45 min of the PR opening)",
    });
    assert.equal(decide({ knobs: { holdMaxMin: 1440 }, now: at(1439) }).action, "hold");
  });

  // As strings, "…:30:00.000Z" < "…:30:00Z" ('.' sorts before 'Z'), so a
  // string compare would get the deadline wrong in one direction or the other.
  it("compares seconds-precision and millis timestamps by time, not as strings", () => {
    const secs = "2026-10-12T10:00:00Z";
    const millis = "2026-10-12T10:00:00.000Z";
    assert.equal(decide({ prCreatedAt: secs, now: "2026-10-12T10:29:59.999Z" }).action, "hold");
    assert.equal(decide({ prCreatedAt: secs, now: "2026-10-12T10:30:00.000Z" }).action, "promote");
    assert.equal(decide({ prCreatedAt: millis, now: "2026-10-12T10:29:59Z" }).action, "hold");
    assert.equal(decide({ prCreatedAt: millis, now: "2026-10-12T10:30:00Z" }).action, "promote");
    assert.equal(decide({ prCreatedAt: secs, now: "2026-10-12T10:30:00Z" }).action, "promote");
  });

  it("is total: no argument at all promotes rather than throwing", () => {
    assert.equal(decideGreptileGate().action, "promote");
    assert.equal(decideGreptileGate({}).reason, "greptile-no-window");
  });
});

// ── greptileInTestNote ──────────────────────────────────────────────────────

describe("greptileInTestNote", () => {
  const note = (extra = {}) =>
    greptileInTestNote({
      activity: "absent",
      pr: PR,
      prCreatedAt: OPENED,
      knobs: { holdMaxMin: 30 },
      now: at(10),
      ...extra,
    });

  it("is empty once Greptile reviewed", () => {
    assert.equal(note({ activity: "reviewed" }), "");
    assert.equal(note({ activity: "reviewed", now: at(90) }), "");
  });

  // The card already left In Review, so a would-be hold becomes a line for
  // the tester instead of a wait.
  it("inside the window, absent → 'has not reviewed … yet'", () => {
    assert.equal(note(), "Greptile has not reviewed PR #12 yet");
  });

  it("inside the window, unavailable → the unknown note", () => {
    assert.equal(note({ activity: "unavailable" }), UNKNOWN);
  });

  it("past the window → the same note the promotion would carry", () => {
    assert.equal(note({ now: at(30) }), NOT_REVIEWED_30);
    assert.equal(note({ now: at(30), activity: "unavailable" }), UNKNOWN);
  });

  it("no window → the no-window note", () => {
    assert.equal(note({ prCreatedAt: null }), NO_WINDOW);
  });
});

describe("greptileUnknownNote", () => {
  it("formats the one-line unknown note", () => {
    assert.equal(
      greptileUnknownNote(7, "gate error"),
      "Greptile review status of PR #7 unknown (gate error)",
    );
  });
});

// ── purity ──────────────────────────────────────────────────────────────────

// The decision half must stay testable without GitHub, a clock or a state
// file. Comments are stripped first: the module's header says, in words, which
// of these it doesn't use.
describe("greptile-review.mjs stays pure", () => {
  const code = readFileSync(MODULE_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("imports nothing", () => {
    assert.doesNotMatch(code, /^\s*import\b/m);
    assert.doesNotMatch(code, /\bimport\s*\(/);
    assert.doesNotMatch(code, /\brequire\s*\(/);
  });

  it("never touches process.env, the filesystem or child processes", () => {
    for (const needle of ["process.env", "process.", "node:fs", "child_process", "fetch("]) {
      assert.ok(!code.includes(needle), `greptile-review.mjs code mentions ${needle}`);
    }
  });
});
