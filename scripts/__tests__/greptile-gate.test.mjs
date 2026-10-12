// Unit tests for scripts/lib/greptile-gate.mjs — the IO half of the factory's
// Greptile review hold (ADR-0047). gh is an injected fake that records its argv
// and answers per REST path; the decisions come from the real
// greptile-review.mjs, so these double as integration tests of the two halves.
// One test runs the real CLI against a PATH-stubbed gh to pin the wire format
// factory-agent.sh's greptile_gate parses, and that it touches no state file.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO, readGreptileInputs, runGate, runNote, main } from "../lib/greptile-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "greptile-gate.mjs");

const MINUTE_MS = 60_000;
const PR = "7";
const OPENED = "2026-10-12T10:00:00Z";
const at = (minutes) => new Date(Date.parse(OPENED) + minutes * MINUTE_MS).toISOString();

const GREPTILE = { login: "greptile-apps[bot]", type: "Bot" };
const GREPTILE_REVIEW = {
  user: GREPTILE,
  state: "COMMENTED",
  body: "**3 files reviewed, 2 comments**",
};
const GREPTILE_SUMMARY = { user: GREPTILE, body: "<h3>Greptile Summary</h3>\n\nAdds a hold." };

const PR_PATH = `repos/JakubAnderwald/drafto/pulls/${PR}`;
const REVIEWS_PATH = `repos/JakubAnderwald/drafto/pulls/${PR}/reviews?per_page=100`;
const COMMENTS_PATH = `repos/JakubAnderwald/drafto/issues/${PR}/comments?per_page=100`;

const NOT_REVIEWED = "Greptile did not review PR #7 (no review within 30 min of the PR opening)";
const UNKNOWN = "Greptile review status of PR #7 unknown (its reviews could not be read)";
const GATE_ERROR = "Greptile review status of PR #7 unknown (gate error)";

// ── fake deps ──────────────────────────────────────────────────────────────

// Each endpoint answers from cfg: a value is served as JSON (lists as one
// slurped page), a {code, stdout} object is served verbatim. Every call is
// recorded, and an unknown call fails loudly so a new endpoint can't hide.
function makeDeps(overrides = {}) {
  const cfg = {
    env: {},
    now: at(10),
    pr: { number: 7, created_at: OPENED },
    reviews: [],
    comments: [],
    ...overrides,
  };
  const calls = [];
  const serve = (value, wrapPage) =>
    value && typeof value === "object" && "code" in value
      ? { stdout: "", stderr: "", ...value }
      : { code: 0, stdout: JSON.stringify(wrapPage ? [value] : value), stderr: "" };
  const deps = {
    env: cfg.env,
    now: () => cfg.now,
    gh: async (args) => {
      calls.push(args);
      const last = args[args.length - 1];
      if (last === PR_PATH) return serve(cfg.pr, false);
      if (last === REVIEWS_PATH) return serve(cfg.reviews, true);
      if (last === COMMENTS_PATH) return serve(cfg.comments, true);
      return { code: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
    },
  };
  return { deps, calls };
}

const FAIL = { code: 1, stdout: "", stderr: "gh: HTTP 502 Bad Gateway" };
const GARBLED = { code: 0, stdout: "<html>502</html>" };
const NOT_PAGES = { code: 0, stdout: JSON.stringify({ message: "Not Found" }) };

const gate = (overrides = {}, now) => {
  const { deps } = makeDeps(overrides);
  return runGate({ pr: PR, now }, deps);
};

// ── runGate ────────────────────────────────────────────────────────────────

describe("runGate", () => {
  it("holds inside the window while Greptile hasn't reviewed", async () => {
    assert.deepEqual(await gate({}, at(10)), {
      action: "hold",
      reason: "greptile-wait",
      activity: "absent",
      note: "",
    });
  });

  it("promotes with no note once the reviews list has a trusted Greptile review", async () => {
    assert.deepEqual(await gate({ reviews: [GREPTILE_REVIEW] }, at(1)), {
      action: "promote",
      reason: "greptile-reviewed",
      activity: "reviewed",
      note: "",
    });
  });

  it("a summary comment counts as well", async () => {
    const out = await gate({ comments: [GREPTILE_SUMMARY] }, at(1));
    assert.equal(out.reason, "greptile-reviewed");
  });

  // A lookalike user must not be able to wave a PR through the hold.
  it("a spoofed Greptile review still holds", async () => {
    const spoof = { ...GREPTILE_REVIEW, user: { login: "greptile-apps[bot]", type: "User" } };
    assert.equal((await gate({ reviews: [spoof] }, at(10))).action, "hold");
  });

  it("promotes with the not-reviewed note once the window passed", async () => {
    assert.deepEqual(await gate({}, at(30)), {
      action: "promote",
      reason: "greptile-hold-expired",
      activity: "absent",
      note: NOT_REVIEWED,
    });
  });

  // Greptile pages are flattened: a review on page two counts.
  it("reads every slurped page", async () => {
    const reviews = { code: 0, stdout: JSON.stringify([[], [GREPTILE_REVIEW]]) };
    assert.equal((await gate({ reviews }, at(10))).reason, "greptile-reviewed");
  });

  // A read failure may cost the wait, never more: it holds inside the window
  // and promotes with the unknown note after it.
  for (const [label, broken] of [
    ["fails", FAIL],
    ["prints garbage", GARBLED],
    ["prints a non-page JSON", NOT_PAGES],
  ]) {
    for (const list of ["reviews", "comments"]) {
      it(`${list} fetch ${label} → holds inside the window, promotes with the unknown note after`, async () => {
        const inside = await gate({ [list]: broken }, at(10));
        assert.deepEqual(inside, {
          action: "hold",
          reason: "greptile-unreadable",
          activity: "unavailable",
          note: "",
        });
        const after = await gate({ [list]: broken }, at(30));
        assert.deepEqual(after, {
          action: "promote",
          reason: "greptile-unreadable-expired",
          activity: "unavailable",
          note: UNKNOWN,
        });
      });
    }
  }

  // One list readable with a Greptile review is not enough when the other
  // failed: "unavailable" is reported, and the hold stays bounded.
  it("a failing comments fetch is unavailable even when the reviews show Greptile", async () => {
    const out = await gate({ reviews: [GREPTILE_REVIEW], comments: FAIL }, at(10));
    assert.equal(out.activity, "unavailable");
    assert.equal(out.reason, "greptile-unreadable");
  });

  // No opening time means no window, so the gate must not wait at all.
  for (const [label, pr] of [
    ["fails", FAIL],
    ["prints garbage", GARBLED],
    ["has no created_at", { number: 7 }],
    ["has a non-string created_at", { number: 7, created_at: 1760263200 }],
  ]) {
    it(`a PR read that ${label} → promotes at once (greptile-no-window)`, async () => {
      assert.deepEqual(await gate({ pr }, at(1)), {
        action: "promote",
        reason: "greptile-no-window",
        activity: "absent",
        note: "Greptile did not review PR #7 (the PR's opening time could not be read, so the factory did not wait)",
      });
    });
  }

  it("a failing PR read with failing lists → promotes at once with the unknown note", async () => {
    assert.deepEqual(await gate({ pr: FAIL, reviews: FAIL, comments: FAIL }, at(1)), {
      action: "promote",
      reason: "greptile-no-window",
      activity: "unavailable",
      note: UNKNOWN,
    });
  });

  it("reads the hold knob from deps.env.FACTORY_GREPTILE_HOLD_MAX_MIN", async () => {
    const env = { FACTORY_GREPTILE_HOLD_MAX_MIN: "45" };
    assert.equal((await gate({ env }, at(30))).action, "hold");
    assert.deepEqual(await gate({ env }, at(45)), {
      action: "promote",
      reason: "greptile-hold-expired",
      activity: "absent",
      note: "Greptile did not review PR #7 (no review within 45 min of the PR opening)",
    });
    // A garbage override is the default, not a disabled or unbounded hold.
    for (const raw of ["0", "abc", "99999"]) {
      const bad = { FACTORY_GREPTILE_HOLD_MAX_MIN: raw };
      assert.equal((await gate({ env: bad }, at(29))).action, "hold", raw);
      assert.equal((await gate({ env: bad }, at(30))).note, NOT_REVIEWED, raw);
    }
  });

  it("uses deps.now() when no --now is given", async () => {
    const { deps } = makeDeps({ now: at(31) });
    assert.equal((await runGate({ pr: PR }, deps)).reason, "greptile-hold-expired");
  });

  it("hits exactly the three REST paths, paginating and slurping the two lists", async () => {
    const { deps, calls } = makeDeps();
    await runGate({ pr: PR, now: at(10) }, deps);
    assert.equal(REPO, "JakubAnderwald/drafto");
    const sorted = (list) => [...list].map((a) => a.join(" ")).sort();
    assert.deepEqual(
      sorted(calls),
      sorted([
        ["api", PR_PATH],
        ["api", "--paginate", "--slurp", REVIEWS_PATH],
        ["api", "--paginate", "--slurp", COMMENTS_PATH],
      ]),
    );
  });
});

describe("readGreptileInputs", () => {
  it("returns the PR's opening time and the classified activity", async () => {
    const { deps } = makeDeps({ comments: [GREPTILE_SUMMARY] });
    assert.deepEqual(await readGreptileInputs(PR, deps), {
      prCreatedAt: OPENED,
      activity: "reviewed",
    });
  });

  it("returns null and unavailable when nothing can be read", async () => {
    const { deps } = makeDeps({ pr: FAIL, reviews: FAIL, comments: GARBLED });
    assert.deepEqual(await readGreptileInputs(PR, deps), {
      prCreatedAt: null,
      activity: "unavailable",
    });
  });
});

// ── runNote ────────────────────────────────────────────────────────────────

describe("runNote", () => {
  it("is empty once Greptile reviewed", async () => {
    const { deps } = makeDeps({ reviews: [GREPTILE_REVIEW] });
    assert.deepEqual(await runNote({ pr: PR, now: at(10) }, deps), { note: "" });
  });

  // The card has already left In Review: a would-be hold becomes a note.
  it("inside the window: 'has not reviewed … yet'", async () => {
    const { deps } = makeDeps();
    assert.deepEqual(await runNote({ pr: PR, now: at(10) }, deps), {
      note: "Greptile has not reviewed PR #7 yet",
    });
  });

  it("past the window: the not-reviewed note; unreadable: the unknown note", async () => {
    assert.deepEqual(await runNote({ pr: PR, now: at(30) }, makeDeps().deps), {
      note: NOT_REVIEWED,
    });
    assert.deepEqual(await runNote({ pr: PR, now: at(10) }, makeDeps({ reviews: FAIL }).deps), {
      note: UNKNOWN,
    });
  });
});

// ── main ───────────────────────────────────────────────────────────────────

describe("main", () => {
  for (const [label, argv, re] of [
    ["no subcommand", [], /missing subcommand/],
    ["an unknown subcommand", ["review", "--pr", PR], /unknown subcommand: review/],
    ["no --pr", ["gate"], /--pr must be a PR number/],
    ["--pr abc", ["gate", "--pr", "abc"], /--pr must be a PR number/],
    ["--pr 0", ["gate", "--pr", "0"], /--pr must be a PR number/],
    ["--pr 7; rm -rf /", ["note", "--pr", "7; rm -rf /"], /--pr must be a PR number/],
    ["--pr with no value", ["gate", "--pr"], /Missing value for --pr/],
    ["a bad --now", ["gate", "--pr", PR, "--now", "yesterday"], /--now must be a timestamp/],
    ["an empty --now", ["note", "--pr", PR, "--now="], /--now must be a timestamp/],
  ]) {
    it(`rejects ${label} by throwing, before any gh call`, async () => {
      const { deps, calls } = makeDeps();
      await assert.rejects(() => main(argv, deps), re);
      assert.equal(calls.length, 0);
    });
  }

  it("gate: answers the decision for a valid argv (both flag forms)", async () => {
    const { deps } = makeDeps();
    assert.deepEqual(await main(["gate", "--pr", PR, "--now", at(10)], deps), {
      action: "hold",
      reason: "greptile-wait",
      activity: "absent",
      note: "",
    });
    assert.equal((await main(["gate", `--pr=${PR}`, `--now=${at(30)}`], deps)).note, NOT_REVIEWED);
  });

  // Fail open: Greptile is optional and must never keep a green card out of
  // In Test. Both a synchronous throw and a rejected promise land here.
  for (const [label, gh] of [
    [
      "throws",
      () => {
        throw new Error("spawn gh ENOENT");
      },
    ],
    ["rejects", async () => Promise.reject(new Error("spawn gh ENOENT"))],
  ]) {
    it(`gate fails open when deps.gh ${label}`, async () => {
      const { deps } = makeDeps();
      const out = await main(["gate", "--pr", PR, "--now", at(10)], { ...deps, gh });
      assert.equal(out.action, "promote");
      assert.match(out.reason, /^gate-error: /);
      assert.match(out.reason, /spawn gh ENOENT/);
      assert.equal(out.activity, "unavailable");
      assert.equal(out.note, GATE_ERROR);
    });

    it(`note answers the gate-error note when deps.gh ${label}`, async () => {
      const { deps } = makeDeps();
      assert.deepEqual(await main(["note", "--pr", PR, "--now", at(10)], { ...deps, gh }), {
        note: GATE_ERROR,
      });
    });
  }

  it("note: answers {note} for a valid argv", async () => {
    const { deps } = makeDeps({ comments: [GREPTILE_SUMMARY] });
    assert.deepEqual(await main(["note", "--pr", PR, "--now", at(10)], deps), { note: "" });
  });
});

// ── the real CLI (PATH-stubbed gh) ─────────────────────────────────────────

describe("greptile-gate.mjs CLI end to end (PATH-stubbed gh)", () => {
  let root;
  let bin;
  let home;
  let logDir;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "greptile-gate-"));
    bin = path.join(root, "bin");
    home = path.join(root, "home");
    logDir = path.join(root, "log");
    for (const dir of [bin, home, logDir]) mkdirSync(dir);
    // Answers per REST path (the last argument). Quoted case patterns match
    // literally, so the "?" in the list paths is not a glob. Its call log goes
    // to its own dir, so bin/ and home/ can be checked for strays.
    const reviewsJson = JSON.stringify([[GREPTILE_REVIEW]]);
    writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/bin/bash",
        'printf \'%s\\n\' "$*" >>"$GH_CALL_LOG"',
        'for last in "$@"; do :; done',
        'case "$last" in',
        `  "${PR_PATH}") echo '${JSON.stringify({ number: 7, created_at: OPENED })}' ;;`,
        `  "${REVIEWS_PATH}") echo '${reviewsJson}' ;;`,
        `  "${COMMENTS_PATH}") echo '[[]]' ;;`,
        '  *) echo "unexpected gh call: $*" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(path.join(bin, "gh"), 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Built from scratch so a FACTORY_* knob exported by the caller (the
  // factory's plist sets them) can't change the decision.
  const run = (argv) =>
    spawnSync(process.execPath, [CLI, ...argv], {
      cwd: home,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        GH_CALL_LOG: path.join(logDir, "calls.txt"),
      },
    });

  it("gate prints exactly one JSON line, exits 0, and leaves no file behind", () => {
    const res = run(["gate", "--pr", PR, "--now", at(10)]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, "");
    assert.match(res.stdout, /^[^\n]+\n$/, "exactly one line");
    assert.deepEqual(JSON.parse(res.stdout), {
      action: "promote",
      reason: "greptile-reviewed",
      activity: "reviewed",
      note: "",
    });
    // The real gh wrapper passed the argv through intact.
    const logged = readFileSync(path.join(logDir, "calls.txt"), "utf8").trim().split("\n").sort();
    assert.deepEqual(
      logged,
      [
        `api ${PR_PATH}`,
        `api --paginate --slurp ${REVIEWS_PATH}`,
        `api --paginate --slurp ${COMMENTS_PATH}`,
      ].sort(),
    );
    // Stateless: nothing written next to gh, in cwd or under HOME.
    assert.deepEqual(readdirSync(bin), ["gh"]);
    assert.deepEqual(readdirSync(home), []);
    assert.equal(existsSync(path.join(home, "logs")), false);
  });

  it("bad argv exits 1 with a JSON error on stderr and nothing on stdout", () => {
    const res = run(["gate", "--pr", "abc"]);
    assert.equal(res.status, 1);
    assert.equal(res.stdout, "");
    const err = JSON.parse(res.stderr.trim());
    assert.match(err.error, /--pr must be a PR number/);
    assert.match(err.usage, /^Usage: greptile-gate\.mjs <gate\|note>/);
    assert.equal(existsSync(path.join(logDir, "calls.txt")), false, "gh must not run");
    assert.deepEqual(readdirSync(home), []);
  });

  // Comments stripped: the header says, in words, that it never touches the
  // state file.
  it("the module source never references the factory state file", () => {
    const code = readFileSync(CLI, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const needle of ["factory-state", "state-file", "stateFile", "node:fs"]) {
      assert.ok(!code.includes(needle), `greptile-gate.mjs code mentions ${needle}`);
    }
  });
});
