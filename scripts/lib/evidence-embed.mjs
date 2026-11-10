// Renders a test run's published screenshots into the Markdown of the comment
// that reports the run (ADR-0072). Markdown only: what gets published, and
// how, is evidence-images.mjs and evidence-upload.mjs; this module only reads
// the upload record (upload.json) they wrote.
//
// Layout, after the report's own table:
//   **Screenshots**
//   one block per step that took any: the step's label, then one image inline
//   or, for several, a collapsed <details><summary>Screenshots (n)</summary>;
//   then "Other screenshots" for the images no step mentions;
//   then the ones kept on the Mac mini (over the cap, or failed a check), each
//   with its local path and why.
// Images are <img width="480">, so a comment stays readable.
//
// Mapping an image to a step: the browser runner refers to its screenshots
// as "screenshot 1", "screenshot 2", … (factory-browser-prompt.md, rule 7),
// and an upload's image n is the runner's screenshot n (evidence-images.mjs's
// browserManifest). So a result-table row that mentions "screenshot k" gets
// image k; the first row to mention an image keeps it. A macOS harness shot
// is named after the step that took it (`NN-step-<id>-<STATUS>.png`).
//
// The upload record is a file on disk, so it is checked here too: only an
// https://raw.githubusercontent.com URL of this repo, pinned to the record's
// own 40-hex commit, is ever rendered. Step text comes from model output: it
// is capped, every Markdown and HTML character is escaped, and the
// `drafto-factory` token is broken, so a label can't open a tag, a link or a
// marker.

import { readFileSync } from "node:fs";

// result-table.mjs only: browser-report.mjs and verify-report.mjs import this
// module, so it must not import either of them back.
import { parseResultTable } from "./result-table.mjs";

export const IMAGE_WIDTH = 480;
const REPO = "JakubAnderwald/drafto";
const RAW_PREFIX = `https://raw.githubusercontent.com/${REPO}/`;
const IMAGE_URL_RE = new RegExp(
  `^${RAW_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([0-9a-f]{40})/[0-9]{1,7}/[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}/[0-9]{2,3}\\.(?:png|jpg)$`,
);
const OVERFLOW_MAX = 30;
const LABEL_MAX = 100;

// Why nothing was published: an upload record's reason, or the renderer's own.
export const REASONS = Object.freeze({
  withheld: "the report was withheld, so its screenshots were too",
  "not-reported": "the lane didn't report a result",
  off: "publishing is switched off (FACTORY_EVIDENCE_UPLOAD=0)",
  "selftest-missing":
    "the publishing self-test hasn't passed on this Mac mini yet (see the factory runbook)",
  "selftest-failed": "the publishing self-test failed (see the factory runbook)",
  "ocr-missing": "the OCR helper that scans each screenshot for secrets isn't available",
  "account-file": "the test account file couldn't be read, so the secret scan can't be trusted",
  "secret-file": "a secret file couldn't be read, so the secret scan can't be trusted",
  "no-session": "the run's guard log couldn't be found",
  push: "pushing them to GitHub failed",
  remote: "GitHub couldn't be asked whether they were already published",
  none: "the run saved no screenshots",
  "none-passed": "none of its screenshots passed the checks",
  unreadable: "the upload record couldn't be read",
  error: "the upload failed",
});

/** A reason token as a sentence; an unknown token reads as a generic failure. */
export function reasonSentence(token) {
  const t = String(token ?? "");
  if (Object.hasOwn(REASONS, t)) return REASONS[t];
  // A word of our own record, but still unable to spell a factory marker.
  const safe = breakMarkers(t.replace(/[^a-z0-9-]/gi, "").slice(0, 40));
  return safe ? `the upload failed (${safe})` : REASONS.error;
}

// ── text ────────────────────────────────────────────────────────────────────

// Break every `drafto-factory` token with a zero-width space (the same rule as
// browser-report.mjs's defangReport), so text can't spell a factory marker.
function breakMarkers(text) {
  return String(text).replace(/drafto-factory/gi, (m) => `${m.slice(0, 6)}\u200b${m.slice(6)}`);
}

// One line of untrusted text, safe anywhere in a Markdown paragraph: no HTML,
// no emphasis, code, link or table syntax, no factory marker token.
export function labelText(text, max = LABEL_MAX) {
  let s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) {
    s = s.slice(0, max - 1);
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
    s = `${s}…`;
  }
  s = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]|~#!])/g, "\\$1");
  return breakMarkers(s);
}

// A local path from our own record: one line, out of code spans and HTML, and
// unable to spell a marker. The factory checkout's `drafto-factory/` stays
// copy-pasteable.
export function pathText(p) {
  return String(p ?? "")
    .replace(/[\r\n`]/g, "")
    .replace(/</g, "&lt;")
    .replace(/drafto-factory-/gi, (m) => `${m.slice(0, 6)}​${m.slice(6)}`);
}

// ── the upload record ───────────────────────────────────────────────────────

/** An upload record (upload.json), or null when it can't be read. */
export function readUpload(file) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v !== null && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** The record's images that may be rendered, by n. */
export function validImages(upload) {
  if (upload?.ok !== true || !Array.isArray(upload.images)) return [];
  const commit = String(upload.commit ?? "");
  const seen = new Set();
  const out = [];
  for (const img of upload.images) {
    const n = Number(img?.n);
    if (!Number.isInteger(n) || n < 1 || n > 999 || seen.has(n)) continue;
    const m = IMAGE_URL_RE.exec(String(img?.url ?? ""));
    if (!m || m[1] !== commit) continue;
    seen.add(n);
    out.push({ n, url: m[0], label: typeof img.label === "string" ? img.label : "" });
  }
  return out.sort((a, b) => a.n - b.n);
}

function overflowOf(upload) {
  if (!upload || !Array.isArray(upload.overflow)) return [];
  return upload.overflow
    .filter((o) => o && typeof o === "object")
    .map((o) => ({ n: Number(o.n), path: String(o.path ?? ""), why: String(o.why ?? "") }));
}

// ── mapping images to steps ─────────────────────────────────────────────────

const MENTION =
  /\bscreenshots?\b\s*:?\s*(#?\s*\d{1,3}(?!\d)(?:\s*(?:,|&|\+|\/|-|–|—|\band\b|\bto\b|\bthrough\b)\s*#?\s*\d{1,3}(?!\d))*)/gi;
const RANGE_SEP = /^(?:-|–|—|to|through)$/i;

/** The screenshot numbers <text> mentions ("screenshot 2", "screenshots 3–5, 7"), in order. */
export function screenshotMentions(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(MENTION)) {
    const parts = m[1].match(/\d{1,3}|-|–|—|\band\b|\bto\b|\bthrough\b|,|&|\+|\//gi) ?? [];
    let prev = null;
    let range = false;
    for (const p of parts) {
      if (/^\d+$/.test(p)) {
        const n = Number(p);
        if (range && prev !== null && n > prev && n - prev <= 20) {
          for (let k = prev + 1; k <= n; k++) out.push(k);
        } else {
          out.push(n);
        }
        prev = n;
        range = false;
      } else {
        range = RANGE_SEP.test(p);
      }
    }
  }
  return [...new Set(out)];
}

function stepNumber(raw, index) {
  const s = String(raw ?? "")
    .replace(/[^0-9A-Za-z.]/g, "")
    .slice(0, 8);
  return s || String(index + 1);
}

/**
 * Group a browser run's images under the result-table rows that mention
 * them. {groups: [{title, images}], other: images}.
 */
export function groupByReport(report, images) {
  const byN = new Map(images.map((i) => [i.n, i]));
  const taken = new Set();
  const groups = [];
  parseResultTable(report).forEach((row, i) => {
    const mine = [];
    for (const n of screenshotMentions(`${row.step} ${row.evidence}`)) {
      if (byN.has(n) && !taken.has(n)) {
        taken.add(n);
        mine.push(byN.get(n));
      }
    }
    if (!mine.length) return;
    const parts = [`**Step ${labelText(stepNumber(row.num, i), 12)}**`];
    if (row.result) parts.push(row.result);
    if (row.step) parts.push(labelText(row.step));
    // raw: the label's text before escaping, for the caller's secret scan
    // (escaping `dk_` to `dk\_` would hide it from the patterns).
    groups.push({
      title: parts.join(" · "),
      raw: [row.num, row.step].map(String),
      images: mine.sort((a, b) => a.n - b.n),
    });
  });
  return { groups, other: images.filter((img) => !taken.has(img.n)) };
}

const MACOS_STEP_LABEL = /^step-([A-Za-z0-9._-]{1,40})-(PASS|FAIL|WARN|SKIP|ABORTED)$/;

/**
 * Group a macOS harness run's images by the step each was named after
 * (`step-<id>-<STATUS>`), in results.jsonl's order: [{step, name, status}].
 */
export function groupByMacosSteps(results, images) {
  const taken = new Set();
  const groups = [];
  const steps = (Array.isArray(results) ? results : []).filter(
    (r) => r && typeof r.step === "string" && r.step,
  );
  for (const r of steps) {
    const mine = images.filter((img) => {
      const m = MACOS_STEP_LABEL.exec(img.label);
      return m && m[1] === r.step && !taken.has(img.n);
    });
    if (!mine.length) continue;
    for (const img of mine) taken.add(img.n);
    const parts = [`**Step ${labelText(r.step, 40)}**`];
    if (typeof r.status === "string" && r.status) parts.push(labelText(r.status, 12));
    if (typeof r.name === "string" && r.name) parts.push(labelText(r.name));
    groups.push({
      title: parts.join(" · "),
      raw: [r.step, r.status, r.name].filter((v) => typeof v === "string"),
      images: mine,
    });
  }
  return { groups, other: images.filter((img) => !taken.has(img.n)) };
}

// ── rendering ───────────────────────────────────────────────────────────────

function imgTag(img, alt) {
  return `<img src="${img.url}" width="${IMAGE_WIDTH}" alt="${alt}">`;
}

function imageBlock(title, images, altOf) {
  const tags = images.map((img) => imgTag(img, altOf(img)));
  if (tags.length === 1) return [title, "", tags[0], ""];
  return [
    title,
    "",
    "<details>",
    `<summary>Screenshots (${tags.length})</summary>`,
    "",
    ...tags,
    "",
    "</details>",
    "",
  ];
}

function overflowLines(overflow) {
  if (!overflow.length) return [];
  const shown = overflow.slice(0, OVERFLOW_MAX).map((o) => {
    const which = Number.isInteger(o.n) && o.n > 0 ? `screenshot ${o.n}` : "a screenshot";
    return `- ${which}, ${labelText(o.why, 160)}: \`${pathText(o.path)}\``;
  });
  if (overflow.length > OVERFLOW_MAX) shown.push(`- …and ${overflow.length - OVERFLOW_MAX} more.`);
  return ["**Kept on the Mac mini** (not published):", "", ...shown, ""];
}

/**
 * The Markdown lines of the screenshots section: the groups, "Other
 * screenshots", then what was kept on the Mac mini. [] when there is nothing
 * to show.
 */
export function renderEvidence({ groups = [], other = [], overflow = [] }) {
  const lines = [];
  for (const g of groups) {
    lines.push(...imageBlock(g.title, g.images, (img) => `Screenshot ${img.n}`));
  }
  if (other.length) {
    lines.push(
      ...imageBlock(
        groups.length ? "**Other screenshots**" : "**Screenshots taken during the run**",
        other,
        (img) => `Screenshot ${img.n}`,
      ),
    );
  }
  const kept = overflowLines(overflow);
  const out = [...(lines.length ? ["**Screenshots**", "", ...lines] : []), ...kept];
  while (out.length && out.at(-1) === "") out.pop();
  return out;
}

/** Today's footer, with why nothing was published when there is a reason. */
export function localFooter(evidenceDir, reason = null) {
  const why = reason ? ` They weren't published: ${reasonSentence(reason)}.` : "";
  return `<sub>Screenshots stay on the Mac mini (this repo is public): \`${pathText(evidenceDir)}\`.${why}</sub>`;
}

// <mode> "macos": a harness run is on production, posted by the operator.
export function publishedFooter(evidenceDir, mode = "report") {
  if (mode === "macos") {
    return (
      "<sub>Screenshots published by the operator (ADR-0072): the Drafto window during a run " +
      `on production with a throwaway account. Local copies: \`${pathText(evidenceDir)}\`.</sub>`
    );
  }
  return (
    "<sub>Screenshots are published with this report (ADR-0072): they show the dev test " +
    `account on dev data. Local copies and the runner's output: \`${pathText(evidenceDir)}\`.</sub>`
  );
}

/**
 * The screenshots section and footer for one run's report.
 *
 * @param {object} o
 * @param {string|null} o.report the report text (the result table is read from it)
 * @param {object|null|undefined} o.upload the upload record; undefined/null when
 *   none was given (no reason is shown then)
 * @param {boolean} o.withheld the report was withheld: never any image
 * @param {string} o.evidenceDir
 * @param {"report"|"macos"} [o.mode]
 * @param {object[]} [o.results] macOS results.jsonl rows (mode "macos")
 * @param {(lines:string[]) => boolean} [o.isSafe] a final check on the block;
 *   false drops the step labels' text
 * @returns {{block: string[], footer: string, embedded: number, reason: string|null}}
 */
export function evidenceSection({
  report = null,
  upload,
  withheld = false,
  evidenceDir,
  mode = "report",
  results = [],
  isSafe = () => true,
}) {
  if (withheld) {
    return {
      block: [],
      footer: localFooter(evidenceDir, "withheld"),
      embedded: 0,
      reason: "withheld",
    };
  }
  if (upload === undefined || upload === null) {
    return { block: [], footer: localFooter(evidenceDir), embedded: 0, reason: null };
  }
  if (upload.ok !== true) {
    const reason = typeof upload.reason === "string" ? upload.reason : "error";
    return { block: [], footer: localFooter(evidenceDir, reason), embedded: 0, reason };
  }
  const images = validImages(upload);
  const overflow = overflowOf(upload);
  const grouped =
    mode === "macos" ? groupByMacosSteps(results, images) : groupByReport(report, images);
  let block = renderEvidence({ ...grouped, overflow });
  // The check sees the rendered lines and the labels' raw text: the escaping
  // that makes a label safe Markdown would also hide a secret from a scan.
  const raw = grouped.groups.flatMap((g) => g.raw ?? []);
  if (!isSafe([...block, ...raw])) {
    // A step label tripped the caller's scan: keep the images, drop the text.
    const plain = grouped.groups.map((g, i) => ({ ...g, title: `**Step group ${i + 1}**` }));
    block = renderEvidence({ groups: plain, other: grouped.other, overflow });
  }
  if (images.length === 0) {
    const reason = overflow.length ? "none-passed" : "none";
    return { block, footer: localFooter(evidenceDir, reason), embedded: 0, reason };
  }
  return {
    block,
    footer: publishedFooter(evidenceDir, mode),
    embedded: images.length,
    reason: null,
  };
}
