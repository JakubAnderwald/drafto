import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureException, sentryState } = vi.hoisted(() => ({
  captureException: vi.fn(),
  sentryState: { enabled: true },
}));

vi.mock("@sentry/nextjs", () => ({ captureException }));

// A getter so each test can switch Sentry on or off without re-importing the helper.
vi.mock("@/lib/sentry-environment", () => ({
  get sentryEnabled() {
    return sentryState.enabled;
  },
}));

import { reportError, resetReportErrorThrottle, toError } from "@/lib/report-error";

describe("reportError", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captureException.mockReset();
    sentryState.enabled = true;
    resetReportErrorThrottle();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("captures the error with the where tag, default level and extra", () => {
    const error = new Error("boom");

    reportError(error, "app-shell:create-note", { extra: { notebookId: "nb-1", status: 500 } });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, {
      level: "error",
      tags: { where: "app-shell:create-note" },
      extra: { where: "app-shell:create-note", notebookId: "nb-1", status: 500 },
    });
  });

  it("passes the warning level through", () => {
    reportError(new Error("slow"), "api:notes-search", { level: "warning" });

    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      level: "warning",
      tags: { where: "api:notes-search" },
      extra: { where: "api:notes-search" },
    });
  });

  it("passes an Error through as-is", () => {
    const error = new TypeError("bad type");

    reportError(error, "here");

    expect(captureException.mock.calls[0][0]).toBe(error);
  });

  it("wraps a plain { message } object in an Error with that message", () => {
    reportError({ message: "row not found", code: "PGRST116" }, "here");

    const captured = captureException.mock.calls[0][0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe("row not found");
  });

  it("wraps a string in an Error with that message", () => {
    reportError("network down", "here");

    const captured = captureException.mock.calls[0][0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe("network down");
  });

  describe("throttle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    });

    it("drops a second report with the same where inside the window", () => {
      reportError(new Error("first"), "middleware:session", { throttleMs: 60_000 });
      vi.setSystemTime(new Date("2026-11-24T12:00:30Z"));
      reportError(new Error("second"), "middleware:session", { throttleMs: 60_000 });

      expect(captureException).toHaveBeenCalledTimes(1);
    });

    it("reports again once the window has passed", () => {
      reportError(new Error("first"), "middleware:session", { throttleMs: 60_000 });
      vi.setSystemTime(new Date("2026-11-24T12:01:00Z"));
      reportError(new Error("second"), "middleware:session", { throttleMs: 60_000 });

      expect(captureException).toHaveBeenCalledTimes(2);
    });

    it("does not throttle a different where", () => {
      reportError(new Error("a"), "middleware:session", { throttleMs: 60_000 });
      reportError(new Error("b"), "middleware:profile", { throttleMs: 60_000 });

      expect(captureException).toHaveBeenCalledTimes(2);
    });

    it("does not throttle without throttleMs", () => {
      reportError(new Error("a"), "here");
      reportError(new Error("b"), "here");

      expect(captureException).toHaveBeenCalledTimes(2);
    });

    it("forgets the window after resetReportErrorThrottle", () => {
      reportError(new Error("first"), "middleware:session", { throttleMs: 60_000 });
      resetReportErrorThrottle();
      reportError(new Error("second"), "middleware:session", { throttleMs: 60_000 });

      expect(captureException).toHaveBeenCalledTimes(2);
    });

    it("still logs on the server inside the window", () => {
      vi.stubGlobal("window", undefined);

      reportError(new Error("first"), "middleware:session", { throttleMs: 60_000 });
      reportError(new Error("second"), "middleware:session", { throttleMs: 60_000 });

      expect(captureException).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(2);
    });
  });

  describe("console logging", () => {
    it("logs on the server (no window)", () => {
      vi.stubGlobal("window", undefined);
      const error = new Error("server boom");

      reportError(error, "cron:cleanup-trash");

      expect(consoleError).toHaveBeenCalledWith("[cron:cleanup-trash]", error);
    });

    it("logs in the browser when Sentry is off", () => {
      sentryState.enabled = false;
      const error = new Error("local boom");

      reportError(error, "app-shell:create-note");

      expect(consoleError).toHaveBeenCalledWith("[app-shell:create-note]", error);
      expect(captureException).toHaveBeenCalledTimes(1);
    });

    it("does not log in the browser when Sentry is on", () => {
      reportError(new Error("browser boom"), "app-shell:create-note");

      expect(consoleError).not.toHaveBeenCalled();
      expect(captureException).toHaveBeenCalledTimes(1);
    });
  });
});

describe("toError", () => {
  it("falls back to JSON for other values", () => {
    expect(toError({ code: 42 }).message).toBe('{"code":42}');
  });

  it("falls back to String() when JSON fails", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toError(circular).message).toBe("[object Object]");
  });

  it("ignores a non-string message", () => {
    expect(toError({ message: 42 }).message).toBe('{"message":42}');
  });

  it("names undefined instead of leaving the message empty", () => {
    expect(toError(undefined).message).toBe("undefined");
  });
});
