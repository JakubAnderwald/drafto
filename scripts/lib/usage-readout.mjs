// The weekly hosting-usage readout's second half (ADR-0091).
//
// The browser runner's `usage` kind reads the Vercel and Supabase usage
// dashboards and prints the figures exactly as shown, inside a
// <<<USAGE … USAGE>>> block, as JSON with string values ("1.42 GB", "195K",
// "2h 17m"). This module turns those strings into numbers deterministically, so
// no model does arithmetic, checks the output for secrets, and posts the
// readout to Drafto's POST /api/cron/hosted-usage with the route's own bearer
// secret. Anything that goes wrong emails the operator through the factory's
// zoho-cli path (toolchain-health.mjs sendEmail). Nothing goes to GitHub.
//
// CLI (called by factory-agent.sh --usage-readout):
//   node usage-readout.mjs run --in <runner-output.txt> --runner-result <ran|timeout|…>
//        --url <post url> --secret-file <file> --to <email>
//        [--providers vercel[,supabase]] [--zoho-cli <path>] [--now <iso>] [--dry-run]
//   Prints one JSON summary line. Exit 0 when a readout was posted (missing
//   resources are emailed but don't fail it), 1 otherwise.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseBlocks, parseEnvValues, scanForSecrets } from "./browser-report.mjs";
import { isMainModule } from "./is-main.mjs";
import { sendEmail } from "./toolchain-health.mjs";

export const SECRET_KEY = "HOSTED_USAGE_SECRET";
export const DEFAULT_POST_URL = "https://drafto.eu/api/cron/hosted-usage";
const DEFAULT_ZOHO_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "zoho-cli.mjs");

// What the runner reports, and how each becomes a reading: the route's resource
// name and the parser for its unit (the unit metrics_hosted_usage() holds the
// limit in).
export const FIELDS = Object.freeze([
  {
    provider: "vercel",
    key: "fastDataTransfer",
    resource: "vercel_fast_data_transfer",
    unit: "GB",
  },
  { provider: "vercel", key: "cdnRequests", resource: "vercel_cdn_requests", unit: "count" },
  {
    provider: "vercel",
    key: "functionInvocations",
    resource: "vercel_function_invocations",
    unit: "count",
  },
  { provider: "vercel", key: "activeCpu", resource: "vercel_active_cpu", unit: "hours" },
  { provider: "supabase", key: "egress", resource: "supabase_egress", unit: "GB" },
  { provider: "supabase", key: "cachedEgress", resource: "supabase_cached_egress", unit: "GB" },
]);

const STATUS_LINE = /^browser=(ok|unavailable|auth-expired|blocked)$/;

// ── Number parsing ──────────────────────────────────────────────────────────

/**
 * A dashboard number: "1.42", "1,42" (decimal comma), "1,234" / "1 234" /
 * "1.234,5" (grouping). When both "." and "," appear, the rightmost is the
 * decimal mark. A lone separator is the decimal mark, except with `grouping`:
 * then a lone separator between a 1–3 digit integer part without a leading 0
 * and exactly three digits groups thousands ("1,234"), and anything else
 * ("0.123", "12.5") is decimal. Byte amounts and suffixed counts ("1.234K")
 * pass `grouping: false`. Null when it isn't a number.
 */
export function parseDashboardNumber(raw, { grouping = true } = {}) {
  let s = String(raw ?? "")
    .trim()
    .replace(/[\u00a0\u202f ]/g, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    const dec = lastDot > lastComma ? "." : ",";
    const group = dec === "." ? "," : ".";
    s = s.split(group).join("").replace(dec, ".");
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const parts = s.split(sep);
    const groups =
      parts.length > 2
        ? parts.slice(1).every((p) => p.length === 3)
        : grouping && /^[1-9]\d{0,2}$/.test(parts[0]) && parts[1].length === 3;
    if (parts.length > 2 && !groups) return null;
    s = groups ? parts.join("") : parts.join(".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const BYTE_UNITS = { B: 1e-9, KB: 1e-6, MB: 1e-3, GB: 1, TB: 1e3 };

/** "1.42 GB", "365.52 MB", "0 B" → gigabytes (decimal, as the dashboards count). */
export function parseGigabytes(raw) {
  const m = /^\s*([\d.,   ]+?)\s*(B|KB|MB|GB|TB)\s*$/i.exec(String(raw ?? ""));
  if (!m) return null;
  const n = parseDashboardNumber(m[1], { grouping: false });
  return n === null ? null : round(n * BYTE_UNITS[m[2].toUpperCase()], 6);
}

const COUNT_SUFFIX = { "": 1, K: 1e3, M: 1e6, B: 1e9 };

/** "195K", "1.2M", "122,034", "6" → a count. */
export function parseCount(raw) {
  const m = /^\s*([\d.,   ]+?)\s*([KMB]?)\s*$/i.exec(String(raw ?? ""));
  if (!m) return null;
  const suffix = m[2].toUpperCase();
  const n = parseDashboardNumber(m[1], { grouping: suffix === "" });
  return n === null ? null : Math.round(n * COUNT_SUFFIX[suffix]);
}

/** "2h 17m", "1m 55s", "45s", "4h", "2.5h" → hours. */
export function parseHours(raw) {
  const s = String(raw ?? "").trim();
  if (!/^(\d+(?:[.,]\d+)?\s*[hms]\s*)+$/i.test(s)) return null;
  const scale = { h: 1, m: 1 / 60, s: 1 / 3600 };
  let hours = 0;
  for (const [, num, unit] of s.matchAll(/(\d+(?:[.,]\d+)?)\s*([hms])/gi)) {
    hours += Number(num.replace(",", ".")) * scale[unit.toLowerCase()];
  }
  return round(hours, 4);
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

const PARSERS = { GB: parseGigabytes, count: parseCount, hours: parseHours };
/** The route's plausibility bounds (hosted-usage-readout.ts MAX_USED): above them is a misread. */
export const MAX_USED = Object.freeze({ GB: 100_000, count: 1e10, hours: 10_000 });

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The usage period a dashboard shows, as ISO dates { from, to }, or null:
 * "Oct 22, 10:00 - Nov 21, 10:00", "Nov 15 - Dec 15", "21 Oct - 21 Nov",
 * "Nov 1 - Nov 30, 2026". Without a year, `from` takes the latest year that
 * puts it on or before `now`, and `to` the first year on or after `from`
 * (a billing cycle can end in the future).
 */
export function parsePeriod(raw, now = new Date()) {
  const text = String(raw ?? "");
  const found = [];
  const re =
    /\b(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})|(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?)(?:,?\s+(\d{4}))?\b/g;
  for (const m of text.matchAll(re)) {
    const month = MONTHS.indexOf((m[1] ?? m[4]).toLowerCase());
    if (month === -1) continue;
    found.push({ month, day: Number(m[2] ?? m[3]), year: m[5] ? Number(m[5]) : null });
    if (found.length === 2) break;
  }
  if (found.length < 2) return null;
  const [a, b] = found;
  const make = (y, d) => {
    const date = new Date(Date.UTC(y, d.month, d.day));
    return date.getUTCMonth() === d.month && date.getUTCDate() === d.day ? date : null;
  };
  let fromYear = a.year ?? b.year ?? now.getUTCFullYear();
  if (a.year === null && b.year === null) {
    const probe = make(fromYear, a);
    if (probe && probe.getTime() > now.getTime() + 86_400_000) fromYear -= 1;
  } else if (a.year === null && b.year !== null && b.month < a.month) {
    fromYear = b.year - 1;
  }
  const from = make(fromYear, a);
  if (!from) return null;
  let to = make(b.year ?? fromYear, b);
  if (to && b.year === null && to < from) to = make(fromYear + 1, b);
  if (!to || to < from) return null;
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

// ── The runner's output → a readout ─────────────────────────────────────────

/**
 * Parse the runner's output. Returns { status, readings, missing, problem }:
 * `status` is the runner's browser= value (or "malformed"), `readings` the
 * route's readout entries, `missing` the expected resources it didn't report
 * or that didn't parse, and `problem` why there is nothing to post (null when
 * there is). Only `providers` are expected (Supabase is optional).
 *
 * A run that stopped at one site's login wall (`auth-expired`) or lost the
 * browser part-way (`unavailable`) still posts what it read; a `blocked` or
 * malformed run, or one whose output looks like it carries a secret, posts
 * nothing.
 */
export function buildReadout(text, { now = new Date(), providers = ["vercel", "supabase"] } = {}) {
  const { blocks, status: m } = parseBlocks(text, { blocks: ["USAGE"], statusLine: STATUS_LINE });
  const status = m ? m[1] : "malformed";
  const secrets = scanForSecrets(text);
  if (secrets.length > 0) {
    return {
      status,
      readings: [],
      missing: [],
      problem: `secret-like text (${secrets.join(", ")})`,
    };
  }
  if (status === "blocked" || status === "malformed") {
    return { status, readings: [], missing: [], problem: `browser=${status}` };
  }
  const body = blocks.USAGE.at(-1);
  let data = null;
  try {
    data = JSON.parse(
      String(body ?? "")
        .trim()
        .replace(/^```(?:json)?\s*\n/i, "")
        .replace(/\n```$/, ""),
    );
  } catch {
    data = null;
  }
  if (data === null || typeof data !== "object") {
    return {
      status,
      readings: [],
      missing: [],
      problem: status === "ok" ? "no readable USAGE block" : `browser=${status}`,
    };
  }
  const readings = [];
  const missing = [];
  for (const f of FIELDS.filter((field) => providers.includes(field.provider))) {
    const section = data?.[f.provider];
    const raw = section?.[f.key];
    const used = typeof raw === "string" ? PARSERS[f.unit](raw) : null;
    if (used === null || used < 0 || used > MAX_USED[f.unit]) {
      missing.push(f.resource);
      continue;
    }
    const period = typeof section?.period === "string" ? parsePeriod(section.period, now) : null;
    readings.push({
      resource: f.resource,
      used,
      ...(period ? { periodFrom: period.from, periodTo: period.to } : {}),
    });
  }
  let problem = null;
  if (readings.length === 0)
    problem = status === "ok" ? "no figure could be read" : `browser=${status}`;
  return { status, readings, missing, problem };
}

// ── Secret file and posting ─────────────────────────────────────────────────

/** The route's secret from a mode-600 env file, or throws saying what's wrong (never the value). */
export function readSecret(file, { fs = { readFileSync, statSync } } = {}) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`secret file ${file} is missing`);
  }
  if (!st.isFile()) throw new Error(`secret file ${file} is not a file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`secret file ${file} must be mode 600`);
  const value = parseEnvValues(fs.readFileSync(file, "utf8"), [SECRET_KEY])[SECRET_KEY];
  if (!value || value.length < 32)
    throw new Error(`${SECRET_KEY} in ${file} is missing or too short`);
  return value;
}

/** POST the readout. Resolves { ok, status, error }; the error text never quotes the secret. */
export async function postReadout({ url, secret, readings, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ readings }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { ok: true, status: res.status, error: null };
    const body = (await res.text().catch(() => "")).split(secret).join("[redacted]").slice(0, 300);
    return { ok: false, status: res.status, error: `HTTP ${res.status} ${body}`.trim() };
  } catch (err) {
    return { ok: false, status: null, error: String(err?.message ?? err) };
  }
}

// ── Email ───────────────────────────────────────────────────────────────────

const RUNBOOK = 'docs/operations/factory-runbook.md → "Browser runner" → the usage readout';

export function failureEmail(reason, { missing = [], incomplete = false } = {}) {
  const lines = [
    incomplete
      ? "The Mac mini's weekly hosting-usage readout (ADR-0091) posted, but some figures weren't read."
      : "The Mac mini's weekly hosting-usage readout (ADR-0091) didn't complete.",
    "",
    `Reason: ${reason}`,
  ];
  if (missing.length) lines.push(`Not read: ${missing.join(", ")}`);
  lines.push(
    "",
    "Until the next good run, /admin/stats keeps the last readings and marks them stale after 8 days.",
    "Check the Vercel and Supabase usage pages by hand in the meantime",
    "(FACTORY_USAGE_VERCEL_URL and FACTORY_USAGE_SUPABASE_URL in the usage job's plist).",
    "",
    "Common causes: Chrome isn't running on the Mac mini, or its profile is signed out of",
    "vercel.com or supabase.com (sign back in; the runner never signs in itself), or a",
    "dashboard redesign moved a figure.",
    "",
    `Triage: ${RUNBOOK}.`,
  );
  return {
    subject: `Drafto factory: weekly usage readout ${incomplete ? "incomplete" : "failed"} (${reason.slice(0, 60)})`,
    body: `${lines.join("\n")}\n`,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

export async function run(
  {
    input,
    runnerResult,
    url,
    secretFile,
    to,
    providers = ["vercel", "supabase"],
    zohoCli = DEFAULT_ZOHO_CLI,
    now = new Date(),
    dryRun = false,
  },
  { fetchImpl = fetch, spawn = spawnSync, readFile = readFileSync, fs } = {},
) {
  const notify = (reason, extra) => {
    if (dryRun) return { ok: true, dryRun: true };
    return sendEmail(failureEmail(reason, extra), { to, zohoCli, spawn });
  };
  if (runnerResult !== "ran") {
    const mail = notify(`runner ${runnerResult}`);
    return { posted: false, reason: `runner ${runnerResult}`, emailed: mail.ok };
  }
  let text = "";
  try {
    text = readFile(input, "utf8");
  } catch {
    const mail = notify("the runner left no output");
    return { posted: false, reason: "no runner output", emailed: mail.ok };
  }
  const readout = buildReadout(text, { now, providers });
  if (readout.problem) {
    const mail = notify(readout.problem, { missing: readout.missing });
    return { posted: false, reason: readout.problem, missing: readout.missing, emailed: mail.ok };
  }
  if (dryRun) {
    return { posted: false, dryRun: true, readings: readout.readings, missing: readout.missing };
  }
  let secret;
  try {
    secret = readSecret(secretFile, fs ? { fs } : undefined);
  } catch (err) {
    const mail = notify(`post skipped: ${err.message}`);
    return { posted: false, reason: err.message, emailed: mail.ok };
  }
  const res = await postReadout({ url, secret, readings: readout.readings, fetchImpl });
  if (!res.ok) {
    const mail = notify(`post failed: ${res.error}`, { missing: readout.missing });
    return { posted: false, reason: `post failed: ${res.error}`, emailed: mail.ok };
  }
  let emailed = null;
  if (readout.missing.length || readout.status !== "ok") {
    const why = readout.status === "ok" ? "some figures weren't read" : `browser=${readout.status}`;
    emailed = notify(why, {
      missing: readout.missing,
      incomplete: true,
    }).ok;
  }
  return {
    posted: true,
    resources: readout.readings.map((r) => r.resource),
    missing: readout.missing,
    ...(emailed === null ? {} : { emailed }),
  };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, deps } = {}) {
  const [cmd, ...rest] = argv;
  if (cmd !== "run") {
    stderr.write(
      "Usage: usage-readout.mjs run --in <f> --runner-result <r> --url <u> --secret-file <f> --to <email> [--zoho-cli <p>] [--now <iso>] [--dry-run]\n",
    );
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      in: { type: "string" },
      "runner-result": { type: "string" },
      url: { type: "string" },
      "secret-file": { type: "string" },
      to: { type: "string" },
      "zoho-cli": { type: "string" },
      providers: { type: "string" },
      now: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    strict: true,
  });
  for (const k of ["in", "runner-result", "secret-file", "to"]) {
    if (!values[k]) {
      stderr.write(`missing --${k}\n`);
      return 2;
    }
  }
  const summary = await run(
    {
      input: values.in,
      runnerResult: values["runner-result"],
      url: values.url ?? DEFAULT_POST_URL,
      secretFile: values["secret-file"],
      to: values.to,
      ...(values["zoho-cli"] ? { zohoCli: values["zoho-cli"] } : {}),
      ...(values.providers
        ? {
            providers: values.providers
              .split(",")
              .filter((p) => p === "vercel" || p === "supabase"),
          }
        : {}),
      now: values.now ? new Date(values.now) : new Date(),
      dryRun: Boolean(values["dry-run"]),
    },
    deps,
  );
  stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.posted || summary.dryRun ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`usage-readout: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
