#!/usr/bin/env node
// Prints Drafto's product metrics for an operator: `pnpm users:stats`.
//
// Every number comes from the service-role SQL functions in
// supabase/migrations/20261112000002_product_metrics.sql (ADR 0075); this
// script only calls them and lays the rows out. Definitions:
// docs/features/product-metrics.md.
//
// Read-only. Each function is called with GET /rest/v1/rpc/<name>, which
// PostgREST runs in a read-only transaction, and the functions are STABLE, so
// the database itself refuses any write. Nothing here sends anything else.
//
// The service-role key comes from the PROD: or DEV: line of --keys-txt, by
// default ~/drafto-secrets/supabase service keys.txt, read with the helper
// delete-users.mjs uses. It is sent in request headers only and never printed.
// The run refuses unattended sessions (DRAFTO_UNATTENDED) and `node --test`
// before reading any key file.
//
// Usage:
//   pnpm users:stats -- --project prod|dev [--weeks N] [--json] [--keys-txt <file>]
//
// --weeks  how many ISO weeks the weekly tables cover, this one included
//          (default 8, at most 104). The emptied-notes check looks back as far.
// --json   one JSON object instead of the tables.
//
// Exit 0 when every metric was read (or for --help), 1 when any failed (the
// others are still printed) or the run was refused, 2 on bad arguments.

import { isMainModule } from "./lib/is-main.mjs";
import { PROJECTS, defaultKeysTxtPath, readServiceKey } from "./lib/service-keys-txt.mjs";
import { UNATTENDED_VAR } from "./run-dev-live-tests.mjs";

export const DEFAULT_WEEKS = 8;
export const MAX_WEEKS = 104;
const DAY_MS = 86_400_000;
const MB = 1024 * 1024;

// The client tags ADR 0023 defines that write notes, in column order.
export const CLIENT_COLUMNS = Object.freeze([
  "web",
  "mobile-ios",
  "mobile-android",
  "desktop-macos",
  "web-mcp",
  "untagged",
]);

// What the script reads, in report order: the JSON key and the SQL function.
export const METRICS = Object.freeze([
  { key: "signups", fn: "metrics_signups" },
  { key: "activation", fn: "metrics_activation" },
  { key: "writers", fn: "metrics_writers" },
  { key: "emptiedNotes", fn: "metrics_emptied_notes" },
  { key: "depth", fn: "metrics_depth" },
  { key: "platformLimits", fn: "metrics_platform_limits" },
]);

export const USAGE = `Usage: pnpm users:stats -- --project prod|dev [--weeks N] [--json] [--keys-txt <file>]

Prints Drafto's product metrics (docs/features/product-metrics.md), read-only.
--weeks     ISO weeks the weekly tables cover, this one included (default ${DEFAULT_WEEKS}, max ${MAX_WEEKS})
--json      print one JSON object instead of tables
--keys-txt  the service-role keys file (default ~/drafto-secrets/supabase service keys.txt)`;

export class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--project", "--weeks", "--keys-txt"]);

/** Parses argv (without node and the script path). Throws UsageError. */
export function parseArgs(argv, { keysTxt = defaultKeysTxtPath() } = {}) {
  const opts = { project: null, weeks: DEFAULT_WEEKS, json: false, keysTxt, help: false };
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--json") opts.json = true;
    else {
      const eq = arg.indexOf("=");
      const flag = eq === -1 ? arg : arg.slice(0, eq);
      if (!VALUE_FLAGS.has(flag)) {
        throw new UsageError(
          arg.startsWith("-") ? `unknown option ${flag}` : `unexpected argument ${arg}`,
        );
      }
      let value;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new UsageError(`${flag} needs a value`);
        }
        i++;
      }
      values[flag] = value;
    }
  }
  if (opts.help) return opts;
  if (values["--keys-txt"] !== undefined) {
    if (!values["--keys-txt"]) throw new UsageError("--keys-txt needs a path");
    opts.keysTxt = values["--keys-txt"];
  }
  if (!Object.hasOwn(PROJECTS, values["--project"] ?? "")) {
    throw new UsageError("--project must be prod or dev");
  }
  opts.project = values["--project"];
  if (values["--weeks"] !== undefined) {
    const raw = values["--weeks"];
    const weeks = Number(raw);
    if (!/^\d+$/.test(raw) || weeks < 1 || weeks > MAX_WEEKS) {
      throw new UsageError(`--weeks must be a whole number from 1 to ${MAX_WEEKS}`);
    }
    opts.weeks = weeks;
  }
  return opts;
}

/** Why this process must not run, or null. */
export function refusalReason({ env = process.env, execArgv = process.execArgv } = {}) {
  // Any value counts, so an unexpected one fails closed.
  if (env[UNATTENDED_VAR]) {
    return `${UNATTENDED_VAR} is set: the product metrics read a service-role key, so they are for interactive sessions only`;
  }
  if (env.NODE_TEST_CONTEXT || execArgv.includes("--test")) {
    return "running under node --test; run it as pnpm users:stats instead";
  }
  return null;
}

/** Each metric's RPC parameters for a run over <weeks> weeks ending at <now>. */
export function metricParams({ weeks, now }) {
  const since = new Date(now.getTime() - weeks * 7 * DAY_MS).toISOString();
  return {
    signups: { p_weeks: weeks },
    activation: { p_weeks: weeks },
    writers: { p_weeks: weeks },
    emptiedNotes: { p_since: since },
    depth: {},
    platformLimits: {},
  };
}

/** <text> with every occurrence of <secret> masked. */
export function redact(text, secret) {
  const s = String(text);
  return secret ? s.split(secret).join("[redacted]") : s;
}

/** The total after the slash in a PostgREST Content-Range header ("0-9/42"), or null. */
export function contentRangeTotal(header) {
  const m = /\/(\d+)$/.exec(header ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * A client for the metric functions over PostgREST RPC. It only sends GET, the
 * read-only RPC method, and only to /rest/v1/rpc/metrics_*. The key goes in
 * headers, never in the URL, and errors never quote it.
 *
 * PostgREST caps every response at the project's max_rows (1000 by default),
 * stored procedures included, and says nothing when it does. So each call asks
 * for the exact count, and a list shorter than its count fails instead of
 * passing for the whole of it.
 */
export function createStatsClient({ ref, serviceKey, fetchImpl = fetch }) {
  const base = `https://${ref}.supabase.co/rest/v1/rpc/`;
  async function rpc(fn, params = {}) {
    if (!/^metrics_[a-z_]+$/.test(fn)) throw new Error(`not a metrics function: ${fn}`);
    const query = new URLSearchParams(params).toString();
    const res = await fetchImpl(`${base}${fn}${query ? `?${query}` : ""}`, {
      method: "GET",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
        Prefer: "count=exact",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(redact(`${fn} -> HTTP ${res.status} ${text.slice(0, 300)}`, serviceKey));
    }
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      throw new Error(`${fn} -> HTTP ${res.status}, not JSON`);
    }
    const total = contentRangeTotal(res.headers.get("content-range"));
    if (Array.isArray(rows) && total !== null && rows.length < total) {
      throw new Error(
        `${fn} -> only ${rows.length} of ${total} rows: the API's max_rows limit cut the list short; try a smaller --weeks`,
      );
    }
    return rows;
  }
  return { rpc };
}

/**
 * Reads every metric, each on its own: one failing doesn't stop the others.
 * Resolves to {metrics: {key: rows}, errors: {key: message}}; depth is its one
 * row (or null).
 */
export async function collectMetrics(client, { weeks, now, serviceKey = "" }) {
  const params = metricParams({ weeks, now });
  const settled = await Promise.allSettled(
    METRICS.map(({ key, fn }) => client.rpc(fn, params[key])),
  );
  const metrics = {};
  const errors = {};
  METRICS.forEach(({ key }, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") {
      metrics[key] = key === "depth" ? (r.value?.[0] ?? null) : r.value;
    } else {
      errors[key] = redact(r.reason?.message ?? String(r.reason), serviceKey);
    }
  });
  return { metrics, errors };
}

// ── Formatting ──────────────────────────────────────────────────────────────

// Cells that align right: numbers and percentages, and the placeholders that
// stand in for them.
const isNumberCell = (v) => /^(-?[\d.,]+%?|–|n\/a)$/.test(v);

/**
 * A plain-text table: a header row, a rule, one line per row. Numeric cells
 * align right, the rest left. Null and undefined show as "–".
 */
export function formatTable(headers, rows) {
  const cells = rows.map((row) =>
    row.map((v) => (v === null || v === undefined ? "–" : String(v))),
  );
  const widths = headers.map((h, c) => Math.max(h.length, ...cells.map((row) => row[c].length)));
  const right = headers.map(
    (_, c) => cells.length > 0 && cells.every((row) => isNumberCell(row[c])),
  );
  const line = (row) =>
    row
      .map((v, c) => (right[c] ? v.padStart(widths[c]) : v.padEnd(widths[c])))
      .join("  ")
      .trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...cells.map(line)].join(
    "\n",
  );
}

const fixed = (n, digits = 1) => (n === null || n === undefined ? null : Number(n).toFixed(digits));
const mb = (bytes) => fixed(Number(bytes) / MB, 1);
const pctOf = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : null);

/**
 * The keys of <objects> as columns: those in <order> first, in that order
 * (all of them with <always>, else only the ones present), then any others
 * alphabetically.
 */
export function columnsFor(objects, order, { always = false } = {}) {
  const seen = new Set(objects.flatMap((o) => Object.keys(o ?? {})));
  const rest = [...seen].filter((k) => !order.includes(k)).sort();
  return [...order.filter((k) => always || seen.has(k)), ...rest];
}

function section(title, body) {
  return `${title}\n${body}`;
}

function signupsSection(rows) {
  const providers = columnsFor(
    rows.map((r) => r.by_provider),
    ["email", "google", "apple"],
  );
  return formatTable(
    ["Week", "Starts", "Sign-ups", ...providers],
    rows.map((r) => [
      r.iso_week,
      r.week_start,
      r.signups,
      ...providers.map((p) => r.by_provider?.[p] ?? 0),
    ]),
  );
}

function activationSection(rows) {
  return formatTable(
    [
      "Cohort",
      "Starts",
      "Signed up",
      "First value",
      "First value %",
      "Activated",
      "Activated %",
      "Window",
    ],
    rows.map((r) => [
      r.iso_week,
      r.week_start,
      r.signed_up,
      r.first_value,
      pctOf(r.first_value, r.signed_up),
      r.activated === null ? "n/a" : r.activated,
      r.activated === null ? "n/a" : pctOf(r.activated, r.signed_up),
      r.window_complete ? "closed" : "open",
    ]),
  );
}

function writersSection(rows) {
  const clients = columnsFor(
    rows.map((r) => r.by_client),
    CLIENT_COLUMNS,
    { always: true },
  );
  return formatTable(
    ["Week", "Starts", "Writers", ...clients, "History"],
    rows.map((r) => [
      r.iso_week,
      r.week_start,
      r.writers,
      ...clients.map((c) => r.by_client?.[c] ?? 0),
      r.history_complete ? "complete" : "partial",
    ]),
  );
}

function emptiedSection(rows) {
  if (!rows.length) return "(none)";
  return formatTable(
    ["Emptied at (UTC)", "Client", "Chars before", "Note", "User"],
    rows.map((r) => [
      String(r.emptied_at)
        .replace("T", " ")
        .replace(/(\.\d+)?(\+00:00|Z)$/, ""),
      r.client,
      r.chars_before,
      r.note_id,
      r.user_id,
    ]),
  );
}

function depthSection(d) {
  if (!d) return "(no row)";
  const sizes = formatTable(
    ["Per writer", "Median", "Max"],
    [
      ["Live notes", fixed(d.live_notes_median), d.live_notes_max],
      ["Notebooks", fixed(d.notebooks_median), d.notebooks_max],
      ["Attachments (MB)", fixed(d.attachment_mb_median, 2), fixed(d.attachment_mb_max, 2)],
    ],
  );
  const pct = (v) => (v === null || v === undefined ? null : `${fixed(v)}%`);
  const shares = formatTable(
    ["Share of writers", "%"],
    [
      ["With an attachment", pct(d.pct_with_attachment)],
      ["With an API key", pct(d.pct_with_api_key)],
      ["With an MCP write", pct(d.pct_with_mcp_write)],
      ["Writing from 2+ clients", pct(d.pct_multi_client)],
    ],
  );
  return `Writers in the last 30 days: ${d.writers}\n${sizes}\n\n${shares}`;
}

function limitsSection(rows) {
  return formatTable(
    ["Resource", "Used (MB)", "Limit (MB)", "Used %", "Level"],
    rows.map((r) => [r.resource, mb(r.used_bytes), mb(r.limit_bytes), `${fixed(r.pct)}%`, r.level]),
  );
}

const SECTIONS = [
  ["signups", "Sign-ups per ISO week (UTC)", signupsSection],
  [
    "activation",
    "Activation by sign-up week (first value: a 50+ character version within 14 days; activated: on 2+ days)",
    activationSection,
  ],
  ["writers", "Writers per ISO week, overall and by client tag", writersSection],
  [
    "emptiedNotes",
    "Notes emptied by one save (200+ characters to none, still empty 24h later)",
    emptiedSection,
  ],
  ["depth", "Depth of use", depthSection],
  ["platformLimits", "Supabase Free plan limits (project-wide)", limitsSection],
];

/** The readable report: a header, then one titled table per metric. */
export function formatReport({ project, ref, weeks, now, metrics, errors }) {
  const since = metricParams({ weeks, now }).emptiedNotes.p_since;
  const parts = [
    `Drafto product metrics — ${project} (${ref}), last ${weeks} ISO week(s), at ${now.toISOString()}`,
    "Admins and metrics_excluded_users are left out of everything but the platform limits.",
  ];
  for (const [key, title, render] of SECTIONS) {
    const heading = key === "emptiedNotes" ? `${title}, since ${since.slice(0, 10)}` : title;
    const body = Object.hasOwn(errors, key) ? `FAILED: ${errors[key]}` : render(metrics[key]);
    parts.push(section(`== ${heading}`, body));
  }
  return `${parts.join("\n\n")}\n`;
}

/** The --json object. */
export function buildJson({ project, ref, weeks, now, metrics, errors }) {
  return {
    project,
    ref,
    generatedAt: now.toISOString(),
    weeks,
    emptiedSince: metricParams({ weeks, now }).emptiedNotes.p_since,
    metrics,
    errors,
  };
}

/**
 * The whole run with its effects injected. Resolves to the exit code; output
 * goes to out / err, with the service key masked in both.
 */
export async function main(
  argv,
  {
    env = process.env,
    execArgv = process.execArgv,
    fetchImpl = fetch,
    now = () => new Date(),
    readFile,
    out = (s) => process.stdout.write(s),
    err = (s) => process.stderr.write(s),
  } = {},
) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`users:stats: ${e.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    out(`${USAGE}\n`);
    return 0;
  }
  const refusal = refusalReason({ env, execArgv });
  if (refusal) {
    err(`users:stats: refused: ${refusal}\n`);
    return 1;
  }
  let key;
  try {
    key = readServiceKey({
      project: opts.project,
      keysTxt: opts.keysTxt,
      ...(readFile && { readFile }),
    });
  } catch (e) {
    err(`users:stats: ${e.code === "ENOENT" ? `${opts.keysTxt} is missing` : e.message}\n`);
    return 1;
  }
  const { ref, serviceKey } = key;
  const at = now();
  const client = createStatsClient({ ref, serviceKey, fetchImpl });
  const { metrics, errors } = await collectMetrics(client, {
    weeks: opts.weeks,
    now: at,
    serviceKey,
  });
  const report = { project: opts.project, ref, weeks: opts.weeks, now: at, metrics, errors };
  const text = opts.json ? `${JSON.stringify(buildJson(report), null, 2)}\n` : formatReport(report);
  out(redact(text, serviceKey));
  const failed = Object.keys(errors);
  if (failed.length) {
    err(`users:stats: ${failed.length} metric(s) failed: ${failed.join(", ")}\n`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`users:stats: ${e.message}\n`);
      process.exitCode = 1;
    },
  );
}
