// Tests for scripts/lib/evidence-post.mjs — the operator command that posts a
// macOS In-Test harness run (ADR-0043) on its issue, with the run's
// screenshots (ADR-0072). Those screenshots are of PRODUCTION (a throwaway
// account, and a run starts by signing the operator's own account out, so an
// early shot can show the operator's own notes). So what this file locks in
// is that publishing is never automatic: the command refuses in an unattended
// session, while the throwaway account is live (state.env), on an unfinished
// or secret-matching report, without the publishing self-test and on a run
// already posted; without --yes it only lists what it would publish; with
// --yes it publishes exactly the run's own shots on a parentless evidence
// commit, and posts one comment whose image URLs are pinned to that commit
// and whose untrusted report text can't pass for a factory marker. A failed
// upload posts nothing, so the operator can simply retry.
//
// Nothing here reaches GitHub: origin is a temp bare repo, gh is a stub that
// records its calls, and OCR is a stub function or a fake helper script.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMENT_MAX_CHARS } from "../lib/browser-report.mjs";
import {
  MACOS_REPORT_MARKER,
  POSTED_FILE,
  composeComment,
  main,
  postMacosRun,
  readResults,
  scenarioShaFrom,
} from "../lib/evidence-post.mjs";
import {
  SELFTEST_FILE,
  SELFTEST_PNG,
  UPLOAD_FILE,
  evidenceRef,
  imagePath,
  rawUrl,
} from "../lib/evidence-upload.mjs";

// The fixtures' git (and the command's own default git, which inherits this
// process's environment) must only ever touch the temp repos: a GIT_DIR or
// GIT_WORK_TREE from a hook's environment would point every call at this
// checkout and its GitHub origin.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "evidence-post.mjs");

const ISSUE = "797";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const RUN_NAME = "20261110-051950";
const RUN_ID = `macos-${RUN_NAME}`;
const COMMENT_URL = "https://github.com/JakubAnderwald/drafto/issues/797#issuecomment-4242";
const HEADER = "🏭 **macOS run — the In-Test harness on this Mac mini**";
const TITLE = "Desktop: note editor";
// The shape of a Drafto API key (browser-report.mjs's drafto-api-key pattern); not a real key.
const FAKE_KEY = "dk_0123456789abcdef0123456789abcdef0123456789abcdef";

const STEPS = [
  {
    step: "1",
    name: "Sign in with the throwaway account",
    status: "PASS",
    secs: 12,
    detail: "signed in, the notebooks list is shown",
  },
  {
    step: "2",
    name: "Open a note and type",
    status: "FAIL",
    secs: 30,
    detail: "the editor never got focus",
  },
  { step: "3", name: "Sign out", status: "SKIP", secs: 0, detail: "skipped after step 2" },
];

// common.sh's shot(): shots/NN-<label>.png; step_end's shot is step-<id>-<STATUS>.
const DEFAULT_SHOTS = {
  "01-after-login.png": SELFTEST_PNG,
  "02-step-1-PASS.png": SELFTEST_PNG,
  "03-step-2-FAIL.png": SELFTEST_PNG,
  "04-step-2-FAIL.png": SELFTEST_PNG,
};

// ── fixtures ────────────────────────────────────────────────────────────────

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

function git(cwd, args, { input, env } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** report.md as common.sh's write_report() writes it. */
function harnessReport(steps = STEPS, { run = "Run: all steps ran (exit 0)" } = {}) {
  const counts = {};
  for (const s of steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const totals = Object.keys(counts)
    .sort()
    .map((k) => `${k} ${counts[k]}`)
    .join(", ");
  return [
    `# ${TITLE} — automated In-Test run ${RUN_NAME}`,
    "",
    "Build: Drafto 1.4.0 (212), backend: production",
    "",
    ...(run ? [run, ""] : []),
    "| Step | Check | Result | Time | Evidence |",
    "|---|---|---|---|---|",
    ...steps.map(
      (s) =>
        `| ${s.step} | ${s.name} | ${s.status} | ${s.secs} s | ${s.detail.replace(/\|/g, "/")} |`,
    ),
    "",
    steps.length ? `Totals: ${totals}` : "No steps ran.",
    "",
  ].join("\n");
}

/** results.jsonl as common.sh's step_end() appends it (jq -nc). */
function resultsJsonl(steps = STEPS) {
  return steps
    .map(({ step, name, status, secs, detail }) =>
      JSON.stringify({ step, name, status, secs, detail }),
    )
    .join("\n")
    .concat("\n");
}

/**
 * A temp bare origin, a work repo pointing at it, the factory log dir with a
 * selftest record, and a harness run dir.
 */
function makeFixture({
  selftest = { ok: true },
  report = harnessReport(),
  results = resultsJsonl(),
  shots = DEFAULT_SHOTS,
  runName = RUN_NAME,
} = {}) {
  const root = tempDir("evidence-post-");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  assert.equal(git(root, ["init", "-q", "--bare", origin]).code, 0);
  assert.equal(git(root, ["init", "-q", work]).code, 0);
  git(work, ["config", "user.name", "Factory Test"]);
  git(work, ["config", "user.email", "factory-test@example.com"]);
  git(work, ["config", "commit.gpgsign", "false"]);
  git(work, ["remote", "add", "origin", origin]);

  const logDir = join(root, "log");
  mkdirSync(logDir, { recursive: true });
  if (selftest !== null) {
    writeFileSync(join(logDir, SELFTEST_FILE), `${JSON.stringify(selftest)}\n`);
  }

  const runDir = join(root, "runs", runName);
  mkdirSync(join(runDir, "shots"), { recursive: true });
  if (report !== null) writeFileSync(join(runDir, "report.md"), report);
  if (results !== null) writeFileSync(join(runDir, "results.jsonl"), results);
  for (const [name, data] of Object.entries(shots)) {
    writeFileSync(join(runDir, "shots", name), data);
  }
  // The harness's own images at the run dir root: never part of the evidence.
  writeFileSync(join(runDir, "preflight-window.png"), SELFTEST_PNG);
  writeFileSync(join(runDir, "tmp-ocr.png"), SELFTEST_PNG);
  writeFileSync(join(runDir, "log.txt"), "05:19:50 ── Step 1: Sign in\n");

  const runGit = (args, opts = {}) => git(work, args, opts);
  return { root, origin, work, logDir, runDir, runGit };
}

function ownerComment(sha, body = "Test scenario for In Test.") {
  return {
    author_association: "OWNER",
    body: `${body}\n\n<!-- drafto-factory-scenario-sha:${sha} -->`,
  };
}

/** A gh stub: records every call; reads and keeps each posted comment's body. */
function fakeGh({ comments = [ownerComment(SHA)], apiCode = 0, commentCode = 0 } = {}) {
  const calls = [];
  const posts = [];
  const gh = (args) => {
    calls.push([...args]);
    if (args[0] === "api") {
      return { code: apiCode, stdout: apiCode === 0 ? JSON.stringify(comments) : "", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      const file = args[args.indexOf("--body-file") + 1];
      posts.push({
        args: [...args],
        file,
        body: readFileSync(file, "utf8"),
        mode: statSync(file).mode & 0o777,
      });
      return commentCode === 0
        ? { code: 0, stdout: `${COMMENT_URL}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "HTTP 502" };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
  };
  return { gh, calls, posts };
}

/** A fixture plus the stubs, and the two ways in: postMacosRun and main. */
function setup(opts = {}) {
  const fx = makeFixture(opts);
  const gh = fakeGh(opts.gh);
  const printed = [];
  const ocrCalls = [];
  const ocr = (data, ext) => {
    ocrCalls.push(ext);
    return { ok: true, text: "Drafto\nNotebooks\nInbox" };
  };
  const print = (s) => printed.push(s);
  const base = {
    runDir: fx.runDir,
    issue: ISSUE,
    logDir: fx.logDir,
    repoRoot: fx.work,
    env: {},
    gh: gh.gh,
    git: fx.runGit,
    deps: { ocr },
    print,
  };
  const argv = [
    "macos",
    "--run-dir",
    fx.runDir,
    "--issue",
    ISSUE,
    "--log-dir",
    fx.logDir,
    "--repo-root",
    fx.work,
  ];
  return {
    ...fx,
    gh,
    printed,
    ocrCalls,
    post: (extra = {}) => postMacosRun({ ...base, ...extra }),
    // main without a git runner: the command's own git, on --repo-root.
    cli: (extra = [], deps = {}) =>
      main([...argv, ...extra], { gh: gh.gh, env: {}, deps: { ocr }, print, ...deps }),
  };
}

function assertRefuses(fn, re) {
  assert.throws(fn, (err) => {
    assert.equal(err.constructor.name, "Refusal", `not a refusal: ${err.stack}`);
    assert.match(err.message, re);
    return true;
  });
}

function originRefs(t) {
  return git(t.origin, ["for-each-ref", "--format=%(refname)"]).stdout.split("\n").filter(Boolean);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function img(commit, n, sha = SHA) {
  return `<img src="${rawUrl(commit, imagePath(ISSUE, sha, RUN_ID, n, "png"))}" width="480" alt="Screenshot ${n}">`;
}

function srcs(body) {
  return [...body.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
}

function lineAt(lines, text) {
  const i = lines.indexOf(text);
  assert.notEqual(i, -1, `missing line: ${text}`);
  return i;
}

/** The comment of the default fixture's run, published on <commit>. */
function assertComment(body, commit, { runDir, sha = SHA } = {}) {
  const lines = body.split("\n");
  assert.equal(lines[0], HEADER);
  lineAt(lines, `Run \`${RUN_ID}\`, posted by the operator. It never moves the card.`);
  // The report: its title as bold text (not a heading), then the harness's table.
  const title = lineAt(lines, `**${TITLE} — automated In-Test run ${RUN_NAME}**`);
  assert.equal(
    lines.some((l) => l.startsWith("# ")),
    false,
  );
  lineAt(lines, "Run: all steps ran (exit 0)");
  const row = lineAt(
    lines,
    "| 2 | Open a note and type | FAIL | 30 s | the editor never got focus |",
  );
  lineAt(lines, "Totals: FAIL 1, PASS 1, SKIP 1");

  // Each step's screenshots, mapped from results.jsonl + NN-step-<id>-<STATUS>.png.
  const shots = lineAt(lines, "**Screenshots**");
  const s1 = lineAt(lines, "**Step 1** · PASS · Sign in with the throwaway account");
  assert.deepEqual(lines.slice(s1 + 1, s1 + 3), ["", img(commit, 2, sha)]);
  const s2 = lineAt(lines, "**Step 2** · FAIL · Open a note and type");
  assert.deepEqual(lines.slice(s2 + 1, s2 + 9), [
    "",
    "<details>",
    "<summary>Screenshots (2)</summary>",
    "",
    img(commit, 3, sha),
    img(commit, 4, sha),
    "",
    "</details>",
  ]);
  // Step 3 took no screenshot, so it has no block.
  assert.equal(
    lines.some((l) => l.startsWith("**Step 3**")),
    false,
  );
  // A shot no step is named after.
  const other = lineAt(lines, "**Other screenshots**");
  assert.deepEqual(lines.slice(other + 1, other + 3), ["", img(commit, 1, sha)]);

  // The macOS footer: production, published by the operator; never "dev data".
  const footer = lines.findIndex((l) => l.startsWith("<sub>") && l.includes("ADR-0072"));
  assert.notEqual(footer, -1, "no footer");
  assert.match(lines[footer], /production/);
  assert.doesNotMatch(lines[footer], /dev data/);
  if (runDir) assert.ok(lines[footer].includes(join(runDir, "shots")), lines[footer]);

  assert.ok(
    title < row && row < shots && shots < s1 && s1 < s2 && s2 < other && other < footer,
    "the comment's sections are out of order",
  );
  assert.equal(lines.at(-1), MACOS_REPORT_MARKER);
  assert.equal((body.match(/<!--/g) ?? []).length, 1, "only the marker is an HTML comment");

  // Only raw.githubusercontent URLs of this repo, pinned to the evidence
  // commit (never a branch tip), and nothing else uploaded.
  assert.deepEqual(
    srcs(body).sort(),
    [1, 2, 3, 4].map((n) => rawUrl(commit, imagePath(ISSUE, sha, RUN_ID, n, "png"))).sort(),
  );
  for (const u of srcs(body)) {
    assert.ok(
      u.startsWith(`https://raw.githubusercontent.com/JakubAnderwald/drafto/${commit}/`),
      u,
    );
  }
  assert.doesNotMatch(body, /preflight-window|tmp-ocr/);
}

/** The evidence commit on origin: parentless, exactly the run's four shots. */
function assertEvidenceCommit(t, sha = SHA) {
  const ref = evidenceRef(ISSUE, sha, RUN_ID);
  assert.deepEqual(originRefs(t), [ref]);
  const commit = git(t.origin, ["rev-parse", ref]).stdout.trim();
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.notEqual(commit, sha);
  const raw = git(t.origin, ["cat-file", "-p", commit]).stdout;
  assert.equal(
    raw.split("\n").some((l) => l.startsWith("parent ")),
    false,
    "the evidence commit has a parent",
  );
  const paths = git(t.origin, ["ls-tree", "-r", "--name-only", commit])
    .stdout.split("\n")
    .filter(Boolean);
  const names = Object.keys(DEFAULT_SHOTS);
  assert.deepEqual(
    paths,
    [1, 2, 3, 4].map((n) => imagePath(ISSUE, sha, RUN_ID, n, "png")),
  );
  for (const [i, rel] of paths.entries()) {
    const blob = git(t.origin, ["rev-parse", `${commit}:${rel}`]).stdout.trim();
    const local = git(t.work, ["hash-object", join(t.runDir, "shots", names[i])]).stdout.trim();
    assert.equal(blob, local, `${rel} isn't ${names[i]}'s bytes`);
  }
  return commit;
}

function commentCalls(gh) {
  return gh.calls.filter((a) => a[0] === "issue");
}

// ── inputs ──────────────────────────────────────────────────────────────────

describe("readResults", () => {
  it("maps results.jsonl rows and skips lines that aren't result objects", () => {
    const dir = tempDir("evidence-post-results-");
    const file = join(dir, "results.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ step: "1", name: "Sign in", status: "PASS", secs: 3, detail: "ok" }),
        "not json at all",
        '{"step": "2", "name": "half a line',
        JSON.stringify({ step: 3, name: "a numeric step id", status: "PASS" }),
        "null",
        "[]",
        '"a string"',
        "",
        "   ",
        JSON.stringify({ step: "4" }),
        JSON.stringify({ step: "5", name: 5, status: ["FAIL"] }),
        JSON.stringify({ step: "6", name: "Sign out", status: "SKIP" }),
      ].join("\n"),
    );
    assert.deepEqual(readResults(file), [
      { step: "1", name: "Sign in", status: "PASS" },
      { step: "4", name: "", status: "" },
      { step: "5", name: "", status: "" },
      { step: "6", name: "Sign out", status: "SKIP" },
    ]);
  });

  it("reads a missing file as no results", () => {
    assert.deepEqual(readResults(join(tempDir("evidence-post-results-"), "nope.jsonl")), []);
  });
});

describe("scenarioShaFrom", () => {
  const marker = (sha) => `<!-- drafto-factory-scenario-sha:${sha} -->`;

  it("takes the newest marker on the factory's own (OWNER) comments", () => {
    assert.equal(scenarioShaFrom([ownerComment(OTHER_SHA), ownerComment(SHA)]), SHA);
    assert.equal(
      scenarioShaFrom([
        { author_association: "OWNER", body: `${marker(OTHER_SHA)}\n${marker(SHA)}` },
      ]),
      SHA,
    );
  });

  it("reads gh's camelCase authorAssociation too", () => {
    assert.equal(scenarioShaFrom([{ authorAssociation: "OWNER", body: marker(SHA) }]), SHA);
  });

  it("ignores a marker on anyone else's comment, even a newer one", () => {
    const comments = [
      ownerComment(SHA),
      { author_association: "CONTRIBUTOR", body: marker(OTHER_SHA) },
      { author_association: "NONE", body: marker(OTHER_SHA) },
      { author_association: "MEMBER", body: marker(OTHER_SHA) },
      { body: marker(OTHER_SHA) },
    ];
    assert.equal(scenarioShaFrom(comments), SHA);
    assert.equal(scenarioShaFrom(comments.slice(1)), null);
  });

  it("is null without a full 40-hex marker, or without a comment list", () => {
    assert.equal(scenarioShaFrom([]), null);
    assert.equal(scenarioShaFrom(null), null);
    assert.equal(scenarioShaFrom({ body: marker(SHA) }), null);
    assert.equal(scenarioShaFrom([{ author_association: "OWNER", body: "no marker" }]), null);
    assert.equal(
      scenarioShaFrom([{ author_association: "OWNER", body: marker(SHA.slice(0, 12)) }]),
      null,
    );
    assert.equal(
      scenarioShaFrom([{ author_association: "OWNER", body: marker(SHA.toUpperCase()) }]),
      null,
    );
    assert.equal(scenarioShaFrom([null, { author_association: "OWNER" }]), null);
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

describe("postMacosRun refusals", () => {
  // Each refusal here comes before anything leaves the Mac mini: no gh call,
  // no push, no print.
  function assertNothingHappened(t) {
    assert.deepEqual(t.gh.calls, []);
    assert.deepEqual(t.printed, []);
    assert.deepEqual(originRefs(t), []);
    assert.equal(existsSync(join(t.runDir, UPLOAD_FILE)), false);
    assert.equal(existsSync(join(t.runDir, POSTED_FILE)), false);
  }

  it("refuses in an unattended session (DRAFTO_UNATTENDED=1), with or without --yes", () => {
    const t = setup();
    for (const yes of [false, true]) {
      assertRefuses(
        () => t.post({ yes, env: { DRAFTO_UNATTENDED: "1" } }),
        /unattended session \(DRAFTO_UNATTENDED=1\): a macOS run is posted by a person/,
      );
    }
    assertNothingHappened(t);
  });

  it("refuses while the run's throwaway account is still live (state.env exists)", () => {
    const t = setup();
    writeFileSync(join(t.runDir, "state.env"), "QA_EMAIL=qa@example.com\nQA_PASSWORD=x\n");
    for (const yes of [false, true]) {
      assertRefuses(() => t.post({ yes }), /state\.env exists.*--cleanup-only first/);
    }
    assertNothingHappened(t);
  });

  it("refuses a run dir that is missing or isn't a directory", () => {
    const t = setup();
    assertRefuses(() => t.post({ runDir: join(t.root, "runs", "nope") }), /no run directory at/);
    const file = join(t.root, "runs", "a-file");
    writeFileSync(file, "x");
    assertRefuses(() => t.post({ runDir: file }), /is not a directory/);
    assertNothingHappened(t);
  });

  it("refuses a report.md with no Run: line (the run didn't finish writing it)", () => {
    const t = setup({ report: harnessReport(STEPS, { run: "" }) });
    for (const yes of [false, true]) {
      assertRefuses(() => t.post({ yes }), /report\.md has no Run: line/);
    }
    assertNothingHappened(t);
  });

  it("refuses a run with no report.md", () => {
    const t = setup({ report: null });
    assertRefuses(() => t.post({ yes: true }), /the run has no report\.md/);
    assertNothingHappened(t);
  });

  it("refuses a report.md that matches a secret pattern, naming the pattern, never the value", () => {
    const leaky = STEPS.map((s) =>
      s.step === "2" ? { ...s, detail: `the settings page showed ${FAKE_KEY}` } : s,
    );
    const t = setup({ report: harnessReport(leaky) });
    for (const yes of [false, true]) {
      assert.throws(
        () => t.post({ yes }),
        (err) => {
          assert.equal(err.constructor.name, "Refusal");
          assert.match(err.message, /report\.md matched a secret pattern \(drafto-api-key\)/);
          assert.equal(err.message.includes(FAKE_KEY), false);
          return true;
        },
      );
    }
    assertNothingHappened(t);
  });

  it("refuses a run already posted (posted.json), quoting the comment", () => {
    const t = setup();
    writeFileSync(
      join(t.runDir, POSTED_FILE),
      `${JSON.stringify({ issue: ISSUE, sha: SHA, runId: RUN_ID, url: COMMENT_URL, upload: true })}\n`,
    );
    for (const yes of [false, true]) {
      assertRefuses(
        () => t.post({ yes }),
        new RegExp(`this run was already posted: ${COMMENT_URL.replace(/[.?]/g, "\\$&")}`),
      );
    }
    assert.deepEqual(t.gh.calls, []);
    assert.deepEqual(originRefs(t), []);
  });

  it("refuses a run dir whose name makes no run id", () => {
    const t = setup({ runName: "@@@" });
    assertRefuses(() => t.post({ yes: true }), /can't make a run id from @@@/);
    assertNothingHappened(t);
  });

  it("refuses without a passed publishing self-test, or when publishing is switched off", () => {
    const cases = [
      [{ selftest: null }, {}, /screenshots can't be published: selftest-missing/],
      [
        { selftest: { ok: false, reason: "push" } },
        {},
        /screenshots can't be published: selftest-failed/,
      ],
      [{}, { FACTORY_EVIDENCE_UPLOAD: "0" }, /screenshots can't be published: off/],
    ];
    for (const [opts, env, re] of cases) {
      const t = setup(opts);
      for (const yes of [false, true]) assertRefuses(() => t.post({ yes, env }), re);
      assert.deepEqual(commentCalls(t.gh), []);
      assert.deepEqual(t.printed, []);
      assert.deepEqual(originRefs(t), []);
      assert.equal(existsSync(join(t.runDir, POSTED_FILE)), false);
    }
  });

  it("refuses without a scenario-sha marker on the issue and no --sha", () => {
    const cases = [
      { comments: [] },
      { comments: [{ author_association: "OWNER", body: "Scenario, no marker" }] },
      // Only someone else's comment carries a marker: never trusted.
      {
        comments: [
          {
            author_association: "CONTRIBUTOR",
            body: `<!-- drafto-factory-scenario-sha:${SHA} -->`,
          },
        ],
      },
      { apiCode: 1 },
    ];
    for (const gh of cases) {
      const t = setup({ gh });
      assertRefuses(
        () => t.post({ yes: true }),
        /no scenario-sha marker on #797's comments: pass --sha <40-hex>/,
      );
      assert.deepEqual(t.gh.calls, [
        ["api", "repos/JakubAnderwald/drafto/issues/797/comments", "--paginate"],
      ]);
      assert.deepEqual(originRefs(t), []);
    }
  });

  it("refuses a --sha that isn't 40 hex", () => {
    const t = setup();
    for (const sha of ["abc123", SHA.toUpperCase(), `${SHA}0`, "HEAD"]) {
      assertRefuses(() => t.post({ yes: true, sha }), /the run's commit isn't a 40-hex SHA/);
    }
    assert.deepEqual(t.gh.calls, []);
    assert.deepEqual(originRefs(t), []);
  });

  it("refuses when no OCR helper can scan the screenshots for secrets", () => {
    const t = setup();
    // No deps.ocr, no --ocr, no <log-dir>/bin/ocr, no harness helper under the repo root.
    assertRefuses(() => t.post({ deps: {} }), /screenshots can't be published: ocr-missing/);
    assertRefuses(
      () => t.post({ yes: true, deps: {} }),
      /publishing the screenshots failed \(ocr-missing\); nothing was posted/,
    );
    assert.deepEqual(commentCalls(t.gh), []);
    assert.deepEqual(originRefs(t), []);
    assert.equal(existsSync(join(t.runDir, POSTED_FILE)), false);
  });
});

// ── listing (no --yes) ──────────────────────────────────────────────────────

describe("postMacosRun without --yes", () => {
  it("only lists what it would publish, with the warning and the report, and publishes nothing", () => {
    const t = setup();
    const r = t.post();
    assert.deepEqual(r, { listed: true, publish: 4, keep: 0 });
    const shots = join(t.runDir, "shots");
    assert.deepEqual(t.printed.slice(0, 5), [
      `Would post the report of ${t.runDir} on #797 (commit ${SHA.slice(0, 12)}), with:`,
      `  publish  ${join(shots, "01-after-login.png")}`,
      `  publish  ${join(shots, "02-step-1-PASS.png")}`,
      `  publish  ${join(shots, "03-step-2-FAIL.png")}`,
      `  publish  ${join(shots, "04-step-2-FAIL.png")}`,
    ]);
    const out = t.printed.join("\n");
    // The run dir's own images are never candidates.
    assert.doesNotMatch(out, /preflight-window|tmp-ocr/);
    assert.match(
      out,
      /Look at each file first: an early shot can show your own account's notes\n\(a run starts by signing it out\)/,
    );
    // The report exactly as it would be posted: title as bold, the table.
    assert.ok(out.includes(`**${TITLE} — automated In-Test run ${RUN_NAME}**`));
    assert.ok(out.includes("| 1 | Sign in with the throwaway account | PASS | 12 s |"));
    assert.equal(
      t.printed.at(-1),
      "Run again with --yes to publish the screenshots and post the comment.",
    );
    // Every listed shot was OCR-scanned, as it would be for real.
    assert.equal(t.ocrCalls.length, 4);

    // Nothing pushed, nothing posted, nothing recorded.
    assert.deepEqual(originRefs(t), []);
    assert.deepEqual(t.gh.calls, [
      ["api", "repos/JakubAnderwald/drafto/issues/797/comments", "--paginate"],
    ]);
    assert.equal(existsSync(join(t.runDir, UPLOAD_FILE)), false);
    assert.equal(existsSync(join(t.runDir, POSTED_FILE)), false);
  });

  it("lists main's run without --yes the same way (a listing is exit 0, not a post)", () => {
    const t = setup();
    assert.deepEqual(t.cli(), { listed: true, publish: 4, keep: 0 });
    assert.deepEqual(originRefs(t), []);
    assert.deepEqual(commentCalls(t.gh), []);
  });

  it("lists a shot that fails a file check as kept, with why", () => {
    const t = setup({
      shots: { ...DEFAULT_SHOTS, "05-step-3-SKIP.png": Buffer.from("not a png at all") },
    });
    assert.deepEqual(t.post(), { listed: true, publish: 4, keep: 1 });
    assert.ok(
      t.printed.includes(
        `  keep     ${join(t.runDir, "shots", "05-step-3-SKIP.png")} (its bytes aren't a PNG image)`,
      ),
      t.printed.join("\n"),
    );
  });

  it("lists what is over the per-comment cap (20 images) as kept", () => {
    const shots = {};
    for (let n = 1; n <= 22; n++)
      shots[`${String(n).padStart(2, "0")}-extra-${n}.png`] = SELFTEST_PNG;
    const t = setup({ shots });
    assert.deepEqual(t.post(), { listed: true, publish: 20, keep: 2 });
    const kept = t.printed.filter((l) => l.startsWith("  keep "));
    assert.deepEqual(kept, [
      `  keep     ${join(t.runDir, "shots", "21-extra-21.png")} (over the per-comment cap (20 images / 20 MB))`,
      `  keep     ${join(t.runDir, "shots", "22-extra-22.png")} (over the per-comment cap (20 images / 20 MB))`,
    ]);
  });

  it("says so when the run saved no screenshot", () => {
    const t = setup({ shots: {} });
    assert.deepEqual(t.post(), { listed: true, publish: 0, keep: 0 });
    assert.ok(t.printed.includes("  (no screenshot to publish)"));
  });

  it("uses the OCR helper at <log-dir>/bin/ocr by default, and --ocr when given", () => {
    const t = setup();
    const bin = join(t.logDir, "bin");
    mkdirSync(bin, { recursive: true });
    const clean = join(bin, "ocr");
    writeFileSync(
      clean,
      `#!/bin/sh\nprintf '%s\\n' '{"items":[{"text":"Drafto"},{"text":"Inbox"}]}'\n`,
    );
    chmodSync(clean, 0o755);
    assert.deepEqual(t.post({ deps: {} }), { listed: true, publish: 4, keep: 0 });

    // A helper that reads a key off every shot: all of them stay on the Mac mini.
    const leaky = join(t.root, "leaky-ocr");
    writeFileSync(
      leaky,
      `#!/bin/sh\nprintf '%s\\n' '{"items":[{"text":"Your key: ${FAKE_KEY}"}]}'\n`,
    );
    chmodSync(leaky, 0o755);
    t.printed.length = 0;
    assert.deepEqual(t.cli(["--ocr", leaky], { deps: {} }), { listed: true, publish: 0, keep: 4 });
    const kept = t.printed.filter((l) => l.startsWith("  keep "));
    assert.equal(kept.length, 4);
    for (const l of kept)
      assert.match(l, /\(its text matched a secret pattern \(drafto-api-key\)\)$/);
    assert.ok(t.printed.includes("  (no screenshot to publish)"));
    assert.equal(t.printed.join("\n").includes(FAKE_KEY), false);
  });

  it("resolves a relative --ocr path, like its other path flags", () => {
    const t = setup();
    const helper = join(t.root, "ocr-helper");
    writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' '{"items":[{"text":"Drafto"}]}'\n`);
    chmodSync(helper, 0o755);
    const rel = relative(process.cwd(), helper);
    assert.equal(isAbsolute(rel), false);
    assert.deepEqual(t.cli(["--ocr", rel], { deps: {} }), { listed: true, publish: 4, keep: 0 });
  });

  it("takes the newest OWNER marker on the issue as the run's commit", () => {
    const t = setup({
      gh: {
        comments: [
          ownerComment(OTHER_SHA),
          ownerComment(SHA),
          {
            author_association: "NONE",
            body: `<!-- drafto-factory-scenario-sha:${OTHER_SHA} -->`,
          },
        ],
      },
    });
    t.post();
    assert.match(t.printed[0], new RegExp(`\\(commit ${SHA.slice(0, 12)}\\)`));
  });

  it("--sha overrides the comment lookup", () => {
    const t = setup();
    t.cli(["--sha", OTHER_SHA]);
    assert.match(t.printed[0], new RegExp(`\\(commit ${OTHER_SHA.slice(0, 12)}\\)`));
    assert.deepEqual(t.gh.calls, []);
  });
});

// ── posting (--yes) ─────────────────────────────────────────────────────────

describe("posting with --yes", () => {
  it("main --yes publishes the run's own shots and posts one comment, then refuses a second run", () => {
    const t = setup();
    const r = t.cli(["--yes"]);
    assert.deepEqual(r, { posted: true, url: COMMENT_URL, upload: true, reason: null });

    // The run's shots, on a parentless commit on its own evidence ref.
    const commit = assertEvidenceCommit(t);

    // Exactly one comment, from a private temp file that is gone afterwards.
    assert.equal(t.gh.posts.length, 1);
    const post = t.gh.posts[0];
    assert.deepEqual(post.args, [
      "issue",
      "comment",
      ISSUE,
      "--repo",
      "JakubAnderwald/drafto",
      "--body-file",
      post.file,
    ]);
    assert.equal(post.mode, 0o600);
    assert.equal(existsSync(post.file), false);
    assertComment(post.body, commit, { runDir: t.runDir });

    // The run is recorded as posted, privately.
    const postedFile = join(t.runDir, POSTED_FILE);
    assert.deepEqual(readJson(postedFile), {
      issue: ISSUE,
      sha: SHA,
      runId: RUN_ID,
      url: COMMENT_URL,
      upload: true,
    });
    assert.equal(statSync(postedFile).mode & 0o777, 0o600);
    assert.equal(readJson(join(t.runDir, UPLOAD_FILE)).commit, commit);
    assert.deepEqual(t.printed, [`Posted on #797: ${COMMENT_URL}`]);

    // A second --yes run refuses: one comment per run.
    assertRefuses(() => t.cli(["--yes"]), /this run was already posted: https:\/\/github\.com\//);
    assert.equal(t.gh.posts.length, 1);
    assert.deepEqual(originRefs(t), [evidenceRef(ISSUE, SHA, RUN_ID)]);
  });

  it("postMacosRun({yes: true}) with an injected git does the same", () => {
    const t = setup();
    const r = t.post({ yes: true });
    assert.equal(r.posted, true);
    assert.equal(r.url, COMMENT_URL);
    const commit = assertEvidenceCommit(t);
    assert.equal(commentCalls(t.gh).length, 1);
    assertComment(t.gh.posts[0].body, commit, { runDir: t.runDir });
    assertRefuses(() => t.post({ yes: true }), /already posted/);
    assert.equal(commentCalls(t.gh).length, 1);
  });

  it("--sha overrides the comment lookup for the ref and the record", () => {
    const t = setup();
    t.cli(["--yes", "--sha", OTHER_SHA]);
    assert.equal(
      t.gh.calls.some((a) => a[0] === "api"),
      false,
    );
    const commit = assertEvidenceCommit(t, OTHER_SHA);
    assertComment(t.gh.posts[0].body, commit, { sha: OTHER_SHA });
    assert.equal(readJson(join(t.runDir, POSTED_FILE)).sha, OTHER_SHA);
  });

  it("defangs the report: no factory marker, no <details>/<summary>, no open fence", () => {
    const report = [
      `# ${TITLE} — automated In-Test run ${RUN_NAME}`,
      "",
      "Build: Drafto 1.4.0 (212), backend: production",
      "",
      "Run: all steps ran (exit 0)",
      "",
      "| Step | Check | Result | Time | Evidence |",
      "|---|---|---|---|---|",
      "| 1 | Sign in with the throwaway account | PASS | 12 s | note said <!-- drafto-factory-feedback --> |",
      "| 2 | Open a note and type | FAIL | 30 s | note said </details><details><summary>click</summary> |",
      "",
      "Totals: FAIL 1, PASS 1",
      "",
      "```",
      "a pasted log with an unclosed fence",
      "",
    ].join("\n");
    const t = setup({ report });
    t.post({ yes: true });
    const body = t.gh.posts[0].body;
    const lines = body.split("\n");

    assert.equal(body.includes("drafto-factory-feedback"), false);
    assert.ok(body.includes("note said &lt;!-- drafto​-factory-feedback -->"));
    assert.ok(body.includes("note said &lt;/details>&lt;details>&lt;summary>click&lt;/summary>"));
    // The only HTML comment is the command's own marker, last.
    assert.equal((body.match(/<!--/g) ?? []).length, 1);
    assert.equal(lines.at(-1), MACOS_REPORT_MARKER);
    // The only <details> is step 2's screenshots.
    assert.equal((body.match(/<details>/g) ?? []).length, 1);
    assert.equal((body.match(/<\/details>/g) ?? []).length, 1);
    assert.equal((body.match(/<summary>/g) ?? []).length, 1);
    // The report's open fence is closed before the screenshots.
    const fences = lines.map((l, i) => (/^ {0,3}```/.test(l) ? i : -1)).filter((i) => i >= 0);
    assert.equal(fences.length % 2, 0, "a fence is left open");
    assert.ok(fences.at(-1) < lines.indexOf("**Screenshots**"));
    assert.equal(srcs(body).length, 4);
  });

  it("posts nothing when the upload's push fails, and a retry posts", () => {
    const t = setup();
    const pushes = [];
    const failingPush = (args, opts) => {
      if (args.includes("push")) {
        pushes.push(args);
        return { code: 1, stdout: "", stderr: "! [remote rejected]" };
      }
      return t.runGit(args, opts);
    };
    assertRefuses(
      () => t.post({ yes: true, git: failingPush }),
      /publishing the screenshots failed \(push\); nothing was posted: run again to retry/,
    );
    assert.equal(pushes.length, 1);
    assert.deepEqual(commentCalls(t.gh), []);
    assert.deepEqual(t.printed, []);
    assert.equal(existsSync(join(t.runDir, POSTED_FILE)), false);
    assert.deepEqual(readJson(join(t.runDir, UPLOAD_FILE)), {
      ok: false,
      issue: ISSUE,
      sha: SHA,
      runId: RUN_ID,
      ref: evidenceRef(ISSUE, SHA, RUN_ID),
      reason: "push",
      overflow: [],
    });
    assert.deepEqual(originRefs(t), []);

    // The failed record isn't reused: the retry publishes and posts.
    assert.equal(t.post({ yes: true }).posted, true);
    const commit = assertEvidenceCommit(t);
    assert.equal(commentCalls(t.gh).length, 1);
    assertComment(t.gh.posts[0].body, commit);
  });

  it("posts nothing when origin can't be reached (main's own git)", () => {
    const t = setup();
    git(t.work, ["remote", "set-url", "origin", join(t.root, "missing.git")]);
    assertRefuses(() => t.cli(["--yes"]), /publishing the screenshots failed \(remote\)/);
    assert.deepEqual(commentCalls(t.gh), []);
    assert.equal(existsSync(join(t.runDir, POSTED_FILE)), false);
  });

  it("a failed comment post records nothing posted; the retry reuses the upload, pushing once", () => {
    const t = setup({ gh: { commentCode: 1 } });
    let pushes = 0;
    const counting = (args, opts) => {
      if (args.includes("push")) pushes++;
      return t.runGit(args, opts);
    };
    assertRefuses(
      () => t.post({ yes: true, git: counting }),
      /posting the comment failed \(gh issue comment\)/,
    );
    assert.equal(pushes, 1);
    assert.equal(existsSync(join(t.runDir, POSTED_FILE)), false);
    assert.equal(readJson(join(t.runDir, UPLOAD_FILE)).ok, true);
    assert.equal(existsSync(t.gh.posts[0].file), false);

    const gh2 = fakeGh();
    assert.equal(t.post({ yes: true, git: counting, gh: gh2.gh }).posted, true);
    assert.equal(pushes, 1, "the retry pushed again");
    assert.deepEqual(srcs(gh2.posts[0].body), srcs(t.gh.posts[0].body));
    assert.equal(existsSync(join(t.runDir, POSTED_FILE)), true);
  });

  it("posts a run with no screenshots without pushing, saying none were saved", () => {
    const t = setup({ shots: {} });
    assert.equal(t.post({ yes: true }).posted, true);
    assert.deepEqual(originRefs(t), []);
    const body = t.gh.posts[0].body;
    assert.equal(body.includes("<img"), false);
    assert.equal(body.includes("**Screenshots**"), false);
    assert.match(body, /Screenshots stay on the Mac mini.*the run saved no screenshots/);
    assert.equal(body.split("\n").at(-1), MACOS_REPORT_MARKER);
  });

  it("lists a shot that fails a check in the comment as kept on the Mac mini", () => {
    const t = setup({
      shots: { ...DEFAULT_SHOTS, "05-step-3-SKIP.png": Buffer.from("not a png at all") },
    });
    t.post({ yes: true });
    const commit = assertEvidenceCommit(t);
    const body = t.gh.posts[0].body;
    assert.equal(srcs(body).length, 4);
    assert.ok(body.includes(img(commit, 2)));
    assert.ok(body.includes("**Kept on the Mac mini** (not published):"));
    assert.ok(
      body.includes(
        `- screenshot 5, its bytes aren't a PNG image: \`${join(t.runDir, "shots", "05-step-3-SKIP.png")}\``,
      ),
      body,
    );
  });

  it("drops step labels from results.jsonl that match a secret pattern", () => {
    // results.jsonl names a step after a key that report.md doesn't show (the
    // report was scanned; the step labels come from results.jsonl).
    const leaky = STEPS.map((s) => (s.step === "2" ? { ...s, name: `Paste ${FAKE_KEY}` } : s));
    const t = setup({ report: harnessReport(STEPS), results: resultsJsonl(leaky) });
    let posted = false;
    try {
      posted = t.post({ yes: true }).posted === true;
    } catch (err) {
      // Refusing the post is safe too; posting the key is not.
      assert.equal(err.constructor.name, "Refusal");
    }
    if (posted) {
      const body = t.gh.posts[0].body;
      assert.equal(body.replace(/\\/g, "").includes(FAKE_KEY), false, "the key was posted");
      assert.equal(srcs(body).length, 4);
    }
  });
});

// ── the comment ─────────────────────────────────────────────────────────────

describe("composeComment", () => {
  const C = "abcdef0123456789abcdef0123456789abcdef01";
  const pinned = (n) => rawUrl(C, imagePath(ISSUE, SHA, RUN_ID, n, "png"));
  const upload = {
    ok: true,
    commit: C,
    images: [
      { n: 1, url: pinned(1), label: "after-login" },
      // Not pinned to the record's commit: a branch tip is never rendered.
      {
        n: 2,
        url: `https://raw.githubusercontent.com/JakubAnderwald/drafto/main/${imagePath(ISSUE, SHA, RUN_ID, 2, "png")}`,
        label: "step-1-PASS",
      },
      { n: 3, url: rawUrl(SHA, imagePath(ISSUE, SHA, RUN_ID, 3, "png")), label: "step-2-FAIL" },
    ],
    overflow: [],
  };
  const results = STEPS.map(({ step, name, status }) => ({ step, name, status }));

  it("renders only images pinned to the upload's own commit", () => {
    const { body, embedded } = composeComment({
      report: harnessReport(),
      upload,
      results,
      shotsDir: "/tmp/run/shots",
      runId: RUN_ID,
    });
    assert.equal(embedded, 1);
    assert.deepEqual(srcs(body), [pinned(1)]);
    assert.equal(body.split("\n").at(-1), MACOS_REPORT_MARKER);
  });

  it("cuts a long report to fit, keeping the screenshots and the marker last", () => {
    const rows = [];
    for (let i = 1; i <= 400; i++)
      rows.push({ ...STEPS[0], step: String(i), detail: "x".repeat(200) });
    const report = harnessReport(rows);
    assert.ok(report.length > COMMENT_MAX_CHARS);
    const { body } = composeComment({
      report,
      upload,
      results,
      shotsDir: "/tmp/run/shots",
      runId: RUN_ID,
    });
    assert.ok(body.length <= COMMENT_MAX_CHARS, `${body.length} > ${COMMENT_MAX_CHARS}`);
    assert.ok(body.includes("_…report truncated; the full report is in the run directory._"));
    assert.equal(body.split("\n")[0], HEADER);
    assert.deepEqual(srcs(body), [pinned(1)]);
    assert.equal(body.split("\n").at(-1), MACOS_REPORT_MARKER);
  });
});

// ── the CLI ─────────────────────────────────────────────────────────────────

describe("main", () => {
  const isUsage = (re) => (err) => {
    assert.equal(err.constructor.name, "UsageError", `not a usage error: ${err.stack}`);
    assert.match(err.message, re);
    return true;
  };

  it("rejects a missing subcommand, --run-dir or --issue as a usage error", () => {
    const t = setup();
    const deps = { gh: t.gh.gh, env: {}, print: (s) => t.printed.push(s) };
    assert.throws(() => main([], deps), isUsage(/usage: evidence-post\.mjs macos --run-dir/));
    assert.throws(() => main(["linux", "--run-dir", t.runDir], deps), isUsage(/usage/));
    assert.throws(() => main(["macos", "--issue", ISSUE], deps), isUsage(/--run-dir required/));
    assert.throws(
      () => main(["macos", "--run-dir", t.runDir], deps),
      isUsage(/--issue <n> required/),
    );
    for (const issue of ["abc", "0797", "-1", "797x"]) {
      assert.throws(
        () => main(["macos", "--run-dir", t.runDir, "--issue", issue], deps),
        isUsage(/--issue <n> required/),
      );
    }
    assert.throws(() => main(["macos", "--run-dir"], deps), /Missing value for --run-dir/);
    assert.deepEqual(t.gh.calls, []);
    assert.deepEqual(t.printed, []);
  });

  it("exits 2 on a usage error and 1 on a refusal, before any gh call", () => {
    const t = setup();
    // A gh on PATH that would show it was called; the command must not get that far.
    const bin = join(t.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho called >> "${join(bin, "gh.log")}"\nexit 97\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DRAFTO_UNATTENDED: "" };
    const run = (args, extra = {}) =>
      spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...env, ...extra } });

    let r = run(["macos"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /evidence-post: --run-dir required/);
    r = run(["macos", "--run-dir"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Missing value for --run-dir/);
    r = run(["macos", "--run-dir", t.runDir, "--issue", ISSUE, "--yes"], {
      DRAFTO_UNATTENDED: "1",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /evidence-post: this is an unattended session/);
    r = run(["macos", "--run-dir", join(t.root, "nope"), "--issue", ISSUE]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /no run directory at/);
    assert.equal(existsSync(join(bin, "gh.log")), false, "gh was called");
  });
});
