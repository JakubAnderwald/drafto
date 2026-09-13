import type { WebViewMessageEvent } from "react-native-webview";

import {
  FIND_RESULT_TYPE,
  findClearJS,
  findSearchJS,
  findStepJS,
  parseFindResult,
} from "@/components/editor/find-engine";

function messageEvent(data: string): WebViewMessageEvent {
  return { nativeEvent: { data } } as WebViewMessageEvent;
}

describe("parseFindResult", () => {
  it("parses a valid find-result message", () => {
    const event = messageEvent(JSON.stringify({ type: FIND_RESULT_TYPE, current: 3, total: 12 }));
    expect(parseFindResult(event)).toEqual({ current: 3, total: 12 });
  });

  it("returns null for a non-find message (tentap emits many other types)", () => {
    const event = messageEvent(JSON.stringify({ type: "editorReady" }));
    expect(parseFindResult(event)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseFindResult(messageEvent("not json"))).toBeNull();
  });

  it("defaults missing numeric fields to 0", () => {
    const event = messageEvent(JSON.stringify({ type: FIND_RESULT_TYPE }));
    expect(parseFindResult(event)).toEqual({ current: 0, total: 0 });
  });

  it("coerces non-numeric fields to 0", () => {
    const event = messageEvent(
      JSON.stringify({ type: FIND_RESULT_TYPE, current: "x", total: null }),
    );
    expect(parseFindResult(event)).toEqual({ current: 0, total: 0 });
  });
});

describe("find command builders", () => {
  it("embeds the query as a safely-escaped JS string literal", () => {
    const query = 'he said "hi"\n';
    const js = findSearchJS(query);
    // JSON.stringify escaping is what keeps an arbitrary query from breaking out
    // of the injected string.
    expect(js).toContain(JSON.stringify(query));
    expect(js).toContain("window.__draftoFind.search(");
  });

  it("builds next and prev step commands", () => {
    expect(findStepJS("next")).toContain("window.__draftoFind.next()");
    expect(findStepJS("prev")).toContain("window.__draftoFind.prev()");
  });

  it("builds a clear command", () => {
    expect(findClearJS()).toContain("window.__draftoFind.clear()");
  });

  it("re-injects the idempotent engine setup with every command", () => {
    for (const js of [findSearchJS("x"), findStepJS("next"), findClearJS()]) {
      expect(js).toContain("window.__draftoFind");
      expect(js).toContain("::highlight(drafto-find)");
    }
  });

  it("passes a regex-escaped pattern so query metacharacters match literally", () => {
    // The 2nd search argument is the escaped regex source: metachars get backslashed.
    expect(findSearchJS("a.b*")).toContain(JSON.stringify("a\\.b\\*"));
  });
});
