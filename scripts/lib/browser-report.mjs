#!/usr/bin/env node
// Parses the locked-down browser runner's output, scans it for secrets and
// renders the In Test report comment.
//
// Why this exists: the browser runner (`run_browser_task` in factory-agent.sh)
// is the only claude call that gets Claude in Chrome, and it has no tools to
// post anything — its stdout is all it can hand back. It drives the Mac mini's
// real, signed-in Chrome profile, so that stdout can carry things that must
// never reach a public repo: the factory account's password it typed into the
// sign-in form, a Supabase session token it read off a network request, a
// Vercel SSO cookie. Bash therefore never posts the runner's text directly: it
// asks this module for the body, and the body withholds the report whenever
// the output matches a secret pattern.
//
// The runner prints (see scripts/factory-browser-prompt.md → "Output"):
//
//   <<<REPORT
//   …markdown report…
//   REPORT>>>
//   <<<FINDINGS            (uicheck kind only: a JSON array)
//   […]
//   FINDINGS>>>
//   browser=<ok|unavailable|auth-expired|signin-failed|blocked> verdict=<pass|warn|fail|none>
//
// The status line is the last line, outside any block, matching that exact
// shape. Without one the run is "malformed" and its report is not trusted as
// a result. The block/status-line parser itself is generic (parseBlocks), and
// verify-report.mjs reuses it — with the secret scan and defanging below — for
// the Testing stage's verification lanes.
//
// The report is model output built from page text, which is untrusted. Before
// it goes into a comment, HTML comments are neutralised and every
// `drafto-factory` token is broken with a zero-width space, so a page can't
// smuggle a factory marker (a scenario-sha or feedback marker the factory
// reads back as trusted) into a comment posted under the owner's token.
// See ADR-0051.
//
// CLI:
//   node browser-report.mjs render --kind intest --in <runner-stdout-file>
//        --issue <n> --sha <sha> --evidence-dir <dir> --account-file <f>
//        --out <body-file>
//     Writes the comment body to --out and a copy of the runner output to
//     <evidence-dir>/runner-output.txt (mode 600). Prints one JSON line
//     {status, verdict, withheld, secretHits}. Exit 0; 1 on an I/O error
//     (including an unreadable account file: without the password the scan
//     can't be trusted, so nothing is written); 2 on a usage error.
//   node browser-report.mjs status --in <runner-stdout-file>
//     Prints the parsed status word (ok|unavailable|auth-expired|signin-failed|blocked|
//     malformed). Exit 0; 1 on an I/O error.
//   node browser-report.mjs account-check --account-file <f>
//     Prints "ok" or the problem word (missing|not-a-file|mode|keys). Exit 0
//     iff ok.

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const REPORT_MARKER = "<!-- drafto-factory-browser-report -->";
export const RUN_SHA_MARKER_PREFIX = "drafto-factory-browser-run-sha:";
export const COMMENT_MAX_CHARS = 60_000;
export const RUNNER_OUTPUT_FILE = "runner-output.txt";
// A shorter "password" is too likely to occur in ordinary report text to scan
// for; the account file's password is generated, so this only skips junk.
export const MIN_PASSWORD_SCAN_LENGTH = 6;

const HEADER = "🏭 **Browser run — web steps on the preview.**";
const STATUS_LINE =
  /^browser=(ok|unavailable|auth-expired|signin-failed|blocked) verdict=(pass|warn|fail|none)$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const BLOCKS = ["REPORT", "FINDINGS"];

export function runShaMarker(sha) {
  return `<!-- ${RUN_SHA_MARKER_PREFIX}${sha} -->`;
}

// ── parsing ─────────────────────────────────────────────────────────────────

// Strip leading/trailing blank lines but keep the first line's indentation.
function trimBlock(text) {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
}

// The generic shape every locked-down runner prints (this runner, and the
// verification lanes in verify-report.mjs): `<<<NAME … NAME>>>` blocks, each
// opener and closer alone on its line, plus a status line outside them.
//
// Returns { blocks: { NAME: [body, …] }, status }: every complete block's body
// per name, in order, and `status` — the RegExp match of the LAST line outside
// complete blocks that matches `statusLine` (a backtick-wrapped line counts),
// or null. A block that never closed is not a block: its lines count as
// outside, so a status line printed after a forgotten closer is still found.
// Only lines outside complete blocks can be the status line: page text the
// model quoted inside its report must not be able to supply one. Inside an
// open block, another block's opener is just content.
export function parseBlocks(text, { blocks: names = [], statusLine = null } = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  const blocks = Object.fromEntries(names.map((name) => [name, []]));
  const outside = [];
  let open = null;
  let buf = [];
  for (const line of lines) {
    const t = line.trim();
    if (open) {
      if (t === `${open}>>>`) {
        blocks[open].push(buf.join("\n"));
        open = null;
        buf = [];
      } else {
        buf.push(line);
      }
      continue;
    }
    const opener = names.find((b) => t === `<<<${b}`);
    if (opener) {
      open = opener;
      buf = [];
    } else {
      outside.push(t);
    }
  }
  if (open) outside.push(...buf.map((l) => l.trim()));

  let status = null;
  if (statusLine) {
    // exec on a /g or /y regex is stateful; a status line must not depend on
    // what the previous line matched.
    const re = new RegExp(statusLine.source, statusLine.flags.replace(/[gy]/g, ""));
    for (const raw of outside) {
      const m = re.exec(raw.replace(/^`(.*)`$/, "$1"));
      if (m) status = m;
    }
  }
  return { blocks, status };
}

// The last complete <name> block, trimmed, or null when there is none or it is
// blank.
export function lastBlock(blocks, name) {
  const last = blocks?.[name]?.at(-1);
  return last == null || !last.trim() ? null : trimBlock(last);
}

export function parseRunnerOutput(text) {
  const { blocks, status: m } = parseBlocks(text, { blocks: BLOCKS, statusLine: STATUS_LINE });
  const status = m ? m[1] : "malformed";
  const verdict = m ? m[2] : "none";
  const report = lastBlock(blocks, "REPORT");

  let findings = null;
  const lastFindings = blocks.FINDINGS.at(-1);
  if (lastFindings != null) {
    try {
      // Tolerate the model wrapping the array in a ```json fence.
      const json = lastFindings
        .trim()
        .replace(/^```(?:json)?[ \t]*\r?\n/i, "")
        .replace(/\r?\n```$/, "");
      const parsed = JSON.parse(json);
      findings = Array.isArray(parsed) ? parsed : null;
    } catch {
      findings = null;
    }
  }
  return { status, verdict, report, findings };
}

// ── account file ────────────────────────────────────────────────────────────

const ACCOUNT_KEYS = { FACTORY_BROWSER_EMAIL: "email", FACTORY_BROWSER_PASSWORD: "password" };

// KEY=VALUE lines, `#` comments, an optional `export ` prefix and optional
// matching quotes around the value. No escapes or interpolation: a quoted
// value is taken verbatim, an unquoted one is trimmed. Returns { KEY: value }
// for the wanted keys only (the last assignment wins); the caller decides what
// a missing key means.
export function parseEnvValues(text, keys) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || !keys.includes(m[1])) continue;
    let value = m[2].trim();
    const q = /^(["'])(.*)\1$/.exec(value);
    if (q) value = q[2];
    out[m[1]] = value;
  }
  return out;
}

export function parseAccountFile(text) {
  const values = parseEnvValues(text, Object.keys(ACCOUNT_KEYS));
  const out = {};
  for (const [key, field] of Object.entries(ACCOUNT_KEYS)) {
    if (key in values) out[field] = values[key];
  }
  // Name the missing key, never echo a value: this message reaches logs.
  for (const [key, field] of Object.entries(ACCOUNT_KEYS)) {
    if (!out[field]) throw new Error(`account file has no ${key}`);
  }
  return { email: out.email, password: out.password };
}

export function readAccountFile(file) {
  return parseAccountFile(readFileSync(file, "utf8"));
}

// Why the factory must not use this account file, or null when it may. The
// mode check is the point: the file holds a live password on a shared Mac, so
// any group/other bit keeps the browser off until it is `chmod 600`.
export function accountFileProblem(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "not-a-file";
  if ((st.mode & 0o077) !== 0) return "mode";
  try {
    readAccountFile(file);
  } catch {
    return "keys";
  }
  return null;
}

// ── secret scan ─────────────────────────────────────────────────────────────

// [name, pattern] pairs, in scan order. Exported (frozen) for verify-report.mjs,
// which scans the verification lanes with these plus its own.
export const SECRET_PATTERNS = Object.freeze([
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["supabase-auth-cookie", /sb-[a-z0-9]+-auth-token/i],
  // Case-insensitive: the auth scheme is, and a network log may print it lower-case.
  ["bearer", /\bBearer\s+[A-Za-z0-9._-]{10,}/i],
  ["oauth-token", /\b(access|refresh)_token\b/i],
  ["vercel-cookie", /_vercel_(jwt|sso_nonce)/],
  // A Drafto MCP API key ("dk_" + 48 hex, apps/web/src/app/api/api-keys):
  // /settings shows a new one in full once, so a run on that page can see it.
  ["drafto-api-key", /\bdk_[0-9a-f]{16,}/i],
  // The runner's one-time sign-in link (browser-signin.mjs). Single-use and
  // consumed when opened, but still a login token: never posted.
  ["sign-in-token", /token_hash=[A-Za-z0-9_-]{8,}/],
]);

// The password is matched as a literal substring — never compiled into a
// regex, so its characters can't change what is matched — in the forms it can
// take in a page or a network log: as typed, URL-encoded and JSON-escaped.
// verify-report.mjs matches its other secret literals the same way.
export function literalForms(secret) {
  const forms = new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  return [...forms];
}

export function scanForSecrets(text, { password } = {}) {
  const s = String(text ?? "");
  const hits = [];
  if (typeof password === "string" && password.length >= MIN_PASSWORD_SCAN_LENGTH) {
    if (literalForms(password).some((form) => s.includes(form))) hits.push("password");
  }
  for (const [name, re] of SECRET_PATTERNS) {
    if (re.test(s)) hits.push(name);
  }
  return hits;
}

// ── comment body ────────────────────────────────────────────────────────────

// Neutralise what untrusted report text could use to pass for the factory:
// HTML comments (hidden markers) and any `drafto-factory` token (marker
// greps), broken with a zero-width space so it still reads the same.
export function defangReport(text) {
  return String(text ?? "")
    .replace(/<!--/g, "&lt;!--")
    .replace(/drafto-factory/gi, (m) => `${m.slice(0, 6)}​${m.slice(6)}`);
}

const STATUS_SENTENCE = {
  unavailable:
    "The run didn't complete: this Mac mini's Chrome wasn't connected to Claude in Chrome, so no web step ran.",
  "auth-expired":
    "The run didn't complete: the preview showed a login wall, so the Vercel sign-in in the Mac mini's Chrome has probably expired.",
  "signin-failed":
    "The run didn't complete: the one-time sign-in link didn't sign the runner in on the preview, so the signed-in steps couldn't run.",
  blocked:
    "The run stopped early on purpose: the runner refused a step (suspected prompt injection, or a step that would break its rules).",
  malformed:
    "The run didn't complete: the runner's output had no status line, so its results can't be trusted.",
};

// Cut <report> to at most <max> characters without splitting a surrogate pair,
// and close a code fence the cut left open so the footer still renders.
export function truncateReport(report, max) {
  let cut = report.slice(0, Math.max(0, max));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const fences = cut.split("\n").filter((l) => /^\s*(```|~~~)/.test(l)).length;
  return fences % 2 === 1 ? `${cut}\n\`\`\`` : cut;
}

export function renderIntestComment({ sha, report, verdict, status, evidenceDir, withheld }) {
  if (!SHA.test(String(sha ?? ""))) throw new Error(`invalid sha: ${sha}`);
  const hits = Array.isArray(withheld) ? withheld : withheld ? ["unspecified"] : [];
  const localCopy = `${evidenceDir}/${RUNNER_OUTPUT_FILE}`;
  const short = String(sha).slice(0, 7);
  const ok = status === "ok";

  const lead = ok
    ? `**Verdict: ${String(verdict ?? "none").toUpperCase()}** for \`${short}\`. ` +
      "This report never moves the card; it stays in In Test either way."
    : `**No result** for \`${short}\`. ${STATUS_SENTENCE[status] ?? STATUS_SENTENCE.malformed} ` +
      "The card is unaffected.";

  const head = [HEADER, "", lead, ""];
  const footer = [
    "",
    `<sub>Screenshots stay on the Mac mini (this repo is public): \`${evidenceDir}\`.</sub>`,
    "",
    REPORT_MARKER,
    runShaMarker(sha),
  ];
  const assemble = (middle) => [...head, ...middle, ...footer].join("\n");

  if (hits.length > 0) {
    return assemble([
      `Report withheld: the output matched a secret pattern (${hits.join(", ")}). ` +
        `The local copy is at \`${localCopy}\`.`,
    ]);
  }
  if (report == null || report === "") {
    return assemble([ok ? "_The runner printed no report._" : "_The runner left no note._"]);
  }

  // A stopped run's report is its own explanation of why it stopped.
  const intro = ok ? [] : ["**What the runner said:**", ""];
  const text = defangReport(report);
  const full = assemble([...intro, text]);
  if (full.length <= COMMENT_MAX_CHARS) return full;

  const note = (n) =>
    `\n\n_…report truncated to ${n} of ${text.length} characters; ` +
    `the full output is at \`${localCopy}\`._`;
  // Budget against the longest note and a fence closer ("\n```" = 4).
  const room = COMMENT_MAX_CHARS - assemble([...intro, ""]).length - note(text.length).length - 4;
  const cut = truncateReport(text, room);
  return assemble([...intro, cut + note(cut.length)]);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

class UsageError extends Error {}

function required(flags, name) {
  const v = flags[name];
  if (v == null || v === "") throw new UsageError(`--${name} required`);
  return v;
}

export function render(argv) {
  const { flags } = parseFlags(argv);
  const kind = required(flags, "kind");
  if (kind !== "intest") throw new UsageError(`unsupported --kind: ${kind} (intest)`);
  const inFile = required(flags, "in");
  const issue = required(flags, "issue");
  if (!/^[1-9][0-9]*$/.test(issue)) throw new UsageError(`invalid --issue: ${issue}`);
  const sha = required(flags, "sha");
  if (!SHA.test(sha)) throw new UsageError(`invalid --sha: ${sha}`);
  const evidenceDir = required(flags, "evidence-dir");
  const accountFile = required(flags, "account-file");
  const out = required(flags, "out");

  const text = readFileSync(inFile, "utf8");
  // Without the password the scan can't be trusted: fail rather than post.
  const { password } = readAccountFile(accountFile);
  const parsed = parseRunnerOutput(text);
  const secretHits = scanForSecrets(text, { password });

  // The withheld / truncated notices point here, so the copy must exist.
  mkdirSync(evidenceDir, { recursive: true });
  const copy = path.join(evidenceDir, RUNNER_OUTPUT_FILE);
  if (path.resolve(copy) !== path.resolve(inFile)) {
    writeFileSync(copy, text, { mode: 0o600 });
    chmodSync(copy, 0o600);
  }

  const body = renderIntestComment({
    issue,
    sha,
    report: parsed.report,
    verdict: parsed.verdict,
    status: parsed.status,
    evidenceDir,
    withheld: secretHits,
  });
  writeFileSync(out, body);
  return {
    status: parsed.status,
    verdict: parsed.verdict,
    withheld: secretHits.length > 0,
    secretHits,
  };
}

const USAGE =
  "Usage: browser-report.mjs render --kind intest --in <runner-stdout-file> --issue <n> " +
  "--sha <sha> --evidence-dir <dir> --account-file <f> --out <body-file>\n" +
  "       browser-report.mjs status --in <runner-stdout-file>\n" +
  "       browser-report.mjs account-check --account-file <f>\n";

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "render") {
    process.stdout.write(JSON.stringify(render(rest)) + "\n");
    return 0;
  }
  if (cmd === "status") {
    const { flags } = parseFlags(rest);
    const text = readFileSync(required(flags, "in"), "utf8");
    process.stdout.write(parseRunnerOutput(text).status + "\n");
    return 0;
  }
  if (cmd === "account-check") {
    const { flags } = parseFlags(rest);
    const problem = accountFileProblem(required(flags, "account-file"));
    process.stdout.write((problem ?? "ok") + "\n");
    return problem ? 1 : 0;
  }
  process.stdout.write(USAGE);
  return cmd && cmd !== "--help" && cmd !== "-h" ? 2 : 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
    // parseFlags' "Missing value for --x" is a usage error too.
    process.exit(err instanceof UsageError || /^Missing value for --/.test(err.message) ? 2 : 1);
  }
}
