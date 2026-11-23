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
