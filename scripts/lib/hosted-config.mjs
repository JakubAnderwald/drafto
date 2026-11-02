// Hosted-config gate (ADR-0065): does the hosted Supabase auth config already
// have what a PR's supabase/config.toml adds?
//
// The Redirect URL allowlist lives in each hosted project's dashboard, not in
// git, so a PR that needs a new entry depends on an operator adding it by hand.
// On #685 / PR #778 nobody had, and the factory still shipped pre-merge betas
// that run against production.
//
// The check needs no credentials. GoTrue's /verify validates `redirect_to`
// before it redirects. With a junk token it answers 303 to that URL when the
// allowlist accepts it, and to the project's Site URL when it doesn't. So
// probing one sample URL per added entry tells us whether the entry is live.
// Each project is first probed with a known-rejected control, whose redirect
// reveals that project's Site URL, and a known-allowed one. A change in that
// behaviour reads as "unknown", never as a false pass or hold. The
// `hosted-config-applied` label overrules "unknown", never a confirmed miss.
//
// Anything else in config.toml (rate limits, templates, providers) can't be
// probed, and neither can a Redirect URL with no valid sample. Those need the
// `hosted-config-applied` PR label, set by the operator once they have applied
// the change to both projects.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const HOSTED_PROJECTS = [
  { name: "dev", ref: "huhzactreblzcogqkbsd" },
  { name: "prod", ref: "tbmjbxxseonkciqovnpl" },
];
export const CONFIG_PATH = "supabase/config.toml";
export const APPLIED_LABEL = "hosted-config-applied";
// Never allowlisted, so /verify must send it to the project's Site URL.
export const CONTROL_REJECTED = "drafto://factory-probe-not-allowlisted";
// Used as the allowed control only when base has no exact custom-scheme entry.
export const FALLBACK_CONTROL_ALLOWED = "drafto://reset-password";
const PROBE_TIMEOUT_MS = 8_000;

// Tables that configure only the local `supabase start` stack, so changing them
// needs nothing in the hosted projects. Every other table counts as hosted,
// including ones this list doesn't know, so a mistake here asks for the label
// rather than letting an unapplied change through. `[db.settings]` and
// `[db.network_restrictions]` are hosted: `supabase config push` applies them.
const LOCAL_ONLY_TABLES = new Set([
  "studio",
  "inbucket",
  "analytics",
  "edge_runtime",
  "edge_runtime.secrets",
  "db.migrations",
  "db.seed",
]);
// Local-only keys inside tables that otherwise count ("" is the top level).
const LOCAL_ONLY_KEYS = new Map([
  ["", new Set(["project_id"])],
  ["db", new Set(["port", "shadow_port", "health_timeout"])],
]);

// ── config.toml parsing ─────────────────────────────────────────────────────

// Character span of the `[auth] additional_redirect_urls = [ … ]` value, from
// the key to the closing bracket, or null when the key is absent. A small
// scanner rather than a TOML library: it only has to find one array of basic or
// literal strings, skipping `#` comments.
function redirectArraySpan(text) {
  let table = "";
  let offset = 0;
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/);
    if (header) table = header[1].trim();
    if (table === "auth" && /^\s*additional_redirect_urls\s*=\s*\[/.test(line)) {
      const open = offset + line.indexOf("[");
      const end = scanArray(text, open);
      return end === -1 ? null : { start: offset, open, end };
    }
    offset += line.length + 1;
  }
  return null;
}

// Index just past the `]` that closes the array opened at `open`, or -1.
function scanArray(text, open) {
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl;
    } else if (c === '"' || c === "'") {
      i = skipString(text, i);
      if (i === -1) return -1;
    } else if (c === "]") {
      return i + 1;
    }
  }
  return -1;
}

// Index of the closing quote of the string opening at `i`, or -1.
function skipString(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (quote === '"' && text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === quote) return j;
    if (text[j] === "\n") return -1;
  }
  return -1;
}

export function parseRedirectUrls(text) {
  const span = redirectArraySpan(text ?? "");
  if (!span) return [];
  const body = text.slice(span.open + 1, span.end - 1);
  const urls = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "#") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl;
    } else if (c === '"' || c === "'") {
      const close = skipString(body, i);
      if (close === -1) break;
      const raw = body.slice(i + 1, close);
      urls.push(c === '"' ? raw.replace(/\\(["\\])/g, "$1") : raw);
      i = close;
    }
  }
  return urls;
}

export function addedRedirectUrls(baseText, headText) {
  const base = new Set(parseRedirectUrls(baseText));
  return parseRedirectUrls(headText).filter((url) => !base.has(url));
}

// A line with any `#` comment outside a string removed.
function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === "'") {
      const close = skipString(line, i);
      if (close === -1) return line;
      i = close;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

// The hosted-relevant settings, one normalised line each: the redirect array,
// comments, blank lines, spacing and local-only tables removed. Two files with
// the same result need the same thing from the hosted projects.
function hostedSettings(text) {
  let rest = text ?? "";
  const span = redirectArraySpan(rest);
  if (span) rest = rest.slice(0, span.start) + rest.slice(span.end);
  const out = [];
  let table = "";
  for (const raw of rest.split("\n")) {
    const line = stripComment(raw).trim();
    if (line === "") continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      table = header[1].trim();
      if (!LOCAL_ONLY_TABLES.has(table)) out.push(`[${table}]`);
      continue;
    }
    if (LOCAL_ONLY_TABLES.has(table)) continue;
    const key = line.split("=")[0].trim();
    if (LOCAL_ONLY_KEYS.get(table)?.has(key)) continue;
    out.push(line.replace(/\s*=\s*/, " = ").replace(/\s+/g, " "));
  }
  return out.join("\n");
}

export function nonRedirectConfigChanged(baseText, headText) {
  return hostedSettings(baseText) !== hostedSettings(headText);
}

// ── probing ─────────────────────────────────────────────────────────────────

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// A concrete URL that an allowlist entry matches. Supabase matches entries as
// globs in which `*` stops at `.` and `/` and `**` doesn't; `?` matches any one
// character, so a literal `?` matches it. Returns null when the entry can't be
// sampled: character classes, alternations, or a sample that isn't a valid URL
// (such as a `*` in a port).
export function probeUrlFor(entry) {
  if (/[[\]{}\\]/.test(entry)) return null;
  const sample = entry.replaceAll("**", "probe/x").replaceAll("*", "probe");
  return parseUrl(sample) ? sample : null;
}

function sameTarget(a, b) {
  return (
    a.protocol === b.protocol &&
    a.host === b.host &&
    a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "")
  );
}

// Where did /verify send the probe? GoTrue keeps the sample's own query and
// adds its error parameters, and may add a `/` before the query. `siteUrl` is
// where the project sends a rejected redirect_to.
export function classifyProbe(sampleUrl, location, siteUrl) {
  if (!location) return { result: "error", detail: "no Location header" };
  const want = parseUrl(sampleUrl);
  const got = parseUrl(location);
  const site = parseUrl(siteUrl);
  if (!want || !got || !site) return { result: "error", detail: `unparseable URL: ${location}` };
  if (sameTarget(want, got)) {
    for (const [key, value] of want.searchParams) {
      if (got.searchParams.get(key) !== value) {
        return { result: "error", detail: `redirect dropped ?${key}: ${location}` };
      }
    }
    return { result: "allowed" };
  }
  if (sameTarget(site, got)) return { result: "rejected" };
  return { result: "error", detail: `unexpected redirect: ${location}` };
}

// One /verify request. Returns { location } or { error }.
async function verifyOnce({ ref, url, fetchImpl, timeoutMs }) {
  const token = `pkce_${randomBytes(16).toString("hex")}`;
  const target =
    `https://${ref}.supabase.co/auth/v1/verify?token=${token}&type=recovery` +
    `&redirect_to=${encodeURIComponent(url)}`;
  let response;
  try {
    response = await fetchImpl(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { error: `request failed: ${err?.message ?? err}`, retry: !timedOut };
  }
  try {
    await response.body?.cancel?.();
  } catch {
    // The body is never read; failing to discard it changes nothing.
  }
  if (response.status < 300 || response.status >= 400) {
    return { error: `HTTP ${response.status}`, retry: false };
  }
  return { location: response.headers.get("location") };
}

// A dropped connection gets one retry. A timeout or a 429 doesn't: retrying
// straight into the same rate limit only spends more of it.
export async function probeLocation(args) {
  const first = await verifyOnce(args);
  return first.error && first.retry ? verifyOnce(args) : first;
}

// An exact custom-scheme entry already on base, which must come back allowed.
function allowedControl(baseUrls) {
  const exact = baseUrls.find((url) => {
    if (url.includes("*") || probeUrlFor(url) === null) return false;
    return !["http:", "https:"].includes(parseUrl(url)?.protocol);
  });
  return exact ?? FALLBACK_CONTROL_ALLOWED;
}

// Probe one project: controls first, then every entry, all in parallel.
async function checkProject(project, { entries, controlAllowed, fetchImpl, timeoutMs }) {
  const probe = (url) => probeLocation({ ref: project.ref, url, fetchImpl, timeoutMs });
  const tag = { project: project.name, ref: project.ref };
  const [rejected, allowed] = await Promise.all([probe(CONTROL_REJECTED), probe(controlAllowed)]);

  // The rejected control's redirect is this project's Site URL.
  const siteUrl = rejected.location ? parseUrl(rejected.location) : null;
  const controlProblem = rejected.error
    ? `${CONTROL_REJECTED}: ${rejected.error}`
    : !siteUrl
      ? `${CONTROL_REJECTED}: no usable redirect (${rejected.location ?? "none"})`
      : sameTarget(parseUrl(CONTROL_REJECTED), siteUrl)
        ? `${CONTROL_REJECTED} was accepted`
        : allowed.error
          ? `${controlAllowed}: ${allowed.error}`
          : classifyProbe(controlAllowed, allowed.location, siteUrl.href).result !== "allowed"
            ? `${controlAllowed} was not accepted (${allowed.location ?? "no redirect"})`
            : null;
  if (controlProblem) {
    return {
      missing: [],
      errors: [{ ...tag, detail: `control probes misbehaved: ${controlProblem}` }],
    };
  }

  const outcomes = await Promise.all(
    entries.map(async (entry) => {
      const sample = probeUrlFor(entry);
      const answer = await probe(sample);
      return answer.error
        ? { entry, result: "error", detail: answer.error }
        : { entry, ...classifyProbe(sample, answer.location, siteUrl.href) };
    }),
  );
  return {
    missing: outcomes
      .filter((o) => o.result === "rejected")
      .map((o) => ({ ...tag, entry: o.entry })),
    errors: outcomes
      .filter((o) => o.result === "error")
      .map((o) => ({ ...tag, entry: o.entry, detail: o.detail })),
  };
}

export async function checkHostedConfig({
  baseText,
  headText,
  prLabels = [],
  fetchImpl = fetch,
  projects = HOSTED_PROJECTS,
  timeoutMs = PROBE_TIMEOUT_MS,
}) {
  const added = addedRedirectUrls(baseText, headText);
  const unprobeable = added.filter((url) => probeUrlFor(url) === null);
  const probeable = added.filter((url) => probeUrlFor(url) !== null);
  const nonRedirectChange = nonRedirectConfigChanged(baseText, headText);
  const labelled = prLabels.includes(APPLIED_LABEL);
  const needsLabel = (nonRedirectChange || unprobeable.length > 0) && !labelled;
  const missing = [];
  const errors = [];

  if (probeable.length > 0) {
    const controlAllowed = allowedControl(parseRedirectUrls(baseText));
    const results = await Promise.all(
      projects.map((project) =>
        checkProject(project, { entries: probeable, controlAllowed, fetchImpl, timeoutMs }),
      ),
    );
    for (const result of results) {
      missing.push(...result.missing);
      errors.push(...result.errors);
    }
  }

  // A confirmed miss always holds: the label can't overrule the project itself.
  // An inconclusive probe can be overruled, because the label is the operator
  // saying the change is applied; without that escape a probe that keeps
  // failing would hold the card for good.
  const status =
    missing.length > 0 || needsLabel ? "hold" : errors.length > 0 && !labelled ? "unknown" : "ok";
  return {
    status,
    added,
    missing,
    unprobeable,
    nonRedirectChange,
    labelled,
    needsLabel,
    errors,
  };
}

// ── the factory's issue comment ─────────────────────────────────────────────

const WHERE_SENTENCE = {
  "In Review":
    "The card stays in **In Review**: no test scenario and no beta builds, which run against production, until this is done.",
  Approved: "The factory won't merge it, and the card stays in **Approved**.",
  beta: "The factory won't build betas of this commit, which run against production, until this is done.",
};

function dashboardUrl(ref) {
  return `https://supabase.com/dashboard/project/${ref}/auth/url-configuration`;
}

// Markdown for the hold / unverified comment. The caller appends its marker.
export function holdComment(result, { pr, where = "In Review" } = {}) {
  const prRef = pr ? `PR #${pr}` : "This PR";
  const whereSentence = WHERE_SENTENCE[where] ?? "";

  if (result.status === "unknown") {
    const reasons = result.errors.map(
      (e) => `- **${e.project}**${e.entry ? ` \`${e.entry}\`` : ""}: ${e.detail}`,
    );
    return [
      "🏭 **Hold — couldn't verify the hosted Supabase config.**",
      "",
      `${prRef} changes \`supabase/config.toml\`, and the factory couldn't confirm that the hosted projects match it. ${whereSentence}`,
      "",
      ...reasons,
      "",
      `It retries every cycle. If this persists, run \`pnpm hosted-config:check\` on the Mac mini. If you have checked both projects by hand, the **\`${APPLIED_LABEL}\`** label on ${prRef} overrides an inconclusive check, but never a confirmed missing entry (ADR-0065).`,
    ].join("\n");
  }

  const lines = [
    "🏭 **Hold — the hosted Supabase config doesn't match this PR yet.**",
    "",
    `${prRef} changes \`supabase/config.toml\`, and the hosted projects don't have all of it. ${whereSentence}`,
  ];

  if (result.missing.length > 0) {
    lines.push(
      "",
      "**Add these Redirect URLs** under Authentication → URL Configuration → Redirect URLs. Keep the existing entries, because installed builds still use them.",
      "",
    );
    const refs = [...new Set(result.missing.map((m) => m.ref))];
    for (const ref of refs) {
      const entries = result.missing.filter((m) => m.ref === ref);
      lines.push(
        `- **${entries[0].project}** (\`${ref}\`, [dashboard](${dashboardUrl(ref)})):`,
        ...entries.map((m) => `  - \`${m.entry}\``),
      );
    }
  }

  if (result.needsLabel) {
    const what = [];
    if (result.nonRedirectChange)
      what.push("the settings it changes outside `additional_redirect_urls`");
    if (result.unprobeable.length > 0) {
      what.push(
        `these Redirect URLs, which the check can't probe: ${result.unprobeable.map((u) => `\`${u}\``).join(", ")}`,
      );
    }
    lines.push(
      "",
      `**Apply the rest of the \`config.toml\` change by hand** to dev and prod: ${what.join("; and ")}. Then add the **\`${APPLIED_LABEL}\`** label to ${prRef}. The label covers this version of \`config.toml\`; if a later commit changes the file, the factory removes it and asks again.`,
    );
  }

  lines.push(
    "",
    "Don't use `supabase config push`: it pushes the whole file and would overwrite settings that differ on prod, such as its SMTP.",
    "",
    "The factory re-checks every cycle and carries on by itself once this is done. To check by hand, run `pnpm hosted-config:check` (ADR-0065).",
  );
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readConfig(flags, side) {
  const file = flags[`${side}-file`];
  if (file !== undefined) return readFileSync(file, "utf8");
  let ref = flags[`${side}-ref`];
  if (ref === undefined) throw new Error(`Pass --${side}-file or --${side}-ref`);
  // The base is where the branch left main, not main's tip: anything main
  // gained since is not this branch's change.
  if (side === "base" && flags["head-ref"] !== undefined) {
    try {
      ref = git(["merge-base", ref, flags["head-ref"]]).trim();
    } catch (err) {
      throw new Error(
        `git merge-base ${ref} ${flags["head-ref"]} failed: ${String(err.stderr).trim()}`,
      );
    }
  }
  try {
    return git(["show", `${ref}:${CONFIG_PATH}`]);
  } catch (err) {
    // A ref without the file has nothing in it; a ref that doesn't resolve is an error.
    if (/does not exist in|exists on disk, but not in/.test(String(err.stderr))) return "";
    throw new Error(`git show ${ref}:${CONFIG_PATH} failed: ${String(err.stderr).trim()}`);
  }
}

const EXIT = { ok: 0, hold: 3, unknown: 4 };

async function main(argv) {
  let flags;
  let positional;
  try {
    ({ flags, positional } = parseFlags(argv.filter((arg) => arg !== "--")));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (positional[0] !== "check") {
    process.stderr.write(
      "Usage: hosted-config.mjs check (--base-file F | --base-ref R) (--head-file F | --head-ref R)\n" +
        "         [--labels a,b] [--pr N] [--where 'In Review'|Approved|beta]\n" +
        "With both refs, the base is their merge-base. Prints JSON.\n" +
        "Exit 0 ok, 3 hold, 4 unknown, 2 usage error.\n",
    );
    return 2;
  }
  let baseText;
  let headText;
  try {
    baseText = readConfig(flags, "base");
    headText = readConfig(flags, "head");
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const prLabels = (flags.labels ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const result = await checkHostedConfig({ baseText, headText, prLabels });
  const comment =
    result.status === "ok" ? "" : holdComment(result, { pr: flags.pr, where: flags.where });
  process.stdout.write(`${JSON.stringify({ ...result, comment })}\n`);
  process.stderr.write(
    `hosted-config: ${result.status}` +
      ` (added ${result.added.length}, missing ${result.missing.length},` +
      ` needs label ${result.needsLabel}, errors ${result.errors.length})\n`,
  );
  return EXIT[result.status];
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
