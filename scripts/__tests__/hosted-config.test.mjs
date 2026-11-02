import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPLIED_LABEL,
  CONTROL_REJECTED,
  addedRedirectUrls,
  checkHostedConfig,
  classifyProbe,
  holdComment,
  nonRedirectConfigChanged,
  parseRedirectUrls,
  probeLocation,
  probeUrlFor,
} from "../lib/hosted-config.mjs";

// Tests for the hosted-config gate's logic (ADR-0065). No test touches the
// network: probes go through a fake fetch that models GoTrue's /verify.

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, "..", "lib", "hosted-config.mjs");
const REPO = resolve(HERE, "..", "..");
const REAL_CONFIG = readFileSync(resolve(REPO, "supabase", "config.toml"), "utf8");

const DEV = "huhzactreblzcogqkbsd";
const PROD = "tbmjbxxseonkciqovnpl";
const SITE = "https://drafto.eu";
const FLOW_ENTRIES = [
  "drafto://auth/callback?sb_flow_id=*",
  "drafto://reset-password?sb_flow_id=*",
];

// The config as it was before PR #778 added the two `?sb_flow_id=*` entries.
const PRE_778_CONFIG = REAL_CONFIG.split("\n")
  .filter((line) => !FLOW_ENTRIES.some((entry) => line.includes(`"${entry}"`)))
  .join("\n");

// A tiny glob matcher with Supabase's semantics for the patterns we use:
// `**` matches anything, `*` anything but `.` and `/`, `?` one character.
function globMatches(pattern, url) {
  const re = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((p) =>
          p
            .split("?")
            .map((q) => q.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
            .join("."),
        )
        .join("[^./]*"),
    )
    .join(".*");
  return new RegExp(`^${re}$`).test(url);
}

// Fake GoTrue /verify: 303 to redirect_to when one of the project's entries
// matches it, else to the project's Site URL, keeping the sample's query as
// GoTrue does. `throwName` makes every call throw an error of that name.
function fakeVerify(
  allowlists,
  { calls = [], failFirst = 0, status, throwName, sites = {}, cancelled = [] } = {},
) {
  let failures = failFirst;
  return async (target, init) => {
    calls.push({ target, init });
    if (throwName) {
      const err = new Error(`${throwName} happened`);
      err.name = throwName;
      throw err;
    }
    if (failures > 0) {
      failures -= 1;
      throw new Error("socket hang up");
    }
    const body = { cancel: async () => cancelled.push(target) };
    if (status) return { status, body, headers: { get: () => null } };
    const url = new URL(target);
    const ref = url.hostname.split(".")[0];
    const redirectTo = url.searchParams.get("redirect_to");
    const allowed = (allowlists[ref] ?? []).some((p) => globMatches(p, redirectTo));
    const error = "error=access_denied&error_code=otp_expired";
    let location;
    if (allowed) {
      const [base, query] = redirectTo.split("?");
      location = `${base}${base.split("://")[1].includes("/") ? "" : "/"}?${error}${query ? `&${query}` : ""}`;
    } else {
      location = `${sites[ref] ?? SITE}/?${error}`;
    }
    return {
      status: 303,
      body,
      headers: { get: (h) => (h.toLowerCase() === "location" ? location : null) },
    };
  };
}

const ALL_ENTRIES = parseRedirectUrls(REAL_CONFIG);
const PRE_778_ENTRIES = parseRedirectUrls(PRE_778_CONFIG);

describe("parseRedirectUrls", () => {
  it("reads every entry of the real supabase/config.toml, skipping comments", () => {
    assert.ok(ALL_ENTRIES.includes("drafto://reset-password"));
    assert.ok(ALL_ENTRIES.includes("https://*-jakubanderwalds-projects.vercel.app/**"));
    for (const entry of FLOW_ENTRIES) assert.ok(ALL_ENTRIES.includes(entry), entry);
    const quotedLines = REAL_CONFIG.match(/^\s+"[^"]+",\s*$/gm) ?? [];
    assert.equal(ALL_ENTRIES.length, quotedLines.length);
  });

  it("handles comments with quotes and brackets, literal strings and a trailing comma", () => {
    const toml = `
[api]
additional_redirect_urls = ["not-auth"]

[auth]
site_url = "https://drafto.eu" # trailing ] and "quote" in a comment
additional_redirect_urls = [
  "a://one", # comment with ] and "quotes"
  # "commented://out",
  'b://literal?x=*',
  "c://esc\\"aped",
]
jwt_expiry = 3600
`;
    assert.deepEqual(parseRedirectUrls(toml), ["a://one", "b://literal?x=*", 'c://esc"aped']);
  });

  it("returns [] when the key is absent", () => {
    assert.deepEqual(parseRedirectUrls("[auth]\nsite_url = 'x'\n"), []);
    assert.deepEqual(parseRedirectUrls(""), []);
  });
});

describe("addedRedirectUrls / nonRedirectConfigChanged", () => {
  it("lists only entries the head adds", () => {
    assert.deepEqual(addedRedirectUrls(PRE_778_CONFIG, REAL_CONFIG), FLOW_ENTRIES);
    assert.deepEqual(addedRedirectUrls(REAL_CONFIG, PRE_778_CONFIG), []);
  });

  it("ignores redirect-list, comment, spacing and indentation changes", () => {
    assert.equal(nonRedirectConfigChanged(PRE_778_CONFIG, REAL_CONFIG), false);
    for (const edited of [
      REAL_CONFIG.replace("[auth]\n", "[auth]\n# a new comment\n\n"),
      REAL_CONFIG.replace("jwt_expiry = 3600", "jwt_expiry = 3600 # one hour"),
      REAL_CONFIG.replace("jwt_expiry = 3600", "  jwt_expiry   =   3600"),
    ]) {
      assert.notEqual(edited, REAL_CONFIG);
      assert.equal(nonRedirectConfigChanged(REAL_CONFIG, edited), false, edited.slice(0, 0));
    }
  });

  it("ignores settings that only configure the local stack", () => {
    const local = REAL_CONFIG.replace(/^project_id = .*$/m, 'project_id = "renamed"').replace(
      /^\[db\]\n(?:#.*\n)*port = \d+/m,
      (block) => block.replace(/port = \d+/, "port = 65432"),
    );
    assert.notEqual(local, REAL_CONFIG);
    assert.equal(nonRedirectConfigChanged(REAL_CONFIG, local), false);
  });

  it("flags a real hosted settings change", () => {
    const changed = REAL_CONFIG.replace("jwt_expiry = 3600", "jwt_expiry = 7200");
    assert.notEqual(changed, REAL_CONFIG);
    assert.equal(nonRedirectConfigChanged(REAL_CONFIG, changed), true);
  });

  it("counts the [db] tables that config push applies to a hosted project", () => {
    const settings = `${REAL_CONFIG}\n[db.settings]\nmax_connections = 200\n`;
    assert.equal(nonRedirectConfigChanged(REAL_CONFIG, settings), true, "adding [db.settings]");
    assert.equal(
      nonRedirectConfigChanged(settings, settings.replace("= 200", "= 300")),
      true,
      "editing [db.settings]",
    );
    const restricted = REAL_CONFIG.replace(
      /(\[db\.network_restrictions\]\n(?:#.*\n)*)enabled = false/,
      "$1enabled = true",
    );
    assert.notEqual(restricted, REAL_CONFIG);
    assert.equal(nonRedirectConfigChanged(REAL_CONFIG, restricted), true);
    const majorVersion = REAL_CONFIG.replace(/^major_version = \d+/m, "major_version = 99");
    assert.notEqual(majorVersion, REAL_CONFIG);
    assert.equal(nonRedirectConfigChanged(REAL_CONFIG, majorVersion), true);
  });

  it("counts a table it doesn't recognise, so a gap in the local-only list fails closed", () => {
    const unknown = `${REAL_CONFIG}\n[db.something_new]\nx = 1\n`;
    assert.equal(nonRedirectConfigChanged(REAL_CONFIG, unknown), true);
  });

  it("reads an array-of-tables header as a new section, not as part of the table before it", () => {
    // In the real file [db.network_restrictions] follows [db.seed] directly.
    const withArray = REAL_CONFIG.replace(
      "[db.network_restrictions]",
      "[[x]] # an array section\nname = 1\n\n[db.network_restrictions]",
    );
    assert.match(withArray, /\[db\.seed\]\n(?:.*\n)*?\[\[x\]\]/, "an [[x]] after [db.seed]");
    assert.equal(nonRedirectConfigChanged(REAL_CONFIG, withArray), true);
    assert.equal(
      nonRedirectConfigChanged(withArray, withArray.replace("name = 1", "name = 2")),
      true,
      "a key under [[x]] after the local-only [db.seed] still counts",
    );
  });

  it("reads Redirect URLs only under [auth], not under an array section", () => {
    const text = '[auth]\nsite_url = "x"\n[[auth]]\nadditional_redirect_urls = ["drafto://a"]\n';
    assert.deepEqual(parseRedirectUrls(text), []);
  });
});

describe("probeUrlFor", () => {
  it("samples * and ** and keeps a literal ?", () => {
    assert.equal(
      probeUrlFor("drafto://reset-password?sb_flow_id=*"),
      "drafto://reset-password?sb_flow_id=probe",
    );
    assert.equal(probeUrlFor("http://localhost:3000/**"), "http://localhost:3000/probe/x");
    assert.equal(
      probeUrlFor("https://*-jakubanderwalds-projects.vercel.app/**"),
      "https://probe-jakubanderwalds-projects.vercel.app/probe/x",
    );
    assert.equal(probeUrlFor("drafto://auth/callback"), "drafto://auth/callback");
  });

  it("refuses glob syntax it can't sample, and samples that aren't URLs", () => {
    assert.equal(probeUrlFor("drafto://[ab]"), null);
    assert.equal(probeUrlFor("drafto://{a,b}"), null);
    assert.equal(probeUrlFor("http://localhost:*/**"), null, "a * in the port isn't a valid URL");
  });

  it("produces a sample its own entry matches", () => {
    for (const entry of ALL_ENTRIES) assert.ok(globMatches(entry, probeUrlFor(entry)), entry);
  });
});

describe("classifyProbe (Location shapes captured from the live projects)", () => {
  it("reads a redirect to the sample as allowed", () => {
    assert.equal(
      classifyProbe(
        "drafto://reset-password?sb_flow_id=x",
        "drafto://reset-password/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb_flow_id=x",
        SITE,
      ).result,
      "allowed",
    );
    assert.equal(
      classifyProbe(
        "eu.drafto.desktop://auth/recovery",
        "eu.drafto.desktop://auth/recovery?error=access_denied&error_code=otp_expired",
        SITE,
      ).result,
      "allowed",
    );
  });

  it("reads a fall-back to the Site URL as rejected", () => {
    assert.equal(
      classifyProbe(
        "drafto://not-allowlisted",
        "https://drafto.eu/?error=access_denied&error_code=otp_expired",
        SITE,
      ).result,
      "rejected",
    );
  });

  it("treats a dropped query, a foreign target or no Location as an error", () => {
    assert.equal(
      classifyProbe(
        "drafto://reset-password?sb_flow_id=x",
        "drafto://reset-password/?error=x",
        SITE,
      ).result,
      "error",
    );
    assert.equal(classifyProbe("drafto://a", "https://evil.example/", SITE).result, "error");
    assert.equal(classifyProbe("drafto://a", null, SITE).result, "error");
  });
});

describe("probeLocation", () => {
  it("sends a junk pkce token, doesn't follow the redirect, and discards the body", async () => {
    const calls = [];
    const cancelled = [];
    const fetchImpl = fakeVerify({ [DEV]: ["drafto://a"] }, { calls, cancelled });
    const out = await probeLocation({ ref: DEV, url: "drafto://a", fetchImpl, timeoutMs: 1000 });
    assert.equal(out.location, "drafto://a/?error=access_denied&error_code=otp_expired");
    const target = new URL(calls[0].target);
    assert.equal(target.host, `${DEV}.supabase.co`);
    assert.equal(target.pathname, "/auth/v1/verify");
    assert.match(target.searchParams.get("token"), /^pkce_[0-9a-f]{32}$/);
    assert.equal(target.searchParams.get("type"), "recovery");
    assert.equal(target.searchParams.get("redirect_to"), "drafto://a");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(cancelled.length, 1);
  });

  it("retries a dropped connection once", async () => {
    const calls = [];
    const out = await probeLocation({
      ref: DEV,
      url: "drafto://a",
      fetchImpl: fakeVerify({ [DEV]: ["drafto://a"] }, { calls, failFirst: 1 }),
      timeoutMs: 1000,
    });
    assert.ok(out.location);
    assert.equal(calls.length, 2);
  });

  it("doesn't retry a rate limit or a timeout", async () => {
    for (const opts of [{ status: 429 }, { throwName: "TimeoutError" }]) {
      const calls = [];
      const out = await probeLocation({
        ref: DEV,
        url: "drafto://a",
        fetchImpl: fakeVerify({}, { ...opts, calls }),
        timeoutMs: 1000,
      });
      assert.ok(out.error);
      assert.equal(calls.length, 1, JSON.stringify(opts));
    }
  });
});

describe("checkHostedConfig", () => {
  const both = (entries) => ({ [DEV]: entries, [PROD]: entries });

  it("does nothing, and probes nothing, when the redirect list is unchanged", async () => {
    const calls = [];
    const out = await checkHostedConfig({
      baseText: REAL_CONFIG,
      headText: REAL_CONFIG,
      fetchImpl: fakeVerify({}, { calls }),
    });
    assert.equal(out.status, "ok");
    assert.equal(calls.length, 0);
  });

  it("holds the #778 replay while prod lacks the ?sb_flow_id=* entries", async () => {
    const out = await checkHostedConfig({
      baseText: PRE_778_CONFIG,
      headText: REAL_CONFIG,
      fetchImpl: fakeVerify({ [DEV]: ALL_ENTRIES, [PROD]: PRE_778_ENTRIES }),
    });
    assert.equal(out.status, "hold");
    assert.deepEqual(
      out.missing.map((m) => `${m.project} ${m.entry}`),
      FLOW_ENTRIES.map((entry) => `prod ${entry}`),
    );
    assert.equal(out.needsLabel, false);
  });

  it("passes once both projects have the entries", async () => {
    const out = await checkHostedConfig({
      baseText: PRE_778_CONFIG,
      headText: REAL_CONFIG,
      fetchImpl: fakeVerify(both(ALL_ENTRIES)),
    });
    assert.equal(out.status, "ok");
    assert.deepEqual(out.missing, []);
  });

  it("learns each project's Site URL from the rejected control", async () => {
    // dev falls back somewhere other than drafto.eu; a hardcoded Site URL
    // would misread every dev rejection as an unexpected redirect.
    const sites = { [DEV]: "http://localhost:3000" };
    const held = await checkHostedConfig({
      baseText: PRE_778_CONFIG,
      headText: REAL_CONFIG,
      fetchImpl: fakeVerify({ [DEV]: PRE_778_ENTRIES, [PROD]: ALL_ENTRIES }, { sites }),
    });
    assert.equal(held.status, "hold");
    assert.deepEqual([...new Set(held.missing.map((m) => m.project))], ["dev"]);
    const ok = await checkHostedConfig({
      baseText: PRE_778_CONFIG,
      headText: REAL_CONFIG,
      fetchImpl: fakeVerify(both(ALL_ENTRIES), { sites }),
    });
    assert.equal(ok.status, "ok");
  });

  it("is unknown, not a false hold, when the allowed control is refused", async () => {
    // As if /verify stopped honouring redirect_to: everything falls back.
    const out = await checkHostedConfig({
      baseText: PRE_778_CONFIG,
      headText: REAL_CONFIG,
      fetchImpl: fakeVerify({}),
    });
    assert.equal(out.status, "unknown");
    assert.deepEqual(out.missing, []);
    assert.equal(out.errors.length, 2);
    assert.match(
      out.errors[0].detail,
      /control probes misbehaved: drafto:\/\/auth\/callback was not accepted/,
    );
  });

  it("is unknown when the rejected control is accepted", async () => {
    const out = await checkHostedConfig({
      baseText: PRE_778_CONFIG,
      headText: REAL_CONFIG,
      fetchImpl: fakeVerify(both(["**"])),
    });
    assert.equal(out.status, "unknown");
    assert.ok(out.errors.every((e) => e.detail.includes(`${CONTROL_REJECTED} was accepted`)));
  });

  it("lets the label overrule an inconclusive check, but never a confirmed miss", async () => {
    const unknown = await checkHostedConfig({
      baseText: PRE_778_CONFIG,
      headText: REAL_CONFIG,
      prLabels: [APPLIED_LABEL],
      fetchImpl: fakeVerify({}, { status: 429 }),
    });
    assert.equal(unknown.status, "ok");
    assert.ok(unknown.errors.length > 0, "the errors are still reported");
    const missing = await checkHostedConfig({
      baseText: PRE_778_CONFIG,
      headText: REAL_CONFIG,
      prLabels: [APPLIED_LABEL],
      fetchImpl: fakeVerify({ [DEV]: ALL_ENTRIES, [PROD]: PRE_778_ENTRIES }),
    });
    assert.equal(missing.status, "hold");
  });

  it("needs the label for a change outside the redirect list, and only that", async () => {
    const head = REAL_CONFIG.replace("jwt_expiry = 3600", "jwt_expiry = 7200");
    const calls = [];
    const held = await checkHostedConfig({
      baseText: REAL_CONFIG,
      headText: head,
      fetchImpl: fakeVerify({}, { calls }),
    });
    assert.equal(held.status, "hold");
    assert.equal(held.needsLabel, true);
    assert.equal(calls.length, 0, "nothing to probe");
    const ok = await checkHostedConfig({
      baseText: REAL_CONFIG,
      headText: head,
      prLabels: [APPLIED_LABEL],
    });
    assert.equal(ok.status, "ok");
  });

  it("needs the label for an entry it can't probe", async () => {
    const head = REAL_CONFIG.replace(
      '  "drafto://reset-password",',
      '  "drafto://reset-password",\n  "drafto://[ab]",\n  "http://localhost:*/**",',
    );
    const out = await checkHostedConfig({
      baseText: REAL_CONFIG,
      headText: head,
      fetchImpl: fakeVerify({}),
    });
    assert.equal(out.status, "hold");
    assert.deepEqual(out.unprobeable, ["drafto://[ab]", "http://localhost:*/**"]);
  });
});

describe("holdComment", () => {
  const holdResult = (missing, extra = {}) => ({
    status: "hold",
    missing,
    unprobeable: [],
    nonRedirectChange: false,
    needsLabel: false,
    errors: [],
    ...extra,
  });

  it("lists missing entries per project with dashboard links and warns off config push", () => {
    const body = holdComment(
      holdResult([
        { project: "dev", ref: DEV, entry: FLOW_ENTRIES[0] },
        { project: "prod", ref: PROD, entry: FLOW_ENTRIES[0] },
        { project: "prod", ref: PROD, entry: FLOW_ENTRIES[1] },
      ]),
      { pr: 778, where: "In Review" },
    );
    assert.match(body, /Hold — the hosted Supabase config doesn't match this PR yet/);
    assert.match(body, /PR #778 changes `supabase\/config.toml`/);
    assert.match(body, /stays in \*\*In Review\*\*: no test scenario and no beta builds/);
    assert.match(body, new RegExp(`dashboard/project/${DEV}/auth/url-configuration`));
    assert.match(body, new RegExp(`dashboard/project/${PROD}/auth/url-configuration`));
    assert.match(
      body,
      /- \*\*prod\*\*[^\n]*\n {2}- `drafto:\/\/auth\/callback\?sb_flow_id=\*`\n {2}- `drafto:\/\/reset-password\?sb_flow_id=\*`/,
    );
    assert.match(body, /Don't use `supabase config push`/);
    assert.doesNotMatch(body, /hosted-config-applied/);
  });

  it("lists whichever projects were checked, not only dev and prod", () => {
    const body = holdComment(
      holdResult([{ project: "staging", ref: "stagingref", entry: "drafto://s" }]),
    );
    assert.match(body, /- \*\*staging\*\* \(`stagingref`[^\n]*\n {2}- `drafto:\/\/s`/);
  });

  it("asks for the label when something can't be probed, and says the label is per version", () => {
    const body = holdComment(holdResult([], { nonRedirectChange: true, needsLabel: true }), {
      pr: 5,
      where: "Approved",
    });
    assert.match(body, /won't merge it, and the card stays in \*\*Approved\*\*/);
    assert.match(body, /add the \*\*`hosted-config-applied`\*\* label to PR #5/);
    assert.match(body, /if a later commit changes the file, the factory removes it/);
  });

  it("names the beta hold", () => {
    const body = holdComment(holdResult([{ project: "prod", ref: PROD, entry: "drafto://b" }]), {
      where: "beta",
    });
    assert.match(body, /won't build betas of this commit/);
  });

  it("explains an unknown result without claiming anything is missing", () => {
    const body = holdComment(
      {
        status: "unknown",
        errors: [{ project: "prod", ref: PROD, entry: FLOW_ENTRIES[0], detail: "HTTP 429" }],
      },
      { pr: 9 },
    );
    assert.match(body, /couldn't verify the hosted Supabase config/);
    assert.match(body, /\*\*prod\*\* `drafto:\/\/auth\/callback\?sb_flow_id=\*`: HTTP 429/);
    assert.match(body, /overrides an inconclusive check, but never a confirmed missing entry/);
    assert.doesNotMatch(body, /Add these Redirect URLs/);
  });
});

describe("hosted-config.mjs CLI", () => {
  function cli(args) {
    return spawnSync(process.execPath, [MODULE, ...args], { encoding: "utf8", cwd: REPO });
  }
  function withFiles(base, head, body) {
    const dir = mkdtempSync(join(tmpdir(), "hosted-config-"));
    try {
      const b = join(dir, "base.toml");
      const h = join(dir, "head.toml");
      writeFileSync(b, base);
      writeFileSync(h, head);
      return body(b, h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rejects a call without the check subcommand", () => {
    const r = cli([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage: hosted-config.mjs check/);
  });

  it("prints ok JSON and exits 0 when nothing changed, without probing", () => {
    withFiles(REAL_CONFIG, REAL_CONFIG, (b, h) => {
      const r = cli(["check", "--base-file", b, "--head-file", h]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.status, "ok");
      assert.equal(out.comment, "");
    });
  });

  it("diffs two refs from their merge base", () => {
    const r = cli(["check", "--base-ref", "HEAD", "--head-ref", "HEAD"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, "ok");
  });

  it("exits 3 with a ready comment when a setting needs the label, and 0 with it", () => {
    withFiles(
      REAL_CONFIG,
      REAL_CONFIG.replace("jwt_expiry = 3600", "jwt_expiry = 7200"),
      (b, h) => {
        const r = cli([
          "check",
          "--base-file",
          b,
          "--head-file",
          h,
          "--pr",
          "12",
          "--where",
          "Approved",
        ]);
        assert.equal(r.status, 3, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.equal(out.status, "hold");
        assert.match(out.comment, /PR #12/);
        assert.match(out.comment, /\*\*Approved\*\*/);
        // pnpm forwards a literal `--` before script args; it must not swallow them.
        const labelled = cli([
          "check",
          "--base-file",
          b,
          "--head-file",
          h,
          "--",
          "--labels",
          APPLIED_LABEL,
        ]);
        assert.equal(labelled.status, 0, labelled.stderr);
      },
    );
  });
});
