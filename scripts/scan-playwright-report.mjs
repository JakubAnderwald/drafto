#!/usr/bin/env node
// Refuses to publish a Playwright report that carries a credential.
//
// When web E2E fails, CI uploads apps/web/playwright-report as an artifact, and
// anyone can download the artifacts of this public repo. The report used to
// leak the E2E password three ways: `Fill "<password>"` step titles, the
// failure snapshot (error-context.md) showing the password field's value, and
// traces, which record request bodies and the Supabase session cookie. The
// specs now keep secrets out (apps/web/e2e/helpers/secret-fields.ts) and CI
// records no traces. This scan is the backstop: if a leak comes back, the
// report isn't uploaded.
//
// Usage:
//   node scripts/scan-playwright-report.mjs <report-dir>
//
// Every file is checked, including the zip the HTML report embeds in its
// index.html and any trace archive, for the values of SECRET_ENV_VARS and for
// Supabase session tokens. Findings name the file and what matched, never the
// value. Exits 1 on any finding, including an archive it can't read.

import { promises as fs } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
// Session tokens are minted per run, so they're matched by shape, with the
// factory browser runner's patterns: JWTs, bearer headers, access/refresh
// tokens, the Supabase auth cookie and the like.
import { SECRET_PATTERNS, literalForms } from "./lib/browser-report.mjs";
import { isMainModule } from "./lib/is-main.mjs";

export const SECRET_ENV_VARS = [
  "E2E_TEST_PASSWORD",
  "E2E_ADMIN_PASSWORD",
  "SUPABASE_SERVICE_ROLE_KEY",
];

// The HTML report inlines its data as a base64 zip in index.html.
const EMBEDDED_ZIP = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/g;

const END_OF_CENTRAL_DIRECTORY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

/** Labels for everything in `text` that looks like a credential. */
export function findCredentials(text, secrets) {
  const found = [];
  for (const { name, value } of secrets) {
    // As typed, URL-encoded and JSON-escaped, the forms a report can hold.
    if (literalForms(value).some((form) => text.includes(form))) found.push(name);
  }
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) found.push(label);
  }
  return found;
}

/**
 * The entries of a zip archive, as `{ name, data }`. Playwright writes plain
 * zips (stored or deflated, no zip64), and that is all this reads: anything
 * else throws.
 */
export function readZipEntries(buffer) {
  const end = buffer.lastIndexOf(END_OF_CENTRAL_DIRECTORY);
  if (end < 0 || end + 22 > buffer.length) throw new Error("not a zip archive");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error("corrupt central directory");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (size === ZIP64_MARKER || local === ZIP64_MARKER) throw new Error(`zip64 entry ${name}`);
    if (buffer.readUInt32LE(local) !== LOCAL_FILE_HEADER) throw new Error(`corrupt entry ${name}`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + size > buffer.length) throw new Error(`truncated entry ${name}`);
    const raw = buffer.subarray(start, start + size);
    if (method === 0) entries.push({ name, data: raw });
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`unsupported compression method ${method} for ${name}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// Every path under `dir`, marked `regular: false` for anything that isn't a
// plain file or directory. The upload follows symlinks, so those can't be
// skipped, and they're reported rather than scanned.
async function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const file = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(dir, file)));
    else files.push({ file, regular: entry.isFile() });
  }
  return files;
}

/**
 * Every credential found under `dir`, as `{ file, found }`. `file` is relative
 * to `dir`; `a.zip!b.json` is an entry inside an archive, and
 * `index.html#embedded!c.json` one inside the zip the HTML report inlines.
 */
export async function scanReport(dir, secrets) {
  const findings = [];
  const scanArchive = (file, buffer) => {
    let entries;
    try {
      entries = readZipEntries(buffer);
    } catch (err) {
      findings.push({ file, found: [`unreadable archive (${err.message})`] });
      return;
    }
    for (const entry of entries) {
      const entryFile = `${file}!${entry.name}`;
      if (entry.name.endsWith(".zip")) scanArchive(entryFile, entry.data);
      else scanContent(entryFile, entry.data);
    }
  };
  const scanContent = (file, buffer) => {
    const text = buffer.toString("utf8");
    const found = findCredentials(text, secrets);
    if (found.length > 0) findings.push({ file, found });
    for (const match of text.matchAll(EMBEDDED_ZIP)) {
      scanArchive(`${file}#embedded`, Buffer.from(match[1], "base64"));
    }
  };
  for (const { file, regular } of await listFiles(dir)) {
    if (!regular) {
      findings.push({ file, found: ["not a regular file (symlink or special file)"] });
      continue;
    }
    const buffer = await fs.readFile(path.join(dir, file));
    if (file.endsWith(".zip")) scanArchive(file, buffer);
    else scanContent(file, buffer);
  }
  return findings;
}

async function main(argv) {
  const [dir] = argv;
  if (!dir) throw new Error("usage: scan-playwright-report.mjs <report-dir>");
  // Only a missing report means there's nothing to upload. Any other error
  // (permissions, a file in its place) fails the scan, which blocks the upload.
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    process.stdout.write(`No Playwright report at ${dir}; nothing to scan.\n`);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  const secrets = SECRET_ENV_VARS.filter((name) => process.env[name]).map((name) => ({
    name,
    value: process.env[name],
  }));
  const findings = await scanReport(dir, secrets);
  if (findings.length === 0) {
    process.stdout.write(`No credentials found in ${dir}.\n`);
    return;
  }
  process.stderr.write(
    `Not uploading the Playwright report: ${dir} contains credentials.\n` +
      findings.map(({ file, found }) => `  ${file}: ${found.join(", ")}\n`).join("") +
      "Enter credentials with fillSecret() (apps/web/e2e/helpers/secret-fields.ts), " +
      "and keep traces off on CI.\n",
  );
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`scan-playwright-report: ${err.message}\n`);
    process.exit(1);
  });
}
