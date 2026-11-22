import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FENCE_LINE, closeFences, fenceStep, truncateFenced } from "../lib/markdown-fence.mjs";

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

  it("doesn't open on a line four spaces or a tab in: that's indented code", () => {
    assert.deepEqual(fenceStep(null, "   ```"), { char: "`", len: 3 });
    assert.equal(fenceStep(null, "    ```"), null);
    assert.equal(fenceStep(null, "    ~~~~md"), null);
    assert.equal(fenceStep(null, "\t```"), null);
  });

  it("doesn't close on a line four spaces or a tab in: that's content", () => {
    const open = { char: "`", len: 3 };
    assert.equal(fenceStep(open, "   ```"), null);
    assert.deepEqual(fenceStep(open, "    ```"), open);
    assert.deepEqual(fenceStep(open, "\t```"), open);
    assert.deepEqual(stateAfter(["```", "    ```", "x"]), open);
  });

  it("FENCE_LINE matches what looks like a fence line", () => {
    assert.ok(FENCE_LINE.test("  ```bash"));
    assert.ok(FENCE_LINE.test("   ~~~"));
    assert.ok(FENCE_LINE.test("~~~"));
    assert.ok(!FENCE_LINE.test("text ```"));
    assert.ok(!FENCE_LINE.test("    ```bash"));
    assert.ok(!FENCE_LINE.test("\t~~~"));
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

  it("adds no closer for a fence-like line four spaces in, and closes past one", () => {
    // A column-0 closer for a line GitHub reads as text would open a real fence.
    assert.equal(closeFences("out:\n\n    ```\n    x"), "out:\n\n    ```\n    x");
    assert.equal(closeFences("\t~~~\nx"), "\t~~~\nx");
    // ...and an indented "closer" doesn't close a real fence.
    assert.equal(closeFences("```\nx\n    ```"), "```\nx\n    ```\n```");
  });
});

describe("truncateFenced", () => {
  const openAfter = (text) => text.split("\n").reduce(fenceStep, null);

  it("cuts plain text to the limit", () => {
    assert.equal(truncateFenced("abcdef", 4), "abcd");
    assert.equal(truncateFenced("abc", 10), "abc");
    assert.equal(truncateFenced("abc", 0), "");
    assert.equal(truncateFenced("abc", -5), "");
  });

  it("closes the fence the cut leaves open with its own marker, within the limit", () => {
    assert.equal(truncateFenced("a\n~~~\nxxxxxxxx", 12), "a\n~~~\nxx\n~~~");
    assert.equal(truncateFenced("````md\n```js\nxxxxxxxxxx", 20), "````md\n```js\nxx\n````");
    assert.equal(truncateFenced("```\nxxxxxxxxxx", 10), "```\nxx\n```");
  });

  it("never splits a surrogate pair", () => {
    assert.equal(truncateFenced("ab😀cd", 3), "ab");
    assert.equal(truncateFenced("ab😀cd", 4), "ab😀");
  });

  it("at every cut point, stays within the limit and leaves no fence open", () => {
    const text = [
      "intro",
      "~~~",
      "```js",
      "x",
      "~~~",
      "````md",
      "```",
      "y 😀",
      "````",
      "  ```bash",
      "z",
      "",
    ].join("\n");
    for (let max = 0; max <= text.length + 2; max++) {
      const cut = truncateFenced(text, max);
      assert.ok(cut.length <= max, `max ${max}: ${cut.length}`);
      assert.equal(openAfter(cut), null, `max ${max}: ${JSON.stringify(cut)}`);
      assert.doesNotMatch(cut, /[\uD800-\uDBFF]$/, `max ${max}`);
    }
    // Room for the whole text: nothing is cut but the closer the text needs.
    assert.equal(truncateFenced(text, text.length + 6), closeFences(text));
  });
});
