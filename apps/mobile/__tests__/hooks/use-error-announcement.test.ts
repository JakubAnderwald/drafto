import { AccessibilityInfo, Platform } from "react-native";
import { renderHook } from "@testing-library/react-native";

import { useErrorAnnouncement } from "@/hooks/use-error-announcement";

describe("useErrorAnnouncement", () => {
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
    renderHook(() => useErrorAnnouncement("Enter a valid email address."));

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Enter a valid email address.", { queue: true });
  });

  it("PrimeTestLab 11035 M-02: stays silent without an error", () => {
    renderHook(() => useErrorAnnouncement(undefined));
    renderHook(() => useErrorAnnouncement(null));
    renderHook(() => useErrorAnnouncement(""));

    expect(announce).not.toHaveBeenCalled();
  });

  it("PrimeTestLab 11035 M-02: does not repeat the same error, but announces a changed one", () => {
    const { rerender } = renderHook(
      ({ error }: { error: string | undefined }) => useErrorAnnouncement(error),
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

  it("PrimeTestLab 11035 review: announces the same error again for each new attempt", () => {
    const { rerender } = renderHook(
      ({ error, attempt }: { error: string; attempt: number }) =>
        useErrorAnnouncement(error, attempt),
      { initialProps: { error: "Email or password is incorrect.", attempt: 1 } },
    );
    // A re-render within the same attempt stays quiet.
    rerender({ error: "Email or password is incorrect.", attempt: 1 });
    // The next submit fails with the same words: heard again.
    rerender({ error: "Email or password is incorrect.", attempt: 2 });

    expect(announce.mock.calls).toEqual([
      ["Email or password is incorrect.", { queue: true }],
      ["Email or password is incorrect.", { queue: true }],
    ]);
  });

  it("PrimeTestLab 11035 review: a new attempt without an error stays silent", () => {
    const { rerender } = renderHook(
      ({ attempt }: { attempt: number }) => useErrorAnnouncement(undefined, attempt),
      { initialProps: { attempt: 1 } },
    );
    rerender({ attempt: 2 });

    expect(announce).not.toHaveBeenCalled();
  });

  it("PrimeTestLab 11035 M-02: leaves Android to the error's live region", () => {
    Object.defineProperty(Platform, "OS", { value: "android", configurable: true });

    renderHook(() => useErrorAnnouncement("Enter a valid email address.", 3));

    expect(announce).not.toHaveBeenCalled();
  });
});
