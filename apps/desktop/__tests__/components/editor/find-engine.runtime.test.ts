/**
 * @jest-environment jsdom
 */
/// <reference lib="dom" />
import { findClearJS, findSearchJS, findStepJS } from "@/components/editor/find-engine";

// The engine is a string injected into the tentap WebView. Here we execute it in
// jsdom to exercise the real search / step / offset logic (jsdom lacks the CSS
// Custom Highlight API, so painting no-ops but range building and counting run).
function runEngine(js: string): void {
  // eslint-disable-next-line no-eval -- run the injected engine exactly as the WebView would
  (0, eval)(js);
}

interface Posted {
  type: string;
  total: number;
  current: number;
}

describe("find engine (jsdom runtime)", () => {
  let posted: Posted[];

  beforeEach(() => {
    document.body.innerHTML = '<div class="ProseMirror"></div>';
    posted = [];
    (
      window as unknown as { ReactNativeWebView: { postMessage: (s: string) => void } }
    ).ReactNativeWebView = {
      postMessage: (s: string) => posted.push(JSON.parse(s) as Posted),
    };
    // Force a fresh engine (fresh match state) per test.
    (window as unknown as { __draftoFind?: unknown }).__draftoFind = undefined;
  });

  function setText(text: string): void {
    const el = document.querySelector(".ProseMirror");
    if (el) el.textContent = text;
  }
  function last(): Posted {
    return posted[posted.length - 1];
  }

  it("counts case-insensitive matches and reports current/total", () => {
    setText("Foo foo FOO bar");
    runEngine(findSearchJS("foo"));
    expect(last()).toMatchObject({ total: 3, current: 1 });
  });

  it("wraps next / prev over the matches", () => {
    setText("a a a");
    runEngine(findSearchJS("a"));
    expect(last()).toMatchObject({ total: 3, current: 1 });
    runEngine(findStepJS("next"));
    expect(last()).toMatchObject({ current: 2 });
    runEngine(findStepJS("prev"));
    runEngine(findStepJS("prev"));
    expect(last()).toMatchObject({ current: 3 }); // wrapped past the start
  });

  it("does not throw on locale-lengthening characters and still matches", () => {
    // 'İ'.toLowerCase() is 2 UTF-16 units; the old lowercased-offset math threw
    // IndexSizeError when a match landed near the end of such a node.
    setText("aİb x b");
    expect(() => runEngine(findSearchJS("b"))).not.toThrow();
    expect(last()).toMatchObject({ total: 2 });
  });

  it("treats regex metacharacters in the query literally", () => {
    setText("a.b aXb");
    runEngine(findSearchJS("a.b"));
    expect(last()).toMatchObject({ total: 1 }); // matches "a.b", not "aXb"
  });

  it("reports zero and clears for an empty query", () => {
    setText("hello");
    runEngine(findSearchJS(""));
    expect(last()).toMatchObject({ total: 0, current: 0 });
    runEngine(findClearJS());
    expect(last()).toMatchObject({ total: 0, current: 0 });
  });
});
