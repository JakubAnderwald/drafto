import { describe, it, beforeEach, afterEach } from "node:test";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMENT_MAX_CHARS,
  REPORT_MARKER,
  SECRET_PATTERNS,
  accountFileProblem,
  defangReport,
  lastBlock,
  literalForms,
  parseAccountFile,
  parseBlocks,
  parseEnvValues,
  parseRunnerOutput,
  readAccountFile,
  renderIntestComment,
  runShaMarker,
  scanForSecrets,
} from "../lib/browser-report.mjs";

// Guards the only path from the browser runner's stdout to a public GitHub
// comment: the runner drives the Mac mini's signed-in Chrome, so its output is
// parsed strictly, scanned for secrets and defanged before bash posts it.

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "lib", "browser-report.mjs");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const HEADER = "🏭 **Browser run — web steps on the preview.**";

function output({
  report = "| # | Step | Result |\n| 1 | Sign in | PASS |",
  status = "ok",
  verdict = "pass",
} = {}) {
  return `Some preamble.\n<<<REPORT\n${report}\nREPORT>>>\nbrowser=${status} verdict=${verdict}\n`;
}

describe("parseRunnerOutput", () => {
  it("reads the report, status and verdict of a well-formed run", () => {
    const r = parseRunnerOutput(output());
    assert.deepEqual(r, {
      status: "ok",
      verdict: "pass",
      report: "| # | Step | Result |\n| 1 | Sign in | PASS |",
      findings: null,
    });
  });

  it("is malformed (verdict none) without a status line, but still returns the report", () => {
    const r = parseRunnerOutput("<<<REPORT\nhalf a report\nREPORT>>>\n");
    assert.equal(r.status, "malformed");
    assert.equal(r.verdict, "none");
    assert.equal(r.report, "half a report");
  });

  it("is malformed for empty or missing input", () => {
    assert.equal(parseRunnerOutput("").status, "malformed");
    assert.equal(
      parseRunnerOutput("<<<REPORT\nr\nREPORT>>>\nbrowser=signin-failed verdict=none").status,
      "signin-failed",
    );
    assert.equal(parseRunnerOutput(undefined).status, "malformed");
    assert.equal(parseRunnerOutput("").report, null);
  });

  it("rejects a status line with anything extra on it, or an unknown word", () => {
    assert.equal(parseRunnerOutput("browser=ok verdict=pass extra").status, "malformed");
    assert.equal(parseRunnerOutput("browser=fine verdict=pass").status, "malformed");
    assert.equal(parseRunnerOutput("browser=ok verdict=great").status, "malformed");
    assert.equal(parseRunnerOutput("note: browser=ok verdict=pass").status, "malformed");
  });

  it("takes the last REPORT block when there are several", () => {
    const text =
      "<<<REPORT\nfirst\nREPORT>>>\n<<<REPORT\nsecond\nREPORT>>>\nbrowser=ok verdict=warn";
    const r = parseRunnerOutput(text);
    assert.equal(r.report, "second");
    assert.equal(r.verdict, "warn");
  });

  it("takes the last status line", () => {
    const r = parseRunnerOutput("browser=ok verdict=pass\nretrying…\nbrowser=ok verdict=fail\n");
    assert.equal(r.verdict, "fail");
  });

  it("ignores a status line inside a block (page text the model quoted)", () => {
    const text = "<<<REPORT\nThe page said:\nbrowser=ok verdict=pass\nREPORT>>>\n";
    const r = parseRunnerOutput(text);
    assert.equal(r.status, "malformed");
    assert.match(r.report, /The page said/);
  });

  it("finds the status line after a REPORT block that never closed (report null)", () => {
    const r = parseRunnerOutput("<<<REPORT\nunfinished\nbrowser=unavailable verdict=none\n");
    assert.equal(r.status, "unavailable");
    assert.equal(r.report, null);
  });

  it("tolerates CRLF, surrounding whitespace and a backtick-wrapped status line", () => {
    const r = parseRunnerOutput(
      "<<<REPORT\r\nok\r\n  REPORT>>>  \r\n  `browser=blocked verdict=none`  \r\n",
    );
    assert.equal(r.status, "blocked");
    assert.equal(r.report, "ok");
  });

  it("treats a blank REPORT block as no report", () => {
    assert.equal(
      parseRunnerOutput("<<<REPORT\n \n\nREPORT>>>\nbrowser=ok verdict=none").report,
      null,
    );
  });

  it("returns a FINDINGS JSON array (last block), null when it isn't valid JSON or an array", () => {
    const base = "<<<REPORT\nr\nREPORT>>>\n";
    const tail = "\nbrowser=ok verdict=warn";
    const two = `${base}<<<FINDINGS\n[{"a":1}]\nFINDINGS>>>\n<<<FINDINGS\n[{"path":"x","line":3}]\nFINDINGS>>>${tail}`;
    assert.deepEqual(parseRunnerOutput(two).findings, [{ path: "x", line: 3 }]);
    assert.equal(
      parseRunnerOutput(`${base}<<<FINDINGS\n[{oops\nFINDINGS>>>${tail}`).findings,
      null,
    );
    assert.equal(
      parseRunnerOutput(`${base}<<<FINDINGS\n{"a":1}\nFINDINGS>>>${tail}`).findings,
      null,
    );
    assert.equal(parseRunnerOutput(`${base}${tail}`).findings, null);
    const fenced = `${base}<<<FINDINGS\n\`\`\`json\n[1, 2]\n\`\`\`\nFINDINGS>>>${tail}`;
    assert.deepEqual(parseRunnerOutput(fenced).findings, [1, 2]);
  });
});

describe("parseBlocks", () => {
  const STATUS = /^lane=(ok|bad) verdict=(pass|fail)$/;
  const opts = { blocks: ["REPORT", "MANUAL"], statusLine: STATUS };

  it("collects every complete block per name, in order, and the last status line", () => {
    const text = [
      "chatter",
      "<<<REPORT",
      "first report",
      "REPORT>>>",
      "lane=bad verdict=fail",
      "<<<MANUAL",
      "1. Do it.",
      "MANUAL>>>",
      "<<<REPORT",
      "second report",
      "REPORT>>>",
      "lane=ok verdict=pass",
    ].join("\n");
    const { blocks, status } = parseBlocks(text, opts);
    assert.deepEqual(blocks, {
      REPORT: ["first report", "second report"],
      MANUAL: ["1. Do it."],
    });
    assert.deepEqual([...status], ["lane=ok verdict=pass", "ok", "pass"]);
  });

  it("never takes a status line from inside a block, and status is null without one", () => {
    const quoted = parseBlocks("<<<REPORT\nlane=ok verdict=pass\nREPORT>>>\n", opts);
    assert.equal(quoted.status, null);
    assert.deepEqual(quoted.blocks.REPORT, ["lane=ok verdict=pass"]);
    assert.equal(parseBlocks("", opts).status, null);
    assert.equal(parseBlocks(undefined, opts).status, null);
    assert.equal(parseBlocks("lane=ok verdict=pass", { blocks: ["REPORT"] }).status, null);
  });

  it("treats an unclosed block's lines as outside, and another opener inside a block as content", () => {
    const unclosed = parseBlocks("<<<MANUAL\n1. Step\nlane=ok verdict=fail\n", opts);
    assert.deepEqual(unclosed.blocks.MANUAL, []);
    assert.equal(unclosed.status[2], "fail");
    const nested = parseBlocks("<<<REPORT\n<<<MANUAL\nx\nMANUAL>>>\nREPORT>>>\n", opts);
    assert.deepEqual(nested.blocks, { REPORT: ["<<<MANUAL\nx\nMANUAL>>>"], MANUAL: [] });
  });

  it("ignores blocks it wasn't asked for, and tolerates CRLF and a backtick-wrapped status", () => {
    // An unrequested block's lines are ordinary outside lines: its status line counts.
    const r = parseBlocks(
      "`lane=ok verdict=pass`\r\n<<<OTHER\r\nlane=bad verdict=fail\r\nOTHER>>>\r\n",
      opts,
    );
    assert.equal(r.status[1], "bad");
    assert.equal(Object.hasOwn(r.blocks, "OTHER"), false);
    const wrapped = parseBlocks("<<<REPORT\r\nr\r\nREPORT>>>\r\n  `lane=ok verdict=pass`  ", opts);
    assert.equal(wrapped.status[1], "ok");
    assert.deepEqual(wrapped.blocks.REPORT, ["r"]);
  });

  it("is not thrown by a /g status regex (exec would otherwise carry lastIndex)", () => {
    const r = parseBlocks("lane=ok verdict=pass\nlane=ok verdict=fail", {
      blocks: [],
      statusLine: /^lane=(ok|bad) verdict=(pass|fail)$/g,
    });
    assert.equal(r.status[2], "fail");
  });

  it("lastBlock returns the trimmed last block, null when absent or blank", () => {
    const { blocks } = parseBlocks(
      "<<<REPORT\n\n  indented\n\nREPORT>>>\n<<<MANUAL\n \nMANUAL>>>",
      opts,
    );
    assert.equal(lastBlock(blocks, "REPORT"), "  indented");
    assert.equal(lastBlock(blocks, "MANUAL"), null);
    assert.equal(lastBlock(blocks, "NOPE"), null);
    assert.equal(lastBlock(undefined, "REPORT"), null);
  });
});

describe("account file", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "browser-account-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(name, text, mode = 0o600) {
    const p = join(dir, name);
    writeFileSync(p, text);
    chmodSync(p, mode);
    return p;
  }

  it("parses KEY=VALUE lines with comments, export and optional quotes", () => {
    const parsed = parseAccountFile(
      "# dev account\nexport FACTORY_BROWSER_EMAIL='qa@example.com'\n" +
        'FACTORY_BROWSER_PASSWORD="  p@ss=word #1  "\nOTHER=ignored\n',
    );
    assert.deepEqual(parsed, { email: "qa@example.com", password: "  p@ss=word #1  " });
    assert.deepEqual(
      parseAccountFile("FACTORY_BROWSER_EMAIL = a@b.c \nFACTORY_BROWSER_PASSWORD=plain-value\n"),
      { email: "a@b.c", password: "plain-value" },
    );
  });

  it("throws on a missing key, naming the key and never the values", () => {
    assert.throws(
      () => parseAccountFile("FACTORY_BROWSER_EMAIL=secret-email@example.com\n"),
      (err) => /FACTORY_BROWSER_PASSWORD/.test(err.message) && !/secret-email/.test(err.message),
    );
    assert.throws(
      () => parseAccountFile("FACTORY_BROWSER_PASSWORD=x\nFACTORY_BROWSER_EMAIL=\n"),
      /FACTORY_BROWSER_EMAIL/,
    );
  });

  it("readAccountFile reads from disk", () => {
    const p = write("a.env", "FACTORY_BROWSER_EMAIL=a@b.c\nFACTORY_BROWSER_PASSWORD=hunter22\n");
    assert.deepEqual(readAccountFile(p), { email: "a@b.c", password: "hunter22" });
  });

  it("parseEnvValues returns only the wanted keys, last assignment wins", () => {
    const text = "A=1\nexport B='two'\nC=3\nA=again\nconstructor=x\n";
    assert.deepEqual(parseEnvValues(text, ["A", "B"]), { A: "again", B: "two" });
    assert.deepEqual(parseEnvValues(text, ["MISSING"]), {});
  });

  it("accountFileProblem: missing, not-a-file, mode, keys, ok", () => {
    assert.equal(accountFileProblem(join(dir, "nope.env")), "missing");
    mkdirSync(join(dir, "adir"));
    assert.equal(accountFileProblem(join(dir, "adir")), "not-a-file");
    const good = "FACTORY_BROWSER_EMAIL=a@b.c\nFACTORY_BROWSER_PASSWORD=hunter22\n";
    assert.equal(accountFileProblem(write("loose.env", good, 0o644)), "mode");
    assert.equal(accountFileProblem(write("group.env", good, 0o640)), "mode");
    assert.equal(accountFileProblem(write("nokeys.env", "FACTORY_BROWSER_EMAIL=a@b.c\n")), "keys");
    assert.equal(accountFileProblem(write("ok.env", good)), null);
    assert.equal(accountFileProblem(write("ro.env", good, 0o400)), null);
  });
});

describe("scanForSecrets", () => {
  it("finds nothing in an ordinary report", () => {
    assert.deepEqual(scanForSecrets("| 1 | Open the notebook | PASS | saw “Inbox” |"), []);
  });

  it("matches each pattern by name", () => {
    const cases = {
      jwt: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw",
      "supabase-auth-cookie": "cookie sb-huhzactreblzcogqkbsd-auth-token=…",
      bearer: "Authorization: Bearer abcdefghij1234",
      "oauth-token": 'body {"refresh_token": "…"}',
      "vercel-cookie": "Set-Cookie: _vercel_jwt=…",
      "drafto-api-key": "key dk_0123456789abcdef0123456789abcdef0123456789abcdef",
      "sign-in-token": "opened /auth/test-sign-in?token_hash=abcdef0123456789&next=%2F",
    };
    for (const [name, text] of Object.entries(cases)) {
      assert.deepEqual(scanForSecrets(text), [name], name);
    }
    assert.deepEqual(scanForSecrets("authorization: bearer abcdefghij1234"), ["bearer"]);
    assert.deepEqual(scanForSecrets("access_token"), ["oauth-token"]);
    assert.deepEqual(scanForSecrets("_vercel_sso_nonce"), ["vercel-cookie"]);
  });

  it("does not flag near misses", () => {
    assert.deepEqual(scanForSecrets("eyJ.short"), []);
    assert.deepEqual(scanForSecrets("Bearer of news"), []);
    assert.deepEqual(scanForSecrets("accessToken in camel case"), []);
  });

  it("reports several hits in a fixed order", () => {
    assert.deepEqual(
      scanForSecrets("_vercel_jwt and access_token and hunter22", { password: "hunter22" }),
      ["password", "oauth-token", "vercel-cookie"],
    );
  });

  it("matches the password as a literal substring: regex characters never match anything else", () => {
    assert.deepEqual(scanForSecrets("hello world", { password: ".*.*.*" }), []);
    assert.deepEqual(scanForSecrets("typed (a+b)*[c] here", { password: "(a+b)*[c]" }), [
      "password",
    ]);
    assert.deepEqual(scanForSecrets("aaab", { password: "a+b|zz" }), []);
  });

  it("also matches the password URL-encoded and JSON-escaped", () => {
    assert.deepEqual(scanForSecrets("password=p%40ss%20w0rd", { password: "p@ss w0rd" }), [
      "password",
    ]);
    assert.deepEqual(scanForSecrets('{"password":"q\\"uote1"}', { password: 'q"uote1' }), [
      "password",
    ]);
  });

  it("exports its patterns frozen, and the literal forms it matches", () => {
    assert.ok(Object.isFrozen(SECRET_PATTERNS));
    assert.deepEqual(
      SECRET_PATTERNS.map(([name]) => name),
      [
        "jwt",
        "supabase-auth-cookie",
        "bearer",
        "oauth-token",
        "vercel-cookie",
        "drafto-api-key",
        "sign-in-token",
      ],
    );
    assert.deepEqual(literalForms('a b"c'), ['a b"c', "a%20b%22c", 'a b\\"c']);
    assert.deepEqual(literalForms("plain"), ["plain"]);
  });

  it("skips a password shorter than 6 characters", () => {
    assert.deepEqual(scanForSecrets("the word abcde", { password: "abcde" }), []);
    assert.deepEqual(scanForSecrets("the word abcdef", { password: "abcdef" }), ["password"]);
  });
});

describe("renderIntestComment", () => {
  const base = {
    issue: "42",
    sha: SHA,
    verdict: "pass",
    status: "ok",
    evidenceDir: "/ev/run-1",
    withheld: [],
  };
  const lines = (body) => body.split("\n");

  it("leads with the header and verdict, ends with the two markers", () => {
    const body = renderIntestComment({ ...base, report: "| 1 | Sign in | PASS |" });
    const l = lines(body);
    assert.equal(l[0], HEADER);
    assert.match(body, /\*\*Verdict: PASS\*\* for `0123456`/);
    assert.match(body, /\| 1 \| Sign in \| PASS \|/);
    assert.deepEqual(l.slice(-2), [REPORT_MARKER, runShaMarker(SHA)]);
    assert.equal(REPORT_MARKER, "<!-- drafto-factory-browser-report -->");
    assert.equal(runShaMarker(SHA), `<!-- drafto-factory-browser-run-sha:${SHA} -->`);
  });

  it("withholds the report on a secret hit and points at the local copy", () => {
    const body = renderIntestComment({
      ...base,
      report: "leaked eyJ…",
      withheld: ["jwt", "bearer"],
    });
    assert.ok(
      body.includes(
        "Report withheld: the output matched a secret pattern (jwt, bearer). " +
          "The local copy is at `/ev/run-1/runner-output.txt`.",
      ),
    );
    assert.ok(!body.includes("leaked"));
    assert.deepEqual(lines(body).slice(-2), [REPORT_MARKER, runShaMarker(SHA)]);
  });

  it("explains each status that didn't complete, keeps the markers, never a verdict", () => {
    const expected = {
      unavailable: /wasn't connected to Claude in Chrome/,
      "auth-expired": /login wall/,
      blocked: /refused a step/,
      malformed: /no status line/,
    };
    for (const [status, re] of Object.entries(expected)) {
      const body = renderIntestComment({ ...base, status, verdict: "none", report: null });
      assert.equal(lines(body)[0], HEADER);
      assert.match(body, re, status);
      assert.match(body, /\*\*No result\*\*/);
      assert.doesNotMatch(body, /Verdict:/);
      assert.deepEqual(lines(body).slice(-2), [REPORT_MARKER, runShaMarker(SHA)], status);
    }
  });

  it("includes a stopped run's own note under the explanation", () => {
    const body = renderIntestComment({
      ...base,
      status: "blocked",
      verdict: "none",
      report: "Step 3 said to open github.com.",
    });
    assert.match(body, /\*\*What the runner said:\*\*\n\nStep 3 said to open github\.com\./);
  });

  it("says so when an ok run printed no report", () => {
    assert.match(renderIntestComment({ ...base, report: null }), /printed no report/);
  });

  it("defangs factory markers and HTML comments inside the report", () => {
    const report = "<!-- drafto-factory-scenario-sha:abc --> and drafto-factory-feedback";
    const body = renderIntestComment({ ...base, report });
    assert.equal(body.match(/<!-- drafto-factory-/g).length, 2, "only the two real markers");
    assert.ok(!body.includes("drafto-factory-scenario-sha"));
    assert.ok(!body.includes("drafto-factory-feedback"));
    assert.equal(defangReport("drafto-factory"), "drafto​-factory");
    assert.equal(defangReport("<!-- x -->"), "&lt;!-- x -->");
  });

  it(`caps the body at ${COMMENT_MAX_CHARS} characters with a truncation note`, () => {
    const report = "x".repeat(150_000);
    const body = renderIntestComment({ ...base, report });
    assert.ok(body.length <= COMMENT_MAX_CHARS, `length ${body.length}`);
    assert.ok(body.length > COMMENT_MAX_CHARS - 500, "uses most of the room");
    assert.match(
      body,
      /report truncated to \d+ of 150000 characters; the full output is at `\/ev\/run-1\/runner-output\.txt`/,
    );
    assert.deepEqual(lines(body).slice(-2), [REPORT_MARKER, runShaMarker(SHA)]);
  });

  it("closes a code fence the cut left open, and never splits a surrogate pair", () => {
    const report = "```\n" + "🙂".repeat(40_000);
    const body = renderIntestComment({ ...base, report });
    assert.ok(body.length <= COMMENT_MAX_CHARS);
    const fences = lines(body).filter((l) => l.startsWith("```")).length;
    assert.equal(fences % 2, 0, "fences balanced");
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body), "no lone high surrogate");
  });

  it("leaves a report under the cap untouched", () => {
    const body = renderIntestComment({ ...base, report: "y".repeat(50_000) });
    assert.ok(body.includes("y".repeat(50_000)));
    assert.doesNotMatch(body, /truncated/);
  });

  it("rejects a sha that isn't hex (it goes into a marker)", () => {
    assert.throws(
      () => renderIntestComment({ ...base, sha: "abc --> x", report: "r" }),
      /invalid sha/,
    );
  });
});

describe("browser-report CLI", () => {
  let dir;
  let account;
  let evidence;

  function run(args) {
    return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  }

  function renderArgs(inFile, extra = []) {
    return [
      "render",
      "--kind",
      "intest",
      "--in",
      inFile,
      "--issue",
      "42",
      "--sha",
      SHA,
      "--evidence-dir",
      evidence,
      "--account-file",
      account,
      "--out",
      join(dir, "body.md"),
      ...extra,
    ];
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "browser-report-cli-"));
    account = join(dir, "account.env");
    writeFileSync(
      account,
      "FACTORY_BROWSER_EMAIL=qa@example.com\nFACTORY_BROWSER_PASSWORD=S3cret.pass*\n",
      {
        mode: 0o600,
      },
    );
    evidence = join(dir, "evidence");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("render writes the body, a mode-600 local copy, and prints the summary", () => {
    const inFile = join(dir, "out.txt");
    writeFileSync(inFile, output({ verdict: "fail" }));
    const r = run(renderArgs(inFile));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      status: "ok",
      verdict: "fail",
      withheld: false,
      secretHits: [],
    });
    const body = readFileSync(join(dir, "body.md"), "utf8");
    assert.equal(body.split("\n")[0], HEADER);
    assert.match(body, /Verdict: FAIL/);
    const copy = join(evidence, "runner-output.txt");
    assert.equal(readFileSync(copy, "utf8"), output({ verdict: "fail" }));
    assert.equal(statSync(copy).mode & 0o777, 0o600);
  });

  it("render withholds a report that contains the account password", () => {
    const inFile = join(dir, "out.txt");
    writeFileSync(inFile, output({ report: "typed S3cret.pass* into the form" }));
    const r = run(renderArgs(inFile));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      status: "ok",
      verdict: "pass",
      withheld: true,
      secretHits: ["password"],
    });
    const body = readFileSync(join(dir, "body.md"), "utf8");
    assert.ok(!body.includes("S3cret.pass*"));
    assert.match(body, /Report withheld: the output matched a secret pattern \(password\)/);
  });

  it("render fails (exit 1) without writing a body when the account file can't be read", () => {
    const inFile = join(dir, "out.txt");
    writeFileSync(inFile, output());
    rmSync(account);
    const r = run(renderArgs(inFile));
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stderr).error, /ENOENT/);
    assert.ok(!existsSync(join(dir, "body.md")));
  });

  it("render fails (exit 1) on a missing input file", () => {
    const r = run(renderArgs(join(dir, "missing.txt")));
    assert.equal(r.status, 1);
  });

  it("render rejects usage errors with exit 2", () => {
    const inFile = join(dir, "out.txt");
    writeFileSync(inFile, output());
    const args = renderArgs(inFile);
    assert.equal(run(args.map((a) => (a === "intest" ? "uicheck" : a))).status, 2);
    assert.equal(run(args.map((a) => (a === SHA ? "not-a-sha" : a))).status, 2);
    assert.equal(run(args.slice(0, -2)).status, 2, "no --out");
    assert.equal(run(["render", "--kind"]).status, 2, "flag without a value");
    assert.equal(run(["bogus"]).status, 2);
  });

  it("status prints only the parsed status word", () => {
    const inFile = join(dir, "out.txt");
    writeFileSync(inFile, output({ status: "auth-expired", verdict: "none" }));
    let r = run(["status", "--in", inFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "auth-expired\n");
    writeFileSync(inFile, "no status here\n");
    r = run(["status", "--in", inFile]);
    assert.equal(r.stdout, "malformed\n");
    assert.equal(run(["status", "--in", join(dir, "missing.txt")]).status, 1);
  });

  it("account-check prints ok / the problem word, exit 0 iff ok", () => {
    let r = run(["account-check", "--account-file", account]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "ok\n");
    chmodSync(account, 0o644);
    r = run(["account-check", "--account-file", account]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "mode\n");
    r = run(["account-check", "--account-file", join(dir, "nope.env")]);
    assert.equal(r.stdout, "missing\n");
  });
});
