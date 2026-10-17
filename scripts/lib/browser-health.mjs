#!/usr/bin/env node
// Soft health tracking for the factory's browser runner (Claude in Chrome).
//
// Why this exists: the browser runner depends on things only the operator can
// fix on the Mac mini — Chrome running, the Claude in Chrome extension signed
// in, a live Vercel login in that profile, a dedicated test account in a
// mode-600 file. Each of those breaks quietly: the run just comes back
// `browser=unavailable` or `auth-expired`, and without a record nobody would
// notice web cards reaching In Test unchecked again.
//
// Modelled on toolchain-health.mjs (decide → perform side effects → save), but
// deliberately soft: it never pauses the factory and never touches a card. A
// bad streak only skips browser runs and emails the operator once; a good run
// clears it and sends a recovery email. The one hard stop is the latch: when
// the guard's settings didn't load (no SessionStart record), the run had no
// guard at all, so the browser is `disabled` until the operator runs
// `state-cli.mjs factory:browser-reset` — a later good run never clears it.
// See ADR-0051.
//
// factory-agent.sh calls, around each browser run:
//   preflight — before the run. Skips it (and the card is unaffected) when the
//               browser is disabled, Chrome isn't running or the account file
//               is missing / loose; bash then records `preflight:<reason>`.
//   record    — after the run (or a failed preflight), with the result.
//
// CLI:
//   node browser-health.mjs preflight --state-file <f> --account-file <f>
//     Prints "ok" | "disabled:<reason>" | "chrome-not-running" |
//     "account-<missing|not-a-file|mode|keys>". Exit 0 iff ok. Read-only.
//   node browser-health.mjs record --state-file <f> --result <result>
//        [--to <email>] [--zoho-cli <path>] [--account-file <f>] [--now <iso>]
//     <result> ∈ ok | blocked | unavailable | auth-expired | malformed |
//     timeout | error | guard-not-loaded | preflight:<reason>.
//     Prints one JSON line {actions:[…], browser:{…}}. Exit 0 even when an
//     email fails (its alert is left unrecorded, so the next record retries
//     it); 1 when the state file can't be read or written; 2 on a usage error.

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { accountFileProblem } from "./browser-report.mjs";
import {
  DEFAULT_FACTORY_STATE_PATH,
  emptyBrowser,
  loadFactoryState,
  saveFactoryState,
} from "./factory-state.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { sendEmail } from "./toolchain-health.mjs";

export const ALERT_THRESHOLD = 2;
export const DEFAULT_ACCOUNT_FILE = path.join(
  os.homedir(),
  ".config",
  "drafto-factory",
  "browser-account.env",
);
const DEFAULT_TO = "jakub@anderwald.info";
const DEFAULT_ZOHO_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "zoho-cli.mjs");
const RESET_CMD = "node scripts/lib/state-cli.mjs factory:browser-reset";
const STATUS_CMD = "node scripts/lib/state-cli.mjs factory:browser-status";

// "blocked" is a completed run: the model refused a step on purpose, which
// says nothing bad about Chrome, the extension or the logins.
const GOOD_RESULTS = new Set(["ok", "blocked"]);
const BAD_RESULTS = new Set(["unavailable", "auth-expired", "malformed", "timeout", "error"]);
const PREFLIGHT_RESULT = /^preflight:[a-z0-9][a-z0-9:-]*$/;

export function isKnownResult(result) {
  const r = String(result ?? "");
  return (
    GOOD_RESULTS.has(r) ||
    BAD_RESULTS.has(r) ||
    r === "guard-not-loaded" ||
    PREFLIGHT_RESULT.test(r)
  );
}

// Pure: returns the next record and the emails to send; never mutates
// <browserState>. Alerts are recorded optimistically (alertedAt = now); the
// caller undoes that when the email fails (undoFailedAlert), so it is retried.
export function decideBrowser(browserState, result, { now = new Date().toISOString() } = {}) {
  const prev = { ...emptyBrowser(), ...(browserState ?? {}) };
  const next = { ...prev, lastResult: result, lastResultAt: now };
  const actions = [];
  const good = GOOD_RESULTS.has(result);

  if (result === "guard-not-loaded" && !prev.disabled) {
    next.disabled = true;
    next.disabledReason = "guard-not-loaded";
    // While latched, alertedAt tracks the disabled email alone.
    next.alertedAt = null;
  }

  if (next.disabled) {
    // Browser runs are off by design, so results don't build a streak; the
    // only alert is the disabled email, retried until it is sent.
    if (good) Object.assign(next, { consecutiveBad: 0, unavailableSince: null, reason: null });
    if (!next.alertedAt) {
      next.alertedAt = now;
      actions.push({ type: "email", kind: "disabled" });
    }
    return { next, actions };
  }

  if (good) {
    if (prev.alertedAt) actions.push({ type: "email", kind: "recovered" });
    Object.assign(next, {
      consecutiveBad: 0,
      unavailableSince: null,
      reason: null,
      alertedAt: null,
    });
    return { next, actions };
  }

  next.consecutiveBad = prev.consecutiveBad + 1;
  next.unavailableSince = prev.unavailableSince ?? now;
  next.reason = result;
  if (next.consecutiveBad >= ALERT_THRESHOLD && !prev.alertedAt) {
    next.alertedAt = now;
    actions.push({ type: "email", kind: "degraded" });
  }
  return { next, actions };
}

// A failed email must not count as sent. A failed outage alert (degraded or
// disabled) goes back to "not alerted", so the next record sends it again; a
// failed recovery keeps the old alertedAt, so the next good run re-sends it.
export function undoFailedAlert(next, action, prev) {
  next.alertedAt = action.kind === "recovered" ? (prev?.alertedAt ?? null) : null;
  return next;
}

// ── message bodies ──────────────────────────────────────────────────────────

function localDate(iso) {
  const d = new Date(iso ?? Date.now());
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

// factory-agent.sh names its log by mode and local date; the In Test sweep
// that runs the browser is part of --watch.
function watchLog(iso) {
  return `logs/factory/factory-agent-browser-${localDate(iso)}.log`;
}

function accountFix(problem, accountFile) {
  const create =
    `create ${accountFile} (mode 600) with FACTORY_BROWSER_EMAIL=<email> and ` +
    "FACTORY_BROWSER_PASSWORD=<password> lines for the dedicated dev-Supabase account " +
    "(not the CI E2E user)";
  switch (problem) {
    case "missing":
      return `the browser account file is missing: ${create}.`;
    case "mode":
      return `the browser account file is readable by other users: \`chmod 600 ${accountFile}\`.`;
    case "keys":
      return `the browser account file can't be used (a key is missing or it can't be read): ${create}.`;
    case "not-a-file":
      return `the browser account file isn't a regular file: replace it — ${create}.`;
    default:
      return `the browser account file has a problem (${problem}): ${create}.`;
  }
}

// Short label for the subject line, and the concrete fix for the body.
export function describeReason(reason, { accountFile = DEFAULT_ACCOUNT_FILE, at } = {}) {
  const r = String(reason ?? "");
  const log = watchLog(at);
  if (r === "preflight:chrome-not-running") {
    return {
      label: "Chrome not running",
      fix: "Google Chrome isn't running on the Mac mini: open Chrome on the Mac mini and leave it running.",
    };
  }
  if (r.startsWith("preflight:account-")) {
    const problem = r.slice("preflight:account-".length);
    return { label: `account file ${problem}`, fix: accountFix(problem, accountFile) };
  }
  switch (r) {
    case "unavailable":
      return {
        label: "Claude in Chrome not connected",
        fix: "the Mac mini's Claude in Chrome extension isn't connected — sign it back in (in Chrome on the Mac mini).",
      };
    case "auth-expired":
      return {
        label: "Vercel login expired",
        fix: "open a Vercel preview in Chrome on the Mac mini and sign in to Vercel.",
      };
    case "timeout":
      return {
        label: "runner timed out",
        fix: `the browser runner timed out twice in a row; see ${log}.`,
      };
    case "error":
      return {
        label: "runner error",
        fix: `the browser runner exited with an error twice in a row; see ${log}.`,
      };
    case "malformed":
      return {
        label: "runner output malformed",
        fix:
          "the browser runner finished without its status line; check runner-output.txt in " +
          `the run's evidence dir and ${log}.`,
      };
    case "guard-not-loaded":
      return {
        label: "guard settings didn't load",
        fix: `the guard settings didn't load; the browser is off until \`${RESET_CMD}\`.`,
      };
    default:
      if (r.startsWith("preflight:")) {
        return {
          label: `pre-run check failed (${r.slice("preflight:".length)})`,
          fix: `the pre-run check failed (${r.slice("preflight:".length)}); see ${log}.`,
        };
      }
      return { label: r || "unknown", fix: `the last browser run ended with "${r}"; see ${log}.` };
  }
}

const SOFT_NOTE =
  "Nothing else is affected: the factory keeps running and cards keep moving; only " +
  "the browser runs (In Test web steps) are skipped.\n";
const FOOTER = `\nStatus: \`${STATUS_CMD}\`\nTurn browser runs off: FACTORY_BROWSER=0 in the factory plist.\n`;

// <state> is the record the email is about: the new one for degraded and
// disabled, the one before the good run for recovered (its streak is gone).
export function emailContent(
  kind,
  state,
  { accountFile = DEFAULT_ACCOUNT_FILE, now = new Date().toISOString() } = {},
) {
  const s = { ...emptyBrowser(), ...(state ?? {}) };
  if (kind === "recovered") {
    const { label } = describeReason(s.reason, { accountFile, at: now });
    return {
      subject: "[drafto factory] browser checks recovered",
      body:
        `The factory's browser runner works again (a completed run at ${now}).\n\n` +
        `It had been failing since ${s.unavailableSince ?? "(unknown)"}; the last problem was: ${label}.\n` +
        "Browser runs carry on from the next tick.\n" +
        FOOTER,
    };
  }
  if (kind === "disabled") {
    const { fix } = describeReason("guard-not-loaded", { accountFile, at: s.lastResultAt });
    return {
      subject: "[drafto factory] browser checks DISABLED: guard settings didn't load",
      body:
        `A browser run at ${s.lastResultAt ?? now} left no SessionStart record in the browser ` +
        "guard's log, so its --settings file (and with it every guard hook) was ignored. The " +
        `factory has switched browser runs off (disabled: ${s.disabledReason ?? "guard-not-loaded"}).\n\n` +
        `Fix: ${fix} Check what broke the settings file first (\`node scripts/lib/browser-guard.mjs ` +
        `settings\`, and ${watchLog(s.lastResultAt)}).\n\n` +
        SOFT_NOTE +
        FOOTER,
    };
  }
  const { label, fix } = describeReason(s.reason, { accountFile, at: s.lastResultAt });
  return {
    subject: `[drafto factory] browser checks failing: ${label}`,
    body:
      `The factory's browser runner (Claude in Chrome on the Mac mini) has had ${s.consecutiveBad} ` +
      `bad results in a row, the first at ${s.unavailableSince ?? "(unknown)"}. ` +
      `Latest: ${s.reason ?? "(unknown)"}.\n\n` +
      `Fix: ${fix}\n\n` +
      SOFT_NOTE +
      "You'll get one more email when a run completes again.\n" +
      FOOTER,
  };
}

// ── preflight ───────────────────────────────────────────────────────────────

export function preflight({ accountFile = DEFAULT_ACCOUNT_FILE, isChromeRunning }) {
  if (!isChromeRunning()) return "chrome-not-running";
  const problem = accountFileProblem(accountFile);
  return problem ? `account-${problem}` : null;
}

// A pgrep that can't run counts as "not running": skipping a run is the safe side.
export function chromeIsRunning(spawn = spawnSync) {
  const res = spawn("pgrep", ["-x", "Google Chrome"], { encoding: "utf8", timeout: 10_000 });
  return !res.error && res.status === 0;
}

// ── side effects ────────────────────────────────────────────────────────────

export function performBrowserActions(
  actions,
  { prev, next, to, zohoCli, accountFile, now = new Date().toISOString(), spawn = spawnSync },
) {
  const results = [];
  for (const a of actions) {
    if (a.type !== "email") continue;
    const about = a.kind === "recovered" ? prev : next;
    let r;
    try {
      r = sendEmail(emailContent(a.kind, about, { accountFile, now }), { to, zohoCli, spawn });
    } catch (err) {
      // An email failure must never fail the tick.
      r = { ok: false, error: err.message };
    }
    if (!r.ok) undoFailedAlert(next, a, prev);
    results.push({ ...a, ok: r.ok, error: r.ok ? undefined : r.error });
  }
  return results;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

class UsageError extends Error {}

export async function runPreflight(argv, { isChromeRunning = () => chromeIsRunning() } = {}) {
  const { flags } = parseFlags(argv);
  const state = await loadFactoryState(flags["state-file"] ?? DEFAULT_FACTORY_STATE_PATH);
  const browser = state.browser ?? emptyBrowser();
  if (browser.disabled) return `disabled:${browser.disabledReason ?? "unknown"}`;
  return (
    preflight({ accountFile: flags["account-file"] ?? DEFAULT_ACCOUNT_FILE, isChromeRunning }) ??
    "ok"
  );
}

export async function runRecord(argv, { spawn = spawnSync } = {}) {
  const { flags } = parseFlags(argv);
  const result = flags.result;
  if (!isKnownResult(result)) throw new UsageError(`invalid --result: ${result ?? "(none)"}`);
  const now = flags.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new UsageError(`invalid --now: ${now}`);
  const stateFile = flags["state-file"] ?? DEFAULT_FACTORY_STATE_PATH;
  const to = flags.to || process.env.SUPPORT_ADMIN_EMAIL || DEFAULT_TO;
  const zohoCli = flags["zoho-cli"] ?? DEFAULT_ZOHO_CLI;
  const accountFile = flags["account-file"] ?? DEFAULT_ACCOUNT_FILE;

  const state = await loadFactoryState(stateFile);
  const prev = state.browser ?? emptyBrowser();
  const { next, actions } = decideBrowser(prev, result, { now });
  const results = performBrowserActions(actions, {
    prev,
    next,
    to,
    zohoCli,
    accountFile,
    now,
    spawn,
  });
  state.browser = next;
  await saveFactoryState(state, stateFile);
  return { actions: results, browser: next };
}

const USAGE =
  "Usage: browser-health.mjs preflight --state-file <f> --account-file <f>\n" +
  "       browser-health.mjs record --state-file <f> --result <result> [--to <email>] " +
  "[--zoho-cli <path>] [--account-file <f>] [--now <iso>]\n";

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "preflight") {
    const out = await runPreflight(rest);
    process.stdout.write(out + "\n");
    return out === "ok" ? 0 : 1;
  }
  if (cmd === "record") {
    process.stdout.write(JSON.stringify(await runRecord(rest)) + "\n");
    return 0;
  }
  process.stdout.write(USAGE);
  return cmd && cmd !== "--help" && cmd !== "-h" ? 2 : 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(err instanceof UsageError || /^Missing value for --/.test(err.message) ? 2 : 1);
    },
  );
}
