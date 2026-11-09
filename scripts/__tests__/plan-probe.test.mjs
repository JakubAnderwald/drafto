import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACK_MARKER_PREFIX,
  HEADER_ALLOWLIST,
  MAX_CHECK_STEPS,
  PROBE_MARKER_FILE,
  REPORT_MARKER_PREFIX,
  ackMarker,
  addedLineFindings,
  availability,
  buildCommit,
  captureHeaders,
  collectSpike,
  commitMessage,
  composeReport,
  deleteRef,
  filterHeaders,
  headerCurlConfig,
  judgeSpike,
  keyedCount,
  lineDiff,
  listProbeRefs,
  main,
  planAcks,
  previewStateFrom,
  probeRef,
  pushRef,
  remoteRefSha,
  scanText,
  secretDirLiterals,
  spikePathProblem,
  validateChecks,
  validateHeaderPaths,
} from "../lib/plan-probe.mjs";
import { loadFactoryState, saveFactoryState, emptyFactoryState } from "../lib/factory-state.mjs";

const ORIGIN = "https://drafto-abc123-jakubanderwalds-projects.vercel.app";
const BYPASS = "Byp4ssSecretValue0123456789abcd";

// ── fixtures ────────────────────────────────────────────────────────────────

function git(cwd, args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      ...opts.env,
    },
    input: opts.input,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A repo with one commit on main and a bare origin it can push to. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "plan-probe-repo-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, ["init", "-q", "--bare", origin]);
  git(root, ["init", "-q", "-b", "main", work]);
  mkdirSync(join(work, "apps/web/src/app"), { recursive: true });
  writeFileSync(
    join(work, "apps/web/src/app/page.tsx"),
    "export default function P() {\n  return null;\n}\n",
  );
  writeFileSync(join(work, "apps/web/next.config.ts"), "export default {};\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "init"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-q", "origin", "main"]);
  const mainSha = git(work, ["rev-parse", "HEAD"]).stdout.trim();
  const runGit = (args, { input, env } = {}) => git(work, args, { input, env });
  return { root, origin, work, mainSha, runGit };
}

async function writeState(file, issues = {}, extra = {}) {
  const s = { ...emptyFactoryState(), ...extra };
  s.issues = issues;
  await saveFactoryState(s, file);
}

// ── pure helpers ────────────────────────────────────────────────────────────

describe("availability", () => {
  const base = { phase: "B", enabled: true, kindOn: true, platforms: ["web"], maxRounds: 2 };
  it("is available on a web card with rounds left", () => {
    assert.deepEqual(availability({ ...base, record: {} }), {
      available: true,
      reason: null,
      roundsUsed: 0,
      maxRounds: 2,
      round: 1,
    });
  });
  it("names the first thing in the way", () => {
    const why = (o) => availability({ ...base, record: {}, ...o }).reason;
    assert.equal(why({ phase: "A" }), "phase");
    assert.equal(why({ enabled: false }), "off");
    assert.equal(why({ kindOn: false }), "kind");
    assert.equal(why({ browserDisabled: true }), "browser-disabled");
    assert.equal(why({ platforms: ["mobile"] }), "not-web");
    assert.equal(why({ record: { planProbeStatus: "queued" } }), "pending");
    assert.equal(why({ record: { planProbeRound: "2", planProbeStatus: "folded" } }), "cap");
  });
  it("lets a fold replan request the next round", () => {
    const a = availability({
      ...base,
      record: { planProbeRound: "1", planProbeStatus: "reported" },
    });
    assert.equal(a.available, true);
    assert.equal(a.round, 2);
  });
});

describe("validateChecks", () => {
  it("accepts numbered steps", () => {
    const v = validateChecks(
      "1. Open /login. Expect the form.\n2) Read the console. Expect no CSP error.",
    );
    assert.equal(v.ok, true);
    assert.equal(v.steps, 2);
  });
  it("rejects empty, stepless, too many and too long", () => {
    assert.equal(validateChecks("  ").reason, "checks-empty");
    assert.equal(validateChecks("just prose").reason, "checks-no-steps");
    const many = Array.from({ length: MAX_CHECK_STEPS + 1 }, (_, i) => `${i + 1}. step`).join("\n");
    assert.equal(validateChecks(many).reason, "checks-too-many-steps");
    assert.equal(validateChecks(`1. ${"x".repeat(9000)}`).reason, "checks-too-long");
  });
});

describe("validateHeaderPaths", () => {
  it("keeps up to five same-origin paths, deduplicated", () => {
    assert.deepEqual(validateHeaderPaths("/login\n# a comment\n/\n/login\n").paths, [
      "/login",
      "/",
    ]);
  });
  it("refuses anything that could leave the origin or the path", () => {
    for (const bad of ["//evil.com/x", "https://x", "/a/../b", "/a\\b", "/u@h", "login", "/a b"]) {
      assert.equal(validateHeaderPaths(bad).ok, false, bad);
    }
    assert.equal(validateHeaderPaths("/1\n/2\n/3\n/4\n/5\n/6").reason, "headers-too-many-paths");
  });
});

describe("spikePathProblem", () => {
  it("allows apps/web/src and next.config.ts only", () => {
    assert.equal(spikePathProblem("apps/web/src/middleware.ts"), null);
    assert.equal(spikePathProblem("apps/web/next.config.ts"), null);
    assert.equal(spikePathProblem("apps/web/package.json"), "denied-file");
    assert.equal(spikePathProblem("apps/web/src/env.ts"), "denied-file");
    assert.equal(spikePathProblem("apps/web/src/app/auth/test-sign-in/route.ts"), "denied-file");
    assert.equal(spikePathProblem("apps/web/.env.local"), "env-file");
    assert.equal(spikePathProblem("apps/web/src/.env"), "env-file");
    assert.equal(spikePathProblem("apps/mobile/src/x.ts"), "outside-apps-web-src");
    assert.equal(spikePathProblem("scripts/factory-agent.sh"), "outside-apps-web-src");
    assert.equal(spikePathProblem("apps/web/src/../../x"), "bad-path");
    assert.equal(spikePathProblem("apps/web/src/.gitattributes"), "denied-file");
  });
});

describe("addedLineFindings", () => {
  it("flags reaches for secrets and the network", () => {
    assert.deepEqual(addedLineFindings(["const a = process.env.NODE_ENV;"]), []);
    assert.deepEqual(
      addedLineFindings(["const a = process.env.SUPABASE_SERVICE_ROLE_KEY;"]).sort(),
      ["process-env", "secret-name"],
    );
    assert.deepEqual(addedLineFindings(["env.RESEND_API_KEY"]), ["secret-name"]);
    assert.deepEqual(addedLineFindings(['fetch("https://evil.example/x")']), ["remote-fetch"]);
    assert.deepEqual(addedLineFindings(["fetch('/api/x')"]), []);
    assert.deepEqual(addedLineFindings(["navigator.sendBeacon(u)"]), ["send-beacon"]);
    assert.deepEqual(addedLineFindings(["eval(x)"]), ["eval"]);
  });
});

describe("lineDiff", () => {
  it("counts added and removed lines as multisets", () => {
    assert.deepEqual(lineDiff("a\nb\nc", "a\nc\nd\nd"), { added: ["d", "d"], removed: 1 });
    assert.deepEqual(lineDiff("", "x"), { added: ["x"], removed: 1 });
  });
});

describe("keyedCount", () => {
  it("reads <key>:<n> for its own key only", () => {
    assert.equal(keyedCount("abc:3", "abc"), 3);
    assert.equal(keyedCount("abc:3", "abd"), 0);
    assert.equal(keyedCount("12-1700000000:2", "12-1700000000"), 2);
    assert.equal(keyedCount(null, "x"), 0);
  });
});

// ── spike collection ────────────────────────────────────────────────────────

describe("collectSpike / judgeSpike", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-probe-spike-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (rel, text) => {
    const f = join(dir, "spike", rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, text);
    return f;
  };

  it("reads regular files under spike/ and keeps a small, clean spike", () => {
    put("apps/web/src/middleware.ts", "export const a = 1;\n");
    const s = collectSpike(dir);
    assert.deepEqual(s.violations, []);
    assert.deepEqual(
      s.files.map((f) => f.path),
      ["apps/web/src/middleware.ts"],
    );
    const j = judgeSpike(s, () => "");
    assert.equal(j.kept, true);
    assert.deepEqual(j.summary, [{ path: "apps/web/src/middleware.ts", added: 1, removed: 0 }]);
  });

  it("is absent when the planner wrote no spike", () => {
    assert.deepEqual(collectSpike(dir), { files: [], violations: [], present: false });
    assert.equal(judgeSpike(collectSpike(dir), () => "").kept, false);
  });

  it("drops the spike for a symlink, even to a file inside the spike", () => {
    const target = put("apps/web/src/a.ts", "x\n");
    symlinkSync(target, join(dir, "spike/apps/web/src/b.ts"));
    const s = collectSpike(dir);
    assert.match(s.violations[0], /^symlink:apps\/web\/src\/b\.ts$/);
    assert.deepEqual(judgeSpike(s, () => "").reason, "symlink");
  });

  it("drops the spike for a hardlink (it could share a secret's inode)", () => {
    const secret = join(dir, "secret.env");
    writeFileSync(secret, "KEY=value\n");
    mkdirSync(join(dir, "spike/apps/web/src"), { recursive: true });
    linkSync(secret, join(dir, "spike/apps/web/src/c.ts"));
    assert.equal(judgeSpike(collectSpike(dir), () => "").reason, "hardlink");
  });

  it("drops the spike for a denied path, a binary file, or too many lines", () => {
    put("apps/web/package.json", "{}");
    assert.equal(judgeSpike(collectSpike(dir), () => "").reason, "denied-file");
    rmSync(join(dir, "spike"), { recursive: true });
    put("apps/web/src/x.bin", "a\u0000b");
    assert.equal(judgeSpike(collectSpike(dir), () => "").reason, "binary");
    rmSync(join(dir, "spike"), { recursive: true });
    put("apps/web/src/big.ts", Array.from({ length: 450 }, (_, i) => `l${i}`).join("\n"));
    assert.equal(judgeSpike(collectSpike(dir), () => "").reason, "too-many-lines");
  });

  it("drops the spike when an added line reaches for a secret", () => {
    put("apps/web/src/m.ts", "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;\n");
    assert.equal(judgeSpike(collectSpike(dir), () => "").reason, "added-process-env");
  });

  it("judges only the lines the spike adds against main", () => {
    put("apps/web/src/m.ts", "const k = process.env.OLD;\nconst x = 1;\n");
    // The process.env line is already on main: not added by the spike.
    const j = judgeSpike(collectSpike(dir), () => "const k = process.env.OLD;\n");
    assert.equal(j.kept, true);
  });
});

// ── secrets ─────────────────────────────────────────────────────────────────

describe("secret scanning", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-probe-secrets-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the test account's email, allowlists and plain URLs out (they aren't secret)", () => {
    writeFileSync(
      join(dir, "browser-account.env"),
      "FACTORY_BROWSER_EMAIL=factory-browser-test@drafto-dev.example\nFACTORY_BROWSER_PASSWORD=pw-0123456789abcdef\n",
    );
    writeFileSync(
      join(dir, "support-env.sh"),
      "export SUPPORT_ALLOWLIST=jakub@example.com,partner@example.com\n",
    );
    writeFileSync(join(dir, "hook.env"), "HOOK=https://hooks.example.com/x?token=abcdef0123\n");
    writeFileSync(
      join(dir, "app.txt"),
      "Some heading line here\nemail: review@example.com\npassword: Review-Pass-12345\n",
    );
    const values = secretDirLiterals(dir).literals.map((l) => l.value);
    assert.ok(values.includes("pw-0123456789abcdef"));
    assert.ok(values.includes("Review-Pass-12345"), "a name: value password line");
    assert.ok(
      values.includes("https://hooks.example.com/x?token=abcdef0123"),
      "a URL with a credential",
    );
    for (const v of values) assert.ok(!v.includes("@"), `no email: ${v}`);
    assert.deepEqual(
      scanText("Ran as factory-browser-test@drafto-dev.example on the preview", {
        literals: secretDirLiterals(dir).literals,
      }),
      [],
    );
  });

  it("reports what it couldn't read, so callers fail closed", () => {
    assert.deepEqual(secretDirLiterals(join(dir, "nope")).problems, ["secrets-dir"]);
    assert.deepEqual(secretDirLiterals(dir).problems, []);
    // A subdirectory or a dangling link is a gap in the scan.
    mkdirSync(join(dir, "sub"));
    symlinkSync(join(dir, "gone.env"), join(dir, "dangling.env"));
    assert.deepEqual(secretDirLiterals(dir).problems.sort(), [
      "secrets-dir:dangling.env",
      "secrets-dir:sub",
    ]);
  });

  it("follows a symlinked secret file and scans what it points at", () => {
    const real = mkdtempSync(join(tmpdir(), "plan-probe-real-"));
    try {
      writeFileSync(join(real, "linked.env"), "API_TOKEN=linkedsecretvalue0123456789\n");
      symlinkSync(join(real, "linked.env"), join(dir, "linked.env"));
      const r = secretDirLiterals(dir);
      assert.deepEqual(r.problems, []);
      assert.ok(r.literals.some((l) => l.value === "linkedsecretvalue0123456789"));
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("collects env values and long tokens, but not URLs or paths", () => {
    writeFileSync(
      join(dir, "a.env"),
      "TOKEN=abcdefghijklmnopqrstuvwx\nURL=https://huhzactreblzcogqkbsd.supabase.co\nSHORT=abc\n",
    );
    writeFileSync(join(dir, "key.txt"), "here is QWERTYUIOPASDFGHJKLZXCVBNM123456 end\n");
    writeFileSync(join(dir, "paths.env"), "KEYSTORE_PATH=/Users/me/drafto-secrets/x.keystore\n");
    const { literals } = secretDirLiterals(dir);
    const values = literals.map((l) => l.value).sort();
    assert.deepEqual(values, ["QWERTYUIOPASDFGHJKLZXCVBNM123456", "abcdefghijklmnopqrstuvwx"]);
    assert.ok(literals.every((l) => l.name.startsWith("secrets-dir:")));
  });

  it("names hits without the value", () => {
    writeFileSync(join(dir, "a.env"), "TOKEN=abcdefghijklmnopqrstuvwx\n");
    const secrets = { literals: secretDirLiterals(dir).literals, bypass: BYPASS };
    assert.deepEqual(scanText("nothing here", secrets), []);
    assert.deepEqual(scanText("x abcdefghijklmnopqrstuvwx y", secrets), ["secrets-dir:a.env"]);
    assert.deepEqual(scanText(`h: ${BYPASS}`, secrets), ["bypass-secret"]);
    assert.ok(scanText("ghp_abcdefghijklmnopqrstuvwxyz0123", {}).includes("github-token"));
    assert.ok(scanText("-----BEGIN RSA PRIVATE KEY-----", {}).includes("private-key"));
    for (const hit of scanText(`${BYPASS} abcdefghijklmnopqrstuvwx`, secrets)) {
      assert.ok(!hit.includes(BYPASS) && !hit.includes("abcdefghijklmnopqrstuvwx"));
    }
  });
});

// ── git ─────────────────────────────────────────────────────────────────────

describe("buildCommit / refs (real git)", () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => rmSync(repo.root, { recursive: true, force: true }));

  it("builds main's tree plus the spike and the marker file, with a fixed message", () => {
    const sha = buildCommit({
      git: repo.runGit,
      mainSha: repo.mainSha,
      issue: "492",
      probeId: "492-1762600000",
      files: [{ path: "apps/web/src/middleware.ts", content: "export const csp = 1;\n" }],
    });
    assert.match(sha, /^[0-9a-f]{40}$/);
    const show = (p) => git(repo.work, ["cat-file", "blob", `${sha}:${p}`]).stdout;
    assert.equal(show(PROBE_MARKER_FILE), "492-1762600000\n");
    assert.equal(show("apps/web/src/middleware.ts"), "export const csp = 1;\n");
    assert.equal(show("apps/web/next.config.ts"), "export default {};\n");
    assert.equal(
      git(repo.work, ["log", "-1", "--format=%B", sha]).stdout.trim(),
      commitMessage("492"),
    );
    assert.equal(git(repo.work, ["rev-parse", `${sha}^`]).stdout.trim(), repo.mainSha);
    // Nothing checked out or staged in the working copy.
    assert.equal(git(repo.work, ["status", "--porcelain"]).stdout, "");
  });

  it("gives an empty spike a commit of its own (the marker file)", () => {
    const a = buildCommit({
      git: repo.runGit,
      mainSha: repo.mainSha,
      issue: "1",
      probeId: "1-1762600000",
    });
    const b = buildCommit({
      git: repo.runGit,
      mainSha: repo.mainSha,
      issue: "1",
      probeId: "1-1762600001",
    });
    assert.notEqual(a, b);
    assert.notEqual(a, repo.mainSha);
  });

  it("writes content as is, with no .gitattributes filter", () => {
    writeFileSync(join(repo.work, ".gitattributes"), "*.ts filter=evil\n");
    git(repo.work, ["config", "filter.evil.clean", "echo FILTERED"]);
    const sha = buildCommit({
      git: repo.runGit,
      mainSha: repo.mainSha,
      issue: "1",
      probeId: "1-1762600000",
      files: [{ path: "apps/web/src/a.ts", content: "raw\n" }],
    });
    assert.equal(git(repo.work, ["cat-file", "blob", `${sha}:apps/web/src/a.ts`]).stdout, "raw\n");
  });

  it("pushes and deletes the probe branch only under its lease", () => {
    const ref = probeRef("7");
    const a = buildCommit({
      git: repo.runGit,
      mainSha: repo.mainSha,
      issue: "7",
      probeId: "7-1762600000",
    });
    const b = buildCommit({
      git: repo.runGit,
      mainSha: repo.mainSha,
      issue: "7",
      probeId: "7-1762600001",
    });
    assert.equal(remoteRefSha(repo.runGit, ref), "");
    assert.equal(pushRef(repo.runGit, ref, a, ""), true);
    assert.equal(remoteRefSha(repo.runGit, ref), a);
    // A stale expectation loses.
    assert.equal(pushRef(repo.runGit, ref, b, ""), false);
    assert.equal(deleteRef(repo.runGit, ref, b), false);
    assert.equal(remoteRefSha(repo.runGit, ref), a);
    assert.deepEqual(listProbeRefs(repo.runGit), [{ ref, sha: a, issue: "7" }]);
    assert.equal(deleteRef(repo.runGit, ref, a), true);
    assert.equal(remoteRefSha(repo.runGit, ref), "");
  });
});

// ── preview ─────────────────────────────────────────────────────────────────

describe("previewStateFrom", () => {
  const dep = (id, created_at, login = "vercel[bot]") => ({ id, created_at, creator: { login } });
  const st = (state, url = ORIGIN) => ({ state, environment_url: url });
  it("is pending with no Vercel deployment yet", () => {
    assert.deepEqual(previewStateFrom([], {}), { state: "pending" });
    assert.deepEqual(previewStateFrom([dep(1, "t", "someone")], {}), { state: "pending" });
  });
  it("is ready only on a success with a preview URL", () => {
    assert.deepEqual(previewStateFrom([dep(1, "2026")], { 1: [st("success")] }), {
      state: "ready",
      url: ORIGIN,
    });
    assert.deepEqual(
      previewStateFrom([dep(1, "2026")], { 1: [st("success", "https://evil.example")] }),
      {
        state: "building",
      },
    );
  });
  it("is failed on a failure, though Vercel still sends the URL", () => {
    assert.deepEqual(previewStateFrom([dep(1, "2026")], { 1: [st("failure"), st("pending")] }), {
      state: "failed",
      reason: "build",
    });
    assert.deepEqual(previewStateFrom([dep(1, "2026")], { 1: [st("error")] }).state, "failed");
  });
  it("is building while pending or in progress, and a later success wins", () => {
    assert.equal(previewStateFrom([dep(1, "2026")], { 1: [st("in_progress")] }).state, "building");
    assert.equal(
      previewStateFrom([dep(2, "2026-02"), dep(1, "2026-01")], {
        1: [st("failure")],
        2: [st("success")],
      }).state,
      "ready",
    );
  });
});

// ── headers ─────────────────────────────────────────────────────────────────

describe("filterHeaders", () => {
  it("keeps the allowlist and the status, and never a cookie or Vercel header", () => {
    const raw = [
      "HTTP/2 200",
      "content-security-policy: default-src 'self'",
      "Set-Cookie: sb-access-token=eyJhbGciOi",
      "x-vercel-id: fra1::abc",
      "Referrer-Policy: strict-origin-when-cross-origin",
      "",
    ].join("\r\n");
    assert.deepEqual(filterHeaders(raw, ORIGIN), {
      status: 200,
      headers: [
        { name: "content-security-policy", value: "default-src 'self'" },
        { name: "referrer-policy", value: "strict-origin-when-cross-origin" },
      ],
      location: null,
    });
  });
  it("reports a redirect as a same-origin path or off-origin", () => {
    assert.equal(
      filterHeaders(`HTTP/2 307\nlocation: ${ORIGIN}/welcome?x=1\n`, ORIGIN).location,
      "/welcome?x=1",
    );
    assert.equal(filterHeaders("HTTP/2 307\nlocation: /login\n", ORIGIN).location, "/login");
    assert.equal(
      filterHeaders("HTTP/2 302\nlocation: https://vercel.com/sso?t=abc\n", ORIGIN).location,
      "off-origin",
    );
  });
  it("covers every allowlisted name", () => {
    const raw = ["HTTP/1.1 200 OK", ...HEADER_ALLOWLIST.map((h) => `${h}: v`)].join("\n");
    assert.equal(filterHeaders(raw, ORIGIN).headers.length, HEADER_ALLOWLIST.length);
  });
});

describe("captureHeaders", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-probe-hdr-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes the bypass secret on stdin only, follows nothing, and filters the answer", () => {
    const file = join(dir, "bypass.env");
    writeFileSync(file, `VERCEL_AUTOMATION_BYPASS_SECRET=${BYPASS}\n`, { mode: 0o600 });
    const calls = [];
    const curl = (args, input) => {
      calls.push({ args, input });
      return { code: 0, stdout: "HTTP/2 200\nx-frame-options: DENY\nset-cookie: a=b\n" };
    };
    const out = captureHeaders({ origin: ORIGIN, paths: ["/login"], bypassFile: file }, { curl });
    assert.deepEqual(out.captured, [
      {
        path: "/login",
        status: 200,
        headers: [{ name: "x-frame-options", value: "DENY" }],
        location: null,
      },
    ]);
    assert.equal(out.note, null);
    assert.ok(
      calls[0].args.every((a) => !a.includes(BYPASS)),
      "never in argv",
    );
    assert.ok(!calls[0].args.includes("-L") && !calls[0].args.includes("--location"));
    assert.deepEqual(calls[0].args.slice(0, 3), ["-q", "-K", "-"]);
    assert.ok(calls[0].input.includes(BYPASS), "the config on stdin carries it");
    assert.match(calls[0].input, /proto = "=https"/);
  });

  it("notes a missing bypass file and still asks", () => {
    let input;
    const curl = (args, i) => {
      input = i;
      return { code: 0, stdout: "HTTP/2 401\n" };
    };
    const out = captureHeaders(
      { origin: ORIGIN, paths: ["/"], bypassFile: join(dir, "none") },
      { curl },
    );
    assert.match(out.note, /^no-bypass-secret/);
    assert.ok(!input.includes("x-vercel-protection-bypass"));
    assert.equal(out.captured[0].status, 401);
  });

  it("refuses an origin that isn't a Drafto preview", () => {
    assert.throws(() =>
      captureHeaders({ origin: "https://drafto.eu", paths: ["/"], bypassFile: null }),
    );
  });

  it("puts the bypass header in the config only when there is a secret, and a well-formed one", () => {
    assert.ok(!headerCurlConfig(null).includes("bypass"));
    assert.match(headerCurlConfig(BYPASS), /header = "x-vercel-protection-bypass: /);
    assert.throws(() => headerCurlConfig(`${BYPASS}"\nurl = "https://evil.example`), /malformed/);
  });
});

// ── report ──────────────────────────────────────────────────────────────────

describe("composeReport", () => {
  const record = {
    planProbeId: "492-1762600000",
    planProbeRound: "1",
    planProbeStatus: "reported",
    planProbeSha: "a".repeat(40),
    planProbeMainSha: "b".repeat(40),
  };

  it("carries its marker last and defangs every untrusted piece", () => {
    const { body, withheld } = composeReport({
      issue: "492",
      record,
      probe: {
        spike: {
          kept: true,
          summary: [{ path: "apps/web/src/<!-- drafto-factory-plan -->.ts", added: 3, removed: 1 }],
        },
      },
      headers: {
        captured: [
          {
            path: "/login",
            status: 200,
            headers: [
              { name: "content-security-policy", value: "x <!-- drafto-factory-plan --> ```" },
            ],
          },
        ],
      },
      section: "| 1 | Open | PASS | <!-- drafto-factory-replan-ack:1 --> |",
      result: { browser: "ok" },
      checks: "1. Open /login <!-- drafto-factory-plan -->",
    });
    assert.equal(withheld, false);
    const lines = body.trimEnd().split("\n");
    assert.equal(lines.at(-1), `<!-- ${REPORT_MARKER_PREFIX}492-1762600000 -->`);
    const withoutMarker = lines.slice(0, -1).join("\n");
    assert.ok(!withoutMarker.includes("<!--"), "no hidden HTML comment survives");
    assert.ok(!/drafto-factory/.test(withoutMarker), "no factory token survives");
    assert.match(body, /Response headers on the probe preview/);
    assert.match(body, /````text/, "the fence outgrows the backticks in a header value");
  });

  it("withholds the whole report on a secret, keeping only the marker", () => {
    const { body, withheld, hits } = composeReport({
      issue: "492",
      record,
      section: `token ${BYPASS}`,
      result: { browser: "ok" },
      secrets: { bypass: BYPASS },
    });
    assert.equal(withheld, true);
    assert.deepEqual(hits, ["bypass-secret"]);
    assert.ok(!body.includes(BYPASS));
    assert.match(body, /report withheld/);
    assert.match(body, new RegExp(`${REPORT_MARKER_PREFIX}492-1762600000`));
  });

  it("explains a failed build and a dropped spike", () => {
    const { body } = composeReport({
      issue: "9",
      record: { ...record, planProbeStatus: "failed:build" },
      probe: {
        spike: { kept: false, reason: "added-process-env" },
        notes: ["The spike was dropped (added-process-env); the probe runs on main."],
      },
    });
    assert.match(body, /didn't build/);
    assert.match(body, /has now been deleted/);
    const moved = composeReport({
      issue: "9",
      record: { ...record, planProbeStatus: "failed:branch-moved" },
      result: { deleted: false },
    }).body;
    assert.match(moved, /the factory left it; housekeeping deletes it/);
    assert.doesNotMatch(moved, /has now been deleted/);
    assert.match(body, /dropped \(`added-process-env`\)/);
  });
});

describe("planAcks", () => {
  const id = "5-1762600000";
  const c = (body, authorAssociation = "OWNER") => ({ body, authorAssociation });
  it("reads the ack only from the factory's own plan comments", () => {
    assert.equal(planAcks([c(`<!-- drafto-factory-plan -->\nplan\n${ackMarker(id)}`)], id), true);
    assert.equal(
      planAcks([c(`<!-- drafto-factory-plan -->\n${ackMarker(id)}`, "NONE")], id),
      false,
    );
    assert.equal(planAcks([c(`a reply quoting ${ackMarker(id)}`)], id), false);
    assert.equal(
      planAcks([c(`<!-- drafto-factory-plan -->\n${ackMarker("5-1762600001")}`)], id),
      false,
    );
  });
  it("uses its own prefix", () => {
    assert.equal(ackMarker(id), `<!-- ${ACK_MARKER_PREFIX}${id} -->`);
  });
});

// ── commands (state + files + real git) ─────────────────────────────────────

describe("CLI lifecycle", () => {
  let repo;
  let root;
  let stateFile;
  let secretsDir;
  beforeEach(() => {
    repo = makeRepo();
    root = join(repo.root, "probes");
    stateFile = join(repo.root, "state.json");
    secretsDir = join(repo.root, "secrets");
    mkdirSync(secretsDir);
    writeFileSync(join(secretsDir, "k.env"), "API=zyxwvutsrqponmlkjihgfedcba\n");
    writeFileSync(
      join(secretsDir, "browser-account.env"),
      "FACTORY_BROWSER_EMAIL=factory-test@example.com\nFACTORY_BROWSER_PASSWORD=Test-Pass-0123456789\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(secretsDir, "dev-supabase-admin.env"),
      "DEV_SUPABASE_URL=https://huhzactreblzcogqkbsd.supabase.co\nDEV_SUPABASE_SERVICE_ROLE_KEY=svc-role-key-0123456789abcdef\n",
      { mode: 0o600 },
    );
  });
  afterEach(() => rmSync(repo.root, { recursive: true, force: true }));

  const deps = () => ({ git: repo.runGit });
  const run = (cmd, flags) =>
    main(
      [
        cmd,
        "--state-file",
        stateFile,
        ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, String(v)]),
      ],
      deps(),
    );
  const finalizeFlags = (extra = {}) => ({
    issue: 492,
    root,
    "repo-root": repo.work,
    action: "planned",
    "main-sha": repo.mainSha,
    "max-rounds": 2,
    spike: 1,
    "secrets-dir": secretsDir,
    "account-file": join(secretsDir, "browser-account.env"),
    "signin-key-file": join(secretsDir, "dev-supabase-admin.env"),
    "bypass-file": join(secretsDir, "none.env"),
    ...extra,
  });

  it("stages, finalizes a probe with a spike, pushes it and records it", async () => {
    await writeState(stateFile);
    const staged = await run("stage", { issue: 492, root, now: "2026-11-09T10:00:00Z" });
    const id = `492-${Date.parse("2026-11-09T10:00:00Z") / 1000}`;
    assert.equal(staged.probeId, id);
    writeFileSync(join(staged.dir, "checks.md"), "1. Open /login. Expect the form.\n");
    writeFileSync(join(staged.dir, "headers.txt"), "/login\n");
    mkdirSync(join(staged.dir, "spike/apps/web/src"), { recursive: true });
    writeFileSync(
      join(staged.dir, "spike/apps/web/src/middleware.ts"),
      "export const csp = 'x';\n",
    );

    const out = await run("finalize", finalizeFlags({ now: "2026-11-09T10:01:00Z" }));
    assert.equal(out.result, "queued");
    assert.equal(out.spike, true);
    const rec = (await loadFactoryState(stateFile)).issues["492"];
    assert.equal(rec.planProbeStaging, null);
    assert.equal(rec.planProbeStatus, "queued");
    assert.equal(rec.planProbeRound, "1");
    assert.equal(rec.planProbeSha, out.sha);
    assert.equal(remoteRefSha(repo.runGit, probeRef("492")), out.sha);
    assert.deepEqual(JSON.parse(readFileSync(join(staged.dir, "probe.json"), "utf8")).headerPaths, [
      "/login",
    ]);

    const cands = await run("candidates", {});
    assert.deepEqual(
      cands.map((c) => c.issue),
      ["492"],
    );

    // The browser ran: end it, which deletes the branch under its lease.
    const ended = await run("end", {
      issue: 492,
      root,
      "repo-root": repo.work,
      status: "reported",
      browser: "ok",
      verdict: "pass",
    });
    assert.deepEqual(ended, { status: "reported", deleted: true, post: true });
    assert.equal(remoteRefSha(repo.runGit, probeRef("492")), "");

    const outFile = join(repo.root, "comment.md");
    const secretFlags = {
      "secrets-dir": secretsDir,
      "account-file": join(secretsDir, "browser-account.env"),
      "signin-key-file": join(secretsDir, "dev-supabase-admin.env"),
      "bypass-file": join(secretsDir, "none.env"),
    };
    const composed = await run("compose", { issue: 492, root, out: outFile, ...secretFlags });
    assert.equal(composed.withheld, false, JSON.stringify(composed));
    assert.match(readFileSync(outFile, "utf8"), /has now been deleted/);
    // Without the files the scan needs, compose posts only a withheld notice.
    const blind = await run("compose", { issue: 492, root, out: outFile });
    assert.equal(blind.withheld, true);
    assert.match(readFileSync(outFile, "utf8"), /the secret scan couldn't read account-file/);
    assert.ok(readFileSync(outFile, "utf8").endsWith(`${id} -->\n`));

    // Fold: due until an OWNER plan comment carries the ack.
    const comments = join(repo.root, "comments.json");
    writeFileSync(
      comments,
      JSON.stringify([{ authorAssociation: "OWNER", body: "<!-- drafto-factory-plan -->\nplan" }]),
    );
    const due = await run("fold-due", {
      issue: 492,
      root,
      "comments-file": comments,
      "max-folds": 2,
    });
    assert.equal(due.due, true);
    assert.equal(due.results.ackMarker, ackMarker(id));
    assert.match(due.results.report, /Plan browser probe/);
    assert.ok(
      !due.results.report.includes(REPORT_MARKER_PREFIX),
      "the planner's copy has no marker",
    );
    await run("fold-begin", { issue: 492 });
    writeFileSync(
      comments,
      JSON.stringify([
        {
          authorAssociation: "OWNER",
          body: `<!-- drafto-factory-plan -->\nplan\n${ackMarker(id)}`,
        },
      ]),
    );
    const folded = await run("fold-end", {
      issue: 492,
      "probe-id": id,
      "comments-file": comments,
      "max-folds": 2,
    });
    assert.deepEqual(folded, { folded: true, why: "acked" });
    assert.equal((await loadFactoryState(stateFile)).issues["492"].planProbeStatus, "folded");
  });

  it("discards the staging when the planner wrote no checks or the run failed", async () => {
    await writeState(stateFile);
    let staged = await run("stage", { issue: 1, root });
    assert.deepEqual(await run("finalize", finalizeFlags({ issue: 1 })), {
      result: "none",
      probeId: staged.probeId,
    });
    assert.equal(existsSync(staged.dir), false);
    staged = await run("stage", { issue: 1, root, now: "2026-11-09T11:00:00Z" });
    writeFileSync(join(staged.dir, "checks.md"), "1. x\n");
    const out = await run("finalize", finalizeFlags({ issue: 1, action: "blocked" }));
    assert.equal(out.result, "discarded");
    assert.equal((await loadFactoryState(stateFile)).issues["1"].planProbeRound ?? null, null);
  });

  it("rejects, pushing nothing, when a planner file carries a secret", async () => {
    await writeState(stateFile);
    const staged = await run("stage", { issue: 3, root });
    writeFileSync(join(staged.dir, "checks.md"), "1. Open / and type zyxwvutsrqponmlkjihgfedcba\n");
    const out = await run("finalize", finalizeFlags({ issue: 3 }));
    assert.deepEqual(out, {
      result: "rejected",
      reason: "secret",
      probeId: staged.probeId,
      post: true,
    });
    assert.equal(remoteRefSha(repo.runGit, probeRef("3")), "");
    assert.equal(
      (await loadFactoryState(stateFile)).issues["3"].planProbeStatus,
      "rejected:secret",
    );
  });

  it("never reads, pushes or names a refused spike file", async () => {
    await writeState(stateFile);
    const staged = await run("stage", { issue: 4, root });
    writeFileSync(join(staged.dir, "checks.md"), "1. x\n");
    mkdirSync(join(staged.dir, "spike/scripts"), { recursive: true });
    writeFileSync(join(staged.dir, "spike/scripts/x.sh"), "zyxwvutsrqponmlkjihgfedcba\n");
    const out = await run("finalize", finalizeFlags({ issue: 4 }));
    assert.equal(out.result, "queued");
    assert.equal(out.spike, false);
    const probe = JSON.parse(readFileSync(join(staged.dir, "probe.json"), "utf8"));
    assert.equal(probe.spike.reason, "outside-apps-web-src");
    assert.ok(!JSON.stringify(probe).includes("x.sh"), "the refused path isn't recorded");
    assert.equal(git(repo.work, ["cat-file", "-e", `${out.sha}:scripts/x.sh`]).code, 128);
  });

  it("scans a kept spike's files for secrets", async () => {
    await writeState(stateFile);
    const staged = await run("stage", { issue: 10, root });
    writeFileSync(join(staged.dir, "checks.md"), "1. x\n");
    mkdirSync(join(staged.dir, "spike/apps/web/src"), { recursive: true });
    writeFileSync(join(staged.dir, "spike/apps/web/src/a.ts"), "// zyxwvutsrqponmlkjihgfedcba\n");
    const out = await run("finalize", finalizeFlags({ issue: 10 }));
    assert.equal(out.reason, "secret");
    assert.equal(remoteRefSha(repo.runGit, probeRef("10")), "");
  });

  it("drops a spike when spikes are off, and still probes main", async () => {
    await writeState(stateFile);
    const staged = await run("stage", { issue: 5, root });
    writeFileSync(join(staged.dir, "checks.md"), "1. x\n");
    mkdirSync(join(staged.dir, "spike/apps/web/src"), { recursive: true });
    writeFileSync(join(staged.dir, "spike/apps/web/src/a.ts"), "x\n");
    const out = await run("finalize", finalizeFlags({ issue: 5, spike: 0 }));
    assert.equal(out.result, "queued");
    assert.equal(out.spike, false);
    const probe = JSON.parse(readFileSync(join(staged.dir, "probe.json"), "utf8"));
    assert.equal(probe.spike.reason, "spike-off");
    assert.equal(git(repo.work, ["cat-file", "-e", `${out.sha}:apps/web/src/a.ts`]).code, 128);
  });

  it("rejects, pushing nothing, when the scan can't read the factory's secrets", async () => {
    await writeState(stateFile);
    const staged = await run("stage", { issue: 18, root });
    writeFileSync(join(staged.dir, "checks.md"), "1. x\n");
    const out = await run(
      "finalize",
      finalizeFlags({ issue: 18, "account-file": join(secretsDir, "missing.env") }),
    );
    assert.equal(out.reason, "secret-scan");
    assert.equal(remoteRefSha(repo.runGit, probeRef("18")), "");
    // A bypass file that exists but can't be read is a problem too.
    writeFileSync(join(secretsDir, "bypass.env"), "NOT_THE_KEY=x\n");
    const staged2 = await run("stage", { issue: 19, root });
    writeFileSync(join(staged2.dir, "checks.md"), "1. x\n");
    const out2 = await run(
      "finalize",
      finalizeFlags({ issue: 19, "bypass-file": join(secretsDir, "bypass.env") }),
    );
    assert.equal(out2.reason, "secret-scan");
  });

  it("rejects a round past the cap", async () => {
    await writeState(stateFile, { 6: { planProbeRound: "2", planProbeStatus: "folded" } });
    const staged = await run("stage", { issue: 6, root });
    writeFileSync(join(staged.dir, "checks.md"), "1. x\n");
    assert.equal((await run("finalize", finalizeFlags({ issue: 6 }))).reason, "cap");
  });

  it("counts browser attempts per probe commit", async () => {
    await writeState(stateFile, { 8: { planProbeSha: "c".repeat(40) } });
    assert.deepEqual(await run("attempt", { issue: 8, op: "bump" }), { attempts: 1 });
    assert.deepEqual(await run("attempt", { issue: 8, op: "bump" }), { attempts: 2 });
    assert.deepEqual(await run("attempt", { issue: 8, op: "refund" }), { attempts: 1 });
  });

  it("gives up folding after the cap, so a missing ack can't replan forever", async () => {
    await writeState(stateFile, {
      9: {
        planProbeId: "9-1762600000",
        planProbeStatus: "reported",
        planProbeFoldAttempts: "9-1762600000:2",
      },
    });
    const comments = join(repo.root, "c.json");
    writeFileSync(comments, "[]");
    assert.deepEqual(
      await run("fold-due", { issue: 9, root, "comments-file": comments, "max-folds": 2 }),
      {
        due: false,
        reason: "cap",
      },
    );
    assert.deepEqual(
      await run("fold-end", {
        issue: 9,
        "probe-id": "9-1762600000",
        "comments-file": comments,
        "max-folds": 2,
      }),
      {
        folded: true,
        why: "gave-up",
      },
    );
  });

  describe("housekeeping", () => {
    it("cancels a queued probe whose card left Plan Review and deletes its branch", async () => {
      const sha = buildCommit({
        git: repo.runGit,
        mainSha: repo.mainSha,
        issue: "11",
        probeId: "11-1762600000",
      });
      pushRef(repo.runGit, probeRef("11"), sha, "");
      await writeState(stateFile, {
        11: {
          planProbeId: "11-1762600000",
          planProbeStatus: "queued",
          planProbeSha: sha,
          planProbeQueuedAt: "2026-11-09T10:00:00Z",
        },
      });
      const out = await run("housekeeping", {
        root,
        "repo-root": repo.work,
        "plan-review": "",
        planning: "",
        enabled: 1,
        now: "2026-11-09T10:10:00Z",
      });
      assert.deepEqual(out.actions, [
        { issue: "11", action: "cancelled:left-plan-review", post: false },
      ]);
      assert.equal(remoteRefSha(repo.runGit, probeRef("11")), "");
    });

    it("leaves a card in Planning alone (the rescue sweep owns it)", async () => {
      await writeState(stateFile, {
        12: {
          planProbeId: "12-1762600000",
          planProbeStatus: "queued",
          planProbeSha: "d".repeat(40),
          planProbeQueuedAt: "2026-11-09T10:00:00Z",
        },
      });
      const out = await run("housekeeping", {
        root,
        "repo-root": repo.work,
        "plan-review": "",
        planning: "12",
        enabled: 1,
        now: "2026-11-09T10:10:00Z",
      });
      assert.deepEqual(out.actions, []);
    });

    it("leaves cards alone when the board couldn't be read", async () => {
      await writeState(stateFile, {
        13: {
          planProbeId: "13-1762600000",
          planProbeStatus: "queued",
          planProbeSha: "d".repeat(40),
          planProbeQueuedAt: "2026-11-09T10:00:00Z",
        },
      });
      const out = await run("housekeeping", {
        root,
        "repo-root": repo.work,
        "plan-review": "",
        planning: "",
        enabled: 1,
        "boards-ok": 0,
        now: "2026-11-09T10:10:00Z",
      });
      assert.deepEqual(out.actions, []);
    });

    it("expires a probe past its deadline and cancels when switched off", async () => {
      await writeState(stateFile, {
        14: {
          planProbeId: "14-1762600000",
          planProbeStatus: "queued",
          planProbeSha: "d".repeat(40),
          planProbeQueuedAt: "2026-11-09T06:00:00Z",
        },
      });
      let out = await run("housekeeping", {
        root,
        "repo-root": repo.work,
        "plan-review": "14",
        planning: "",
        enabled: 1,
        now: "2026-11-09T10:10:00Z",
      });
      assert.deepEqual(out.actions, [{ issue: "14", action: "failed:expired", post: true }]);
      await writeState(stateFile, {
        15: {
          planProbeId: "15-1762600000",
          planProbeStatus: "queued",
          planProbeSha: "d".repeat(40),
          planProbeQueuedAt: "2026-11-09T10:00:00Z",
        },
      });
      out = await run("housekeeping", {
        root,
        "repo-root": repo.work,
        "plan-review": "15",
        planning: "",
        enabled: 0,
        now: "2026-11-09T10:10:00Z",
      });
      assert.deepEqual(out.actions, [{ issue: "15", action: "cancelled:off", post: false }]);
    });

    it("drops a staging a killed planner run left, spending no round", async () => {
      await writeState(stateFile, {
        16: { planProbeStaging: "16-1762600000" },
        17: { planProbeStaging: "17-1762600000", planProbeRound: "1", planProbeStatus: "folded" },
      });
      mkdirSync(join(root, "16-1762600000"), { recursive: true });
      writeFileSync(join(root, "16-1762600000", "checks.md"), "1. x\n");
      mkdirSync(join(root, "17-1762600000"), { recursive: true });
      const out = await run("housekeeping", {
        root,
        "repo-root": repo.work,
        "plan-review": "16,17",
        planning: "",
        enabled: 1,
        now: "2026-11-09T10:10:00Z",
      });
      assert.deepEqual(out.actions, [
        { issue: "16", action: "staging-dropped", post: false },
        { issue: "17", action: "staging-dropped", post: false },
      ]);
      const s = await loadFactoryState(stateFile);
      assert.equal(s.issues["16"].planProbeStaging, null);
      assert.equal(s.issues["16"].planProbeRound ?? null, null);
      assert.equal(s.issues["17"].planProbeRound, "1");
      assert.equal(existsSync(join(root, "16-1762600000")), false);
      assert.equal(existsSync(join(root, "17-1762600000")), false);
    });

    it("deletes a probe branch nothing owns, and keeps the one a queued probe owns", async () => {
      const own = buildCommit({
        git: repo.runGit,
        mainSha: repo.mainSha,
        issue: "20",
        probeId: "20-1762600000",
      });
      const orphan = buildCommit({
        git: repo.runGit,
        mainSha: repo.mainSha,
        issue: "21",
        probeId: "21-1762600000",
      });
      pushRef(repo.runGit, probeRef("20"), own, "");
      pushRef(repo.runGit, probeRef("21"), orphan, "");
      await writeState(stateFile, {
        20: {
          planProbeId: "20-1762600000",
          planProbeStatus: "queued",
          planProbeSha: own,
          planProbeQueuedAt: "2026-11-09T10:00:00Z",
        },
      });
      const out = await run("housekeeping", {
        root,
        "repo-root": repo.work,
        "plan-review": "20",
        planning: "",
        enabled: 1,
        now: "2026-11-09T10:10:00Z",
      });
      assert.deepEqual(out.actions, [{ issue: "21", action: "orphan-deleted", post: false }]);
      assert.equal(remoteRefSha(repo.runGit, probeRef("20")), own);
      assert.equal(remoteRefSha(repo.runGit, probeRef("21")), "");
    });

    it("folds away a result whose card left Plan Review", async () => {
      await writeState(stateFile, {
        22: { planProbeId: "22-1762600000", planProbeStatus: "reported" },
      });
      const out = await run("housekeeping", {
        root,
        "repo-root": repo.work,
        "plan-review": "",
        planning: "",
        enabled: 1,
        now: "2026-11-09T10:10:00Z",
      });
      assert.deepEqual(out.actions, [
        { issue: "22", action: "folded:left-plan-review", post: false },
      ]);
    });
  });
});
