import { generateId } from "@/lib/generate-id";

describe("generateId", () => {
  it("returns a string in UUID v4 format", () => {
    const id = generateId();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(id).toMatch(uuidRegex);
  });

  it("sets version nibble to 4", () => {
    const id = generateId();
    // 13th character (index 14 after hyphens) should be '4'
    expect(id[14]).toBe("4");
  });

  it("sets variant bits correctly (8, 9, a, or b)", () => {
    const id = generateId();
    // 17th character (index 19 after hyphens) should be 8, 9, a, or b
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it("returns lowercase hex characters", () => {
    const id = generateId();
    expect(id).toBe(id.toLowerCase());
  });

  it("has correct length (36 chars with hyphens)", () => {
    expect(generateId()).toHaveLength(36);
  });
});
