import { AccessibilityInfo, Platform } from "react-native";
import { renderHook } from "@testing-library/react-native";

import { useFieldErrorAnnouncement } from "@/hooks/use-field-error-announcement";

describe("useFieldErrorAnnouncement", () => {
  const originalOS = Platform.OS;
  let announce: jest.SpyInstance;

  beforeEach(() => {
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
      .mockImplementation(() => {});
    announce.mockClear();
  });

  afterEach(() => {
    announce.mockRestore();
    Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
  });

  it("PrimeTestLab 11035 M-02: announces a new error on iOS, queued behind current speech", () => {
    renderHook(() => useFieldErrorAnnouncement("Enter a valid email address."));

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Enter a valid email address.", { queue: true });
  });

  it("PrimeTestLab 11035 M-02: stays silent without an error", () => {
    renderHook(() => useFieldErrorAnnouncement(undefined));
    renderHook(() => useFieldErrorAnnouncement(""));

    expect(announce).not.toHaveBeenCalled();
  });

  it("PrimeTestLab 11035 M-02: does not repeat the same error, but announces a changed one", () => {
    const { rerender } = renderHook(
      ({ error }: { error: string | undefined }) => useFieldErrorAnnouncement(error),
      { initialProps: { error: "Error A" as string | undefined } },
    );
    rerender({ error: "Error A" });
    rerender({ error: undefined });
    rerender({ error: "Error B" });

    expect(announce.mock.calls).toEqual([
      ["Error A", { queue: true }],
      ["Error B", { queue: true }],
    ]);
  });

  it("PrimeTestLab 11035 M-02: leaves Android to the error's live region", () => {
    Object.defineProperty(Platform, "OS", { value: "android", configurable: true });

    renderHook(() => useFieldErrorAnnouncement("Enter a valid email address."));

    expect(announce).not.toHaveBeenCalled();
  });
});
