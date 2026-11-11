// Tests for scripts/user-stats.mjs (`pnpm users:stats`): argument parsing,
// the session refusal, the read-only RPC client, table and JSON output, and a
// whole run against a fake fetch. What must hold: it only ever sends GET to
// /rest/v1/rpc/metrics_*, the service-role key travels in headers only and is
// never printed, and a metric that fails doesn't hide the others. No network:
// every call goes to a fake, and every key here is fake.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLIENT_COLUMNS,
  DEFAULT_WEEKS,
  MAX_WEEKS,
  METRICS,
  USAGE,
  UsageError,
  buildJson,
  collectMetrics,
  columnsFor,
  createStatsClient,
  formatReport,
  formatTable,
  main,
  metricParams,
  parseArgs,
  redact,
  refusalReason,
} from "../user-stats.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_KEY = "fake-prod-service-key-3c9e1a7b5d2f4608";
const DEV_KEY = "fake-dev-service-key-8a2c4e6f1b3d5079";
const NOW = new Date("2026-11-12T10:00:00.000Z");

const ROWS = {
  metrics_signups: [
    {
      week_start: "2026-11-02",
      iso_week: "2026-W45",
      signups: 3,
      by_provider: { email: 2, google: 1 },
    },
    { week_start: "2026-11-09", iso_week: "2026-W46", signups: 0, by_provider: {} },
  ],
  metrics_activation: [
    {
      week_start: "2026-09-14",
      iso_week: "2026-W38",
      signed_up: 4,
      first_value: 2,
      activated: null,
      window_complete: true,
    },
    {
      week_start: "2026-11-09",
      iso_week: "2026-W46",
      signed_up: 2,
      first_value: 1,
      activated: 0,
      window_complete: false,
    },
  ],
  metrics_writers: [
    {
      week_start: "2026-11-09",
      iso_week: "2026-W46",
      writers: 5,
      by_client: { web: 3, untagged: 2, "web-cron": 1 },
      history_complete: false,
    },
  ],
  metrics_emptied_notes: [
    {
      note_id: "11111111-1111-4111-8111-111111111111",
      user_id: "22222222-2222-4222-8222-222222222222",
      emptied_at: "2026-11-08T21:05:12.345678+00:00",
      client: "web",
      chars_before: 2625,
    },
  ],
  metrics_depth: [
    {
      writers: 7,
      live_notes_median: 12.5,
      live_notes_max: 200,
      notebooks_median: 2,
      notebooks_max: 9,
      attachment_mb_median: 0.25,
      attachment_mb_max: 31.4,
      pct_with_attachment: 42.9,
      pct_with_api_key: 14.3,
      pct_with_mcp_write: 14.3,
      pct_multi_client: 28.6,
    },
  ],
  metrics_platform_limits: [
    { resource: "database", used_bytes: 52428800, limit_bytes: 524288000, pct: 10, level: "ok" },
    { resource: "storage", used_bytes: 805306368, limit_bytes: 1073741824, pct: 75, level: "warn" },
  ],
};

/**
 * A fetch fake answering /rest/v1/rpc/<fn> from <rows>; a function listed in
 * <fail> answers with an error status instead. Records every call.
 */
function fakeFetch({ rows = ROWS, fail = {} } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method, headers: init.headers, body: init.body });
    const fn = u.pathname.replace(/^\/rest\/v1\/rpc\//, "");
    if (Object.hasOwn(fail, fn)) {
      return new Response(JSON.stringify(fail[fn].body), { status: fail[fn].status });
    }
    if (!Object.hasOwn(rows, fn)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(rows[fn]), { status: 200 });
  };
  return { impl, calls };
}

function withKeysFile(text, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "user-stats-"));
  const file = path.join(dir, "keys.txt");
  writeFileSync(file, text, { mode: 0o600 });
  return Promise.resolve(fn(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** main() with a fake fetch and captured output; returns {code, out, err, calls}. */
async function runMain(argv, { fetch = fakeFetch(), env = {}, readFile } = {}) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    env,
    execArgv: [],
    fetchImpl: fetch.impl,
    now: () => NOW,
    readFile,
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
  });
  return { code, out, err, calls: fetch.calls };
}

describe("parseArgs", () => {
  const keysTxt = "/k/keys.txt";

  it("needs --project and defaults the rest", () => {
    assert.deepEqual(parseArgs(["--project", "prod"], { keysTxt }), {
      project: "prod",
      weeks: DEFAULT_WEEKS,
      json: false,
      keysTxt,
      help: false,
    });
    assert.match(
      parseArgs(["--project", "dev"]).keysTxt,
      /drafto-secrets\/supabase service keys\.txt$/,
    );
  });

  it("reads --weeks, --json and --keys-txt in either form, skipping a bare --", () => {
    assert.deepEqual(
      parseArgs(["--", "--project=dev", "--weeks", "12", "--json", "--keys-txt=/x.txt"], {
        keysTxt,
      }),
      { project: "dev", weeks: 12, json: true, keysTxt: "/x.txt", help: false },
    );
    assert.equal(parseArgs(["--project", "dev", "--weeks=1"]).weeks, 1);
    assert.equal(parseArgs(["--project", "dev", `--weeks=${MAX_WEEKS}`]).weeks, MAX_WEEKS);
  });

  it("returns early for --help, whatever else is there", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h", "--weeks", "0"]).help, true);
  });

  for (const [argv, why] of [
    [[], /--project must be prod or dev/],
    [["--project", "staging"], /--project must be prod or dev/],
    [["--project"], /--project needs a value/],
    [["--project", "--json"], /--project needs a value/],
    [["--project", "prod", "--weeks", "0"], /--weeks must be a whole number from 1 to 104/],
    [["--project", "prod", "--weeks", "105"], /--weeks must be/],
    [["--project", "prod", "--weeks", "2.5"], /--weeks must be/],
    [["--project", "prod", "--weeks", "-3"], /--weeks must be/],
    [["--project", "prod", "--weeks=abc"], /--weeks must be/],
    [["--project", "prod", "--weeks="], /--weeks must be/],
    [["--project", "prod", "--keys-txt="], /--keys-txt needs a path/],
    [["--project", "prod", "--execute"], /unknown option --execute/],
    [["--project", "prod", "--json=1"], /unknown option --json/],
    [["--project", "prod", "stray"], /unexpected argument stray/],
  ]) {
    it(`rejects ${JSON.stringify(argv)}`, () => {
      assert.throws(
        () => parseArgs(argv, { keysTxt }),
        (err) => err instanceof UsageError && why.test(err.message),
      );
    });
  }
});

describe("refusalReason", () => {
  it("refuses unattended sessions, whatever the value", () => {
    for (const value of ["1", "0", "yes"]) {
      assert.match(
        refusalReason({ env: { DRAFTO_UNATTENDED: value }, execArgv: [] }),
        /DRAFTO_UNATTENDED is set: .*interactive sessions only/,
      );
    }
  });

  it("refuses node --test, and allows an interactive run", () => {
    assert.match(
      refusalReason({ env: { NODE_TEST_CONTEXT: "child" }, execArgv: [] }),
      /node --test/,
    );
    assert.match(refusalReason({ env: {}, execArgv: ["--test"] }), /node --test/);
    assert.equal(refusalReason({ env: {}, execArgv: [] }), null);
    assert.equal(refusalReason({ env: { DRAFTO_UNATTENDED: "" }, execArgv: [] }), null);
  });
});

describe("metricParams", () => {
  it("passes the weeks to the weekly metrics and looks as far back for emptied notes", () => {
    assert.deepEqual(metricParams({ weeks: 2, now: NOW }), {
      signups: { p_weeks: 2 },
      activation: { p_weeks: 2 },
      writers: { p_weeks: 2 },
      emptiedNotes: { p_since: "2026-10-29T10:00:00.000Z" },
      depth: {},
      platformLimits: {},
    });
  });

  it("covers every metric", () => {
    assert.deepEqual(
      Object.keys(metricParams({ weeks: 1, now: NOW })).sort(),
      METRICS.map((m) => m.key).sort(),
    );
  });
});

describe("createStatsClient", () => {
  it("calls the RPC with GET, its parameters in the query and the key in headers only", async () => {
    const fetch = fakeFetch();
    const client = createStatsClient({ ref: "abc", serviceKey: PROD_KEY, fetchImpl: fetch.impl });
    assert.deepEqual(await client.rpc("metrics_signups", { p_weeks: 3 }), ROWS.metrics_signups);
    await client.rpc("metrics_depth");
    const [first, second] = fetch.calls;
    assert.equal(first.method, "GET");
    assert.equal(first.body, undefined);
    assert.equal(first.url.origin, "https://abc.supabase.co");
    assert.equal(first.url.pathname, "/rest/v1/rpc/metrics_signups");
    assert.equal(first.url.search, "?p_weeks=3");
    assert.equal(first.headers.apikey, PROD_KEY);
    assert.equal(first.headers.Authorization, `Bearer ${PROD_KEY}`);
    assert.equal(second.url.search, "");
    for (const call of fetch.calls) assert.ok(!call.url.href.includes(PROD_KEY));
  });

  it("refuses anything but a metrics function", async () => {
    const fetch = fakeFetch();
    const client = createStatsClient({ ref: "abc", serviceKey: PROD_KEY, fetchImpl: fetch.impl });
    for (const fn of ["note_text_chars", "delete_everything", "metrics_x?y=1", "../notes"]) {
      await assert.rejects(client.rpc(fn), /not a metrics function/);
    }
    assert.equal(fetch.calls.length, 0);
  });

  it("names the function and status on an error, with the key masked", async () => {
    const fetch = fakeFetch({
      fail: {
        metrics_signups: {
          status: 403,
          body: { code: "42501", message: `permission denied; echoed ${PROD_KEY}` },
        },
      },
    });
    const client = createStatsClient({ ref: "abc", serviceKey: PROD_KEY, fetchImpl: fetch.impl });
    await assert.rejects(client.rpc("metrics_signups", { p_weeks: 1 }), (err) => {
      assert.match(err.message, /^metrics_signups -> HTTP 403 .*42501/);
      assert.ok(!err.message.includes(PROD_KEY));
      assert.match(err.message, /\[redacted\]/);
      return true;
    });
  });

  it("reports a body that isn't JSON", async () => {
    const client = createStatsClient({
      ref: "abc",
      serviceKey: PROD_KEY,
      fetchImpl: async () => new Response("<html>", { status: 200 }),
    });
    await assert.rejects(client.rpc("metrics_depth"), /metrics_depth -> HTTP 200, not JSON/);
  });
});

describe("collectMetrics", () => {
  it("reads every metric, unwraps depth's one row, and keeps going past a failure", async () => {
    const fetch = fakeFetch({
      fail: { metrics_writers: { status: 500, body: { message: "boom" } } },
    });
    const client = createStatsClient({ ref: "abc", serviceKey: PROD_KEY, fetchImpl: fetch.impl });
    const { metrics, errors } = await collectMetrics(client, { weeks: 4, now: NOW });
    assert.deepEqual(Object.keys(errors), ["writers"]);
    assert.match(errors.writers, /metrics_writers -> HTTP 500/);
    assert.deepEqual(metrics.depth, ROWS.metrics_depth[0]);
    assert.deepEqual(metrics.signups, ROWS.metrics_signups);
    assert.equal(Object.hasOwn(metrics, "writers"), false);
    assert.deepEqual(
      fetch.calls.map((c) => c.url.pathname.split("/").pop()).sort(),
      METRICS.map((m) => m.fn).sort(),
    );
  });

  it("gives depth null when the function returns no row", async () => {
    const fetch = fakeFetch({ rows: { ...ROWS, metrics_depth: [] } });
    const client = createStatsClient({ ref: "abc", serviceKey: PROD_KEY, fetchImpl: fetch.impl });
    const { metrics } = await collectMetrics(client, { weeks: 4, now: NOW });
    assert.equal(metrics.depth, null);
  });
});

describe("formatTable", () => {
  it("aligns numbers right and text left, under a rule", () => {
    assert.equal(
      formatTable(
        ["Name", "Count", "Share"],
        [
          ["alpha", 3, "50.0%"],
          ["b", 12, null],
        ],
      ),
      [
        "Name   Count  Share",
        "-----  -----  -----",
        "alpha      3  50.0%",
        "b         12      –",
      ].join("\n"),
    );
  });

  it("prints only the header and rule for no rows", () => {
    assert.equal(formatTable(["A", "B"], []), "A  B\n-  -");
  });
});

describe("columnsFor", () => {
  it("puts known keys first, then the rest alphabetically", () => {
    assert.deepEqual(
      columnsFor(
        [
          { zeta: 1, google: 1 },
          { email: 1, alpha: 1 },
        ],
        ["email", "google", "apple"],
      ),
      ["email", "google", "alpha", "zeta"],
    );
    assert.deepEqual(columnsFor([{ "web-cron": 1 }], CLIENT_COLUMNS, { always: true }), [
      ...CLIENT_COLUMNS,
      "web-cron",
    ]);
    assert.deepEqual(columnsFor([null, {}], ["email"]), []);
  });
});

describe("formatReport", () => {
  const base = { project: "prod", ref: "tbmjbxxseonkciqovnpl", weeks: 8, now: NOW, errors: {} };
  const metrics = {
    signups: ROWS.metrics_signups,
    activation: ROWS.metrics_activation,
    writers: ROWS.metrics_writers,
    emptiedNotes: ROWS.metrics_emptied_notes,
    depth: ROWS.metrics_depth[0],
    platformLimits: ROWS.metrics_platform_limits,
  };

  it("prints one titled table per metric, with units", () => {
    const text = formatReport({ ...base, metrics });
    assert.match(
      text,
      /^Drafto product metrics — prod \(tbmjbxxseonkciqovnpl\), last 8 ISO week\(s\)/,
    );
    assert.match(text, /Admins and metrics_excluded_users are left out/);
    for (const title of [
      "== Sign-ups per ISO week (UTC)",
      "== Activation by sign-up week",
      "== Writers per ISO week",
      "== Notes emptied by one save (200+ characters to none, still empty 24h later), since 2026-09-17",
      "== Depth of use",
      "== Supabase Free plan limits (project-wide)",
    ]) {
      assert.ok(text.includes(title), title);
    }
    assert.match(text, /Week {6}Starts {6}Sign-ups {2}email {2}google\n/);
    assert.match(text, /2026-W45 {2}2026-11-02 {9}3 {6}2 {7}1/);
    // A cohort past the history retention shows n/a, not 0.
    assert.match(text, /2026-W38 .* 50\.0% +n\/a +n\/a +closed/);
    assert.match(text, /2026-W46 .* 0 +0\.0% +open/);
    // Every client column, plus a tag outside the known set.
    assert.match(
      text,
      /Writers {2}web {2}mobile-ios {2}mobile-android {2}desktop-macos {2}web-mcp {2}untagged {2}web-cron {2}History/,
    );
    assert.match(text, /partial/);
    assert.match(text, /2026-11-08 21:05:12 {2}web {13}2625 {2}11111111-/);
    assert.match(text, /Writers in the last 30 days: 7/);
    assert.match(text, /Attachments \(MB\) +0\.25 +31\.40/);
    assert.match(text, /With an MCP write +14\.3%/);
    assert.match(text, /Used \(MB\) {2}Limit \(MB\) {2}Used % {2}Level/);
    assert.match(text, /storage {7}768\.0 {6}1024\.0 {3}75\.0% {2}warn/);
  });

  it("marks a failed metric and says when nothing was emptied", () => {
    const text = formatReport({
      ...base,
      metrics: { ...metrics, emptiedNotes: [], signups: undefined },
      errors: { signups: "metrics_signups -> HTTP 403 permission denied" },
    });
    assert.match(text, /== Sign-ups per ISO week \(UTC\)\nFAILED: metrics_signups -> HTTP 403/);
    assert.match(text, /still empty 24h later\), since 2026-09-17\n\(none\)/);
  });
});

describe("buildJson", () => {
  it("carries the run's settings, every metric and the errors", () => {
    const json = buildJson({
      project: "dev",
      ref: "huhzactreblzcogqkbsd",
      weeks: 2,
      now: NOW,
      metrics: { depth: null },
      errors: { signups: "x" },
    });
    assert.deepEqual(json, {
      project: "dev",
      ref: "huhzactreblzcogqkbsd",
      generatedAt: "2026-11-12T10:00:00.000Z",
      weeks: 2,
      emptiedSince: "2026-10-29T10:00:00.000Z",
      metrics: { depth: null },
      errors: { signups: "x" },
    });
  });
});

describe("redact", () => {
  it("masks every occurrence, and leaves text alone without a secret", () => {
    assert.equal(redact("a SECRET b SECRET", "SECRET"), "a [redacted] b [redacted]");
    assert.equal(redact("plain", ""), "plain");
  });
});

describe("main", () => {
  const keys = `PROD: ${PROD_KEY}\nDEV: ${DEV_KEY}\n`;

  it("prints the tables for --project prod, from GET calls with the prod key", async () => {
    await withKeysFile(keys, async (file) => {
      const r = await runMain(["--project", "prod", "--weeks", "3", "--keys-txt", file]);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.err, "");
      assert.match(r.out, /prod \(tbmjbxxseonkciqovnpl\), last 3 ISO week\(s\)/);
      assert.equal(r.calls.length, METRICS.length);
      for (const call of r.calls) {
        assert.equal(call.method, "GET");
        assert.equal(call.url.host, "tbmjbxxseonkciqovnpl.supabase.co");
        assert.match(call.url.pathname, /^\/rest\/v1\/rpc\/metrics_[a-z_]+$/);
        assert.equal(call.headers.apikey, PROD_KEY);
      }
      assert.ok(!r.out.includes(PROD_KEY) && !r.out.includes(DEV_KEY));
    });
  });

  it("prints one JSON object for --json, with the dev key for --project dev", async () => {
    await withKeysFile(keys, async (file) => {
      const r = await runMain(["--project", "dev", "--json", "--keys-txt", file]);
      assert.equal(r.code, 0, r.err);
      const json = JSON.parse(r.out);
      assert.equal(json.ref, "huhzactreblzcogqkbsd");
      assert.equal(json.weeks, DEFAULT_WEEKS);
      assert.deepEqual(json.errors, {});
      assert.deepEqual(json.metrics.platformLimits, ROWS.metrics_platform_limits);
      assert.deepEqual(json.metrics.depth, ROWS.metrics_depth[0]);
      assert.equal(r.calls[0].headers.apikey, DEV_KEY);
      assert.ok(!r.out.includes(DEV_KEY) && !r.out.includes(PROD_KEY));
    });
  });

  it("still prints the other metrics when one fails, exits 1, and masks the key", async () => {
    await withKeysFile(keys, async (file) => {
      const fetch = fakeFetch({
        fail: { metrics_signups: { status: 403, body: { message: `denied ${PROD_KEY}` } } },
      });
      for (const json of [false, true]) {
        const r = await runMain(
          ["--project", "prod", "--keys-txt", file, ...(json ? ["--json"] : [])],
          { fetch },
        );
        assert.equal(r.code, 1);
        assert.match(r.err, /1 metric\(s\) failed: signups/);
        assert.match(r.out, /HTTP 403/);
        assert.match(r.out, json ? /"platformLimits"/ : /Supabase Free plan limits/);
        assert.ok(!r.out.includes(PROD_KEY) && !r.err.includes(PROD_KEY));
      }
    });
  });

  it("refuses an unattended session before reading the keys file", async () => {
    let read = false;
    const r = await runMain(["--project", "prod"], {
      env: { DRAFTO_UNATTENDED: "1" },
      readFile: () => {
        read = true;
        return keys;
      },
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /refused: DRAFTO_UNATTENDED is set/);
    assert.equal(read, false);
    assert.equal(r.calls.length, 0);
    assert.equal(r.out, "");
  });

  it("names a missing keys file or a missing tag line, never a key", async () => {
    const missing = await runMain(["--project", "prod", "--keys-txt", "/nonexistent/keys.txt"]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /\/nonexistent\/keys\.txt is missing/);
    await withKeysFile(`DEV: ${DEV_KEY}\n`, async (file) => {
      const r = await runMain(["--project", "prod", "--keys-txt", file]);
      assert.equal(r.code, 1);
      assert.ok(r.err.includes(`no PROD: line in ${file}`), r.err);
      assert.ok(!r.err.includes(DEV_KEY));
      assert.equal(r.calls.length, 0);
    });
  });

  it("prints usage for --help (exit 0) and for bad arguments (exit 2)", async () => {
    const help = await runMain(["--help"]);
    assert.equal(help.code, 0);
    assert.equal(help.out, `${USAGE}\n`);
    const bad = await runMain(["--project", "prod", "--weeks", "0"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /^users:stats: --weeks must be/);
    assert.ok(bad.err.includes(USAGE));
    assert.equal(bad.calls.length, 0);
  });
});

describe("pnpm users:stats", () => {
  it("is the root package's script for this file", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(pkg.scripts["users:stats"], "node scripts/user-stats.mjs");
  });
});
