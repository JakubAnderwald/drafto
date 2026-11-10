// Picks the screenshots of one factory test run that may be published with its
// report, and checks each one before it leaves the Mac mini (ADR-0072).
//
// Why this exists: the repo is public, and a screenshot is pixels the text
// secret scan never sees. So only files with provenance are considered, each
// is re-checked on disk, its text is read back with OCR and scanned like the
// report, and a per-comment cap bounds what one comment can carry:
//
//   - Provenance. A browser run's screenshots are exactly the files the guard
//     copied into the run's evidence dir, in the order its decision log
//     (`$LOG_DIR/browser-guard/<session>.jsonl`, browser-guard.mjs) recorded
//     them: each "Screenshot saved to:" block of a `computer` call becomes one
//     `copied`, `copyFailed` or `screenshotRejected` event. A failed or
//     rejected copy keeps its slot, so slot k is still the runner's
//     "screenshot k". A macOS harness run's are its `shots/NN-<label>.png`
//     (common.sh's shot()). Anything else in the dir is ignored:
//     runner-output.txt, the harness's preflight-window.png and tmp-ocr.png.
//   - Per file: not a symlink, real path strictly inside the evidence dir (the
//     dir itself no symlink), a regular file read through an O_NOFOLLOW fd,
//     .png / .jpg / .jpeg with matching magic bytes, at most MAX_IMAGE_BYTES.
//     The bytes read here are the bytes scanned and the bytes uploaded.
//   - OCR: the helper (apps/desktop/e2e/in-test/lib/ocr.swift, compiled by
//     the caller) reads the image's text; a secret-pattern or password hit
//     drops that image. Without the helper nothing is published at all.
//   - The cap: MAX_IMAGES images and MAX_TOTAL_BYTES per comment, in slot
//     order. What doesn't fit, or fails a check, is listed as kept on the Mac
//     mini with its local path and why — never with what a scan matched.
//
// Pure apart from the file reads and the OCR call, both injectable for tests.

import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanLaneText } from "./verify-report.mjs";

export const MAX_IMAGES = 20;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const OCR_TIMEOUT_MS = 30_000;
// All of one run's OCR together: past it, the rest stay on the Mac mini, so a
// slow or hung helper can't hold up the factory tick that publishes them.
export const OCR_BUDGET_MS = 120_000;

// Extension → [type, the extension the published copy gets].
const IMAGE_TYPES = Object.freeze({
  ".png": ["png", "png"],
  ".jpg": ["jpeg", "jpg"],
  ".jpeg": ["jpeg", "jpg"],
});
const MAGIC = Object.freeze({
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
});

// copyEvidence's destination names: screenshot-<ms>-<n>[-<k>].<ext>.
const GUARD_COPY_NAME = /^screenshot-\d+-\d+(?:-\d+)?\.(?:jpg|png)$/;
// common.sh's shot(): shots/<NN>-<label>.png.
const MACOS_SHOT_NAME = /^(\d{2,3})-([A-Za-z0-9._-]{1,80})\.png$/;

export const CAP_WHY = `over the per-comment cap (${MAX_IMAGES} images / ${
  MAX_TOTAL_BYTES / 1024 / 1024
} MB)`;

// ── manifests ───────────────────────────────────────────────────────────────

// Guard events that mean a tab left the preview, or the guard lost track of
// where one was, during the call that logged them.
const DRIFT_EVENTS = Object.freeze(["quarantined", "unknown", "ambiguous", "gone"]);
// A copy the guard didn't see taken on the preview's origin: a neutral page
// (the new-tab page), a page off the preview, or a log from before the guard
// recorded it (ADR-0072).
export const OFF_ORIGIN_WHY = "taken while the tab wasn't on the preview";

/**
 * A browser run's screenshots, from its session's decision log: one entry per
 * screenshot event, in the order the guard logged them. Slot k (from 1) is
 * the runner's "screenshot k". [{slot, name, missing}]: name is the copied
 * file's basename in the evidence dir, or null when the copy was rejected or
 * failed (missing then says which).
 */
export function browserManifest(logText) {
  const out = [];
  for (const line of String(logText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.event !== "post" || !Array.isArray(rec.events)) continue;
    // A call that lost track of a tab, or found one off the preview, may have
    // screenshotted a page that isn't the preview's: none of its shots count.
    const drifted = rec.events.some(
      (e) => e !== null && typeof e === "object" && DRIFT_EVENTS.some((k) => Object.hasOwn(e, k)),
    );
    for (const e of rec.events) {
      if (e === null || typeof e !== "object") continue;
      if (Object.hasOwn(e, "copied")) {
        const name = typeof e.copied === "string" ? e.copied : "";
        let missing = null;
        if (!GUARD_COPY_NAME.test(name)) missing = "unexpected file name";
        else if (e.onOrigin !== true || drifted) missing = OFF_ORIGIN_WHY;
        out.push({ slot: out.length + 1, name: missing ? null : name, missing });
      } else if (Object.hasOwn(e, "copyFailed")) {
        out.push({ slot: out.length + 1, name: null, missing: "the guard couldn't copy it" });
      } else if (Object.hasOwn(e, "screenshotRejected")) {
        out.push({ slot: out.length + 1, name: null, missing: "the guard rejected it" });
      }
    }
  }
  return out;
}

/**
 * A macOS harness run's screenshots: shots/NN-<label>.png, by NN. [{slot,
 * name, missing: null, label}]. An unreadable dir is no screenshots.
 */
export function macosManifest(shotsDir, { fs = nodeFs } = {}) {
  let names;
  try {
    names = fs.readdirSync(shotsDir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, m: MACOS_SHOT_NAME.exec(name) }))
    .filter(({ m }) => m)
    .map(({ name, m }) => ({ slot: Number(m[1]), name, missing: null, label: m[2] }))
    .sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name));
}

// ── per-file checks ─────────────────────────────────────────────────────────

function isStrictlyUnder(child, root) {
  const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return child.startsWith(base) && child.length > base.length;
}

/** Why <dir> can't be an evidence root, or null when it can. */
export function rootProblem(dir, { fs = nodeFs } = {}) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return "the evidence directory is missing";
  }
  if (st.isSymbolicLink()) return "the evidence directory is a symlink";
  if (!st.isDirectory()) return "the evidence directory is not a directory";
  return null;
}

// A byte cap as people read it: whole MB, or KB below one MB.
function sizeText(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Re-check one file on disk and read it. {ok: true, data, size, type, ext}
 * (ext: the published copy's, png|jpg) or {ok: false, why}. <realRoot>, when
 * given, is the evidence dir's real path as the caller first saw it: the dir
 * is re-checked for every file, so swapping it for a symlink mid-selection
 * can't let an outside file through.
 */
export function checkImage(
  file,
  root,
  { maxBytes = MAX_IMAGE_BYTES, realRoot = null, fs = nodeFs } = {},
) {
  const typeOf = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!typeOf) return { ok: false, why: "not a .png or .jpg file" };
  const [type, ext] = typeOf;
  let lst;
  try {
    lst = fs.lstatSync(file);
  } catch {
    return { ok: false, why: "missing" };
  }
  if (lst.isSymbolicLink()) return { ok: false, why: "a symlink" };
  if (!lst.isFile()) return { ok: false, why: "not a regular file" };
  const rootWhy = rootProblem(root, { fs });
  if (rootWhy) return { ok: false, why: rootWhy };
  try {
    const rootNow = fs.realpathSync(root);
    if (realRoot !== null && rootNow !== realRoot) {
      return { ok: false, why: "the evidence directory changed while it was being checked" };
    }
    if (!isStrictlyUnder(fs.realpathSync(file), rootNow)) {
      return { ok: false, why: "outside the evidence directory" };
    }
  } catch {
    return { ok: false, why: "its path couldn't be resolved" };
  }
  let fd;
  try {
    // O_NONBLOCK: a file swapped for a FIFO after the lstat can't hang the open.
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return { ok: false, why: "it couldn't be opened without following a link" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "not a regular file" };
    if (st.dev !== lst.dev || st.ino !== lst.ino) {
      return { ok: false, why: "it changed while it was being checked" };
    }
    if (st.size === 0) return { ok: false, why: "empty" };
    if (st.size > maxBytes) {
      return { ok: false, why: `larger than ${sizeText(maxBytes)}` };
    }
    const data = fs.readFileSync(fd);
    if (data.length !== st.size) return { ok: false, why: "it changed while it was being read" };
    if (!data.subarray(0, MAGIC[type].length).equals(MAGIC[type])) {
      return { ok: false, why: `its bytes aren't a ${type === "png" ? "PNG" : "JPEG"} image` };
    }
    return { ok: true, data, size: data.length, type, ext };
  } catch {
    return { ok: false, why: "it couldn't be read" };
  } finally {
    fs.closeSync(fd);
  }
}

// ── OCR ─────────────────────────────────────────────────────────────────────

/** Is <bin> an executable regular file? */
export function ocrAvailable(bin, { fs = nodeFs } = {}) {
  if (typeof bin !== "string" || !bin || !path.isAbsolute(bin)) return false;
  try {
    if (!fs.statSync(bin).isFile()) return false;
    fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * An OCR function over image bytes, backed by the ocr helper at <bin>: the
 * bytes go to a fresh private temp file (so the text scanned is the text of
 * the bytes that get uploaded), and the helper's JSON items are joined into
 * one text. Returns (data, ext) => {ok: true, text} | {ok: false}.
 */
export function helperOcr(
  bin,
  { spawn = spawnSync, tmpRoot = os.tmpdir(), fs = nodeFs, timeoutMs = OCR_TIMEOUT_MS } = {},
) {
  return (data, ext) => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "factory-evidence-ocr-"));
    try {
      const file = path.join(dir, `image.${ext}`);
      fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
      const r = spawn(bin, [file], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status !== 0) return { ok: false };
      const parsed = JSON.parse(r.stdout);
      if (!Array.isArray(parsed?.items)) return { ok: false };
      const text = parsed.items
        .map((i) => (typeof i?.text === "string" ? i.text : ""))
        .filter(Boolean)
        .join("\n");
      return { ok: true, text };
    } catch {
      return { ok: false };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ── selection ───────────────────────────────────────────────────────────────

/**
 * Which of a run's screenshots may be published.
 *
 * @param {object} o
 * @param {string} o.root the evidence dir every entry's file must be in
 * @param {{slot:number,name:string|null,missing:string|null,label?:string}[]} o.entries
 *   a manifest (browserManifest / macosManifest)
 * @param {((data:Buffer, ext:string) => {ok:boolean,text?:string})|null} o.ocr
 *   null when the helper is missing: then nothing is published
 * @param {{password?:string,bypass?:string,signinKey?:string}} o.secrets
 *   literals to scan the OCR text for (scanLaneText's)
 * @param {number} [o.ocrBudgetMs] all the OCR calls together; past it, the
 *   remaining images are kept on the Mac mini
 * @returns {{ok:true, upload:object[], overflow:{slot,path,why}[]} | {ok:false, reason:string}}
 *   upload: [{slot, name, path, data, size, type, ext, label?}] in slot order
 */
export function selectImages({
  root,
  entries,
  ocr,
  secrets = {},
  maxImages = MAX_IMAGES,
  maxTotalBytes = MAX_TOTAL_BYTES,
  maxImageBytes = MAX_IMAGE_BYTES,
  ocrBudgetMs = OCR_BUDGET_MS,
  now = Date.now,
  fs = nodeFs,
}) {
  const listed = (Array.isArray(entries) ? entries : []).filter((e) => e && e.name);
  if (listed.length === 0) return { ok: true, upload: [], overflow: [] };
  if (typeof ocr !== "function") return { ok: false, reason: "ocr-missing" };
  const rootWhy = rootProblem(root, { fs });
  if (rootWhy) {
    return {
      ok: true,
      upload: [],
      overflow: listed.map((e) => ({ slot: e.slot, path: path.join(root, e.name), why: rootWhy })),
    };
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { ok: false, reason: "error" };
  }

  const upload = [];
  const overflow = [];
  // The slots already in the upload. A slot is one published file
  // (NN.<ext>), so a second shot with the same number (macOS `07-a.png` and
  // `07-b.png`) would replace the first's image. The first that passes every
  // check keeps the slot: a rejected one doesn't hold it.
  const taken = new Set();
  let total = 0;
  const deadline = now() + ocrBudgetMs;
  for (const e of [...listed].sort((a, b) => a.slot - b.slot)) {
    // A manifest name is a basename: one that isn't is not this run's file.
    if (e.name !== path.basename(e.name) || e.name === "." || e.name === "..") {
      overflow.push({ slot: e.slot, path: root, why: "unexpected file name" });
      continue;
    }
    const file = path.join(root, e.name);
    if (taken.has(e.slot)) {
      overflow.push({ slot: e.slot, path: file, why: "another screenshot has the same number" });
      continue;
    }
    const img = checkImage(file, root, { maxBytes: maxImageBytes, realRoot, fs });
    if (!img.ok) {
      overflow.push({ slot: e.slot, path: file, why: img.why });
      continue;
    }
    // The cap before the OCR, so a run with many screenshots isn't OCR'd past it.
    if (upload.length >= maxImages || total + img.size > maxTotalBytes) {
      overflow.push({ slot: e.slot, path: file, why: CAP_WHY });
      continue;
    }
    if (now() > deadline) {
      overflow.push({ slot: e.slot, path: file, why: "the OCR secret scan ran out of time" });
      continue;
    }
    const read = ocr(img.data, img.ext);
    if (!read?.ok || typeof read.text !== "string") {
      overflow.push({ slot: e.slot, path: file, why: "the OCR secret scan couldn't read it" });
      continue;
    }
    const hits = scanLaneText(read.text, secrets);
    if (hits.length > 0) {
      overflow.push({
        slot: e.slot,
        path: file,
        why: `its text matched a secret pattern (${[...new Set(hits)].join(", ")})`,
      });
      continue;
    }
    taken.add(e.slot);
    total += img.size;
    upload.push({
      slot: e.slot,
      name: e.name,
      path: file,
      data: img.data,
      size: img.size,
      type: img.type,
      ext: img.ext,
      ...(e.label ? { label: e.label } : {}),
    });
  }
  return { ok: true, upload, overflow };
}
