#!/usr/bin/env node
// Migration safety: snapshot DB row counts before/after a `supabase db push`,
// diff them, and surface any unexpected data loss. Runs from a Claude Code
// hook (.claude/hooks/migration-stats-{pre,post}.sh) or directly from the CLI.
//
// Usage:
//   node scripts/migration-stats.mjs pre
//   node scripts/migration-stats.mjs post
//
// `pre` writes a snapshot to /tmp/drafto-migration-stats-pre-<ref>.json.
// `post` re-snapshots, diffs against the matching pre file, and prints a
// [MIGRATION SAFETY] report to stderr. Exit code is always 0 — this is an
// observability tool, not a guard. If you want to actually block a push,
// react to the report.
//
// Behavior on missing inputs:
//   - No linked project (supabase/.temp/project-ref absent): prints a
//     dimmed [MIGRATION SAFETY] note and exits 0. Don't block migrations
//     just because the snapshot couldn't run.
//   - No service-role key: same.
//   - Network failure: same. Best-effort, fail-open.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_REF_FILE = path.join(REPO_ROOT, "supabase", ".temp", "project-ref");
const KEY_FILE = path.join(os.homedir(), "drafto-secrets", "supabase service keys.txt");

// Tables to snapshot. `keyAggregates` are PostgREST-friendly aggregations
// (just row count today; extend with an RPC if/when content-size totals
// matter enough to be worth the schema change).
const TABLES = [
  "notes",
  "note_content_history",
  "notebooks",
  "attachments",
  "profiles",
  "api_keys",
];

// Drops that should always trigger an alert. Increases never alert
// (concurrent user activity is normal); only decreases.
const NEVER_DECREASE = new Set(["notes", "notebooks", "attachments", "profiles"]);

const COLOR = process.stderr.isTTY
  ? { red: "\x1b[31m", yellow: "\x1b[33m", dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m" }
  : { red: "", yellow: "", dim: "", reset: "", bold: "" };

function log(line) {
  process.stderr.write(`[MIGRATION SAFETY] ${line}\n`);
}

async function readProjectRef() {
  try {
    return (await fs.readFile(PROJECT_REF_FILE, "utf8")).trim();
  } catch {
    return null;
  }
}

async function readServiceKey(projectRef) {
  // The keys file uses "DEV: <key>" / "PROD: <key>" format. Map ref → tag.
  let raw;
  try {
    raw = await fs.readFile(KEY_FILE, "utf8");
  } catch {
    return null;
  }
  const tag = projectRef === "tbmjbxxseonkciqovnpl" ? "PROD" : "DEV";
  for (const line of raw.split("\n")) {
    if (line.startsWith(`${tag}:`)) return line.slice(tag.length + 1).trim();
  }
  return null;
}

async function tableCount(projectRef, key, table) {
  // PostgREST exact count via Prefer header. select=id&limit=0 minimises
  // payload — we only need the Content-Range header.
  const url = `https://${projectRef}.supabase.co/rest/v1/${table}?select=id&limit=0`;
  const resp = await fetch(url, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      Prefer: "count=exact",
    },
  });
  if (!resp.ok) {
    return { error: `HTTP ${resp.status} ${await resp.text().catch(() => "")}` };
  }
  // Content-Range looks like "0-0/<total>" or "*/<total>" when empty.
  const range = resp.headers.get("content-range") ?? "";
  const match = range.match(/\/(\d+|\*)$/);
  if (!match || match[1] === "*") return { error: `unparsable Content-Range: ${range}` };
  return { count: Number(match[1]) };
}

async function snapshot(projectRef, key) {
  const stats = {
    project_ref: projectRef,
    captured_at: new Date().toISOString(),
    tables: {},
  };
  await Promise.all(
    TABLES.map(async (table) => {
      stats.tables[table] = await tableCount(projectRef, key, table);
    }),
  );
  return stats;
}

function snapshotPath(projectRef, mode) {
  return path.join(os.tmpdir(), `drafto-migration-stats-${mode}-${projectRef}.json`);
}

function describeProject(ref) {
  if (ref === "tbmjbxxseonkciqovnpl")
    return `${COLOR.red}${COLOR.bold}PROD (drafto.eu)${COLOR.reset}`;
  if (ref === "huhzactreblzcogqkbsd") return `${COLOR.dim}dev${COLOR.reset}`;
  return ref;
}

function diffSnapshots(pre, post) {
  const lines = [];
  let alerts = 0;
  for (const table of TABLES) {
    const a = pre.tables[table];
    const b = post.tables[table];
    if (a?.error || b?.error) {
      lines.push(`  ${table}: skipped (${a?.error ?? ""}${b?.error ? ` / ${b.error}` : ""})`);
      continue;
    }
    const before = a.count;
    const after = b.count;
    const delta = after - before;
    let marker = "";
    if (delta < 0 && NEVER_DECREASE.has(table)) {
      marker = ` ${COLOR.red}${COLOR.bold}⚠ DECREASE${COLOR.reset}`;
      alerts += 1;
    } else if (delta < 0) {
      marker = ` ${COLOR.yellow}↓${COLOR.reset}`;
    } else if (delta > 0) {
      marker = ` ${COLOR.dim}+${delta}${COLOR.reset}`;
    } else {
      marker = ` ${COLOR.dim}=${COLOR.reset}`;
    }
    lines.push(`  ${table.padEnd(22)} ${before} → ${after}${marker}`);
  }
  return { lines, alerts };
}

async function cmdPre() {
  const ref = await readProjectRef();
  if (!ref) {
    log(`${COLOR.dim}skip pre-snapshot: no linked project${COLOR.reset}`);
    return;
  }
  const key = await readServiceKey(ref);
  if (!key) {
    log(`${COLOR.dim}skip pre-snapshot: no service-role key for ${ref}${COLOR.reset}`);
    return;
  }
  const stats = await snapshot(ref, key);
  await fs.writeFile(snapshotPath(ref, "pre"), JSON.stringify(stats, null, 2));
  const counts = Object.entries(stats.tables)
    .map(([t, v]) => `${t}=${v.count ?? "?"}`)
    .join(" ");
  log(`pre-snapshot taken on ${describeProject(ref)} (${counts})`);
}

async function cmdPost() {
  const ref = await readProjectRef();
  if (!ref) {
    log(`${COLOR.dim}skip post-snapshot: no linked project${COLOR.reset}`);
    return;
  }
  const key = await readServiceKey(ref);
  if (!key) {
    log(`${COLOR.dim}skip post-snapshot: no service-role key for ${ref}${COLOR.reset}`);
    return;
  }

  let pre;
  try {
    pre = JSON.parse(await fs.readFile(snapshotPath(ref, "pre"), "utf8"));
  } catch {
    log(
      `${COLOR.yellow}post-snapshot: no matching pre-snapshot for ${ref}; running stand-alone post.${COLOR.reset}`,
    );
    const stats = await snapshot(ref, key);
    await fs.writeFile(snapshotPath(ref, "post"), JSON.stringify(stats, null, 2));
    return;
  }

  const post = await snapshot(ref, key);
  await fs.writeFile(snapshotPath(ref, "post"), JSON.stringify(post, null, 2));

  const ageSec = Math.round((Date.parse(post.captured_at) - Date.parse(pre.captured_at)) / 1000);
  log(`post-diff on ${describeProject(ref)} (window: ${ageSec}s)`);
  const { lines, alerts } = diffSnapshots(pre, post);
  for (const line of lines) process.stderr.write(`  ${line}\n`);
  if (alerts > 0) {
    log(
      `${COLOR.red}${COLOR.bold}⚠ ${alerts} table(s) lost rows that should never decrease. ` +
        `Review note_content_history for what was archived; restore from there if needed.${COLOR.reset}`,
    );
  } else {
    log(`${COLOR.dim}no row-count drops on protected tables${COLOR.reset}`);
  }
}

const mode = process.argv[2];
try {
  if (mode === "pre") await cmdPre();
  else if (mode === "post") await cmdPost();
  else {
    log("usage: migration-stats.mjs <pre|post>");
    process.exit(0);
  }
} catch (err) {
  // Never block migrations because the safety check itself errored.
  log(`${COLOR.yellow}safety-check error (ignored): ${err.message}${COLOR.reset}`);
  process.exit(0);
}
