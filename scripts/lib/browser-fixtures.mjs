// Files the browser runner may upload (ADR-0073, FACTORY_BROWSER_UPLOADS=1).
//
// A scenario that uploads names its files in a `### Fixtures` section, one per
// bullet:
//
//   - small.jpg 1.5MB
//   - big.png 3MB
//   - notes.txt 2KB
//   - quota.enex notes=4 image=1MB     (an Evernote export: N notes, one image each)
//   - sample.enex                      (the repo's apps/web/e2e/fixtures/sample.enex)
//
// Bash generates them into the run's own fixtures/ directory (mode 700) before
// the session, and the guard lets file_upload take only regular files inside
// that directory. Images are valid (a 1×1 JPEG or PNG) padded after their end
// marker to the size asked for, which decoders ignore, so a quota or size
// limit sees the real byte count. Nothing here reads anything outside the
// repo's own fixture.
//
// CLI: <the Fixtures section's text on stdin> | node browser-fixtures.mjs make --out <dir>
//   → one JSON line: [{name, path, size}] (an empty list for no text), exit 0;
//   {error} and exit 2 for a bad spec. Bash pipes only the section's text, so
//   the bundle, which holds the one-time sign-in links, never touches disk.
//
// Claude in Chrome's file_upload takes at most 10 MB per call, so one file is
// at most 10 MB, and the runner uploads one file per call.

import * as nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const MAX_FIXTURE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_FIXTURES = 10;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(jpg|jpeg|png|txt|enex)$/;
const SIZE_RE = /^(\d+(?:\.\d+)?)(B|KB|MB)$/i;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLE_ENEX = path.join(REPO_ROOT, "apps", "web", "e2e", "fixtures", "sample.enex");

// A 1×1 white JPEG and a 1×1 transparent PNG.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export class FixtureSpecError extends Error {}

export function parseSize(text) {
  const m = SIZE_RE.exec(String(text ?? "").trim());
  if (!m) throw new FixtureSpecError(`not a size: ${String(text).slice(0, 20)} (use B, KB or MB)`);
  const unit = { b: 1, kb: 1024, mb: 1024 * 1024 }[m[2].toLowerCase()];
  const bytes = Math.round(Number(m[1]) * unit);
  if (bytes < 1 || bytes > MAX_FIXTURE_BYTES) {
    throw new FixtureSpecError(`size out of range (1 B to ${MAX_FIXTURE_BYTES / 1024 / 1024} MB)`);
  }
  return bytes;
}

/** The `### Fixtures` section's text → [{name, kind, bytes?, notes?, imageBytes?, sample?}]. */
export function parseFixtureSpecs(text) {
  const specs = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*]|\d+[.)])\s+`?([^`\s]+)`?(.*)$/.exec(raw);
    if (!m) continue;
    const name = m[1];
    const rest = m[2].trim().replace(/`/g, "");
    if (!NAME_RE.test(name)) throw new FixtureSpecError(`not a fixture name: ${name.slice(0, 64)}`);
    if (specs.some((s) => s.name === name)) throw new FixtureSpecError(`${name} is named twice`);
    const ext = name.split(".").pop().toLowerCase();
    if (ext === "enex" && rest === "" && name === "sample.enex") {
      specs.push({ name, kind: "sample" });
    } else if (ext === "enex") {
      const notes = /\bnotes=(\d{1,2})\b/.exec(rest);
      const image = /\bimage=(\S+)/.exec(rest);
      if (!notes || !image) {
        throw new FixtureSpecError(
          `${name}: an .enex needs notes=N image=SIZE (or use sample.enex)`,
        );
      }
      const n = Number(notes[1]);
      if (n < 1 || n > 20) throw new FixtureSpecError(`${name}: notes must be 1 to 20`);
      specs.push({ name, kind: "enex", notes: n, imageBytes: parseSize(image[1]) });
    } else {
      specs.push({ name, kind: ext === "jpeg" ? "jpg" : ext, bytes: parseSize(rest) });
    }
    if (specs.length > MAX_FIXTURES) throw new FixtureSpecError(`at most ${MAX_FIXTURES} fixtures`);
  }
  const total = specs.reduce(
    (n, s) => n + (s.bytes ?? 0) + (s.notes ?? 0) * (s.imageBytes ?? 0),
    0,
  );
  if (total > MAX_TOTAL_BYTES) throw new FixtureSpecError("fixtures total more than 100 MB");
  return specs;
}

/** An image of exactly <bytes> bytes (at least the tiny image's own size). */
export function paddedImage(kind, bytes) {
  const base = kind === "png" ? TINY_PNG : TINY_JPEG;
  if (bytes <= base.length) return base;
  return Buffer.concat([base, Buffer.alloc(bytes - base.length)]);
}

function enexFile(notes, imageBytes) {
  const image = paddedImage("jpg", imageBytes).toString("base64");
  const items = [];
  for (let i = 1; i <= notes; i++) {
    items.push(
      `<note><title>Fixture note ${i}</title>` +
        `<content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>Fixture note ${i}</div></en-note>]]></content>` +
        `<resource><data encoding="base64">${image}</data><mime>image/jpeg</mime>` +
        `<resource-attributes><file-name>fixture-${i}.jpg</file-name></resource-attributes></resource>` +
        `</note>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">\n` +
    `<en-export application="Drafto factory fixtures">${items.join("")}</en-export>\n`
  );
}

/** Writes each spec into <dir> (created mode 700); returns [{name, path, size}]. */
export function makeFixtures(specs, dir, { fs = nodeFs } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = [];
  for (const spec of specs) {
    const file = path.join(dir, spec.name);
    let data;
    if (spec.kind === "sample") data = fs.readFileSync(SAMPLE_ENEX);
    else if (spec.kind === "enex") data = Buffer.from(enexFile(spec.notes, spec.imageBytes));
    else if (spec.kind === "txt") data = Buffer.alloc(spec.bytes, "x");
    else data = paddedImage(spec.kind, spec.bytes);
    fs.writeFileSync(file, data, { mode: 0o600 });
    out.push({ name: spec.name, path: file, size: data.length });
  }
  return out;
}

export function main(argv, { fs = nodeFs, stdout = process.stdout, stdinText = null } = {}) {
  const [cmd, ...rest] = argv;
  const { flags } = parseFlags(rest);
  if (cmd !== "make" || !flags.out) {
    stdout.write(
      `${JSON.stringify({ error: "usage: make --out <dir> < fixtures-section.txt" })}\n`,
    );
    return 2;
  }
  try {
    const text = stdinText ?? fs.readFileSync(0, "utf8");
    const specs = parseFixtureSpecs(text);
    stdout.write(`${JSON.stringify(makeFixtures(specs, path.resolve(flags.out), { fs }))}\n`);
    return 0;
  } catch (err) {
    stdout.write(`${JSON.stringify({ error: err.message })}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
