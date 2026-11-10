import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMAGE_WIDTH,
  REASONS,
  evidenceSection,
  groupByMacosSteps,
  groupByReport,
  labelText,
  localFooter,
  pathText,
  publishedFooter,
  readUpload,
  reasonSentence,
  renderEvidence,
  screenshotMentions,
  validImages,
} from "../lib/evidence-embed.mjs";
import { imagePath, rawUrl } from "../lib/evidence-upload.mjs";

// evidence-embed.mjs turns an upload record (upload.json) into the Markdown
// that puts a run's screenshots into a public GitHub comment (ADR-0072). These
// tests lock in the layout (one image inline, several in a <details>), the
// "screenshot k" → step mapping, the "kept on the Mac mini" overflow list, and
// the fallbacks: a withheld report shows no image, a failed upload keeps
// today's "Screenshots stay on the Mac mini" footer and says why. They also
// lock in the two checks that make the comment safe: only raw URLs of this
// repo pinned to the record's own commit are ever rendered, and step text
// (model output) can't open a tag, a link, a code span or a factory marker.

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const ISSUE = 797;
const RUN = "intest-20261110T1200";
const DIR = "/Volumes/DraftoFactory/drafto-factory/logs/browser/797/run-1/evidence";
const RAW = "https://raw.githubusercontent.com/JakubAnderwald/drafto";

function url(n, { commit = COMMIT, ext = "png" } = {}) {
  return `${RAW}/${commit}/${ISSUE}/${HEAD.slice(0, 12)}/${RUN}/${String(n).padStart(2, "0")}.${ext}`;
}

function image(n, extra = {}) {
  return { n, url: url(n), local: `${DIR}/shot-${n}.png`, name: `shot-${n}.png`, ...extra };
}

function upload(ns, extra = {}) {
  return {
    ok: true,
    issue: ISSUE,
    sha: HEAD,
    runId: RUN,
    ref: `refs/factory-evidence/${ISSUE}/${HEAD.slice(0, 12)}/${RUN}`,
    commit: COMMIT,
    images: ns.map((n) => image(n)),
    overflow: [],
    ...extra,
  };
}

function imgTag(n, opts) {
  return `<img src="${url(n, opts)}" width="480" alt="Screenshot ${n}">`;
}

function table(rows) {
  return [
    "| # | Step | Result | Evidence |",
    "|---|------|--------|----------|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

const valid = (ns) => validImages(upload(ns));

// The Markdown characters in <s> not escaped by a backslash (CommonMark: a
// backslash escapes the next character, so `\\` is a literal backslash).
function unescaped(s, chars = "*_[]`|") {
  const found = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (chars.includes(s[i])) found.push(s[i]);
  }
  return found;
}

describe("reasonSentence", () => {
  it("reads every known token as its sentence", () => {
    for (const [token, sentence] of Object.entries(REASONS)) {
      assert.equal(reasonSentence(token), sentence, token);
    }
    assert.equal(reasonSentence("push"), "pushing them to GitHub failed");
    assert.equal(
      reasonSentence("withheld"),
      "the report was withheld, so its screenshots were too",
    );
  });

  it("reads an unknown token as a generic failure that names it", () => {
    assert.equal(reasonSentence("rate-limited"), "the upload failed (rate-limited)");
    assert.equal(reasonSentence("constructor"), "the upload failed (constructor)");
    assert.equal(reasonSentence("toString"), "the upload failed (toString)");
    assert.equal(reasonSentence("__proto__"), "the upload failed (proto)");
  });

  it("reads no token, or one with nothing safe in it, as the plain generic failure", () => {
    for (const t of [null, undefined, "", "<>!!", "   "]) {
      assert.equal(reasonSentence(t), REASONS.error, String(t));
    }
  });

  it("keeps only letters, digits and hyphens of a hostile token, capped at 40", () => {
    const s = reasonSentence('<img src=x onerror="alert(1)">`code`\n**b**');
    assert.match(s, /^the upload failed \([A-Za-z0-9-]{1,40}\)$/);
    assert.ok(!s.includes("<") && !s.includes("`") && !s.includes("*"));
    assert.equal(reasonSentence("a".repeat(100)), `the upload failed (${"a".repeat(40)})`);
  });

  it("breaks the drafto-factory token, so a reason can't spell a factory marker", () => {
    for (const t of ["drafto-factory-merge-failed", "<!-- drafto-factory-test-scenario -->"]) {
      assert.doesNotMatch(reasonSentence(t), /drafto-factory/i, t);
    }
  });
});

describe("labelText", () => {
  it("escapes HTML", () => {
    assert.equal(labelText("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
    assert.equal(labelText("<details>"), "&lt;details&gt;");
  });

  it("escapes every Markdown character that could start emphasis, code, a link or a cell", () => {
    assert.equal(labelText("**x**"), "\\*\\*x\\*\\*");
    assert.equal(labelText("a_b"), "a\\_b");
    assert.equal(labelText("`c`"), "\\`c\\`");
    assert.equal(labelText("[l](u)"), "\\[l\\](u)");
    assert.equal(labelText("a|b"), "a\\|b");
    assert.equal(labelText("a\\b"), "a\\\\b");
    assert.equal(labelText("~#!"), "\\~\\#\\!");
  });

  it("collapses whitespace and newlines to one line", () => {
    assert.equal(labelText("  a\n\nb\r\n\tc  "), "a b c");
  });

  it("caps the text, without splitting a surrogate pair", () => {
    const long = labelText("x".repeat(200));
    assert.equal(long.length, 100);
    assert.ok(long.endsWith("…"));
    assert.equal(labelText("abc", 2), "a…");
    assert.equal(labelText("abc", 3), "abc");
    const emoji = labelText(`${"a".repeat(98)}😀b`);
    assert.equal(emoji, `${"a".repeat(98)}…`);
    assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("breaks the drafto-factory token in any case", () => {
    const s = labelText("<!-- drafto-factory-plan --> DRAFTO-FACTORY Drafto-Factory");
    assert.doesNotMatch(s, /drafto-factory/i);
    assert.ok(!s.includes("<!--"));
    assert.ok(s.includes("drafto​-factory-plan"));
  });

  it("reads null and undefined as empty", () => {
    assert.equal(labelText(null), "");
    assert.equal(labelText(undefined), "");
  });
});

describe("pathText", () => {
  it("keeps the factory checkout's drafto-factory/ copy-pasteable", () => {
    assert.equal(pathText(DIR), DIR);
  });

  it("breaks drafto-factory- in any case", () => {
    const s = pathText("/tmp/drafto-factory-merge-failed/DRAFTO-FACTORY-x/a.png");
    assert.doesNotMatch(s, /drafto-factory-/i);
    assert.ok(s.includes("drafto​-factory-merge-failed"));
  });

  it("strips backticks and newlines, and escapes <", () => {
    assert.equal(pathText("/a`b\nc\rd"), "/abcd");
    assert.equal(pathText("/a/<!--x"), "/a/&lt;!--x");
    assert.equal(pathText(null), "");
  });
});

describe("readUpload", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "evidence-embed-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads an upload record", () => {
    const file = join(dir, "upload.json");
    writeFileSync(file, JSON.stringify(upload([1])));
    assert.deepEqual(readUpload(file), upload([1]));
  });

  it("returns null for a missing file, bad JSON, or JSON that isn't an object", () => {
    assert.equal(readUpload(join(dir, "missing.json")), null);
    for (const [name, text] of [
      ["bad.json", "{not json"],
      ["null.json", "null"],
      ["num.json", "5"],
      ["str.json", '"ok"'],
    ]) {
      const file = join(dir, name);
      writeFileSync(file, text);
      assert.equal(readUpload(file), null, name);
    }
  });
});

describe("validImages", () => {
  it("keeps the record's well-formed images, sorted by n, with their labels", () => {
    const rec = upload([], {
      images: [image(3, { label: "step-a-PASS" }), image(1), image(2, { label: 7 })],
    });
    assert.deepEqual(validImages(rec), [
      { n: 1, url: url(1), label: "" },
      { n: 2, url: url(2), label: "" },
      { n: 3, url: url(3), label: "step-a-PASS" },
    ]);
  });

  it("accepts the URLs the uploader writes, png and jpg", () => {
    const rec = upload([], {
      images: [
        { n: 1, url: rawUrl(COMMIT, imagePath(ISSUE, HEAD, RUN, 1, "png")) },
        { n: 2, url: rawUrl(COMMIT, imagePath(ISSUE, HEAD, RUN, 2, "jpg")) },
      ],
    });
    assert.deepEqual(
      validImages(rec).map((i) => i.n),
      [1, 2],
    );
  });

  it("drops a URL on another host", () => {
    const rest = `JakubAnderwald/drafto/${COMMIT}/${ISSUE}/${HEAD.slice(0, 12)}/${RUN}/01.png`;
    for (const bad of [
      `https://evil.example/${rest}`,
      `https://raw.githubusercontent.com.evil.example/${rest}`,
      `https://rawXgithubusercontent.com/${rest}`,
      `https://user-images.githubusercontent.com/${rest}`,
      `https://github.com/${rest}`,
    ]) {
      assert.deepEqual(validImages(upload([], { images: [{ n: 1, url: bad }] })), [], bad);
    }
  });

  it("drops a URL of another repo", () => {
    const tail = `${COMMIT}/${ISSUE}/${HEAD.slice(0, 12)}/${RUN}/01.png`;
    for (const bad of [
      `https://raw.githubusercontent.com/someone/drafto/${tail}`,
      `https://raw.githubusercontent.com/JakubAnderwald/drafto-fork/${tail}`,
      `https://raw.githubusercontent.com/JakubAnderwald/other/${tail}`,
    ]) {
      assert.deepEqual(validImages(upload([], { images: [{ n: 1, url: bad }] })), [], bad);
    }
  });

  it("drops a URL pinned to another commit than the record's, or to a branch", () => {
    const rec = upload([], {
      images: [image(1), { n: 2, url: url(2, { commit: OTHER_COMMIT }) }],
    });
    assert.deepEqual(
      validImages(rec).map((i) => i.n),
      [1],
    );
    assert.deepEqual(validImages({ ...upload([1]), commit: undefined }), []);
    assert.deepEqual(validImages({ ...upload([1]), commit: null }), []);
    const branch = url(1).replace(COMMIT, "main");
    assert.deepEqual(validImages(upload([], { images: [{ n: 1, url: branch }] })), []);
    const short = url(1).replace(COMMIT, COMMIT.slice(0, 7));
    assert.deepEqual(validImages(upload([], { images: [{ n: 1, url: short }] })), []);
  });

  it("drops an http:// URL", () => {
    const bad = url(1).replace("https://", "http://");
    assert.deepEqual(validImages(upload([], { images: [{ n: 1, url: bad }] })), []);
  });

  it("drops a URL whose path doesn't match the evidence layout", () => {
    const base = `${RAW}/${COMMIT}`;
    const sha12 = HEAD.slice(0, 12);
    for (const bad of [
      `${base}/${ISSUE}/nothex000000/${RUN}/01.png`,
      `${base}/${ISSUE}/${sha12}/${RUN}/1.png`,
      `${base}/${ISSUE}/${sha12}/${RUN}/01.gif`,
      `${base}/${ISSUE}/${sha12}/${RUN}/01.svg`,
      `${base}/${ISSUE}/${sha12}/../01.png`,
      `${base}/${ISSUE}/${sha12}/${RUN}/sub/01.png`,
      `${base}/${sha12}/${RUN}/01.png`,
      `${base}/x${ISSUE}/${sha12}/${RUN}/01.png`,
      `${url(1)}?raw=1`,
      `${url(1)}#x`,
      `${url(1)}\n`,
      `${url(1)}" onerror="alert(1)`,
      ` ${url(1)}`,
      "",
    ]) {
      assert.deepEqual(validImages(upload([], { images: [{ n: 1, url: bad }] })), [], bad);
    }
  });

  it("keeps the first image for a duplicate n", () => {
    const rec = upload([], { images: [image(1), { n: 1, url: url(5) }] });
    assert.deepEqual(validImages(rec), [{ n: 1, url: url(1), label: "" }]);
  });

  it("drops an image whose n isn't an integer from 1 to 999", () => {
    for (const n of [1.5, "x", null, undefined, 0, -1, 1000, Number.NaN, Infinity]) {
      assert.deepEqual(validImages(upload([], { images: [{ n, url: url(1) }] })), [], String(n));
    }
  });

  it("returns nothing for a failed record, even with images in it", () => {
    assert.deepEqual(validImages({ ...upload([1, 2]), ok: false, reason: "push" }), []);
    assert.deepEqual(validImages({ ...upload([1]), ok: "true" }), []);
    assert.deepEqual(validImages({ ...upload([1]), images: "nope" }), []);
    assert.deepEqual(validImages(null), []);
    assert.deepEqual(validImages(undefined), []);
  });
});

describe("screenshotMentions", () => {
  it("reads one screenshot", () => {
    assert.deepEqual(screenshotMentions("see screenshot 2"), [2]);
    assert.deepEqual(screenshotMentions("screenshot #4"), [4]);
    assert.deepEqual(screenshotMentions("Screenshot: 1"), [1]);
    assert.deepEqual(screenshotMentions("SCREENSHOT 7."), [7]);
  });

  it("reads a list", () => {
    assert.deepEqual(screenshotMentions("screenshots 2 and 3"), [2, 3]);
    assert.deepEqual(screenshotMentions("screenshots #2, #3"), [2, 3]);
    assert.deepEqual(screenshotMentions("screenshots 2/3"), [2, 3]);
    assert.deepEqual(screenshotMentions("screenshots 2 & 3"), [2, 3]);
    assert.deepEqual(screenshotMentions("screenshots 2 + 3"), [2, 3]);
    // A comma before the last word or symbol ("Oxford comma").
    assert.deepEqual(screenshotMentions("screenshots 1, 2, and 3"), [1, 2, 3]);
    assert.deepEqual(screenshotMentions("screenshots 1, 2, & 3"), [1, 2, 3]);
    assert.deepEqual(screenshotMentions("screenshots 3–5, and 7"), [3, 4, 5, 7]);
    assert.deepEqual(screenshotMentions("screenshot 2, step 4"), [2]);
  });

  it("reads across line breaks and runs of spaces", () => {
    assert.deepEqual(screenshotMentions("screenshot\n\n  4"), [4]);
    assert.deepEqual(screenshotMentions("screenshots 1 ,\t 2"), [1, 2]);
  });

  it("stays fast on hostile whitespace (no catastrophic backtracking)", () => {
    const hostile = `${"screenshot" + " ".repeat(20_000) + "x "}`.repeat(5);
    const t0 = process.hrtime.bigint();
    assert.deepEqual(screenshotMentions(hostile), []);
    assert.deepEqual(screenshotMentions(`${hostile} screenshot 3`), []);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 500, `took ${ms} ms`);
  });

  it("reads a range", () => {
    assert.deepEqual(screenshotMentions("screenshots 3–5"), [3, 4, 5]);
    assert.deepEqual(screenshotMentions("screenshots 3-5"), [3, 4, 5]);
    assert.deepEqual(screenshotMentions("screenshots 3 — 5"), [3, 4, 5]);
    assert.deepEqual(screenshotMentions("screenshots 1 to 3"), [1, 2, 3]);
    assert.deepEqual(screenshotMentions("screenshots 4 through 6"), [4, 5, 6]);
    assert.deepEqual(screenshotMentions("screenshots 3–5, 7"), [3, 4, 5, 7]);
  });

  it("caps a range at 20 steps, and doesn't expand one that runs backwards", () => {
    assert.deepEqual(
      screenshotMentions("screenshots 1–21"),
      Array.from({ length: 21 }, (_, i) => i + 1),
    );
    assert.deepEqual(screenshotMentions("screenshots 1–22"), [1, 22]);
    assert.deepEqual(screenshotMentions("screenshots 1-500"), [1, 500]);
    assert.deepEqual(screenshotMentions("screenshots 5-3"), [5, 3]);
  });

  it("reads every mention in order, once each", () => {
    assert.deepEqual(
      screenshotMentions("screenshot 3, then screenshot 1 and screenshot 3 again"),
      [3, 1],
    );
  });

  it("reads nothing that isn't a screenshot mention", () => {
    for (const t of ["step 2", "screen shot 2", "screenshotting 2", "screenshot", "", null]) {
      assert.deepEqual(screenshotMentions(t), [], String(t));
    }
  });
});

describe("groupByReport", () => {
  it("puts each image under the row that mentions it", () => {
    const report = table([
      ["1", "Sign in", "PASS", "screenshot 1"],
      ["2", "Open the note", "FAIL", "screenshots 2 and 3"],
    ]);
    const { groups, other } = groupByReport(report, valid([1, 2, 3]));
    assert.deepEqual(
      groups.map((g) => [g.title, g.images.map((i) => i.n)]),
      [
        ["**Step 1** · PASS · Sign in", [1]],
        ["**Step 2** · FAIL · Open the note", [2, 3]],
      ],
    );
    assert.deepEqual(other, []);
  });

  it("reads mentions in the step text too", () => {
    const report = table([["1", "Sign in (screenshot 2)", "PASS", "—"]]);
    const { groups } = groupByReport(report, valid([1, 2]));
    assert.deepEqual(
      groups.map((g) => g.images.map((i) => i.n)),
      [[2]],
    );
  });

  it("gives an image to the first row that mentions it", () => {
    const report = table([
      ["1", "First", "PASS", "screenshots 1 and 2"],
      ["2", "Second", "PASS", "screenshots 2 and 3"],
      ["3", "Third", "PASS", "screenshot 1"],
    ]);
    const { groups, other } = groupByReport(report, valid([1, 2, 3]));
    assert.deepEqual(
      groups.map((g) => [g.title, g.images.map((i) => i.n)]),
      [
        ["**Step 1** · PASS · First", [1, 2]],
        ["**Step 2** · PASS · Second", [3]],
      ],
    );
    assert.deepEqual(other, []);
  });

  it("leaves the images no row mentions for Other, and ignores mentions of missing ones", () => {
    const report = table([
      ["1", "Sign in", "PASS", "screenshot 9"],
      ["2", "Open", "PASS", "screenshot 2"],
    ]);
    const { groups, other } = groupByReport(report, valid([1, 2, 3]));
    assert.deepEqual(
      groups.map((g) => g.title),
      ["**Step 2** · PASS · Open"],
    );
    assert.deepEqual(
      other.map((i) => i.n),
      [1, 3],
    );
  });

  it("sorts a step's images by n", () => {
    const report = table([["1", "a", "PASS", "screenshots 3 and 1"]]);
    const { groups } = groupByReport(report, valid([1, 3]));
    assert.deepEqual(
      groups[0].images.map((i) => i.n),
      [1, 3],
    );
  });

  it("reduces the # cell to a short safe token, or the row's position when there is none", () => {
    const bold = table([["**3**", "x", "PASS", "screenshot 1"]]);
    assert.equal(groupByReport(bold, valid([1])).groups[0].title, "**Step 3** · PASS · x");
    const noNum = [
      "| Step | Result | Evidence |",
      "|---|---|---|",
      "| a | PASS | — |",
      "| b | WARN | screenshot 1 |",
    ].join("\n");
    assert.equal(groupByReport(noNum, valid([1])).groups[0].title, "**Step 2** · WARN · b");
  });

  it("puts everything under Other when there is no result table", () => {
    for (const report of [null, "", "no table here"]) {
      const { groups, other } = groupByReport(report, valid([1, 2]));
      assert.deepEqual(groups, []);
      assert.deepEqual(
        other.map((i) => i.n),
        [1, 2],
      );
    }
  });
});

describe("groupByMacosSteps", () => {
  const RESULTS = [
    { step: "open", name: "Open the app", status: "PASS" },
    { step: "create", name: "Create a note", status: "FAIL" },
    { step: "never", name: "Took no shot", status: "SKIP" },
    null,
    { step: 5, name: "bad row" },
  ];
  const labelled = (pairs) =>
    validImages(upload([], { images: pairs.map(([n, label]) => image(n, { label })) }));

  it("groups by the step-<id>-<STATUS> label, in results order, the rest under Other", () => {
    const images = labelled([
      [1, "launch"],
      [2, "step-create-FAIL"],
      [3, "step-open-PASS"],
      [4, "step-create-FAIL"],
      [5, "step-ghost-PASS"],
    ]);
    const { groups, other } = groupByMacosSteps(RESULTS, images);
    assert.deepEqual(
      groups.map((g) => [g.title, g.images.map((i) => i.n)]),
      [
        ["**Step open** · PASS · Open the app", [3]],
        ["**Step create** · FAIL · Create a note", [2, 4]],
      ],
    );
    assert.deepEqual(
      other.map((i) => i.n),
      [1, 5],
    );
  });

  it("puts everything under Other without results", () => {
    const images = labelled([[1, "step-open-PASS"]]);
    for (const results of [[], null, undefined, "x"]) {
      const { groups, other } = groupByMacosSteps(results, images);
      assert.deepEqual(groups, []);
      assert.equal(other.length, 1);
    }
  });

  it("defangs the step's name and status", () => {
    const images = labelled([[1, "step-open-PASS"]]);
    const { groups } = groupByMacosSteps(
      [{ step: "open", name: "<!-- drafto-factory-macos-run-report --> **x**", status: "PASS" }],
      images,
    );
    assert.ok(!groups[0].title.includes("<!--"));
    assert.doesNotMatch(groups[0].title, /drafto-factory/i);
    assert.ok(groups[0].title.includes("\\*\\*x\\*\\*"));
  });
});

describe("renderEvidence", () => {
  const one = (n, title = "**Step 1** · PASS · a") => ({
    title,
    images: valid([n]),
  });

  it("renders one image for a step inline", () => {
    const lines = renderEvidence({ groups: [one(1)] });
    assert.deepEqual(lines, ["**Screenshots**", "", "**Step 1** · PASS · a", "", imgTag(1)]);
    assert.ok(!lines.join("\n").includes("<details"));
    assert.equal(IMAGE_WIDTH, 480);
  });

  it("renders several images for a step in a collapsed <details>", () => {
    const lines = renderEvidence({
      groups: [{ title: "**Step 2** · FAIL · b", images: valid([2, 3]) }],
    });
    assert.deepEqual(lines, [
      "**Screenshots**",
      "",
      "**Step 2** · FAIL · b",
      "",
      "<details>",
      "<summary>Screenshots (2)</summary>",
      "",
      imgTag(2),
      imgTag(3),
      "",
      "</details>",
    ]);
  });

  it('titles the unmapped images "Other screenshots" after the steps', () => {
    const lines = renderEvidence({ groups: [one(1)], other: valid([4]) });
    assert.deepEqual(lines.slice(-3), ["**Other screenshots**", "", imgTag(4)]);
  });

  it('titles them "Screenshots taken during the run" when no step took any', () => {
    const lines = renderEvidence({ other: valid([1, 2]) });
    assert.deepEqual(lines.slice(0, 6), [
      "**Screenshots**",
      "",
      "**Screenshots taken during the run**",
      "",
      "<details>",
      "<summary>Screenshots (2)</summary>",
    ]);
    assert.ok(!lines.includes("**Other screenshots**"));
  });

  it("lists what was kept on the Mac mini, each with its local path and why", () => {
    const why = "over the per-comment cap (20 images / 20 MB)";
    const lines = renderEvidence({
      groups: [one(1)],
      overflow: [
        { n: 21, path: `${DIR}/shot-21.png`, why },
        { n: Number.NaN, path: `${DIR}/x.png`, why: "the OCR secret scan couldn't read it" },
      ],
    });
    const at = lines.indexOf("**Kept on the Mac mini** (not published):");
    assert.ok(at > 0);
    assert.deepEqual(lines.slice(at), [
      "**Kept on the Mac mini** (not published):",
      "",
      `- screenshot 21, ${why}: \`${DIR}/shot-21.png\``,
      `- a screenshot, the OCR secret scan couldn't read it: \`${DIR}/x.png\``,
    ]);
  });

  it('caps the kept list at 30, with "…and N more"', () => {
    const overflow = Array.from({ length: 33 }, (_, i) => ({
      n: i + 1,
      path: `${DIR}/shot-${i + 1}.png`,
      why: "too big",
    }));
    const lines = renderEvidence({ overflow });
    const items = lines.filter((l) => l.startsWith("- "));
    assert.equal(items.length, 31);
    assert.equal(items[29], `- screenshot 30, too big: \`${DIR}/shot-30.png\``);
    assert.equal(items[30], "- …and 3 more.");
    assert.equal(lines[0], "**Kept on the Mac mini** (not published):", "no Screenshots heading");
  });

  it("defangs a kept file's path and why", () => {
    const lines = renderEvidence({
      overflow: [{ n: 1, path: "/tmp/a`b\n<!-- drafto-factory-x -->.png", why: "<b>**x**</b>" }],
    });
    const text = lines.join("\n");
    assert.ok(!text.includes("<!--"));
    assert.ok(!text.includes("<b>"));
    assert.doesNotMatch(text, /drafto-factory-/);
    assert.equal(lines.length, 3, "the path stays on one line");
  });

  it("renders nothing when there is nothing to show, and never ends on a blank line", () => {
    assert.deepEqual(renderEvidence({}), []);
    assert.notEqual(renderEvidence({ groups: [one(1)], other: valid([2]) }).at(-1), "");
  });
});

describe("localFooter / publishedFooter", () => {
  it("keeps the existing sentence when there is no reason", () => {
    assert.equal(
      localFooter(DIR),
      `<sub>Screenshots stay on the Mac mini (this repo is public): \`${DIR}\`.</sub>`,
    );
    assert.equal(localFooter(DIR, null), localFooter(DIR));
  });

  it("adds why nothing was published when there is a reason", () => {
    assert.equal(
      localFooter(DIR, "push"),
      `<sub>Screenshots stay on the Mac mini (this repo is public): \`${DIR}\`.` +
        ` They weren't published: ${REASONS.push}.</sub>`,
    );
    assert.ok(localFooter(DIR, "ocr-missing").includes(REASONS["ocr-missing"]));
  });

  it("can't be broken out of by a hostile reason or directory", () => {
    const f = localFooter("/tmp/a`b</sub>\nc", "</sub><img src=x>");
    assert.equal(f.match(/<\/sub>/g).length, 1);
    assert.ok(!f.includes("<img"));
    assert.ok(f.includes("`/tmp/ab&lt;/sub>c`"));
  });

  it("says the published screenshots are the dev test account's, or the operator's macOS run's", () => {
    const web = publishedFooter(DIR);
    assert.ok(web.startsWith("<sub>") && web.endsWith("</sub>"));
    assert.ok(web.includes("ADR-0072") && web.includes("dev test account"));
    assert.ok(web.includes(`\`${DIR}\``));
    const mac = publishedFooter(DIR, "macos");
    assert.ok(mac.includes("published by the operator") && mac.includes("production"));
    assert.ok(mac.includes(`\`${DIR}\``));
  });
});

describe("evidenceSection", () => {
  const REPORT = table([
    ["1", "Sign in", "PASS", "screenshot 1"],
    ["2", "Open the note", "FAIL", "screenshots 2 and 3"],
  ]);

  it("embeds the published images under their steps, with the published footer", () => {
    const ev = evidenceSection({ report: REPORT, upload: upload([1, 2, 3, 4]), evidenceDir: DIR });
    const text = ev.block.join("\n");
    assert.equal(ev.embedded, 4);
    assert.equal(ev.reason, null);
    assert.equal(ev.footer, publishedFooter(DIR));
    for (const n of [1, 2, 3, 4]) assert.ok(text.includes(imgTag(n)), `image ${n}`);
    assert.ok(text.includes("**Step 1** · PASS · Sign in\n\n" + imgTag(1)));
    assert.ok(text.includes("<summary>Screenshots (2)</summary>"));
    assert.ok(text.includes("**Other screenshots**\n\n" + imgTag(4)));
  });

  it("counts and renders only the valid images", () => {
    const rec = upload([1], {
      images: [image(1), { n: 2, url: url(2, { commit: OTHER_COMMIT }) }],
    });
    const ev = evidenceSection({ report: REPORT, upload: rec, evidenceDir: DIR });
    assert.equal(ev.embedded, 1);
    assert.ok(!ev.block.join("\n").includes(OTHER_COMMIT));
  });

  it("shows no image for a withheld report, even when given images", () => {
    const ev = evidenceSection({
      report: REPORT,
      upload: upload([1, 2]),
      withheld: true,
      evidenceDir: DIR,
    });
    assert.deepEqual(ev, {
      block: [],
      footer: localFooter(DIR, "withheld"),
      embedded: 0,
      reason: "withheld",
    });
    assert.ok(ev.footer.includes(REASONS.withheld));
    assert.ok(!ev.footer.includes("raw.githubusercontent.com"));
  });

  it("keeps today's footer, with no reason, when no upload record was given", () => {
    for (const rec of [undefined, null]) {
      const ev = evidenceSection({ report: REPORT, upload: rec, evidenceDir: DIR });
      assert.deepEqual(ev, { block: [], footer: localFooter(DIR), embedded: 0, reason: null });
      assert.ok(!ev.footer.includes("weren't published"));
    }
  });

  it("falls back to today's footer and the reason when the upload failed", () => {
    const ev = evidenceSection({
      report: REPORT,
      upload: { ...upload([1, 2]), ok: false, reason: "push" },
      evidenceDir: DIR,
    });
    assert.deepEqual(ev, {
      block: [],
      footer: localFooter(DIR, "push"),
      embedded: 0,
      reason: "push",
    });
    for (const rec of [{ ok: false }, { ok: false, reason: 42 }, {}, []]) {
      const r = evidenceSection({ report: REPORT, upload: rec, evidenceDir: DIR });
      assert.equal(r.reason, "error", JSON.stringify(rec));
      assert.equal(r.footer, localFooter(DIR, "error"));
      assert.deepEqual(r.block, []);
    }
  });

  it('says "none" when the run saved no screenshots', () => {
    const ev = evidenceSection({
      report: REPORT,
      upload: upload([], { commit: null }),
      evidenceDir: DIR,
    });
    assert.deepEqual(ev, {
      block: [],
      footer: localFooter(DIR, "none"),
      embedded: 0,
      reason: "none",
    });
  });

  it('says "none-passed", and lists them, when none passed the checks', () => {
    const ev = evidenceSection({
      report: REPORT,
      upload: upload([], {
        commit: null,
        overflow: [{ n: 1, path: `${DIR}/shot-1.png`, why: "it is not a PNG or JPEG image" }],
      }),
      evidenceDir: DIR,
    });
    assert.equal(ev.reason, "none-passed");
    assert.equal(ev.embedded, 0);
    assert.equal(ev.footer, localFooter(DIR, "none-passed"));
    assert.deepEqual(ev.block, [
      "**Kept on the Mac mini** (not published):",
      "",
      `- screenshot 1, it is not a PNG or JPEG image: \`${DIR}/shot-1.png\``,
    ]);
  });

  it("lists the overflow next to the published images", () => {
    const ev = evidenceSection({
      report: REPORT,
      upload: upload([1], { overflow: [{ n: 21, path: `${DIR}/shot-21.png`, why: "too many" }] }),
      evidenceDir: DIR,
    });
    assert.equal(ev.embedded, 1);
    assert.equal(ev.footer, publishedFooter(DIR));
    assert.ok(ev.block.includes(`- screenshot 21, too many: \`${DIR}/shot-21.png\``));
  });

  it("drops the step labels' text, but keeps the images, when isSafe says no", () => {
    const report = table([
      ["1", "Typed hunter2 into the field", "PASS", "screenshot 1"],
      ["2", "Saved", "PASS", "screenshot 2"],
    ]);
    const seen = [];
    const ev = evidenceSection({
      report,
      upload: upload([1, 2, 3]),
      evidenceDir: DIR,
      isSafe: (lines) => {
        seen.push(lines);
        return !lines.join("\n").includes("hunter2");
      },
    });
    const text = ev.block.join("\n");
    assert.ok(Array.isArray(seen[0]) && seen[0].join("\n").includes("hunter2"));
    assert.ok(!text.includes("hunter2"));
    assert.ok(!text.includes("Saved"));
    assert.ok(text.includes("**Step group 1**\n\n" + imgTag(1)));
    assert.ok(text.includes("**Step group 2**\n\n" + imgTag(2)));
    assert.ok(text.includes("**Other screenshots**\n\n" + imgTag(3)));
    assert.equal(ev.embedded, 3);
    assert.equal(ev.footer, publishedFooter(DIR));
  });

  it("groups a macOS run by its step-<id>-<STATUS> labels", () => {
    const rec = upload([], {
      images: [
        image(1, { label: "step-open-PASS" }),
        image(2, { label: "step-type-FAIL" }),
        image(3, { label: "step-type-FAIL" }),
        image(4, { label: "after-run" }),
      ],
    });
    const ev = evidenceSection({
      upload: rec,
      evidenceDir: DIR,
      mode: "macos",
      results: [
        { step: "open", name: "Open Drafto", status: "PASS" },
        { step: "type", name: "Type a note", status: "FAIL" },
      ],
    });
    const text = ev.block.join("\n");
    assert.equal(ev.embedded, 4);
    assert.equal(ev.footer, publishedFooter(DIR, "macos"));
    assert.ok(text.includes("**Step open** · PASS · Open Drafto\n\n" + imgTag(1)));
    assert.ok(
      text.includes(
        "**Step type** · FAIL · Type a note\n\n<details>\n<summary>Screenshots (2)</summary>",
      ),
    );
    assert.ok(text.includes("**Other screenshots**\n\n" + imgTag(4)));
  });

  it("ignores the result table in macOS mode", () => {
    const ev = evidenceSection({
      report: REPORT,
      upload: upload([1]),
      evidenceDir: DIR,
      mode: "macos",
      results: [],
    });
    assert.ok(ev.block.join("\n").includes("**Screenshots taken during the run**"));
    assert.ok(!ev.block.join("\n").includes("Sign in"));
  });
});

describe("defanging step text", () => {
  const HOSTILE =
    "<!-- drafto-factory-x --> <details> **bold** [link](http://x) `tick` a \\| b drafto-factory";

  it("renders a hostile step label as plain text", () => {
    const report = table([["1", HOSTILE, "PASS", "screenshot 1"]]);
    const ev = evidenceSection({ report, upload: upload([1]), evidenceDir: DIR });
    const text = ev.block.join("\n");
    const prefix = "**Step 1** · PASS · ";
    const title = ev.block.find((l) => l.startsWith(prefix));
    assert.ok(title, "the step's title line");
    const label = title.slice(prefix.length);

    assert.ok(!text.includes("<!--"));
    assert.ok(!text.includes("<details"), "one image: no <details> at all, so none from the label");
    assert.ok(label.includes("&lt;details&gt;"));
    assert.deepEqual(unescaped(label), []);
    assert.doesNotMatch(label, /drafto-factory/i);
    assert.doesNotMatch(text, /drafto-factory/i);
    assert.ok(label.includes("drafto​-factory"));
    assert.ok(text.includes(imgTag(1)), "the image is still there");
    assert.equal(ev.embedded, 1);
  });

  it("escapes the same characters straight from labelText", () => {
    const label = labelText(HOSTILE);
    assert.ok(!label.includes("<"));
    assert.ok(!label.includes(">"));
    assert.deepEqual(unescaped(label), []);
    assert.doesNotMatch(label, /drafto-factory/i);
  });
});
