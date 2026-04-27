import { isCatastrophicEraseSave } from "../../../src/components/notes/erase-tripwire";

const FORTY_KB_NOTE = JSON.stringify(
  Array.from({ length: 200 }, (_, i) => ({
    type: "paragraph",
    content: [{ type: "text", text: `paragraph ${i} `.repeat(20) }],
    children: [],
  })),
);

const SMALL_REAL_NOTE = JSON.stringify([
  { type: "paragraph", content: [{ type: "text", text: "hello" }], children: [] },
]);

const EMPTY_BLOCKNOTE = JSON.stringify([{ type: "paragraph", content: [], children: [] }]);
const EMPTY_BLOCKNOTE_NO_CHILDREN = JSON.stringify([{ type: "paragraph", content: [] }]);
const EMPTY_ARRAY = JSON.stringify([]);

describe("isCatastrophicEraseSave", () => {
  it("blocks the exact 49-byte empty-BlockNote signature against a 40 KB note", () => {
    expect(isCatastrophicEraseSave(FORTY_KB_NOTE, EMPTY_BLOCKNOTE)).toBe(true);
  });

  it("blocks empty-paragraph variants without children prop", () => {
    expect(isCatastrophicEraseSave(FORTY_KB_NOTE, EMPTY_BLOCKNOTE_NO_CHILDREN)).toBe(true);
  });

  it("blocks an empty array against a substantial note", () => {
    expect(isCatastrophicEraseSave(FORTY_KB_NOTE, EMPTY_ARRAY)).toBe(true);
  });

  it("permits the same erase pattern when existing content is small", () => {
    expect(isCatastrophicEraseSave(SMALL_REAL_NOTE, EMPTY_BLOCKNOTE)).toBe(false);
  });

  it("permits a legitimate small but non-empty save against a large note", () => {
    expect(isCatastrophicEraseSave(FORTY_KB_NOTE, SMALL_REAL_NOTE)).toBe(false);
  });

  it("permits any save when the existing record is empty/null", () => {
    expect(isCatastrophicEraseSave(null, EMPTY_BLOCKNOTE)).toBe(false);
    expect(isCatastrophicEraseSave(undefined, EMPTY_BLOCKNOTE)).toBe(false);
    expect(isCatastrophicEraseSave("", EMPTY_BLOCKNOTE)).toBe(false);
  });

  it("permits non-paragraph single-block writes (heading, image, etc.)", () => {
    const headingOnly = JSON.stringify([
      { type: "heading", props: { level: 1 }, content: [], children: [] },
    ]);
    expect(isCatastrophicEraseSave(FORTY_KB_NOTE, headingOnly)).toBe(false);
  });

  it("permits writes with multiple blocks even if each is short", () => {
    const twoEmptyParagraphs = JSON.stringify([
      { type: "paragraph", content: [], children: [] },
      { type: "paragraph", content: [], children: [] },
    ]);
    expect(isCatastrophicEraseSave(FORTY_KB_NOTE, twoEmptyParagraphs)).toBe(false);
  });

  it("permits writes that fail to parse as JSON (the editor would never produce these)", () => {
    expect(isCatastrophicEraseSave(FORTY_KB_NOTE, "not-json")).toBe(false);
    expect(isCatastrophicEraseSave(FORTY_KB_NOTE, "")).toBe(false);
  });

  it("uses the 1000-byte protection threshold inclusively", () => {
    const justUnder = "x".repeat(999);
    const justOver = "x".repeat(1000);
    expect(isCatastrophicEraseSave(justUnder, EMPTY_BLOCKNOTE)).toBe(false);
    expect(isCatastrophicEraseSave(justOver, EMPTY_BLOCKNOTE)).toBe(true);
  });
});
