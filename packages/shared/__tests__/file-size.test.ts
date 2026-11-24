import { describe, it, expect } from "vitest";
import { formatFileSize } from "../src";

describe("PrimeTestLab 11035 S-04 formatFileSize", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [812 * 1024, "812 KB"],
    [1023.6 * 1024, "1 MB"],
    [1.2 * 1024 * 1024, "1.2 MB"],
    [10 * 1024 * 1024, "10 MB"],
    [99.96 * 1024 * 1024, "100 MB"],
    [120.4 * 1024 * 1024, "120 MB"],
    [1024 * 1024 * 1024, "1 GB"],
    [1.25 * 1024 * 1024 * 1024, "1.3 GB"],
  ])("formats %d bytes as %s", (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("has no label for %d", (bytes) => {
    expect(formatFileSize(bytes)).toBe("");
  });
});
