import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FENCE_LINE, closeFences, fenceStep } from "../lib/markdown-fence.mjs";

// The factory's scenario parsers and the verification report must agree with
// GitHub (CommonMark) on where a fenced code block ends.

function stateAfter(lines) {
  let open = null;
  for (const line of lines) open = fenceStep(open, line);
  return open;
}

describe("fenceStep", () => {
  it("opens on 3+ backticks or tildes, with or without an info string or indent", () => {
    assert.deepEqual(fenceStep(null, "```"), { char: "`", len: 3 });
    assert.deepEqual(fenceStep(null, "   ````md"), { char: "`", len: 4 });
    assert.deepEqual(fenceStep(null, "~~~~~ text"), { char: "~", len: 5 });
    assert.equal(fenceStep(null, "``"), null);
    assert.equal(fenceStep(null, "plain"), null);
  });

  it("doesn't open a backtick fence whose info string has a backtick", () => {
    assert.equal(fenceStep(null, "```js `inline`"), null);
    assert.deepEqual(fenceStep(null, "~~~ `fine`"), { char: "~", len: 3 });
  });

  it("closes only on the same character, at least as long, with nothing after it", () => {
    const open = { char: "`", len: 4 };
    assert.equal(fenceStep(open, "````"), null);
    assert.equal(fenceStep(open, "  `````  "), null);
    assert.deepEqual(fenceStep(open, "```"), open, "shorter");
    assert.deepEqual(fenceStep(open, "~~~~"), open, "other character");
    assert.deepEqual(fenceStep(open, "````js"), open, "info string");
    assert.deepEqual(fenceStep(open, "text"), open);
  });

  it("keeps a quoted ```js block inside a ````md one", () => {
    assert.deepEqual(stateAfter(["````md", "```js", "x", "```"]), { char: "`", len: 4 });
    assert.equal(stateAfter(["````md", "```js", "x", "```", "````"]), null);
  });

  it("FENCE_LINE matches what looks like a fence line", () => {
    assert.ok(FENCE_LINE.test("  ```bash"));
    assert.ok(FENCE_LINE.test("~~~"));
    assert.ok(!FENCE_LINE.test("text ```"));
  });
});

describe("closeFences", () => {
  it("closes an open fence with its own character and length", () => {
    assert.equal(closeFences("a\n```js\nb"), "a\n```js\nb\n```");
    assert.equal(closeFences("~~~~\nb"), "~~~~\nb\n~~~~");
    assert.equal(closeFences("````md\n```\n"), "````md\n```\n\n````");
  });

  it("leaves balanced text alone", () => {
    for (const text of ["", "plain", "```\nx\n```", "~~~\n```\n~~~"]) {
      assert.equal(closeFences(text), text);
    }
  });
});
