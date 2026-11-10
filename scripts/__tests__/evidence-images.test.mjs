import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CAP_WHY,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  OCR_TIMEOUT_MS,
  OFF_ORIGIN_WHY,
  browserManifest,
  checkImage,
  helperOcr,
  macosManifest,
  ocrAvailable,
  rootProblem,
  selectImages,
} from "../lib/evidence-images.mjs";
import {
  CHROME_PREFIX,
  main as guardMain,
  runPostHook,
  runPreHook,
  runSessionStartHook,
} from "../lib/browser-guard.mjs";

// Locks in which screenshots of a factory test run may leave the Mac mini
// (ADR-0072). The repo is public and a screenshot is pixels the report's text
// secret scan never sees, so what is published rests on three things this
// file pins down:
//   - provenance: a browser run's images are exactly the files the guard's
//     copyEvidence copied, read from the guard's REAL decision log (the hooks
//     below are the guard's own runPostHook, so a change to the log's shape
//     fails here), and slot k stays the runner's "screenshot k" even when a
//     copy failed or was rejected; a macOS run's are its shots/NN-<label>.png;
//   - the per-file checks (no symlinks, real path inside the evidence dir,
//     regular file, size cap, extension + magic bytes), and that the bytes
//     checked are the bytes OCR-scanned and the bytes uploaded;
//   - the OCR secret scan and the per-comment cap, whose overflow names the
//     pattern that matched but never the matched text.
// CI runs on Ubuntu with no OCR helper: OCR is a stub or a fake executable.

const here = dirname(fileURLToPath(import.meta.url));
const LIB_URL = pathToFileURL(resolve(here, "..", "lib", "evidence-images.mjs")).href;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

// A real 1×1 PNG, for the "accepts a real image" cases.
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Image bytes with the right magic, a findable tag, padded to <size>. */
function imageBytes(magic, tag, size = 0) {
  const head = Buffer.concat([magic, Buffer.from(`tag:${tag};`)]);
  return size > head.length ? Buffer.concat([head, Buffer.alloc(size - head.length, 0x2e)]) : head;
}
const png = (tag, size) => imageBytes(PNG_MAGIC, tag, size);
const jpeg = (tag, size) => imageBytes(JPEG_MAGIC, tag, size);
const tagOf = (data) => /tag:([^;]*);/.exec(Buffer.from(data).toString("latin1"))?.[1] ?? null;

/**
 * A stub OCR that records its calls. <byTag> maps an image's tag to the
 * result to return; any other image reads as harmless app text.
 */
function fakeOcr(byTag = {}) {
  const calls = [];
  const ocr = (data, ext) => {
    calls.push({ data: Buffer.from(data), ext, tag: tagOf(data) });
    const tag = tagOf(data);
    return Object.hasOwn(byTag, tag) ? byTag[tag] : { ok: true, text: "Notebooks\nNew note" };
  };
  ocr.calls = calls;
  return ocr;
}

function mkfifo(p) {
  const r = spawnSync("mkfifo", [p], { encoding: "utf8" });
  assert.equal(r.status, 0, `mkfifo failed: ${r.stderr}`);
}

const HEX48 = "0123456789abcdef".repeat(3);
const API_KEY = `dk_${HEX48}`;

describe("evidence-images: the per-comment cap", () => {
  it("is 20 images / 20 MB, at most 5 MB an image, and CAP_WHY says so", () => {
    assert.equal(MAX_IMAGES, 20);
    assert.equal(MAX_TOTAL_BYTES, 20 * 1024 * 1024);
    assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
    assert.equal(CAP_WHY, "over the per-comment cap (20 images / 20 MB)");
  });
});

// ── checkImage ──────────────────────────────────────────────────────────────

describe("evidence-images: checkImage", () => {
  let tmp;
  let root;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-images-check-"));
    root = join(tmp, "evidence");
    mkdirSync(root, { mode: 0o700 });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const put = (name, data, dir = root) => {
    const p = join(dir, name);
    writeFileSync(p, data, { mode: 0o600 });
    return p;
  };

  it("accepts a real PNG and returns the exact bytes it read", () => {
    const p = put("screenshot-1-0.png", REAL_PNG);
    assert.deepEqual(checkImage(p, root), {
      ok: true,
      data: REAL_PNG,
      size: REAL_PNG.length,
      type: "png",
      ext: "png",
    });
  });

  it("accepts JPEG magic under .jpg and .jpeg, and publishes both as .jpg", () => {
    const bytes = jpeg("j");
    for (const name of ["screenshot-1-0.jpg", "shot.jpeg"]) {
      const r = checkImage(put(name, bytes), root);
      assert.equal(r.ok, true, name);
      assert.equal(r.type, "jpeg");
      assert.equal(r.ext, "jpg");
      assert.deepEqual(r.data, bytes);
    }
  });

  it("reads the extension case-insensitively", () => {
    const r = checkImage(put("SHOT.PNG", png("upper")), root);
    assert.equal(r.ok, true);
    assert.equal(r.ext, "png");
  });

  it("refuses a symlink, even one to a valid image inside the evidence dir", () => {
    const target = put("real.png", png("real"));
    symlinkSync(target, join(root, "link.png"));
    assert.deepEqual(checkImage(join(root, "link.png"), root), { ok: false, why: "a symlink" });
    const outside = put("outside.png", png("out"), tmp);
    symlinkSync(outside, join(root, "out.png"));
    assert.deepEqual(checkImage(join(root, "out.png"), root), { ok: false, why: "a symlink" });
  });

  it("refuses a file whose real path escapes through a symlinked subdirectory", () => {
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    put("secret.png", png("secret"), elsewhere);
    symlinkSync(elsewhere, join(root, "sub"));
    // lstat only looks at the last component, so this is a regular file to it.
    assert.deepEqual(checkImage(join(root, "sub", "secret.png"), root), {
      ok: false,
      why: "outside the evidence directory",
    });
  });

  it("refuses a path that climbs out with .., and a sibling dir sharing the root's prefix", () => {
    put("up.png", png("up"), tmp);
    assert.deepEqual(checkImage(join(root, "..", "up.png"), root), {
      ok: false,
      why: "outside the evidence directory",
    });
    const sibling = `${root}-other`;
    mkdirSync(sibling);
    const p = put("a.png", png("sib"), sibling);
    assert.deepEqual(checkImage(p, root), { ok: false, why: "outside the evidence directory" });
  });

  it("refuses a FIFO", () => {
    const p = join(root, "screenshot-1-0.png");
    mkfifo(p);
    assert.deepEqual(checkImage(p, root), { ok: false, why: "not a regular file" });
  });

  it("refuses a directory with an image name", () => {
    mkdirSync(join(root, "dir.png"));
    assert.deepEqual(checkImage(join(root, "dir.png"), root), {
      ok: false,
      why: "not a regular file",
    });
  });

  it("refuses an empty file", () => {
    assert.deepEqual(checkImage(put("empty.png", Buffer.alloc(0)), root), {
      ok: false,
      why: "empty",
    });
  });

  it("refuses a file over the size cap: 5 MB by default, or a smaller maxBytes", () => {
    const small = put("small.png", png("s", 64));
    const r = checkImage(small, root, { maxBytes: 63 });
    assert.equal(r.ok, false);
    assert.match(r.why, /^larger than \d+ (?:KB|MB)$/);
    assert.equal(checkImage(small, root, { maxBytes: 64 }).ok, true, "exactly the cap is fine");

    const big = put("big.png", png("b", MAX_IMAGE_BYTES + 1));
    assert.deepEqual(checkImage(big, root), { ok: false, why: "larger than 5 MB" });
    const atCap = put("at-cap.png", png("c", MAX_IMAGE_BYTES));
    assert.equal(checkImage(atCap, root).ok, true);
  });

  it("refuses bytes that don't match the extension", () => {
    assert.deepEqual(checkImage(put("png-bytes.jpg", png("p")), root), {
      ok: false,
      why: "its bytes aren't a JPEG image",
    });
    assert.deepEqual(checkImage(put("jpeg-bytes.png", jpeg("j")), root), {
      ok: false,
      why: "its bytes aren't a PNG image",
    });
    assert.deepEqual(checkImage(put("gif-bytes.png", Buffer.from("GIF89a\x01\x00")), root), {
      ok: false,
      why: "its bytes aren't a PNG image",
    });
    // A PNG magic cut short is not a PNG.
    assert.deepEqual(checkImage(put("short.png", PNG_MAGIC.subarray(0, 4)), root), {
      ok: false,
      why: "its bytes aren't a PNG image",
    });
  });

  it("refuses a non-image extension before it touches the disk", () => {
    for (const name of ["a.gif", "a.txt", "a.svg", "a.png.txt", "a", "runner-output.txt"]) {
      const p = put(name, png("n"));
      assert.deepEqual(checkImage(p, root), { ok: false, why: "not a .png or .jpg file" }, name);
    }
    // Nothing on disk at all: still the extension's answer.
    assert.deepEqual(checkImage(join(root, "nope.webp"), root), {
      ok: false,
      why: "not a .png or .jpg file",
    });
  });

  it("refuses a missing file", () => {
    assert.deepEqual(checkImage(join(root, "gone.png"), root), { ok: false, why: "missing" });
  });

  it("refuses a file swapped for another between the lstat and the open", () => {
    const p = put("swapped.png", png("w"));
    // An lstat that saw a different inode than the fd that gets opened.
    const fs = {
      ...nodeFs,
      lstatSync: (file, ...rest) => {
        const st = nodeFs.lstatSync(file, ...rest);
        if (file !== p) return st;
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1 });
      },
    };
    assert.deepEqual(checkImage(p, root, { fs }), {
      ok: false,
      why: "it changed while it was being checked",
    });
  });

  it("a file swapped for a FIFO after the lstat can't hang the open", () => {
    const fifo = join(root, "fifo.png");
    mkfifo(fifo);
    const decoy = put("decoy.png", png("d"));
    // In a child with a timeout: a blocking open of a FIFO would block the
    // event loop, so an in-process test could never time out.
    const script = `
      import * as fs from "node:fs";
      import { checkImage } from ${JSON.stringify(LIB_URL)};
      const [fifo, decoy, root] = process.argv.slice(1);
      const fake = { ...fs, lstatSync: (p, ...r) => fs.lstatSync(p === fifo ? decoy : p, ...r) };
      process.stdout.write(JSON.stringify(checkImage(fifo, root, { fs: fake })));
    `;
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, fifo, decoy, root],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(r.status, 0, `the open hung or crashed: ${r.signal ?? ""} ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, why: "not a regular file" });
  });
});

// ── rootProblem ─────────────────────────────────────────────────────────────

describe("evidence-images: rootProblem", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-images-root-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("accepts a real directory", () => {
    mkdirSync(join(tmp, "evidence"));
    assert.equal(rootProblem(join(tmp, "evidence")), null);
  });

  it("refuses a symlinked evidence dir, even one pointing at a real directory", () => {
    mkdirSync(join(tmp, "real"));
    symlinkSync(join(tmp, "real"), join(tmp, "evidence"));
    assert.equal(rootProblem(join(tmp, "evidence")), "the evidence directory is a symlink");
  });

  it("refuses a missing dir and a regular file", () => {
    assert.equal(rootProblem(join(tmp, "nope")), "the evidence directory is missing");
    writeFileSync(join(tmp, "file"), "x");
    assert.equal(rootProblem(join(tmp, "file")), "the evidence directory is not a directory");
  });
});

// ── browserManifest, from the real guard ────────────────────────────────────

describe("evidence-images: browserManifest reads the real guard's decision log", () => {
  const SID = "e0000000-0000-4000-8000-000000000797";
  const DEVICE = "9796912b-8977-4d74-9c08-d9bb283b9496";
  const PREVIEW = "https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app";
  const TAB = 1264169916;
  const T = (short) => `${CHROME_PREFIX}${short}`;
  const text = (t) => ({ type: "text", text: t });
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const tabContext =
    `\n\nTab Context:\n- Executed on tabId: ${TAB}\n- Available tabs:\n` +
    `  • tabId ${TAB}: "Log in — Drafto" (${JSON.stringify(`${PREVIEW}/login`)})`;

  let tmp;
  let tmpRoot;
  let shotDir;
  let cfgPath;
  let dirs;
  let logText;
  let useId = 0;
  // What each copied source held when the guard copied it, by copied name.
  const copiedBytes = new Map();

  const payload = (extra) =>
    JSON.stringify({
      session_id: SID,
      transcript_path: join(tmp, "t.jsonl"),
      cwd: tmp,
      ...extra,
    });
  const toolPayload = (event, tool, input, response) => {
    useId += 1;
    return payload({
      hook_event_name: event,
      tool_name: T(tool),
      tool_input: input,
      tool_use_id: `toolu_${String(useId).padStart(2, "0")}`,
      ...(response === undefined ? {} : { tool_response: response, duration_ms: 42 }),
    });
  };
  const postHook = (tool, input, response) => {
    const r = runPostHook({
      configPath: cfgPath,
      stdin: toolPayload("PostToolUse", tool, input, response),
      tmpRoots: [tmpRoot],
    });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
  };
  /** A `computer` screenshot exactly as Claude Code reports a save_to_disk one. */
  const screenshot = (...paths) =>
    postHook("computer", { tabId: TAB, action: "screenshot", save_to_disk: true }, [
      text("Successfully captured screenshot"),
      text(tabContext),
      image,
      ...paths.map((p) => text(`Screenshot saved to: ${p}`)),
    ]);
  /** Write a source screenshot the way Claude Code does, remembering its bytes. */
  const shoot = (name, bytes, copiedAs = name) => {
    const p = join(shotDir, name);
    writeFileSync(p, bytes, { mode: 0o600 });
    copiedBytes.set(copiedAs, bytes);
    return p;
  };
  const appendRaw = (...lines) =>
    appendFileSync(join(dirs.log, `${SID}.jsonl`), lines.map((l) => `${l}\n`).join(""));

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-images-guard-"));
    // Stands in for os.tmpdir(): Claude Code's 0700 claude-chrome-screenshots-XXXX dir.
    tmpRoot = join(tmp, "tmp");
    mkdirSync(tmpRoot, { mode: 0o700 });
    shotDir = mkdtempSync(join(tmpRoot, "claude-chrome-screenshots-"));
    chmodSync(shotDir, 0o700);
    dirs = {
      log: join(tmp, "logs", "browser-guard"),
      state: join(tmp, "state"),
      evidence: join(tmp, "evidence", "run-1"),
    };
    cfgPath = join(tmp, "cfg", "config.json");

    // The config exactly as factory-agent.sh has the guard's CLI write it.
    let err = "";
    const code = await guardMain(
      [
        "config",
        "--out",
        cfgPath,
        "--device",
        DEVICE,
        "--allow-origin",
        PREVIEW,
        "--log-dir",
        dirs.log,
        "--state-dir",
        dirs.state,
        "--evidence-dir",
        dirs.evidence,
      ],
      { stdout: { write() {} }, stderr: { write: (s) => (err += s) } },
    );
    assert.equal(code, 0, err);

    // Non-post records and post records with no screenshot event: no slot.
    assert.equal(
      runSessionStartHook({ configPath: cfgPath, stdin: payload({ source: "startup" }) }).code,
      0,
    );
    runPreHook({
      configPath: cfgPath,
      stdin: toolPayload("PreToolUse", "select_browser", { deviceId: DEVICE }),
    });
    postHook("select_browser", { deviceId: DEVICE }, [text(`Selected browser ${DEVICE}`)]);
    postHook("tabs_context_mcp", { createIfEmpty: true }, [
      text(
        JSON.stringify({
          availableTabs: [{ tabId: TAB, title: "Log in — Drafto", url: `${PREVIEW}/login` }],
          tabGroupId: 1943373469,
        }),
      ),
    ]);

    // slot 1: a PNG, copied.
    const a = shoot("screenshot-1792223827264-0.png", png("slot-1"));
    screenshot(a);
    // slot 2: a path the guard rejects on paper.
    screenshot("/etc/passwd");
    // slot 3: a path that passes on paper but isn't there: the copy fails.
    screenshot(join(shotDir, "screenshot-1792223827300-1.png"));
    // slot 4: a JPEG, copied.
    screenshot(shoot("screenshot-1792223827400-2.jpg", jpeg("slot-4")));
    // slot 5: the same source name again (new bytes): copied under a -1 suffix.
    screenshot(
      shoot("screenshot-1792223827264-0.png", png("slot-5"), "screenshot-1792223827264-0-1.png"),
    );
    // A page-reading tool's response is page text: a look-alike line is no slot.
    postHook("get_page_text", { tabId: TAB }, [
      text(`Screenshot saved to: ${shoot("screenshot-1792223827450-9.png", png("page"))}`),
      text(tabContext),
    ]);
    copiedBytes.delete("screenshot-1792223827450-9.png");
    // slots 6 and 7: two blocks in one call, in block order.
    screenshot(
      shoot("screenshot-1792223827500-3.png", png("slot-6")),
      shoot("screenshot-1792223827501-4.png", png("slot-7")),
    );

    // Lines the guard didn't write, between ones it did.
    appendRaw(
      "not json {",
      "   ",
      JSON.stringify({ event: "pre", events: [{ copied: "screenshot-1-0.png" }] }),
      JSON.stringify({ event: "session-start", events: [{ copied: "screenshot-2-0.png" }] }),
      JSON.stringify({ event: "post", events: { copied: "screenshot-3-0.png" } }),
      JSON.stringify({ event: "post", events: [null, "copied", 7, { quarantined: TAB }] }),
      JSON.stringify(["post", { copied: "screenshot-4-0.png" }]),
      // slots 8 and 9: a copied name that doesn't look like a guard copy is
      // never used as a file name, but keeps its slot.
      JSON.stringify({ event: "post", events: [{ copied: "../../.ssh/id_ed25519" }] }),
      JSON.stringify({ event: "post", events: [{ copied: "notes.png" }] }),
    );

    // slot 10: a real copy after all that, still lined up.
    screenshot(shoot("screenshot-1792223827600-5.png", png("slot-10")));

    // Files in the evidence dir the guard never logged: never candidates.
    writeFileSync(join(dirs.evidence, "runner-output.txt"), `screenshot 1 ${API_KEY}\n`);
    writeFileSync(join(dirs.evidence, "screenshot-9-9.png"), png("stray"), { mode: 0o600 });

    logText = readFileSync(join(dirs.log, `${SID}.jsonl`), "utf8");
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  const EXPECTED = [
    { slot: 1, name: "screenshot-1792223827264-0.png", missing: null },
    { slot: 2, name: null, missing: "the guard rejected it" },
    { slot: 3, name: null, missing: "the guard couldn't copy it" },
    { slot: 4, name: "screenshot-1792223827400-2.jpg", missing: null },
    { slot: 5, name: "screenshot-1792223827264-0-1.png", missing: null },
    { slot: 6, name: "screenshot-1792223827500-3.png", missing: null },
    { slot: 7, name: "screenshot-1792223827501-4.png", missing: null },
    { slot: 8, name: null, missing: "unexpected file name" },
    { slot: 9, name: null, missing: "unexpected file name" },
    { slot: 10, name: "screenshot-1792223827600-5.png", missing: null },
  ];

  it("the guard logged the events this test relies on, in the shape it relies on", () => {
    const posts = logText
      .trim()
      .split("\n")
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
      .filter((r) => r.event === "post" && Array.isArray(r.events));
    const kinds = posts.flatMap((r) =>
      r.events.filter((e) => e && typeof e === "object").flatMap((e) => Object.keys(e)),
    );
    assert.ok(kinds.includes("selected"), "select_browser logs a non-screenshot event");
    assert.ok(kinds.includes("adopted"), "tabs_context_mcp logs a non-screenshot event");
    assert.ok(kinds.includes("screenshotRejected"));
    assert.ok(kinds.includes("copyFailed"));
    assert.ok(kinds.includes("copied"));
  });

  it("is one slot per screenshot event, in the order the guard logged them", () => {
    assert.deepEqual(browserManifest(logText), EXPECTED);
  });

  it("names exactly the files the guard copied into the evidence dir", () => {
    const named = EXPECTED.filter((e) => e.name).map((e) => e.name);
    assert.deepEqual(
      readdirSync(dirs.evidence)
        .filter((n) => n.startsWith("screenshot-") && n !== "screenshot-9-9.png")
        .sort(),
      [...named].sort(),
    );
    for (const name of named) {
      assert.deepEqual(readFileSync(join(dirs.evidence, name)), copiedBytes.get(name), name);
    }
  });

  it("feeds selectImages only the guard's copies, slot k still the runner's screenshot k", () => {
    const ocr = fakeOcr();
    const r = selectImages({
      root: dirs.evidence,
      entries: browserManifest(logText),
      ocr,
    });
    assert.equal(r.ok, true);
    // The slots with no guard copy are listed, never read: the dir itself is
    // their path, since there is no file.
    assert.deepEqual(r.overflow, [
      { slot: 2, path: dirs.evidence, why: "the guard rejected it" },
      { slot: 3, path: dirs.evidence, why: "the guard couldn't copy it" },
      { slot: 8, path: dirs.evidence, why: "unexpected file name" },
      { slot: 9, path: dirs.evidence, why: "unexpected file name" },
    ]);
    assert.deepEqual(
      r.upload.map((u) => [u.slot, u.name, u.ext, tagOf(u.data)]),
      [
        [1, "screenshot-1792223827264-0.png", "png", "slot-1"],
        [4, "screenshot-1792223827400-2.jpg", "jpg", "slot-4"],
        [5, "screenshot-1792223827264-0-1.png", "png", "slot-5"],
        [6, "screenshot-1792223827500-3.png", "png", "slot-6"],
        [7, "screenshot-1792223827501-4.png", "png", "slot-7"],
        [10, "screenshot-1792223827600-5.png", "png", "slot-10"],
      ],
    );
    for (const u of r.upload) {
      assert.deepEqual(u.data, copiedBytes.get(u.name), u.name);
      assert.equal(u.path, join(dirs.evidence, u.name));
    }
    assert.ok(!ocr.calls.some((c) => c.tag === "stray"), "an unlogged file is never even read");
  });

  it("text with no screenshot events is no screenshots", () => {
    assert.deepEqual(browserManifest(""), []);
    assert.deepEqual(browserManifest(null), []);
    assert.deepEqual(browserManifest(undefined), []);
    assert.deepEqual(browserManifest("garbage\n{\n[1,2]\nnull\n"), []);
    // The session-start and pre records alone.
    const head = logText
      .split("\n")
      .filter((l) => l && !l.includes('"event":"post"'))
      .join("\n");
    assert.ok(head.includes('"event":"session-start"') && head.includes('"event":"pre"'));
    assert.deepEqual(browserManifest(head), []);
  });
});

// ── macosManifest ───────────────────────────────────────────────────────────

describe("evidence-images: browserManifest publishes only shots taken on the preview", () => {
  const rec = (...events) => JSON.stringify({ event: "post", tool: "computer", events });
  const NAME = (n) => `screenshot-1792223827264-${n}.jpg`;

  it("keeps the slot and the file's name but publishes nothing for a copy not seen on the preview's origin", () => {
    const log = [
      rec({ copied: NAME(1), onOrigin: true }),
      // A log from before the guard recorded it.
      rec({ copied: NAME(2) }),
      rec({ copied: NAME(3), onOrigin: false }),
      rec({ copied: NAME(4), onOrigin: "true" }),
      rec({ copied: NAME(5), onOrigin: true }),
    ].join("\n");
    assert.deepEqual(browserManifest(log), [
      { slot: 1, name: NAME(1), missing: null },
      { slot: 2, name: NAME(2), missing: OFF_ORIGIN_WHY },
      { slot: 3, name: NAME(3), missing: OFF_ORIGIN_WHY },
      { slot: 4, name: NAME(4), missing: OFF_ORIGIN_WHY },
      { slot: 5, name: NAME(5), missing: null },
    ]);
  });

  it("drops every copy in a call that also lost or quarantined a tab", () => {
    for (const drift of [{ quarantined: 7 }, { unknown: 7 }, { ambiguous: 7 }, { gone: 7 }]) {
      const log = [
        rec({ copied: NAME(1), onOrigin: true }, drift),
        rec(drift, { copied: NAME(2), onOrigin: true }),
        rec({ copied: NAME(3), onOrigin: true }),
      ].join("\n");
      assert.deepEqual(
        browserManifest(log),
        [
          { slot: 1, name: NAME(1), missing: OFF_ORIGIN_WHY },
          { slot: 2, name: NAME(2), missing: OFF_ORIGIN_WHY },
          { slot: 3, name: NAME(3), missing: null },
        ],
        JSON.stringify(drift),
      );
    }
  });

  it("still says why for an unexpected name before anything else", () => {
    assert.deepEqual(browserManifest(rec({ copied: "notes.png", onOrigin: false })), [
      { slot: 1, name: null, missing: "unexpected file name" },
    ]);
  });
});

describe("evidence-images: macosManifest", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-images-macos-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("picks only NN-<label>.png, sorted by NN, and ignores the harness's other files", () => {
    const shots = join(tmp, "shots");
    mkdirSync(shots);
    for (const name of [
      "10-note-saved.png",
      "02-login.png",
      "01-launch.png",
      "100-last.png",
      "preflight-window.png",
      "tmp-ocr.png",
      "report.md",
      "1-one-digit.png",
      "03-has space.png",
      "04-jpeg.jpg",
      "05-.png",
      "06-upper.PNG",
    ]) {
      writeFileSync(join(shots, name), png(name));
    }
    assert.deepEqual(macosManifest(shots), [
      { slot: 1, name: "01-launch.png", missing: null, label: "launch" },
      { slot: 2, name: "02-login.png", missing: null, label: "login" },
      { slot: 10, name: "10-note-saved.png", missing: null, label: "note-saved" },
      { slot: 100, name: "100-last.png", missing: null, label: "last" },
    ]);
  });

  it("orders two shots with the same NN by name", () => {
    writeFileSync(join(tmp, "07-b.png"), png("b"));
    writeFileSync(join(tmp, "07-a.png"), png("a"));
    assert.deepEqual(
      macosManifest(tmp).map((e) => e.name),
      ["07-a.png", "07-b.png"],
    );
  });

  it("an unreadable or missing dir is no screenshots", () => {
    assert.deepEqual(macosManifest(join(tmp, "nope")), []);
    writeFileSync(join(tmp, "file"), "x");
    assert.deepEqual(macosManifest(join(tmp, "file")), []);
  });
});

// ── selectImages ────────────────────────────────────────────────────────────

describe("evidence-images: selectImages", () => {
  let tmp;
  let root;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-images-select-"));
    root = join(tmp, "evidence");
    mkdirSync(root, { mode: 0o700 });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** Write <files> ([name, bytes]) into root; entries listing them as slots 1.. */
  const stage = (files) =>
    files.map(([name, bytes], i) => {
      writeFileSync(join(root, name), bytes, { mode: 0o600 });
      return { slot: i + 1, name, missing: null };
    });

  it("only considers manifest-listed files: an unlisted file in the dir is never returned", () => {
    const entries = stage([["screenshot-1-0.png", png("listed")]]);
    writeFileSync(join(root, "screenshot-2-0.png"), png("unlisted"));
    writeFileSync(join(root, "01-shot.png"), png("unlisted-macos"));
    writeFileSync(join(root, "runner-output.txt"), "screenshot 1");
    const ocr = fakeOcr();
    const r = selectImages({ root, entries, ocr });
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.upload.map((u) => u.name),
      ["screenshot-1-0.png"],
    );
    assert.deepEqual(r.overflow, []);
    assert.deepEqual(
      ocr.calls.map((c) => c.tag),
      ["listed"],
    );
  });

  it("carries the exact bytes read, and OCR-scans those same bytes", () => {
    const a = png("a", 300);
    const b = jpeg("b", 200);
    const entries = stage([
      ["screenshot-1-0.png", a],
      ["shot.jpeg", b],
    ]);
    const ocr = fakeOcr();
    const r = selectImages({ root, entries, ocr });
    assert.deepEqual(r, {
      ok: true,
      upload: [
        {
          slot: 1,
          name: "screenshot-1-0.png",
          path: join(root, "screenshot-1-0.png"),
          data: a,
          size: 300,
          type: "png",
          ext: "png",
        },
        {
          slot: 2,
          name: "shot.jpeg",
          path: join(root, "shot.jpeg"),
          data: b,
          size: 200,
          type: "jpeg",
          ext: "jpg",
        },
      ],
      overflow: [],
    });
    assert.deepEqual(
      ocr.calls.map((c) => [c.data, c.ext]),
      [
        [a, "png"],
        [b, "jpg"],
      ],
    );
  });

  it("keeps a macOS shot's label", () => {
    writeFileSync(join(root, "02-login.png"), png("login"));
    writeFileSync(join(root, "01-launch.png"), png("launch"));
    writeFileSync(join(root, "preflight-window.png"), png("preflight"));
    const r = selectImages({ root, entries: macosManifest(root), ocr: fakeOcr() });
    assert.deepEqual(
      r.upload.map((u) => [u.slot, u.name, u.label]),
      [
        [1, "01-launch.png", "launch"],
        [2, "02-login.png", "login"],
      ],
    );
  });

  it("publishes one shot per number: a later shot with the same NN is kept on the Mac mini", () => {
    // One slot is one published file (NN.png), so a second 07 would replace the first.
    writeFileSync(join(root, "07-b.png"), png("b"));
    writeFileSync(join(root, "07-a.png"), png("a"));
    writeFileSync(join(root, "08-c.png"), png("c"));
    const ocr = fakeOcr();
    const r = selectImages({ root, entries: macosManifest(root), ocr });
    assert.deepEqual(
      r.upload.map((u) => [u.slot, u.name]),
      [
        [7, "07-a.png"],
        [8, "08-c.png"],
      ],
    );
    assert.deepEqual(r.overflow, [
      { slot: 7, path: join(root, "07-b.png"), why: "another screenshot has the same number" },
    ]);
    // The duplicate is never read or scanned.
    assert.deepEqual(
      ocr.calls.map((c) => c.tag),
      ["a", "c"],
    );
  });

  it("lets a later shot with the same NN take the slot when the first one fails a check", () => {
    writeFileSync(join(root, "07-a.png"), Buffer.from("not a png"));
    writeFileSync(join(root, "07-b.png"), png("b-secret"));
    writeFileSync(join(root, "07-c.png"), png("c"));
    writeFileSync(join(root, "07-d.png"), png("d"));
    const ocr = fakeOcr({
      "b-secret": { ok: true, text: "dk_0123456789abcdef0123456789abcdef0123456789abcdef" },
    });
    const r = selectImages({ root, entries: macosManifest(root), ocr });
    assert.deepEqual(
      r.upload.map((u) => u.name),
      ["07-c.png"],
    );
    assert.deepEqual(
      r.overflow.map((o) => [o.path, o.why]),
      [
        [join(root, "07-a.png"), "its bytes aren't a PNG image"],
        [join(root, "07-b.png"), "its text matched a secret pattern (drafto-api-key)"],
        [join(root, "07-d.png"), "another screenshot has the same number"],
      ],
    );
  });

  it("caps the number of images in slot order, lists the rest in order, and OCRs none past the cap", () => {
    const entries = stage([
      ["s1.png", png("1")],
      ["s2.png", png("2")],
      ["s3.png", png("3")],
      ["s4.png", png("4")],
    ]);
    const ocr = fakeOcr();
    // Out of order on purpose: the cap goes by slot, not by manifest order.
    const r = selectImages({ root, entries: [...entries].reverse(), ocr, maxImages: 2 });
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.upload.map((u) => u.slot),
      [1, 2],
    );
    assert.deepEqual(r.overflow, [
      { slot: 3, path: join(root, "s3.png"), why: CAP_WHY },
      { slot: 4, path: join(root, "s4.png"), why: CAP_WHY },
    ]);
    assert.equal(ocr.calls.length, 2);
  });

  it("caps the total bytes, and a later smaller image still fits after a big one overflowed", () => {
    const entries = stage([
      ["s1.png", png("1", 100)],
      ["s2.png", png("2", 300)],
      ["s3.png", png("3", 100)],
      ["s4.png", png("4", 100)],
    ]);
    const r = selectImages({ root, entries, ocr: fakeOcr(), maxTotalBytes: 250 });
    assert.deepEqual(
      r.upload.map((u) => u.slot),
      [1, 3],
    );
    assert.deepEqual(r.overflow, [
      { slot: 2, path: join(root, "s2.png"), why: CAP_WHY },
      { slot: 4, path: join(root, "s4.png"), why: CAP_WHY },
    ]);
  });

  it("drops an image over maxImageBytes with the size reason, not the cap's", () => {
    const entries = stage([
      ["s1.png", png("1", 50)],
      ["s2.png", png("2", 500)],
    ]);
    const r = selectImages({ root, entries, ocr: fakeOcr(), maxImageBytes: 100 });
    assert.deepEqual(
      r.upload.map((u) => u.slot),
      [1],
    );
    assert.equal(r.overflow.length, 1);
    assert.equal(r.overflow[0].slot, 2);
    assert.match(r.overflow[0].why, /^larger than \d+ (?:KB|MB)$/);
  });

  it("drops an image whose OCR text has an API key, naming the pattern but never the key", () => {
    const entries = stage([
      ["s1.png", png("key")],
      ["s2.png", png("fine")],
    ]);
    const ocr = fakeOcr({ key: { ok: true, text: `API keys\nYour new key\n${API_KEY}\nCopy` } });
    const r = selectImages({ root, entries, ocr });
    assert.deepEqual(
      r.upload.map((u) => u.slot),
      [2],
      "a dropped image doesn't stop later ones",
    );
    assert.deepEqual(r.overflow, [
      {
        slot: 1,
        path: join(root, "s1.png"),
        why: "its text matched a secret pattern (drafto-api-key)",
      },
    ]);
    const shown = JSON.stringify(r.overflow);
    assert.ok(!shown.includes(HEX48) && !shown.includes("dk_0123"));
  });

  it("drops an image showing the test account's password, never repeating it", () => {
    const password = "Correct-Horse-9!";
    const entries = stage([["s1.png", png("pw")]]);
    const ocr = fakeOcr({ pw: { ok: true, text: `Password\n${password}\nSign in` } });
    const r = selectImages({ root, entries, ocr, secrets: { password } });
    assert.deepEqual(r.upload, []);
    assert.deepEqual(r.overflow, [
      { slot: 1, path: join(root, "s1.png"), why: "its text matched a secret pattern (password)" },
    ]);
    assert.ok(!JSON.stringify(r.overflow).includes(password));
  });

  it("a secret-dropped image doesn't count toward the cap", () => {
    const entries = stage([
      ["s1.png", png("key", 200)],
      ["s2.png", png("2", 200)],
      ["s3.png", png("3", 200)],
    ]);
    const ocr = fakeOcr({ key: { ok: true, text: API_KEY } });
    const r = selectImages({ root, entries, ocr, maxImages: 2, maxTotalBytes: 400 });
    assert.deepEqual(
      r.upload.map((u) => u.slot),
      [2, 3],
    );
  });

  it("drops an image OCR couldn't read", () => {
    const entries = stage([
      ["s1.png", png("fail")],
      ["s2.png", png("no-text")],
      ["s3.png", png("bad-text")],
      ["s4.png", png("null")],
      ["s5.png", png("fine")],
    ]);
    const ocr = fakeOcr({
      fail: { ok: false },
      "no-text": { ok: true },
      "bad-text": { ok: true, text: ["a"] },
      null: null,
    });
    const r = selectImages({ root, entries, ocr });
    assert.deepEqual(
      r.upload.map((u) => u.slot),
      [5],
    );
    assert.deepEqual(
      r.overflow.map((o) => [o.slot, o.why]),
      [1, 2, 3, 4].map((slot) => [slot, "the OCR secret scan couldn't read it"]),
    );
  });

  it("without the OCR helper, publishes nothing at all", () => {
    const entries = stage([["s1.png", png("1")]]);
    for (const ocr of [null, undefined, "/usr/local/bin/ocr"]) {
      assert.deepEqual(selectImages({ root, entries, ocr }), { ok: false, reason: "ocr-missing" });
    }
  });

  it("no listed entries is ok with nothing, OCR or not", () => {
    for (const entries of [[], undefined, "screenshot-1-0.png", [null]]) {
      assert.deepEqual(selectImages({ root, entries, ocr: null }), {
        ok: true,
        upload: [],
        overflow: [],
      });
    }
  });

  it("with only held-back entries, publishes nothing but lists each with why, OCR or not", () => {
    const entries = [
      { slot: 1, name: null, missing: "the guard rejected it" },
      { slot: 2, name: null, missing: "the guard couldn't copy it" },
      null,
    ];
    for (const ocr of [null, fakeOcr()]) {
      assert.deepEqual(selectImages({ root, entries, ocr }), {
        ok: true,
        upload: [],
        overflow: [
          { slot: 1, path: root, why: "the guard rejected it" },
          { slot: 2, path: root, why: "the guard couldn't copy it" },
        ],
      });
    }
  });

  it("a rejected or failed slot is listed, never read, and later slots keep their numbers", () => {
    writeFileSync(join(root, "s3.png"), png("3"));
    const ocr = fakeOcr();
    const r = selectImages({
      root,
      entries: [
        { slot: 1, name: null, missing: "the guard rejected it" },
        { slot: 2, name: null, missing: "the guard couldn't copy it" },
        { slot: 3, name: "s3.png", missing: null },
      ],
      ocr,
    });
    assert.deepEqual(
      r.upload.map((u) => u.slot),
      [3],
    );
    assert.deepEqual(r.overflow, [
      { slot: 1, path: root, why: "the guard rejected it" },
      { slot: 2, path: root, why: "the guard couldn't copy it" },
    ]);
    assert.deepEqual(
      ocr.calls.map((c) => c.tag),
      ["3"],
    );
  });

  it("never publishes or reads an off-origin copy, but lists it at its path, in slot order", () => {
    const NAME = (n) => `screenshot-1792223827264-${n}.png`;
    for (const n of [1, 2, 3]) writeFileSync(join(root, NAME(n)), png(`off-${n}`));
    writeFileSync(join(root, NAME(4)), png("on-4"));
    const ocr = fakeOcr();
    // The guard's own log: slot 2 is on the preview, 1 and 3 aren't, and slot
    // 4 was copied in a call that also lost track of a tab.
    const log = [
      { copied: NAME(1), onOrigin: false },
      { copied: NAME(2), onOrigin: true },
      { copied: NAME(3) },
    ]
      .map((e) => JSON.stringify({ event: "post", tool: "computer", events: [e] }))
      .concat(
        JSON.stringify({
          event: "post",
          tool: "computer",
          events: [{ copied: NAME(4), onOrigin: true }, { gone: 7 }],
        }),
      )
      .join("\n");
    // NAME(2)'s file is missing on purpose: its check fails after the others.
    rmSync(join(root, NAME(2)));
    const r = selectImages({ root, entries: browserManifest(log), ocr });
    assert.deepEqual(r, {
      ok: true,
      upload: [],
      overflow: [
        { slot: 1, path: join(root, NAME(1)), why: OFF_ORIGIN_WHY },
        { slot: 2, path: join(root, NAME(2)), why: "missing" },
        { slot: 3, path: join(root, NAME(3)), why: OFF_ORIGIN_WHY },
        { slot: 4, path: join(root, NAME(4)), why: OFF_ORIGIN_WHY },
      ],
    });
    assert.deepEqual(ocr.calls, [], "a held-back copy is never even read");
  });

  it("a held-back entry with a name that isn't a basename is listed at the evidence dir", () => {
    const r = selectImages({
      root,
      entries: [
        { slot: 1, name: "../up.png", missing: OFF_ORIGIN_WHY },
        { slot: 2, name: "..", missing: OFF_ORIGIN_WHY },
      ],
      ocr: null,
    });
    assert.deepEqual(r.overflow, [
      { slot: 1, path: root, why: OFF_ORIGIN_WHY },
      { slot: 2, path: root, why: OFF_ORIGIN_WHY },
    ]);
  });

  it("refuses a manifest name with a path separator, or . / .., without reading it", () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "screenshot-1-0.png"), png("nested"));
    writeFileSync(join(tmp, "up.png"), png("up"));
    const ocr = fakeOcr();
    const r = selectImages({
      root,
      entries: [
        { slot: 1, name: "sub/screenshot-1-0.png", missing: null },
        { slot: 2, name: "../up.png", missing: null },
        { slot: 3, name: join(root, "sub", "screenshot-1-0.png"), missing: null },
        { slot: 4, name: ".", missing: null },
        { slot: 5, name: "..", missing: null },
      ],
      ocr,
    });
    assert.deepEqual(r.upload, []);
    assert.deepEqual(
      r.overflow,
      [1, 2, 3, 4, 5].map((slot) => ({ slot, path: root, why: "unexpected file name" })),
    );
    assert.equal(ocr.calls.length, 0);
  });

  it("lists a file that fails a check with its local path and why", () => {
    writeFileSync(join(tmp, "elsewhere.png"), png("elsewhere"));
    symlinkSync(join(tmp, "elsewhere.png"), join(root, "s1.png"));
    writeFileSync(join(root, "s2.jpg"), png("png-as-jpg"));
    const entries = [
      { slot: 1, name: "s1.png", missing: null },
      { slot: 2, name: "s2.jpg", missing: null },
      { slot: 3, name: "s3.png", missing: null },
    ];
    const ocr = fakeOcr();
    const r = selectImages({ root, entries, ocr });
    assert.deepEqual(r, {
      ok: true,
      upload: [],
      overflow: [
        { slot: 1, path: join(root, "s1.png"), why: "a symlink" },
        { slot: 2, path: join(root, "s2.jpg"), why: "its bytes aren't a JPEG image" },
        { slot: 3, path: join(root, "s3.png"), why: "missing" },
      ],
    });
    assert.equal(ocr.calls.length, 0);
  });

  it("a symlinked evidence dir publishes nothing and lists every file", () => {
    const real = join(tmp, "real");
    mkdirSync(real);
    writeFileSync(join(real, "s1.png"), png("1"));
    const link = join(tmp, "linked");
    symlinkSync(real, link);
    const ocr = fakeOcr();
    const r = selectImages({ root: link, entries: [{ slot: 1, name: "s1.png" }], ocr });
    assert.deepEqual(r, {
      ok: true,
      upload: [],
      overflow: [
        { slot: 1, path: join(link, "s1.png"), why: "the evidence directory is a symlink" },
      ],
    });
    assert.equal(ocr.calls.length, 0);
  });

  it("keeps the rest on the Mac mini once the OCR time budget is spent", () => {
    const entries = stage([
      ["screenshot-1-0.png", png("one")],
      ["screenshot-2-0.png", png("two")],
      ["screenshot-3-0.png", png("three")],
    ]);
    // Each OCR call takes 50 "ms" of a 60 ms budget: the second call starts
    // inside it, the third after it.
    let t = 0;
    const base = fakeOcr();
    const ocr = (data, ext) => {
      t += 50;
      return base(data, ext);
    };
    const r = selectImages({ root, entries, ocr, ocrBudgetMs: 60, now: () => t });
    assert.deepEqual(
      r.upload.map((u) => u.slot),
      [1, 2],
    );
    assert.deepEqual(r.overflow, [
      {
        slot: 3,
        path: join(root, "screenshot-3-0.png"),
        why: "the OCR secret scan ran out of time",
      },
    ]);
  });

  it("re-checks the evidence dir for every file, so a dir swapped for a symlink mid-run lets nothing out", () => {
    // The first look at the root (selectImages' own) sees a real directory;
    // every later one sees a symlink, as if the dir was swapped after it.
    const entries = stage([
      ["screenshot-1-0.png", png("one")],
      ["screenshot-2-0.png", png("two")],
    ]);
    let looks = 0;
    const fs = {
      ...nodeFs,
      constants: nodeFs.constants,
      lstatSync(p, ...rest) {
        const st = nodeFs.lstatSync(p, ...rest);
        if (p !== root) return st;
        looks += 1;
        return looks === 1 ? st : { ...st, isSymbolicLink: () => true, isDirectory: () => false };
      },
    };
    const ocr = fakeOcr();
    const r = selectImages({ root, entries, ocr, fs });
    assert.equal(r.ok, true);
    assert.deepEqual(r.upload, []);
    assert.deepEqual(
      r.overflow.map((o) => o.why),
      ["the evidence directory is a symlink", "the evidence directory is a symlink"],
    );
    assert.equal(ocr.calls.length, 0, "nothing was read, so nothing was scanned");
  });
});

// ── helperOcr ───────────────────────────────────────────────────────────────

describe("evidence-images: helperOcr", () => {
  let tmp;
  let ocrTmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-images-ocr-"));
    ocrTmp = join(tmp, "ocr-tmp");
    mkdirSync(ocrTmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** A fake ocr helper: a shell script that records what it was given. */
  const helper = (body) => {
    const bin = join(tmp, "bin", "ocr");
    mkdirSync(dirname(bin), { recursive: true });
    const record = join(tmp, "record");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `printf '%s' "$1" > '${record}.arg'`,
        `cp "$1" '${record}.bytes'`,
        `ls -l "$1" | cut -c1-10 > '${record}.mode'`,
        `ls -ld "$(dirname "$1")" | cut -c1-10 > '${record}.dirmode'`,
        body,
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return { bin, record };
  };
  const ITEMS = '{"width":1,"height":1,"items":[{"text":"a"},{"text":"b"}]}';

  it("joins the helper's items into one text, from a private temp copy it then deletes", () => {
    const { bin, record } = helper(`printf '%s\\n' '${ITEMS}'`);
    const bytes = png("ocr-me", 128);
    assert.deepEqual(helperOcr(bin, { tmpRoot: ocrTmp })(bytes, "png"), { ok: true, text: "a\nb" });
    const arg = readFileSync(`${record}.arg`, "utf8");
    assert.equal(basename(arg), "image.png");
    assert.equal(dirname(dirname(arg)), ocrTmp);
    assert.match(basename(dirname(arg)), /^factory-evidence-ocr-/);
    assert.deepEqual(readFileSync(`${record}.bytes`), bytes, "the helper reads the bytes given");
    assert.equal(readFileSync(`${record}.mode`, "utf8").trim(), "-rw-------");
    assert.equal(readFileSync(`${record}.dirmode`, "utf8").trim(), "drwx------");
    assert.ok(!existsSync(arg));
    assert.deepEqual(readdirSync(ocrTmp), [], "the temp copy and its dir are gone");
  });

  it("names the temp copy after the extension it is given", () => {
    const { bin, record } = helper(`printf '%s' '${ITEMS}'`);
    assert.equal(helperOcr(bin, { tmpRoot: ocrTmp })(jpeg("j"), "jpg").ok, true);
    assert.equal(basename(readFileSync(`${record}.arg`, "utf8")), "image.jpg");
  });

  it("skips items without text", () => {
    const { bin } = helper(
      `printf '%s' '{"items":[{"text":"a"},{"text":""},{"x":1},null,{"text":7},{"text":"b"}]}'`,
    );
    assert.deepEqual(helperOcr(bin, { tmpRoot: ocrTmp })(png("x"), "png"), {
      ok: true,
      text: "a\nb",
    });
  });

  it("a non-zero exit is a failed read, and the temp copy is still deleted", () => {
    const { bin, record } = helper(`printf '%s' '${ITEMS}'\nexit 3`);
    assert.deepEqual(helperOcr(bin, { tmpRoot: ocrTmp })(png("x"), "png"), { ok: false });
    assert.ok(!existsSync(readFileSync(`${record}.arg`, "utf8")));
    assert.deepEqual(readdirSync(ocrTmp), []);
  });

  it("output that isn't the helper's JSON is a failed read", () => {
    for (const out of ["not json", '{"width":1,"height":1}', '{"items":"a"}', "null", ""]) {
      const { bin } = helper(`printf '%s' '${out}'`);
      assert.deepEqual(helperOcr(bin, { tmpRoot: ocrTmp })(png("x"), "png"), { ok: false }, out);
      assert.deepEqual(readdirSync(ocrTmp), []);
    }
  });

  it("a helper that hangs is killed at the timeout: a failed read", () => {
    const { bin } = helper("exec sleep 30");
    const started = Date.now();
    assert.deepEqual(helperOcr(bin, { tmpRoot: ocrTmp, timeoutMs: 300 })(png("x"), "png"), {
      ok: false,
    });
    assert.ok(Date.now() - started < 15_000);
    assert.deepEqual(readdirSync(ocrTmp), []);
  });

  it("a helper that can't be run is a failed read", () => {
    assert.deepEqual(helperOcr(join(tmp, "missing"), { tmpRoot: ocrTmp })(png("x"), "png"), {
      ok: false,
    });
    assert.deepEqual(readdirSync(ocrTmp), []);
  });

  it("runs the helper on the one file, with the default timeout", () => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, timeout: opts.timeout, exists: existsSync(args[0]) });
      return { status: 0, stdout: ITEMS };
    };
    const r = helperOcr("/opt/ocr", { spawn, tmpRoot: ocrTmp })(png("x"), "png");
    assert.deepEqual(r, { ok: true, text: "a\nb" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "/opt/ocr");
    assert.equal(calls[0].args.length, 1);
    assert.equal(calls[0].timeout, OCR_TIMEOUT_MS);
    assert.equal(calls[0].exists, true, "the copy exists while the helper runs");
    assert.deepEqual(readdirSync(ocrTmp), []);
  });
});

// ── ocrAvailable ────────────────────────────────────────────────────────────

describe("evidence-images: ocrAvailable", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-images-avail-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("is true for an executable regular file at an absolute path", () => {
    const bin = join(tmp, "ocr");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    assert.equal(ocrAvailable(bin), true);
  });

  it("is false for a relative path, even to an executable", () => {
    const bin = join(tmp, "ocr");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const rel = join(".", basename(tmp), "ocr");
    assert.equal(ocrAvailable(rel), false);
    assert.equal(ocrAvailable("ocr"), false);
  });

  it("is false for a missing file, a non-executable one and a directory", () => {
    assert.equal(ocrAvailable(join(tmp, "missing")), false);
    const plain = join(tmp, "plain");
    writeFileSync(plain, "#!/bin/sh\n");
    chmodSync(plain, 0o644);
    assert.equal(ocrAvailable(plain), false);
    const dir = join(tmp, "dir");
    mkdirSync(dir, { mode: 0o755 });
    assert.equal(ocrAvailable(dir), false);
  });

  it("is false for no path at all", () => {
    for (const v of [undefined, null, "", 42]) assert.equal(ocrAvailable(v), false);
  });
});
