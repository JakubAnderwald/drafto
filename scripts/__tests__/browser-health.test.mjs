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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALERT_THRESHOLD,
  decideBrowser,
  describeReason,
  emailContent,
  isKnownResult,
  performBrowserActions,
  preflight,
  undoFailedAlert,
} from "../lib/browser-health.mjs";
import { emptyBrowser, emptyFactoryState, resetBrowser } from "../lib/factory-state.mjs";

// Guards the browser runner's soft health check: two bad results in a row
// send one email, a good run sends one recovery email, nothing ever pauses the
// factory, and a guard that failed to load latches the browser off until the
// operator resets it.

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "lib", "browser-health.mjs");
const stateCli = resolve(here, "..", "lib", "state-cli.mjs");

const T0 = "2026-10-17T10:00:00.000Z";
const T1 = "2026-10-17T10:05:00.000Z";
const T2 = "2026-10-17T10:10:00.000Z";
const T3 = "2026-10-17T10:15:00.000Z";

// Feed results through decideBrowser, treating every email as sent.
function feed(results, start = emptyBrowser()) {
  let state = start;
  const emails = [];
  results.forEach((result, i) => {
    const { next, actions } = decideBrowser(state, result, {
      now: new Date(Date.parse(T0) + i * 300_000).toISOString(),
    });
    emails.push(actions.map((a) => a.kind));
    state = next;
  });
  return { state, emails };
}

describe("decideBrowser", () => {
  it("a good run on a clean record sends nothing and stamps the result", () => {
    const { next, actions } = decideBrowser(emptyBrowser(), "ok", { now: T0 });
    assert.deepEqual(actions, []);
    assert.equal(next.lastResult, "ok");
    assert.equal(next.lastResultAt, T0);
    assert.equal(next.consecutiveBad, 0);
  });

  it(`two bad results send one degraded email; a third sends none (threshold ${ALERT_THRESHOLD})`, () => {
    const { state, emails } = feed(["unavailable", "auth-expired", "unavailable"]);
    assert.deepEqual(emails, [[], ["degraded"], []]);
    assert.equal(state.consecutiveBad, 3);
    assert.equal(state.unavailableSince, T0, "the streak's first bad result");
    assert.equal(state.reason, "unavailable", "the latest bad result");
    assert.equal(state.alertedAt, T1);
    assert.equal(state.disabled, false);
  });

  it("a single bad result followed by a good one stays silent", () => {
    const { state, emails } = feed(["unavailable", "ok"]);
    assert.deepEqual(emails, [[], []]);
    assert.equal(state.consecutiveBad, 0);
    assert.equal(state.unavailableSince, null);
  });

  it("a good run after an alert sends one recovered email and clears the streak", () => {
    const { state, emails } = feed(["unavailable", "unavailable", "ok", "ok"]);
    assert.deepEqual(emails, [[], ["degraded"], ["recovered"], []]);
    assert.deepEqual(
      { ...state, lastResult: null, lastResultAt: null },
      emptyBrowser(),
      "back to a clean record",
    );
  });

  it("blocked is a completed run: it clears the streak like ok", () => {
    assert.deepEqual(feed(["unavailable", "blocked", "unavailable"]).emails, [[], [], []]);
    assert.deepEqual(feed(["unavailable", "unavailable", "blocked"]).emails, [
      [],
      ["degraded"],
      ["recovered"],
    ]);
  });

  it("timeout, error, malformed and preflight:<reason> all count as bad", () => {
    for (const bad of [
      "timeout",
      "error",
      "malformed",
      "preflight:chrome-not-running",
      "preflight:account-mode",
    ]) {
      const { state, emails } = feed([bad, bad]);
      assert.deepEqual(emails, [[], ["degraded"]], bad);
      assert.equal(state.reason, bad);
    }
    assert.deepEqual(
      feed(["timeout", "error"]).emails,
      [[], ["degraded"]],
      "mixed reasons still a streak",
    );
  });

  it("guard-not-loaded latches disabled and emails once, immediately", () => {
    const { state, emails } = feed(["guard-not-loaded", "guard-not-loaded"]);
    assert.deepEqual(emails, [["disabled"], []]);
    assert.equal(state.disabled, true);
    assert.equal(state.disabledReason, "guard-not-loaded");
  });

  it("a good run never clears disabled, and sends no recovered email while latched", () => {
    const { state, emails } = feed(["guard-not-loaded", "ok", "blocked"]);
    assert.deepEqual(emails, [["disabled"], [], []]);
    assert.equal(state.disabled, true);
    assert.equal(state.disabledReason, "guard-not-loaded");
  });

  it("bad results while disabled don't build a streak or send a degraded email", () => {
    const { state, emails } = feed([
      "guard-not-loaded",
      "preflight:disabled:guard-not-loaded",
      "unavailable",
    ]);
    assert.deepEqual(emails, [["disabled"], [], []]);
    assert.equal(state.consecutiveBad, 0);
  });

  it("guard-not-loaded after a degraded alert still sends the disabled email", () => {
    assert.deepEqual(feed(["unavailable", "unavailable", "guard-not-loaded"]).emails, [
      [],
      ["degraded"],
      ["disabled"],
    ]);
  });

  it("factory:browser-reset (resetBrowser) clears the latch; the next good run is silent", () => {
    const { state } = feed(["guard-not-loaded"]);
    const s = { ...emptyFactoryState(), browser: state };
    resetBrowser(s);
    assert.deepEqual(s.browser, emptyBrowser());
    const { next, actions } = decideBrowser(s.browser, "ok", { now: T1 });
    assert.deepEqual(actions, []);
    assert.equal(next.disabled, false);
  });

  it("never mutates the record it is given", () => {
    const prev = {
      ...emptyBrowser(),
      consecutiveBad: 1,
      unavailableSince: T0,
      reason: "unavailable",
    };
    const frozen = structuredClone(prev);
    decideBrowser(prev, "unavailable", { now: T1 });
    decideBrowser(prev, "guard-not-loaded", { now: T1 });
    assert.deepEqual(prev, frozen);
  });

  it("isKnownResult accepts the documented results only", () => {
    for (const r of [
      "ok",
      "blocked",
      "unavailable",
      "auth-expired",
      "malformed",
      "timeout",
      "error",
      "guard-not-loaded",
      "preflight:chrome-not-running",
      "preflight:disabled:guard-not-loaded",
    ]) {
      assert.equal(isKnownResult(r), true, r);
    }
    for (const r of ["", undefined, "OK", "preflight:", "preflight:Bad Reason", "fine"]) {
      assert.equal(isKnownResult(r), false, String(r));
    }
  });
});

describe("failed emails are retried", () => {
  const sendOk = () => ({ status: 0, stdout: "", stderr: "" });
  const sendFail = () => ({ status: 1, stdout: "", stderr: "zoho 500" });
  const opts = { to: "op@example.com", zohoCli: "/z.mjs", accountFile: "/acct.env" };

  function step(prev, result, now, spawn) {
    const { next, actions } = decideBrowser(prev, result, { now });
    const results = performBrowserActions(actions, { prev, next, now, spawn, ...opts });
    return { next, results };
  }

  it("a failed degraded email leaves alertedAt unset, and the next bad result re-sends it", () => {
    let s = step(emptyBrowser(), "unavailable", T0, sendOk).next;
    let r = step(s, "unavailable", T1, sendFail);
    assert.deepEqual(
      r.results.map((x) => [x.kind, x.ok]),
      [["degraded", false]],
    );
    assert.equal(r.results[0].error, "zoho 500");
    assert.equal(r.next.alertedAt, null);
    r = step(r.next, "unavailable", T2, sendOk);
    assert.deepEqual(
      r.results.map((x) => [x.kind, x.ok]),
      [["degraded", true]],
    );
    assert.equal(r.next.alertedAt, T2);
  });

  it("a failed disabled email is retried on the next record, the latch stays on", () => {
    let r = step(emptyBrowser(), "guard-not-loaded", T0, sendFail);
    assert.equal(r.next.disabled, true);
    assert.equal(r.next.alertedAt, null);
    r = step(r.next, "preflight:disabled:guard-not-loaded", T1, sendOk);
    assert.deepEqual(
      r.results.map((x) => [x.kind, x.ok]),
      [["disabled", true]],
    );
    assert.equal(r.next.alertedAt, T1);
  });

  it("a failed recovered email keeps the alert, so the next good run re-sends it", () => {
    let s = step(emptyBrowser(), "unavailable", T0, sendOk).next;
    s = step(s, "unavailable", T1, sendOk).next;
    let r = step(s, "ok", T2, sendFail);
    assert.equal(r.next.alertedAt, T1);
    assert.equal(r.next.consecutiveBad, 0);
    r = step(r.next, "ok", T3, sendOk);
    assert.deepEqual(
      r.results.map((x) => [x.kind, x.ok]),
      [["recovered", true]],
    );
    assert.equal(r.next.alertedAt, null);
  });

  it("an email that throws is a failed email, never an exception", () => {
    const boom = () => {
      throw new Error("spawn exploded");
    };
    const prev = { ...emptyBrowser(), consecutiveBad: 1, unavailableSince: T0, reason: "timeout" };
    const r = step(prev, "timeout", T1, boom);
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].error, /spawn exploded/);
    assert.equal(r.next.alertedAt, null);
  });

  it("undoFailedAlert: outage alerts reset to null, recovery keeps the previous alert", () => {
    const prev = { ...emptyBrowser(), alertedAt: T0 };
    assert.equal(undoFailedAlert({ alertedAt: T1 }, { kind: "degraded" }, prev).alertedAt, null);
    assert.equal(undoFailedAlert({ alertedAt: T1 }, { kind: "disabled" }, prev).alertedAt, null);
    assert.equal(undoFailedAlert({ alertedAt: null }, { kind: "recovered" }, prev).alertedAt, T0);
  });
});

describe("emailContent", () => {
  const bad = (reason) => ({
    ...emptyBrowser(),
    consecutiveBad: 2,
    unavailableSince: T0,
    reason,
    lastResult: reason,
    lastResultAt: T1,
    alertedAt: T1,
  });
  const opts = { accountFile: "/Users/x/.config/drafto-factory/browser-account.env", now: T2 };
  const localDate = (() => {
    const d = new Date(T1);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();

  it("gives a concrete fix for each reason", () => {
    const cases = {
      "preflight:chrome-not-running": /open Chrome on the Mac mini/,
      "preflight:account-missing":
        /create \/Users\/x\/\.config\/drafto-factory\/browser-account\.env \(mode 600\) with FACTORY_BROWSER_EMAIL/,
      "preflight:account-mode":
        /chmod 600 \/Users\/x\/\.config\/drafto-factory\/browser-account\.env/,
      "preflight:account-keys": /FACTORY_BROWSER_PASSWORD/,
      unavailable: /Claude in Chrome extension isn't connected — sign it back in/,
      "auth-expired": /open a Vercel preview in Chrome on the Mac mini and sign in to Vercel/,
      timeout: new RegExp(
        `timed out twice in a row; see logs/factory/factory-agent-watch-${localDate}\\.log`,
      ),
      error: new RegExp(
        `exited with an error twice in a row; see logs/factory/factory-agent-watch-${localDate}\\.log`,
      ),
      malformed: /without its status line/,
    };
    for (const [reason, re] of Object.entries(cases)) {
      const { subject, body } = emailContent("degraded", bad(reason), opts);
      assert.match(subject, /^\[drafto factory\] browser checks failing: /, reason);
      assert.match(body, re, reason);
      assert.match(body, /Nothing else is affected/, reason);
      assert.match(body, /factory:browser-status/, reason);
    }
  });

  it("names the reset command in the disabled email", () => {
    const s = {
      ...emptyBrowser(),
      disabled: true,
      disabledReason: "guard-not-loaded",
      lastResultAt: T1,
    };
    const { subject, body } = emailContent("disabled", s, opts);
    assert.match(subject, /DISABLED: guard settings didn't load/);
    assert.match(
      body,
      /the guard settings didn't load; the browser is off until `node scripts\/lib\/state-cli\.mjs factory:browser-reset`/,
    );
  });

  it("reports what was wrong in the recovered email", () => {
    const { subject, body } = emailContent("recovered", bad("auth-expired"), opts);
    assert.equal(subject, "[drafto factory] browser checks recovered");
    assert.match(
      body,
      /failing since 2026-10-17T10:00:00\.000Z; the last problem was: Vercel login expired/,
    );
  });

  it("describeReason has a fallback for an unknown preflight reason", () => {
    assert.match(
      describeReason("preflight:pgrep-broken").fix,
      /pre-run check failed \(pgrep-broken\)/,
    );
  });
});

describe("preflight", () => {
  let dir;
  let account;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "browser-preflight-"));
    account = join(dir, "account.env");
    writeFileSync(account, "FACTORY_BROWSER_EMAIL=a@b.c\nFACTORY_BROWSER_PASSWORD=hunter22\n");
    chmodSync(account, 0o600);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is null when Chrome runs and the account file is sound", () => {
    assert.equal(preflight({ accountFile: account, isChromeRunning: () => true }), null);
  });

  it("checks Chrome first", () => {
    assert.equal(
      preflight({ accountFile: join(dir, "nope"), isChromeRunning: () => false }),
      "chrome-not-running",
    );
  });

  it("names the account file's problem", () => {
    chmodSync(account, 0o644);
    assert.equal(preflight({ accountFile: account, isChromeRunning: () => true }), "account-mode");
    assert.equal(
      preflight({ accountFile: join(dir, "nope"), isChromeRunning: () => true }),
      "account-missing",
    );
  });
});

describe("browser-health CLI end to end (stub zoho-cli, PATH-stubbed pgrep)", () => {
  let dir;
  let bin;
  let calls;
  let stateFile;
  let zoho;
  let account;

  function run(args, env = {}) {
    return spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
  }

  function record(result, now, extra = []) {
    return run([
      "record",
      "--state-file",
      stateFile,
      "--result",
      result,
      "--to",
      "op@example.com",
      "--zoho-cli",
      zoho,
      "--account-file",
      account,
      "--now",
      now,
      ...extra,
    ]);
  }

  function preflightRun() {
    return run(["preflight", "--state-file", stateFile, "--account-file", account]);
  }

  function sent() {
    return existsSync(calls)
      ? readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  }

  function browser() {
    return JSON.parse(readFileSync(stateFile, "utf8")).browser;
  }

  function stubPgrep(code) {
    const p = join(bin, "pgrep");
    writeFileSync(p, `#!/bin/bash\n[[ "$1 $2" == "-x Google Chrome" ]] || exit 9\nexit ${code}\n`);
    chmodSync(p, 0o755);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "browser-health-cli-"));
    bin = join(dir, "bin");
    mkdirSync(bin);
    calls = join(dir, "calls.log");
    stateFile = join(dir, "factory-state.json");
    zoho = join(dir, "zoho-stub.mjs");
    account = join(dir, "account.env");
    writeFileSync(account, "FACTORY_BROWSER_EMAIL=a@b.c\nFACTORY_BROWSER_PASSWORD=hunter22\n");
    chmodSync(account, 0o600);
    // Logs argv and the body, like the real `zoho-cli.mjs send` would send them.
    writeFileSync(
      zoho,
      `import { appendFileSync, readFileSync } from "node:fs";\n` +
        `const a = process.argv.slice(2);\n` +
        `const body = readFileSync(a[a.indexOf("--body-file") + 1], "utf8");\n` +
        `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: a, body }) + "\\n");\n`,
    );
    stubPgrep(0);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("two bad results → one email, a third → none, then a good run → one recovery email", () => {
    let r = record("unavailable", T0);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).actions, []);
    assert.equal(sent().length, 0);

    r = record("unavailable", T1);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).actions, [{ type: "email", kind: "degraded", ok: true }]);
    const [mail] = sent();
    assert.deepEqual(mail.args.slice(0, 5), [
      "send",
      "--to",
      "op@example.com",
      "--subject",
      "[drafto factory] browser checks failing: Claude in Chrome not connected",
    ]);
    assert.match(mail.body, /sign it back in/);

    record("auth-expired", T2);
    assert.equal(sent().length, 1, "third bad result adds no email");
    assert.equal(browser().consecutiveBad, 3);
    assert.equal(browser().reason, "auth-expired");

    r = record("ok", T3);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sent().length, 2);
    assert.equal(sent()[1].args[4], "[drafto factory] browser checks recovered");
    assert.equal(browser().consecutiveBad, 0);
    assert.equal(browser().alertedAt, null);
  });

  it("a failed email still exits 0, leaves alertedAt unset, and is retried", () => {
    const real = readFileSync(zoho, "utf8");
    writeFileSync(zoho, real + "process.exit(1);\n");
    record("timeout", T0);
    const r = record("timeout", T1);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).actions[0].ok, false);
    assert.equal(browser().alertedAt, null);

    writeFileSync(zoho, real);
    record("timeout", T2);
    assert.equal(browser().alertedAt, T2);
    const subjects = sent().map((m) => m.args[4]);
    assert.deepEqual(subjects, [
      "[drafto factory] browser checks failing: runner timed out",
      "[drafto factory] browser checks failing: runner timed out",
    ]);
  });

  it("an unreachable zoho-cli is an email failure, not a crash", () => {
    record("error", T0);
    const r = record("error", T1, ["--zoho-cli", join(dir, "missing-zoho.mjs")]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).actions[0].ok, false);
    assert.equal(browser().alertedAt, null);
  });

  it("guard-not-loaded: disabled + one email; preflight refuses until factory:browser-reset", () => {
    let r = record("guard-not-loaded", T0);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sent().length, 1);
    assert.match(sent()[0].args[4], /DISABLED/);
    assert.equal(browser().disabled, true);

    r = preflightRun();
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "disabled:guard-not-loaded\n");

    record("ok", T1);
    assert.equal(browser().disabled, true, "a good run never clears the latch");
    assert.equal(sent().length, 1, "and sends no recovered email");

    r = spawnSync(
      process.execPath,
      [stateCli, "factory:browser-reset", "--state-file", stateFile],
      {
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(browser(), emptyBrowser());

    r = preflightRun();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "ok\n");
  });

  it("preflight reports Chrome not running and a loose account file", () => {
    stubPgrep(1);
    let r = preflightRun();
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "chrome-not-running\n");

    stubPgrep(0);
    chmodSync(account, 0o644);
    r = preflightRun();
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "account-mode\n");
    assert.ok(!existsSync(stateFile), "preflight never writes state");
  });

  it("record keeps the rest of the factory state intact", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ issues: { 42: { attempts: 2 } }, futureKey: { a: 1 } }),
    );
    record("unavailable", T0);
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(s.issues["42"].attempts, 2);
    assert.deepEqual(s.futureKey, { a: 1 });
    assert.equal(s.browser.consecutiveBad, 1);
  });

  it("rejects an unknown --result with exit 2 and writes nothing", () => {
    const r = record("sideways", T0);
    assert.equal(r.status, 2);
    assert.match(JSON.parse(r.stderr).error, /invalid --result/);
    assert.ok(!existsSync(stateFile));
    assert.equal(run(["bogus"]).status, 2);
  });
});
