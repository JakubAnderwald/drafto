// The hosting-usage readout's parser and poster (ADR-0093): the runner prints
// dashboard strings, and this turns them into the route's readout.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIELDS,
  buildReadout,
  failureEmail,
  main,
  parseCount,
  parseDashboardNumber,
  parseGigabytes,
  parseHours,
  parsePeriod,
  postReadout,
  readSecret,
  run,
} from "../lib/usage-readout.mjs";

const NOW = new Date("2026-11-22T19:00:00.000Z");
const SECRET = "s".repeat(40);

const USAGE = {
  vercel: {
    period: "Oct 23, 10:00 - Nov 22, 10:00",
    fastDataTransfer: "1,42 GB",
    cdnRequests: "195K",
    functionInvocations: "122K",
    activeCpu: "2h 17m",
  },
  supabase: {
    period: "Nov 1 - Nov 30, 2026",
    egress: "365.52 MB",
    cachedEgress: "0 B",
    logIngestion: "1.02 GB",
  },
};

const output = (usage = USAGE, status = "browser=ok") =>
  `Read both pages.\n<<<USAGE\n${JSON.stringify(usage, null, 2)}\nUSAGE>>>\n${status}\n`;

describe("usage-readout: number parsing", () => {
  test("reads both decimal marks and thousands grouping", () => {
    assert.equal(parseDashboardNumber("1.42"), 1.42);
    assert.equal(parseDashboardNumber("1,42"), 1.42);
    assert.equal(parseDashboardNumber("6,46"), 6.46);
    assert.equal(parseDashboardNumber("1,234"), 1234);
    assert.equal(parseDashboardNumber("1.234"), 1234);
    assert.equal(parseDashboardNumber("1,234,567"), 1234567);
    assert.equal(parseDashboardNumber("1.234,5"), 1234.5);
    assert.equal(parseDashboardNumber("1,234.5"), 1234.5);
    assert.equal(parseDashboardNumber("1 234"), 1234);
    assert.equal(parseDashboardNumber("12"), 12);
    // A leading 0 or a 4-digit integer part can't be a thousands group.
    assert.equal(parseDashboardNumber("0.123"), 0.123);
    assert.equal(parseDashboardNumber("1234.567"), 1234.567);
    // Without grouping (byte amounts, suffixed counts) a lone separator is decimal.
    assert.equal(parseDashboardNumber("1.234", { grouping: false }), 1.234);
    assert.equal(parseDashboardNumber("1,234", { grouping: false }), 1.234);
    assert.equal(parseDashboardNumber("1,23,4"), null);
    for (const bad of ["", "abc", "-1", "1.2.3,4.5", "1e3", null]) {
      assert.equal(parseDashboardNumber(bad), null, String(bad));
    }
  });

  test("reads data amounts in decimal gigabytes", () => {
    assert.equal(parseGigabytes("1.42 GB"), 1.42);
    assert.equal(parseGigabytes("1,42 GB"), 1.42);
    assert.equal(parseGigabytes("365.52 MB"), 0.36552);
    assert.equal(parseGigabytes("2 TB"), 2000);
    assert.equal(parseGigabytes("0 B"), 0);
    assert.equal(parseGigabytes("12 KB"), 0.000012);
    assert.equal(parseGigabytes("0.123 GB"), 0.123);
    assert.equal(parseGigabytes("365.520 MB"), 0.36552);
    assert.equal(parseGigabytes("1,420 GB"), 1.42);
    assert.equal(parseGigabytes("1.42"), null);
    assert.equal(parseGigabytes("1.42 GB / 100 GB"), null);
    // Log ingestion as the Supabase page shows it: "Used in period" in either decimal
    // mark, and the summary row ("used / limit"), which must not parse.
    assert.equal(parseGigabytes("1.02 GB"), 1.02);
    assert.equal(parseGigabytes("1,02 GB"), 1.02);
    assert.equal(parseGigabytes("1,019 GB"), 1.019);
    assert.equal(parseGigabytes("1,019 / 1 GB"), null);
  });

  test("reads counts with K / M suffixes", () => {
    assert.equal(parseCount("195K"), 195000);
    assert.equal(parseCount("1.2M"), 1200000);
    assert.equal(parseCount("1,2M"), 1200000);
    assert.equal(parseCount("122,034"), 122034);
    assert.equal(parseCount("6"), 6);
    assert.equal(parseCount("1.234K"), 1234);
    assert.equal(parseCount("0,5K"), 500);
    assert.equal(parseCount("lots"), null);
  });

  test("reads durations as hours", () => {
    assert.equal(parseHours("2h 17m"), 2.2833);
    assert.equal(parseHours("1m 55s"), 0.0319);
    assert.equal(parseHours("4h"), 4);
    assert.equal(parseHours("2.5h"), 2.5);
    assert.equal(parseHours("45s"), 0.0125);
    assert.equal(parseHours("2 hours"), null);
    assert.equal(parseHours(""), null);
  });

  test("reads the usage period, inferring a missing year", () => {
    assert.deepEqual(parsePeriod("Oct 23, 10:00 - Nov 22, 10:00", NOW), {
      from: "2026-10-23",
      to: "2026-11-22",
    });
    assert.deepEqual(parsePeriod("Nov 1 - Nov 30, 2026", NOW), {
      from: "2026-11-01",
      to: "2026-11-30",
    });
    assert.deepEqual(parsePeriod("Dec 23 - Jan 22", new Date("2027-01-23T00:00:00Z")), {
      from: "2026-12-23",
      to: "2027-01-22",
    });
    // A billing cycle that ends in the future, and day-first dates.
    const nov21 = new Date("2026-11-21T12:00:00Z");
    assert.deepEqual(parsePeriod("Nov 15 - Dec 15", nov21), {
      from: "2026-11-15",
      to: "2026-12-15",
    });
    assert.deepEqual(parsePeriod("Nov 1 - Nov 30", nov21), {
      from: "2026-11-01",
      to: "2026-11-30",
    });
    assert.deepEqual(parsePeriod("21 Oct - 21 Nov", nov21), {
      from: "2026-10-21",
      to: "2026-11-21",
    });
    assert.deepEqual(parsePeriod("Dec 23 - Jan 22, 2027", new Date("2027-01-23Z")), {
      from: "2026-12-23",
      to: "2027-01-22",
    });
    assert.equal(parsePeriod("Last 30 days", NOW), null);
    assert.equal(parsePeriod("Feb 30 - Mar 2", NOW), null);
  });
});

describe("usage-readout: buildReadout", () => {
  test("turns a full report into seven readings with periods", () => {
    const r = buildReadout(output(), { now: NOW });
    assert.equal(r.problem, null);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.readings, [
      {
        resource: "vercel_fast_data_transfer",
        used: 1.42,
        periodFrom: "2026-10-23",
        periodTo: "2026-11-22",
      },
      {
        resource: "vercel_cdn_requests",
        used: 195000,
        periodFrom: "2026-10-23",
        periodTo: "2026-11-22",
      },
      {
        resource: "vercel_function_invocations",
        used: 122000,
        periodFrom: "2026-10-23",
        periodTo: "2026-11-22",
      },
      {
        resource: "vercel_active_cpu",
        used: 2.2833,
        periodFrom: "2026-10-23",
        periodTo: "2026-11-22",
      },
      {
        resource: "supabase_egress",
        used: 0.36552,
        periodFrom: "2026-11-01",
        periodTo: "2026-11-30",
      },
      {
        resource: "supabase_cached_egress",
        used: 0,
        periodFrom: "2026-11-01",
        periodTo: "2026-11-30",
      },
      {
        resource: "supabase_log_ingestion",
        used: 1.02,
        periodFrom: "2026-11-01",
        periodTo: "2026-11-30",
      },
    ]);
    assert.equal(FIELDS.length, 7);
  });

  test("keeps what it could read and names the rest", () => {
    const usage = structuredClone(USAGE);
    usage.vercel.activeCpu = "—";
    delete usage.supabase;
    const r = buildReadout(output(usage), { now: NOW });
    assert.equal(r.problem, null);
    assert.deepEqual(r.missing, [
      "vercel_active_cpu",
      "supabase_egress",
      "supabase_cached_egress",
      "supabase_log_ingestion",
    ]);
    assert.equal(r.readings.length, 3);
  });

  test("posts what a run that stopped part-way read, and nothing from a blocked one", () => {
    const vercelOnly = { vercel: USAGE.vercel };
    const stopped = buildReadout(output(vercelOnly, "browser=auth-expired"), { now: NOW });
    assert.equal(stopped.problem, null);
    assert.equal(stopped.status, "auth-expired");
    assert.equal(stopped.readings.length, 4);
    assert.deepEqual(stopped.missing, [
      "supabase_egress",
      "supabase_cached_egress",
      "supabase_log_ingestion",
    ]);
    assert.equal(buildReadout(output({}, "browser=unavailable")).problem, "browser=unavailable");
    assert.equal(buildReadout(output(USAGE, "browser=blocked")).problem, "browser=blocked");
    assert.equal(buildReadout(output(USAGE, "browser=blocked")).readings.length, 0);
  });

  test("expects only the configured providers, and drops implausible figures", () => {
    const vercelOnly = buildReadout(output({ vercel: USAGE.vercel }), {
      now: NOW,
      providers: ["vercel"],
    });
    assert.deepEqual(vercelOnly.missing, []);
    assert.equal(vercelOnly.readings.length, 4);
    const usage = structuredClone(USAGE);
    usage.vercel.cdnRequests = "20B";
    const huge = buildReadout(output(usage), { now: NOW });
    assert.ok(huge.missing.includes("vercel_cdn_requests"));
    assert.equal(huge.readings.length, 6);
  });

  test("posts nothing when the block is missing, or nothing parsed", () => {
    assert.equal(buildReadout("no block\nbrowser=ok\n").problem, "no readable USAGE block");
    assert.equal(buildReadout("<<<USAGE\n{}\nUSAGE>>>\n").problem, "browser=malformed");
    assert.equal(buildReadout(output({ vercel: {} })).problem, "no figure could be read");
  });

  test("a status line inside the block doesn't count", () => {
    const text = "<<<USAGE\nbrowser=ok\nUSAGE>>>\n";
    assert.equal(buildReadout(text).status, "malformed");
  });

  test("refuses output that looks like it carries a secret", () => {
    const leaked = output() + "Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n";
    const r = buildReadout(leaked);
    assert.match(r.problem, /^secret-like text \(bearer\)/);
    assert.deepEqual(r.readings, []);
  });
});

describe("usage-readout: secret file and posting", () => {
  test("reads the secret only from a mode-600 file, never quoting it", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-secret-"));
    try {
      const f = join(dir, "hosted-usage.env");
      writeFileSync(f, `export HOSTED_USAGE_SECRET=${SECRET}\n`);
      chmodSync(f, 0o644);
      assert.throws(() => readSecret(f), /must be mode 600/);
      chmodSync(f, 0o600);
      assert.equal(readSecret(f), SECRET);
      writeFileSync(f, "HOSTED_USAGE_SECRET=short\n");
      assert.throws(
        () => readSecret(f),
        (err) => /too short/.test(err.message) && !err.message.includes("short\n"),
      );
      assert.throws(() => readSecret(join(dir, "nope")), /is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("posts the readings with the bearer secret, and redacts it from errors", async () => {
    const calls = [];
    const ok = await postReadout({
      url: "https://drafto.eu/api/cron/hosted-usage",
      secret: SECRET,
      readings: [{ resource: "vercel_active_cpu", used: 2 }],
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 201, text: async () => "" };
      },
    });
    assert.deepEqual(ok, { ok: true, status: 201, error: null });
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      readings: [{ resource: "vercel_active_cpu", used: 2 }],
    });

    const bad = await postReadout({
      url: "https://drafto.eu/api/cron/hosted-usage",
      secret: SECRET,
      readings: [],
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => `nope ${SECRET}` }),
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "HTTP 401 nope [redacted]");

    const thrown = await postReadout({
      url: "https://drafto.eu/api/cron/hosted-usage",
      secret: SECRET,
      readings: [],
      fetchImpl: async () => {
        throw new Error(`connect failed for Bearer ${SECRET}`);
      },
    });
    assert.equal(thrown.error, "connect failed for Bearer [redacted]");
  });
});

describe("usage-readout: run", () => {
  function setup(text) {
    const dir = mkdtempSync(join(tmpdir(), "usage-run-"));
    const input = join(dir, "runner-output.txt");
    if (text !== undefined) writeFileSync(input, text);
    const secretFile = join(dir, "hosted-usage.env");
    writeFileSync(secretFile, `HOSTED_USAGE_SECRET=${SECRET}\n`, { mode: 0o600 });
    const emails = [];
    const spawn = (_cmd, args) => {
      emails.push(args[args.indexOf("--subject") + 1]);
      return { status: 0, stdout: "", stderr: "" };
    };
    const posts = [];
    const fetchImpl = async (_url, init) => {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 201, text: async () => "" };
    };
    const base = {
      input,
      runnerResult: "ran",
      url: "https://drafto.eu/api/cron/hosted-usage",
      secretFile,
      to: "operator@example.com",
      zohoCli: "/x/zoho-cli.mjs",
      now: NOW,
    };
    return { dir, base, emails, posts, deps: { spawn, fetchImpl } };
  }

  test("posts a full readout and emails nobody", async () => {
    const t = setup(output());
    try {
      const r = await run(t.base, t.deps);
      assert.equal(r.posted, true);
      assert.equal(r.resources.length, 7);
      assert.equal(t.posts[0].readings.length, 7);
      assert.deepEqual(t.emails, []);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("posts a partial readout and emails that it's incomplete", async () => {
    const usage = structuredClone(USAGE);
    delete usage.supabase;
    const t = setup(output(usage));
    try {
      const r = await run(t.base, t.deps);
      assert.equal(r.posted, true);
      assert.deepEqual(r.missing, [
        "supabase_egress",
        "supabase_cached_egress",
        "supabase_log_ingestion",
      ]);
      assert.equal(t.emails.length, 1);
      assert.match(t.emails[0], /readout incomplete/);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("posts a stopped run's partial readout, and emails why", async () => {
    const t = setup(output({ vercel: USAGE.vercel }, "browser=auth-expired"));
    try {
      const r = await run(t.base, t.deps);
      assert.equal(r.posted, true);
      assert.equal(t.posts[0].readings.length, 4);
      assert.equal(t.emails.length, 1);
      assert.match(t.emails[0], /readout incomplete \(browser=auth-expired\)/);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a Vercel-only setup emails nobody about Supabase", async () => {
    const t = setup(output({ vercel: USAGE.vercel }));
    try {
      const r = await run({ ...t.base, providers: ["vercel"] }, t.deps);
      assert.equal(r.posted, true);
      assert.deepEqual(r.missing, []);
      assert.deepEqual(t.emails, []);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("emails, and posts nothing, when the runner failed or stopped", async () => {
    for (const [runnerResult, text, reason] of [
      ["timeout", output(), /runner timeout/],
      ["preflight:disabled:guard-not-loaded", undefined, /runner preflight:disabled/],
      ["ran", output({}, "browser=auth-expired"), /browser=auth-expired/],
      ["ran", undefined, /no runner output/],
    ]) {
      const t = setup(text);
      try {
        const r = await run({ ...t.base, runnerResult }, t.deps);
        assert.equal(r.posted, false);
        assert.match(r.reason, reason);
        assert.equal(t.posts.length, 0);
        assert.equal(t.emails.length, 1);
        assert.match(t.emails[0], /readout failed/);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    }
  });

  test("emails when the post fails", async () => {
    const t = setup(output());
    try {
      const r = await run(t.base, {
        ...t.deps,
        fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
      });
      assert.equal(r.posted, false);
      assert.match(r.reason, /post failed: HTTP 500 boom/);
      assert.match(t.emails[0], /readout failed \(post failed/);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a dry run parses but neither posts nor emails", async () => {
    const t = setup(output());
    try {
      const r = await run({ ...t.base, dryRun: true }, t.deps);
      assert.equal(r.dryRun, true);
      assert.equal(r.readings.length, 7);
      assert.equal(t.posts.length, 0);
      assert.equal(t.emails.length, 0);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("the failure email names the cause and the fix, never a secret", () => {
    const { subject, body } = failureEmail("browser=auth-expired");
    assert.match(subject, /weekly usage readout failed/);
    assert.match(body, /signed out of\s+vercel\.com or supabase\.com/);
    assert.doesNotMatch(body, /Bearer|HOSTED_USAGE_SECRET=/);
  });

  test("the CLI prints a summary line and exits by outcome", async () => {
    const t = setup(output());
    try {
      let out = "";
      const code = await main(
        [
          "run",
          "--in",
          t.base.input,
          "--runner-result",
          "ran",
          "--secret-file",
          t.base.secretFile,
          "--to",
          "operator@example.com",
          "--now",
          NOW.toISOString(),
        ],
        { stdout: { write: (s) => (out += s) }, stderr: { write() {} }, deps: t.deps },
      );
      assert.equal(code, 0);
      assert.equal(JSON.parse(out).posted, true);
      const usage = await main(["nope"], { stdout: { write() {} }, stderr: { write() {} } });
      assert.equal(usage, 2);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
