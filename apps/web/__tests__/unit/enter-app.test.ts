import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enterApp } from "@/lib/auth/enter-app";

describe("enterApp", () => {
  const originalLocation = window.location;
  const assign = vi.fn();

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...originalLocation, assign },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { writable: true, value: originalLocation });
    assign.mockReset();
  });

  it("opens / with a full page load, so middleware picks the page for the new session", () => {
    enterApp();

    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith("/");
  });
});
