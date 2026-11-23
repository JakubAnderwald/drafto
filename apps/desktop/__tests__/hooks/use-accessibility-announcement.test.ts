import { AccessibilityInfo } from "react-native";
import { renderHook } from "@testing-library/react-native";

import { useAccessibilityAnnouncement } from "@/hooks/use-accessibility-announcement";

describe("useAccessibilityAnnouncement", () => {
  let announce: jest.SpyInstance;

  beforeEach(() => {
    announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    announce.mockRestore();
  });

  it("announces a message on mount", () => {
    renderHook(() => useAccessibilityAnnouncement("You are offline"));

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("You are offline");
  });

  it("stays silent for null", () => {
    renderHook(() => useAccessibilityAnnouncement(null));

    expect(announce).not.toHaveBeenCalled();
  });

  it("does not repeat the same message on a re-render", () => {
    const { rerender } = renderHook(
      ({ message }: { message: string | null }) => useAccessibilityAnnouncement(message),
      { initialProps: { message: "You are offline" } },
    );
    rerender({ message: "You are offline" });

    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("announces each new message, and again after a silence", () => {
    const { rerender } = renderHook(
      ({ message }: { message: string | null }) => useAccessibilityAnnouncement(message),
      { initialProps: { message: "You are offline" as string | null } },
    );
    rerender({ message: "Back online — syncing..." });
    rerender({ message: null });
    rerender({ message: "You are offline" });

    expect(announce.mock.calls).toEqual([
      ["You are offline"],
      ["Back online — syncing..."],
      ["You are offline"],
    ]);
  });
});

describe("useAccessibilityAnnouncement with queue", () => {
  it("PrimeTestLab 11035 M-02: queues the announcement behind current speech", () => {
    const announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => {});
    const announceWithOptions = jest
      .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
      .mockImplementation(() => {});
    announceWithOptions.mockClear();

    renderHook(() => useAccessibilityAnnouncement("Enter a valid email address.", { queue: true }));

    expect(announceWithOptions).toHaveBeenCalledWith("Enter a valid email address.", {
      queue: true,
    });
    expect(announce).not.toHaveBeenCalled();
    announce.mockRestore();
    announceWithOptions.mockRestore();
  });
});

describe("useAccessibilityAnnouncement with attempt", () => {
  let announceWithOptions: jest.SpyInstance;

  beforeEach(() => {
    announceWithOptions = jest
      .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
      .mockImplementation(() => {});
    announceWithOptions.mockClear();
  });

  afterEach(() => {
    announceWithOptions.mockRestore();
  });

  it("PrimeTestLab 11035 review: announces the same message again for each new attempt", () => {
    const { rerender } = renderHook(
      ({ attempt }: { attempt: number }) =>
        useAccessibilityAnnouncement("Email or password is incorrect.", { queue: true, attempt }),
      { initialProps: { attempt: 1 } },
    );
    // A re-render within the same attempt stays quiet.
    rerender({ attempt: 1 });
    // The next submit fails with the same words: heard again.
    rerender({ attempt: 2 });

    expect(announceWithOptions.mock.calls).toEqual([
      ["Email or password is incorrect.", { queue: true }],
      ["Email or password is incorrect.", { queue: true }],
    ]);
  });

  it("PrimeTestLab 11035 review: a new attempt without a message stays silent", () => {
    const { rerender } = renderHook(
      ({ attempt }: { attempt: number }) =>
        useAccessibilityAnnouncement(null, { queue: true, attempt }),
      { initialProps: { attempt: 1 } },
    );
    rerender({ attempt: 2 });

    expect(announceWithOptions).not.toHaveBeenCalled();
  });
});
