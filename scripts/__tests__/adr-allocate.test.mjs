// ADR-0103: the implement bundle's ADR number, clear of main and of every open
// PR's. Mirrors migration-renumber.test.mjs's claimedVersions and next-version
// cases: a real git origin, and gh injected.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ADR_CLAIM_PATH_RE, main as allocateMain } from "../lib/adr-allocate.mjs";
import { claimedVersions } from "../lib/migration-renumber.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "lib", "adr-allocate.mjs");

function gitIn(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// A fake gh: `pr list` gives <prs>' numbers, and each PR's files endpoint its
// "<status>\t<path>" lines (a bare path is `added`). A PR mapped to null fails.
function fakeGh(prs) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify(Object.keys(prs).map((number) => ({ number: Number(number) })));
    }
    const n = /pulls\/(\d+)\/files/.exec(args[2] ?? "")?.[1];
    const files = prs[n];
    if (files === null || files === undefined) throw new Error(`gh api failed: HTTP 502 (#${n})`);
    return files.map((f) => (f.includes("\t") ? f : `added\t${f}`)).join("\n");
  };
  return { gh, calls };
}

describe("claimedVersions with the ADR path", () => {
  it("lists only numbered ADRs directly under docs/adr", () => {
    const { gh } = fakeGh({
      901: [
        "docs/adr/0099-new.md",
        "renamed\tdocs/adr/0100-moved.md",
        "modified\tdocs/adr/0050-amended.md",
        "docs/adr/README.md",
        "docs/adr/drafts/0101-nested.md",
        "supabase/migrations/20261113000001_x.sql",
      ],
    });
    const r = claimedVersions({ gh, warn: () => {}, pathRe: ADR_CLAIM_PATH_RE });
    assert.deepEqual(r.claimed, [
      { pr: 901, file: "0099-new.md" },
      { pr: 901, file: "0100-moved.md" },
    ]);
  });

  it("names what it couldn't avoid when a PR's files can't be listed", () => {
    const warnings = [];
    const { gh } = fakeGh({ 801: null, 901: ["docs/adr/0099-new.md"] });
    const r = claimedVersions({
      gh,
      warn: (m) => warnings.push(m),
      pathRe: ADR_CLAIM_PATH_RE,
      what: "ADR numbers",
    });
    assert.deepEqual(r.skipped, [801]);
    assert.match(warnings.join("\n"), /couldn't list PR #801's files, so its ADR numbers/);
  });
});

describe("adr-allocate next-adr", () => {
  let bare;
  let root;

  before(() => {
    bare = mkdtempSync(join(tmpdir(), "adr-allocate-origin-"));
    gitIn(bare, ["init", "--bare", "-q", "-b", "main"]);
    const seed = mkdtempSync(join(tmpdir(), "adr-allocate-seed-"));
    gitIn(seed, ["init", "-q", "-b", "main"]);
    gitIn(seed, ["config", "user.email", "test@example.com"]);
    gitIn(seed, ["config", "user.name", "Test"]);
    mkdirSync(join(seed, "docs", "adr"), { recursive: true });
    for (const f of ["0000-adr-template.md", "0097-a.md", "0098-b.md", "README.md"]) {
      writeFileSync(join(seed, "docs", "adr", f), `# ${f}\n`);
    }
    gitIn(seed, ["add", "-A"]);
    gitIn(seed, ["commit", "-q", "-m", "seed"]);
    gitIn(seed, ["remote", "add", "origin", bare]);
    gitIn(seed, ["push", "-q", "origin", "main"]);
    rmSync(seed, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "adr-allocate-root-"));
    gitIn(root, ["clone", "-q", bare, "."]);
  });

  after(() => {
    rmSync(bare, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const run = (args, gh, now) => allocateMain(["next-adr", "--root", root, ...args], { gh, now });

  it("is one past main's newest with no open PR", () => {
    const { gh } = fakeGh({});
    assert.deepEqual(run([], gh), {
      mainNewest: "0098",
      next: "0099",
      own: [],
      claimed: [],
      skipped: [],
    });
  });

  it("skips every open PR's ADR, and leaves stale claims out of `claimed`", () => {
    const { gh, calls } = fakeGh({
      901: ["docs/adr/0099-x.md", "apps/web/a.ts"],
      902: ["docs/adr/0101-y.md"],
      // At or below main's newest: a PR main moved past, which no new number can take.
      903: ["docs/adr/0090-stale.md"],
      904: ["modified\tdocs/adr/0098-b.md"],
    });
    const r = run([], gh);
    assert.equal(r.next, "0102");
    assert.deepEqual(r.claimed, [
      { pr: 901, file: "0099-x.md" },
      { pr: 902, file: "0101-y.md" },
    ]);
    // The paginated files endpoint, as the migration sweep reads it.
    assert.ok(
      calls.includes(
        "api --paginate repos/JakubAnderwald/drafto/pulls/901/files --jq .[] | [.status, .filename] | @tsv",
      ),
    );
  });

  // A revision: its own PR's ADR is the floor, not a claim.
  it("with --own-pr, counts the PR's own ADR and leaves it out of `claimed`", () => {
    const { gh } = fakeGh({ 901: ["docs/adr/0099-x.md"], 981: ["docs/adr/0100-mine.md"] });
    const r = run(["--own-pr", "981"], gh);
    assert.equal(r.next, "0101");
    assert.deepEqual(r.own, ["0100-mine.md"]);
    assert.deepEqual(
      r.claimed.map((c) => c.pr),
      [901],
    );
  });

  it("skips a PR it can't read, but fails when that PR is the card's own", () => {
    const { gh } = fakeGh({ 901: ["docs/adr/0099-x.md"], 981: null });
    const plain = run([], gh);
    assert.equal(plain.next, "0100");
    assert.deepEqual(plain.skipped, [981]);
    assert.throws(() => run(["--own-pr", "981"], gh), /couldn't list PR #981's files/);
  });

  it("fails when the open PRs can't be listed, so the bundle falls back to null", () => {
    const gh = () => {
      throw new Error("gh pr list failed: HTTP 502");
    };
    assert.throws(() => run([], gh), /gh pr list failed/);
  });

  it("gives up once the total gh budget is spent, instead of reading every PR", () => {
    let clock = 0;
    const reads = [];
    const gh = (args) => {
      if (args[0] === "pr") return JSON.stringify([1, 2, 3, 4].map((number) => ({ number })));
      reads.push(args[2]);
      clock += 25_000;
      return "added\tdocs/adr/0099-x.md";
    };
    assert.throws(() => run([], gh, () => clock), /gave up listing the open PRs' files after 60s/);
    assert.equal(reads.length, 3);
  });

  it("fails when main can't be fetched", () => {
    const lost = mkdtempSync(join(tmpdir(), "adr-allocate-lost-"));
    try {
      gitIn(lost, ["init", "-q", "-b", "main"]);
      gitIn(lost, ["remote", "add", "origin", join(tmpdir(), "adr-allocate-no-such-origin")]);
      assert.throws(
        () => allocateMain(["next-adr", "--root", lost], { gh: fakeGh({}).gh }),
        /couldn't fetch main/,
      );
    } finally {
      rmSync(lost, { recursive: true, force: true });
    }
  });

  it("rejects a bad --own-pr and an unknown command from the CLI", () => {
    const bad = spawnSync("node", [CLI, "next-adr", "--root", root, "--own-pr", "x"], {
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.match(JSON.parse(bad.stderr).error, /--own-pr must be a PR number/);
    const unknown = spawnSync("node", [CLI, "next-version"], { encoding: "utf8" });
    assert.equal(unknown.status, 1);
    assert.match(JSON.parse(unknown.stderr).error, /Usage: adr-allocate\.mjs next-adr/);
  });
});
