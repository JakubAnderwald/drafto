// Picks the screenshots of one factory test run that may be published with its
// report, and checks each one before it leaves the Mac mini (ADR-0096).
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
//     (common.sh's shot()). A device run's are the files its supervisor
//     listed in evidence/shots.json, each with the sha256 it recorded when it
//     captured the screen itself (ADR-0106 decision 8): deviceManifest checks
//     name, pass and hash, and selectImages re-checks the hash on the bytes it
//     reads. Anything else in the dir is ignored: runner-output.txt, the
//     harness's preflight-window.png and tmp-ocr.png.
//   - Per file: not a symlink, real path strictly inside the evidence dir (the
//     dir itself no symlink), a regular file read through an O_NOFOLLOW fd,
//     .png / .jpg / .jpeg with matching magic bytes, at most MAX_IMAGE_BYTES.
//     The bytes read here are the bytes scanned and the bytes uploaded.
//   - OCR: the helper (apps/desktop/e2e/in-test/lib/ocr.swift, compiled by
//     the caller) reads the image's text; a secret-pattern or password hit
//     drops that image, and so, for a browser run, does an email address
//     (showsEmail). Without the helper nothing is published at all.
//   - The cap: MAX_IMAGES images and MAX_TOTAL_BYTES per comment, in slot
//     order. What doesn't fit, fails a check, or the manifest held back (a
//     rejected, failed or off-origin copy) is listed as kept on the Mac mini
//     with its local path and why — never with what a scan matched.
//
// Pure apart from the file reads and the OCR call, both injectable for tests.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
// device-lane.mjs's captureShot: device-<platform>/<NN>-<flow slug>.png,
// relative to the run's evidence dir. The only manifest name with a dir part.
export const DEVICE_SHOT_NAME = /^device-(ios|android)\/(\d{2})-([a-z0-9._-]+)\.png$/;
export const DEVICE_SHOTS_FILE = "shots.json";
const DEVICE_PLATFORM_ORDER = Object.freeze(["android", "ios"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
export const DEVICE_HASH_WHY = "its sha256 doesn't match shots.json";

export const CAP_WHY = `over the per-comment cap (${MAX_IMAGES} images / ${
  MAX_TOTAL_BYTES / 1024 / 1024
} MB)`;

// An email address in a screenshot's text. ADR-0073 keeps the accounts'
// emails off the public issue (the runner's output is redacted, prompt rule
// 9), and an `(admin)` step's /admin page lists every pending dev user's. Any
// email-shaped string counts, not only the two accounts' own: another user's
// is no better, and a known address the OCR misread wouldn't match a literal.
// The only exceptions are the addresses the web app shows every visitor: the
// support address and the sign-in forms' placeholder.
const EMAIL_SHAPE = /[^\s@<>()[\]{}"'`,;:]+@[^\s@<>()[\]{}"'`,;:]+\.[a-z]{2,}/gi;
export const PUBLIC_EMAILS = Object.freeze(["support@drafto.eu", "you@example.com"]);
export const EMAIL_WHY = "its text showed an email address";

/** Whether <text> shows an email address other than PUBLIC_EMAILS'. Never says which. */
export function showsEmail(text) {
  for (const [match] of String(text ?? "").matchAll(EMAIL_SHAPE)) {
    if (!PUBLIC_EMAILS.includes(match.toLowerCase())) return true;
  }
  return false;
}

// ── manifests ───────────────────────────────────────────────────────────────

// Guard events that mean a tab left the preview, or the guard lost track of
// where one was, during the call that logged them.
const DRIFT_EVENTS = Object.freeze(["quarantined", "unknown", "ambiguous", "gone"]);
// A copy the guard didn't see taken on the preview's origin: a neutral page
// (the new-tab page), a page off the preview, or a log from before the guard
// recorded it (ADR-0096).
export const OFF_ORIGIN_WHY = "taken while the tab wasn't on the preview";

/**
 * A browser run's screenshots, from its session's decision log: one entry per
 * screenshot event, in the order the guard logged them. Slot k (from 1) is
 * the runner's "screenshot k". [{slot, name, missing}]: name is the copied
 * file's basename in the evidence dir, or null when there is no such file
 * (the copy was rejected or failed) or the log's name isn't a guard copy's.
 * missing, when set, says why the screenshot is held back: such an entry is
 * never published, only listed (an off-origin copy keeps its name, so the
 * listing can point at the file).
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
        if (!GUARD_COPY_NAME.test(name)) {
          // Never used as a file name: it isn't one the guard gives a copy.
          out.push({ slot: out.length + 1, name: null, missing: "unexpected file name" });
        } else {
          const missing = e.onOrigin !== true || drifted ? OFF_ORIGIN_WHY : null;
          out.push({ slot: out.length + 1, name, missing });
        }
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

/**
 * A device run's screenshots, from the supervisor's <dir>/shots.json (<dir>:
 * the run's evidence dir; ADR-0106 decision 8). Android's first, then iOS's,
 * each by NN; slots run 1.. over all of them, so the two platforms' 01 shots
 * don't share one. [{slot, name, missing, label, sha256}]: label is
 * "<platform>: <flow>", sha256 the recorded hash selectImages checks the read
 * bytes against. An entry is held back (missing says why) unless its name is
 * device-<platform>/NN-<slug>.png for its own platform, it comes from the
 * final pass, it is listed once, and its file is a regular file (no symlink
 * on the way) inside <dir> whose bytes hash to the recorded sha256. A missing
 * or unreadable shots.json is no screenshots.
 */
export function deviceManifest(dir, { fs = nodeFs } = {}) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(path.join(dir, DEVICE_SHOTS_FILE), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  let realDir = null;
  const dirWhy = rootProblem(dir, { fs });
  if (!dirWhy) {
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      realDir = null;
    }
  }
  const seen = new Set();
  const rows = list.map((raw, order) => {
    const rec = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const file = typeof rec.file === "string" ? rec.file : "";
    const m = DEVICE_SHOT_NAME.exec(file);
    const platform = m ? m[1] : null;
    const flow = typeof rec.flow === "string" && rec.flow.trim() ? rec.flow.trim() : m?.[3];
    const sha256 = typeof rec.sha256 === "string" ? rec.sha256 : "";
    let missing = null;
    if (!m) missing = "unexpected file name";
    else if (rec.platform !== platform) missing = "its platform doesn't match its file name";
    else if (rec.pass !== "final") missing = "not from the final evidence pass";
    else if (seen.has(file)) missing = "listed twice in shots.json";
    else if (!SHA256_RE.test(sha256)) missing = "shots.json records no sha256 for it";
    else if (realDir === null) missing = dirWhy ?? "the evidence directory is missing";
    else missing = deviceFileProblem(dir, realDir, file, sha256, fs);
    if (m) seen.add(file);
    return {
      order,
      rank: platform ? DEVICE_PLATFORM_ORDER.indexOf(platform) : DEVICE_PLATFORM_ORDER.length,
      nn: m ? Number(m[2]) : 0,
      name: m ? file : null,
      missing,
      ...(m ? { label: `${platform}: ${flow}`, sha256 } : {}),
    };
  });
  return rows
    .sort((a, b) => a.rank - b.rank || a.nn - b.nn || a.order - b.order)
    .map(({ order: _o, rank: _r, nn: _n, ...e }, i) => ({ slot: i + 1, ...e }));
}

// Why a shots.json entry's file can't be published, or null: its platform dir
// and the file itself must not be symlinks, its real path must be inside the
// evidence dir, and its bytes must hash to the recorded sha256.
function deviceFileProblem(dir, realDir, name, sha256, fs) {
  const file = path.join(dir, name);
  try {
    if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) return "a symlink";
  } catch {
    return "missing";
  }
  let lst;
  try {
    lst = fs.lstatSync(file);
  } catch {
    return "missing";
  }
  if (lst.isSymbolicLink()) return "a symlink";
  if (!lst.isFile()) return "not a regular file";
  if (lst.size > MAX_IMAGE_BYTES) return `larger than ${sizeText(MAX_IMAGE_BYTES)}`;
  try {
    if (!isStrictlyUnder(fs.realpathSync(file), realDir)) return "outside the evidence directory";
    return sha256Of(fs.readFileSync(file)) === sha256 ? null : DEVICE_HASH_WHY;
  } catch {
    return "it couldn't be read";
  }
}

function sha256Of(data) {
  return createHash("sha256").update(data).digest("hex");
}

// A manifest name selectImages may join onto the evidence dir: a basename, or
// a device shot's device-<platform>/<file> (the only one with a dir part).
function entryName(name) {
  if (typeof name !== "string" || !name) return null;
  if (DEVICE_SHOT_NAME.test(name)) return name;
  return name === path.basename(name) && name !== "." && name !== ".." ? name : null;
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
 *   a manifest (browserManifest / macosManifest / deviceManifest); an entry
 *   with `missing` is never published, only listed in the overflow with that
 *   reason, and one with `sha256` only when the bytes read hash to it
 * @param {((data:Buffer, ext:string) => {ok:boolean,text?:string})|null} o.ocr
 *   null when the helper is missing: then nothing is published
 * @param {{password?:string,bypass?:string,signinKey?:string}} o.secrets
 *   literals to scan the OCR text for (scanLaneText's)
 * @param {boolean} [o.holdEmails] keep back an image whose OCR text shows an
 *   email address (showsEmail); on unless the caller turns it off
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
  holdEmails = true,
  maxImages = MAX_IMAGES,
  maxTotalBytes = MAX_TOTAL_BYTES,
  maxImageBytes = MAX_IMAGE_BYTES,
  ocrBudgetMs = OCR_BUDGET_MS,
  now = Date.now,
  fs = nodeFs,
}) {
  const all = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === "object");
  // A screenshot the manifest held back (the guard rejected it, couldn't copy
  // it, or it wasn't taken on the preview) is never published, but it is
  // listed with why: a row's "screenshot k" with no image is then explained.
  const held = all.filter((e) => e.missing).map((e) => heldBack(e, root));
  const listed = all.filter((e) => e.name && !e.missing);
  const bySlot = (overflow) => overflow.sort((a, b) => a.slot - b.slot);
  if (listed.length === 0) return { ok: true, upload: [], overflow: bySlot(held) };
  if (typeof ocr !== "function") return { ok: false, reason: "ocr-missing" };
  const rootWhy = rootProblem(root, { fs });
  if (rootWhy) {
    return {
      ok: true,
      upload: [],
      overflow: bySlot([
        ...held,
        ...listed.map((e) => ({ slot: e.slot, path: path.join(root, e.name), why: rootWhy })),
      ]),
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
    // A manifest name is a basename (or a device shot's platform dir plus
    // one): one that isn't is not this run's file.
    if (entryName(e.name) === null) {
      overflow.push({ slot: e.slot, path: root, why: "unexpected file name" });
      continue;
    }
    const file = path.join(root, e.name);
    if (taken.has(e.slot)) {
      overflow.push({ slot: e.slot, path: file, why: "another screenshot has the same number" });
      continue;
    }
    // A device shot's platform dir is checked again here: swapped for a link
    // since deviceManifest looked, it could point anywhere inside the root.
    if (path.dirname(e.name) !== "." && subdirIsLink(path.join(root, path.dirname(e.name)), fs)) {
      overflow.push({ slot: e.slot, path: file, why: "a symlink" });
      continue;
    }
    const img = checkImage(file, root, { maxBytes: maxImageBytes, realRoot, fs });
    if (!img.ok) {
      overflow.push({ slot: e.slot, path: file, why: img.why });
      continue;
    }
    // A device shot: the bytes read now must be the ones its supervisor
    // hashed when it captured them (ADR-0106 decision 8).
    if (typeof e.sha256 === "string" && sha256Of(img.data) !== e.sha256) {
      overflow.push({ slot: e.slot, path: file, why: DEVICE_HASH_WHY });
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
    if (holdEmails && showsEmail(read.text)) {
      overflow.push({ slot: e.slot, path: file, why: EMAIL_WHY });
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
  return { ok: true, upload, overflow: bySlot([...held, ...overflow]) };
}

// A held-back manifest entry as an overflow line: its file when it names one
// (an off-origin copy), else the evidence dir, since there is no file.
function heldBack(e, root) {
  const name = entryName(e.name);
  return { slot: e.slot, path: name ? path.join(root, name) : root, why: String(e.missing) };
}

function subdirIsLink(dir, fs) {
  try {
    return fs.lstatSync(dir).isSymbolicLink();
  } catch {
    return false;
  }
}
